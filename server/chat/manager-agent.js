/**
 * ManagerAgent: hierarchical planning layer inspired by droidrun's Manager+Executor pattern.
 *
 * Flow:
 *   1. Manager LLM decomposes the user's goal into ordered sub-goals
 *   2. For each sub-goal, the existing Agent (Executor) runs a scoped perceive→act loop
 *   3. After each sub-goal completes (or fails), Manager re-plans with updated context
 *   4. Loop until the Manager declares the goal complete, or max sub-goals exhausted
 */
import { Agent } from './agent.js';
import { captureScreenshot, getForegroundApp } from './perception.js';
import { getScreenResolution } from '../adb/device-info.js';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';

const DEFAULT_MAX_SUBGOALS = 10;
const DEFAULT_EXECUTOR_STEPS = 8;

const MANAGER_SYSTEM_PROMPT = `You are a planning agent for Android phone automation. Break tasks into sub-goals.

RESPOND WITH ONLY a compact JSON object (no markdown, no explanation):
{"analysis":"brief current state","is_complete":false,"sub_goals":["step 1","step 2"],"answer":null}

Rules:
- Keep "analysis" under 30 words
- Keep each sub-goal under 20 words — be specific and actionable
- Set is_complete:true and answer:"summary" when goal is done, sub_goals:[]
- 2-5 sub-goals max. Don't over-decompose.
- If a previous sub-goal failed, try a different approach
- TRUST THE SCREENSHOT over any other signal`;

/**
 * Detect which LLM provider to use (same logic as Agent).
 */
function getProvider() {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  if (process.env.OLLAMA_MODEL) return 'ollama';
  return null;
}

export class ManagerAgent {
  constructor(serial, onEvent, options = {}) {
    this.serial = serial;
    this.onEvent = onEvent;
    this.options = options;
    this.running = false;
    this._provider = null;
    this._openai = null;
    this._anthropic = null;
    this._gemini = null;
    this._ollama = null;
    this._activeExecutor = null;
    this._abortController = null;
  }

  async init() {
    this._provider = getProvider();
    if (!this._provider) {
      throw new Error('No API key set. Add GEMINI_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY to .env');
    }

    if (this._provider === 'gemini') {
      this._gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    } else if (this._provider === 'openai') {
      this._openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    } else if (this._provider === 'anthropic') {
      this._anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    } else if (this._provider === 'ollama') {
      const base = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/$/, '');
      this._ollama = new OpenAI({ baseURL: `${base}/v1`, apiKey: 'ollama' });
    }

    this.resolution = await getScreenResolution(this.serial);
    console.log(`[Manager] Provider: ${this._provider}, Resolution: ${this.resolution.width}x${this.resolution.height}`);
  }

  async run(goal) {
    await this.init();
    this.running = true;
    this._abortController = new AbortController();

    const maxSubGoals = this.options.maxSubGoals || DEFAULT_MAX_SUBGOALS;
    const executorSteps = this.options.executorSteps || DEFAULT_EXECUTOR_STEPS;
    const history = []; // { subGoal, status, summary }

    this.onEvent({ type: 'manager-start', goal, maxSubGoals, provider: this._provider });

    for (let round = 0; round < maxSubGoals && this.running; round++) {
      try {
        // 1. PLAN — ask Manager LLM to (re-)plan
        this.onEvent({ type: 'manager-planning', round: round + 1 });

        const plan = await this._plan(goal, history);

        if (!this.running) break;

        if (!plan) {
          this.onEvent({ type: 'manager-error', round: round + 1, message: 'Manager returned invalid plan' });
          continue;
        }

        this.onEvent({
          type: 'manager-plan',
          round: round + 1,
          analysis: plan.analysis,
          subGoals: plan.sub_goals,
          isComplete: plan.is_complete,
        });

        // 2. CHECK — is the goal already complete?
        if (plan.is_complete) {
          this.onEvent({
            type: 'manager-done',
            message: plan.answer || 'Goal achieved',
            totalRounds: round + 1,
            history,
          });
          this.running = false;
          return;
        }

        // 3. EXECUTE — run each sub-goal through the Executor (Agent)
        const subGoals = plan.sub_goals || [];
        if (subGoals.length === 0) {
          this.onEvent({ type: 'manager-error', round: round + 1, message: 'Manager returned no sub-goals' });
          continue;
        }

        // Execute one sub-goal at a time, then re-plan
        const subGoal = subGoals[0];
        this.onEvent({
          type: 'manager-executing',
          round: round + 1,
          subGoal,
          subGoalIndex: 0,
          totalSubGoals: subGoals.length,
          remainingSubGoals: subGoals.slice(1),
        });

        const result = await this._executeSubGoal(subGoal, executorSteps);

        if (!this.running) break;

        history.push({
          subGoal,
          status: result.status, // 'done' | 'maxsteps' | 'error'
          summary: result.summary,
        });

        this.onEvent({
          type: 'manager-subgoal-result',
          round: round + 1,
          subGoal,
          status: result.status,
          summary: result.summary,
        });

        // After executing, loop back to re-plan with updated context

      } catch (err) {
        if (!this.running || err.name === 'AbortError') break;

        const msg = err.message || String(err);
        console.error('[Manager] Error:', msg);
        this.onEvent({ type: 'manager-error', round: round + 1, message: msg });

        if (msg.includes('401') || msg.includes('403') || msg.includes('invalid')) {
          this.running = false;
          return;
        }

        await sleep(1000);
      }
    }

    if (this.running) {
      this.onEvent({
        type: 'manager-maxrounds',
        message: `Reached max ${maxSubGoals} planning rounds`,
        history,
      });
      this.running = false;
    }
  }

  stop() {
    this.running = false;
    this._abortController?.abort();
    if (this._activeExecutor) {
      this._activeExecutor.stop();
      this._activeExecutor = null;
    }
  }

  /**
   * Ask Manager LLM to create/update the plan.
   */
  async _plan(goal, history) {
    // Capture current screen state for context
    const [screenshot, foregroundApp] = await Promise.all([
      captureScreenshot(this.serial),
      getForegroundApp(this.serial),
    ]);

    const historyText = history.length === 0
      ? 'None yet — this is the initial plan.'
      : history.map((h, i) =>
          `${i + 1}. "${h.subGoal}" → ${h.status}${h.summary ? ': ' + h.summary : ''}`
        ).join('\n');

    const userPrompt = `GOAL: ${goal}

FOREGROUND APP: ${foregroundApp || 'unknown'}
RESOLUTION: ${this.resolution.width}x${this.resolution.height}

COMPLETED SUB-GOALS:
${historyText}

A screenshot of the current screen is attached. Analyze the current state and return your plan.`;

    const responseText = await this._callManagerLLM(userPrompt, screenshot);
    return this._parsePlan(responseText);
  }

  _parsePlan(responseText) {
    const cleaned = responseText
      .replace(/```json\s*/gi, '').replace(/```\s*/g, '')
      .replace(/^\s*json\s*/i, '')
      .trim();

    let plan = null;
    try { plan = JSON.parse(cleaned); } catch {}

    if (!plan) {
      try {
        const match = cleaned.match(/\{[\s\S]*\}/);
        if (match) plan = JSON.parse(match[0]);
      } catch {}
    }

    if (!plan) {
      try {
        let depth = 0, start = -1;
        for (let i = 0; i < cleaned.length; i++) {
          if (cleaned[i] === '{') { if (depth === 0) start = i; depth++; }
          if (cleaned[i] === '}') { depth--; if (depth === 0 && start !== -1) {
            plan = JSON.parse(cleaned.substring(start, i + 1));
            break;
          }}
        }
      } catch {}
    }

    if (!plan || typeof plan !== 'object') {
      console.log('[Manager] Bad plan response:', responseText.substring(0, 300));
      return null;
    }

    return {
      analysis: plan.analysis || '',
      is_complete: Boolean(plan.is_complete),
      sub_goals: Array.isArray(plan.sub_goals) ? plan.sub_goals : [],
      answer: plan.answer || null,
    };
  }

  /**
   * Run the Executor (Agent) on a single sub-goal, returning status.
   */
  async _executeSubGoal(subGoal, maxSteps) {
    return new Promise((resolve) => {
      let lastThink = '';
      let lastAction = '';

      const executor = new Agent(this.serial, (stepData) => {
        // Forward all executor events to the manager's event stream
        const { type: stepType, ...rest } = stepData;
        this.onEvent({ type: 'executor-step', stepType, ...rest });

        // Track last state for summary
        if (stepData.think) lastThink = stepData.think;
        if (stepData.action) lastAction = stepData.action;

        if (stepType === 'done') {
          resolve({ status: 'done', summary: stepData.message || lastThink });
        } else if (stepType === 'maxsteps') {
          resolve({ status: 'maxsteps', summary: `Ran out of steps. Last: ${lastAction}` });
        } else if (stepType === 'stopped') {
          resolve({ status: 'stopped', summary: 'Stopped by user' });
        }
      }, { maxSteps, inputHandler: this.options.inputHandler });

      this._activeExecutor = executor;

      executor.run(subGoal).catch(err => {
        console.error('[Manager] Executor error:', err.message);
        resolve({ status: 'error', summary: err.message });
      }).finally(() => {
        this._activeExecutor = null;
      });
    });
  }

  // --- LLM calls (Manager-specific, single-turn with vision) ---

  async _callManagerLLM(userPrompt, screenshotBase64) {
    switch (this._provider) {
      case 'gemini':    return this._callGemini(userPrompt, screenshotBase64);
      case 'openai':    return this._callOpenAI(userPrompt, screenshotBase64);
      case 'anthropic': return this._callAnthropic(userPrompt, screenshotBase64);
      case 'ollama':    return this._callOllama(userPrompt, screenshotBase64);
    }
  }

  async _callGemini(userPrompt, screenshotBase64) {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const parts = [{ text: userPrompt }];
    if (screenshotBase64) {
      parts.push({ inlineData: { mimeType: 'image/png', data: screenshotBase64 } });
    }

    const response = await this._gemini.models.generateContent({
      model,
      config: {
        systemInstruction: MANAGER_SYSTEM_PROMPT,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json',
      },
      contents: [{ role: 'user', parts }],
    }, { signal: this._abortController?.signal });

    return response?.text || '';
  }

  async _callOpenAI(userPrompt, screenshotBase64) {
    const content = [{ type: 'text', text: userPrompt }];
    if (screenshotBase64) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${screenshotBase64}`, detail: 'low' },
      });
    }

    const model = process.env.OPENAI_MODEL || 'gpt-4o';
    const response = await this._openai.chat.completions.create({
      model,
      max_completion_tokens: 2048,
      messages: [
        { role: 'system', content: MANAGER_SYSTEM_PROMPT },
        { role: 'user', content },
      ],
    }, { signal: this._abortController?.signal });

    return response.choices[0]?.message?.content || '';
  }

  async _callAnthropic(userPrompt, screenshotBase64) {
    const userContent = [{ type: 'text', text: userPrompt }];
    if (screenshotBase64) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 },
      });
    }

    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
    const response = await this._anthropic.messages.create({
      model,
      max_tokens: 2048,
      system: MANAGER_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    }, { signal: this._abortController?.signal });

    return response.content[0]?.text || '';
  }

  async _callOllama(userPrompt, screenshotBase64) {
    const model = process.env.OLLAMA_MODEL || 'qwen2.5vl:72b';
    const content = [{ type: 'text', text: userPrompt }];
    if (screenshotBase64) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${screenshotBase64}` },
      });
    }

    const response = await this._ollama.chat.completions.create({
      model,
      max_tokens: 2048,
      messages: [
        { role: 'system', content: MANAGER_SYSTEM_PROMPT },
        { role: 'user', content },
      ],
    }, { signal: this._abortController?.signal });

    return response.choices[0]?.message?.content || '';
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

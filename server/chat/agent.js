/**
 * AI Agent: perceive → reason → act loop.
 * Supports OpenAI, Anthropic, and Google Gemini as LLM providers.
 */
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { getScreenElements, captureScreenshot, getForegroundApp } from './perception.js';
import { getClient } from '../adb/adb-client.js';
import { getScreenResolution } from '../adb/device-info.js';

const MAX_STEPS = 20;
const STEP_DELAY_MS = 800;

const SYSTEM_PROMPT = `You are an AI agent controlling an Android phone via ADB.

CRITICAL: A screenshot of the ACTUAL screen is attached. ALWAYS trust what you SEE in the screenshot over the ELEMENTS list. The elements list may contain stale/wrong data from a previous screen. Describe what you ACTUALLY see in the image first, then decide your action.

RESPOND WITH ONLY a JSON object (no markdown):
{
  "think": "describe what I ACTUALLY SEE in the screenshot, then my reasoning",
  "action": "tap|type|swipe|press|launch|wait|done",
  "coordinates": [x, y],
  "text": "text to type",
  "direction": "up|down|left|right",
  "key": "home|back|recent|enter|delete",
  "package": "com.app.name",
  "reason": "why this action"
}

Actions:
- tap [x,y]: tap at coordinates. Use element "tap" field OR estimate from screenshot
- type "text": type into the currently focused text field
- swipe up/down/left/right: swipe screen in that direction
- press home/back/recent/enter/delete: press hardware/nav key
- launch com.package.name: open an app
- wait: pause and re-read screen
- done: goal achieved

Rules:
- LOOK AT THE SCREENSHOT FIRST. It shows the real screen. The elements list may be stale.
- If the screenshot shows a home screen but elements mention YouTube, TRUST THE SCREENSHOT.
- Use the "tap" coordinates from elements when they match what's visible in the screenshot.
- To type: first tap the text field, then use type action in the next step.
- If screen didn't change after your action, try something completely different.
- Common packages: com.android.settings, com.android.chrome, com.google.android.youtube
- Be efficient and direct. Don't overthink.`;

/**
 * Detect which LLM provider to use.
 * Priority: Gemini > OpenAI > Anthropic
 */
function getProvider() {
  if (process.env.GEMINI_API_KEY) return 'gemini';
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic';
  return null;
}

export class Agent {
  constructor(serial, onStep) {
    this.serial = serial;
    this.onStep = onStep;
    this.running = false;
    this.resolution = null;
    this._provider = null;
    this._openai = null;
    this._anthropic = null;
    this._gemini = null;
    this._geminiChat = null;
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
    } else {
      this._anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    }

    this.resolution = await getScreenResolution(this.serial);
    console.log(`[Agent] Provider: ${this._provider}, Resolution: ${this.resolution.width}x${this.resolution.height}`);
  }

  async run(goal) {
    await this.init();
    this.running = true;

    this._messages = [];
    let prevElementHash = '';
    let stuckCount = 0;

    this.onStep({ type: 'start', goal, maxSteps: MAX_STEPS, provider: this._provider });

    for (let step = 0; step < MAX_STEPS && this.running; step++) {
      try {
        // 1. PERCEIVE
        this.onStep({ type: 'perceiving', step: step + 1 });

        const [{ elements, raw: xmlRaw }, foregroundApp, screenshot] = await Promise.all([
          getScreenElements(this.serial),
          getForegroundApp(this.serial),
          captureScreenshot(this.serial),
        ]);

        console.log(`[Agent] Foreground: ${foregroundApp}, Elements: ${elements.length}, Screenshot: ${screenshot ? (screenshot.length / 1024).toFixed(0) + 'KB' : 'none'}`);

        // Detect stale elements: check if elements' package matches foreground app
        let elementsStale = false;
        if (elements.length > 0 && foregroundApp) {
          // Extract package from first element's XML or check element types
          const elementPackages = new Set();
          const pkgMatch = xmlRaw.match(/package="([^"]+)"/g);
          if (pkgMatch) {
            pkgMatch.forEach(m => {
              const p = m.match(/package="([^"]+)"/)?.[1];
              if (p) elementPackages.add(p);
            });
          }
          // If foreground app isn't in the elements, they're stale
          if (elementPackages.size > 0 && !elementPackages.has(foregroundApp)) {
            elementsStale = true;
            console.log(`[Agent] Stale elements detected: elements from [${[...elementPackages].join(',')}] but foreground is ${foregroundApp}`);
          }
        }

        let compactElements = [];
        if (!elementsStale) {
          compactElements = elements.slice(0, 40).map(e => ({
            i: e.index,
            text: e.text || undefined,
            desc: e.desc || undefined,
            type: e.type || undefined,
            id: e.id || undefined,
            tap: e.clickable ? e.center : undefined,
            scroll: e.scrollable || undefined,
          }));
        }

        // Stuck detection
        const currentHash = JSON.stringify(compactElements.map(e => e.text || e.desc));
        if (currentHash === prevElementHash && step > 0) stuckCount++;
        else stuckCount = 0;
        prevElementHash = currentHash;

        let stuckHint = '';
        if (stuckCount >= 2) {
          stuckHint = `\n\nWARNING: Screen NOT changed for ${stuckCount} steps. Try completely different approach.`;
        }

        // 2. REASON
        this.onStep({ type: 'thinking', step: step + 1 });

        let screenText;
        if (elementsStale || compactElements.length === 0) {
          // Screenshot-only mode: no elements, rely entirely on vision
          screenText = `GOAL: ${goal}\n\nFOREGROUND: ${foregroundApp || 'unknown'}\nRESOLUTION: ${this.resolution.width}x${this.resolution.height}\nSTEP: ${step + 1}/${MAX_STEPS}\n\nNO RELIABLE UI ELEMENTS AVAILABLE. Use ONLY the screenshot to decide your action. Estimate tap coordinates from what you see in the image.${stuckHint}`;
          console.log(`[Agent] Screenshot-only mode (stale elements discarded)`);
        } else {
          screenText = `GOAL: ${goal}\n\nFOREGROUND: ${foregroundApp || 'unknown'}\nRESOLUTION: ${this.resolution.width}x${this.resolution.height}\nSTEP: ${step + 1}/${MAX_STEPS}\n\nELEMENTS (${compactElements.length} found):\n${JSON.stringify(compactElements, null, 1)}\n\nA screenshot is also attached. If the elements don't match what you see in the screenshot, TRUST THE SCREENSHOT.${stuckHint}`;
        }

        const responseText = await this._callLLM(screenText, screenshot);

        // Parse decision - try multiple extraction strategies
        let decision = null;
        const cleaned = responseText
          .replace(/```json\s*/gi, '').replace(/```\s*/g, '') // strip markdown code blocks
          .replace(/^\s*json\s*/i, '')                         // strip leading "json" label
          .trim();

        // Strategy 1: parse the cleaned text directly
        try { decision = JSON.parse(cleaned); } catch {}

        // Strategy 2: extract first {...} block
        if (!decision) {
          try {
            const match = cleaned.match(/\{[\s\S]*\}/);
            if (match) decision = JSON.parse(match[0]);
          } catch {}
        }

        // Strategy 3: try to find the last complete {...} (sometimes LLM adds text after)
        if (!decision) {
          try {
            let depth = 0, start = -1;
            for (let i = 0; i < cleaned.length; i++) {
              if (cleaned[i] === '{') { if (depth === 0) start = i; depth++; }
              if (cleaned[i] === '}') { depth--; if (depth === 0 && start !== -1) {
                decision = JSON.parse(cleaned.substring(start, i + 1));
                break;
              }}
            }
          } catch {}
        }

        if (!decision || !decision.action) {
          console.log('[Agent] Bad LLM response:', responseText.substring(0, 200));
          this.onStep({ type: 'error', step: step + 1, message: 'LLM returned invalid response, retrying...' });
          continue;
        }

        this.onStep({
          type: 'decided',
          step: step + 1,
          think: decision.think,
          action: decision.action,
          reason: decision.reason,
        });

        // 3. ACT
        if (decision.action === 'done') {
          this.onStep({ type: 'done', step: step + 1, message: decision.reason || 'Goal achieved' });
          this.running = false;
          return;
        }

        await this._executeAction(decision);
        this.onStep({ type: 'acted', step: step + 1, action: decision.action });

        await sleep(STEP_DELAY_MS);

      } catch (err) {
        const msg = err.message || String(err);
        console.error('[Agent] Step error:', msg);

        // Friendly error messages
        if (msg.includes('429') || msg.includes('quota') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('rate')) {
          const retryMatch = msg.match(/retry\s+in\s+([\d.]+)/i) || msg.match(/retryDelay.*?(\d+)/);
          const wait = retryMatch ? Math.ceil(parseFloat(retryMatch[1])) : 30;
          this.onStep({ type: 'error', step: step + 1, message: `Rate limit reached. Waiting ${wait}s before retrying...` });
          await sleep(wait * 1000);
          continue; // Retry the step instead of failing
        }
        if (msg.includes('401') || msg.includes('403') || msg.includes('invalid') && msg.includes('key')) {
          this.onStep({ type: 'error', step: step + 1, message: 'Invalid API key. Check your .env file.' });
          this.running = false;
          return;
        }
        if (msg.includes('404') || msg.includes('not found')) {
          this.onStep({ type: 'error', step: step + 1, message: 'Model not found. Check GEMINI_MODEL / OPENAI_MODEL in .env.' });
          this.running = false;
          return;
        }

        this.onStep({ type: 'error', step: step + 1, message: msg.length > 150 ? msg.substring(0, 150) + '...' : msg });
        await sleep(1000);
      }
    }

    if (this.running) {
      this.onStep({ type: 'maxsteps', message: `Reached max ${MAX_STEPS} steps` });
      this.running = false;
    }
  }

  stop() {
    this.running = false;
  }

  async _callLLM(screenText, screenshotBase64) {
    switch (this._provider) {
      case 'gemini': return this._callGemini(screenText, screenshotBase64);
      case 'openai': return this._callOpenAI(screenText, screenshotBase64);
      case 'anthropic': return this._callAnthropic(screenText, screenshotBase64);
    }
  }

  async _callGemini(screenText, screenshotBase64) {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

    // Build message parts
    const parts = [{ text: screenText }];
    if (screenshotBase64) {
      parts.push({
        inlineData: {
          mimeType: 'image/png',
          data: screenshotBase64,
        },
      });
    }

    // Create chat session (multi-turn)
    if (!this._geminiChat) {
      this._geminiChat = this._gemini.chats.create({
        model,
        config: {
          systemInstruction: SYSTEM_PROMPT,
          maxOutputTokens: 512,
          responseMimeType: 'application/json',
        },
      });
    }

    const response = await this._geminiChat.sendMessage({ message: parts });
    return response.text || '';
  }

  async _callOpenAI(screenText, screenshotBase64) {
    const content = [{ type: 'text', text: screenText }];
    if (screenshotBase64) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,${screenshotBase64}`, detail: 'low' },
      });
    }

    this._messages.push({ role: 'user', content });
    if (this._messages.length > 14) this._messages.splice(0, 2);

    const model = process.env.OPENAI_MODEL || 'gpt-4o';
    const response = await this._openai.chat.completions.create({
      model,
      max_completion_tokens: 512,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...this._messages],
    });

    const text = response.choices[0]?.message?.content || '';
    this._messages.push({ role: 'assistant', content: text });
    return text;
  }

  async _callAnthropic(screenText, screenshotBase64) {
    const userContent = [{ type: 'text', text: screenText }];
    if (screenshotBase64) {
      userContent.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: screenshotBase64 },
      });
    }

    this._messages.push({ role: 'user', content: userContent });
    if (this._messages.length > 14) this._messages.splice(0, 2);

    const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
    const response = await this._anthropic.messages.create({
      model,
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: this._messages,
    });

    const text = response.content[0]?.text || '';
    this._messages.push({ role: 'assistant', content: text });
    return text;
  }

  async _executeAction(decision) {
    const device = getClient().getDevice(this.serial);

    switch (decision.action) {
      case 'tap': {
        const [x, y] = decision.coordinates || [0, 0];
        await shell(device, `input tap ${x} ${y}`);
        break;
      }
      case 'type': {
        const text = (decision.text || '').replace(/ /g, '%s').replace(/(['"\\$`!&|;(){}])/g, '\\$1');
        await shell(device, `input text "${text}"`);
        break;
      }
      case 'swipe': {
        const dir = decision.direction || 'up';
        const w = this.resolution.width, h = this.resolution.height;
        const cx = Math.round(w / 2), cy = Math.round(h / 2);
        const d = Math.round(h * 0.3);
        const coords = {
          up: `${cx} ${cy + d} ${cx} ${cy - d}`,
          down: `${cx} ${cy - d} ${cx} ${cy + d}`,
          left: `${cx + d} ${cy} ${cx - d} ${cy}`,
          right: `${cx - d} ${cy} ${cx + d} ${cy}`,
        }[dir] || `${cx} ${cy + d} ${cx} ${cy - d}`;
        await shell(device, `input swipe ${coords} 300`);
        break;
      }
      case 'press': {
        const keys = { home: 3, back: 4, recent: 187, enter: 66, delete: 67 };
        const keycode = keys[decision.key] || 3;
        await shell(device, `input keyevent ${keycode}`);
        break;
      }
      case 'launch': {
        const pkg = decision.package || '';
        await shell(device, `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
        break;
      }
      case 'wait': {
        await sleep(1500);
        break;
      }
    }
  }
}

async function shell(device, cmd) {
  const stream = await device.shell(cmd);
  for await (const _ of stream) {}
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

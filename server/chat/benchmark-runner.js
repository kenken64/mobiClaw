import { Agent } from './agent.js';

const DEFAULT_GOALS = [
  'go home',
  'open settings',
  'open chrome',
  'open youtube',
];

const BASELINE_ENV = {
  AGENT_OCR_ENABLE: '0',
  AGENT_MODAL_PANEL_MIN_RATIO: '0.45',
  AGENT_MODAL_TOP_REGION_MAX: '0.20',
  AGENT_MODAL_CENTER_MIN_RATIO: '0.08',
};

const ENHANCED_ENV = {
  AGENT_OCR_ENABLE: process.env.AGENT_OCR_ENABLE || '1',
  AGENT_MODAL_PANEL_MIN_RATIO: process.env.AGENT_MODAL_PANEL_MIN_RATIO || '0.40',
  AGENT_MODAL_TOP_REGION_MAX: process.env.AGENT_MODAL_TOP_REGION_MAX || '0.25',
  AGENT_MODAL_CENTER_MIN_RATIO: process.env.AGENT_MODAL_CENTER_MIN_RATIO || '0.06',
};

export class BenchmarkRunner {
  constructor(serial, report) {
    this.serial = serial;
    this.report = report || (() => {});
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }

  async run(commandText = '') {
    const args = parseBenchmarkArgs(commandText);
    const mode = args.mode;
    const goals = args.goals;

    if (mode === 'compare') {
      const baseline = await this.runSuite('baseline', goals, BASELINE_ENV);
      if (this.stopped) return { mode, baseline, stopped: true };
      const enhanced = await this.runSuite('enhanced', goals, ENHANCED_ENV);
      return {
        mode,
        baseline,
        enhanced,
        delta: compareSuites(baseline, enhanced),
      };
    }

    if (mode === 'baseline') {
      const baseline = await this.runSuite('baseline', goals, BASELINE_ENV);
      return { mode, baseline };
    }

    const enhanced = await this.runSuite('enhanced', goals, ENHANCED_ENV);
    return { mode, enhanced };
  }

  async runSuite(label, goals, envOverrides) {
    const startedAt = Date.now();
    const results = [];

    this.report(`[Benchmark] Running ${label} suite with ${goals.length} goals...`);

    for (let i = 0; i < goals.length; i++) {
      if (this.stopped) break;
      const goal = goals[i];
      this.report(`[Benchmark] ${label} ${i + 1}/${goals.length}: ${goal}`);
      const result = await withEnv(envOverrides, async () => {
        return this.runGoal(goal);
      });
      results.push(result);
      this.report(`[Benchmark] ${label} result: ${result.success ? 'PASS' : 'FAIL'} in ${result.steps} steps (${result.durationMs}ms)`);
    }

    const completedAt = Date.now();
    return summarizeSuite(label, results, completedAt - startedAt, envOverrides);
  }

  async runGoal(goal) {
    const startedAt = Date.now();
    const state = {
      goal,
      success: false,
      steps: 0,
      stuckEvents: 0,
      errors: 0,
      ocrUsed: false,
      reason: '',
    };

    const agent = new Agent(this.serial, (event) => {
      if (event.type === 'acted') state.steps = Math.max(state.steps, event.step || 0);
      if (event.type === 'done') {
        state.success = true;
        state.reason = event.message || 'done';
      }
      if (event.type === 'maxsteps') {
        state.reason = event.message || 'maxsteps';
      }
      if (event.type === 'error') {
        state.errors += 1;
        state.reason = event.message || 'error';
      }
      if (event.type === 'stuck') {
        state.stuckEvents += 1;
      }
      if (event.type === 'debug_candidates' && (event.ocrCount || 0) > 0) {
        state.ocrUsed = true;
      }
    }, {
      maxSteps: parseInt(process.env.BENCHMARK_MAX_STEPS || '12', 10),
      stepDelayMs: parseInt(process.env.BENCHMARK_STEP_DELAY_MS || '300', 10),
    });

    await agent.run(goal);

    return {
      ...state,
      durationMs: Date.now() - startedAt,
    };
  }
}

function summarizeSuite(label, results, elapsedMs, envOverrides) {
  const total = results.length;
  const passed = results.filter((r) => r.success).length;
  const failed = total - passed;
  const successRate = total > 0 ? Number((passed / total).toFixed(3)) : 0;
  const avgSteps = total > 0 ? Number((results.reduce((sum, r) => sum + r.steps, 0) / total).toFixed(2)) : 0;
  const avgDurationMs = total > 0 ? Number((results.reduce((sum, r) => sum + r.durationMs, 0) / total).toFixed(0)) : 0;
  const stuckEvents = results.reduce((sum, r) => sum + r.stuckEvents, 0);
  const errorCount = results.reduce((sum, r) => sum + r.errors, 0);
  const ocrUsageRate = total > 0 ? Number((results.filter((r) => r.ocrUsed).length / total).toFixed(3)) : 0;

  return {
    label,
    elapsedMs,
    total,
    passed,
    failed,
    successRate,
    avgSteps,
    avgDurationMs,
    stuckEvents,
    errorCount,
    ocrUsageRate,
    envOverrides,
    results,
  };
}

function compareSuites(before, after) {
  return {
    successRate: Number((after.successRate - before.successRate).toFixed(3)),
    avgSteps: Number((after.avgSteps - before.avgSteps).toFixed(2)),
    avgDurationMs: Number((after.avgDurationMs - before.avgDurationMs).toFixed(0)),
    stuckEvents: after.stuckEvents - before.stuckEvents,
    errorCount: after.errorCount - before.errorCount,
    ocrUsageRate: Number((after.ocrUsageRate - before.ocrUsageRate).toFixed(3)),
  };
}

function parseBenchmarkArgs(commandText) {
  const text = String(commandText || '').trim().toLowerCase();
  let mode = 'compare';
  if (/\bbaseline\b/.test(text)) mode = 'baseline';
  if (/\benhanced\b/.test(text)) mode = 'enhanced';
  if (/\bcompare\b/.test(text)) mode = 'compare';

  // Keep goal set deterministic and bounded.
  const goals = [...DEFAULT_GOALS];
  return { mode, goals };
}

async function withEnv(overrides, fn) {
  const previous = {};
  const keys = Object.keys(overrides || {});
  for (const key of keys) {
    previous[key] = process.env[key];
    process.env[key] = String(overrides[key]);
  }

  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

import { ShellInputHandler } from '../input/shell-input.js';
import { executeDeviceAction } from '../input/action-executor.js';
import { saveReplayResult } from '../recording/artifact-store.js';
import { captureStepState } from '../recording/state-utils.js';
import { evaluatePlaybackStep } from '../recording/step-evaluator.js';
import { getScreenResolution } from '../adb/device-info.js';
import { relocateDecision } from './semantic-targeting.js';

const DEFAULT_POLICY = {
  mode: 'strict',
  maxHardFailures: 1,
  maxSoftFailures: 0,
  maxRetriesPerStep: 1,
  semanticFallback: true,
  stopOnFailure: true,
};

function normalizePolicy(policy = {}) {
  const mode = policy.mode || DEFAULT_POLICY.mode;
  const normalized = {
    mode,
    maxHardFailures: Number.isFinite(policy.maxHardFailures) ? policy.maxHardFailures : DEFAULT_POLICY.maxHardFailures,
    maxSoftFailures: Number.isFinite(policy.maxSoftFailures) ? policy.maxSoftFailures : DEFAULT_POLICY.maxSoftFailures,
    maxRetriesPerStep: Number.isFinite(policy.maxRetriesPerStep) ? policy.maxRetriesPerStep : DEFAULT_POLICY.maxRetriesPerStep,
    semanticFallback: typeof policy.semanticFallback === 'boolean' ? policy.semanticFallback : DEFAULT_POLICY.semanticFallback,
    stopOnFailure: typeof policy.stopOnFailure === 'boolean' ? policy.stopOnFailure : DEFAULT_POLICY.stopOnFailure,
  };

  if (mode === 'continue') {
    normalized.stopOnFailure = false;
    if (!Number.isFinite(policy.maxSoftFailures)) normalized.maxSoftFailures = 99;
    if (!Number.isFinite(policy.maxHardFailures)) normalized.maxHardFailures = 99;
  } else if (mode === 'tolerant') {
    normalized.stopOnFailure = false;
    if (!Number.isFinite(policy.maxSoftFailures)) normalized.maxSoftFailures = 2;
    if (!Number.isFinite(policy.maxHardFailures)) normalized.maxHardFailures = 1;
  } else {
    normalized.stopOnFailure = true;
    if (!Number.isFinite(policy.maxHardFailures)) normalized.maxHardFailures = 1;
    if (!Number.isFinite(policy.maxSoftFailures)) normalized.maxSoftFailures = 0;
  }

  normalized.maxHardFailures = Math.max(0, normalized.maxHardFailures);
  normalized.maxSoftFailures = Math.max(0, normalized.maxSoftFailures);
  normalized.maxRetriesPerStep = Math.max(0, normalized.maxRetriesPerStep);
  return normalized;
}

export class ScriptRunner {
  constructor({ serial, inputHandler, onEvent, policy }) {
    this.serial = serial;
    this.inputHandler = inputHandler || null;
    this.onEvent = onEvent || (() => {});
    this.policy = normalizePolicy(policy);
    this.stopped = false;
  }

  stop() {
    this.stopped = true;
  }

  async run(script) {
    const resolution = await getScreenResolution(this.serial);
    const replayStartedAt = new Date().toISOString();
    const localInputHandler = this.inputHandler || new ShellInputHandler(this.serial);
    const steps = [];
    let hardFailures = 0;
    let softFailures = 0;

    this.onEvent({ type: 'replay-start', scriptId: script.scriptId, scriptName: script.name, serial: this.serial, stepCount: script.steps.length, policy: this.policy });

    for (const scriptStep of script.steps) {
      if (this.stopped) break;

      let attempt = 0;
      let replayStep = null;

      while (!this.stopped) {
        attempt += 1;
        const before = await captureStepState(this.serial, resolution);
        this.onEvent({ type: 'replay-step', step: scriptStep.step, name: scriptStep.name, action: scriptStep.action?.action || scriptStep.action?.kind || 'unknown', attempt, scriptStep });

        let effectiveDecision = scriptStep.action;
        let relocation = { relocated: false, reason: 'disabled' };
        if (this.policy.semanticFallback) {
          relocation = relocateDecision(scriptStep.action, scriptStep, before.elements || [], resolution);
          effectiveDecision = relocation.decision;
        }

        let execution;
        try {
          execution = await executeDeviceAction({
            serial: this.serial,
            resolution,
            inputHandler: localInputHandler,
            decision: effectiveDecision,
          });
        } catch (err) {
          execution = {
            ok: false,
            error: err.message,
            transport: localInputHandler ? 'input-handler' : 'adb',
            durationMs: 0,
            startedAt: new Date().toISOString(),
            endedAt: new Date().toISOString(),
          };
        }

          execution.relocation = relocation;

        const after = await captureStepState(this.serial, resolution);
        const evaluation = evaluatePlaybackStep(scriptStep, before, after, execution);
        replayStep = {
          step: scriptStep.step,
          name: scriptStep.name,
          scriptStep,
          before,
          execution,
          after,
          evaluation,
          attempt,
          relocation,
        };

        this.onEvent({
          type: 'replay-step-result',
          step: scriptStep.step,
          name: scriptStep.name,
          execution,
          evaluation,
          attempt,
          relocation,
          willRetry: Boolean(evaluation.verdict === 'fail' && evaluation.retryable && attempt <= this.policy.maxRetriesPerStep),
        });

        if (evaluation.verdict === 'pass' || !evaluation.retryable || attempt > this.policy.maxRetriesPerStep) {
          break;
        }
      }

      if (replayStep) {
        steps.push(replayStep);
      }

      if (replayStep?.evaluation?.verdict === 'fail') {
        if (replayStep.evaluation.failureType === 'hard') hardFailures += 1;
        else softFailures += 1;

        const exceededHard = hardFailures >= this.policy.maxHardFailures && this.policy.maxHardFailures > 0;
        const exceededSoft = softFailures > this.policy.maxSoftFailures && this.policy.maxSoftFailures >= 0;
        const shouldStop = this.policy.stopOnFailure || exceededHard || exceededSoft;
        if (shouldStop) break;
      }
    }

    const failed = steps.find((step) => step.evaluation?.verdict === 'fail');
    const stopped = this.stopped;
    const replayRecord = await saveReplayResult({
      scriptId: script.scriptId,
      scriptName: script.name,
      sourceRunId: script.sourceRunId || null,
      serial: this.serial,
      startedAt: replayStartedAt,
      endedAt: new Date().toISOString(),
      status: stopped ? 'stopped' : failed ? 'failed' : 'completed',
      summary: stopped ? 'Replay stopped by user' : failed ? failed.evaluation.summary : 'Replay completed',
      policy: this.policy,
      failureCounts: { hard: hardFailures, soft: softFailures },
      steps,
    });

    this.onEvent({
      type: 'replay-done',
      status: replayRecord.status,
      summary: replayRecord.summary,
      replayId: replayRecord.replayId,
      failedStep: failed?.step || null,
      failureCounts: replayRecord.failureCounts,
    });

    return replayRecord;
  }
}
import { appendManagerRound, createRunManifest, finalizeRun, saveRunStep } from './artifact-store.js';
import { evaluateRecordedStep } from './step-evaluator.js';

export class RunRecorder {
  static async create(options) {
    const manifest = await createRunManifest(options);
    return new RunRecorder(manifest);
  }

  constructor(manifest) {
    this.runId = manifest.runId;
    this.manifest = manifest;
    this.finished = false;
  }

  async recordManagerPlan(roundData) {
    if (this.finished) return;
    await appendManagerRound(this.runId, roundData);
  }

  async recordStep(stepRecord) {
    if (this.finished) return null;
    const evaluation = evaluateRecordedStep(stepRecord);
    return saveRunStep(this.runId, { ...stepRecord, evaluation });
  }

  async finish(status, summary = '') {
    if (this.finished) return;
    this.finished = true;
    await finalizeRun(this.runId, {
      status,
      summary,
      success: status === 'done' || status === 'completed',
    });
  }
}
import { promises as fs } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { deriveTargetHint } from '../playback/semantic-targeting.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = resolve(__dirname, '..', '..', 'artifacts');
const RUNS_DIR = join(ROOT_DIR, 'runs');
const SCRIPTS_DIR = join(ROOT_DIR, 'scripts');
const REPLAYS_DIR = join(ROOT_DIR, 'replays');

function slugify(value) {
  return String(value || 'item')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'item';
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await ensureDir(dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function stripScreenshot(state) {
  if (!state) return null;
  const { screenshotBase64, ...rest } = state;
  return rest;
}

async function writeBase64Image(rootPath, relativePath, screenshotBase64) {
  if (!screenshotBase64) return null;
  const normalized = relativePath.replace(/\\/g, '/');
  const target = join(rootPath, normalized);
  await ensureDir(dirname(target));
  await fs.writeFile(target, Buffer.from(screenshotBase64, 'base64'));
  return normalized;
}

async function listJsonFiles(dirPath) {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && entry.name.endsWith('.json')).map((entry) => entry.name);
  } catch {
    return [];
  }
}

export async function createRunManifest({ goal, serial, agentMode, provider }) {
  const runId = `${stamp()}-${slugify(goal)}`;
  const runDir = join(RUNS_DIR, runId);
  const manifest = {
    runId,
    goal,
    serial,
    agentMode,
    provider,
    startedAt: new Date().toISOString(),
    endedAt: null,
    status: 'running',
    success: false,
    stepCount: 0,
    managerRounds: [],
    artifactsVersion: 1,
    summary: '',
  };

  await ensureDir(join(runDir, 'steps'));
  await writeJson(join(runDir, 'run.json'), manifest);
  return manifest;
}

export async function updateRunManifest(runId, updater) {
  const filePath = join(RUNS_DIR, runId, 'run.json');
  const manifest = await readJson(filePath);
  const next = typeof updater === 'function' ? await updater({ ...manifest }) : { ...manifest, ...updater };
  await writeJson(filePath, next);
  return next;
}

export async function appendManagerRound(runId, roundData) {
  return updateRunManifest(runId, (manifest) => {
    const rounds = Array.isArray(manifest.managerRounds) ? [...manifest.managerRounds] : [];
    const index = rounds.findIndex((item) => item.round === roundData.round);
    if (index >= 0) rounds[index] = { ...rounds[index], ...roundData };
    else rounds.push(roundData);
    rounds.sort((a, b) => a.round - b.round);
    return { ...manifest, managerRounds: rounds };
  });
}

export async function saveRunStep(runId, stepRecord) {
  const runDir = join(RUNS_DIR, runId);
  const stepId = String(stepRecord.step).padStart(3, '0');
  const beforeImage = await writeBase64Image(runDir, `steps/${stepId}-before.png`, stepRecord.before?.screenshotBase64);
  const afterImage = await writeBase64Image(runDir, `steps/${stepId}-after.png`, stepRecord.after?.screenshotBase64);
  const targetHint = stepRecord.targetHint || deriveTargetHint(stepRecord.before?.elements || [], stepRecord.decision?.coordinates);
  const sanitized = {
    ...stepRecord,
    targetHint,
    before: { ...stripScreenshot(stepRecord.before), image: beforeImage },
    after: { ...stripScreenshot(stepRecord.after), image: afterImage },
  };

  await writeJson(join(runDir, 'steps', `${stepId}.json`), sanitized);
  await updateRunManifest(runId, (manifest) => ({
    ...manifest,
    stepCount: Math.max(manifest.stepCount || 0, stepRecord.step),
    lastUpdatedAt: new Date().toISOString(),
  }));
  return sanitized;
}

export async function finalizeRun(runId, fields) {
  return updateRunManifest(runId, (manifest) => ({
    ...manifest,
    ...fields,
    endedAt: new Date().toISOString(),
  }));
}

export async function listRuns() {
  await ensureDir(RUNS_DIR);
  const entries = await fs.readdir(RUNS_DIR, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      manifests.push(await readJson(join(RUNS_DIR, entry.name, 'run.json')));
    } catch {}
  }
  manifests.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  return manifests;
}

export async function getRun(runId, { includeSteps = false } = {}) {
  const manifest = await readJson(join(RUNS_DIR, runId, 'run.json'));
  if (!includeSteps) return manifest;

  const stepFiles = (await listJsonFiles(join(RUNS_DIR, runId, 'steps'))).sort();
  const steps = [];
  for (const fileName of stepFiles) {
    if (/-before\.png$|-after\.png$/i.test(fileName)) continue;
    steps.push(await readJson(join(RUNS_DIR, runId, 'steps', fileName)));
  }

  return { ...manifest, steps };
}

export async function createScriptFromRun({ runId, name, stepNumbers }) {
  const run = await getRun(runId, { includeSteps: true });
  const selected = Array.isArray(stepNumbers) && stepNumbers.length > 0
    ? run.steps.filter((step) => stepNumbers.includes(step.step))
    : run.steps.filter((step) => step.evaluation?.verdict !== 'fail');

  if (selected.length === 0) {
    throw new Error('No eligible steps found in the selected run');
  }

  const scriptId = `${slugify(name || run.goal)}-${Date.now()}`;
  const script = {
    scriptId,
    name: name || run.goal,
    description: `Generated from run ${run.runId}`,
    sourceRunId: run.runId,
    createdAt: new Date().toISOString(),
    agentMode: run.agentMode,
    tags: ['recorded'],
    stepCount: selected.length,
    steps: selected.map((step) => {
      const assertAfter = {};
      if (step.after?.foregroundApp && step.after.foregroundApp !== step.before?.foregroundApp) {
        assertAfter.foregroundApp = step.after.foregroundApp;
      }
      if (step.before?.screenshotHash && step.after?.screenshotHash && step.before.screenshotHash !== step.after.screenshotHash) {
        assertAfter.expectScreenChange = true;
      }

      const targetHint = deriveTargetHint(step.before?.elements || [], step.decision?.coordinates);

      return {
        step: step.step,
        name: step.subGoal || `${step.decision?.action || 'action'} ${step.step}`,
        sourceStep: step.step,
        round: step.round || null,
        subGoal: step.subGoal || null,
        action: step.decision,
        assertBefore: {
          foregroundApp: step.before?.foregroundApp || null,
        },
        assertAfter,
        targetHint,
        fallbackCoordinates: step.decision?.coordinates || null,
      };
    }),
  };

  await ensureDir(SCRIPTS_DIR);
  await writeJson(join(SCRIPTS_DIR, `${scriptId}.json`), script);
  return script;
}

export async function listScripts() {
  await ensureDir(SCRIPTS_DIR);
  const files = (await listJsonFiles(SCRIPTS_DIR)).sort().reverse();
  const scripts = [];
  for (const fileName of files) {
    scripts.push(await readJson(join(SCRIPTS_DIR, fileName)));
  }
  return scripts;
}

export async function getScript(scriptId) {
  return readJson(join(SCRIPTS_DIR, `${scriptId}.json`));
}

export async function listReplays() {
  await ensureDir(REPLAYS_DIR);
  const entries = await fs.readdir(REPLAYS_DIR, { withFileTypes: true });
  const manifests = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      manifests.push(await readJson(join(REPLAYS_DIR, entry.name, 'replay.json')));
    } catch {}
  }
  manifests.sort((a, b) => String(b.savedAt || b.startedAt).localeCompare(String(a.savedAt || a.startedAt)));
  return manifests;
}

export async function getReplay(replayId) {
  return readJson(join(REPLAYS_DIR, replayId, 'replay.json'));
}

export async function saveReplayResult(replayRecord) {
  await ensureDir(REPLAYS_DIR);
  const replayId = `${stamp()}-${slugify(replayRecord.scriptId || 'replay')}`;
  const replayDir = join(REPLAYS_DIR, replayId);
  await ensureDir(join(replayDir, 'steps'));

  const steps = [];
  for (const step of replayRecord.steps || []) {
    const stepId = String(step.step).padStart(3, '0');
    const beforeImage = await writeBase64Image(replayDir, `steps/${stepId}-before.png`, step.before?.screenshotBase64);
    const afterImage = await writeBase64Image(replayDir, `steps/${stepId}-after.png`, step.after?.screenshotBase64);
    const sanitized = {
      ...step,
      before: { ...stripScreenshot(step.before), image: beforeImage },
      after: { ...stripScreenshot(step.after), image: afterImage },
    };
    await writeJson(join(replayDir, 'steps', `${stepId}.json`), sanitized);
    steps.push(sanitized);
  }

  const manifest = {
    ...replayRecord,
    replayId,
    steps,
    savedAt: new Date().toISOString(),
  };
  await writeJson(join(replayDir, 'replay.json'), manifest);
  return manifest;
}
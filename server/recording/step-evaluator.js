function makeCheck(name, ok, detail) {
  return { name, ok: Boolean(ok), detail };
}

function classifyFailure(checks) {
  const failedNames = checks.filter((check) => !check.ok).map((check) => check.name);
  if (failedNames.includes('action_sent')) {
    return { category: 'execution', severity: 'hard' };
  }
  if (failedNames.some((name) => name.startsWith('precondition_'))) {
    return { category: 'environment', severity: 'hard' };
  }
  if (failedNames.some((name) => name.startsWith('postcondition_'))) {
    return { category: 'verification', severity: 'hard' };
  }
  if (failedNames.length > 0) {
    return { category: 'verification', severity: 'soft' };
  }
  return { category: 'none', severity: 'none' };
}

function buildSummary(verdict, checks) {
  const failed = checks.filter((check) => !check.ok).map((check) => check.name);
  const passed = checks.filter((check) => check.ok).map((check) => check.name);
  if (verdict === 'pass') {
    return passed.length > 0 ? `Passed: ${passed.join(', ')}` : 'Passed';
  }
  if (verdict === 'fail') {
    return failed.length > 0 ? `Failed: ${failed.join(', ')}` : 'Failed';
  }
  return failed.length > 0 ? `Uncertain: ${failed.join(', ')}` : 'Uncertain';
}

export function evaluateRecordedStep(stepRecord) {
  const checks = [];
  const decision = stepRecord.decision || {};
  const execution = stepRecord.execution || {};
  const before = stepRecord.before || {};
  const after = stepRecord.after || {};

  const actionSent = execution.ok !== false;
  const screenChanged = Boolean(before.screenshotHash && after.screenshotHash && before.screenshotHash !== after.screenshotHash);
  const foregroundChanged = Boolean(before.foregroundApp && after.foregroundApp && before.foregroundApp !== after.foregroundApp);

  checks.push(makeCheck('action_sent', actionSent, execution.error || execution.transport || 'executed'));

  if (decision.action === 'wait') {
    checks.push(makeCheck('wait_completed', actionSent, 'wait step'));
  } else if (decision.action === 'type') {
    checks.push(makeCheck('screen_changed', screenChanged, 'post-type screen diff'));
  } else if (decision.action === 'swipe' || decision.action === 'drag') {
    checks.push(makeCheck('screen_changed', screenChanged, 'post-motion screen diff'));
  } else if (decision.action === 'launch') {
    checks.push(makeCheck('foreground_changed', foregroundChanged || screenChanged, after.foregroundApp || 'no app change'));
  } else if (decision.action === 'press') {
    checks.push(makeCheck('screen_or_app_changed', foregroundChanged || screenChanged, after.foregroundApp || 'no visible change'));
  } else if (decision.action === 'tap') {
    checks.push(makeCheck('screen_or_app_changed', foregroundChanged || screenChanged, after.foregroundApp || 'no visible change'));
  }

  const failedChecks = checks.filter((check) => !check.ok);
  let verdict = 'uncertain';
  let confidence = 0.5;
  let failureType = 'soft';

  if (!actionSent) {
    verdict = 'fail';
    confidence = 0.99;
    failureType = 'hard';
  } else if (checks.length > 1 && failedChecks.length === 0) {
    verdict = 'pass';
    confidence = 0.9;
  } else if (decision.action === 'wait' && actionSent) {
    verdict = 'pass';
    confidence = 0.8;
  } else if (failedChecks.length > 0) {
    verdict = 'fail';
    confidence = 0.72;
  }

  return {
    verdict,
    confidence,
    failureType,
    failureCategory: verdict === 'fail' ? 'verification' : 'none',
    checks,
    summary: buildSummary(verdict, checks),
  };
}

export function evaluatePlaybackStep(scriptStep, before, after, execution) {
  const checks = [];
  const assertBefore = scriptStep.assertBefore || {};
  const assertAfter = scriptStep.assertAfter || {};
  const actionSent = execution.ok !== false;
  const screenChanged = Boolean(before.screenshotHash && after.screenshotHash && before.screenshotHash !== after.screenshotHash);

  checks.push(makeCheck('action_sent', actionSent, execution.error || execution.transport || 'executed'));

  if (assertBefore.foregroundApp) {
    checks.push(makeCheck('precondition_foreground', before.foregroundApp === assertBefore.foregroundApp, before.foregroundApp || 'unknown'));
  }
  if (assertAfter.foregroundApp) {
    checks.push(makeCheck('postcondition_foreground', after.foregroundApp === assertAfter.foregroundApp, after.foregroundApp || 'unknown'));
  }
  if (assertAfter.expectScreenChange) {
    checks.push(makeCheck('postcondition_screen_change', screenChanged, 'after screenshot hash check'));
  }

  if (!assertAfter.expectScreenChange && ['tap', 'swipe', 'drag', 'press', 'launch'].includes(scriptStep.action?.action)) {
    checks.push(makeCheck('advisory_screen_change', screenChanged, 'heuristic screen diff'));
  }

  const failedChecks = checks.filter((check) => !check.ok);
  const verdict = failedChecks.length === 0 ? 'pass' : 'fail';
  const classification = classifyFailure(checks);
  const retryable = failedChecks.every((check) => ['advisory_screen_change', 'postcondition_screen_change'].includes(check.name));

  return {
    verdict,
    confidence: verdict === 'pass' ? 0.93 : 0.86,
    failureType: classification.severity,
    failureCategory: classification.category,
    retryable,
    checks,
    summary: buildSummary(verdict, checks),
  };
}
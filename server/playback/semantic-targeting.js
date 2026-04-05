function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function distance(pointA, pointB) {
  if (!Array.isArray(pointA) || !Array.isArray(pointB)) return Number.POSITIVE_INFINITY;
  const dx = pointA[0] - pointB[0];
  const dy = pointA[1] - pointB[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function scoreCandidate(hint, candidate, resolution) {
  let score = 0;
  const label = normalizeText(candidate.text || candidate.desc || '');
  const hintedText = normalizeText(hint?.text);
  const hintedId = normalizeText(hint?.id);
  const hintedType = normalizeText(hint?.type);

  if (hintedText && label) {
    if (label === hintedText) score += 8;
    else if (label.includes(hintedText) || hintedText.includes(label)) score += 5;
  }
  if (hintedId && normalizeText(candidate.id) === hintedId) score += 7;
  if (hintedType && normalizeText(candidate.type) === hintedType) score += 2;

  if (Array.isArray(hint?.tap) && Array.isArray(candidate.tap)) {
    const diagonal = resolution ? Math.hypot(resolution.width || 1, resolution.height || 1) : 2000;
    const proximity = 1 - Math.min(distance(hint.tap, candidate.tap) / diagonal, 1);
    score += proximity * 4;
  }

  if (candidate.confidence) score += Math.min(candidate.confidence, 1);
  return score;
}

export function deriveTargetHint(elements, coordinates) {
  if (!Array.isArray(coordinates) || !Array.isArray(elements) || elements.length === 0) return null;

  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const element of elements) {
    if (!Array.isArray(element.tap)) continue;
    const currentDistance = distance(coordinates, element.tap);
    if (currentDistance < bestDistance) {
      bestDistance = currentDistance;
      best = element;
    }
  }

  if (!best || bestDistance > 180) return null;
  return {
    text: best.text || best.desc || null,
    desc: best.desc || null,
    id: best.id || null,
    type: best.type || null,
    tap: best.tap || best.center || null,
    bounds: best.bounds || null,
    source: best.source || 'ui',
  };
}

export function relocateDecision(decision, scriptStep, currentElements, resolution) {
  const action = decision?.action;
  if (!scriptStep?.targetHint || !['tap', 'drag'].includes(action)) {
    return { decision, relocated: false, reason: 'no-target-hint' };
  }

  const candidates = (currentElements || []).filter((element) => Array.isArray(element.tap));
  if (candidates.length === 0) {
    return { decision, relocated: false, reason: 'no-candidates' };
  }

  const scored = candidates
    .map((candidate) => ({ candidate, score: scoreCandidate(scriptStep.targetHint, candidate, resolution) }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < 4.5) {
    return { decision, relocated: false, reason: 'no-confident-match' };
  }

  const relocatedDecision = { ...decision };
  const originalCoordinates = decision.coordinates;
  relocatedDecision.coordinates = best.candidate.tap;

  if (action === 'drag' && Array.isArray(originalCoordinates) && Array.isArray(decision.endCoordinates)) {
    const dx = decision.endCoordinates[0] - originalCoordinates[0];
    const dy = decision.endCoordinates[1] - originalCoordinates[1];
    relocatedDecision.endCoordinates = [
      Math.round(best.candidate.tap[0] + dx),
      Math.round(best.candidate.tap[1] + dy),
    ];
  }

  return {
    decision: relocatedDecision,
    relocated: true,
    reason: 'semantic-match',
    match: {
      score: Number(best.score.toFixed(2)),
      text: best.candidate.text || best.candidate.desc || null,
      id: best.candidate.id || null,
      type: best.candidate.type || null,
      tap: best.candidate.tap || null,
    },
  };
}
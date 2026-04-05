import { createHash } from 'crypto';
import { captureScreenshot, getForegroundApp, getScreenElements } from '../chat/perception.js';

export function summarizeElements(elements, limit = 40) {
  return (elements || []).slice(0, limit).map((element) => ({
    i: element.index,
    text: element.text || undefined,
    desc: element.desc || undefined,
    type: element.type || undefined,
    id: element.id || undefined,
    tap: element.clickable ? element.center : undefined,
    center: element.center || undefined,
    bounds: element.bounds || undefined,
    scroll: element.scrollable || undefined,
    confidence: element.confidence,
    source: element.source || 'ui',
  }));
}

export function hashBase64Image(base64) {
  if (!base64) return null;
  return createHash('sha1').update(base64).digest('hex').slice(0, 16);
}

export async function captureStepState(serial, resolution, extras = {}) {
  const [{ elements, meta }, foregroundApp, screenshot] = await Promise.all([
    getScreenElements(serial),
    getForegroundApp(serial),
    captureScreenshot(serial),
  ]);

  return {
    capturedAt: new Date().toISOString(),
    foregroundApp: foregroundApp || null,
    resolution: resolution || null,
    screenshotBase64: screenshot || null,
    screenshotHash: hashBase64Image(screenshot),
    elements: summarizeElements(elements),
    totalElements: elements.length,
    modalDetected: Boolean(meta?.modalDetected),
    modalMetrics: meta?.modalMetrics || null,
    ...extras,
  };
}
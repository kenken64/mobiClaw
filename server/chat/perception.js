/**
 * Screen perception: reads the UI accessibility tree and captures screenshots.
 * Uses uiautomator dump + screencap via ADB.
 */
import { getClient } from '../adb/adb-client.js';
import { GoogleGenAI } from '@google/genai';
import { captureFreshVisionFrame, getCachedVisionFrame } from '../stream/vision-frame-cache.js';

const DUMP_PATH = '/sdcard/window_dump.xml';
const OCR_MAX_RESULTS = parseInt(process.env.AGENT_OCR_MAX_RESULTS || '12', 10);

let ocrClient = null;
const ocrCache = new Map();

/**
 * Dump the accessibility tree and parse interactive UI elements.
 */
export async function getScreenElements(serial) {
  const device = getClient().getDevice(serial);

  // Dump UI hierarchy
  try {
    await shell(device, `uiautomator dump ${DUMP_PATH}`);
  } catch {
    return { elements: [], raw: '', meta: { modalDetected: false, totalElements: 0 } };
  }

  // Pull the XML
  const stream = await device.shell(`cat ${DUMP_PATH}`);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const xml = Buffer.concat(chunks).toString('utf-8').replace(/\r/g, '');

  // Parse elements
  const parsed = parseElements(xml);
  return { elements: parsed.elements, raw: xml, meta: parsed.meta };
}

/**
 * Capture screenshot as base64 PNG.
 * Saves to sdcard first to avoid binary corruption over adb shell.
 */
export async function captureScreenshot(serial) {
  const cached = getCachedVisionFrame(serial, 1500);
  if (cached) return cached;

  return captureFreshVisionFrame(serial, 'perception-fallback');
}

/**
 * Capture screenshot as base64 PNG without consulting the shared cache.
 */
export async function captureScreenshotFresh(serial) {
  try {
    return await captureFreshVisionFrame(serial, 'perception-fresh');
  } catch {
    return null;
  }
}

/**
 * Get the foreground app package name.
 */
export async function getForegroundApp(serial) {
  const device = getClient().getDevice(serial);
  try {
    // Android 16 uses topResumedActivity, older uses mResumedActivity
    const out = await shellOutput(device, 'dumpsys activity activities');
    // Try multiple patterns
    const patterns = [
      /topResumedActivity=.*?([a-zA-Z][a-zA-Z0-9_.]+)\//,
      /mResumedActivity=.*?([a-zA-Z][a-zA-Z0-9_.]+)\//,
      /mFocusedApp=.*?([a-zA-Z][a-zA-Z0-9_.]+)\//,
    ];
    for (const pattern of patterns) {
      const match = out.match(pattern);
      if (match) return match[1];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Optional OCR extraction using Gemini Vision.
 * Enabled by AGENT_OCR_ENABLE=1 and requires GEMINI_API_KEY.
 */
export async function extractOcrElements(screenshotBase64) {
  if (process.env.AGENT_OCR_ENABLE !== '1') return [];
  if (!process.env.GEMINI_API_KEY || !screenshotBase64) return [];

  const screenshotHash = quickHash(screenshotBase64);
  if (ocrCache.has(screenshotHash)) {
    return ocrCache.get(screenshotHash);
  }

  try {
    if (!ocrClient) ocrClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

    const model = process.env.GEMINI_OCR_MODEL || process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
    const prompt = [
      'Extract visible UI text regions from this Android screenshot.',
      'Return ONLY JSON in this exact shape:',
      '{"items":[{"text":"Settings","bounds":[x1,y1,x2,y2],"confidence":0.92}]}',
      'Rules:',
      '- bounds are pixel coordinates in original image',
      '- include only readable text likely useful for tapping/navigation',
      '- confidence must be 0..1',
      `- max ${OCR_MAX_RESULTS} items`,
    ].join('\n');

    const response = await ocrClient.models.generateContent({
      model,
      config: {
        responseMimeType: 'application/json',
        maxOutputTokens: 1024,
      },
      contents: [{
        role: 'user',
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: 'image/png',
              data: screenshotBase64,
            },
          },
        ],
      }],
    });

    const parsed = parseOcrResponse(response?.text || '');
    ocrCache.set(screenshotHash, parsed);
    if (ocrCache.size > 12) {
      const firstKey = ocrCache.keys().next().value;
      ocrCache.delete(firstKey);
    }
    return parsed;
  } catch {
    return [];
  }
}

/**
 * Merge OCR elements into UIAutomator elements with overlap/text dedupe.
 */
export function fuseElementsWithOcr(elements, ocrElements) {
  if (!ocrElements || ocrElements.length === 0) return elements;

  const merged = [...elements];
  const labeled = elements.filter((e) => (e.text || e.desc) && e.bounds);

  for (const ocr of ocrElements) {
    const duplicate = labeled.some((elem) => {
      const iou = boundsIou(elem.bounds, ocr.bounds);
      const sameText = normalizeText(elem.text || elem.desc) === normalizeText(ocr.text);
      return iou >= 0.55 || (sameText && iou >= 0.2);
    });
    if (duplicate) continue;

    const [x1, y1, x2, y2] = ocr.bounds;
    merged.push({
      index: merged.length,
      text: ocr.text,
      desc: '',
      type: 'OCR',
      id: `ocr_${merged.length}`,
      clickable: true,
      focusable: false,
      longClickable: false,
      scrollable: false,
      bounds: [x1, y1, x2, y2],
      center: [Math.round((x1 + x2) / 2), Math.round((y1 + y2) / 2)],
      confidence: ocr.confidence,
      source: 'ocr',
      score: 5 + (ocr.confidence || 0),
    });
  }

  return merged;
}

/**
 * Parse the UI XML into interactive elements with bounds.
 */
function parseElements(xml) {
  const parsedElements = [];
  // Match each <node> element
  const nodeRegex = /<node\s[^>]*>/g;
  let match;

  while ((match = nodeRegex.exec(xml)) !== null) {
    const node = match[0];

    const text = attr(node, 'text');
    const desc = attr(node, 'content-desc');
    const cls = attr(node, 'class');
    const resId = attr(node, 'resource-id');
    const clickable = attr(node, 'clickable') === 'true';
    const enabled = attr(node, 'enabled') === 'true';
    const focusable = attr(node, 'focusable') === 'true';
    const longClickable = attr(node, 'long-clickable') === 'true';
    const scrollable = attr(node, 'scrollable') === 'true';
    const bounds = attr(node, 'bounds');

    // Only include interactive or labeled elements
    const isInteractive = clickable || focusable || longClickable || scrollable;
    const hasLabel = text || desc;
    if (!isInteractive && !hasLabel) continue;
    if (!enabled) continue;
    if (!bounds) continue;

    // Parse bounds "[x1,y1][x2,y2]"
    const bm = bounds.match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (!bm) continue;
    const x1 = parseInt(bm[1]), y1 = parseInt(bm[2]);
    const x2 = parseInt(bm[3]), y2 = parseInt(bm[4]);
    const cx = Math.round((x1 + x2) / 2);
    const cy = Math.round((y1 + y2) / 2);

    // Skip invisible elements (zero size)
    if (x2 <= x1 || y2 <= y1) continue;

    const shortClass = cls ? cls.split('.').pop() : '';

    parsedElements.push({
      index: parsedElements.length,
      text: text || '',
      desc: desc || '',
      type: shortClass,
      id: resId ? resId.split('/').pop() : '',
      clickable,
      focusable,
      longClickable,
      scrollable,
      bounds: [x1, y1, x2, y2],
      center: [cx, cy],
    });
  }

  if (parsedElements.length === 0) {
    return { elements: [], meta: { modalDetected: false, totalElements: 0 } };
  }

  const screen = inferScreenBounds(parsedElements);
  const modalConfig = getModalHeuristicConfig();
  const modalDetected = hasModalOverlay(parsedElements, screen, modalConfig);
  const baseSet = modalDetected ? selectModalFocusedElements(parsedElements, screen) : parsedElements;

  const ranked = baseSet
    .map((element) => {
      const score = computeElementScore(element, screen);
      const confidence = computeElementConfidence(element, screen);
      return { ...element, score, confidence };
    })
    .sort((a, b) => b.score - a.score)
    .map((element, i) => ({ ...element, index: i }));

  return {
    elements: ranked,
    meta: {
      modalDetected,
      totalElements: parsedElements.length,
      modalMetrics: buildModalMetrics(parsedElements, baseSet, screen, modalConfig),
    },
  };
}

function inferScreenBounds(elements) {
  let maxX = 0;
  let maxY = 0;
  for (const element of elements) {
    maxX = Math.max(maxX, element.bounds[2]);
    maxY = Math.max(maxY, element.bounds[3]);
  }
  return { width: maxX || 1080, height: maxY || 1920 };
}

function hasModalOverlay(elements, screen, config) {
  const screenArea = Math.max(1, screen.width * screen.height);
  for (const element of elements) {
    const area = getElementArea(element);
    const hasLabel = Boolean(element.text || element.desc);
    const largePanel = area / screenArea >= config.panelMinRatio;
    const topRegion = element.bounds[1] <= Math.round(screen.height * config.topRegionMax);
    if (largePanel && (element.clickable || hasLabel) && topRegion) {
      return true;
    }
  }
  return false;
}

function selectModalFocusedElements(elements, screen) {
  const centerX = Math.round(screen.width / 2);
  const centerY = Math.round(screen.height / 2);
  const screenArea = Math.max(1, screen.width * screen.height);

  const config = getModalHeuristicConfig();
  const nearCenter = elements.filter((element) => {
    const [x1, y1, x2, y2] = element.bounds;
    const area = getElementArea(element);
    const coversCenter = x1 <= centerX && x2 >= centerX && y1 <= centerY && y2 >= centerY;
    const largeEnough = area / screenArea >= config.centerMinRatio;
    return coversCenter || largeEnough;
  });

  return nearCenter.length > 0 ? nearCenter : elements;
}

function computeElementScore(element, screen) {
  const interactiveBonus = element.clickable ? 5 : 0;
  const focusBonus = element.focusable ? 2 : 0;
  const scrollBonus = element.scrollable ? 2 : 0;
  const labelBonus = (element.text || element.desc) ? 4 : 0;
  const typeBonus = element.type && /Button|TextView|EditText|ImageButton/i.test(element.type) ? 1 : 0;
  const area = getElementArea(element);
  const areaRatio = area / Math.max(1, screen.width * screen.height);
  const sizeBonus = Math.min(3, areaRatio * 20);
  return interactiveBonus + focusBonus + scrollBonus + labelBonus + typeBonus + sizeBonus;
}

function computeElementConfidence(element, screen) {
  const hasText = Boolean(element.text || element.desc);
  const area = getElementArea(element);
  const areaRatio = area / Math.max(1, screen.width * screen.height);

  let confidence = 0.35;
  if (element.clickable) confidence += 0.25;
  if (hasText) confidence += 0.2;
  if (areaRatio >= 0.004) confidence += 0.1;
  if (areaRatio >= 0.02) confidence += 0.1;

  return Math.max(0.1, Math.min(0.99, Number(confidence.toFixed(2))));
}

function getElementArea(element) {
  const [x1, y1, x2, y2] = element.bounds;
  return Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
}

function parseOcrResponse(text) {
  let payload = text || '';
  payload = payload.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  let obj = null;
  try {
    obj = JSON.parse(payload);
  } catch {
    try {
      const match = payload.match(/\{[\s\S]*\}/);
      if (match) obj = JSON.parse(match[0]);
    } catch {
      obj = null;
    }
  }

  const rawItems = Array.isArray(obj?.items) ? obj.items : [];
  const clean = [];

  for (const item of rawItems) {
    const textValue = String(item?.text || '').trim();
    const bounds = item?.bounds;
    if (!textValue || !Array.isArray(bounds) || bounds.length !== 4) continue;

    const nums = bounds.map((n) => Number(n));
    if (nums.some((n) => !Number.isFinite(n))) continue;
    const [x1, y1, x2, y2] = nums.map((n) => Math.round(n));
    if (x2 <= x1 || y2 <= y1) continue;

    let confidence = Number(item?.confidence);
    if (!Number.isFinite(confidence)) confidence = 0.6;
    confidence = Math.max(0.1, Math.min(0.99, Number(confidence.toFixed(2))));

    clean.push({ text: textValue, bounds: [x1, y1, x2, y2], confidence });
    if (clean.length >= OCR_MAX_RESULTS) break;
  }

  return clean;
}

function quickHash(input) {
  const stride = Math.max(1, Math.floor(input.length / 48));
  let hash = '';
  for (let i = 0; i < input.length && hash.length < 48; i += stride) {
    hash += input[i];
  }
  return hash;
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function boundsIou(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0;
  const xLeft = Math.max(a[0], b[0]);
  const yTop = Math.max(a[1], b[1]);
  const xRight = Math.min(a[2], b[2]);
  const yBottom = Math.min(a[3], b[3]);
  const intersection = Math.max(0, xRight - xLeft) * Math.max(0, yBottom - yTop);
  if (intersection <= 0) return 0;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - intersection;
  if (union <= 0) return 0;
  return intersection / union;
}

function getModalHeuristicConfig() {
  return {
    panelMinRatio: clamp01(parseFloat(process.env.AGENT_MODAL_PANEL_MIN_RATIO || '0.45')),
    topRegionMax: clamp01(parseFloat(process.env.AGENT_MODAL_TOP_REGION_MAX || '0.20')),
    centerMinRatio: clamp01(parseFloat(process.env.AGENT_MODAL_CENTER_MIN_RATIO || '0.08')),
  };
}

function buildModalMetrics(allElements, selectedElements, screen, config) {
  const screenArea = Math.max(1, screen.width * screen.height);
  const maxRatio = allElements.reduce((max, element) => {
    return Math.max(max, getElementArea(element) / screenArea);
  }, 0);
  const selectedRatio = selectedElements.length / Math.max(1, allElements.length);

  const metrics = {
    panelMinRatio: Number(config.panelMinRatio.toFixed(3)),
    topRegionMax: Number(config.topRegionMax.toFixed(3)),
    centerMinRatio: Number(config.centerMinRatio.toFixed(3)),
    maxElementAreaRatio: Number(maxRatio.toFixed(3)),
    selectedRatio: Number(selectedRatio.toFixed(3)),
  };

  if (process.env.AGENT_MODAL_DEBUG === '1') {
    console.log('[Perception][Modal]', metrics);
  }

  return metrics;
}

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function attr(node, name) {
  const m = node.match(new RegExp(`${name}="([^"]*)"`));
  return m ? m[1] : '';
}

async function shell(device, cmd) {
  const stream = await device.shell(cmd);
  for await (const _ of stream) {}
}

async function shellOutput(device, cmd) {
  const stream = await device.shell(cmd);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf-8').replace(/\r/g, '').trim();
}

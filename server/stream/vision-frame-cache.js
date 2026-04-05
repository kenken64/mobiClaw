import { getClient } from '../adb/adb-client.js';

const frameCache = new Map();
const refreshers = new Map();

async function capturePngBuffer(serial) {
  const device = getClient().getDevice(serial);
  const stream = await device.shell('exec-out screencap -p');
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk, 'binary') : chunk);
  }
  const buffer = Buffer.concat(chunks);
  if (buffer.length < 8 || buffer[0] !== 0x89 || buffer[1] !== 0x50) {
    return null;
  }
  return buffer;
}

export function updateVisionFrame(serial, { buffer, base64, source = 'unknown' }) {
  if (!serial) return null;
  const encoded = base64 || (buffer ? buffer.toString('base64') : null);
  if (!encoded) return null;
  const record = {
    base64: encoded,
    source,
    capturedAt: Date.now(),
  };
  frameCache.set(serial, record);
  return record;
}

export function getCachedVisionFrame(serial, maxAgeMs = 1200) {
  const record = frameCache.get(serial);
  if (!record) return null;
  if (Date.now() - record.capturedAt > maxAgeMs) return null;
  return record.base64;
}

export async function captureFreshVisionFrame(serial, source = 'adb-screencap') {
  const buffer = await capturePngBuffer(serial);
  if (!buffer) return null;
  return updateVisionFrame(serial, { buffer, source })?.base64 || null;
}

export function clearVisionFrame(serial) {
  frameCache.delete(serial);
}

export function startVisionFrameFeed(serial, { intervalMs = 600 } = {}) {
  if (!serial) return;

  const existing = refreshers.get(serial);
  if (existing) {
    existing.refCount += 1;
    return;
  }

  const state = {
    refCount: 1,
    running: false,
    timer: null,
  };

  async function tick() {
    if (state.running) return;
    state.running = true;
    try {
      await captureFreshVisionFrame(serial, 'mirror-cache');
    } catch {
      // Ignore intermittent capture failures; perception will fall back if needed.
    } finally {
      state.running = false;
    }
  }

  state.timer = setInterval(tick, intervalMs);
  refreshers.set(serial, state);
  tick().catch(() => {});
}

export function stopVisionFrameFeed(serial) {
  const existing = refreshers.get(serial);
  if (!existing) return;

  existing.refCount -= 1;
  if (existing.refCount > 0) return;

  if (existing.timer) clearInterval(existing.timer);
  refreshers.delete(serial);
}
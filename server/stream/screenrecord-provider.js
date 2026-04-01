/**
 * Screen streaming via adb shell screenrecord using adbkit.
 * No 5-second disconnect on Android 16.
 * Auto-restarts before the 3-minute Android limit.
 */
import { getClient } from '../adb/adb-client.js';
import config from '../config.js';

const MAX_RECORD_SECONDS = 170;
const NALU_SPS = 7;
const NALU_PPS = 8;
const NALU_IDR = 5;

export class ScreenrecordProvider {
  constructor(serial) {
    this.serial = serial;
    this.running = false;
    this.frameCallback = null;
    this.frameCount = 0;
    this.fps = 0;
    this._fpsTimer = null;
    this._stream = null;
    this._sps = null;
    this._pps = null;
  }

  onFrame(callback) { this.frameCallback = callback; }
  getControlSocket() { return null; }
  getInfo() { return { type: 'h264', fps: this.fps }; }

  async start() {
    if (this.running) return;
    this.running = true;
    this.frameCount = 0;

    this._fpsTimer = setInterval(() => {
      this.fps = this.frameCount;
      this.frameCount = 0;
    }, 1000);

    await this._startRecording();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._fpsTimer) { clearInterval(this._fpsTimer); this._fpsTimer = null; }
    if (this._stream) { try { this._stream.destroy(); } catch (_) {} this._stream = null; }
    console.log('[Screenrecord] Stopped');
  }

  async _startRecording() {
    if (!this.running) return;

    const device = getClient().getDevice(this.serial);
    const cmd = `screenrecord --output-format=h264 --bit-rate=${config.scrcpy.bitRate} --time-limit=${MAX_RECORD_SECONDS} /dev/fd/1`;

    console.log('[Screenrecord] Starting stream via adbkit shell...');

    try {
      this._stream = await device.shell(cmd);
    } catch (err) {
      console.error('[Screenrecord] Failed to start:', err.message);
      if (this.running) {
        setTimeout(() => this._startRecording(), 1000);
      }
      return;
    }

    let buffer = Buffer.alloc(0);

    this._stream.on('data', (chunk) => {
      if (!this.running) return;

      // Ensure chunk is a Buffer
      if (typeof chunk === 'string') chunk = Buffer.from(chunk, 'binary');

      buffer = Buffer.concat([buffer, chunk]);

      // Find and emit complete NALUs (split on 00 00 00 01 start codes)
      let lastStart = -1;
      let i = 0;
      while (i < buffer.length - 4) {
        if (buffer[i] === 0 && buffer[i + 1] === 0 && buffer[i + 2] === 0 && buffer[i + 3] === 1) {
          if (lastStart !== -1) {
            this._emitNalu(buffer.subarray(lastStart, i));
          }
          lastStart = i;
          i += 4;
        } else {
          i++;
        }
      }

      // Keep unprocessed data
      if (lastStart > 0) {
        buffer = buffer.subarray(lastStart);
      } else if (buffer.length > 1024 * 1024) {
        // Safety: flush oversized buffer
        if (lastStart === -1 && buffer.length > 4) {
          this._emitNalu(buffer);
        }
        buffer = Buffer.alloc(0);
      }
    });

    this._stream.on('end', () => {
      console.log('[Screenrecord] Stream ended');
      if (this.running) {
        console.log('[Screenrecord] Auto-restarting...');
        setTimeout(() => this._startRecording(), 300);
      }
    });

    this._stream.on('error', (err) => {
      console.error('[Screenrecord] Stream error:', err.message);
      if (this.running) {
        setTimeout(() => this._startRecording(), 1000);
      }
    });
  }

  _emitNalu(data) {
    if (!this.frameCallback || !this.running || data.length < 5) return;

    // Find NALU type after start code
    let off = 0;
    if (data[0] === 0 && data[1] === 0 && data[2] === 0 && data[3] === 1) off = 4;
    else if (data[0] === 0 && data[1] === 0 && data[2] === 1) off = 3;
    const naluType = data[off] & 0x1f;

    // Buffer SPS and PPS - don't emit separately
    if (naluType === NALU_SPS) {
      this._sps = Buffer.from(data);
      return;
    }
    if (naluType === NALU_PPS) {
      this._pps = Buffer.from(data);
      // Emit combined SPS+PPS as config
      if (this._sps) {
        const config = Buffer.concat([this._sps, this._pps]);
        if (this.frameCount < 3) console.log(`[Screenrecord] Config: ${config.length} bytes (SPS+PPS)`);
        this.frameCallback(config, { isConfig: true, isKeyframe: true, pts: 0 });
        this.frameCount++;
      }
      return;
    }

    // For IDR keyframes, prepend SPS+PPS
    if (naluType === NALU_IDR && this._sps && this._pps) {
      const full = Buffer.concat([this._sps, this._pps, data]);
      if (this.frameCount < 3) console.log(`[Screenrecord] Keyframe: ${full.length} bytes (SPS+PPS+IDR)`);
      this.frameCallback(full, { isConfig: false, isKeyframe: true, pts: 0 });
      this.frameCount++;
      return;
    }

    // Regular P-frames
    this.frameCallback(data, { isConfig: false, isKeyframe: false, pts: 0 });
    this.frameCount++;
  }
}

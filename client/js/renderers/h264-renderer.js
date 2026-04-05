/**
 * H.264 renderer using WebCodecs API.
 *
 * Frame format from server:
 *   [1 byte: 0x02] [1 byte: flags] [4 bytes: PTS] [N bytes: H.264 data]
 *   flags bit 0: isConfig (SPS/PPS)
 *   flags bit 1: isKeyframe
 */
export class H264Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this._decoder = null;
    this._configured = false;
    this._configData = null;       // Raw SPS+PPS bytes (Annex B)
    this._waitingForKeyframe = true;
    this._frameCount = 0;
    this._lastFpsTime = performance.now();
    this.clientFps = 0;
    this._supported = typeof VideoDecoder !== 'undefined';
    this._pts = 0;
    this._pendingFrame = null;
    this._drainScheduled = false;
    this._latestDecodedFrame = null;
    this._paintScheduled = false;
    if (this.ctx) {
      this.ctx.imageSmoothingEnabled = false;
    }
  }

  get supported() { return this._supported; }

  async renderFrame(arrayBuffer) {
    this._pendingFrame = arrayBuffer;
    if (this._drainScheduled) return;
    this._drainScheduled = true;

    queueMicrotask(async () => {
      try {
        const latest = this._pendingFrame;
        this._pendingFrame = null;
        if (latest) {
          await this._decodeFrame(latest);
        }
      } finally {
        this._drainScheduled = false;
        if (this._pendingFrame) {
          this.renderFrame(this._pendingFrame);
        }
      }
    });
  }

  async _decodeFrame(arrayBuffer) {
    if (!this._supported) return;

    const view = new DataView(arrayBuffer);
    const flags = view.getUint8(1);
    const pts = view.getInt32(2);
    const h264Data = new Uint8Array(arrayBuffer, 6);

    const isConfig = (flags & 0x01) !== 0;
    const isKeyframe = (flags & 0x02) !== 0;

    if (isConfig) {
      this._configData = h264Data.slice();
      this._waitingForKeyframe = true;
      await this._ensureDecoder();
      console.log('[H264] Got config data:', this._configData.length, 'bytes');
      return;
    }

    if (!this._configured || !this._configData) return;

    // Detect keyframe from NALU type (more reliable than server flag)
    const naluType = this._findFirstNaluType(h264Data);
    const reallyKeyframe = isKeyframe || naluType === 5 || naluType === 7;

    // Must wait for a keyframe before we can start decoding
    if (this._waitingForKeyframe && !reallyKeyframe) return;

    this._pts += 1000;

    // Keep latency low by preferring freshness over perfect frame retention.
    if (this._decoder && this._decoder.decodeQueueSize > 0 && !reallyKeyframe) {
      return;
    }

    // If the queue still builds up, reset quickly instead of letting seconds of lag accumulate.
    if (this._decoder && this._decoder.decodeQueueSize > 2) {
      this._decoder.reset();
      await this._ensureDecoder();
      this._waitingForKeyframe = true;
      return;
    }

    try {
      let data;
      if (reallyKeyframe) {
        data = this._prependConfig(h264Data);
        this._waitingForKeyframe = false;
      } else {
        data = h264Data;
      }

      const chunk = new EncodedVideoChunk({
        type: reallyKeyframe ? 'key' : 'delta',
        timestamp: this._pts,
        data: data,
      });

      if (this._decoder && this._decoder.state === 'configured') {
        this._decoder.decode(chunk);
      }
    } catch (e) {
      if (e.message && e.message.includes('key frame is required')) {
        this._waitingForKeyframe = true;
      } else {
        console.warn('[H264] Decode:', e.message);
      }
    }

    this._frameCount++;
    const now = performance.now();
    if (now - this._lastFpsTime >= 1000) {
      this.clientFps = this._frameCount;
      this._frameCount = 0;
      this._lastFpsTime = now;
    }
  }

  async _ensureDecoder() {
    if (this._decoder && this._decoder.state !== 'closed') {
      this._decoder.close();
    }

    const codecString = this._parseCodecString(this._configData);
    console.log('[H264] Configuring decoder:', codecString);

    this._decoder = new VideoDecoder({
      output: (frame) => {
        if (this._latestDecodedFrame) {
          this._latestDecodedFrame.close();
        }
        this._latestDecodedFrame = frame;
        this._schedulePaint();
      },
      error: (e) => {
        console.error('[H264] Decoder error:', e.message);
        this._waitingForKeyframe = true;
      },
    });

    this._decoder.configure({
      codec: codecString,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true,
    });

    this._configured = true;
    this._pts = 0;
  }

  /** Prepend SPS/PPS config data before keyframe data */
  _prependConfig(frameData) {
    // Check if frame already contains SPS (type 7)
    if (this._findFirstNaluType(frameData) === 7) {
      return frameData; // Already has config
    }
    // Concatenate: [config SPS+PPS] [keyframe IDR]
    const combined = new Uint8Array(this._configData.length + frameData.length);
    combined.set(this._configData, 0);
    combined.set(frameData, this._configData.length);
    return combined;
  }

  /** Find NALU type of first NALU in Annex B data */
  _findFirstNaluType(data) {
    for (let i = 0; i < data.length - 4; i++) {
      if (data[i] === 0 && data[i + 1] === 0) {
        let naluStart;
        if (data[i + 2] === 0 && data[i + 3] === 1) {
          naluStart = i + 4;
        } else if (data[i + 2] === 1) {
          naluStart = i + 3;
        }
        if (naluStart !== undefined && naluStart < data.length) {
          return data[naluStart] & 0x1f;
        }
      }
    }
    // No start code found, try raw NALU
    if (data.length > 0) return data[0] & 0x1f;
    return -1;
  }

  _parseCodecString(data) {
    if (!data || data.length < 4) return 'avc1.42E01E';

    for (let i = 0; i < data.length - 4; i++) {
      let naluStart = -1;
      if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 0 && data[i + 3] === 1) {
        naluStart = i + 4;
      } else if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
        naluStart = i + 3;
      }

      if (naluStart !== -1 && naluStart + 3 < data.length) {
        const naluType = data[naluStart] & 0x1f;
        if (naluType === 7) {
          const profile = data[naluStart + 1];
          const compat = data[naluStart + 2];
          const level = data[naluStart + 3];
          const hex = n => n.toString(16).padStart(2, '0');
          return `avc1.${hex(profile)}${hex(compat)}${hex(level)}`;
        }
      }
    }
    return 'avc1.42E01E';
  }

  destroy() {
    if (this._latestDecodedFrame) {
      this._latestDecodedFrame.close();
      this._latestDecodedFrame = null;
    }
    if (this._decoder && this._decoder.state !== 'closed') {
      this._decoder.close();
    }
    this._configured = false;
    this._pendingFrame = null;
    this._drainScheduled = false;
    this._paintScheduled = false;
  }

  _schedulePaint() {
    if (this._paintScheduled) return;
    this._paintScheduled = true;
    requestAnimationFrame(() => {
      this._paintScheduled = false;
      const frame = this._latestDecodedFrame;
      this._latestDecodedFrame = null;
      if (!frame || !this.ctx) return;
      if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
        this.canvas.width = frame.displayWidth;
        this.canvas.height = frame.displayHeight;
      }
      this.ctx.drawImage(frame, 0, 0);
      frame.close();
      if (this._latestDecodedFrame) {
        this._schedulePaint();
      }
    });
  }
}

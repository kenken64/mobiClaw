/**
 * WebRTC DataChannel handler for low-latency H.264 streaming.
 * Uses unreliable DataChannel (UDP semantics) instead of WebSocket (TCP).
 * Browser decodes with WebCodecs - same decoder, faster transport.
 */
import { RTCPeerConnection } from 'werift';

const FRAME_PREFIX_H264 = 0x02;

export class RtcSession {
  constructor() {
    this.pc = null;
    this.dataChannel = null;
    this._ready = false;
    this._bufferedAmount = 0;
  }

  async createOffer() {
    this.pc = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: 'max-bundle',
    });

    // Create unreliable DataChannel (UDP-like: no retransmit, unordered)
    this.dataChannel = this.pc.createDataChannel('video', {
      ordered: false,
      maxRetransmits: 0,
    });

    this.dataChannel.onopen = () => {
      console.log('[WebRTC DC] DataChannel open');
      this._ready = true;
    };

    this.dataChannel.onclose = () => {
      console.log('[WebRTC DC] DataChannel closed');
      this._ready = false;
    };

    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      console.log('[WebRTC] Connection:', state);
      if (state === 'failed' || state === 'closed') {
        this._ready = false;
      }
    };

    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    return this.pc.localDescription;
  }

  async setAnswer(answer) {
    await this.pc.setRemoteDescription(answer);
  }

  waitForConnection(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (this._ready) return resolve();
      const timer = setTimeout(() => reject(new Error('WebRTC DC timeout')), timeoutMs);
      const check = () => {
        if (this._ready) {
          clearTimeout(timer);
          resolve();
        } else if (this.pc?.connectionState === 'failed' || this.pc?.connectionState === 'closed') {
          clearTimeout(timer);
          reject(new Error('WebRTC connection failed'));
        } else {
          setTimeout(check, 50);
        }
      };
      check();
    });
  }

  /**
   * Send H.264 frame over DataChannel.
   * Same format as WebSocket: [prefix][flags][pts][h264 data]
   * But over UDP - no head-of-line blocking.
   */
  sendFrame(frameBuffer, meta) {
    if (!this._ready || !this.dataChannel) return;

    // Keep only near-real-time data in flight.
    if (this.dataChannel.bufferedAmount > 128 * 1024) {
      if (!meta.isConfig && !meta.isKeyframe) return;
    }
    if (this.dataChannel.bufferedAmount > 384 * 1024 && !meta.isConfig) return;
    if (this.dataChannel.bufferedAmount > 768 * 1024) return;

    const header = Buffer.alloc(6);
    header[0] = FRAME_PREFIX_H264;
    let flags = 0;
    if (meta.isConfig) flags |= 0x01;
    if (meta.isKeyframe) flags |= 0x02;
    header[1] = flags;
    header.writeInt32BE(meta.pts & 0x7FFFFFFF, 2);

    const combined = Buffer.concat([header, frameBuffer]);

    try {
      this.dataChannel.send(combined);
    } catch (e) {
      // Ignore send errors
    }
  }

  close() {
    this._ready = false;
    if (this.dataChannel) {
      try { this.dataChannel.close(); } catch (_) {}
      this.dataChannel = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch (_) {}
      this.pc = null;
    }
  }
}

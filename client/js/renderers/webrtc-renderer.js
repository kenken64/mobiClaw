/**
 * WebRTC DataChannel renderer.
 * Receives H.264 frames via unreliable DataChannel (UDP transport),
 * decodes with the same H264Renderer (WebCodecs).
 * Benefit: UDP = no head-of-line blocking = lower latency than WebSocket/TCP.
 */
import { H264Renderer } from './h264-renderer.js';

export class WebrtcRenderer {
  constructor(videoElement, canvas) {
    this.video = videoElement; // unused in DC mode
    this.canvas = canvas;
    this.pc = null;
    this.dataChannel = null;
    this._h264 = new H264Renderer(canvas);
    this._connected = false;
    this.onDimensionsChange = null;
    this._h264.onDimensionsChange = (info) => {
      if (typeof this.onDimensionsChange === 'function') {
        this.onDimensionsChange(info);
      }
    };
  }

  get supported() {
    return typeof RTCPeerConnection !== 'undefined' && this._h264.supported;
  }

  /**
   * Handle SDP offer from server, create answer.
   */
  async handleOffer(offer) {
    this.close();

    this.pc = new RTCPeerConnection({
      iceServers: [],
      bundlePolicy: 'max-bundle',
    });

    this.pc.ondatachannel = (event) => {
      console.log('[WebRTC DC] Got data channel:', event.channel.label);
      this.dataChannel = event.channel;
      this.dataChannel.binaryType = 'arraybuffer';

      this.dataChannel.onmessage = (e) => {
        // Same format as WebSocket binary: [prefix][flags][pts][h264 data]
        this._h264.renderFrame(e.data);
      };

      this.dataChannel.onopen = () => {
        console.log('[WebRTC DC] Channel open');
        this._connected = true;
      };

      this.dataChannel.onclose = () => {
        console.log('[WebRTC DC] Channel closed');
        this._connected = false;
      };
    };

    this.pc.onconnectionstatechange = () => {
      console.log('[WebRTC] State:', this.pc?.connectionState);
    };

    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    return this.pc.localDescription;
  }

  show() {
    this.canvas.classList.remove('hidden');
    this.canvas.classList.add('active');
    this.video.classList.add('hidden');
    this.video.classList.remove('active');
  }

  hide() {
    this.canvas.classList.remove('active');
    this.canvas.classList.add('hidden');
  }

  resetDecoder() {
    this._h264._waitingForKeyframe = true;
    this._h264._configData = null;
  }

  close() {
    this._connected = false;
    if (this.dataChannel) {
      try { this.dataChannel.close(); } catch (_) {}
      this.dataChannel = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch (_) {}
      this.pc = null;
    }
    this._h264.destroy();
    this.hide();
  }

  /** No-op - frames arrive via DataChannel, not binary WS */
  renderFrame() {}
}

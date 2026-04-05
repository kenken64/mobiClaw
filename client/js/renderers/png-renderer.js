export class PngRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.onDimensionsChange = null;
    this._frameCount = 0;
    this._lastFpsTime = performance.now();
    this.clientFps = 0;
    this._pendingFrame = null;
    this._renderScheduled = false;
    this._latestBitmap = null;
    this._paintScheduled = false;
    this._lastReportedWidth = 0;
    this._lastReportedHeight = 0;
    if (this.ctx) {
      this.ctx.imageSmoothingEnabled = false;
    }
  }

  async renderFrame(arrayBuffer) {
    this._pendingFrame = arrayBuffer;
    if (this._renderScheduled) return;
    this._renderScheduled = true;

    queueMicrotask(async () => {
      try {
        const latest = this._pendingFrame;
        this._pendingFrame = null;
        if (latest) {
          await this._drawFrame(latest);
        }
      } finally {
        this._renderScheduled = false;
        if (this._pendingFrame) {
          this.renderFrame(this._pendingFrame);
        }
      }
    });
  }

  async _drawFrame(arrayBuffer) {
    // Skip the 1-byte prefix
    const imageData = arrayBuffer.slice(1);
    const blob = new Blob([imageData], { type: 'image/png' });

    try {
      const bitmap = await createImageBitmap(blob);
      if (this._latestBitmap) {
        this._latestBitmap.close();
      }
      this._latestBitmap = bitmap;
      this._schedulePaint();

      // Track client-side FPS
      this._frameCount++;
      const now = performance.now();
      if (now - this._lastFpsTime >= 1000) {
        this.clientFps = this._frameCount;
        this._frameCount = 0;
        this._lastFpsTime = now;
      }
    } catch (e) {
      // Likely corrupt frame, skip
    }
  }

  _schedulePaint() {
    if (this._paintScheduled) return;
    this._paintScheduled = true;
    requestAnimationFrame(() => {
      this._paintScheduled = false;
      const bitmap = this._latestBitmap;
      this._latestBitmap = null;
      if (!bitmap || !this.ctx) return;
      if (this.canvas.width !== bitmap.width || this.canvas.height !== bitmap.height) {
        this.canvas.width = bitmap.width;
        this.canvas.height = bitmap.height;
        this._notifyDimensions(bitmap.width, bitmap.height);
      }
      this.ctx.drawImage(bitmap, 0, 0);
      bitmap.close();
      if (this._latestBitmap) {
        this._schedulePaint();
      }
    });
  }

  _notifyDimensions(width, height) {
    if (!width || !height) return;
    if (width === this._lastReportedWidth && height === this._lastReportedHeight) return;
    this._lastReportedWidth = width;
    this._lastReportedHeight = height;
    if (typeof this.onDimensionsChange === 'function') {
      this.onDimensionsChange({
        width,
        height,
        orientation: width > height ? 'landscape' : 'portrait',
      });
    }
  }
}

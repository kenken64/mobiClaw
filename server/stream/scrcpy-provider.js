import { createConnection } from 'net';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import config from '../config.js';

const execFileAsync = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRCPY_SERVER_PATH = join(__dirname, '..', '..', 'scrcpy', 'scrcpy-server.jar');
const DEVICE_SERVER_PATH = '/data/local/tmp/scrcpy-server.jar';
const SCRCPY_VERSION = '3.3.4';
const FORWARD_PORT = 27183;

export class ScrcpyProvider {
  constructor(serial, options = {}) {
    this.serial = serial;
    this.options = options;
    this.running = false;
    this.frameCallback = null;
    this.frameCount = 0;
    this.fps = 0;
    this._fpsTimer = null;
    this._videoSocket = null;
    this._controlSocket = null;
    this._serverProcess = null;
    this.deviceName = '';
    this.videoWidth = 0;
    this.videoHeight = 0;
  }

  onFrame(callback) { this.frameCallback = callback; }
  getControlSocket() { return this._controlSocket; }
  getInfo() { return { type: 'h264', fps: this.fps }; }

  async start() {
    if (this.running) return;
    this.running = true;
    this.frameCount = 0;

    this._fpsTimer = setInterval(() => {
      this.fps = this.frameCount;
      this.frameCount = 0;
    }, 1000);

    const scrcpyConfig = {
      maxSize: this.options.maxSize ?? config.scrcpy.maxSize,
      bitRate: this.options.bitRate ?? config.scrcpy.bitRate,
      maxFps: this.options.maxFps ?? config.scrcpy.maxFps,
      codecOptions: this.options.codecOptions ?? 'profile=1,level=4096,repeat-previous-level-prefix=1,i-frame-interval=1,intra-refresh-period=30',
    };

    // Step 1: Kill old scrcpy and set up forward (parallel for speed)
    console.log('[Scrcpy] Cleaning up...');
    await Promise.all([
      this._adb('shell', 'pkill', '-9', '-f', 'scrcpy-server').catch(() => {}),
      this._adb('forward', '--remove-all').catch(() => {}),
    ]);
    await sleep(200);

    // Step 2: Push server JAR (skip if already present) + set up forward (parallel)
    const { stdout: lsOut } = await this._adb('shell', 'ls', '-l', DEVICE_SERVER_PATH).catch(() => ({ stdout: '' }));
    const needsPush = !lsOut.includes('scrcpy-server.jar');
    await Promise.all([
      needsPush ? this._adb('push', SCRCPY_SERVER_PATH, DEVICE_SERVER_PATH) : Promise.resolve(),
      this._adb('forward', `tcp:${FORWARD_PORT}`, 'localabstract:scrcpy'),
    ]);
    if (needsPush) console.log('[Scrcpy] Server pushed');
    console.log('[Scrcpy] Forward ready');

    // Step 4: Start scrcpy-server via CLI
    const args = [
      SCRCPY_VERSION,
      'tunnel_forward=true', 'video=true', 'audio=false', 'control=true',
      `max_size=${scrcpyConfig.maxSize}`,
      `video_bit_rate=${scrcpyConfig.bitRate}`,
      `max_fps=${scrcpyConfig.maxFps}`,
      'video_codec=h264', 'send_frame_meta=true',
      'send_device_meta=true', 'send_dummy_byte=true',
      'stay_awake=true',
      'power_off_on_close=false',
      // Balanced low-latency encoder bias with frequent refresh for smoother motion.
      `video_codec_options=${scrcpyConfig.codecOptions}`,
    ].join(' ');

    console.log('[Scrcpy] Starting server...');
    this._serverProcess = execFile(
      config.adbPath,
      ['-s', this.serial, 'shell', `CLASSPATH=${DEVICE_SERVER_PATH} app_process / com.genymobile.scrcpy.Server ${args}`],
      { timeout: 0 }
    );
    this._serverProcess.stdout.on('data', (d) => {
      const t = d.toString().trim();
      if (t) console.log('[Scrcpy Server]', t);
    });
    this._serverProcess.stderr.on('data', (d) => {
      const t = d.toString().trim();
      if (t) console.log('[Scrcpy Server]', t);
    });

    await this._waitForServer();
    console.log('[Scrcpy] Server ready');

    // Step 5: Connect BOTH sockets BEFORE reading.
    // Scrcpy protocol: server sends dummy byte on video socket,
    // then BLOCKS waiting for control socket to connect,
    // then sends device name + codec info on video socket.
    console.log('[Scrcpy] Connecting video socket...');
    this._videoSocket = await this._connectTcp();
    console.log('[Scrcpy] Video connected, connecting control socket...');
    this._controlSocket = await this._connectTcp();
    console.log('[Scrcpy] Control connected');

    // Step 6: Now read the handshake (server unblocked after both sockets connected)
    // Format: [1 dummy] [64 device name] [4 codec_id] [4 width] [4 height] = 77 bytes
    console.log('[Scrcpy] Reading handshake...');
    const handshake = await this._readExact(this._videoSocket, 77);

    if (handshake[0] !== 0x00) {
      throw new Error(`Bad dummy byte: 0x${handshake[0].toString(16)}`);
    }
    const nameBytes = handshake.subarray(1, 65);
    const nullIdx = nameBytes.indexOf(0);
    this.deviceName = nameBytes.subarray(0, nullIdx === -1 ? 64 : nullIdx).toString('utf-8');
    this.videoWidth = handshake.readInt32BE(69);
    this.videoHeight = handshake.readInt32BE(73);
    console.log(`[Scrcpy] ${this.deviceName} ${this.videoWidth}x${this.videoHeight}`);

    // Step 7: Start frame reader
    this._readVideoFrames();
    console.log('[Scrcpy] Streaming!');
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    if (this._fpsTimer) { clearInterval(this._fpsTimer); this._fpsTimer = null; }
    if (this._videoSocket) { this._videoSocket.destroy(); this._videoSocket = null; }
    if (this._controlSocket) { this._controlSocket.destroy(); this._controlSocket = null; }
    if (this._serverProcess) { this._serverProcess.kill(); this._serverProcess = null; }
    this._adb('shell', 'pkill', '-9', '-f', 'scrcpy-server').catch(() => {});
    this._adb('forward', '--remove', `tcp:${FORWARD_PORT}`).catch(() => {});
    console.log('[Scrcpy] Stopped');
  }

  _adb(...args) {
    return execFileAsync(config.adbPath, ['-s', this.serial, ...args], { timeout: 15000 });
  }

  _waitForServer() {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve(), 6000);
      const onData = (data) => {
        if (data.toString().includes('INFO: Device:')) {
          this._serverProcess.stdout.removeListener('data', onData);
          this._serverProcess.stderr.removeListener('data', onData);
          clearTimeout(timeout);
          setTimeout(resolve, 800);
        }
      };
      this._serverProcess.stdout.on('data', onData);
      this._serverProcess.stderr.on('data', onData);
    });
  }

  _connectTcp() {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: '127.0.0.1', port: FORWARD_PORT }, () => resolve(socket));
      socket.on('error', (err) => { socket.destroy(); reject(err); });
      setTimeout(() => { socket.destroy(); reject(new Error('TCP timeout')); }, 5000);
    });
  }

  _readExact(socket, length) {
    return new Promise((resolve, reject) => {
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timeout reading ${length} bytes (got ${buf.length})`));
      }, 10000);

      function onData(chunk) {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length >= length) {
          cleanup();
          if (buf.length > length) socket.unshift(buf.subarray(length));
          resolve(buf.subarray(0, length));
        }
      }
      function onError(err) { cleanup(); reject(err); }
      function cleanup() {
        clearTimeout(timer);
        socket.removeListener('data', onData);
        socket.removeListener('error', onError);
      }
      socket.on('data', onData);
      socket.on('error', onError);
    });
  }

  _readVideoFrames() {
    let headerBuf = Buffer.alloc(0);
    let packetBuf = Buffer.alloc(0);
    let readingHeader = true;
    let expectedLen = 0;
    let currentPts = BigInt(0);
    let totalFrames = 0;

    this._videoSocket.on('data', (chunk) => {
      let off = 0;
      while (off < chunk.length) {
        if (readingHeader) {
          const take = Math.min(12 - headerBuf.length, chunk.length - off);
          headerBuf = Buffer.concat([headerBuf, chunk.subarray(off, off + take)]);
          off += take;
          if (headerBuf.length === 12) {
            currentPts = headerBuf.readBigInt64BE(0);
            expectedLen = headerBuf.readInt32BE(8);
            if (expectedLen <= 0 || expectedLen > 10 * 1024 * 1024) {
              // Invalid or end-of-stream: expectedLen 0 = EOS, negative/huge = corrupt
              if (expectedLen === 0) {
                console.log(`[Scrcpy] End of stream after ${totalFrames} frames`);
              } else {
                console.error(`[Scrcpy] Bad packet length: ${expectedLen} after ${totalFrames} frames, header: ${headerBuf.toString('hex')}`);
              }
              // Don't stop on bad packets, just reset and try to resync
              readingHeader = true;
              headerBuf = Buffer.alloc(0);
              if (expectedLen === 0) { this.stop(); return; }
              continue;
            }
            readingHeader = false;
            packetBuf = Buffer.alloc(0);
          }
        } else {
          const take = Math.min(expectedLen - packetBuf.length, chunk.length - off);
          packetBuf = Buffer.concat([packetBuf, chunk.subarray(off, off + take)]);
          off += take;
          if (packetBuf.length === expectedLen) {
            this._emitFrame(packetBuf, currentPts);
            totalFrames++;
            if (totalFrames <= 3) {
              console.log(`[Scrcpy] Frame ${totalFrames}: ${packetBuf.length} bytes, pts=${currentPts}, nalu=0x${(packetBuf[0] & 0x1f).toString(16)}`);
            }
            readingHeader = true;
            headerBuf = Buffer.alloc(0);
          }
        }
      }
    });

    this._videoSocket.on('error', (e) => {
      console.error(`[Scrcpy] Video error after ${totalFrames} frames:`, e.message);
    });
    this._videoSocket.on('close', () => {
      console.log(`[Scrcpy] Video socket closed after ${totalFrames} frames`);
      if (this.running) this.stop();
    });
  }

  _emitFrame(data, pts) {
    if (!this.frameCallback || !this.running) return;
    const isConfig = pts < BigInt(0);

    // Find the first NALU type in Annex B stream
    let isKeyframe = isConfig;
    if (!isConfig) {
      const naluType = findNaluType(data);
      isKeyframe = naluType === 5 || naluType === 7; // IDR or SPS
    }

    this.frameCallback(data, { isConfig, isKeyframe, pts: isConfig ? 0 : Number(pts) });
    this.frameCount++;
  }
}

/** Find first NALU type in Annex B data (searches for start codes) */
function findNaluType(data) {
  for (let i = 0; i < data.length - 4; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 0 && data[i + 3] === 1 && i + 4 < data.length) {
        return data[i + 4] & 0x1f;
      }
      if (data[i + 2] === 1 && i + 3 < data.length) {
        return data[i + 3] & 0x1f;
      }
    }
  }
  return data.length > 0 ? (data[0] & 0x1f) : -1;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

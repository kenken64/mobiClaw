import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { WebSocketServer } from 'ws';
import { listDevices, connectDevice, pairDevice, disconnectDevice } from '../adb/adb-client.js';
import { getDeviceInfo } from '../adb/device-info.js';
import { ScreencapProvider } from '../stream/screencap-provider.js';
import { ScrcpyProvider } from '../stream/scrcpy-provider.js';
import { ScreenrecordProvider } from '../stream/screenrecord-provider.js';
import { ShellInputHandler } from '../input/shell-input.js';
import { ScrcpyInputHandler } from '../input/scrcpy-input.js';
import { RtcSession } from '../webrtc/rtc-handler.js';
import { CommandHandler } from '../chat/command-handler.js';
import { Agent } from '../chat/agent.js';
import { ManagerAgent } from '../chat/manager-agent.js';
import { BenchmarkRunner } from '../chat/benchmark-runner.js';
import { RunRecorder } from '../recording/run-recorder.js';
import { getScript } from '../recording/artifact-store.js';
import { ScriptRunner } from '../playback/script-runner.js';
import { acquireMirrorWakeLock, releaseMirrorWakeLock } from '../adb/power-manager.js';
import { clearVisionFrame, startVisionFrameFeed, stopVisionFrameFeed, updateVisionFrame } from '../stream/vision-frame-cache.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRCPY_SERVER_PATH = join(__dirname, '..', '..', 'scrcpy', 'scrcpy-server.jar');

const FRAME_PREFIX_PNG = 0x01;
const FRAME_PREFIX_H264 = 0x02;

export function createWsHandler(server) {
  const wss = new WebSocketServer({ server });
  const scrcpyAvailable = existsSync(SCRCPY_SERVER_PATH);
  if (scrcpyAvailable) {
    console.log('  Scrcpy server: available (H.264 mode enabled)');
  } else {
    console.log('  Scrcpy server: not found (run `npm run download-scrcpy` for H.264 mode)');
  }

  wss.on('connection', (ws) => {
    console.log('[WS] Client connected');
    let streamProvider = null;
    let inputHandler = null;
    let fpsInterval = null;
    let currentMode = null;
    let rtcSession = null;
    let commandHandler = null;
    let activeAgent = null;
    let activeBenchmark = null;
    let activeReplay = null;
    let activeRecorder = null;
    let activeRunOutcome = null;
    let currentSerial = null;

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type !== 'touch' && msg.type !== 'key' && msg.type !== 'scroll') {
          console.log('[WS] <<', msg.type, msg.device || msg.mode || '');
        }
        await handleMessage(ws, msg);
      } catch (err) {
        console.error('[WS] Handler error:', err.message);
        sendJson(ws, { type: 'error', message: err.message });
      }
    });

    ws.on('close', () => {
      console.log('[WS] Client disconnected');
      cleanup();
    });

    ws.on('error', (err) => {
      console.error('[WS] Error:', err.message);
      cleanup();
    });

    function cleanup() {
      const serialToRelease = currentSerial;
      if (fpsInterval) {
        clearInterval(fpsInterval);
        fpsInterval = null;
      }
      if (activeAgent) {
        activeAgent.stop();
        activeAgent = null;
      }
      if (streamProvider) {
        streamProvider.stop();
        streamProvider = null;
      }
      if (activeBenchmark) {
        activeBenchmark.stop();
        activeBenchmark = null;
      }
      if (activeReplay) {
        activeReplay.stop();
        activeReplay = null;
      }
      if (activeRecorder) {
        const recorder = activeRecorder;
        const outcome = activeRunOutcome || { status: 'stopped', summary: 'Client disconnected' };
        activeRecorder = null;
        activeRunOutcome = null;
        recorder.finish(outcome.status, outcome.summary).catch((err) => {
          console.error('[Recorder] Failed to finalize on cleanup:', err.message);
        });
      }
      if (rtcSession) {
        rtcSession.close();
        rtcSession = null;
      }
      inputHandler = null;
      currentMode = null;
      currentSerial = null;
      if (serialToRelease) {
        stopVisionFrameFeed(serialToRelease);
      }
      if (serialToRelease) {
        releaseMirrorWakeLock(serialToRelease).catch((err) => {
          console.error('[Power] Failed to release wake lock:', err.message);
        });
      }
    }

    async function handleMessage(ws, msg) {
      switch (msg.type) {
        case 'list-devices': {
          const devices = await listDevices();
          sendJson(ws, {
            type: 'device-list',
            devices: devices.map(d => ({ serial: d.id, type: d.type })),
          });
          break;
        }

        case 'get-device-info': {
          const info = await getDeviceInfo(msg.device);
          sendJson(ws, { type: 'device-info', data: info });
          break;
        }

        case 'get-capabilities': {
          sendJson(ws, {
            type: 'capabilities',
            scrcpy: scrcpyAvailable,
            modes: scrcpyAvailable ? ['screenrecord', 'scrcpy', 'screencap', 'webrtc', 'ultra'] : ['screenrecord', 'screencap'],
          });
          break;
        }

        case 'start-stream': {
          cleanup();

          const serial = msg.device;
          const mode = msg.mode || 'screenrecord';
          currentMode = mode;
          currentSerial = serial;

          try {
            await acquireMirrorWakeLock(serial);
            clearVisionFrame(serial);
            if (mode !== 'screencap') {
              startVisionFrameFeed(serial, { intervalMs: mode === 'ultra' ? 350 : 650 });
            }
            const info = await getDeviceInfo(serial);

            if (mode === 'screenrecord') {
              await startScreenrecordStream(ws, serial, info);
            } else if (mode === 'ultra' && scrcpyAvailable) {
              await startWebrtcStream(ws, serial, info, {
                streamMode: 'ultra',
                scrcpyOptions: {
                  maxSize: 720,
                  bitRate: 1800000,
                  maxFps: 45,
                  codecOptions: 'profile=1,level=4096,repeat-previous-level-prefix=1,i-frame-interval=1,intra-refresh-period=15',
                },
              });
            } else if (mode === 'webrtc' && scrcpyAvailable) {
              await startWebrtcStream(ws, serial, info, {
                streamMode: 'webrtc',
                scrcpyOptions: {
                  maxSize: 1080,
                  bitRate: 3800000,
                  maxFps: 30,
                  codecOptions: 'profile=1,level=4096,repeat-previous-level-prefix=1,i-frame-interval=1,intra-refresh-period=30',
                },
              });
            } else if (mode === 'scrcpy' && scrcpyAvailable) {
              await startScrcpyStream(ws, serial, info);
            } else {
              await startScreencapStream(ws, serial, info);
            }
          } catch (err) {
            console.error(`[WS] Failed to start ${mode} stream:`, err.message);
            cleanup();
            sendJson(ws, { type: 'error', message: `Failed to start stream: ${err.message}` });

            if (mode === 'scrcpy' || mode === 'webrtc' || mode === 'ultra') {
              console.log('[WS] Falling back to screencap mode...');
              try {
                const info = await getDeviceInfo(serial);
                await startScreencapStream(ws, serial, info);
              } catch (fallbackErr) {
                sendJson(ws, { type: 'error', message: `Fallback also failed: ${fallbackErr.message}` });
              }
            }
          }

          break;
        }

        case 'stop-stream': {
          cleanup();
          sendJson(ws, { type: 'stream-stopped' });
          break;
        }

        case 'touch': {
          if (!inputHandler) return;
          switch (msg.action) {
            case 'tap':
              inputHandler.tap(msg.x, msg.y);
              break;
            case 'swipe':
              inputHandler.swipe(msg.x1, msg.y1, msg.x2, msg.y2, msg.duration || 300);
              break;
            case 'down':
              if (inputHandler.touchDown) inputHandler.touchDown(msg.x, msg.y);
              break;
            case 'move':
              if (inputHandler.touchMove) inputHandler.touchMove(msg.x, msg.y);
              break;
            case 'up':
              if (inputHandler.touchUp) inputHandler.touchUp(msg.x, msg.y);
              break;
          }
          break;
        }

        case 'key': {
          if (!inputHandler) return;
          inputHandler.key(msg.keycode);
          break;
        }

        case 'scroll': {
          if (!inputHandler || !inputHandler.scroll) return;
          inputHandler.scroll(msg.x, msg.y, msg.hScroll || 0, msg.vScroll || 0);
          break;
        }

        case 'chat': {
          const serial = msg.device;
          if (!serial) {
            sendJson(ws, { type: 'chat-response', error: true, message: 'No device selected' });
            break;
          }

          // Simple commands (start with /, or are single keywords like "help")
          const prompt = msg.prompt.trim();
          if (prompt.startsWith('/') || prompt === 'help' || prompt === '?') {
            const cmdPrompt = prompt.startsWith('/') ? prompt.slice(1).trim() : prompt;

            if (cmdPrompt.toLowerCase().startsWith('benchmark')) {
              const lower = cmdPrompt.toLowerCase();
              if (lower === 'benchmark stop') {
                if (activeBenchmark) {
                  activeBenchmark.stop();
                  activeBenchmark = null;
                  sendJson(ws, { type: 'chat-response', action: 'benchmark', message: 'Benchmark stopped.' });
                } else {
                  sendJson(ws, { type: 'chat-response', action: 'benchmark', message: 'No active benchmark.' });
                }
                break;
              }

              if (activeAgent) {
                activeAgent.stop();
                activeAgent = null;
              }
              if (activeBenchmark) {
                activeBenchmark.stop();
              }

              activeBenchmark = new BenchmarkRunner(serial, (line) => {
                sendJson(ws, { type: 'chat-response', action: 'benchmark', message: line });
              });

              activeBenchmark.run(cmdPrompt).then((result) => {
                sendJson(ws, {
                  type: 'chat-response',
                  action: 'benchmark',
                  message: formatBenchmarkResult(result),
                });
              }).catch((err) => {
                sendJson(ws, {
                  type: 'chat-response',
                  error: true,
                  action: 'benchmark',
                  message: `Benchmark failed: ${err.message}`,
                });
              }).finally(() => {
                activeBenchmark = null;
              });

              break;
            }

            if (!commandHandler || commandHandler.serial !== serial) {
              commandHandler = new CommandHandler(serial);
            }
            try {
              const result = await commandHandler.execute(cmdPrompt);
              sendJson(ws, { type: 'chat-response', ...result, prompt });
            } catch (err) {
              sendJson(ws, { type: 'chat-response', error: true, message: err.message, prompt });
            }
            break;
          }

          // AI Agent mode: natural language goals
          if (activeAgent) {
            activeAgent.stop();
            activeAgent = null;
          }
          if (activeReplay) {
            activeReplay.stop();
            activeReplay = null;
          }

          // /simple prefix uses the flat single-loop agent (old behavior)
          const useSimple = prompt.toLowerCase().startsWith('/simple ');
          const agentGoal = useSimple ? prompt.slice(8).trim() : prompt;
          const agentMode = useSimple ? 'simple' : 'manager';
          activeRunOutcome = { status: 'error', summary: 'Run interrupted' };

          activeRecorder = await RunRecorder.create({
            goal: agentGoal,
            serial,
            agentMode,
            provider: process.env.GEMINI_API_KEY ? 'gemini' : process.env.OPENAI_API_KEY ? 'openai' : process.env.ANTHROPIC_API_KEY ? 'anthropic' : process.env.OLLAMA_MODEL ? 'ollama' : 'unknown',
          });

          async function finalizeRecorder() {
            if (!activeRecorder) return;
            const recorder = activeRecorder;
            activeRecorder = null;
            const outcome = activeRunOutcome || { status: 'error', summary: 'Run interrupted' };
            activeRunOutcome = null;
            await recorder.finish(outcome.status, outcome.summary);
            sendJson(ws, { type: 'run-recorded', runId: recorder.runId, status: outcome.status, summary: outcome.summary });
          }

          if (useSimple) {
            activeAgent = new Agent(serial, (stepData) => {
              console.log('[Agent]', stepData.type, stepData.message || stepData.think || stepData.action || '');
              if (stepData.type === 'done') {
                activeRunOutcome.status = 'done';
                activeRunOutcome.summary = stepData.message || 'Goal achieved';
              } else if (stepData.type === 'maxsteps') {
                activeRunOutcome.status = 'maxsteps';
                activeRunOutcome.summary = stepData.message || 'Reached max steps';
              } else if (stepData.type === 'stopped') {
                activeRunOutcome.status = 'stopped';
                activeRunOutcome.summary = stepData.message || 'Stopped by user';
              }
              const { type: stepType, ...rest } = stepData;
              sendJson(ws, { type: 'agent-step', stepType, ...rest });
            }, { inputHandler, runRecorder: activeRecorder });
          } else {
            activeAgent = new ManagerAgent(serial, (eventData) => {
              console.log('[Manager]', eventData.type, eventData.message || eventData.subGoal || eventData.analysis || '');
              if (eventData.type === 'manager-done') {
                activeRunOutcome.status = 'done';
                activeRunOutcome.summary = eventData.message || 'Goal achieved';
              } else if (eventData.type === 'manager-maxrounds') {
                activeRunOutcome.status = 'maxrounds';
                activeRunOutcome.summary = eventData.message || 'Reached max planning rounds';
              }
              const { type: eventType, ...rest } = eventData;
              sendJson(ws, { type: 'manager-event', eventType, ...rest });
            }, { inputHandler, runRecorder: activeRecorder });
          }

          // Run agent in background (don't await - it streams via callback)
          activeAgent.run(agentGoal).catch(err => {
            console.error('[Agent] Fatal error:', err.message, err.stack);
            activeRunOutcome.status = 'error';
            activeRunOutcome.summary = err.message;
            if (useSimple) {
              sendJson(ws, { type: 'agent-step', stepType: 'error', message: err.message });
            } else {
              sendJson(ws, { type: 'manager-event', eventType: 'manager-error', message: err.message });
            }
          }).finally(() => {
            activeAgent = null;
            finalizeRecorder().catch((err) => {
              console.error('[Recorder] Failed to finalize:', err.message);
            });
          });

          break;
        }

        case 'agent-stop': {
          if (activeAgent) {
            const isManager = activeAgent instanceof ManagerAgent;
            if (activeRunOutcome) {
              activeRunOutcome.status = 'stopped';
              activeRunOutcome.summary = 'Stopped by user';
            }
            activeAgent.stop();
            activeAgent = null;
            if (isManager) {
              sendJson(ws, { type: 'manager-event', eventType: 'manager-done', message: 'Agent stopped by user' });
            } else {
              sendJson(ws, { type: 'agent-step', stepType: 'stopped', message: 'Agent stopped' });
            }
          }
          break;
        }

        case 'replay-script': {
          const serial = msg.device;
          if (!serial) {
            sendJson(ws, { type: 'replay-error', message: 'No device selected for replay' });
            break;
          }
          if (!msg.scriptId) {
            sendJson(ws, { type: 'replay-error', message: 'No script selected' });
            break;
          }

          if (activeReplay) {
            activeReplay.stop();
            activeReplay = null;
          }

          const script = await getScript(msg.scriptId);
          activeReplay = new ScriptRunner({
            serial,
            inputHandler,
            policy: msg.policy,
            onEvent: (event) => sendJson(ws, event),
          });

          activeReplay.run(script).catch((err) => {
            console.error('[Replay] Fatal error:', err.message);
            sendJson(ws, { type: 'replay-error', message: err.message });
          }).finally(() => {
            activeReplay = null;
          });
          break;
        }

        case 'replay-stop': {
          if (activeReplay) {
            activeReplay.stop();
            activeReplay = null;
            sendJson(ws, { type: 'replay-error', message: 'Replay stopped by user' });
          }
          break;
        }

        case 'rtc-answer': {
          // Browser sends SDP answer for WebRTC
          if (rtcSession && msg.answer) {
            await rtcSession.setAnswer(msg.answer);
            console.log('[WebRTC] Answer received, connection establishing...');
          }
          break;
        }

        case 'wifi-connect': {
          const result = await connectDevice(msg.host, msg.port || 5555);
          sendJson(ws, { type: 'wifi-connect-result', ...result });
          // Auto-refresh device list on success
          if (result.success) {
            const devices = await listDevices();
            sendJson(ws, {
              type: 'device-list',
              devices: devices.map(d => ({ serial: d.id, type: d.type })),
            });
          }
          break;
        }

        case 'wifi-pair': {
          const result = await pairDevice(msg.host, msg.port, msg.code);
          sendJson(ws, { type: 'wifi-pair-result', ...result });
          break;
        }

        case 'wifi-disconnect': {
          const result = await disconnectDevice(msg.serial);
          sendJson(ws, { type: 'wifi-disconnect-result', ...result });
          const devices = await listDevices();
          sendJson(ws, {
            type: 'device-list',
            devices: devices.map(d => ({ serial: d.id, type: d.type })),
          });
          break;
        }

        default:
          sendJson(ws, { type: 'error', message: `Unknown message type: ${msg.type}` });
      }
    }

    async function startScreenrecordStream(ws, serial, info) {
      streamProvider = new ScreenrecordProvider(serial);
      inputHandler = new ShellInputHandler(serial);

      streamProvider.onFrame((frameBuffer, meta) => {
        if (ws.readyState !== ws.OPEN) return;
        const bufAmt = ws.bufferedAmount;
        if (bufAmt > 128 * 1024 && !meta.isConfig && !meta.isKeyframe) return;
        if (bufAmt > 384 * 1024 && !meta.isConfig) return;
        if (bufAmt > 768 * 1024) return;

        const header = Buffer.alloc(6);
        header[0] = FRAME_PREFIX_H264;
        let flags = 0;
        if (meta.isConfig) flags |= 0x01;
        if (meta.isKeyframe) flags |= 0x02;
        header[1] = flags;
        header.writeInt32BE(0, 2);

        ws.send(Buffer.concat([header, frameBuffer]));
      });

      await streamProvider.start();

      sendJson(ws, {
        type: 'stream-started',
        mode: 'screenrecord',
        width: info.width,
        height: info.height,
      });

      startFpsUpdates(ws);
    }

    async function startScreencapStream(ws, serial, info) {
      streamProvider = new ScreencapProvider(serial);
      inputHandler = new ShellInputHandler(serial);

      streamProvider.onFrame((frameBuffer) => {
        if (ws.readyState !== ws.OPEN) return;
        if (ws.bufferedAmount > 512 * 1024) return;

        updateVisionFrame(serial, { buffer: frameBuffer, source: 'screencap-stream' });

        const prefixed = Buffer.alloc(1 + frameBuffer.length);
        prefixed[0] = FRAME_PREFIX_PNG;
        frameBuffer.copy(prefixed, 1);
        ws.send(prefixed);
      });

      await streamProvider.start();

      sendJson(ws, {
        type: 'stream-started',
        mode: 'screencap',
        width: info.width,
        height: info.height,
      });

      startFpsUpdates(ws);
    }

    async function startScrcpyStream(ws, serial, info) {
      let reconnecting = false;

      async function launchScrcpy() {
        const provider = new ScrcpyProvider(serial);
        streamProvider = provider;

        provider.onFrame((frameBuffer, meta) => {
          if (ws.readyState !== ws.OPEN) return;

          // Real-time backpressure: prefer freshness over completeness.
          const bufAmt = ws.bufferedAmount;
          if (bufAmt > 128 * 1024 && !meta.isConfig && !meta.isKeyframe) return;
          if (bufAmt > 384 * 1024 && !meta.isConfig) return;
          if (bufAmt > 768 * 1024) return;

          const header = Buffer.alloc(6);
          header[0] = FRAME_PREFIX_H264;
          let flags = 0;
          if (meta.isConfig) flags |= 0x01;
          if (meta.isKeyframe) flags |= 0x02;
          header[1] = flags;
          header.writeInt32BE(meta.pts & 0x7FFFFFFF, 2);

          const combined = Buffer.concat([header, frameBuffer]);
          ws.send(combined);
        });

        await provider.start();

        const controlSocket = provider.getControlSocket();
        const w = provider.videoWidth || info.width;
        const h = provider.videoHeight || info.height;
        inputHandler = new ScrcpyInputHandler(controlSocket, w, h);

        return { w, h };
      }

      // Auto-reconnect: watch for stream drops and restart
      function watchForDrop() {
        if (!streamProvider) return;
        const checkInterval = setInterval(async () => {
          if (!streamProvider || !currentMode || ws.readyState !== ws.OPEN) {
            clearInterval(checkInterval);

            return;
          }
          // If provider stopped running, auto-reconnect
          if (!streamProvider.running && !reconnecting) {
            reconnecting = true;
            console.log('[WS] Scrcpy stream dropped, auto-reconnecting...');
            sendJson(ws, { type: 'stream-reconnecting' });
            try {
              const { w, h } = await launchScrcpy();
              console.log('[WS] Scrcpy reconnected');
              sendJson(ws, { type: 'stream-reconnected', width: w, height: h });
              watchForDrop(); // Watch again
            } catch (err) {
              console.error('[WS] Reconnect failed:', err.message);
              sendJson(ws, { type: 'error', message: 'Stream reconnect failed: ' + err.message });
            }
            reconnecting = false;
          }
        }, 500); // Check every 500ms for faster reconnect
      }

      const { w, h } = await launchScrcpy();

      sendJson(ws, {
        type: 'stream-started',
        mode: 'scrcpy',
        width: w,
        height: h,
      });

      startFpsUpdates(ws);
      watchForDrop();
    }

    async function startWebrtcStream(ws, serial, info, { streamMode = 'webrtc', scrcpyOptions = {} } = {}) {
      let reconnecting = false;

      async function launchWebrtcScrcpy() {
        const provider = new ScrcpyProvider(serial, scrcpyOptions);
        streamProvider = provider;

        // Create WebRTC session and send offer
        rtcSession = new RtcSession();
        const offer = await rtcSession.createOffer();
        sendJson(ws, {
          type: 'rtc-offer',
          offer: { type: offer.type, sdp: offer.sdp },
        });
        console.log('[WebRTC] Offer sent, waiting for answer + connection...');

        // Wait for browser to send answer and connection to establish
        // (answer is handled by the 'rtc-answer' message handler)
        await rtcSession.waitForConnection(15000);
        console.log('[WebRTC] Connected!');

        // Now start scrcpy and route frames to WebRTC
        provider.onFrame((frameBuffer, meta) => {
          if (!rtcSession) return;
          rtcSession.sendFrame(frameBuffer, meta);
        });

        await provider.start();

        const controlSocket = provider.getControlSocket();
        const w = provider.videoWidth || info.width;
        const h = provider.videoHeight || info.height;
        inputHandler = new ScrcpyInputHandler(controlSocket, w, h);

        return { w, h };
      }

      // Auto-reconnect for WebRTC too
      function watchForDrop() {
        if (!streamProvider) return;
        const checkInterval = setInterval(async () => {
          if (!streamProvider || !currentMode || ws.readyState !== ws.OPEN) {
            clearInterval(checkInterval);
            return;
          }
          if (!streamProvider.running && !reconnecting) {
            reconnecting = true;
            console.log('[WebRTC] Stream dropped, reconnecting...');
            sendJson(ws, { type: 'stream-reconnecting' });
            try {
              // Close old RTC session
              if (rtcSession) { rtcSession.close(); rtcSession = null; }
              const { w, h } = await launchWebrtcScrcpy();
              console.log('[WebRTC] Reconnected');
              sendJson(ws, { type: 'stream-reconnected', width: w, height: h });
              watchForDrop();
            } catch (err) {
              console.error('[WebRTC] Reconnect failed:', err.message);
              sendJson(ws, { type: 'error', message: 'WebRTC reconnect failed: ' + err.message });
            }
            reconnecting = false;
          }
        }, 500);
      }

      const { w, h } = await launchWebrtcScrcpy();

      sendJson(ws, {
        type: 'stream-started',
        mode: streamMode,
        width: w,
        height: h,
      });

      startFpsUpdates(ws);
      watchForDrop();
    }

    function startFpsUpdates(ws) {
      fpsInterval = setInterval(() => {
        if (!streamProvider || ws.readyState !== ws.OPEN) {
          clearInterval(fpsInterval);
          fpsInterval = null;
          return;
        }
        sendJson(ws, { type: 'fps', value: streamProvider.getInfo().fps });
      }, 1000);
    }
  });

  return wss;
}

function formatBenchmarkResult(result) {
  if (!result) return 'Benchmark finished with no results.';

  const lines = [];
  if (result.baseline) lines.push(formatSuiteLine(result.baseline));
  if (result.enhanced) lines.push(formatSuiteLine(result.enhanced));

  if (result.delta) {
    lines.push('--- Delta (enhanced - baseline) ---');
    lines.push(`successRate: ${signed(result.delta.successRate)}`);
    lines.push(`avgSteps: ${signed(result.delta.avgSteps)}`);
    lines.push(`avgDurationMs: ${signed(result.delta.avgDurationMs)}`);
    lines.push(`stuckEvents: ${signed(result.delta.stuckEvents)}`);
    lines.push(`errorCount: ${signed(result.delta.errorCount)}`);
    lines.push(`ocrUsageRate: ${signed(result.delta.ocrUsageRate)}`);
  }

  lines.push('Run /benchmark stop to cancel an active run.');
  return lines.join('\n');
}

function formatSuiteLine(suite) {
  return `${suite.label}: pass ${suite.passed}/${suite.total}, successRate=${suite.successRate}, avgSteps=${suite.avgSteps}, avgDurationMs=${suite.avgDurationMs}, stuck=${suite.stuckEvents}, errors=${suite.errorCount}, ocrUsage=${suite.ocrUsageRate}`;
}

function signed(value) {
  const n = Number(value || 0);
  return n > 0 ? `+${n}` : String(n);
}

function sendJson(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

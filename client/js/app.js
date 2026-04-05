import { WsClient } from './ws-client.js';
import { PngRenderer } from './renderers/png-renderer.js';
import { H264Renderer } from './renderers/h264-renderer.js';
import { WebrtcRenderer } from './renderers/webrtc-renderer.js';
import { TouchHandler } from './input/touch-handler.js';

// DOM elements
const deviceSelect = document.getElementById('device-select');
const btnRefresh = document.getElementById('btn-refresh');
const btnConnect = document.getElementById('btn-connect');
const canvas = document.getElementById('screen-canvas');
const videoEl = document.getElementById('screen-video');
const placeholder = document.getElementById('canvas-placeholder');
const infoPanel = document.getElementById('device-info-panel');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const statusFps = document.getElementById('status-fps');
const statusMode = document.getElementById('status-mode');
const connectHost = document.getElementById('connect-host');
const connectPort = document.getElementById('connect-port');
const btnWifiConnect = document.getElementById('btn-wifi-connect');
const pairHost = document.getElementById('pair-host');
const pairPort = document.getElementById('pair-port');
const pairCode = document.getElementById('pair-code');
const btnPair = document.getElementById('btn-pair');
const wifiStatus = document.getElementById('wifi-status');
const btnDeviceInfo = document.getElementById('btn-device-info');
const deviceInfoDialog = document.getElementById('device-info-dialog');
const dialogOverlay = document.getElementById('dialog-overlay');
const btnCloseDialog = document.getElementById('btn-close-dialog');
const chatInput = document.getElementById('chat-input');
const btnChatSend = document.getElementById('btn-chat-send');
const chatMessages = document.getElementById('chat-messages');
const btnChatHelp = document.getElementById('btn-chat-help');
const btnChatClear = document.getElementById('btn-chat-clear');
const btnHome = document.getElementById('btn-home');
const btnLogout = document.getElementById('btn-logout');
const btnRecordStart = document.getElementById('btn-record-start');
const btnRecordStop = document.getElementById('btn-record-stop');
const btnRecordDownload = document.getElementById('btn-record-download');
const recordingStatus = document.getElementById('recording-status');
const recordingTimer = document.getElementById('recording-timer');
const recordingBadge = document.getElementById('recording-badge');
const runSelect = document.getElementById('run-select');
const btnRunsRefresh = document.getElementById('btn-runs-refresh');
const btnViewRun = document.getElementById('btn-view-run');
const scriptNameInput = document.getElementById('script-name');
const btnSaveScript = document.getElementById('btn-save-script');
const scriptSelect = document.getElementById('script-select');
const btnScriptsRefresh = document.getElementById('btn-scripts-refresh');
const btnReplayScript = document.getElementById('btn-replay-script');
const btnReplayStop = document.getElementById('btn-replay-stop');
const btnReplaysRefresh = document.getElementById('btn-replays-refresh');
const replaySelect = document.getElementById('replay-select');
const btnViewReplay = document.getElementById('btn-view-replay');
const playbackStatus = document.getElementById('playback-status');
const replayMode = document.getElementById('replay-mode');
const replayRetries = document.getElementById('replay-retries');
const replayHardFailures = document.getElementById('replay-hard-failures');
const replaySoftFailures = document.getElementById('replay-soft-failures');
const replaySemanticFallback = document.getElementById('replay-semantic-fallback');
const runDetailDialog = document.getElementById('run-detail-dialog');
const runDetailOverlay = document.getElementById('run-detail-overlay');
const btnCloseRunDetail = document.getElementById('btn-close-run-detail');
const runDetailSummary = document.getElementById('run-detail-summary');
const runStepList = document.getElementById('run-step-list');
const runStepDetail = document.getElementById('run-step-detail');
const replayDetailDialog = document.getElementById('replay-detail-dialog');
const replayDetailOverlay = document.getElementById('replay-detail-overlay');
const btnCloseReplayDetail = document.getElementById('btn-close-replay-detail');
const replayDetailSummary = document.getElementById('replay-detail-summary');
const replayStepList = document.getElementById('replay-step-list');
const replayStepDetail = document.getElementById('replay-step-detail');

// State
let streaming = false;
let selectedDevice = null;
let activeRenderer = null;
let currentStreamMode = null;
let wifiConnectedSerial = null; // Track wireless device for disconnect
let mediaRecorder = null;
let recordingStream = null;
let recordingChunks = [];
let recordingBlob = null;
let recordingUrl = null;
let recordingStartedAt = 0;
let recordingTimerInterval = null;
let recordingMimeType = 'video/webm';
let replayRunning = false;
let currentRunDetail = null;
let currentReplayDetail = null;
let wifiConnectionTarget = null;

function isWirelessSerial(serial) {
  return typeof serial === 'string' && (serial.includes(':') || serial.includes('_adb-tls-connect._tcp'));
}

function normalizeWirelessSerial(serial) {
  return typeof serial === 'string' ? serial.replace(/\s+\(\d+\)(?=\._adb-tls-connect\._tcp$)/, '') : serial;
}

function findBestWirelessDevice(devices) {
  if (!Array.isArray(devices) || devices.length === 0) return null;
  if (wifiConnectedSerial) {
    const exact = devices.find((device) => device.serial === wifiConnectedSerial);
    if (exact) return exact;
  }
  const wirelessDevices = devices.filter((device) => isWirelessSerial(device.serial));
  if (wirelessDevices.length === 0) return null;

  if (wifiConnectedSerial) {
    const normalizedCurrent = normalizeWirelessSerial(wifiConnectedSerial);
    const renamed = wirelessDevices.find((device) => normalizeWirelessSerial(device.serial) === normalizedCurrent);
    if (renamed) return renamed;
  }

  if (wifiConnectionTarget) {
    const byTarget = wirelessDevices.find((device) => device.serial === wifiConnectionTarget || device.serial.includes(wifiConnectionTarget));
    if (byTarget) return byTarget;
  }

  return wirelessDevices.length === 1 ? wirelessDevices[0] : null;
}

// Renderers
const pngRenderer = new PngRenderer(canvas);
const h264Renderer = new H264Renderer(canvas);
const webrtcRenderer = new WebrtcRenderer(videoEl, canvas);

// Initialize
const ws = new WsClient();
// Touch handler works on both canvas and video element
const touchCanvas = new TouchHandler(canvas, (msg) => ws.send(msg));
const touchVideo = new TouchHandler(videoEl, (msg) => ws.send(msg));

function getSelectedMode() {
  const checked = document.querySelector('input[name="mode"]:checked');
  return checked ? checked.value : 'screencap';
}

function setPreferredMode(mode) {
  const target = document.querySelector(`input[name="mode"][value="${mode}"]`);
  if (target && !target.disabled) {
    target.checked = true;
  }
}

// --- WebSocket Events ---

ws.on('connected', () => {
  setStatus('no-device', 'No device');
  ws.send({ type: 'list-devices' });
  ws.send({ type: 'get-capabilities' });
  // Re-apply API config from localStorage in case server restarted
  const saved = JSON.parse(localStorage.getItem('mobiclaw-config') || '{}');
  if (saved.provider === 'ollama' || saved.apiKey) {
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider: saved.provider, apiKey: saved.apiKey, model: saved.model, baseUrl: saved.baseUrl }),
    }).catch(() => {});
  }
});

ws.on('disconnected', () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording('Stream disconnected. Recording stopped.');
  }
  setStatus('disconnected', 'Disconnected');
  streaming = false;
  currentStreamMode = null;
  updateSendButton();
  updateRecordingControls();
  btnConnect.textContent = 'Start Mirror';
  hideAllScreens();
  placeholder.classList.remove('hidden');
  statusMode.textContent = '--';
  webrtcRenderer.close();
});

ws.on('capabilities', (msg) => {
  const scrcpyRadio = document.querySelector('input[name="mode"][value="scrcpy"]');
  const webrtcRadio = document.querySelector('input[name="mode"][value="webrtc"]');
  const ultraRadio = document.querySelector('input[name="mode"][value="ultra"]');
  const screenrecordRadio = document.querySelector('input[name="mode"][value="screenrecord"]');
  const screencapRadio = document.querySelector('input[name="mode"][value="screencap"]');

  // screenrecord is always available (system binary)
  if (screenrecordRadio) screenrecordRadio.disabled = false;

  // scrcpy/webrtc need the scrcpy server
  if (scrcpyRadio) scrcpyRadio.disabled = !msg.scrcpy;
  if (webrtcRadio) webrtcRadio.disabled = !msg.scrcpy || !webrtcRenderer.supported;
  if (ultraRadio) ultraRadio.disabled = !msg.scrcpy || !webrtcRenderer.supported;

  // H.264 modes need WebCodecs
  if (!h264Renderer.supported) {
    if (scrcpyRadio) scrcpyRadio.disabled = true;
    if (webrtcRadio) webrtcRadio.disabled = true;
    if (ultraRadio) ultraRadio.disabled = true;
    if (screenrecordRadio) screenrecordRadio.disabled = true;
    if (screencapRadio) screencapRadio.checked = true;
    return;
  }

  const selectedMode = getSelectedMode();
  const currentRadio = document.querySelector(`input[name="mode"][value="${selectedMode}"]`);
  if (!currentRadio || currentRadio.disabled) {
    if (webrtcRadio && !webrtcRadio.disabled) setPreferredMode('webrtc');
    else if (ultraRadio && !ultraRadio.disabled) setPreferredMode('ultra');
    else if (scrcpyRadio && !scrcpyRadio.disabled) setPreferredMode('scrcpy');
    else if (screenrecordRadio && !screenrecordRadio.disabled) setPreferredMode('screenrecord');
    else if (screencapRadio) setPreferredMode('screencap');
  }
});

ws.on('device-list', (msg) => {
  const previousSelectedDevice = selectedDevice;
  deviceSelect.innerHTML = '<option value="">Select device...</option>';
  msg.devices.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.serial;
    // Truncate long serial names for display
    opt.textContent = d.serial.length > 28 ? d.serial.substring(0, 25) + '...' : d.serial;
    opt.title = d.serial; // Full name on hover
    deviceSelect.appendChild(opt);
  });

  const reboundWirelessDevice = findBestWirelessDevice(msg.devices);
  if (reboundWirelessDevice) {
    wifiConnectedSerial = reboundWirelessDevice.serial;
  }

  if (msg.devices.length === 0) {
    if (!selectedDevice) setStatus('no-device', 'No device');
  } else if (msg.devices.length === 1) {
    deviceSelect.value = msg.devices[0].serial;
    deviceSelect.dispatchEvent(new Event('change'));
  } else if (previousSelectedDevice && msg.devices.find(d => d.serial === previousSelectedDevice)) {
    deviceSelect.value = previousSelectedDevice;
  } else if (reboundWirelessDevice) {
    deviceSelect.value = reboundWirelessDevice.serial;
    if (selectedDevice !== reboundWirelessDevice.serial) {
      deviceSelect.dispatchEvent(new Event('change'));
    }
  }

  // If wifi device is gone, reset wifi button only when no matching wireless transport remains.
  if (wifiConnectedSerial && !findBestWirelessDevice(msg.devices)) {
    wifiConnectedSerial = null;
    wifiConnectionTarget = null;
    updateWifiButton();
  } else if (wifiConnectedSerial) {
    updateWifiButton();
  }

  // If selected device was disconnected, reset UI
  if (selectedDevice && !msg.devices.find(d => d.serial === selectedDevice)) {
    if (reboundWirelessDevice) {
      selectedDevice = reboundWirelessDevice.serial;
      deviceSelect.value = reboundWirelessDevice.serial;
      return;
    }
    selectedDevice = null;
    btnConnect.disabled = true;
    btnDeviceInfo.classList.add('hidden');
    deviceInfoDialog.classList.add('hidden');
    if (streaming) {
      streaming = false;
      currentStreamMode = null;
      btnConnect.textContent = 'Start Mirror';
      btnConnect.classList.remove('bg-red-600', 'hover:bg-red-700');
      btnConnect.classList.add('bg-emerald-600', 'hover:bg-emerald-700');
      hideAllScreens();
      placeholder.classList.remove('hidden');
      statusFps.textContent = '0';
      statusMode.textContent = '--';
      activeRenderer = null;
      webrtcRenderer.close();
    }
    setStatus('no-device', 'No device');
  }
});

ws.on('device-info', (msg) => {
  const d = msg.data;
  // Store in hidden holder
  document.getElementById('info-model').textContent = d.model;
  document.getElementById('info-brand').textContent = d.brand;
  document.getElementById('info-android').textContent = `${d.androidVersion} (SDK ${d.sdkVersion})`;
  document.getElementById('info-resolution').textContent = `${d.width}x${d.height} @${d.dpi}dpi`;
  document.getElementById('info-battery').textContent =
    `${d.batteryLevel}%${d.charging ? ' (charging)' : ''}`;
  // Also populate dialog
  document.getElementById('dialog-model').textContent = d.model;
  document.getElementById('dialog-brand').textContent = d.brand;
  document.getElementById('dialog-android').textContent = `${d.androidVersion} (SDK ${d.sdkVersion})`;
  document.getElementById('dialog-resolution').textContent = `${d.width}x${d.height} @${d.dpi}dpi`;
  document.getElementById('dialog-battery').textContent =
    `${d.batteryLevel}%${d.charging ? ' (charging)' : ''}`;
  // Show info button
  btnDeviceInfo.classList.remove('hidden');
});

ws.on('stream-started', (msg) => {
  streaming = true;
  currentStreamMode = msg.mode;
  updateSendButton();
  updateRecordingControls();
  btnConnect.textContent = 'Stop Mirror';
  btnConnect.classList.remove('bg-emerald-600', 'hover:bg-emerald-700');
  btnConnect.classList.add('bg-red-600', 'hover:bg-red-700');
  placeholder.classList.add('hidden');
  setStatus('streaming', 'Streaming');

  if (msg.mode === 'webrtc') {
    statusMode.textContent = 'Agent';
    activeRenderer = webrtcRenderer;
    touch.mode = 'continuous';
  } else if (msg.mode === 'ultra') {
    statusMode.textContent = 'Ultra';
    activeRenderer = webrtcRenderer;
    touch.mode = 'continuous';
  } else if (msg.mode === 'screenrecord') {
    statusMode.textContent = 'Stable';
    canvas.classList.add('active');
    activeRenderer = h264Renderer;
    touch.mode = 'simple'; // No scrcpy control socket, use adb shell input
  } else if (msg.mode === 'scrcpy') {
    statusMode.textContent = 'Fast';
    canvas.classList.add('active');
    activeRenderer = h264Renderer;
    touch.mode = 'continuous';
  } else {
    statusMode.textContent = 'PNG';
    canvas.classList.add('active');
    activeRenderer = pngRenderer;
    touch.mode = 'simple';
  }
});

// WebRTC signaling: receive offer from server
ws.on('rtc-offer', async (msg) => {
  console.log('[WebRTC] Got offer from server');
  try {
    const answer = await webrtcRenderer.handleOffer(msg.offer);
    ws.send({ type: 'rtc-answer', answer: { type: answer.type, sdp: answer.sdp } });
    console.log('[WebRTC] Sent answer');
    webrtcRenderer.show();
  } catch (e) {
    console.error('[WebRTC] Failed to handle offer:', e);
  }
});

ws.on('stream-stopped', () => {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording('Mirror stopped. Recording finalized.');
  }
  streaming = false;
  currentStreamMode = null;
  updateSendButton();
  updateRecordingControls();
  btnConnect.textContent = 'Start Mirror';
  btnConnect.classList.remove('bg-red-600', 'hover:bg-red-700');
  btnConnect.classList.add('bg-emerald-600', 'hover:bg-emerald-700');
  hideAllScreens();
  placeholder.classList.remove('hidden');
  setStatus('connected', 'Connected');
  statusFps.textContent = '0';
  statusMode.textContent = '--';
  activeRenderer = null;
  webrtcRenderer.close();
});

ws.on('fps', (msg) => {
  statusFps.textContent = msg.value;
});

ws.on('error', (msg) => {
  console.error('[Server]', msg.message);
  if (msg.message) setPlaybackStatus(msg.message, true);
});

ws.on('run-recorded', () => {
  refreshRunList();
});

ws.on('replay-start', (msg) => {
  replayRunning = true;
  updatePlaybackControls();
  setPlaybackStatus(`Replay started: ${msg.scriptName} on ${msg.serial} (${msg.policy.mode})`);
  addAgentStep('start', `Replay started: "${msg.scriptName}" (${msg.stepCount} steps)`);
});

ws.on('replay-step', (msg) => {
  addAgentStep('perceive', `Replay step ${msg.step}: ${msg.name}`);
});

ws.on('replay-step-result', (msg) => {
  const type = msg.evaluation?.verdict === 'pass' ? 'done' : msg.willRetry ? 'warn' : 'error';
  const suffix = msg.willRetry ? ` (retrying, attempt ${msg.attempt})` : '';
  const relocation = msg.relocation?.relocated
    ? ` [relocated to ${msg.relocation.match?.text || msg.relocation.match?.id || msg.relocation.match?.type || 'matched target'}]`
    : '';
  addAgentStep(type, `Replay step ${msg.step}: ${msg.evaluation?.summary || 'No summary'}${relocation}${suffix}`);
});

ws.on('replay-done', (msg) => {
  replayRunning = false;
  updatePlaybackControls();
  const counts = msg.failureCounts ? ` (hard=${msg.failureCounts.hard}, soft=${msg.failureCounts.soft})` : '';
  setPlaybackStatus(`${msg.summary}${counts}`, msg.status === 'failed');
  addAgentStep(msg.status === 'completed' ? 'done' : 'warn', `Replay ${msg.status}: ${msg.summary}${counts}`);
  refreshReplayList();
});

ws.on('replay-error', (msg) => {
  replayRunning = false;
  updatePlaybackControls();
  setPlaybackStatus(msg.message, true);
  addAgentStep('error', `Replay error: ${msg.message}`);
});

ws.on('stream-reconnecting', () => {
  setStatus('streaming', 'Reconnecting...');
  statusFps.textContent = '...';
});

ws.on('stream-reconnected', (msg) => {
  setStatus('streaming', 'Streaming');
  if (currentStreamMode === 'scrcpy') {
    h264Renderer._waitingForKeyframe = true;
    h264Renderer._configData = null;
  }
  // For WebRTC, new offer arrives via rtc-offer → resets decoder automatically
});

ws.on('wifi-connect-result', (msg) => {
  showWifiStatus(msg.success, msg.message);
  if (msg.success) {
    wifiConnectedSerial = msg.serial || wifiConnectedSerial;
    wifiConnectionTarget = msg.target || (msg.host && msg.port ? `${msg.host}:${msg.port}` : msg.host || wifiConnectionTarget);
    updateWifiButton();
  }
});

ws.on('wifi-pair-result', (msg) => {
  showWifiStatus(msg.success, msg.message);
  // Auto-fill connect IP from pair IP on success
  if (msg.success && pairHost.value.trim()) {
    connectHost.value = pairHost.value.trim();
  }
});

ws.on('wifi-disconnect-result', (msg) => {
  showWifiStatus(msg.success, msg.message);
  wifiConnectedSerial = null;
  wifiConnectionTarget = null;
  updateWifiButton();
});

// Binary frame handler (for H.264/PNG modes, not WebRTC)
ws.onBinary((data) => {
  if (!activeRenderer || currentStreamMode === 'webrtc') return;
  activeRenderer.renderFrame(data);
});

// --- UI Events ---

deviceSelect.addEventListener('change', () => {
  selectedDevice = deviceSelect.value;
  btnConnect.disabled = !selectedDevice;
  updateRecordingControls();
  updatePlaybackControls();

  if (selectedDevice) {
    setStatus('connected', 'Connected');
    ws.send({ type: 'get-device-info', device: selectedDevice });
  } else {
    setStatus('no-device', 'No device');
    infoPanel.classList.add('hidden');
  }
});

// Device info dialog
btnDeviceInfo.addEventListener('click', () => {
  deviceInfoDialog.classList.remove('hidden');
  lucide.createIcons();
});
btnCloseDialog.addEventListener('click', () => deviceInfoDialog.classList.add('hidden'));
dialogOverlay.addEventListener('click', () => deviceInfoDialog.classList.add('hidden'));

btnRefresh.addEventListener('click', () => {
  ws.send({ type: 'list-devices' });
});

btnConnect.addEventListener('click', () => {
  if (!selectedDevice) return;

  if (streaming) {
    ws.send({ type: 'stop-stream' });
  } else {
    const mode = getSelectedMode();
    ws.send({ type: 'start-stream', device: selectedDevice, mode });
  }
});

document.querySelectorAll('.btn-key').forEach(btn => {
  btn.addEventListener('click', () => {
    const keycode = parseInt(btn.dataset.keycode, 10);
    ws.send({ type: 'key', keycode });
  });
});

btnWifiConnect.addEventListener('click', () => {
  // If connected, disconnect
  if (wifiConnectedSerial) {
    showWifiStatus(null, 'Disconnecting...');
    ws.send({ type: 'wifi-disconnect', serial: wifiConnectionTarget || wifiConnectedSerial });
    wifiConnectedSerial = null;
    wifiConnectionTarget = null;
    updateWifiButton();
    return;
  }

  const host = connectHost.value.trim();
  const port = parseInt(connectPort.value, 10);
  if (!host) { showWifiStatus(false, 'Enter an IP address'); return; }
  if (!port) { showWifiStatus(false, 'Enter a port number'); return; }
  wifiConnectionTarget = `${host}:${port}`;
  showWifiStatus(null, 'Connecting...');
  ws.send({ type: 'wifi-connect', host, port });
});

connectHost.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnWifiConnect.click();
});

btnPair.addEventListener('click', () => {
  const host = pairHost.value.trim();
  const port = parseInt(pairPort.value, 10);
  const code = pairCode.value.trim();
  if (!host || !port || !code) { showWifiStatus(false, 'Fill in all pairing fields'); return; }
  showWifiStatus(null, 'Pairing...');
  ws.send({ type: 'wifi-pair', host, port, code });
});

// --- Helpers ---

function hideAllScreens() {
  canvas.classList.remove('active');
  canvas.classList.add('hidden');
  videoEl.classList.remove('active');
  videoEl.classList.add('hidden');
}

function setStatus(state, text) {
  const color =
    state === 'streaming'     ? 'bg-emerald-500' :
    state === 'connected'     ? 'bg-emerald-500' :
    state === 'no-device'     ? 'bg-amber-400'   :
    state === 'disconnected'  ? 'bg-red-500'     :
    'bg-zinc-600';
  statusDot.className = `w-2 h-2 rounded-full ${color}`;
  statusText.textContent = text;
}

function updateWifiButton() {
  if (wifiConnectedSerial) {
    btnWifiConnect.textContent = 'Disconnect';
    btnWifiConnect.classList.remove('bg-secondary', 'hover:bg-accent');
    btnWifiConnect.classList.add('bg-red-600/80', 'hover:bg-red-700');
  } else {
    btnWifiConnect.textContent = 'Connect';
    btnWifiConnect.classList.remove('bg-red-600/80', 'hover:bg-red-700');
    btnWifiConnect.classList.add('bg-secondary', 'hover:bg-accent');
  }
}

function getPreferredRecordingMimeType() {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  for (const candidate of candidates) {
    if (window.MediaRecorder && MediaRecorder.isTypeSupported(candidate)) return candidate;
  }
  return '';
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function setRecordingStatus(text, isError = false) {
  recordingStatus.textContent = text;
  recordingStatus.className = `text-[11px] min-h-[16px] ${isError ? 'text-red-400' : 'text-muted-foreground'}`;
}

function updateRecordingTimer() {
  if (!recordingStartedAt) {
    recordingTimer.textContent = '00:00';
    return;
  }
  const elapsed = (Date.now() - recordingStartedAt) / 1000;
  recordingTimer.textContent = formatDuration(elapsed);
}

function resetRecordingTimer() {
  recordingStartedAt = 0;
  if (recordingTimerInterval) {
    clearInterval(recordingTimerInterval);
    recordingTimerInterval = null;
  }
  recordingTimer.textContent = '00:00';
}

function updateRecordingControls() {
  const activeRecording = Boolean(mediaRecorder && mediaRecorder.state === 'recording');
  const canRecord = streaming && selectedDevice && Boolean(canvas.captureStream);

  btnRecordStart.disabled = !canRecord || activeRecording;
  btnRecordStop.disabled = !activeRecording;
  btnRecordDownload.disabled = !recordingBlob;

  if (activeRecording) {
    recordingBadge.textContent = 'REC';
    recordingBadge.className = 'ml-auto text-[10px] px-2 py-0.5 rounded-full border border-red-500/40 text-red-400 bg-red-500/10';
  } else if (recordingBlob) {
    recordingBadge.textContent = 'Ready';
    recordingBadge.className = 'ml-auto text-[10px] px-2 py-0.5 rounded-full border border-emerald-500/40 text-emerald-400 bg-emerald-500/10';
  } else {
    recordingBadge.textContent = 'Idle';
    recordingBadge.className = 'ml-auto text-[10px] px-2 py-0.5 rounded-full border border-input text-muted-foreground';
  }

  if (!streaming && !activeRecording && !recordingBlob) {
    setRecordingStatus('Start mirroring to enable recording.');
  }
}

function setPlaybackStatus(text, isError = false) {
  playbackStatus.textContent = text;
  playbackStatus.className = `text-[11px] min-h-[16px] ${isError ? 'text-red-400' : 'text-muted-foreground'}`;
}

function updatePlaybackControls() {
  btnViewRun.disabled = !runSelect.value;
  btnSaveScript.disabled = !runSelect.value;
  btnReplayScript.disabled = !scriptSelect.value || !selectedDevice || replayRunning;
  btnReplayStop.disabled = !replayRunning;
  btnViewReplay.disabled = !replaySelect.value;
}

function artifactUrl(path) {
  return path ? `/artifacts/${path.replace(/\\/g, '/')}` : '';
}

function deriveTargetHint(step) {
  if (step.targetHint) return step.targetHint;
  const elements = step.before?.elements || [];
  const coordinates = step.decision?.coordinates;
  if (!Array.isArray(coordinates) || elements.length === 0) return null;

  let best = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const element of elements) {
    const tap = element.tap || element.center;
    if (!Array.isArray(tap)) continue;
    const dx = tap[0] - coordinates[0];
    const dy = tap[1] - coordinates[1];
    const currentDistance = Math.sqrt(dx * dx + dy * dy);
    if (currentDistance < bestDistance) {
      bestDistance = currentDistance;
      best = element;
    }
  }

  if (!best) return null;
  return {
    text: best.text || best.desc || null,
    id: best.id || null,
    type: best.type || null,
    tap: best.tap || best.center || null,
  };
}

function renderRunStepDetail(run, step) {
  const targetHint = deriveTargetHint(step);
  const beforeImage = artifactUrl(`runs/${run.runId}/${step.before?.image || ''}`);
  const afterImage = artifactUrl(`runs/${run.runId}/${step.after?.image || ''}`);
  const detailLines = [
    ['Action', step.decision?.action || '--'],
    ['Sub-goal', step.subGoal || '--'],
    ['Foreground', `${step.before?.foregroundApp || 'unknown'} -> ${step.after?.foregroundApp || 'unknown'}`],
    ['Verdict', `${step.evaluation?.verdict || '--'}${step.evaluation?.failureCategory ? ` (${step.evaluation.failureCategory})` : ''}`],
    ['Reason', step.decision?.reason || '--'],
    ['Target hint', targetHint ? (targetHint.text || targetHint.id || targetHint.type || 'matched nearby element') : '--'],
    ['Coordinates', Array.isArray(step.decision?.coordinates) ? step.decision.coordinates.join(', ') : '--'],
  ];

  runStepDetail.innerHTML = `
    <div class="space-y-3">
      <div>
        <div class="text-sm font-semibold">Step ${step.step}</div>
        <div class="text-xs text-muted-foreground">${escapeHtml(step.name || step.subGoal || step.decision?.action || 'Recorded step')}</div>
      </div>
      <div class="grid grid-cols-2 gap-2 text-xs run-meta-grid">
        ${detailLines.map(([label, value]) => `<div class="rounded-md border border-input bg-background px-3 py-2"><div class="text-[10px] uppercase text-muted-foreground">${escapeHtml(label)}</div><div class="mt-1 text-foreground">${escapeHtml(String(value))}</div></div>`).join('')}
      </div>
      <div class="rounded-md border border-input bg-background px-3 py-2 text-xs text-muted-foreground">
        <div class="text-[10px] uppercase mb-1">Evaluation</div>
        <div>${escapeHtml(step.evaluation?.summary || 'No summary')}</div>
      </div>
      <div class="grid grid-cols-2 gap-3 run-image-grid">
        <div class="space-y-2">
          <div class="text-[10px] uppercase text-muted-foreground">Before</div>
          ${beforeImage ? `<img src="${beforeImage}" alt="Before step ${step.step}" class="w-full rounded-lg border border-input bg-black/20 object-contain max-h-[360px]">` : '<div class="rounded-lg border border-input bg-background p-4 text-xs text-muted-foreground">No before image</div>'}
        </div>
        <div class="space-y-2">
          <div class="text-[10px] uppercase text-muted-foreground">After</div>
          ${afterImage ? `<img src="${afterImage}" alt="After step ${step.step}" class="w-full rounded-lg border border-input bg-black/20 object-contain max-h-[360px]">` : '<div class="rounded-lg border border-input bg-background p-4 text-xs text-muted-foreground">No after image</div>'}
        </div>
      </div>
      <div class="rounded-md border border-input bg-background px-3 py-2 text-xs text-muted-foreground">
        <div class="text-[10px] uppercase mb-1">Decision</div>
        <pre class="whitespace-pre-wrap text-[11px]">${escapeHtml(JSON.stringify(step.decision || {}, null, 2))}</pre>
      </div>
    </div>
  `;
}

function renderRunDetail(run) {
  currentRunDetail = run;
  runDetailSummary.textContent = `${run.goal} • ${run.status} • ${run.stepCount || (run.steps || []).length} steps`;
  const steps = run.steps || [];
  runStepList.innerHTML = '';

  if (steps.length === 0) {
    runStepList.innerHTML = '<div class="text-sm text-muted-foreground">No steps recorded.</div>';
    runStepDetail.innerHTML = '<div class="text-sm text-muted-foreground">No step selected.</div>';
    return;
  }

  steps.forEach((step, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'w-full text-left rounded-lg border border-input bg-background px-3 py-2 hover:bg-accent transition-colors';
    button.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="text-xs font-semibold">Step ${step.step}</span>
        <span class="ml-auto text-[10px] ${step.evaluation?.verdict === 'pass' ? 'text-emerald-400' : step.evaluation?.verdict === 'fail' ? 'text-red-400' : 'text-yellow-400'}">${escapeHtml(step.evaluation?.verdict || 'unknown')}</span>
      </div>
      <div class="mt-1 text-xs text-foreground">${escapeHtml(step.subGoal || step.decision?.action || 'Recorded step')}</div>
      <div class="mt-1 text-[10px] text-muted-foreground line-clamp-2">${escapeHtml((deriveTargetHint(step)?.text || deriveTargetHint(step)?.id || step.evaluation?.summary || 'No target hint'))}</div>
    `;
    button.addEventListener('click', () => {
      runStepList.querySelectorAll('button').forEach((item) => item.classList.remove('ring-1', 'ring-blue-400/60'));
      button.classList.add('ring-1', 'ring-blue-400/60');
      renderRunStepDetail(run, step);
    });
    runStepList.appendChild(button);
    if (index === 0) {
      queueMicrotask(() => button.click());
    }
  });
}

function formatReplayLabel(replay) {
  const stamp = replay.savedAt || replay.startedAt;
  return `${stamp ? new Date(stamp).toLocaleString() : 'unknown time'} • ${replay.scriptName} [${replay.status}]`;
}

async function refreshReplayList() {
  try {
    const replays = await fetch('/api/test/replays').then((res) => res.json());
    replaySelect.innerHTML = '';
    if (!Array.isArray(replays) || replays.length === 0) {
      replaySelect.innerHTML = '<option value="">No replay results yet</option>';
    } else {
      replaySelect.appendChild(new Option('Select replay result...', ''));
      replays.forEach((replay) => replaySelect.appendChild(new Option(formatReplayLabel(replay), replay.replayId)));
    }
    updatePlaybackControls();
  } catch (err) {
    setPlaybackStatus(`Failed to load replays: ${err.message}`, true);
  }
}

function findSourceStep(sourceRun, replayStep) {
  if (!sourceRun?.steps || !replayStep?.scriptStep?.sourceStep) return null;
  return sourceRun.steps.find((step) => step.step === replayStep.scriptStep.sourceStep) || null;
}

function compareState(expectedState, liveState) {
  const expectedHash = expectedState?.screenshotHash || null;
  const liveHash = liveState?.screenshotHash || null;
  const expectedApp = expectedState?.foregroundApp || null;
  const liveApp = liveState?.foregroundApp || null;
  const hashMatch = expectedHash && liveHash ? expectedHash === liveHash : null;
  const appMatch = expectedApp && liveApp ? expectedApp === liveApp : null;
  const mismatch = hashMatch === false || appMatch === false;
  const match = hashMatch === true && (appMatch !== false);
  return {
    expectedHash,
    liveHash,
    expectedApp,
    liveApp,
    hashMatch,
    appMatch,
    mismatch,
    match,
  };
}

function comparisonBadge(comparison) {
  if (comparison.match) {
    return '<span class="replay-badge replay-badge-match">Match</span>';
  }
  if (comparison.mismatch) {
    return '<span class="replay-badge replay-badge-mismatch">Mismatch</span>';
  }
  return '<span class="replay-badge replay-badge-unknown">Partial</span>';
}

function comparisonToneClass(comparison) {
  if (comparison.match) return 'is-match';
  if (comparison.mismatch) return 'is-mismatch';
  return 'is-partial';
}

function renderImageSlot(label, imageUrl, altText) {
  return `
    <div class="space-y-2 replay-image-panel">
      <div class="text-[10px] uppercase text-muted-foreground">${escapeHtml(label)}</div>
      ${imageUrl
        ? `<img src="${imageUrl}" alt="${escapeHtml(altText)}" class="w-full rounded-lg border border-input bg-black/20 object-contain max-h-[320px] replay-compare-image">`
        : '<div class="rounded-lg border border-input bg-background p-4 text-xs text-muted-foreground">No image available</div>'}
    </div>
  `;
}

function renderComparisonDetails(comparison) {
  const details = [];
  if (comparison.hashMatch === true) details.push('Screenshot hash matched');
  else if (comparison.hashMatch === false) details.push('Screenshot hash changed');
  else details.push('Screenshot hash unavailable');

  if (comparison.appMatch === true) details.push(`App matched: ${comparison.liveApp}`);
  else if (comparison.appMatch === false) details.push(`App drift: expected ${comparison.expectedApp || 'unknown'}, live ${comparison.liveApp || 'unknown'}`);
  else if (comparison.expectedApp || comparison.liveApp) details.push(`App context: ${comparison.expectedApp || comparison.liveApp}`);

  return details.map((item) => `<span class="replay-detail-chip">${escapeHtml(item)}</span>`).join('');
}

function renderDiffOverlay(label, expectedImage, liveImage) {
  if (!expectedImage || !liveImage) {
    return '<div class="rounded-lg border border-dashed border-input bg-background/60 p-4 text-xs text-muted-foreground">Overlay preview unavailable without both images.</div>';
  }

  return `
    <div class="space-y-2">
      <div class="text-[10px] uppercase text-muted-foreground">${escapeHtml(label)} Overlay Diff</div>
      <div class="replay-diff-stack rounded-lg border border-input overflow-hidden bg-black/30">
        <img src="${expectedImage}" alt="Expected ${escapeHtml(label)}" class="replay-diff-base">
        <img src="${liveImage}" alt="Live ${escapeHtml(label)}" class="replay-diff-overlay">
      </div>
      <div class="text-[11px] text-muted-foreground">Difference blend highlights regions where live replay diverged from the recorded reference.</div>
    </div>
  `;
}

function renderComparisonCard(label, expectedImage, liveImage, comparison) {
  return `
    <div class="replay-compare-card ${comparisonToneClass(comparison)}">
      <div class="flex items-center gap-2 replay-compare-header">
        <div class="text-[11px] font-semibold uppercase tracking-[0.12em] text-foreground">${escapeHtml(label)}</div>
        ${comparisonBadge(comparison)}
      </div>
      <div class="flex flex-wrap gap-2 mt-2">${renderComparisonDetails(comparison)}</div>
      <div class="grid grid-cols-2 gap-3 run-image-grid mt-3 replay-compare-grid">
        ${renderImageSlot(`Expected ${label}`, expectedImage, `Expected ${label}`)}
        ${renderImageSlot(`Live ${label}`, liveImage, `Live ${label}`)}
      </div>
      <div class="mt-3">
        ${renderDiffOverlay(label, expectedImage, liveImage)}
      </div>
    </div>
  `;
}

function renderReplayStepDetail(replay, replayStep, sourceRun) {
  const sourceStep = findSourceStep(sourceRun, replayStep);
  const expectedBeforeImage = sourceStep?.before?.image ? artifactUrl(`runs/${sourceRun.runId}/${sourceStep.before.image}`) : '';
  const expectedAfterImage = sourceStep?.after?.image ? artifactUrl(`runs/${sourceRun.runId}/${sourceStep.after.image}`) : '';
  const liveBeforeImage = replayStep.before?.image ? artifactUrl(`replays/${replay.replayId}/${replayStep.before.image}`) : '';
  const liveAfterImage = replayStep.after?.image ? artifactUrl(`replays/${replay.replayId}/${replayStep.after.image}`) : '';
  const beforeComparison = compareState(sourceStep?.before, replayStep.before);
  const afterComparison = compareState(sourceStep?.after, replayStep.after);
  const relocation = replayStep.relocation?.relocated
    ? (replayStep.relocation.match?.text || replayStep.relocation.match?.id || replayStep.relocation.match?.type || 'matched target')
    : '--';

  replayStepDetail.innerHTML = `
    <div class="space-y-3">
      <div>
        <div class="text-sm font-semibold">Replay Step ${replayStep.step}</div>
        <div class="text-xs text-muted-foreground">${escapeHtml(replayStep.name || replayStep.scriptStep?.name || 'Replay step')}</div>
      </div>
      <div class="grid grid-cols-2 gap-2 text-xs run-meta-grid">
        <div class="rounded-md border border-input bg-background px-3 py-2"><div class="text-[10px] uppercase text-muted-foreground">Verdict</div><div class="mt-1 text-foreground">${escapeHtml(replayStep.evaluation?.verdict || '--')}</div></div>
        <div class="rounded-md border border-input bg-background px-3 py-2"><div class="text-[10px] uppercase text-muted-foreground">Failure Type</div><div class="mt-1 text-foreground">${escapeHtml(replayStep.evaluation?.failureType || '--')}</div></div>
        <div class="rounded-md border border-input bg-background px-3 py-2"><div class="text-[10px] uppercase text-muted-foreground">Action</div><div class="mt-1 text-foreground">${escapeHtml(replayStep.scriptStep?.action?.action || '--')}</div></div>
        <div class="rounded-md border border-input bg-background px-3 py-2"><div class="text-[10px] uppercase text-muted-foreground">Relocation</div><div class="mt-1 text-foreground">${escapeHtml(relocation)}</div></div>
        <div class="rounded-md border border-input bg-background px-3 py-2"><div class="text-[10px] uppercase text-muted-foreground">Before Check</div><div class="mt-1 text-foreground">${beforeComparison.match ? 'match' : beforeComparison.mismatch ? 'mismatch' : 'partial'}</div></div>
        <div class="rounded-md border border-input bg-background px-3 py-2"><div class="text-[10px] uppercase text-muted-foreground">After Check</div><div class="mt-1 text-foreground">${afterComparison.match ? 'match' : afterComparison.mismatch ? 'mismatch' : 'partial'}</div></div>
      </div>
      <div class="rounded-md border border-input bg-background px-3 py-2 text-xs text-muted-foreground">
        <div class="text-[10px] uppercase mb-1">Evaluation</div>
        <div>${escapeHtml(replayStep.evaluation?.summary || 'No summary')}</div>
      </div>
      <div class="space-y-4">
        ${renderComparisonCard('Before', expectedBeforeImage, liveBeforeImage, beforeComparison)}
        ${renderComparisonCard('After', expectedAfterImage, liveAfterImage, afterComparison)}
      </div>
      <div class="rounded-md border border-input bg-background px-3 py-2 text-xs text-muted-foreground">
        <div class="text-[10px] uppercase mb-1">Checks</div>
        <pre class="whitespace-pre-wrap text-[11px]">${escapeHtml(JSON.stringify(replayStep.evaluation?.checks || [], null, 2))}</pre>
      </div>
    </div>
  `;
}

function renderReplayDetail(replay, sourceRun) {
  currentReplayDetail = replay;
  replayDetailSummary.textContent = `${replay.scriptName} • ${replay.status} • ${replay.steps?.length || 0} steps`;
  replayStepList.innerHTML = '';

  const steps = replay.steps || [];
  if (steps.length === 0) {
    replayStepList.innerHTML = '<div class="text-sm text-muted-foreground">No replay steps recorded.</div>';
    replayStepDetail.innerHTML = '<div class="text-sm text-muted-foreground">No step selected.</div>';
    return;
  }

  steps.forEach((step, index) => {
    const sourceStep = findSourceStep(sourceRun, step);
    const beforeComparison = compareState(sourceStep?.before, step.before);
    const afterComparison = compareState(sourceStep?.after, step.after);
    const hasMismatch = beforeComparison.mismatch || afterComparison.mismatch;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `w-full text-left rounded-lg border bg-background px-3 py-2 hover:bg-accent transition-colors ${hasMismatch ? 'border-red-500/40' : 'border-input'}`;
    button.innerHTML = `
      <div class="flex items-center gap-2">
        <span class="text-xs font-semibold">Step ${step.step}</span>
        <span class="ml-auto text-[10px] ${step.evaluation?.verdict === 'pass' ? 'text-emerald-400' : 'text-red-400'}">${escapeHtml(step.evaluation?.verdict || 'unknown')}</span>
      </div>
      <div class="mt-1 text-xs text-foreground">${escapeHtml(step.name || step.scriptStep?.name || 'Replay step')}</div>
      <div class="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
        ${hasMismatch ? '<span class="replay-badge replay-badge-mismatch">Screen drift</span>' : '<span class="replay-badge replay-badge-match">Aligned</span>'}
        <span class="line-clamp-2">${escapeHtml(step.evaluation?.summary || 'No summary')}</span>
      </div>
    `;
    button.addEventListener('click', () => {
      replayStepList.querySelectorAll('button').forEach((item) => item.classList.remove('ring-1', 'ring-emerald-400/60'));
      button.classList.add('ring-1', 'ring-emerald-400/60');
      renderReplayStepDetail(replay, step, sourceRun);
    });
    replayStepList.appendChild(button);
    if (index === 0) queueMicrotask(() => button.click());
  });
}

async function openReplayDetail() {
  if (!replaySelect.value) return;
  try {
    const replay = await fetch(`/api/test/replays/${encodeURIComponent(replaySelect.value)}`).then((res) => res.json());
    if (replay.error) throw new Error(replay.error);
    let sourceRun = null;
    if (replay.sourceRunId) {
      const run = await fetch(`/api/test/runs/${encodeURIComponent(replay.sourceRunId)}?includeSteps=1`).then((res) => res.json());
      if (!run.error) sourceRun = run;
    }
    renderReplayDetail(replay, sourceRun);
    replayDetailDialog.classList.remove('hidden');
    lucide.createIcons();
  } catch (err) {
    setPlaybackStatus(`Failed to load replay detail: ${err.message}`, true);
  }
}

function closeReplayDetail() {
  replayDetailDialog.classList.add('hidden');
}

async function openRunDetail() {
  if (!runSelect.value) return;
  try {
    const run = await fetch(`/api/test/runs/${encodeURIComponent(runSelect.value)}?includeSteps=1`).then((res) => res.json());
    if (run.error) throw new Error(run.error);
    renderRunDetail(run);
    runDetailDialog.classList.remove('hidden');
    lucide.createIcons();
  } catch (err) {
    setPlaybackStatus(`Failed to load run detail: ${err.message}`, true);
  }
}

function closeRunDetail() {
  runDetailDialog.classList.add('hidden');
}

function getReplayPolicy() {
  return {
    mode: replayMode.value || 'strict',
    maxRetriesPerStep: Number.parseInt(replayRetries.value, 10) || 0,
    maxHardFailures: Number.parseInt(replayHardFailures.value, 10) || 1,
    maxSoftFailures: Number.parseInt(replaySoftFailures.value, 10) || 0,
    semanticFallback: replaySemanticFallback.checked,
  };
}

function formatRunLabel(run) {
  const stamp = run.startedAt ? new Date(run.startedAt).toLocaleString() : 'unknown time';
  return `${stamp} • ${run.goal} [${run.status}]`;
}

function formatScriptLabel(script) {
  return `${script.name} (${script.stepCount || (script.steps || []).length} steps)`;
}

async function refreshRunList() {
  try {
    const runs = await fetch('/api/test/runs').then((res) => res.json());
    runSelect.innerHTML = '';
    if (!Array.isArray(runs) || runs.length === 0) {
      runSelect.innerHTML = '<option value="">No recorded runs yet</option>';
    } else {
      runSelect.appendChild(new Option('Select recorded run...', ''));
      runs.forEach((run) => runSelect.appendChild(new Option(formatRunLabel(run), run.runId)));
    }
    updatePlaybackControls();
  } catch (err) {
    setPlaybackStatus(`Failed to load runs: ${err.message}`, true);
  }
}

async function refreshScriptList() {
  try {
    const scripts = await fetch('/api/test/scripts').then((res) => res.json());
    scriptSelect.innerHTML = '';
    if (!Array.isArray(scripts) || scripts.length === 0) {
      scriptSelect.innerHTML = '<option value="">No saved scripts yet</option>';
    } else {
      scriptSelect.appendChild(new Option('Select saved script...', ''));
      scripts.forEach((script) => scriptSelect.appendChild(new Option(formatScriptLabel(script), script.scriptId)));
    }
    updatePlaybackControls();
  } catch (err) {
    setPlaybackStatus(`Failed to load scripts: ${err.message}`, true);
  }
}

async function saveSelectedRunAsScript() {
  if (!runSelect.value) return;
  try {
    const response = await fetch('/api/test/scripts/from-run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId: runSelect.value, name: scriptNameInput.value.trim() || undefined }),
    });
    const result = await response.json();
    if (!result.success) throw new Error(result.error || 'Failed to save script');
    setPlaybackStatus(`Saved script: ${result.script.name}`);
    scriptNameInput.value = '';
    await refreshScriptList();
    scriptSelect.value = result.script.scriptId;
    updatePlaybackControls();
  } catch (err) {
    setPlaybackStatus(`Failed to save script: ${err.message}`, true);
  }
}

function replaySelectedScript() {
  if (!scriptSelect.value || !selectedDevice) return;
  ws.send({ type: 'replay-script', scriptId: scriptSelect.value, device: selectedDevice, policy: getReplayPolicy() });
}

function startRecording() {
  if (!streaming) {
    setRecordingStatus('Start mirroring before recording.', true);
    return;
  }
  if (!canvas.captureStream) {
    setRecordingStatus('Recording unsupported in this browser.', true);
    return;
  }

  const mimeType = getPreferredRecordingMimeType();
  if (!mimeType) {
    setRecordingStatus('No supported recording codec found.', true);
    return;
  }

  try {
    if (recordingUrl) {
      URL.revokeObjectURL(recordingUrl);
      recordingUrl = null;
    }
    recordingBlob = null;
    recordingChunks = [];
    recordingMimeType = mimeType;

    recordingStream = canvas.captureStream(30);
    mediaRecorder = new MediaRecorder(recordingStream, { mimeType: recordingMimeType, videoBitsPerSecond: 4_000_000 });

    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) recordingChunks.push(event.data);
    };

    mediaRecorder.onerror = () => {
      setRecordingStatus('Recording error occurred.', true);
      updateRecordingControls();
    };

    mediaRecorder.onstop = () => {
      const tracks = recordingStream ? recordingStream.getTracks() : [];
      tracks.forEach((track) => track.stop());
      recordingStream = null;

      if (recordingChunks.length > 0) {
        recordingBlob = new Blob(recordingChunks, { type: recordingMimeType || 'video/webm' });
        recordingUrl = URL.createObjectURL(recordingBlob);
        setRecordingStatus(`Recording ready (${(recordingBlob.size / (1024 * 1024)).toFixed(1)} MB). Click Download.`);
      } else {
        setRecordingStatus('Recording finished but no data was captured.', true);
      }

      resetRecordingTimer();
      updateRecordingControls();
    };

    mediaRecorder.start(1000);
    recordingStartedAt = Date.now();
    updateRecordingTimer();
    recordingTimerInterval = setInterval(updateRecordingTimer, 500);
    setRecordingStatus('Recording in progress...');
    updateRecordingControls();
  } catch (err) {
    setRecordingStatus(`Failed to start recording: ${err.message}`, true);
    mediaRecorder = null;
    if (recordingStream) {
      recordingStream.getTracks().forEach((track) => track.stop());
      recordingStream = null;
    }
    resetRecordingTimer();
    updateRecordingControls();
  }
}

function stopRecording(statusText) {
  if (!mediaRecorder || mediaRecorder.state !== 'recording') return;
  if (statusText) setRecordingStatus(statusText);
  mediaRecorder.stop();
}

function downloadRecording() {
  if (!recordingBlob || !recordingUrl) return;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const extension = recordingMimeType.includes('webm') ? 'webm' : 'mp4';
  const a = document.createElement('a');
  a.href = recordingUrl;
  a.download = `mobiclaw-recording-${stamp}.${extension}`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function showWifiStatus(success, message) {
  wifiStatus.textContent = message;
  wifiStatus.className = 'text-xs min-h-[16px] ' +
    (success === true ? 'text-emerald-400' :
     success === false ? 'text-red-400' :
     'text-muted-foreground');
}

// Alias for backward compat
const touch = touchCanvas;

// --- Chat / AI Agent ---

const btnAgentStop = document.getElementById('btn-agent-stop');
let agentRunning = false;

ws.on('chat-response', (msg) => {
  addChatMessage(msg.message, 'bot', msg.error);
});

ws.on('agent-step', (msg) => {
  const st = msg.stepType;
  switch (st) {
    case 'start':
      agentRunning = true;
      btnAgentStop.classList.remove('hidden');
      updateSendButton();
      addAgentStep('start', `Goal: "${msg.goal}" (max ${msg.maxSteps} steps, ${msg.provider || 'ai'})`);
      break;
    case 'perceiving':
      addAgentStep('perceive', `Step ${msg.step}: Reading screen...`);
      break;
    case 'thinking':
      updateLastStep(`Step ${msg.step}: Thinking...`);
      break;
    case 'decided':
      updateLastStep(`Step ${msg.step}: ${msg.think}`);
      addAgentStep('action', `${msg.action}${msg.reason ? ' — ' + msg.reason : ''}`);
      break;
    case 'acted':
      break;
    case 'debug_candidates':
      addAgentCandidateDebug(msg);
      break;
    case 'done':
      addAgentStep('done', msg.message || 'Goal achieved!');
      agentRunning = false;
      btnAgentStop.classList.add('hidden');
      updateSendButton();
      break;
    case 'maxsteps':
      addAgentStep('warn', msg.message);
      agentRunning = false;
      btnAgentStop.classList.add('hidden');
      updateSendButton();
      break;
    case 'stopped':
      addAgentStep('warn', 'Agent stopped by user');
      agentRunning = false;
      btnAgentStop.classList.add('hidden');
      updateSendButton();
      break;
    case 'error':
      addAgentStep('error', msg.message);
      break;
    default:
      console.log('[Agent] Unknown step:', st, msg);
  }
});

// --- Manager Agent events (hierarchical planning mode) ---
ws.on('manager-event', (msg) => {
  const t = msg.eventType;
  switch (t) {
    case 'manager-start':
      agentRunning = true;
      btnAgentStop.classList.remove('hidden');
      updateSendButton();
      addAgentStep('start', `Goal: "${msg.goal}" (planner mode, max ${msg.maxSubGoals} rounds, ${msg.provider || 'ai'})`);
      break;
    case 'manager-planning':
      addAgentStep('perceive', `Round ${msg.round}: Planning...`);
      break;
    case 'manager-plan': {
      addManagerPlan('', msg.subGoals || [], msg.analysis, msg.round);
      break;
    }
    case 'manager-executing':
      addAgentStep('action', `Executing sub-goal ${msg.subGoalIndex + 1}/${msg.totalSubGoals}: "${msg.subGoal}"`);
      break;
    case 'manager-subgoal-result': {
      const icon = msg.status === 'done' ? 'done' : msg.status === 'error' ? 'error' : 'warn';
      addAgentStep(icon, `Sub-goal "${msg.subGoal}" → ${msg.status}${msg.summary ? ': ' + msg.summary : ''}`);
      break;
    }
    case 'manager-done':
      addAgentStep('done', msg.message || 'Goal achieved!');
      agentRunning = false;
      btnAgentStop.classList.add('hidden');
      updateSendButton();
      break;
    case 'manager-maxrounds':
      addAgentStep('warn', msg.message);
      agentRunning = false;
      btnAgentStop.classList.add('hidden');
      updateSendButton();
      break;
    case 'manager-error':
      addAgentStep('error', msg.message);
      break;
    // Executor steps forwarded from within the manager
    case 'executor-step':
      handleExecutorStep(msg);
      break;
    default:
      console.log('[Manager] Unknown event:', t, msg);
  }
});

function sendChat() {
  // If agent is running, stop it
  if (agentRunning) {
    ws.send({ type: 'agent-stop' });
    agentRunning = false;
    updateSendButton();
    return;
  }

  const text = chatInput.value.trim();
  if (!text || !selectedDevice) return;
  addChatMessage(text, 'user');
  ws.send({ type: 'chat', device: selectedDevice, prompt: text });
  chatInput.value = '';

  // Immediately show stop button if it's not a / command
  if (!text.startsWith('/') && text !== 'help' && text !== '?') {
    agentRunning = true;
    updateSendButton();
  }
}

const ICON_SEND = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z"/><path d="m21.854 2.147-10.94 10.939"/></svg>';
const ICON_STOP = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>';

function updateSendButton() {
  if (!streaming && !agentRunning) {
    chatInput.disabled = true;
    chatInput.placeholder = 'Start mirroring to use AI agent...';
    btnChatSend.disabled = true;
    btnChatSend.classList.remove('bg-purple-600', 'hover:bg-purple-700', 'bg-red-600', 'hover:bg-red-700');
    btnChatSend.classList.add('opacity-40', 'cursor-not-allowed');
    btnChatSend.innerHTML = ICON_SEND;
    btnChatSend.title = 'Start mirroring first';
  } else if (agentRunning) {
    chatInput.disabled = false;
    chatInput.placeholder = 'Tell the AI what to do...';
    btnChatSend.disabled = false;
    btnChatSend.classList.remove('bg-purple-600', 'hover:bg-purple-700', 'opacity-40', 'cursor-not-allowed');
    btnChatSend.classList.add('bg-red-600', 'hover:bg-red-700');
    btnChatSend.innerHTML = ICON_STOP;
    btnChatSend.title = 'Stop agent';
  } else {
    chatInput.disabled = false;
    chatInput.placeholder = 'Tell the AI what to do...';
    btnChatSend.disabled = false;
    btnChatSend.classList.remove('bg-red-600', 'hover:bg-red-700', 'opacity-40', 'cursor-not-allowed');
    btnChatSend.classList.add('bg-purple-600', 'hover:bg-purple-700');
    btnChatSend.innerHTML = ICON_SEND;
    btnChatSend.title = 'Send';
  }
}

btnChatSend.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendChat();
});

btnChatHelp.addEventListener('click', () => {
  ws.send({ type: 'chat', device: selectedDevice || '_', prompt: '/help' });
});

btnRecordStart.addEventListener('click', startRecording);
btnRecordStop.addEventListener('click', () => stopRecording('Finalizing recording...'));
btnRecordDownload.addEventListener('click', downloadRecording);
btnRunsRefresh.addEventListener('click', refreshRunList);
btnViewRun.addEventListener('click', openRunDetail);
btnScriptsRefresh.addEventListener('click', refreshScriptList);
btnReplaysRefresh.addEventListener('click', refreshReplayList);
btnViewReplay.addEventListener('click', openReplayDetail);
btnSaveScript.addEventListener('click', saveSelectedRunAsScript);
btnReplayScript.addEventListener('click', replaySelectedScript);
btnReplayStop.addEventListener('click', () => ws.send({ type: 'replay-stop' }));
runSelect.addEventListener('change', updatePlaybackControls);
scriptSelect.addEventListener('change', updatePlaybackControls);
replaySelect.addEventListener('change', updatePlaybackControls);
replayMode.addEventListener('change', updatePlaybackControls);
replayRetries.addEventListener('input', updatePlaybackControls);
replayHardFailures.addEventListener('input', updatePlaybackControls);
replaySoftFailures.addEventListener('input', updatePlaybackControls);
replaySemanticFallback.addEventListener('change', updatePlaybackControls);
btnCloseRunDetail.addEventListener('click', closeRunDetail);
runDetailOverlay.addEventListener('click', closeRunDetail);
btnCloseReplayDetail.addEventListener('click', closeReplayDetail);
replayDetailOverlay.addEventListener('click', closeReplayDetail);

btnChatClear.addEventListener('click', () => {
  chatMessages.innerHTML = '';
});

btnHome.addEventListener('click', () => {
  window.location.href = '/';
});

btnLogout.addEventListener('click', () => {
  localStorage.removeItem('mobiclaw-config');
  window.location.href = '/';
});

btnAgentStop.addEventListener('click', () => {
  ws.send({ type: 'agent-stop' });
});

// Clickable suggestions
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('chat-suggestion')) {
    chatInput.value = e.target.textContent;
    sendChat();
  }
});

function addChatMessage(text, sender, isError = false) {
  const div = document.createElement('div');
  div.className = `chat-msg chat-msg-${sender}${isError ? ' chat-msg-error' : ''}`;
  const html = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\n/g, '<br>');
  div.innerHTML = html;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function addAgentStep(type, text) {
  const div = document.createElement('div');
  const icons = {
    start: '&#x1F3AF;',    // target
    perceive: '&#x1F441;', // eye
    action: '&#x26A1;',    // lightning
    done: '&#x2705;',      // check
    warn: '&#x26A0;',      // warning
    error: '&#x274C;',     // x
  };
  const colors = {
    start: 'text-purple-400',
    perceive: 'text-blue-400',
    action: 'text-amber-400',
    done: 'text-emerald-400',
    warn: 'text-yellow-400',
    error: 'text-red-400',
  };
  div.className = `chat-msg chat-msg-bot text-xs ${colors[type] || ''}`;
  div.innerHTML = `<span class="opacity-70">${icons[type] || ''}</span> ${escapeHtml(text)}`;
  div.dataset.agentStep = 'true';
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function updateLastStep(text) {
  const steps = chatMessages.querySelectorAll('[data-agent-step]');
  if (steps.length > 0) {
    const last = steps[steps.length - 1];
    const icon = last.innerHTML.match(/^<span[^>]*>.*?<\/span>/)?.[0] || '';
    last.innerHTML = `${icon} ${escapeHtml(text)}`;
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
}

function addAgentCandidateDebug(msg) {
  const flags = [];
  if (msg.modalDetected) flags.push('modal');
  if (msg.elementsStale) flags.push('stale-elements');
  if ((msg.ocrCount || 0) > 0) flags.push(`ocr=${msg.ocrCount}`);
  if (msg.modalMetrics?.maxElementAreaRatio !== undefined) {
    flags.push(`maxArea=${msg.modalMetrics.maxElementAreaRatio}`);
  }
  const header = `Step ${msg.step} candidates${flags.length ? ` [${flags.join(', ')}]` : ''}`;

  const lines = (msg.candidates || []).slice(0, 8).map((candidate) => {
    const label = candidate.text || candidate.desc || candidate.id || candidate.type || `#${candidate.i}`;
    const tap = Array.isArray(candidate.tap) ? ` @${candidate.tap[0]},${candidate.tap[1]}` : '';
    const conf = typeof candidate.confidence === 'number' ? ` (c=${candidate.confidence.toFixed(2)})` : '';
    const source = candidate.source ? ` [${candidate.source}]` : '';
    return `- ${label}${source}${tap}${conf}`;
  });

  addAgentStep('perceive', `${header}\n${lines.length ? lines.join('\n') : '- no candidates'}`);
}

function addManagerPlan(text, subGoals, analysis, round) {
  const div = document.createElement('div');
  div.className = 'chat-msg chat-msg-bot text-xs text-purple-300';
  div.dataset.agentStep = 'true';

  let html = `<span class="opacity-70">&#x1F4CB;</span> `;
  if (subGoals.length > 0) {
    html += `<strong>Round ${round || '?'} Plan (${subGoals.length} steps):</strong>`;
    if (analysis) html += `<br><span class="text-muted-foreground">${escapeHtml(analysis)}</span>`;
    html += '<br>';
    subGoals.forEach((sg, i) => {
      html += `<span class="text-muted-foreground ml-2">${i + 1}.</span> ${escapeHtml(sg)}<br>`;
    });
  } else {
    html += escapeHtml(text);
  }
  div.innerHTML = html;
  chatMessages.appendChild(div);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function handleExecutorStep(msg) {
  const st = msg.stepType;
  switch (st) {
    case 'start':
      // Sub-goal start — already shown by manager-executing
      break;
    case 'perceiving':
      addAgentStep('perceive', `  Step ${msg.step}: Reading screen...`);
      break;
    case 'thinking':
      updateLastStep(`  Step ${msg.step}: Thinking...`);
      break;
    case 'decided':
      updateLastStep(`  Step ${msg.step}: ${msg.think}`);
      addAgentStep('action', `  ${msg.action}${msg.reason ? ' — ' + msg.reason : ''}`);
      break;
    case 'acted':
    case 'done':
    case 'maxsteps':
    case 'stopped':
      // Handled at the manager level
      break;
    case 'stuck':
      addAgentStep('warn', `  Screen unchanged for ${msg.count} steps`);
      break;
    case 'error':
      addAgentStep('error', `  ${msg.message}`);
      break;
  }
}

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Start ---
updateSendButton();
updateRecordingControls();
updatePlaybackControls();
refreshRunList();
refreshScriptList();
refreshReplayList();
ws.connect();

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

// State
let streaming = false;
let selectedDevice = null;
let activeRenderer = null;
let currentStreamMode = null;
let wifiConnectedSerial = null; // Track wireless device for disconnect

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

// --- WebSocket Events ---

ws.on('connected', () => {
  setStatus('connected', 'Connected');
  ws.send({ type: 'list-devices' });
  ws.send({ type: 'get-capabilities' });
});

ws.on('disconnected', () => {
  setStatus('disconnected', 'Disconnected');
  streaming = false;
  currentStreamMode = null;
  btnConnect.textContent = 'Start Mirror';
  hideAllScreens();
  placeholder.classList.remove('hidden');
  statusMode.textContent = '--';
  webrtcRenderer.close();
});

ws.on('capabilities', (msg) => {
  const scrcpyRadio = document.querySelector('input[name="mode"][value="scrcpy"]');
  const webrtcRadio = document.querySelector('input[name="mode"][value="webrtc"]');
  const screenrecordRadio = document.querySelector('input[name="mode"][value="screenrecord"]');

  // screenrecord is always available (system binary)
  if (screenrecordRadio) screenrecordRadio.disabled = false;

  // scrcpy/webrtc need the scrcpy server
  if (scrcpyRadio) scrcpyRadio.disabled = !msg.scrcpy;
  if (webrtcRadio) webrtcRadio.disabled = !msg.scrcpy || !webrtcRenderer.supported;

  // H.264 modes need WebCodecs
  if (!h264Renderer.supported) {
    if (scrcpyRadio) scrcpyRadio.disabled = true;
    if (screenrecordRadio) screenrecordRadio.disabled = true;
    document.querySelector('input[name="mode"][value="screencap"]').checked = true;
  }
});

ws.on('device-list', (msg) => {
  deviceSelect.innerHTML = '<option value="">Select device...</option>';
  msg.devices.forEach(d => {
    const opt = document.createElement('option');
    opt.value = d.serial;
    // Truncate long serial names for display
    opt.textContent = d.serial.length > 28 ? d.serial.substring(0, 25) + '...' : d.serial;
    opt.title = d.serial; // Full name on hover
    deviceSelect.appendChild(opt);
  });

  if (msg.devices.length === 1) {
    deviceSelect.value = msg.devices[0].serial;
    deviceSelect.dispatchEvent(new Event('change'));
  }

  // If wifi device is gone, reset wifi button
  if (wifiConnectedSerial && !msg.devices.find(d => d.serial === wifiConnectedSerial)) {
    wifiConnectedSerial = null;
    updateWifiButton();
  }

  // If selected device was disconnected, reset UI
  if (selectedDevice && !msg.devices.find(d => d.serial === selectedDevice)) {
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
    setStatus('connected', 'No device');
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
  btnConnect.textContent = 'Stop Mirror';
  btnConnect.classList.remove('bg-emerald-600', 'hover:bg-emerald-700');
  btnConnect.classList.add('bg-red-600', 'hover:bg-red-700');
  placeholder.classList.add('hidden');
  setStatus('streaming', 'Streaming');

  if (msg.mode === 'webrtc') {
    statusMode.textContent = 'WebRTC';
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
  streaming = false;
  currentStreamMode = null;
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
  if (msg.success && msg.serial) {
    wifiConnectedSerial = msg.serial;
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

  if (selectedDevice) {
    ws.send({ type: 'get-device-info', device: selectedDevice });
  } else {
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
    ws.send({ type: 'wifi-disconnect', serial: wifiConnectedSerial });
    wifiConnectedSerial = null;
    updateWifiButton();
    return;
  }

  const host = connectHost.value.trim();
  const port = parseInt(connectPort.value, 10);
  if (!host) { showWifiStatus(false, 'Enter an IP address'); return; }
  if (!port) { showWifiStatus(false, 'Enter a port number'); return; }
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
  statusDot.className = 'w-2 h-2 rounded-full ' +
    (state === 'streaming' ? 'streaming bg-emerald-500' :
     state === 'connected' ? 'connected bg-emerald-500' :
     'bg-zinc-600');
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
  if (agentRunning) {
    btnChatSend.classList.remove('bg-purple-600', 'hover:bg-purple-700');
    btnChatSend.classList.add('bg-red-600', 'hover:bg-red-700');
    btnChatSend.innerHTML = ICON_STOP;
    btnChatSend.title = 'Stop agent';
  } else {
    btnChatSend.classList.remove('bg-red-600', 'hover:bg-red-700');
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

function escapeHtml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// --- Start ---
ws.connect();

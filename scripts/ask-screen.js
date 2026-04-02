/**
 * ask-screen.js
 * Connects to the MobiClaw server, picks the first available device,
 * and asks the AI agent "What's on the screen right now?"
 *
 * Usage:
 *   node scripts/ask-screen.js
 *   node scripts/ask-screen.js "What app is open?"
 *   node scripts/ask-screen.js --device 192.168.0.239:5555 "Describe the screen"
 */

import WebSocket from 'ws';

const BASE_URL = process.env.MOBICLAW_URL || 'http://localhost:3000';
const WS_URL   = BASE_URL.replace(/^http/, 'ws');
const ITERATION_DELAY_MS = 30_000;

let shouldStop = false;

process.on('SIGINT', () => {
  shouldStop = true;
  console.log('\nStopping ask-screen loop...');
});

// Parse args: optional --device <serial> and optional prompt
let deviceSerial = null;
let prompt = 'What is currently on the screen? Describe what you see in detail, then respond with done.';

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--device' && args[i + 1]) {
    deviceSerial = args[++i];
  } else {
    prompt = args[i];
  }
}

async function getFirstDevice() {
  const res = await fetch(`${BASE_URL}/api/devices`);
  const devices = await res.json();
  if (!devices.length) throw new Error('No devices connected. Connect a device first.');
  return devices[0].serial;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runSingleIteration() {
  // Resolve device
  if (!deviceSerial) {
    process.stdout.write('Fetching devices... ');
    deviceSerial = await getFirstDevice();
    console.log(`using ${deviceSerial}`);
  }

  console.log(`\nPrompt : "${prompt}"`);
  console.log(`Device : ${deviceSerial}`);
  console.log('─'.repeat(60));

  const ws = new WebSocket(WS_URL);

  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  // Send the chat message
  ws.send(JSON.stringify({ type: 'chat', device: deviceSerial, prompt }));

  // Stream agent steps to stdout
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('Timed out waiting for agent response (60s)'));
    }, 60_000);

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());

      if (msg.type !== 'agent-step') return;

      const { stepType } = msg;

      switch (stepType) {
        case 'start':
          console.log(`[start]  Goal: "${msg.goal}" — provider: ${msg.provider}`);
          break;
        case 'perceiving':
          process.stdout.write(`[step ${msg.step}] Perceiving screen...`);
          break;
        case 'thinking':
          process.stdout.write(' thinking...');
          break;
        case 'decided':
          process.stdout.write('\n');
          console.log(`[step ${msg.step}] ${msg.think}`);
          console.log(`         → action: ${msg.action}${msg.reason ? ' — ' + msg.reason : ''}`);
          break;
        case 'acted':
          break;
        case 'done':
          process.stdout.write('\n');
          console.log('─'.repeat(60));
          console.log(`[done]   ${msg.message || 'Goal achieved'}`);
          clearTimeout(timeout);
          ws.close();
          resolve();
          break;
        case 'error':
          process.stdout.write('\n');
          console.error(`[error]  ${msg.message}`);
          break;
        case 'maxsteps':
          process.stdout.write('\n');
          console.warn(`[warn]   ${msg.message}`);
          clearTimeout(timeout);
          ws.close();
          resolve();
          break;
        case 'stopped':
          clearTimeout(timeout);
          ws.close();
          resolve();
          break;
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function main() {
  while (!shouldStop) {
    try {
      await runSingleIteration();
    } catch (err) {
      console.error('Error:', err.message);
    }

    if (shouldStop) break;

    console.log(`Waiting ${ITERATION_DELAY_MS / 1000}s before next run...`);
    await sleep(ITERATION_DELAY_MS);
  }
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});

import express from 'express';
import { createServer } from 'http';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './config.js';
import { listDevices, trackDevices } from './adb/adb-client.js';
import { createWsHandler } from './ws/ws-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ENV_PATH = join(__dirname, '..', '.env');
const app = express();
const server = createServer(app);

app.use(express.json());

// Landing page at /
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '..', 'client', 'landing.html'));
});

// Mirror app at /app
app.get('/app', (req, res) => {
  res.sendFile(join(__dirname, '..', 'client', 'index.html'));
});

// Serve static frontend files
app.use(express.static(join(__dirname, '..', 'client')));

// API: Save config (API key + model)
app.post('/api/config', (req, res) => {
  try {
    const { provider, apiKey, model } = req.body;
    if (!provider || !apiKey) {
      return res.json({ success: false, error: 'Provider and API key are required' });
    }

    // Read existing .env
    let envContent = '';
    if (existsSync(ENV_PATH)) {
      envContent = readFileSync(ENV_PATH, 'utf-8');
    }

    // Clear old API keys
    envContent = envContent
      .replace(/^GEMINI_API_KEY=.*$/gm, '')
      .replace(/^GEMINI_MODEL=.*$/gm, '')
      .replace(/^OPENAI_API_KEY=.*$/gm, '')
      .replace(/^OPENAI_MODEL=.*$/gm, '')
      .replace(/^ANTHROPIC_API_KEY=.*$/gm, '')
      .replace(/^ANTHROPIC_MODEL=.*$/gm, '')
      .replace(/^#\s*GEMINI_API_KEY=.*$/gm, '')
      .replace(/^#\s*OPENAI_API_KEY=.*$/gm, '')
      .replace(/^#\s*ANTHROPIC_API_KEY=.*$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // Add new key
    const keyMap = { gemini: 'GEMINI', openai: 'OPENAI', anthropic: 'ANTHROPIC' };
    const prefix = keyMap[provider];
    envContent += `\n\n${prefix}_API_KEY=${apiKey}\n${prefix}_MODEL=${model}\n`;

    writeFileSync(ENV_PATH, envContent.trim() + '\n');

    // Update process.env so the agent picks it up immediately
    process.env[`${prefix}_API_KEY`] = apiKey;
    process.env[`${prefix}_MODEL`] = model;

    console.log(`[Config] ${provider} API key saved (model: ${model})`);
    res.json({ success: true });
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// API: Get current config (without exposing full key)
app.get('/api/config', (req, res) => {
  let provider = 'none';
  let model = '';
  let keySet = false;

  if (process.env.GEMINI_API_KEY) {
    provider = 'gemini';
    model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    keySet = true;
  } else if (process.env.OPENAI_API_KEY) {
    provider = 'openai';
    model = process.env.OPENAI_MODEL || 'gpt-4o';
    keySet = true;
  } else if (process.env.ANTHROPIC_API_KEY) {
    provider = 'anthropic';
    model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-20250514';
    keySet = true;
  }

  res.json({ provider, model, keySet });
});

// REST API for device list
app.get('/api/devices', async (req, res) => {
  try {
    const devices = await listDevices();
    res.json(devices.map(d => ({ serial: d.id, type: d.type })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// WebSocket handler
const wss = createWsHandler(server);

// Track device connections and broadcast to all clients
trackDevices(async (event, device) => {
  console.log(`[ADB] Device ${event}: ${device.id} (${device.type})`);
  try {
    const devices = await listDevices();
    const msg = JSON.stringify({
      type: 'device-list',
      devices: devices.map(d => ({ serial: d.id, type: d.type })),
    });
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) {
        ws.send(msg);
      }
    }
  } catch (_) {}
});

server.listen(config.port, () => {
  console.log(`\n  MobiClaw`);
  console.log(`  ────────`);
  console.log(`  Server:  http://localhost:${config.port}`);
  console.log(`  ADB:     Waiting for devices...\n`);

  listDevices().then(devices => {
    if (devices.length === 0) {
      console.log('  No devices connected. Connect a device via USB or adb connect <ip>');
    } else {
      devices.forEach(d => console.log(`  Found device: ${d.id}`));
    }
    console.log('');
  }).catch(err => {
    console.error('  [Error] ADB not found or not running.');
    console.error('  Make sure ADB is installed and in your PATH.');
    console.error(`  Details: ${err.message}\n`);
  });
});

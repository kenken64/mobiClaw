import express from 'express';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import config from './config.js';
import { listDevices, trackDevices } from './adb/adb-client.js';
import { createWsHandler } from './ws/ws-handler.js';
import { createScriptFromRun, getReplay, getRun, getScript, listReplays, listRuns, listScripts } from './recording/artifact-store.js';

// Prevent adbkit/Bluebird uncaught errors from crashing the server
process.on('uncaughtException', (err) => {
  console.error('[Server] Uncaught exception (non-fatal):', err.message);
});
process.on('unhandledRejection', (reason) => {
  console.error('[Server] Unhandled rejection (non-fatal):', reason?.message || reason);
});

const __dirname = dirname(fileURLToPath(import.meta.url));
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
app.use('/artifacts', express.static(join(__dirname, '..', 'artifacts')));

// API: Save config (API key + model) — stored in memory only, never written to disk
app.post('/api/config', (req, res) => {
  try {
    const { provider, apiKey, model, baseUrl } = req.body;
    if (!provider) {
      return res.json({ success: false, error: 'Provider is required' });
    }

    // Ollama: no API key needed
    if (provider === 'ollama') {
      // Clear other providers
      delete process.env.GEMINI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      process.env.OLLAMA_MODEL = model || 'qwen2.5vl:72b';
      process.env.OLLAMA_BASE_URL = baseUrl || 'http://localhost:11434';
      console.log(`[Config] ollama config updated in memory (model: ${process.env.OLLAMA_MODEL}, url: ${process.env.OLLAMA_BASE_URL})`);
      return res.json({ success: true });
    }

    const keyMap = { gemini: 'GEMINI', openai: 'OPENAI', anthropic: 'ANTHROPIC' };
    const prefix = keyMap[provider];
    if (!prefix) {
      return res.json({ success: false, error: 'Invalid provider' });
    }

    // Allow omitting apiKey if one is already configured for this provider
    const existingKey = process.env[`${prefix}_API_KEY`];
    const keyToUse = apiKey || existingKey;
    if (!keyToUse) {
      return res.json({ success: false, error: 'API key is required' });
    }

    // Clear other providers so getProvider() picks the right one
    const allPrefixes = ['GEMINI', 'OPENAI', 'ANTHROPIC'];
    for (const p of allPrefixes) {
      if (p !== prefix) delete process.env[`${p}_API_KEY`];
    }
    delete process.env.OLLAMA_MODEL;

    // Store in process.env only (in-memory, not persisted to disk)
    process.env[`${prefix}_API_KEY`] = keyToUse;
    process.env[`${prefix}_MODEL`] = model;

    console.log(`[Config] ${provider} config updated in memory (model: ${model})`);
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
  } else if (process.env.OLLAMA_MODEL) {
    provider = 'ollama';
    model = process.env.OLLAMA_MODEL;
    keySet = true;
  }

  const result = { provider, model, keySet };
  if (provider === 'ollama') result.baseUrl = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
  res.json(result);
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

app.get('/api/test/runs', async (req, res) => {
  try {
    res.json(await listRuns());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/test/runs/:runId', async (req, res) => {
  try {
    const includeSteps = req.query.includeSteps === '1';
    res.json(await getRun(req.params.runId, { includeSteps }));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.post('/api/test/scripts/from-run', async (req, res) => {
  try {
    const { runId, name, stepNumbers } = req.body || {};
    if (!runId) return res.status(400).json({ success: false, error: 'runId is required' });
    const script = await createScriptFromRun({ runId, name, stepNumbers });
    res.json({ success: true, script });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.get('/api/test/scripts', async (req, res) => {
  try {
    res.json(await listScripts());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/test/scripts/:scriptId', async (req, res) => {
  try {
    res.json(await getScript(req.params.scriptId));
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

app.get('/api/test/replays', async (req, res) => {
  try {
    res.json(await listReplays());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/test/replays/:replayId', async (req, res) => {
  try {
    res.json(await getReplay(req.params.replayId));
  } catch (err) {
    res.status(404).json({ error: err.message });
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

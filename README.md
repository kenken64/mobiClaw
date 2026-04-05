# MobiClaw

> AI-powered Android phone control from your browser. Mirror your screen, tap, swipe, and give natural language commands — the AI reads the screen, thinks, and acts.

## How It Works

```
You type: "open youtube and search for lofi music"

Agent: Step 1 -> reads screen -> thinks -> taps YouTube icon
Agent: Step 2 -> reads screen -> thinks -> taps search bar
Agent: Step 3 -> reads screen -> thinks -> types "lofi music"
Agent: Step 4 -> reads screen -> thinks -> presses enter
Agent: Step 5 -> reads screen -> "done!"

All automatic. No human interaction needed.
```

The AI agent uses a **perception -> reasoning -> action** loop:

```
                    +-------------------------------------------+
                    |            your goal                       |
                    |  "open settings and turn on wifi"          |
                    +-------------------+-----------------------+
                                        |
                                        v
                    +-------------------------------------------+
                    |                                           |
                    |          1. PERCEIVE                      |
                    |   - dump accessibility tree via ADB       |
                    |   - capture screenshot                    |
                    |   - detect foreground app                 |
                    |   - discard stale elements                |
                    |                                           |
                    |          2. REASON                        |
                    |   - send screen + goal to LLM             |
                    |   - LLM returns action as JSON            |
                    |   - "I see the WiFi toggle, tapping it"   |
                    |                                           |
                    |          3. ACT                           |
                    |   - execute via ADB: tap, type, swipe     |
                    |   - check if goal is done                 |
                    |   - loop back to perceive                 |
                    |                                           |
                    +-------------------------------------------+
```

## Features

- **Screen Mirroring** - 3 modes: H.264 (scrcpy, up to 60fps), WebRTC (DataChannel), PNG (screencap)
- **AI Agent** - Hierarchical planner/executor by default, with legacy single-loop mode via `/simple`
- **Multi-LLM** - Google Gemini, OpenAI GPT, Anthropic Claude, Ollama (auto-detects from .env)
- **Vision** - Screenshots sent to LLM for visual understanding of the screen
- **Touch Control** - Click-to-tap, drag-to-swipe, scroll wheel from the browser
- **Native Input Injection** - Agent actions use scrcpy control injection when available, with adb shell fallback
- **Navigation** - Back, Home, Recent, Volume, Power buttons
- **Recording & Download** - Record mirrored screen in-browser and download `.webm`
- **Wireless ADB** - Connect and pair devices from the browser UI
- **Auto-Reconnect** - Stream auto-restarts on disconnect
- **Stop Agent** - Cancel in-flight LLM requests and pending ADB actions instantly
- **Direct Commands** - `/swipe up`, `/open settings`, `/help` with `/` prefix
- **Playback Lab** - Save recorded AI runs as replayable scripts and run them again from the web UI
- **Stale Detection** - Discards stale accessibility data, falls back to screenshot-only mode
- **API Key Storage** - Set API keys from the browser UI (saved to localStorage)
- **Professional UI** - Tailwind CSS + Lucide icons, shadcn-inspired dark theme

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [ADB (Android Platform Tools)](https://developer.android.com/tools/releases/platform-tools)
- An Android device with USB Debugging enabled
- An API key for one of: Google Gemini, OpenAI, Anthropic, or a local Ollama instance (for AI agent)

### Install

```bash
git clone https://github.com/kenken64/MobiClaw.git
cd MobiClaw
npm install
```

### Configure

Copy `.env.example` to `.env` and set your API key:

```bash
cp .env.example .env
```

```env
PORT=3000
# ADB_PATH=/path/to/adb   # optional — auto-detected if adb is in PATH

# Set ONE of these (priority: Gemini > OpenAI > Anthropic > Ollama):
GEMINI_API_KEY=your-key-here
# OPENAI_API_KEY=sk-...
# ANTHROPIC_API_KEY=sk-ant-...
# OLLAMA_MODEL=qwen2.5vl:72b
# OLLAMA_MODEL=gemma4:e4b
```

You can also set API keys directly from the browser UI — they are saved to localStorage and used automatically.

### Run

```bash
# Connect your Android device via USB (with USB debugging enabled)
npm start
```

Open **http://localhost:3000** in Chrome/Edge.

## Usage

### Screen Mirroring

1. Select your device from the dropdown
2. Choose a mode: **H.264** (recommended), WebRTC, or PNG
3. Click **Start Mirror**
4. Click/drag on the screen to tap/swipe the phone
5. Use **Recording** panel: Start -> Stop -> Download video

### AI Agent

Type a natural language goal in the chat panel on the right:

- `open youtube and search for lofi music`
- `go to settings and check battery percentage`
- `open chrome and search for weather today`
- `what do you see on the mobile screen?`

By default, MobiClaw runs a hierarchical agent:

1. A **Manager** plans a short list of sub-goals from the current screenshot and task.
2. An **Executor** carries out each sub-goal with the perceive -> reason -> act loop.
3. The Manager re-plans after each sub-goal until the overall goal is complete.

The executor reads the screen (accessibility tree + screenshot), sends it to the LLM, and executes the returned action. When a scrcpy control channel is available, taps, swipes, drags, typing, and key presses are sent through that channel for lower-latency, more reliable input. Otherwise, MobiClaw falls back to adb shell input commands.

Use the `/simple` prefix if you want the older flat single-loop behavior instead of planner mode:

- `/simple open youtube and search for lofi music`
- `/simple describe the current screen`

Press the **Stop** button at any time to cancel immediately. In-flight LLM requests are aborted and no further actions are executed.

For drag-heavy tasks such as sliders, drag-and-drop, and grid-based puzzle games, the agent now prefers precise drag actions over taps or scroll swipes.

Runs are recorded automatically under `artifacts/runs/`. In the app sidebar, **Playback Lab** lets you refresh recorded runs, promote a run into a saved script, and replay a saved script against the currently selected device.

Playback now supports three replay policies in the web UI:

- `Strict` - stop on the first failure
- `Tolerant` - allow bounded soft failures before stopping
- `Continue` - continue through failures to gather a broader failure report

You can also configure replay retry count and hard/soft failure limits before starting playback.

When semantic fallback is enabled, replay will try to relocate tap and drag targets using the recorded element text/id/type and approximate position before falling back to the original coordinates. This helps scripts survive moderate UI drift on the same app flow.

Saved replay runs can also be inspected from the web UI. The replay-result viewer compares expected recorded screenshots from the source run with the live before/after screenshots captured during replay, step by step.

### Direct Commands

Prefix with `/` for instant commands without AI:

| Command | Example |
|---------|---------|
| `/open [app]` | `/open settings`, `/open chrome` |
| `/type [text]` | `/type hello world` |
| `/tap [x] [y]` | `/tap 500 300`, `/tap center` |
| `/swipe [dir]` | `/swipe up`, `/swipe left` |
| `/press [key]` | `/press home`, `/press back` |
| `/screenshot` | Take a screenshot |
| `/benchmark compare` | Run deterministic baseline vs enhanced benchmark |
| `/benchmark baseline` | Run baseline suite only |
| `/benchmark enhanced` | Run enhanced suite only |
| `/benchmark stop` | Stop active benchmark |
| `/simple [goal]` | Use the legacy single-loop agent for one request |
| `/help` | Show all commands |

### ask-screen Script

For unattended screen polling from the terminal, run:

```bash
node scripts/ask-screen.js
```

Optional forms:

```bash
node scripts/ask-screen.js "What app is open?"
node scripts/ask-screen.js --device 192.168.0.239:5555 "Describe the screen"
```

The script connects to the WebSocket server, asks the agent about the current screen, prints streamed agent steps, then waits 30 seconds and repeats until you stop it with `Ctrl+C`.

## Supported LLM Providers

| Provider | Model | Best For | Env Variable |
|----------|-------|----------|-------------|
| **Google Gemini** | gemini-2.5-flash | Android UI (Google makes Android), fast, cheap | `GEMINI_API_KEY` |
| **OpenAI** | gpt-4o | General vision tasks | `OPENAI_API_KEY` |
| **Anthropic** | claude-sonnet-4-20250514 | Structured reasoning | `ANTHROPIC_API_KEY` |
| **Ollama** | qwen2.5vl:72b, gemma4:e4b | Local/offline, no API key needed | `OLLAMA_MODEL` |

## Configuration

All settings in `.env`:

```env
PORT=3000                           # Web server port
# ADB_PATH=/path/to/adb            # Path to ADB (auto-detected if not set)

# AI Provider (set one)
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash       # default

OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o                 # default

ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-20250514

# Ollama (local models, no API key needed)
OLLAMA_MODEL=qwen2.5vl:72b          # model name to use
OLLAMA_BASE_URL=http://localhost:11434  # default

# Scrcpy streaming
SCRCPY_MAX_SIZE=1280                # Max screen dimension (0 = no limit)
SCRCPY_BITRATE=8000000              # Video bitrate (8Mbps)
SCRCPY_MAX_FPS=60                   # Max frames per second

# Agent loop tuning
AGENT_MAX_STEPS=20                  # Max steps per goal
AGENT_STEP_DELAY_MS=800             # Delay between steps (ms)

# Optional OCR fusion (improves tiny/non-accessible labels, requires GEMINI_API_KEY)
AGENT_OCR_ENABLE=1                  # 1=enable OCR fusion, 0=off (default off)
AGENT_OCR_EVERY_N_STEPS=2           # OCR cadence to control cost/latency
AGENT_OCR_MAX_RESULTS=12            # Max OCR boxes merged per step
GEMINI_OCR_MODEL=gemini-2.5-flash-lite

# Modal heuristics tuning (for dialog/overlay detection)
AGENT_MODAL_PANEL_MIN_RATIO=0.45    # Larger => stricter modal detection
AGENT_MODAL_TOP_REGION_MAX=0.20     # Larger => allow deeper panel origin
AGENT_MODAL_CENTER_MIN_RATIO=0.08   # Lower => include more modal candidates
AGENT_MODAL_DEBUG=1                 # Log modal metrics in server console

# Benchmark runner tuning
BENCHMARK_MAX_STEPS=12
BENCHMARK_STEP_DELAY_MS=300
```

## Architecture

```
server/
  index.js              # Express + WebSocket server
  config.js             # Config with ADB auto-detection
  adb/                  # ADB connection, device info
  stream/               # screencap + scrcpy H.264 providers
  input/                # Touch/key input (shell + scrcpy binary protocol)
  ws/                   # WebSocket message routing
  webrtc/               # WebRTC DataChannel transport
  chat/
    manager-agent.js    # Planner layer (default agent mode)
    agent.js            # Executor / legacy single-loop agent
    perception.js       # Screen reader (uiautomator + screencap)
    command-handler.js  # Direct /command parser
    benchmark-runner.js # Deterministic benchmark suite

client/
  index.html            # Tailwind UI (3-panel layout)
  js/app.js             # Main app + chat handler
  js/renderers/         # PNG, H.264 (WebCodecs), WebRTC renderers
  js/input/             # Touch/mouse event handler
```

## Known Limitations

- **Android 16** revokes screen capture every ~5 seconds (OS security feature). Auto-reconnect handles this, but there's a brief gap. A companion Android app with MediaProjection permission would fix this permanently.
- **uiautomator** can return stale accessibility data on Android 16. MobiClaw detects this by comparing the foreground app with element packages and falls back to screenshot-only mode.
- **Gemini free tier** has rate limits (requests/day). The agent auto-retries after the cooldown period.

## Tech Stack

- **Backend**: Node.js, Express, ws, werift
- **ADB**: @devicefarmer/adbkit + CLI
- **Streaming**: scrcpy-server v3.3.4
- **AI**: @google/genai, openai, @anthropic-ai/sdk
- **Frontend**: Tailwind CSS, Lucide Icons, WebCodecs API
- **Screen Perception**: Android uiautomator + screencap

## License

MIT

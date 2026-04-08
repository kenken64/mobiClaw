# MobiClaw — Technical Design Document

| Field | Value |
|---|---|
| **Document Owner** | MobiClaw Team |
| **Status** | Draft |
| **Version** | 1.0 |
| **Last Updated** | 2026-04-08 |
| **Companion Doc** | [PRD.md](./PRD.md) |

---

## 1. Purpose

This document describes the **how** behind MobiClaw — the architecture, modules, data flow, transports, agent loop internals, and configuration surface. For the **what** and **why** (goals, personas, requirements), see [PRD.md](./PRD.md).

---

## 2. System Architecture

### 2.1 High-Level Diagram

```
+------------------+        WebSocket / HTTP        +------------------+        ADB / scrcpy        +------------------+
|                  |  <-------------------------->  |                  |  <---------------------->  |                  |
|   Browser (UI)   |     frames, input, agent IO    |   Node Server    |    shell, input, video     |  Android Device  |
|                  |                                |                  |                            |                  |
+------------------+                                +--------+---------+                            +------------------+
                                                             |
                                                             v
                                                    +------------------+
                                                    |   LLM Providers  |
                                                    |  Gemini / OpenAI |
                                                    | Anthropic/Ollama |
                                                    +------------------+
```

### 2.2 Repository Layout

```
server/
  index.js              Express + WebSocket server entrypoint
  config.js             Env config + ADB auto-detection
  adb/                  ADB connection, device info, wireless pairing
  stream/               screencap (PNG) + scrcpy H.264 providers
  input/                Touch/key input (shell + scrcpy binary protocol)
  ws/                   WebSocket message routing
  webrtc/               WebRTC DataChannel transport
  chat/
    manager-agent.js    Planner layer (default agent mode)
    agent.js            Executor / legacy single-loop agent
    perception.js       Screen reader (uiautomator + screencap)
    command-handler.js  Direct /command parser
    benchmark-runner.js Deterministic benchmark suite

client/
  index.html            Tailwind UI (3-panel layout)
  js/app.js             Main app + chat handler
  js/renderers/         PNG, H.264 (WebCodecs), WebRTC renderers
  js/input/             Touch/mouse event handler

scripts/
  ask-screen.js         Unattended terminal screen-polling client
  download-scrcpy-server.js  Postinstall fetch of scrcpy-server.jar

artifacts/
  runs/                 Auto-saved agent runs (screenshots, actions, metadata)
```

---

## 3. Tech Stack

| Layer | Technology |
|---|---|
| **Server runtime** | Node.js v18+ (ES modules) |
| **HTTP / WS** | Express 5, `ws` |
| **Realtime media** | `werift` (WebRTC), scrcpy-server v3.3.4 (H.264) |
| **ADB** | `@devicefarmer/adbkit` + ADB CLI |
| **AI SDKs** | `@google/genai`, `openai`, `@anthropic-ai/sdk`, raw HTTP for Ollama |
| **Frontend** | Tailwind CSS, Lucide Icons, vanilla ES modules |
| **Video decoding** | WebCodecs API (Chromium) |
| **Perception** | Android `uiautomator dump` + `screencap -p` |
| **Config** | `dotenv` |

---

## 4. Module Breakdown

### 4.1 `server/index.js`
- Boots Express, mounts static `client/`, opens a WebSocket upgrade handler.
- Wires ADB, stream providers, input handlers, and chat router into the WS message bus.

### 4.2 `server/config.js`
- Loads `.env` via `dotenv`.
- Resolves `ADB_PATH` from env or `PATH` lookup.
- Exposes typed config object consumed by every other module.

### 4.3 `server/adb/`
- Wraps `@devicefarmer/adbkit` for device listing, model/version queries, wireless `pair` and `connect`.
- Provides shell helpers used by `input/` and `chat/perception.js`.

### 4.4 `server/stream/`
- **PNG provider**: polls `screencap -p`, encodes as PNG, pushes over WS.
- **scrcpy H.264 provider**: pushes `scrcpy-server.jar`, starts the server on the device, opens the video and control sockets, and forwards H.264 NALU frames over WS.
- Handles Android 16's periodic screen-capture revocation by tearing down and reconnecting transparently.

### 4.5 `server/input/`
- Two backends:
  - **scrcpy binary protocol** — preferred when the scrcpy control socket is open. Lower latency, more reliable.
  - **`adb shell input`** — fallback for `tap`, `swipe`, `text`, `keyevent`.
- Coordinate translation accounts for device rotation and configured `SCRCPY_MAX_SIZE`.

### 4.6 `server/ws/`
- Single WebSocket message bus.
- Message types include: `device.list`, `mirror.start`, `mirror.frame`, `input.tap`, `input.swipe`, `chat.message`, `agent.step`, `agent.stop`, `playback.*`, `benchmark.*`.
- Each handler is registered by the relevant subsystem at boot.

### 4.7 `server/webrtc/`
- `werift`-based WebRTC transport.
- Frames are sent over an ordered DataChannel — chosen for browsers that struggle with H.264 WebCodecs.

### 4.8 `server/chat/perception.js`
- Captures one perception frame per agent step:
  1. `uiautomator dump` → parse XML accessibility tree.
  2. `screencap -p` → screenshot.
  3. Detect foreground app via `dumpsys window`.
  4. Discard accessibility nodes whose package doesn't match the foreground app (stale-data guard).
  5. (Optional) OCR fusion via Gemini if `AGENT_OCR_ENABLE=1`, gated by `AGENT_OCR_EVERY_N_STEPS`.
- Returns a normalized `Screen` object: `{ elements, screenshot, foregroundApp, modalRegion, ocrBoxes }`.

### 4.9 `server/chat/agent.js` (Executor / legacy single-loop)
- Implements the **perceive → reason → act** loop:
  1. Call `perception` for the current `Screen`.
  2. Build a multimodal prompt (screenshot + accessibility text + goal + history).
  3. Send to the configured LLM provider; expect a JSON action.
  4. Validate and execute the action via `input/`.
  5. Check for completion or loop until `AGENT_MAX_STEPS`.
- Used directly when the user prefixes a goal with `/simple`.
- Used internally by `manager-agent.js` as the per-sub-goal executor.

### 4.10 `server/chat/manager-agent.js` (Planner)
- Wraps the executor with a planning layer:
  1. **Plan** — ask the LLM for a short ordered list of sub-goals based on the current screenshot and the overall goal.
  2. **Execute** — hand each sub-goal to `agent.js`.
  3. **Re-plan** — after each sub-goal, ask the LLM to revise the remaining plan based on the new screen state.
  4. **Terminate** — when the plan is empty or the LLM declares the goal complete.
- All steps stream progress messages (`agent.step`) to the UI.
- All LLM calls use a shared `AbortController` so a single Stop call halts the whole hierarchy.

### 4.11 `server/chat/command-handler.js`
- Parses `/`-prefixed messages and dispatches deterministic actions without invoking an LLM.
- Supported commands:
  - `/open <app>` — `monkey -p <package> ...`
  - `/type <text>` — scrcpy text inject or `input text`
  - `/tap <x> <y> | center` — single tap
  - `/swipe <up|down|left|right>` — directional swipe with sane defaults
  - `/press <home|back|recent|power|volume_up|volume_down>`
  - `/screenshot` — capture and stream back
  - `/help` — list all commands
  - `/simple <goal>` — bypass planner, run flat agent loop
  - `/benchmark <baseline|enhanced|compare|stop>`

### 4.12 `server/chat/benchmark-runner.js`
- Drives a deterministic suite of agent tasks for regression measurement.
- Two suites: **baseline** (vanilla agent settings) and **enhanced** (OCR + modal heuristics enabled).
- Reports per-task pass/fail and side-by-side compare reports.
- Tunable via `BENCHMARK_MAX_STEPS` and `BENCHMARK_STEP_DELAY_MS`.

### 4.13 Client (`client/`)
- **`index.html`** — three-panel layout: device list, mirror canvas, chat/agent panel.
- **`js/app.js`** — top-level controller, WebSocket lifecycle, chat/agent rendering, Stop button wiring.
- **`js/renderers/`** — `PngRenderer`, `H264Renderer` (WebCodecs `VideoDecoder`), `WebRTCRenderer`.
- **`js/input/`** — translates mouse/touch/wheel events into `input.tap`, `input.swipe`, `input.text`, etc.
- **API key UI** — keys entered in the chat panel are stored in `localStorage` and sent to the server per WS session.

---

## 5. Data Flow

### 5.1 Mirroring
```
Device  --(scrcpy server / screencap)-->  Server  --(WS frames)-->  Browser
                                                                      |
                                                                      v
                                                            WebCodecs / canvas
```

### 5.2 Manual Input
```
Browser mouse/touch  -->  WS input.* msg  -->  Server input/  -->  scrcpy ctl / adb shell  -->  Device
```

### 5.3 Agent (Hierarchical)
```
User goal
   |
   v
Manager.plan(goal, screen)  ----------->  LLM
   | sub-goals[]
   v
for each sub-goal:
    Executor.run(sub-goal)
        loop:
            perception.read()  -------->  device (uiautomator + screencap)
            executor.reason()  -------->  LLM
            input.execute(action)  ---->  device
        until done or max steps
    Manager.replan(remaining, screen)  -->  LLM
   |
   v
artifacts/runs/<id>/  (screenshots, actions, metadata)
```

### 5.4 Stop Path
```
User clicks Stop
   |
   v
ws msg "agent.stop"
   |
   v
AbortController.abort()
   |
   +--> in-flight LLM fetch rejects
   +--> next agent step short-circuits
   +--> queued ADB actions discarded
```

---

## 6. Transport Modes

| Mode | Source | Decode | Pros | Cons |
|---|---|---|---|---|
| **H.264** | scrcpy-server NALUs over WS | WebCodecs `VideoDecoder` | Highest fps, lowest bandwidth | Chromium-only |
| **WebRTC** | Server-side encode → DataChannel | Browser native | Works on more browsers | Higher CPU server-side |
| **PNG** | `screencap -p` polled | `<img>` swap | Universally compatible | Lowest fps, highest bandwidth |

Selection is per-session and persisted in `localStorage`.

---

## 7. Configuration Reference

All settings live in `.env`. The agent and stream layers read from `server/config.js`.

### 7.1 Server
```env
PORT=3000
ADB_PATH=/path/to/adb            # optional, auto-detected
```

### 7.2 LLM Providers (priority: Gemini > OpenAI > Anthropic > Ollama)
```env
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash    # default

OPENAI_API_KEY=sk-...
OPENAI_MODEL=gpt-4o              # default

ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-sonnet-4-20250514

OLLAMA_MODEL=qwen2.5vl:72b
OLLAMA_BASE_URL=http://localhost:11434
```

### 7.3 scrcpy Streaming
```env
SCRCPY_MAX_SIZE=1280
SCRCPY_BITRATE=8000000
SCRCPY_MAX_FPS=60
```

### 7.4 Agent Loop
```env
AGENT_MAX_STEPS=20
AGENT_STEP_DELAY_MS=800
```

### 7.5 OCR Fusion (optional)
```env
AGENT_OCR_ENABLE=1
AGENT_OCR_EVERY_N_STEPS=2
AGENT_OCR_MAX_RESULTS=12
GEMINI_OCR_MODEL=gemini-2.5-flash-lite
```

### 7.6 Modal Heuristics
```env
AGENT_MODAL_PANEL_MIN_RATIO=0.45
AGENT_MODAL_TOP_REGION_MAX=0.20
AGENT_MODAL_CENTER_MIN_RATIO=0.08
AGENT_MODAL_DEBUG=1
```

### 7.7 Benchmark Runner
```env
BENCHMARK_MAX_STEPS=12
BENCHMARK_STEP_DELAY_MS=300
```

---

## 8. Artifacts & Replay Format

### 8.1 Run Artifact Layout
```
artifacts/runs/<run-id>/
  meta.json            goal, provider, model, timing, outcome
  steps/
    001.png            screenshot before action
    001.action.json    {type, target, coords, reasoning}
    002.png
    002.action.json
    ...
```

### 8.2 Replay Script
A saved script is a normalized derivative of a run, with target metadata captured for semantic fallback:
```json
{
  "id": "script-...",
  "name": "open settings and toggle wifi",
  "steps": [
    {
      "type": "tap",
      "coords": [540, 1820],
      "target": { "text": "Settings", "id": "...", "class": "ImageView" }
    },
    { "type": "swipe", "from": [...], "to": [...] }
  ]
}
```

### 8.3 Replay Policies
| Policy | Behavior |
|---|---|
| `Strict` | Stop on first failure |
| `Tolerant` | Allow N soft failures (configurable) before stopping |
| `Continue` | Run every step regardless of failures, gather a complete report |

### 8.4 Semantic Fallback
When enabled, on each `tap`/`drag` step:
1. Try to relocate the target by `text` / `id` / `class` against the current accessibility tree.
2. If found within an acceptable distance from the original coordinates, use the relocated point.
3. Otherwise, fall back to the recorded coordinates.

---

## 9. Perception Pipeline Detail

```
+----------------------------+
| 1. uiautomator dump (XML)  |
+-------------+--------------+
              |
              v
+----------------------------+
| 2. parse → element[]       |
+-------------+--------------+
              |
              v
+----------------------------+
| 3. screencap -p (PNG)      |
+-------------+--------------+
              |
              v
+----------------------------+
| 4. dumpsys window          |
|    foreground app          |
+-------------+--------------+
              |
              v
+----------------------------+
| 5. drop elements whose     |
|    package != foreground   |
+-------------+--------------+
              |
              v
+----------------------------+
| 6. modal-region heuristic  |
|    (AGENT_MODAL_*)         |
+-------------+--------------+
              |
              v
+----------------------------+
| 7. (optional) OCR fusion   |
|    every N steps           |
+-------------+--------------+
              |
              v
       Screen object
```

If step 5 leaves zero elements but the foreground app is known, the agent enters **screenshot-only mode** and forwards only the image + foreground app to the LLM.

---

## 10. Known Technical Limitations

| Area | Limitation | Mitigation |
|---|---|---|
| Android 16 capture revocation | OS revokes screen capture every ~5 s | Auto-reconnect; future companion app with `MediaProjection` |
| uiautomator stale data | Returns elements from a previous foreground app | Foreground-app cross-check; screenshot-only fallback |
| Gemini free tier | Hard requests-per-day limit | Auto-retry with backoff |
| WebCodecs availability | Required for H.264 path | Fallback to WebRTC or PNG |
| `input text` injection | Slow and lossy on some devices | Prefer scrcpy text injection when available |

---

## 11. Build & Run

### 11.1 Install
```bash
git clone https://github.com/kenken64/MobiClaw.git
cd MobiClaw
npm install   # postinstall fetches scrcpy-server.jar
```

### 11.2 Run
```bash
npm start         # production
npm run dev       # node --watch
```

### 11.3 Unattended Polling
```bash
node scripts/ask-screen.js
node scripts/ask-screen.js "What app is open?"
node scripts/ask-screen.js --device 192.168.0.239:5555 "Describe the screen"
```

---

## 12. Extension Points

- **New LLM provider** — add a client in `server/chat/` and register it in the provider-priority chain in `agent.js` / `manager-agent.js`.
- **New transport** — add a renderer under `client/js/renderers/` and a corresponding provider under `server/stream/`.
- **New direct command** — add a parser branch in `server/chat/command-handler.js`.
- **New benchmark task** — append to the suite arrays in `server/chat/benchmark-runner.js`.
- **New replay policy** — add a strategy in the playback engine and surface it in the UI policy dropdown.

---

## 13. Open Technical Questions

- Should perception cache the previous accessibility tree to detect "no-op" steps and short-circuit them?
- Is a small on-device helper APK worth the install friction to eliminate the Android 16 revocation window?
- Could replay scripts adopt a structured assertion DSL without forcing test-framework semantics on casual users?
- Should benchmark artifacts ship to a shared dashboard, or stay strictly local?

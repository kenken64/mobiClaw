# MobiClaw — Product Requirements Document

| Field | Value |
|---|---|
| **Document Owner** | MobiClaw Team |
| **Status** | Draft |
| **Version** | 1.0 |
| **Last Updated** | 2026-04-08 |
| **Companion Doc** | [TECHNICAL.md](./TECHNICAL.md) — architecture, modules, configuration |

---

## 1. Overview

### 1.1 Product Summary
MobiClaw is a browser-based platform that mirrors and controls Android devices using ADB, layered with an AI agent that can read the on-screen state and execute natural-language commands. Users can stream a phone's screen, interact via mouse/touch, or hand off complex tasks to a hierarchical Manager+Executor agent powered by their LLM provider of choice.

### 1.2 Vision
Make any Android device fully operable from a web browser — manually for productivity, and autonomously for testing, automation, and accessibility — without installing platform-specific tooling on the user's machine beyond Node.js and ADB.

### 1.3 Problem Statement
Existing Android control tools are either:
- **Manual-only** (scrcpy, Vysor) — fast mirroring but no automation.
- **Automation-only** (Appium, UIAutomator scripts) — require code, brittle selectors, no live UI.
- **Closed/proprietary cloud farms** — costly, network-dependent, no local device support.

Developers, QA engineers, and power users need a single tool that combines **live mirroring**, **direct input**, and **AI-driven task execution** against their own physical devices.

### 1.4 Goals
1. Provide low-latency screen mirroring with multiple transport options (H.264, WebRTC, PNG).
2. Enable click/drag/type interaction from the browser with native input injection.
3. Run an AI agent that perceives the screen and acts autonomously to fulfill natural-language goals.
4. Support multiple LLM providers (Google, OpenAI, Anthropic, Ollama) so users can choose price, latency, or offline.
5. Allow recording, replay, and benchmarking of agent runs for regression testing.

### 1.5 Non-Goals
- Building a closed cloud device farm or hosting devices for users.
- Replacing Appium-style scripted test frameworks with code-defined assertions.
- Supporting iOS or non-Android platforms in v1.
- Running a custom Android app on the device (current scope is ADB-only).

---

## 2. Target Users & Personas

### 2.1 Primary Personas

**P1 — Mobile QA Engineer ("Maya")**
- Tests app flows across multiple Android devices.
- Wants to record a flow once and replay it on every build.
- Cares about reliability, failure reporting, and UI drift tolerance.

**P2 — Android Developer ("Devan")**
- Develops Android apps and needs to demo or debug on a connected device while pair-coding.
- Wants to mirror the device into a screen-share without installing scrcpy on every machine.
- Uses AI agent to script repetitive setup steps ("open my app, log in, navigate to settings").

**P3 — AI/Automation Researcher ("Riya")**
- Experiments with vision-language agents on real-world UI tasks.
- Needs structured perception (accessibility tree + screenshots) and pluggable LLM backends.
- Cares about benchmarking, run artifacts, and reproducibility.

**P4 — Power User / Accessibility User ("Sam")**
- Controls a phone from a desktop browser for ergonomic or accessibility reasons.
- Uses natural language ("open WhatsApp and message Mom") instead of touch.

### 2.2 User Needs Summary
| Persona | Top Needs |
|---|---|
| Maya | Replay scripts, failure tolerance modes, screenshot diffs |
| Devan | Fast mirror, direct commands, multi-device |
| Riya | Provider-agnostic LLM, run artifacts, benchmark suite |
| Sam | Natural language control, reliable execution, stop button |

---

## 3. User Stories

### 3.1 Mirroring & Control
- As a user, I want to select a connected device from a dropdown so I can mirror it.
- As a user, I want to choose between H.264, WebRTC, and PNG so I can balance quality, latency, and compatibility.
- As a user, I want to click and drag on the mirrored screen so I can tap and swipe the phone.
- As a user, I want hardware-button shortcuts (Back, Home, Recent, Volume, Power) in the UI.
- As a user, I want auto-reconnect when streaming drops so I don't lose context.

### 3.2 AI Agent
- As a user, I want to type a goal in natural language and have the agent execute it on the device.
- As a user, I want the agent to plan high-level sub-goals before acting on each step.
- As a user, I want to interrupt the agent at any time and have all in-flight LLM and ADB calls cancelled immediately.
- As a user, I want to switch between hierarchical (default) and single-loop (`/simple`) agent modes.
- As a user, I want to set my LLM API key from the UI and have it persisted in localStorage.

### 3.3 Direct Commands
- As a user, I want `/`-prefixed commands (`/open`, `/tap`, `/swipe`, `/type`, `/press`, `/screenshot`) for instant deterministic actions without paying LLM cost.
- As a user, I want a `/help` command that lists every supported direct command.

### 3.4 Recording & Playback
- As a user, I want to record the mirrored screen in-browser and download a `.webm` file.
- As a user, I want every agent run automatically saved to `artifacts/runs/`.
- As a user, I want to promote a recorded run into a saved replay script.
- As a user, I want to replay a script with `Strict`, `Tolerant`, or `Continue` failure policies.
- As a user, I want semantic fallback so replays survive moderate UI drift.
- As a user, I want a side-by-side diff of expected vs live screenshots after replay.

### 3.5 Benchmarking
- As a researcher, I want to run a deterministic baseline benchmark suite to measure agent quality.
- As a researcher, I want to compare baseline vs enhanced agent runs side by side.
- As a researcher, I want to stop a benchmark mid-run.

---

## 4. Functional Requirements

### 4.1 Device Connectivity
| ID | Requirement |
|---|---|
| FR-1.1 | Auto-detect ADB binary from `PATH`; allow override via `ADB_PATH`. |
| FR-1.2 | List all currently connected ADB devices in the UI. |
| FR-1.3 | Support wireless ADB pair + connect from the UI. |
| FR-1.4 | Display device model, Android version, and resolution after selection. |

### 4.2 Screen Mirroring
| ID | Requirement |
|---|---|
| FR-2.1 | Provide three transport modes: H.264 (scrcpy server), WebRTC DataChannel, PNG (screencap polling). |
| FR-2.2 | H.264 mode must support up to 60 fps and configurable bitrate/max-size via env vars. |
| FR-2.3 | Stream must auto-reconnect on disconnect or Android screen-capture revocation. |
| FR-2.4 | Frame rendering must use WebCodecs where available, with a software fallback. |

### 4.3 Input Injection
| ID | Requirement |
|---|---|
| FR-3.1 | Translate browser mouse/touch events into device taps, swipes, and drags. |
| FR-3.2 | Prefer scrcpy control-channel injection when available; fall back to `adb shell input`. |
| FR-3.3 | Expose hardware-key buttons for Back, Home, Recent, Volume Up/Down, Power. |
| FR-3.4 | Support keyboard text input forwarded to the device. |

### 4.4 AI Agent (Hierarchical Mode — Default)
| ID | Requirement |
|---|---|
| FR-4.1 | A **Manager** layer must produce a short ordered list of sub-goals from the current screenshot and overall task. |
| FR-4.2 | An **Executor** layer must run a perceive → reason → act loop for each sub-goal. |
| FR-4.3 | The Manager must re-plan after each sub-goal completes or fails. |
| FR-4.4 | The agent must respect `AGENT_MAX_STEPS` and `AGENT_STEP_DELAY_MS` settings. |
| FR-4.5 | The agent must stream step-by-step progress to the UI over WebSocket. |

### 4.5 AI Agent (Single-Loop Mode)
| ID | Requirement |
|---|---|
| FR-5.1 | `/simple <goal>` must run the legacy flat perceive→reason→act loop instead of the planner. |
| FR-5.2 | All other agent guarantees (stop, streaming, max steps) must apply identically. |

### 4.6 Perception
| ID | Requirement |
|---|---|
| FR-6.1 | Perception must dump the accessibility tree via uiautomator and capture a screenshot per step. |
| FR-6.2 | Perception must detect the foreground app and discard stale accessibility elements that don't match it. |
| FR-6.3 | When accessibility data is stale, the agent must fall back to screenshot-only mode. |
| FR-6.4 | Optional OCR fusion (`AGENT_OCR_ENABLE`) must augment perception with OCR-detected boxes at a configurable cadence. |
| FR-6.5 | Modal/overlay heuristics must be tunable via env vars (`AGENT_MODAL_*`). |

### 4.7 LLM Providers
| ID | Requirement |
|---|---|
| FR-7.1 | Support Google Gemini, OpenAI, Anthropic, and Ollama backends. |
| FR-7.2 | Provider selection priority: Gemini > OpenAI > Anthropic > Ollama, based on which keys/models are configured. |
| FR-7.3 | Allow API keys to be set from the browser UI and persisted to localStorage. |
| FR-7.4 | Handle provider rate limits with auto-retry and surface errors to the UI. |

### 4.8 Direct Commands
| ID | Requirement |
|---|---|
| FR-8.1 | Parse `/`-prefixed messages as direct commands and bypass the LLM. |
| FR-8.2 | Support `/open`, `/type`, `/tap`, `/swipe`, `/press`, `/screenshot`, `/help`, `/simple`, `/benchmark *`. |
| FR-8.3 | `/tap center` must compute the device center automatically. |

### 4.9 Recording & Playback Lab
| ID | Requirement |
|---|---|
| FR-9.1 | In-browser recording of mirrored video with download as `.webm`. |
| FR-9.2 | Automatically persist agent runs under `artifacts/runs/` with screenshots, actions, and metadata. |
| FR-9.3 | Promote a recorded run into a saved replay script. |
| FR-9.4 | Replay scripts against the currently selected device with three policies: `Strict`, `Tolerant`, `Continue`. |
| FR-9.5 | Allow configuring retry count and hard/soft failure limits per replay. |
| FR-9.6 | Semantic fallback must relocate tap/drag targets by recorded text/id/type before falling back to coordinates. |
| FR-9.7 | Replay-result viewer must display expected vs live before/after screenshots per step. |

### 4.10 Benchmark Runner
| ID | Requirement |
|---|---|
| FR-10.1 | `/benchmark baseline` runs the deterministic baseline suite. |
| FR-10.2 | `/benchmark enhanced` runs the enhanced suite. |
| FR-10.3 | `/benchmark compare` runs both and reports a diff. |
| FR-10.4 | `/benchmark stop` cancels an in-flight benchmark immediately. |
| FR-10.5 | Step delay and max steps are tunable via `BENCHMARK_*` env vars. |

### 4.11 Stop & Cancellation
| ID | Requirement |
|---|---|
| FR-11.1 | A persistent **Stop** button must abort in-flight LLM requests via `AbortController`. |
| FR-11.2 | Pending ADB actions must be discarded; no further steps may execute after Stop. |
| FR-11.3 | Stop must work in both hierarchical and single-loop modes, and during benchmark and replay. |

---

## 5. Non-Functional Requirements

### 5.1 Performance
- Mirror end-to-end latency in H.264 mode under 200 ms on a local network.
- Agent step cadence configurable; default 800 ms between steps.
- Cold start of the server under 3 seconds (excluding scrcpy server download).

### 5.2 Reliability
- Stream auto-recovery on Android 16's 5-second screen-capture revocation.
- Stale accessibility data must never cause the agent to act on incorrect coordinates without verification.
- Stop must reliably halt the loop within one in-flight LLM request worst case.

### 5.3 Compatibility
- Server: Node.js v18+, macOS / Linux / Windows.
- Browser: Chromium-based (Chrome, Edge); requires WebCodecs for H.264 mode.
- Devices: Android with USB Debugging; tested up to Android 16.

### 5.4 Security & Privacy
- API keys stored in `.env` server-side or `localStorage` client-side only — never sent to MobiClaw-controlled servers.
- ADB connections are local-network or USB; no cloud relay.
- Recorded artifacts are stored locally under `artifacts/`.

### 5.5 Usability
- Three-panel UI: device list, mirror canvas, chat/agent panel.
- Tailwind + Lucide icons, shadcn-inspired dark theme.
- Direct commands discoverable via `/help`.

### 5.6 Observability
- Server console logs WebSocket traffic, ADB calls, agent steps, and modal heuristic metrics (when `AGENT_MODAL_DEBUG=1`).
- Agent run artifacts include screenshots, actions, and timing for offline analysis.

---

## 6. Architecture & Tech Stack

Architecture, module breakdown, data flow, transport modes, configuration reference, and the perception pipeline are documented separately in [TECHNICAL.md](./TECHNICAL.md).

---

## 7. Success Metrics

| Metric | Target |
|---|---|
| Agent task completion rate (baseline benchmark) | ≥ 70% |
| Agent task completion rate (enhanced benchmark) | ≥ 85% |
| H.264 mirror latency (LAN) | < 200 ms |
| Stop-to-halt latency | < 1 in-flight LLM request |
| Replay re-run success on unchanged UI | ≥ 95% |
| Replay survival rate under moderate UI drift (semantic fallback ON) | ≥ 70% |

---

## 8. Constraints & Known Limitations

- **Android 16** revokes screen capture every ~5 seconds; auto-reconnect masks but does not eliminate the gap. A companion app with `MediaProjection` permission would fully resolve this — out of scope for v1.
- **uiautomator** can return stale data on Android 16; mitigated by foreground-app cross-check and screenshot fallback.
- **Gemini free tier** rate limits cap throughput; the agent retries with backoff.
- **WebCodecs** is required for H.264 rendering; non-Chromium browsers fall back to PNG/WebRTC.

---

## 9. Out of Scope (v1)

- iOS or other non-Android platforms.
- Cloud-hosted device farms.
- A native Android companion app.
- Multi-user collaboration on a single device session.
- Built-in test-assertion DSL (replay is currently behavioral, not assertion-based).

---

## 10. Future Considerations

- Companion Android app using `MediaProjection` to remove the 5-second revocation gap.
- Multi-device parallel agent execution.
- Assertion DSL on top of the replay engine for true regression testing.
- Cloud-optional artifact sync.
- Browser-based device discovery over mDNS/Bonjour.
- Voice input for natural-language goals.
- iOS support via WebDriverAgent.

---

## 11. Glossary

| Term | Definition |
|---|---|
| **ADB** | Android Debug Bridge — CLI/protocol for talking to Android devices. |
| **scrcpy** | Open-source Android screen mirroring/control server. |
| **uiautomator** | Android tool that dumps the on-screen accessibility tree. |
| **Manager / Executor** | The two layers of MobiClaw's hierarchical agent: planner vs step-runner. |
| **Perception** | Combined accessibility tree + screenshot view of the current screen. |
| **Replay policy** | `Strict` / `Tolerant` / `Continue` — how the replay engine reacts to step failures. |
| **Semantic fallback** | Re-locating a replay target by element text/id/type before using stored coordinates. |

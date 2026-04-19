# ChainMail Spectacles v2 -- Architecture Spec

## Overview

Three-tier system: Spectacles (lite frontend) -> Phone (Cactus middleware) -> VM (heavy compute + memory).

Spectacles captures voice and vision. Phone handles local triage and ASR. VM runs heavy inference, Token Factory, and Bubble Memory.

---

## Modes

### 1. Passive (default)
- Clean AR view. No HUD clutter.
- ASR idle -- listening for wake words only.
- Camera off. No recording.

### 2. Record (left button press)
- Camera activates. Qwen VL sees what YOU see -- the real world through the Spectacles camera. A laptop screen, a person, a whiteboard, a building, anything.
- Frames captured every 2-3 seconds.
- Each frame: Qwen VL describes/extracts what it sees -> Gemma 4 interprets context -> writes marble to Bubble Memory via MAG.
- Voice recording also active -- captures ALL conversations (with people, with AIs, in meetings). Every spoken word transcribed and saved.
- Video recording active -- continuous capture of what you see.
- Minimal HUD indicator: small green dot in corner = recording.
- Left button again = stop recording.

### 3. Voice Agent (wake word)
- "Hey CTO" / "Hey CPO" / etc. -> activates that specific C-Suite role.
- Agent responds via text on HUD + optional TTS audio.
- Agent orb appears, pulses while processing, fades after response.
- Response also written to Bubble Memory.

### 4. Boardroom (wake phrase)
- "Hey Boardroom" or "Call the board" -> activates all C-Suite roles.
- Multi-model deliberation via MMCP governance.
- All orbs appear. UNI consensus synthesis.

### 5. Qwen/Gemma Direct
- "Hey Qwen" -> just the Eyes (describe what I see).
- "Hey Gemma" -> just the Ears/reasoning (interpret, analyze).
- No governance overhead. Direct model access.

---

## System Components

### Spectacles (Lens Studio via Snap CLI -- ultra-lite edge client)

Spectacles is a dumb terminal. Capture + send + display. Zero processing.

Scripts (maximum 3-4, minimal logic):
- `Edge.js` -- Entry point. Button listener (left = record toggle). Sends events to backend. Receives display commands. That's it.
- `Capture.js` -- ASR Module for voice (required on-device by Snap). Camera frame grab. Sends raw data out.
- `Display.js` -- Renders text on HUD. Shows/hides recording dot. Plays audio. Pure display slave -- does what backend tells it.
- `Intro.js` -- On launch: floating "ChainMail" text appears, holds briefly, disappears. That's it. No logo, no animation, just text.

All intelligence lives on the backend. Spectacles does NOT:
- Parse wake words (backend does this)
- Route commands (backend does this)
- Decide what model to call (backend does this)
- Manage conversation state (backend does this)

Spectacles ONLY:
- Captures mic audio (ASR transcription string)
- Captures camera frames (JPEG bytes)
- Captures button presses
- Sends all of the above to backend via HTTPS (or BLE to phone)
- Displays text/status that backend sends back
- Plays audio that backend sends back

Inputs:
- Left button = record toggle
- Voice = ASR transcription (Snap ASR Module, on-device by Snap requirement)
- Camera = frame capture (only in record mode)

Outputs:
- HUD text overlay (whatever backend says to show)
- Green dot (recording indicator)
- Audio playback (TTS from backend)

### Phone (Cactus SDK -- middleware)

When online: phone is a relay. Everything goes to VM.
When offline: Cactus activates and handles what it can locally.

#### Cactus Full Capability Stack (offline mode):
- **LLM Inference**: Gemma 4 on-device (Gemma-3-1b-it or Qwen3-0.6B, ~400-640MB)
  - Text generation, reasoning, triage
  - Tool calling support (MCP-compatible)
  - Auto RAG for local document context
- **Voice Transcription**: Cactus Hybrid Transcription
  - Whisper-Small on-device, NPU-accelerated
  - Sub-150ms latency, <6% WER
  - Voice Activity Detection (Silero VAD) -- detects when someone is speaking
  - Streaming transcription (real-time, not batch)
  - When online: cloud correction for noisy audio (hybrid)
  - When offline: pure on-device, still functional
- **Voice Synthesis**: Coming soon in Cactus SDK (use VM TTS for now)
- **Vision**: LFM2.5-VL-1.6B on-device
  - Can describe what camera sees locally when offline
  - Backup to VM Qwen VL when online
- **Embeddings**: On-device embedding generation for local semantic search
- **Audio Embeddings**: cactusAudioEmbed for audio similarity
- **Image Embeddings**: cactusImageEmbed for visual similarity
- **Smart Routing**: Cactus monitors model confidence in real-time
  - High confidence -> on-device response
  - Low confidence -> escalate to cloud (VM)
  - Automatic handoff, app doesn't need to know
- **Privacy Lock**: Can force on-device only for sensitive conversations
  - HIPAA-friendly, GDPR-compliant, zero data retention mode
- **Model Updates**: OTA model versioning without app updates

#### SDK: Kotlin (Android) or Swift (iOS) -- native Cactus bindings
#### Spectacles Bridge: Mobile Kit BLE (SpectaclesMobileKitModule)

Message envelope (BLE):
```json
{
  "v": 1,
  "id": "uuid",
  "type": "voice|frame|command",
  "route": "vm|on_device",
  "payload": {},
  "meta": {"timestamp": 0, "mode": "record|voice|boardroom", "online": true}
}
```

#### Performance (on-device, offline):
- iPhone 16 Pro: 54 tok/s (Gemma3 1B), 18 tok/s (Qwen3 4B)
- Samsung Galaxy S24 Ultra: 42 tok/s (Gemma3 1B)
- Transcription: sub-150ms, <6% WER
- Model footprint: 400MB-1.2GB depending on model choice

### VM (Nebius H100 -- heavy compute)
Containers:
- `vllm-vision` (port 8001) -- Qwen VL 7B -> screen reading, OCR, visual understanding
- `vllm-reasoning` (port 8000) -- Gemma 4 31B (replacing Mistral) -> interpretation, reasoning, training
- `mmcp` (port 5000) -- MMCP runtime, C-Suite MMAL, governance
- Token Factory -- Nemotron, DeepSeek via NVIDIA NIM for heavy tasks

Endpoints (Supabase edge functions):
- `POST /functions/v1/code-router` -- existing, routes to vLLM models
- `POST /functions/v1/screen-read` -- NEW: receives frame, returns extracted text + interpretation
- `POST /functions/v1/memory-write` -- NEW: writes marble to Bubble Memory
- `POST /functions/v1/boardroom` -- NEW: triggers full C-Suite deliberation

### Bubble Memory (Supabase + pgvector)
- Every recorded conversation -> marble
- Every screen reading -> marble
- Every agent response -> marble
- MAG (Memory Associative Graph) connects everything via semantic search
- Any agent can query MAG before responding

---

## Data Flow: Screen Reading Mode

```
1. User presses left button on Spectacles
2. Camera activates, HUD shows green recording dot
3. Every 2-3 seconds, Spectacles captures frame
4. Frame -> Phone (BLE) -> Phone checks if simple (Gemma on-device) or complex
5. Complex frames (text-heavy screens) -> VM via HTTPS
6. VM: Qwen VL extracts text from frame
7. VM: Gemma 4 interprets context (what app, what conversation, key insights)
8. VM: Writes marble to Bubble Memory with metadata (source, timestamp, tags)
9. Spectacles HUD: brief confirmation flash (optional)
10. User presses left button again -> camera off, recording stops
```

## Data Flow: Voice Command

```
1. ASR running (Snap ASR Module on Spectacles, Cactus Whisper on phone)
2. User says "Hey CTO, what should our pricing strategy be?"
3. ASR transcribes -> VoiceRouter detects "hey cto" wake word
4. Command routed to AgentBridge -> POST to Supabase edge function
5. Edge function routes to Token Factory (Claude for CTO role)
6. Response comes back with text + optional TTS audio
7. HUD displays response, CTO orb pulses
8. Response written to Bubble Memory
9. State resets to passive
```

## Data Flow: Boardroom

```
1. User says "Hey Boardroom, should we pivot to enterprise?"
2. Wake phrase detected -> all agents activated
3. Request -> MMCP governance layer
4. C-Suite MMAL: Claude (CTO), Perplexity (CPO), Gemini (CMO), OpenAI (COO) deliberate
5. UNUM consensus synthesis
6. Response displayed on HUD
7. All deliberation written to Bubble Memory
8. State resets
```

---

## Model Stack

| Role | Model | Location | Port |
|------|-------|----------|------|
| Eyes (Vision) | Qwen VL 7B | VM vLLM | 8001 |
| Ears/Reasoning | Gemma 4 31B | VM vLLM | 8000 |
| Phone triage | Gemma 4 (small) | Phone Cactus | local |
| Phone ASR | Whisper | Phone Cactus | local |
| CTO | Claude | Token Factory API | - |
| CPO | Perplexity | Token Factory API | - |
| CMO | Gemini | Token Factory API | - |
| COO | OpenAI | Token Factory API | - |
| CRO | DeepSeek R1 | Token Factory API | - |
| Heavy coding | Nemotron/DeepSeek | Token Factory NIM | - |

---

## UI/HUD Design

Minimal. Clean. Nothing visible in passive mode.

### Recording mode:
- Small green dot, top-right corner
- No other overlay

### Voice response:
- Default: audio response (agent speaks back via TTS)
- Say "quiet" or "text only": switches to HUD text only, no audio
- Say "both": audio AND text on HUD
- Agent name in small mono text, top-left
- Response text, center, max 3 lines, fades after 8 seconds
- NO orbs. Clean view always.

### Boardroom:
- No visual orbs. Agents respond by voice or text based on current mode.
- Agent name label shows who is speaking.
- Consensus response displayed as final text.

### Font:
- Mono (JetBrains Mono or system) for agent labels
- Clean sans-serif for response text
- All white text with subtle drop shadow for readability on any background

---

## Button Mapping

| Button | Action |
|--------|--------|
| Left (top) | Toggle record mode |
| Voice | Wake words detected by backend |
| Pinch | Dismiss HUD text |

---

## Auth

- Supabase JWT anon key for edge function auth
- MMCP token for governance endpoints
- Stored in script @input fields (Inspector), not hardcoded

---

## File Structure (Lens Studio project)

```
ChainMail-v2/
  Assets/
    Main.js
    ASRController.js
    ScreenReader.js
    AgentBridge.js
    HUD.js
    IntroAnimation.js
  Scenes/
    Main.scene
```

6 scripts. Clean separation. No duplicates. No legacy.

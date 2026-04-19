# Snap AI Build Spec -- ChainMail v2

Build a new Spectacles Lens from scratch using Snap CLI. Ultra-lite edge client.
Spectacles is a dumb terminal. Capture + send + display. Zero intelligence on device.

## Project Setup
- New project via Snap CLI for Spectacles (2024)
- Target: Lens Studio 5.15+ / Spectacles OS 5.61+
- Permissions needed: Microphone - SnapML, Speech to Text, Camera

## Scripts (4 total, minimal logic)

### 1. Edge.js -- Entry point and event coordinator

```
Responsibilities:
- Listen for left button press (toggle record mode)
- Coordinate between Capture.js and Display.js
- Send all events to backend via HTTPS POST
- Receive responses and pass to Display.js

State:
- recording: boolean (toggled by left button)
- responseMode: "audio" | "text" | "both" (default: "audio")
- sessionId: generated once on start

Backend endpoint:
- POST https://emyiiapbjrijawaejcxd.supabase.co/functions/v1/spectacles-gateway
- Headers: Content-Type: application/json, Authorization: Bearer <jwt>
- JWT stored in @input string authToken

On button press (left):
  recording = !recording
  POST to backend: {type: "button", session_id, payload: {button: "left", action: "press"}, mode: recording ? "record" : "passive"}
  Pass response to Display.js (show/hide green dot)

On voice transcription (from Capture.js):
  POST to backend: {type: "voice", session_id, payload: {text: transcribedText, is_final: isFinal}, mode: current_mode, response_mode: responseMode}
  Pass response to Display.js (show text, play audio)

On camera frame (from Capture.js, only when recording):
  POST to backend: {type: "frame", session_id, payload: {image_base64: frameData}, mode: "record"}
  // No display update needed for frames

Use RemoteServiceHttpRequest for all HTTP calls.
Use InternetModule if available (LS 5.9+), fallback to RemoteServiceHttpRequest.
```

### 2. Capture.js -- Sensor input (mic + camera)

```
Responsibilities:
- ASR Module for voice transcription (always on)
- Camera frame capture (only when recording)

ASR:
- require("LensStudio:AsrModule")
- AsrTranscriptionOptions with HighAccuracy mode
- silenceUntilTerminationMs = 1500
- On transcription update: call Edge.js with {text, isFinal}
- On error: auto-retry with exponential backoff (max 3 retries)
- ASR runs continuously. Does NOT parse wake words (backend does that).
- Just sends every transcription to Edge.js which sends to backend.

Camera:
- Exposed via public function: captureFrame()
- Called by Edge.js on a timer (every 3 seconds) when recording=true
- Captures current camera texture
- Returns base64 JPEG string
- If base64 encoding not available, use Texture API to get pixel data

@inputs:
- Component.Camera spectaclesCamera
```

### 3. Display.js -- HUD renderer

```
Responsibilities:
- Show/hide agent response text
- Show/hide recording indicator (green dot)
- Play audio responses
- Pure display slave -- only does what it's told

Public functions:
- showText(agentName, text) -- shows agent name label + response text, auto-fades after 8 seconds
- hideText() -- immediately clear HUD
- showRecording(active) -- show/hide green dot top-right
- playAudio(base64Audio) -- decode and play TTS audio

@inputs:
- Component.Text responseText
- Component.Text agentLabel
- Component.Image recordingDot
- Component.AudioComponent audioOut

Text styling:
- Response text: white, center, max 3 lines
- Agent label: small mono, top-left, muted color
- Recording dot: small green circle, top-right corner
- All text has subtle drop shadow for readability on any background
- Text fades out after 8 seconds via alpha animation
```

### 4. Intro.js -- Startup text

```
On launch:
- Show "ChainMail" as floating white text, centered
- Hold for 2 seconds
- Fade out over 0.5 seconds
- Disable the intro SceneObject
- Done. Never runs again.

@inputs:
- Component.Text chainmailText
- SceneObject introObject
```

## Scene Structure

```
Scene
  [Intro]
    IntroText (Text: "ChainMail") -- Intro.js attached here
  [HUD]
    AgentLabel (Text: "") -- top-left, small mono
    ResponseText (Text: "") -- center, white, max 3 lines
    RecordingDot (Image: green circle) -- top-right, small, hidden by default
  [Audio]
    AudioOut (AudioComponent)
  [Camera]
    SpectaclesCamera (Camera component)
  [Scripts]
    Edge.js (ScriptComponent) -- inputs: authToken string
    Capture.js (ScriptComponent) -- inputs: spectaclesCamera
    Display.js (ScriptComponent) -- inputs: responseText, agentLabel, recordingDot, audioOut
    Intro.js (ScriptComponent) -- inputs: chainmailText, introObject
```

## Critical Rules
- NO unicode characters in any script (no em-dashes, arrows, smart quotes). ASCII only.
- NO complex logic on Spectacles. Send raw data to backend, display what comes back.
- ASR transcriptions go straight to backend. Backend decides if it's a wake word, command, or noise.
- Camera frames go straight to backend. Backend does OCR/vision.
- All @input references must be wired in Inspector after script creation.
- Use RemoteServiceHttpRequest for HTTP (proven to work on Spectacles).
- All strings use regular quotes, not template literals.
- var declarations (ES5 safe), though const/let work on LS 5.15.

## Auth
- @input string authToken on Edge.js
- Set in Inspector to the Supabase JWT anon key
- Passed as Authorization: Bearer header on every request

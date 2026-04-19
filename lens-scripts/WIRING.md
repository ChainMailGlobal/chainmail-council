# ChainMail v2 -- Lens Studio Inspector Wiring Guide

## Scene Hierarchy

Build this object tree in Lens Studio:

```
Scene
  [Intro]
    IntroText          -- Text component, centered, white, large font
  [HUD]
    AgentLabel         -- Text component, top-left, small mono font, muted white
    ResponseText       -- Text component, center, white, max 3 lines
    RecordingDot       -- SceneObject with Image (green circle), top-right, small, disabled by default
  [Audio]
    AudioOut           -- SceneObject with AudioComponent
  [Camera]
    SpectaclesCamera   -- Camera component (Spectacles camera feed)
  [Scripts]
    EdgeScript         -- SceneObject with ScriptComponent (Edge.js)
    CaptureScript      -- SceneObject with ScriptComponent (Capture.js)
    DisplayScript      -- SceneObject with ScriptComponent (Display.js)
    IntroScript        -- SceneObject with ScriptComponent (Intro.js)
```

---

## Script Input Wiring

### Edge.js (on EdgeScript)

| Input         | Type                     | Wire To                              | Notes                                |
|---------------|--------------------------|--------------------------------------|--------------------------------------|
| capture       | Component.ScriptComponent | CaptureScript's ScriptComponent     | Drag CaptureScript here              |
| display       | Component.ScriptComponent | DisplayScript's ScriptComponent     | Drag DisplayScript here              |
| authToken     | string                   | (paste Supabase JWT anon key)        | Set in Inspector, not in code        |
| gatewayUrl    | string                   | Pre-filled with default URL          | Change only if gateway URL changes   |

### Capture.js (on CaptureScript)

| Input            | Type              | Wire To                  | Notes                        |
|------------------|-------------------|--------------------------|------------------------------|
| spectaclesCamera | Component.Camera  | SpectaclesCamera's Camera | Drag the Camera component    |
| asrModule        | Asset.AsrModule   | AsrModule asset           | Add ASR Module asset, drag here |

### Display.js (on DisplayScript)

| Input         | Type                    | Wire To                           | Notes                          |
|---------------|-------------------------|-----------------------------------|--------------------------------|
| responseText  | Component.Text          | ResponseText's Text component     | Center text, white, 3 lines    |
| agentLabel    | Component.Text          | AgentLabel's Text component       | Top-left, small mono           |
| recordingDot  | SceneObject             | RecordingDot SceneObject          | The whole object, not a component |
| audioOut      | Component.AudioComponent | AudioOut's AudioComponent        | For TTS playback               |

### Intro.js (on IntroScript)

| Input          | Type             | Wire To                        | Notes                         |
|----------------|------------------|--------------------------------|-------------------------------|
| chainmailText  | Component.Text   | IntroText's Text component     | Will be set to "ChainMail"    |
| introObject    | SceneObject      | [Intro] SceneObject            | Disabled after fade completes |

---

## Permissions Required

In Project Settings > Permissions, enable:
- **Microphone** -- for ASR
- **Speech to Text** -- for ASR Module
- **Camera** -- for frame capture
- **Internet** -- for HTTPS requests to Supabase gateway

---

## Script Execution Order

Lens Studio runs scripts in scene hierarchy order. Recommended order:

1. **Intro.js** -- runs first, shows splash, disables itself
2. **Capture.js** -- starts ASR immediately
3. **Display.js** -- initializes HUD (everything hidden)
4. **Edge.js** -- wires callbacks to Capture.js and Display.js on start

Edge.js must run AFTER Capture.js and Display.js so their `script.api` objects
are available when Edge.js tries to wire callbacks.

To control order: arrange SceneObjects in the hierarchy so IntroScript is first
and EdgeScript is last under [Scripts].

---

## Button Trigger

Edge.js exposes `script.api.toggleRecording()` for the left button.

Current status: no direct hardware button binding in the script (Spectacles
button APIs vary by SDK version). Options:

1. **Spectacles Interaction Kit (SIK)**: If available, add a SIK Button
   component and call `EdgeScript.api.toggleRecording()` on press.
2. **BehaviorScript**: Add a Behavior component that calls
   `EdgeScript.api.toggleRecording()` on a trigger event.
3. **Inspector toggle**: For testing, manually trigger from Inspector.

---

## Text Styling Notes

- **ResponseText**: white fill, center alignment, word wrap, max 3 lines.
  Use a sans-serif font. Add a subtle drop shadow via Lens Studio text
  shadow settings (offset 1px, black at 60% opacity).
- **AgentLabel**: white fill at ~70% opacity, top-left alignment, mono font
  (JetBrains Mono or system mono). Smaller font size than ResponseText.
- **RecordingDot**: small green circle image (12x12 or 16x16 px), anchored
  top-right with padding. Start with `enabled = false`.

---

## Testing Checklist

- [ ] Auth token pasted into Edge.js authToken input
- [ ] All 4 scripts attached to their SceneObjects
- [ ] All @input references wired (no yellow warnings in Inspector)
- [ ] Permissions enabled in Project Settings
- [ ] Preview in Lens Studio -- "ChainMail" text appears and fades
- [ ] Check print output for "[Edge] Session: ..." and "[Capture] ASR started"
- [ ] Push to Spectacles device for real ASR + camera testing

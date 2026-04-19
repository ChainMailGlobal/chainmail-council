/**
 * spectacles-gateway – Single entry point for ALL Spectacles requests.
 *
 * POST /functions/v1/spectacles-gateway
 *
 * Receives typed events (voice, frame, button, command), routes to the
 * appropriate handler, and returns a standardised display response.
 *
 * All intelligence lives here. The Spectacles are a dumb terminal.
 */

import {
  handleCors,
  jsonResponse,
  errorResponse,
} from "../_shared/cors.ts";
import {
  callReasoning,
  callVision,
  callTokenFactory,
  visionMessage,
  type ChatMessage,
} from "../_shared/vm.ts";
import { writeBubbleMemory } from "../_shared/vm.ts";
import { getSession, updateSession } from "../_shared/supabase.ts";
import { conveneCouncil } from "../_shared/council.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface GatewayRequest {
  type: "voice" | "frame" | "button" | "command";
  session_id: string;
  payload: {
    text?: string;
    is_final?: boolean;
    image_base64?: string;
    button?: string;
    action?: string;
  };
  mode?: string;
  response_mode?: string;
}

interface GatewayResponse {
  display: {
    text: string | null;
    agent: string | null;
    recording: boolean;
  };
  audio_base64: string | null;
  memory_written: boolean;
}

// ---------------------------------------------------------------------------
// Wake-word detection
// ---------------------------------------------------------------------------

type AgentName =
  | "cto"
  | "cpo"
  | "cmo"
  | "coo"
  | "cro"
  | "cfo"
  | "boardroom"
  | "qwen"
  | "gemma";

const WAKE_WORDS: Record<string, AgentName> = {
  "hey cto": "cto",
  "hey cpo": "cpo",
  "hey cmo": "cmo",
  "hey coo": "coo",
  "hey cro": "cro",
  "hey cfo": "cfo",
  "hey boardroom": "boardroom",
  "call the board": "boardroom",
  "hey qwen": "qwen",
  "hey gemma": "gemma",
};

/** Response-mode control phrases. */
const RESPONSE_MODE_PHRASES: Record<string, string> = {
  quiet: "text",
  "text only": "text",
  both: "both",
};

/**
 * Check if the text starts with (or is) a wake word.
 * Returns { agent, remainder } where remainder is the text after the wake word.
 * If the text IS just the wake word with no follow-up, remainder is empty.
 */
function detectWakeWord(
  text: string,
): { agent: AgentName; remainder: string } | null {
  const lower = text.toLowerCase().trim();

  for (const [phrase, agent] of Object.entries(WAKE_WORDS)) {
    if (lower.startsWith(phrase)) {
      const rest = text.slice(phrase.length).replace(/^[,.\s]+/, "").trim();
      return { agent, remainder: rest };
    }
  }
  return null;
}

function detectResponseMode(text: string): string | null {
  const lower = text.toLowerCase().trim();
  for (const [phrase, mode] of Object.entries(RESPONSE_MODE_PHRASES)) {
    if (lower === phrase || lower.startsWith(phrase + " ")) {
      return mode;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response builder
// ---------------------------------------------------------------------------

interface ResponseOverrides {
  display?: {
    text?: string | null;
    agent?: string | null;
    recording?: boolean;
  };
  audio_base64?: string | null;
  memory_written?: boolean;
}

function buildResponse(overrides: ResponseOverrides = {}): GatewayResponse {
  return {
    display: {
      text: overrides.display?.text ?? null,
      agent: overrides.display?.agent ?? null,
      recording: overrides.display?.recording ?? false,
    },
    audio_base64: overrides.audio_base64 ?? null,
    memory_written: overrides.memory_written ?? false,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Handle voice events: wake-word detection + command routing.
 */
async function handleVoice(
  req: GatewayRequest,
): Promise<GatewayResponse> {
  const text = req.payload.text ?? "";
  if (!text.trim()) {
    return buildResponse();
  }

  const session = await getSession(req.session_id);

  // --- Check for response-mode commands --------------------------------
  const modeSwitch = detectResponseMode(text);
  if (modeSwitch) {
    await updateSession(req.session_id, { response_mode: modeSwitch });
    return buildResponse({
      display: {
        text: `Response mode: ${modeSwitch}`,
        agent: null,
        recording: session.mode === "record",
      },
    });
  }

  // --- Check for wake word in this utterance ----------------------------
  const wakeResult = detectWakeWord(text);

  if (wakeResult) {
    // Wake word found. Two cases:
    // 1) "Hey CTO, what should we do?" – wake + command in one utterance
    // 2) "Hey CTO" (just the wake word) – store agent, wait for next event

    if (wakeResult.remainder) {
      // Case 1: immediate command
      return await routeToAgent(
        wakeResult.agent,
        wakeResult.remainder,
        req.session_id,
        session.mode === "record",
        req.response_mode ?? session.response_mode,
      );
    }

    // Case 2: just the wake word – store and wait
    await updateSession(req.session_id, { wake_agent: wakeResult.agent });
    return buildResponse({
      display: {
        text: `Listening... (${wakeResult.agent.toUpperCase()})`,
        agent: wakeResult.agent,
        recording: session.mode === "record",
      },
    });
  }

  // --- No wake word: check if we have a pending agent from previous wake --
  if (session.wake_agent) {
    const agent = session.wake_agent as AgentName;
    // Clear the wake state before routing (prevent stale state on timeout)
    await updateSession(req.session_id, { wake_agent: null });
    return await routeToAgent(
      agent,
      text,
      req.session_id,
      session.mode === "record",
      req.response_mode ?? session.response_mode,
    );
  }

  // No wake word, no pending agent – ignore (passive listening)
  return buildResponse({
    display: { recording: session.mode === "record" },
  });
}

/**
 * Route a command to the correct agent / model and return a response.
 */
async function routeToAgent(
  agent: AgentName,
  command: string,
  sessionId: string,
  isRecording: boolean,
  responseMode: string,
): Promise<GatewayResponse> {
  let responseText: string;

  try {
    switch (agent) {
      case "boardroom": {
        const council = await conveneCouncil(command, sessionId);
        const con     = council.consensus;
        responseText  =
          `[COUNCIL ${con.decision.toUpperCase()}] ${con.summary}` +
          (con.conditions ? ` — ${con.conditions}` : "") +
          ` (${council.agents_selected.join(", ")} · audit:${council.audit_id.slice(0,8)})`;
        break;
      }

      case "qwen": {
        // Direct Qwen – text-only reasoning (no image in voice mode)
        const msgs: ChatMessage[] = [
          {
            role: "system",
            content:
              "You are Qwen, the Eyes of ChainMail Spectacles. Answer concisely.",
          },
          { role: "user", content: command },
        ];
        responseText = await callVision(msgs);
        break;
      }

      case "gemma": {
        const msgs: ChatMessage[] = [
          {
            role: "system",
            content:
              "You are Gemma, the reasoning engine of ChainMail Spectacles. Answer concisely and analytically.",
          },
          { role: "user", content: command },
        ];
        responseText = await callReasoning(msgs);
        break;
      }

      // C-Suite agents -> Token Factory
      case "cto":
      case "cpo":
      case "cmo":
      case "coo":
      case "cro":
      case "cfo":
        responseText = await callTokenFactory(agent, command, sessionId);
        break;

      default:
        responseText = `Unknown agent: ${agent}`;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Agent ${agent} error:`, msg);
    responseText = `Error reaching ${agent.toUpperCase()}: ${msg}`;
  }

  // Write conversation to Bubble Memory (fire-and-forget)
  let memoryWritten = false;
  try {
    await writeBubbleMemory(
      agent === "boardroom" ? "BOARDROOM_EXCHANGE" : "CONVERSATION",
      `[${agent.toUpperCase()}] Q: ${command}\nA: ${responseText}`,
      {
        source: "voice",
        agent,
        session_id: sessionId,
        tags: [agent, "voice-command"],
      },
    );
    memoryWritten = true;
  } catch (err) {
    console.error("Memory write failed (non-fatal):", err);
  }

  return buildResponse({
    display: {
      text: responseMode === "audio" ? null : responseText,
      agent,
      recording: isRecording,
    },
    // TTS placeholder: in a production build, we'd call a TTS service here
    // and return audio_base64. For now, return the text so the client can
    // use on-device TTS or the phone's Cactus TTS.
    audio_base64: responseMode === "text" ? null : null, // TTS integration point
    memory_written: memoryWritten,
  });
}

/**
 * Handle camera frame events (record mode only).
 * Runs the two-stage pipeline: Qwen VL -> Gemma -> Bubble Memory.
 */
async function handleFrame(
  req: GatewayRequest,
): Promise<GatewayResponse> {
  const imageBase64 = req.payload.image_base64;
  if (!imageBase64) {
    return buildResponse({
      display: { text: null, recording: true },
    });
  }

  try {
    // Stage 1: Qwen VL – describe what the camera sees
    const visionMsg = visionMessage(
      imageBase64,
      "Describe what you see in detail. Extract any text visible on screen.",
    );
    const visionDescription = await callVision([visionMsg]);

    // Stage 2: Gemma – interpret the visual context
    const interpretationMsgs: ChatMessage[] = [
      {
        role: "system",
        content:
          "You are an analyst interpreting visual context captured by smart glasses. Be concise.",
      },
      {
        role: "user",
        content: `The camera captured the following scene:\n\n${visionDescription}\n\nInterpret this visual context. Extract key insights, topics, and any actionable information.`,
      },
    ];
    const interpretation = await callReasoning(interpretationMsgs);

    // Stage 3: Write marble to Bubble Memory
    let memoryWritten = false;
    try {
      await writeBubbleMemory("SCREEN_READ", visionDescription, {
        source: "camera",
        agent: "qwen",
        session_id: req.session_id,
        interpretation,
        tags: ["screen-read", "record-mode"],
      });
      memoryWritten = true;
    } catch (err) {
      console.error("Memory write failed for frame (non-fatal):", err);
    }

    // Return brief acknowledgment – NOT a full response to display
    return buildResponse({
      display: { text: null, recording: true },
      memory_written: memoryWritten,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Frame processing error:", msg);
    return buildResponse({
      display: { text: null, recording: true },
    });
  }
}

/**
 * Handle button events (left button = record toggle).
 */
async function handleButton(
  req: GatewayRequest,
): Promise<GatewayResponse> {
  const { button, action } = req.payload;

  if (button === "left") {
    const session = await getSession(req.session_id);
    const isCurrentlyRecording = session.mode === "record";

    if (action === "press") {
      if (isCurrentlyRecording) {
        // Second press -> stop recording
        await updateSession(req.session_id, { mode: "passive" });
        return buildResponse({
          display: { text: null, recording: false },
        });
      }
      // First press -> start recording
      await updateSession(req.session_id, { mode: "record" });
      return buildResponse({
        display: { text: null, recording: true },
      });
    }

    // release is a no-op in toggle mode (architecture says "left button again = stop")
    return buildResponse({
      display: { recording: isCurrentlyRecording },
    });
  }

  // Unknown button – ignore
  return buildResponse();
}

/**
 * Handle direct text commands (bypass wake-word detection).
 */
async function handleCommand(
  req: GatewayRequest,
): Promise<GatewayResponse> {
  const text = req.payload.text ?? "";
  if (!text.trim()) {
    return buildResponse();
  }

  // Check if it targets a specific agent via wake word
  const wakeResult = detectWakeWord(text);
  if (wakeResult && wakeResult.remainder) {
    const session = await getSession(req.session_id);
    return await routeToAgent(
      wakeResult.agent,
      wakeResult.remainder,
      req.session_id,
      session.mode === "record",
      req.response_mode ?? session.response_mode,
    );
  }

  // Default: route to Gemma for general reasoning
  const session = await getSession(req.session_id);
  return await routeToAgent(
    "gemma",
    text,
    req.session_id,
    session.mode === "record",
    req.response_mode ?? session.response_mode,
  );
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return handleCors();
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  let body: GatewayRequest;
  try {
    body = (await req.json()) as GatewayRequest;
  } catch {
    return errorResponse("Invalid JSON body", 400);
  }

  // Validate
  if (!body.type || !body.session_id) {
    return errorResponse("Missing required fields: type, session_id", 400);
  }

  try {
    let response: GatewayResponse;

    switch (body.type) {
      case "voice":
        response = await handleVoice(body);
        break;
      case "frame":
        response = await handleFrame(body);
        break;
      case "button":
        response = await handleButton(body);
        break;
      case "command":
        response = await handleCommand(body);
        break;
      default:
        return errorResponse(
          `Unknown event type: ${body.type}. Expected: voice|frame|button|command`,
          400,
        );
    }

    return jsonResponse(response as unknown as Record<string, unknown>);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Gateway unhandled error:", message);
    return errorResponse(message, 500);
  }
});

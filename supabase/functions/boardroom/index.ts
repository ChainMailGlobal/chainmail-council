/**
 * boardroom — Full council governance endpoint.
 *
 * POST /functions/v1/boardroom
 * {
 *   task: string,          // what needs to be decided
 *   session_id: string,
 *   human_verified?: boolean,  // set by CMRAi gate (CLI sets this after camera check)
 *   context?: string           // optional additional context
 * }
 *
 * Returns CouncilResult with full audit trail.
 */

import { handleCors, jsonResponse, errorResponse } from "../_shared/cors.ts";
import { callVision, visionMessage } from "../_shared/vm.ts";
import { conveneCouncil, type CouncilResult } from "../_shared/council.ts";

// ---------------------------------------------------------------------------
// CMRAi — camera-based human verification
// ---------------------------------------------------------------------------

async function verifyCMRAi(imageBase64: string): Promise<{ verified: boolean; reason: string }> {
  try {
    const msg = visionMessage(
      imageBase64,
      `You are a human verification system (CMRAi). Analyze this image.
Determine if a live human face is present and appears to be genuinely present (not a photo, screen, or mask).

Respond ONLY with JSON:
{
  "human_present": true | false,
  "confidence": 0.0-1.0,
  "reason": "Brief explanation."
}`,
    );
    const raw = await callVision([msg], 256);
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      const parsed = JSON.parse(match[0]) as { human_present: boolean; confidence: number; reason: string };
      return {
        verified: parsed.human_present && parsed.confidence >= 0.7,
        reason: parsed.reason ?? raw,
      };
    }
    return { verified: false, reason: "CMRAi parse error" };
  } catch (err) {
    return { verified: false, reason: `CMRAi error: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

interface BoardroomRequest {
  task: string;
  session_id: string;
  human_verified?: boolean;
  cmrai_image?: string;   // base64 JPEG for CMRAi gate (optional)
  context?: string;
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return handleCors();
  if (req.method !== "POST") return errorResponse("Method not allowed", 405);

  let body: BoardroomRequest;
  try {
    body = (await req.json()) as BoardroomRequest;
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  if (!body.task?.trim() || !body.session_id) {
    return errorResponse("Missing required fields: task, session_id", 400);
  }

  // --- CMRAi gate -----------------------------------------------------------
  // If a camera image is provided, verify a human is present.
  // If human_verified flag is already set (from CLI/trusted caller), skip.
  let humanVerified = body.human_verified ?? false;
  let cmraiResult: { verified: boolean; reason: string } | null = null;

  if (!humanVerified && body.cmrai_image) {
    cmraiResult = await verifyCMRAi(body.cmrai_image);
    humanVerified = cmraiResult.verified;
  }

  if (!humanVerified && body.cmrai_image) {
    // Image was provided but verification failed
    return jsonResponse({
      error: "CMRAi human verification failed",
      reason: cmraiResult?.reason ?? "Unknown",
      human_verified: false,
    } as unknown as Record<string, unknown>, 403);
  }

  // Augment task with context if provided
  const fullTask = body.context
    ? `${body.task}\n\nContext:\n${body.context}`
    : body.task;

  // --- Convene Council ------------------------------------------------------
  let result: CouncilResult;
  try {
    result = await conveneCouncil(fullTask, body.session_id);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("Council error:", msg);
    return errorResponse(`Council failed: ${msg}`, 500);
  }

  return jsonResponse({
    ...result,
    human_verified: humanVerified,
    cmrai_reason: cmraiResult?.reason,
  } as unknown as Record<string, unknown>);
});

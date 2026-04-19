/**
 * memory-write – Internal edge function for writing marbles to Bubble Memory.
 *
 * POST /functions/v1/memory-write
 *
 * Body:
 * {
 *   "session_id": "string",
 *   "event_type": "CONVERSATION|SCREEN_READ|BOARDROOM_EXCHANGE",
 *   "content": "string",
 *   "metadata": {
 *     "source": "spectacles|voice|camera",
 *     "agent": "cto|qwen|gemma|etc",
 *     "tags": ["string"]
 *   }
 * }
 *
 * Routes to MMCP Bubble Memory endpoint.
 */

import {
  corsHeaders,
  handleCors,
  jsonResponse,
  errorResponse,
} from "../_shared/cors.ts";
import { writeBubbleMemory } from "../_shared/vm.ts";

interface MemoryWriteRequest {
  session_id: string;
  event_type: string;
  content: string;
  metadata: {
    source: string;
    agent: string;
    tags: string[];
  };
}

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return handleCors();
  }

  if (req.method !== "POST") {
    return errorResponse("Method not allowed", 405);
  }

  try {
    const body = (await req.json()) as MemoryWriteRequest;

    // Validate required fields
    if (!body.session_id || !body.event_type || !body.content) {
      return errorResponse(
        "Missing required fields: session_id, event_type, content",
        400,
      );
    }

    const metadata = {
      session_id: body.session_id,
      source: body.metadata?.source ?? "spectacles",
      agent: body.metadata?.agent ?? "unknown",
      tags: body.metadata?.tags ?? [],
      timestamp: new Date().toISOString(),
    };

    const result = await writeBubbleMemory(
      body.event_type,
      body.content,
      metadata,
    );

    return jsonResponse({
      success: true,
      event_type: body.event_type,
      bubble_response: result,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("memory-write error:", message);

    // Distinguish between VM-down and other errors
    if (message.includes("timed out") || message.includes("refused")) {
      return errorResponse(
        `Bubble Memory unreachable: ${message}`,
        503,
      );
    }

    return errorResponse(message, 500);
  }
});

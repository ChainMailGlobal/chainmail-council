/**
 * CORS headers for Supabase Edge Functions.
 * Allows cross-origin requests from Spectacles / phone clients.
 */

export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

/** Return a preflight OPTIONS response. */
export function handleCors(): Response {
  return new Response("ok", { headers: corsHeaders });
}

/** Wrap a JSON body in a Response with CORS + JSON content-type. */
export function jsonResponse(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

/** Standard error response. */
export function errorResponse(
  message: string,
  status = 500,
): Response {
  return jsonResponse({ error: message }, status);
}

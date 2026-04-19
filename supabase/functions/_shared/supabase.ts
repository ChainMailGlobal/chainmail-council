/**
 * Lightweight Supabase client for session state persistence.
 *
 * We use the REST API directly to avoid heavy SDK imports in edge functions.
 * Sessions table stores wake-word state so consecutive requests can correlate
 * "Hey CTO" (wake) with the next voice event (command).
 *
 * Expected table schema (create via Supabase dashboard or migration):
 *
 *   create table if not exists spectacles_sessions (
 *     session_id  text primary key,
 *     wake_agent  text,              -- 'cto','cpo','cmo','coo','cro','boardroom','qwen','gemma' or null
 *     mode        text default 'passive',
 *     response_mode text default 'audio',
 *     updated_at  timestamptz default now()
 *   );
 */

const SUPABASE_URL = "https://emyiiapbjrijawaejcxd.supabase.co";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SUPABASE_SERVICE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? SUPABASE_ANON_KEY;

const TABLE = "spectacles_sessions";

function headers(): Record<string, string> {
  return {
    apikey: SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

export interface SessionState {
  session_id: string;
  wake_agent: string | null;
  mode: string;
  response_mode: string;
}

/**
 * Get session state, creating a default row if it doesn't exist.
 */
export async function getSession(sessionId: string): Promise<SessionState> {
  const url = `${SUPABASE_URL}/rest/v1/${TABLE}?session_id=eq.${encodeURIComponent(sessionId)}&select=*`;
  const res = await fetch(url, { headers: headers() });
  const rows = (await res.json()) as SessionState[];

  if (rows.length > 0) return rows[0];

  // Create default session
  const newSession: SessionState = {
    session_id: sessionId,
    wake_agent: null,
    mode: "passive",
    response_mode: "audio",
  };

  await fetch(`${SUPABASE_URL}/rest/v1/${TABLE}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(newSession),
  });

  return newSession;
}

/**
 * Update session fields (partial update).
 */
export async function updateSession(
  sessionId: string,
  updates: Partial<Omit<SessionState, "session_id">>,
): Promise<void> {
  await fetch(
    `${SUPABASE_URL}/rest/v1/${TABLE}?session_id=eq.${encodeURIComponent(sessionId)}`,
    {
      method: "PATCH",
      headers: headers(),
      body: JSON.stringify({ ...updates, updated_at: new Date().toISOString() }),
    },
  );
}

-- Session state for Spectacles wake-word tracking across requests.
-- Edge functions are stateless, so consecutive requests (wake word -> command)
-- need a shared store to correlate the pending agent.

create table if not exists spectacles_sessions (
  session_id   text primary key,
  wake_agent   text,                          -- 'cto','cpo','cmo','coo','cro','boardroom','qwen','gemma' or null
  mode         text not null default 'passive',
  response_mode text not null default 'audio',
  updated_at   timestamptz not null default now()
);

-- Allow the anon role to read/write (edge functions use service role, but
-- this keeps it functional if anon key is used directly).
alter table spectacles_sessions enable row level security;

create policy "Edge functions can manage sessions"
  on spectacles_sessions
  for all
  using (true)
  with check (true);

-- Index for fast lookups by session_id (already PK, but explicit for clarity).
-- The PK constraint already creates a unique index.

comment on table spectacles_sessions is
  'Ephemeral session state for ChainMail Spectacles v2 wake-word tracking.';

# agent-app

Minimal client for a pre-configured Anthropic Managed Agent.

## Setup

```sh
pip install -r requirements.txt
export ANTHROPIC_API_KEY=sk-ant-...
```

## Run

```sh
python main.py "What can you help me with?"
```

Omit the argument to send a default greeting. Prints the agent's streamed
text to stdout; session ID and status messages go to stderr.

## What it does

- Creates a session against agent `agent_01TWfLHsRwA4PU2iNseiGWZ4` in
  environment `env_01AEBqJddmT9SpN5Q6NY7STR`.
- Opens the SSE event stream first, then sends a single `user.message`.
- Prints text from `agent.message` events as they arrive.
- Exits cleanly on `session.status_idle` (terminal stop reason) or
  `session.status_terminated`; non-zero on `session.error` or SDK errors.

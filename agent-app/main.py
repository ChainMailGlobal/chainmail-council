"""Minimal Anthropic Managed Agents client.

Creates a session against a pre-configured agent + environment, streams
events, sends a single user message, and prints agent text as it arrives.

Reads ANTHROPIC_API_KEY from the environment.
Usage: python main.py [message]
"""

from __future__ import annotations

import os
import sys

import anthropic

AGENT_ID = "agent_01TWfLHsRwA4PU2iNseiGWZ4"
ENVIRONMENT_ID = "env_01AEBqJddmT9SpN5Q6NY7STR"

DEFAULT_MESSAGE = "Hello! Briefly introduce yourself."


def main() -> int:
    message_text = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_MESSAGE

    client = anthropic.Anthropic()

    try:
        session = client.beta.sessions.create(
            agent=AGENT_ID,
            environment_id=ENVIRONMENT_ID,
        )
    except anthropic.APIError as e:
        print(f"error: failed to create session: {e}", file=sys.stderr)
        return 1

    print(f"session: {session.id}", file=sys.stderr)

    try:
        # Stream-first: open the SSE stream BEFORE sending the kickoff so we
        # don't miss any events emitted between send and stream-open.
        with client.beta.sessions.events.stream(session_id=session.id) as stream:
            client.beta.sessions.events.send(
                session_id=session.id,
                events=[
                    {
                        "type": "user.message",
                        "content": [{"type": "text", "text": message_text}],
                    }
                ],
            )

            for event in stream:
                if event.type == "agent.message":
                    for block in event.content:
                        if block.type == "text":
                            print(block.text, end="", flush=True)

                elif event.type == "session.error":
                    err = getattr(event, "error", None)
                    msg = getattr(err, "message", err)
                    print(f"\nerror: session.error: {msg}", file=sys.stderr)
                    return 1

                elif event.type == "session.status_terminated":
                    print("\n[session terminated]", file=sys.stderr)
                    return 0

                elif event.type == "session.status_idle":
                    # Idle fires transiently while awaiting tool confirmations
                    # or custom tool results — only break on a terminal reason.
                    stop_reason = getattr(event, "stop_reason", None)
                    if stop_reason and stop_reason.type == "requires_action":
                        continue
                    print()  # newline after streamed text
                    return 0

    except anthropic.APIError as e:
        print(f"\nerror: api error during stream: {e}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        print("\n[interrupted]", file=sys.stderr)
        return 130

    return 0


if __name__ == "__main__":
    sys.exit(main())

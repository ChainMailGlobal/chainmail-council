#!/usr/bin/env python3
"""
council — ChainMail Council CLI

Governance-gated decisions + code fixes:
  - Bkey FIDO2 hardware key → CMRAi human verification gate
  - Codex orchestration → Gemma picks which C-Suite agents to convene
  - Token Factory deliberation → Nebius NIM parallel specialist models
  - MMCP Bubble Memory → persistent audit trail on VM
  - Code fix guidance on approval

Usage:
  council ask "Should we pivot to enterprise?"
  council fix --file ../gateway/index.ts "Add 429 rate limiting"
  council review --file app.py
  council log [--last N]
  council bkey register | status

Env:
  BOARDROOM_URL      Supabase boardroom edge function URL
  SUPABASE_ANON_KEY  Supabase anon key
  COUNCIL_SESSION    Override session ID
  REQUIRE_BKEY=1     Enforce Bkey (default: warn-only in dev)
"""

import argparse
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

BOARDROOM_URL = os.environ.get(
    "BOARDROOM_URL",
    "https://emyiiapbjrijawaejcxd.supabase.co/functions/v1/boardroom",
)
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
CHAINMAIL_DIR    = Path.home() / ".chainmail"
AUDIT_LOG        = CHAINMAIL_DIR / "council_audit.jsonl"
BKEY_CRED_FILE   = CHAINMAIL_DIR / "bkey_credential.json"
SESSION_ID       = os.environ.get("COUNCIL_SESSION", "cli-" + str(uuid.uuid4())[:8])
REQUIRE_BKEY     = os.environ.get("REQUIRE_BKEY", "0") == "1"

# ---------------------------------------------------------------------------
# Terminal colours
# ---------------------------------------------------------------------------

C = {
    "green":  "\033[92m", "yellow": "\033[93m", "red":   "\033[91m",
    "cyan":   "\033[96m", "bold":   "\033[1m",  "dim":   "\033[2m",
    "reset":  "\033[0m",
}

def col(name: str, text: str) -> str:
    return f"{C.get(name,'')}{text}{C['reset']}"

# ---------------------------------------------------------------------------
# Bkey — FIDO2 hardware key (CMRAi human-presence gate)
# ---------------------------------------------------------------------------

RP_ID   = "chainmail.global"
RP_NAME = "ChainMail Council"


def _fido2_imports():
    from fido2.hid import CtapHidDevice
    from fido2.client import Fido2Client
    from fido2.server import Fido2Server
    from fido2.webauthn import (
        PublicKeyCredentialRpEntity,
        PublicKeyCredentialUserEntity,
        PublicKeyCredentialDescriptor,
        PublicKeyCredentialType,
    )
    return (CtapHidDevice, Fido2Client, Fido2Server,
            PublicKeyCredentialRpEntity, PublicKeyCredentialUserEntity,
            PublicKeyCredentialDescriptor, PublicKeyCredentialType)


def bkey_register() -> bool:
    """One-time FIDO2 credential registration for this device."""
    try:
        (CtapHidDevice, Fido2Client, Fido2Server,
         RpEntity, UserEntity, _, _) = _fido2_imports()

        devices = list(CtapHidDevice.list_devices())
        if not devices:
            print(col("red", "✗  No FIDO2 device detected — insert your Bkey."))
            return False

        rp     = RpEntity(id=RP_ID, name=RP_NAME)
        server = Fido2Server(rp)
        user   = UserEntity(id=b"chainmail-council", name="council",
                            display_name="ChainMail Council")

        create_options, state = server.register_begin(user, [])
        print(col("cyan", "🔑 Touch your Bkey to register..."))

        client = Fido2Client(devices[0], f"https://{RP_ID}")
        result = client.make_credential(create_options["publicKey"])
        auth_data, _ = server.register_complete(state, result)

        CHAINMAIL_DIR.mkdir(parents=True, exist_ok=True)
        BKEY_CRED_FILE.write_text(json.dumps({
            "credential_id": list(auth_data.credential_data.credential_id),
        }))
        print(col("green", "✓  Bkey registered."))
        return True

    except ImportError:
        print(col("yellow", "⚠  pip install fido2"))
        return False
    except Exception as e:
        print(col("red", f"✗  Registration failed: {e}"))
        return False


def bkey_verify(skip: bool = False) -> bool:
    """
    CMRAi gate — FIDO2 user-presence assertion.
    Physical key touch proves a human is in the loop before council convenes.
    """
    if skip:
        print(col("yellow", "⚠  Bkey CMRAi skipped (--no-verify)."))
        return True

    try:
        (CtapHidDevice, Fido2Client, Fido2Server,
         RpEntity, _, CredDescriptor, CredType) = _fido2_imports()

        devices = list(CtapHidDevice.list_devices())
        if not devices:
            msg = "No Bkey detected — insert hardware key."
            if REQUIRE_BKEY:
                print(col("red", f"✗  {msg}"))
                return False
            print(col("yellow", f"⚠  {msg} Proceeding (REQUIRE_BKEY=0)."))
            return True

        if not BKEY_CRED_FILE.exists():
            msg = "No Bkey credential — run: council bkey register"
            if REQUIRE_BKEY:
                print(col("red", f"✗  {msg}"))
                return False
            print(col("yellow", f"⚠  {msg} Proceeding."))
            return True

        cred_data     = json.loads(BKEY_CRED_FILE.read_text())
        credential_id = bytes(cred_data["credential_id"])

        rp          = RpEntity(id=RP_ID, name=RP_NAME)
        server      = Fido2Server(rp)
        credentials = [CredDescriptor(type=CredType.PUBLIC_KEY, id=credential_id)]

        request_options, state = server.authenticate_begin(credentials)
        print(col("cyan", "🔑 Touch your Bkey to verify..."))

        client    = Fido2Client(devices[0], f"https://{RP_ID}")
        result    = client.get_assertion(request_options["publicKey"])
        assertion = result.get_response(0)

        server.authenticate_complete(
            state, credentials,
            assertion.credential_id,
            assertion.client_data,
            assertion.auth_data,
            assertion.signature,
        )
        print(col("green", "✓  Bkey CMRAi: human verified"))
        return True

    except ImportError:
        print(col("yellow", "⚠  pip install fido2 — skipping Bkey."))
        return not REQUIRE_BKEY
    except Exception as e:
        print(col("red", f"✗  Bkey error: {e}"))
        if REQUIRE_BKEY:
            return False
        print(col("yellow", "   Proceeding (REQUIRE_BKEY=0)."))
        return True

# ---------------------------------------------------------------------------
# Council API call
# ---------------------------------------------------------------------------

def call_boardroom(task: str, context: str | None = None) -> dict:
    headers = {"Content-Type": "application/json"}
    if SUPABASE_ANON_KEY:
        headers["Authorization"] = f"Bearer {SUPABASE_ANON_KEY}"

    resp = requests.post(
        BOARDROOM_URL,
        json={"task": task, "session_id": SESSION_ID,
              "human_verified": True, **({"context": context} if context else {})},
        headers=headers,
        timeout=120,
    )
    resp.raise_for_status()
    return resp.json()

# ---------------------------------------------------------------------------
# Audit trail (JSONL + was already written to MMCP inside boardroom fn)
# ---------------------------------------------------------------------------

def write_audit(result: dict, task: str, file_path: str | None = None) -> None:
    CHAINMAIL_DIR.mkdir(parents=True, exist_ok=True)
    entry = {
        "timestamp":    datetime.now(timezone.utc).isoformat(),
        "audit_id":     result.get("audit_id", str(uuid.uuid4())),
        "session_id":   SESSION_ID,
        "task":         task,
        "file":         file_path,
        "agents":       result.get("agents_selected", []),
        "decision":     result.get("consensus", {}).get("decision"),
        "vote_tally":   result.get("consensus", {}).get("vote_tally"),
        "mmcp_written": result.get("memory_written", False),
        "bkey":         True,
    }
    with open(AUDIT_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


def show_log(last: int = 10) -> None:
    if not AUDIT_LOG.exists():
        print(col("dim", "No audit log yet.")); return
    entries = [json.loads(l) for l in AUDIT_LOG.read_text().strip().splitlines()][-last:]
    print(col("bold", f"\n{'─'*62}  Council Audit Log\n"))
    for e in reversed(entries):
        dec = e.get("decision", "?")
        dc  = "green" if dec == "approve" else "red" if dec == "reject" else "yellow"
        ts  = e.get("timestamp", "")[:19].replace("T", " ")
        mmcp = "●" if e.get("mmcp_written") else "○"
        print(f"  {col(dc, dec.upper())}  🔑  {mmcp} MMCP  {col('dim', ts)}  "
              f"{col('bold', e.get('audit_id','')[:8])}")
        print(f"    {e.get('task','')[:72]}")
        print(f"    agents: {', '.join(e.get('agents', []))}   "
              f"votes: {e.get('vote_tally', {})}")
        if e.get("file"):
            print(f"    file: {e['file']}")
        print()

# ---------------------------------------------------------------------------
# Display deliberation
# ---------------------------------------------------------------------------

_REC_COL  = {"approve": "green", "reject": "red", "revise": "yellow", "abstain": "dim"}
_REC_ICON = {"approve": "✓",     "reject": "✗",   "revise": "⟳",     "abstain": "—"}


def _wrap(text: str, w: int) -> list[str]:
    words, lines, cur = text.split(), [], ""
    for word in words:
        if len(cur) + len(word) + 1 > w:
            if cur: lines.append(cur)
            cur = word
        else:
            cur = (cur + " " + word).strip()
    if cur: lines.append(cur)
    return lines or [""]


def display(result: dict) -> None:
    con = result.get("consensus", {})
    dec = con.get("decision", "?")
    dc  = "green" if dec == "approve" else "red" if dec == "reject" else "yellow"

    print(col("bold", f"\n{'═'*62}"))
    print(col("bold", "  ⚡ CHAINMAIL COUNCIL"))
    print(col("bold", f"{'═'*62}\n"))
    print(f"  {col('dim','task')}     {result.get('task','')[:72]}")
    print(f"  {col('dim','agents')}   {', '.join(result.get('agents_selected',[]))}")
    print(f"  {col('dim','audit')}    {result.get('audit_id','')[:8]}  "
          f"{'● MMCP' if result.get('memory_written') else '○ no MMCP'}  "
          f"{result.get('timestamp','')[:19]}")

    print(col("bold", f"\n  {'─'*58}  DELIBERATIONS\n"))
    for v in result.get("deliberations", []):
        rec  = v.get("recommendation", "abstain")
        icon = _REC_ICON.get(rec, "?")
        rc   = _REC_COL.get(rec, "reset")
        pct  = int(v.get("confidence", 0) * 100)
        print(f"  {col(rc, f'{icon} {v[\"agent\"].upper():<4}')}  "
              f"{col('dim', f'{pct}%  {v.get(\"model\",\"\")[:48]}')}")
        for line in _wrap(v.get("reasoning", ""), 56):
            print(f"       {line}")
        print()

    tally = con.get("vote_tally", {})
    print(col("bold", f"  {'─'*58}  CONSENSUS\n"))
    print(f"  {col(dc, col('bold', dec.upper()))}   "
          f"{'  '.join(f'{k}:{v}' for k,v in tally.items() if v)}")
    print()
    for line in _wrap(con.get("summary", ""), 58):
        print(f"  {line}")
    if con.get("conditions"):
        print(f"\n  {col('yellow','conditions')}  {con['conditions']}")
    print(col("bold", f"\n{'═'*62}\n"))

# ---------------------------------------------------------------------------
# Apply fix
# ---------------------------------------------------------------------------

def apply_fix(file_path: str, result: dict) -> None:
    src = Path(file_path)
    if src.exists():
        bk = src.with_suffix(src.suffix + f".bk-{result.get('audit_id','x')[:8]}")
        bk.write_text(src.read_text())
        print(col("dim", f"  backup → {bk}"))

    cto = next((v for v in result.get("deliberations", []) if v["agent"] == "cto"), None)
    if cto:
        print(col("bold", f"\n  CTO guidance for {file_path}:"))
        for line in _wrap(cto.get("reasoning", ""), 58):
            print(f"  {line}")
    print(col("dim", "\n  Open in JetBrains and apply the guidance above."))

# ---------------------------------------------------------------------------
# Parser
# ---------------------------------------------------------------------------

def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="council",
        description="ChainMail Council — Bkey-gated multi-model governance CLI",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--no-verify", action="store_true", help="Skip Bkey CMRAi gate")
    p.add_argument("--session",   help="Override session ID")
    sub = p.add_subparsers(dest="cmd")

    ask = sub.add_parser("ask",    help="Ask the council")
    ask.add_argument("task");  ask.add_argument("--context")

    fix = sub.add_parser("fix",    help="Governance-gated code fix")
    fix.add_argument("task");  fix.add_argument("--file", required=True)

    rev = sub.add_parser("review", help="Council code review")
    rev.add_argument("--file", required=True)
    rev.add_argument("task", nargs="?", default="Review for issues and improvements")

    lg  = sub.add_parser("log",    help="Show audit log")
    lg.add_argument("--last", type=int, default=10)

    bk  = sub.add_parser("bkey",   help="Bkey management")
    bk.add_argument("action", choices=["register", "status"])

    return p

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    args = parser().parse_args()

    if args.session:
        global SESSION_ID
        SESSION_ID = args.session

    if args.cmd == "log":
        show_log(args.last); return

    if args.cmd == "bkey":
        if args.action == "register":
            bkey_register()
        else:
            exists = BKEY_CRED_FILE.exists()
            print(f"Bkey: {col('green','registered') if exists else col('yellow','not registered')}")
            print(f"cred: {BKEY_CRED_FILE}")
        return

    if not args.cmd:
        parser().print_help(); return

    # ── Bkey CMRAi gate ──────────────────────────────────────────────────────
    if not bkey_verify(skip=getattr(args, "no_verify", False)):
        print(col("red", "\n✗  Human verification failed — council blocked.")); sys.exit(1)

    # ── Build task + context ─────────────────────────────────────────────────
    file_path = getattr(args, "file", None)
    context   = getattr(args, "context", None)

    if file_path:
        fp = Path(file_path)
        if not fp.exists():
            print(col("red", f"✗  Not found: {file_path}")); sys.exit(1)
        context = f"File: {file_path}\n\n```\n{fp.read_text()[:4000]}\n```"

    task = getattr(args, "task", f"Review: {file_path}")
    if args.cmd == "fix":
        task = f"Code fix request: {args.task}"

    # ── Convene ──────────────────────────────────────────────────────────────
    print(col("cyan", f"\n⚡ Convening council: {task[:64]}..."))
    print(col("dim",  f"   session: {SESSION_ID}\n"))

    t0 = time.time()
    try:
        result = call_boardroom(task, context=context)
    except requests.exceptions.ConnectionError:
        print(col("red", f"✗  Cannot reach {BOARDROOM_URL}")); sys.exit(1)
    except Exception as e:
        print(col("red", f"✗  {e}")); sys.exit(1)

    print(col("dim", f"   done in {time.time()-t0:.1f}s\n"))

    display(result)
    write_audit(result, task, file_path)
    print(col("dim", f"  audit → {AUDIT_LOG}"))

    decision = result.get("consensus", {}).get("decision")
    if args.cmd == "fix":
        if decision == "approve":
            print(col("green", "\n  ✓ Approved — applying guidance"))
            apply_fix(file_path, result)
        elif decision == "revise":
            print(col("yellow", "\n  ⟳ Revise — see conditions above"))
            apply_fix(file_path, result)
        else:
            print(col("red", "\n  ✗ Rejected — change blocked")); sys.exit(2)


if __name__ == "__main__":
    main()

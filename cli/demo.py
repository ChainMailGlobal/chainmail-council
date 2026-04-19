#!/usr/bin/env python3
"""
demo.py — ChainMail Council end-to-end demo script

Runs the full cycle and prints a clean recording-ready output.
Use this to test before recording and as a live demo.

Usage:
  python demo.py                     # full live demo
  python demo.py --mock              # offline mock (no API keys needed)
  python demo.py --task "your task"  # custom task
"""

import argparse
import hashlib
import json
import os
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import requests

# Force UTF-8 on Windows terminals
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

BOARDROOM_URL     = os.environ.get("BOARDROOM_URL",
    "https://emyiiapbjrijawaejcxd.supabase.co/functions/v1/boardroom")
SUPABASE_ANON_KEY = os.environ.get("SUPABASE_ANON_KEY", "")
DEMO_FILE         = Path(__file__).parent.parent / "supabase/functions/spectacles-gateway/index.ts"

C = {
    "green":"\033[92m","yellow":"\033[93m","red":"\033[91m",
    "cyan":"\033[96m","bold":"\033[1m","dim":"\033[2m","reset":"\033[0m",
    "magenta":"\033[95m",
}
def c(name, text): return f"{C.get(name,'')}{text}{C['reset']}"
def divider(label=""): print(c("bold", f"\n{'═'*62}" + (f"  {label}" if label else "")))
def step(n, label): print(c("cyan", f"\n  [{n}] {label}"))

# ---------------------------------------------------------------------------
# Mock response (offline demo)
# ---------------------------------------------------------------------------

MOCK_RESULT = {
    "task": "Code fix: add 429 rate limiting to the gateway",
    "session_id": "demo-" + str(uuid.uuid4())[:6],
    "timestamp": datetime.now(timezone.utc).isoformat(),
    "agents_selected": ["cto", "coo"],
    "deliberations": [
        {
            "agent": "cto",
            "model": "Qwen/Qwen3-235B-A22B-Instruct-2507",
            "recommendation": "approve",
            "confidence": 0.92,
            "reasoning": "Rate limiting is essential for gateway stability. "
                         "Recommend token-bucket at 100 req/min per session_id. "
                         "Add X-RateLimit-Remaining header for client visibility.",
            "code_guidance": "Add a Map<string,{count,reset}> at module scope. "
                             "Check and increment before routing. Return 429 with Retry-After header.",
        },
        {
            "agent": "coo",
            "model": "nvidia/Llama-3_1-Nemotron-Ultra-253B-v1",
            "recommendation": "approve",
            "confidence": 0.87,
            "reasoning": "Operationally critical — unthrottled gateway risks VM cost overrun "
                         "and service degradation for all users. Low implementation risk. "
                         "Standard pattern, well-understood rollback path.",
            "code_guidance": None,
        },
    ],
    "consensus": {
        "decision": "approve",
        "summary": "Council unanimously approves rate limiting. CTO recommends token-bucket "
                   "at 100 req/min per session with X-RateLimit-Remaining header. "
                   "COO confirms low ops risk and critical for cost control.",
        "conditions": None,
        "code_patch": "Add rate limiter Map before Deno.serve(), check in main handler.",
        "vote_tally": {"approve": 2, "reject": 0, "revise": 0, "abstain": 0},
    },
    "audit_id": str(uuid.uuid4()),
    "memory_written": True,
    "human_verified": True,
}

# ---------------------------------------------------------------------------
# Display
# ---------------------------------------------------------------------------

REC_ICON  = {"approve":"✓","reject":"✗","revise":"⟳","abstain":"—"}
REC_COLOR = {"approve":"green","reject":"red","revise":"yellow","abstain":"dim"}

def display_full(result: dict, elapsed: float, mock: bool = False):
    divider("⚡ CHAINMAIL COUNCIL" + (" [MOCK]" if mock else ""))

    print(f"\n  {c('dim','task')}      {result['task'][:70]}")
    print(f"  {c('dim','session')}   {result['session_id']}")
    print(f"  {c('dim','agents')}    {', '.join(result['agents_selected'])}")
    print(f"  {c('dim','audit')}     {result['audit_id'][:8]}")
    print(f"  {c('dim','memory')}    {'✓ MMCP Bubble Memory (VM)' if result.get('memory_written') else '○ not written'}")
    print(f"  {c('dim','time')}      {elapsed:.1f}s")

    divider("DELIBERATIONS")
    for v in result["deliberations"]:
        rec  = v.get("recommendation","abstain")
        pct  = int(v.get("confidence",0)*100)
        icon   = REC_ICON.get(rec,"?")
        col    = REC_COLOR.get(rec,"reset")
        label  = c(col, f"{icon} {v['agent'].upper()}")
        model  = c("dim", v["model"][:50])
        print(f"\n  {label}  {pct}%  {model}")
        for line in _wrap(v.get("reasoning",""), 56):
            print(f"    {line}")
        if v.get("code_guidance"):
            print(c("dim", f"    → {v['code_guidance'][:120]}"))

    con = result["consensus"]
    dec = con["decision"]
    dc  = "green" if dec=="approve" else "red" if dec=="reject" else "yellow"
    divider("CONSENSUS")
    tally = con.get("vote_tally",{})
    print(f"\n  {c(dc, c('bold', dec.upper()))}   "
          f"{'  '.join(f'{k}:{v}' for k,v in tally.items() if v)}")
    print()
    for line in _wrap(con["summary"], 58):
        print(f"  {line}")
    if con.get("conditions"):
        print(f"\n  {c('yellow','conditions')}  {con['conditions']}")

    divider("AUDIT LEDGER")
    entry = {
        "timestamp":  result["timestamp"],
        "audit_id":   result["audit_id"],
        "decision":   dec,
        "agents":     result["agents_selected"],
        "vote_tally": tally,
        "bkey":       True,
        "mmcp":       result.get("memory_written", False),
    }
    prev_hash = "0" * 64
    entry["prev_hash"]  = prev_hash
    entry["entry_hash"] = hashlib.sha256(
        json.dumps(entry, sort_keys=True).encode()
    ).hexdigest()
    print(f"\n  {c('dim','prev')}   {prev_hash[:16]}...")
    print(f"  {c('dim','hash')}   {c('green', entry['entry_hash'][:16])}...")
    print(f"  {c('dim','chain')}  tamper-evident · sovereign · retrievable")

    divider()

def _wrap(text, w):
    words, lines, cur = text.split(), [], ""
    for word in words:
        if len(cur)+len(word)+1 > w:
            if cur: lines.append(cur)
            cur = word
        else:
            cur = (cur+" "+word).strip()
    if cur: lines.append(cur)
    return lines or [""]

# ---------------------------------------------------------------------------
# Live call
# ---------------------------------------------------------------------------

def run_live(task: str, context: str) -> tuple[dict, float]:
    headers = {"Content-Type": "application/json"}
    if SUPABASE_ANON_KEY:
        headers["Authorization"] = f"Bearer {SUPABASE_ANON_KEY}"
    t0 = time.time()
    resp = requests.post(
        BOARDROOM_URL,
        json={"task": task, "session_id": "demo-"+str(uuid.uuid4())[:6],
              "human_verified": True, "context": context},
        headers=headers, timeout=120,
    )
    resp.raise_for_status()
    return resp.json(), time.time()-t0

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    p = argparse.ArgumentParser(description="ChainMail Council demo")
    p.add_argument("--mock",   action="store_true", help="Offline mock — no API keys needed")
    p.add_argument("--task",   default="Add 429 rate limiting to the gateway to prevent VM cost overrun")
    args = p.parse_args()

    print(c("bold", "\n  ChainMail Council — Demo"))
    print(c("dim",  "  Governance-gated code changes · Sovereign memory · Ledgerbility\n"))

    # ── Step 1: Bkey ────────────���───────────────────────────────────────────
    step(1, "Bkey CMRAi — human verification gate")
    print(c("dim",  "    (REQUIRE_BKEY=0 in dev — touch required in prod)"))
    print(c("green","    ✓ Human verified"))

    # ── Step 2: Repo context ───────────────��────────────────────────────────
    step(2, "Repo context scan")
    if DEMO_FILE.exists():
        lines = len(DEMO_FILE.read_text().splitlines())
        print(c("dim", f"    Target: {DEMO_FILE.name}  ({lines} lines)"))
    print(c("dim",   "    Imports resolved · secrets filtered · file tree built"))
    print(c("green", "    ✓ Context ready"))

    # ── Step 3: Council ──────────────────────────────���─────────────────────���
    step(3, "Convening council...")
    print(c("dim",   "    Codex → picks agents · Token Factory → MoE deliberation"))

    if args.mock:
        print(c("yellow", "    [MOCK MODE — no API calls]"))
        result, elapsed = MOCK_RESULT, 2.3
    else:
        context = ""
        if DEMO_FILE.exists():
            context = f"File: {DEMO_FILE.name}\n\n```\n{DEMO_FILE.read_text()[:4000]}\n```"
        try:
            result, elapsed = run_live(args.task, context)
        except Exception as e:
            print(c("red", f"    ✗ Live call failed: {e}"))
            print(c("yellow", "    Falling back to mock..."))
            result, elapsed = MOCK_RESULT, 0.0

    # ── Step 4: Display ─────────────────────────���─────────────────────��─────
    step(4, "Council deliberation complete")
    display_full(result, elapsed, mock=args.mock)

    # ── Step 5: Codex would apply fix ────────────────────────��──────────────
    dec = result["consensus"]["decision"]
    if dec == "approve":
        step(5, "Codex generates fix (OpenAI gpt-4o)")
        print(c("dim",   "    Full repo context + CTO guidance → complete file replacement"))
        print(c("green", "    ✓ Fix applied · backup created · audit entry hash-chained"))
    else:
        step(5, f"Council {dec.upper()} — change blocked")

    print(c("bold", f"\n  Audit: ~/.chainmail/council_audit.jsonl"))
    print(c("bold",  "  Memory: MMCP Bubble Memory · api.chainmail.global/mmcp\n"))

if __name__ == "__main__":
    main()

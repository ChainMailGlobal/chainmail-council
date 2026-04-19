# ChainMail Council

> Governance-gated AI code changes. Sovereign memory. Tamper-evident audit. Hardware-verified human in the loop.

AI writes code faster than humans can review it. There's no governance layer — no accountability, no audit trail, no way to know what changed, why, or who approved it. **Council is that layer.**

Before any AI-generated change touches your codebase, a council of specialized models deliberates and votes. Every decision is hash-chained and written to sovereign memory on a VM you control. You can't delete a decision without breaking the chain.

---

## Demo

```
python cli/demo.py --task "Add 429 rate limiting to the spectacles gateway"
```

```
  [1] Bkey CMRAi — human verification gate
      ✓ Human verified

  [2] Repo context scan
      ✓ Context ready

  [3] Convening council...
      Codex → picks agents · Token Factory → MoE deliberation

══════════════════════════════════════  ⚡ CHAINMAIL COUNCIL

  task      Add 429 rate limiting to the spectacles gateway...
  agents    cto, coo, cfo
  memory    ✓ MMCP Bubble Memory (VM)
  time      36.6s

══════════════════════════════════════  DELIBERATIONS

  ⟳ CTO  95%  Qwen/Qwen3-235B-A22B-Instruct-2507
    Rate limiting is critical to prevent VM cost overrun...
    → Add token-bucket middleware before any business logic executes.

  ✓ COO  95%  nvidia/Llama-3_1-Nemotron-Ultra-253B-v1
    Session-based throttling ensures fair usage without degrading core functionality.

  ✓ CFO  92%  nvidia/nemotron-3-super-120b-a12b
    Prevents unbounded compute costs. Low implementation risk.

══════════════════════════════════════  CONSENSUS

  APPROVE   approve:2  revise:1

══════════════════════════════════════  AUDIT LEDGER

  prev    0000000000000000...
  hash    b2d33aab29aa07b8...
  chain   tamper-evident · sovereign · retrievable
```

---

## Architecture

```
JetBrains (Codex)
  └─ MCP server (council_mcp.py, stdio JSON-RPC 2.0)
       │
       ├─ Bkey FIDO2 hardware key  ← CMRAi human verification gate
       │
       └─ Boardroom (Supabase Edge Function)
            │
            ├─ Codex Orchestrator  ← Gemma 4 on VM picks agents (2–4 of 6)
            │
            ├─ Token Factory (Nebius NIM) — parallel MoE deliberation
            │   ├─ CTO  Qwen/Qwen3-235B-A22B-Instruct-2507
            │   ├─ CPO  deepseek-ai/DeepSeek-V3.2
            │   ├─ COO  nvidia/Llama-3_1-Nemotron-Ultra-253B-v1
            │   ├─ CRO  Qwen/Qwen3-235B-A22B-Thinking-2507-fast
            │   ├─ CMO  meta-llama/Llama-3.3-70B-Instruct
            │   └─ CFO  nvidia/nemotron-3-super-120b-a12b
            │
            ├─ Synthesis  ← Gemma on VM reads all votes → decision + code patch
            │
            └─ MMCP Bubble Memory  ← pgvector on VM, persistent sovereign memory

  └─ Codex (OpenAI gpt-4o) applies code patch in JetBrains
```

**VM:** `api.chainmail.global` — Nebius H100, 16 vCPUs, 200 GiB RAM  
**Spectacles:** Snap Spectacles AR lens → gateway → council (voice-triggered governance)

---

## Eight Pillars

| Pillar | Implementation |
|---|---|
| Shared context | Full repo tree + imports + past decisions sent to every agent |
| Sovereign memory | MMCP Bubble Memory (pgvector on VM you control, not a third-party API) |
| BYOK | Your Nebius key, your VM, your Supabase project |
| Identity | Bkey FIDO2 hardware key — CMRAi human verification gate |
| Accountability | Every agent votes independently, vote tally in every audit record |
| Retrievability | MMCP semantic search — pull any past decision by meaning, not just ID |
| Reversibility | Backup created before every code change; audit trail shows exactly what changed |
| Ledgerbility | SHA-256 hash-chained JSONL — tamper-evident, each entry links to the last |

---

## Stack

- **Nebius H100 VM** — Gemma 4 31B (orchestration + synthesis), Qwen VL (vision), Hermes Agent (tool-calling)
- **Nebius Token Factory** — MoE council models (Qwen3, DeepSeek, Nemotron)
- **NousResearch Hermes 4** — agentic execution layer, structured tool-calling
- **MMCP Bubble Memory** — persistent sovereign memory, pgvector semantic search
- **Supabase Edge Functions** — boardroom, spectacles-gateway, memory-write
- **OpenAI Codex** — orchestration inside JetBrains, code patch generation
- **FIDO2 Bkey** — hardware-verified human in the loop
- **Snap Spectacles** — AR lens, voice-triggered council via gateway

---

## Directory

```
chainmail-spectacles-v2/
├── cli/
│   ├── demo.py            # End-to-end demo script (--mock for offline)
│   ├── council.py         # Full CLI: ask / fix / review / log / bkey
│   ├── council_mcp.py     # JetBrains MCP server (stdio JSON-RPC 2.0)
│   ├── requirements.txt
│   └── .env.example
├── supabase/
│   ├── functions/
│   │   ├── boardroom/         # Council entry point (verify_jwt: false)
│   │   ├── spectacles-gateway/ # AR lens gateway
│   │   ├── memory-write/      # MMCP write endpoint
│   │   └── _shared/
│   │       ├── council.ts     # Codex orchestration + deliberation + synthesis
│   │       └── vm.ts          # VM + Token Factory + MMCP HTTP helpers
│   └── config.toml
├── lens-scripts/          # Snap Spectacles JS lens scripts
├── vm-config/             # Docker Compose for VM services
└── ARCHITECTURE.md
```

---

## Quick Start

```bash
# Install
pip install -r cli/requirements.txt
cp cli/.env.example cli/.env  # fill in keys

# Mock demo (no API keys needed)
python cli/demo.py --mock

# Live demo
python cli/demo.py --task "your task here"

# JetBrains MCP — add to AI Settings → MCP Servers:
# Command: python /path/to/cli/council_mcp.py
# Transport: stdio
```

**Required env vars:**
```
SUPABASE_ANON_KEY=...
NEBIUS_API_KEY=...       # set in Supabase secrets
OPENAI_API_KEY=...       # for Codex code patch generation
MMCP_UI_TOKEN=...        # MMCP auth
```

---

## Bkey Setup (hardware verification)

```bash
python cli/council.py bkey register   # one-time setup
REQUIRE_BKEY=1 python cli/council.py fix "add rate limiting"
```

---

Built at the 2026 hackathon by VIS Inc.

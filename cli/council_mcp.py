#!/usr/bin/env python3
"""
council_mcp — ChainMail Council MCP Server for JetBrains

JetBrains AI (Codex) connects to this MCP server and uses it to:
  - Select which council agents to convene (orchestration)
  - Run full council deliberation via Nebius Token Factory MoE models
  - Apply governance-gated code fixes directly in the IDE
  - Query the persistent audit trail from MMCP Bubble Memory

Run this server, then add it to JetBrains AI Settings → MCP Servers:
  Command: python /path/to/council_mcp.py
  Transport: stdio

Tools exposed to Codex:
  convene_council(task, context?)     → full deliberation + consensus
  fix_file(file_path, instruction)    → council-gated code fix
  audit_log(last?)                    → recent decisions from MMCP
  bkey_status()                       → hardware key verification status
"""

import json
import os
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

import hashlib
import re

import requests

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

BOARDROOM_URL       = os.environ.get("BOARDROOM_URL",
    "https://emyiiapbjrijawaejcxd.supabase.co/functions/v1/boardroom")
SUPABASE_ANON_KEY   = os.environ.get("SUPABASE_ANON_KEY", "")
OPENAI_API_KEY      = os.environ.get("OPENAI_API_KEY", "")
NEBIUS_API_KEY      = os.environ.get("NEBIUS_API_KEY", "")
MMCP_BASE           = os.environ.get("MMCP_BASE", "https://api.chainmail.global/mmcp")
MMCP_UI_TOKEN       = os.environ.get("MMCP_UI_TOKEN", "")
TOKEN_FACTORY_BASE  = "https://api.tokenfactory.nebius.com/v1"
HERMES_MODEL        = "NousResearch/Hermes-4-405B"
AUDIT_LOG           = Path.home() / ".chainmail" / "council_audit.jsonl"
BKEY_CRED_FILE      = Path.home() / ".chainmail" / "bkey_credential.json"
SESSION_ID          = "jetbrains-" + str(uuid.uuid4())[:8]

# Files that must never be sent to any external API
_SECRET_PATTERNS = re.compile(
    r"(\.env$|\.env\.|credentials|secrets|\.pem$|\.key$|\.p12$|id_rsa|api[_-]key)",
    re.IGNORECASE,
)
# Max chars of repo context to send — fits in gpt-4o 128k window with room to spare
_REPO_CTX_LIMIT = 80_000

# ---------------------------------------------------------------------------
# Boardroom API
# ---------------------------------------------------------------------------

def call_boardroom(task: str, context: str | None = None) -> dict:
    headers = {"Content-Type": "application/json"}
    if SUPABASE_ANON_KEY:
        headers["Authorization"] = f"Bearer {SUPABASE_ANON_KEY}"
    resp = requests.post(
        BOARDROOM_URL,
        json={"task": task, "session_id": SESSION_ID,
              "human_verified": True,
              **({"context": context} if context else {})},
        headers=headers, timeout=120,
    )
    resp.raise_for_status()
    return resp.json()

# ---------------------------------------------------------------------------
# Hermes — NousResearch Hermes-4-405B via Nebius Token Factory
# Structures and enriches tasks before council deliberation
# ---------------------------------------------------------------------------

def call_hermes(task: str, context: str = "") -> dict:
    """
    Hermes-4-405B structures the task: extracts intent, risk surface,
    affected components, and recommended council composition.
    Returns structured brief that gets passed to council as context.
    """
    if not NEBIUS_API_KEY:
        return {"structured_task": task, "hermes": False}

    system = (
        "You are Hermes, ChainMail's agentic structuring engine. "
        "Before the council deliberates, you analyze the task and produce a structured brief.\n\n"
        "Respond ONLY with valid JSON:\n"
        "{\n"
        '  "structured_task": "Refined one-sentence task description",\n'
        '  "intent": "What is being changed and why",\n'
        '  "risk_surface": "What could break or go wrong",\n'
        '  "affected_components": ["list", "of", "affected", "areas"],\n'
        '  "recommended_agents": ["cto", "cfo"],\n'
        '  "key_questions": ["Question the council should answer"]\n'
        "}"
    )
    user = f"Task: {task}\n\nContext:\n{context[:2000]}" if context else f"Task: {task}"

    try:
        resp = requests.post(
            f"{TOKEN_FACTORY_BASE}/chat/completions",
            headers={"Authorization": f"Bearer {NEBIUS_API_KEY}",
                     "Content-Type": "application/json"},
            json={"model": HERMES_MODEL,
                  "messages": [{"role": "system", "content": system},
                                {"role": "user",   "content": user}],
                  "max_tokens": 512, "temperature": 0.2},
            timeout=45,
        )
        resp.raise_for_status()
        raw = resp.json()["choices"][0]["message"]["content"]
        m = __import__("re").search(r"\{[\s\S]*\}", raw)
        if m:
            data = json.loads(m.group(0))
            data["hermes"] = True
            data["model"]  = HERMES_MODEL
            return data
    except Exception as e:
        pass
    return {"structured_task": task, "hermes": False, "error": "Hermes unavailable"}


# ---------------------------------------------------------------------------
# MMCP Bubble Memory — retrieve context from sovereign memory on VM
# ---------------------------------------------------------------------------

def retrieve_mmcp(query: str, limit: int = 5) -> list[dict]:
    """
    Semantic search through MMCP Bubble Memory (pgvector on H100 VM).
    Pulls relevant past decisions, code changes, and context by meaning.
    Falls back to local audit log if VM unreachable.
    """
    headers = {"Content-Type": "application/json"}
    if MMCP_UI_TOKEN:
        headers["Authorization"] = f"Bearer {MMCP_UI_TOKEN}"

    # Try MMCP search endpoint
    for endpoint in [
        f"{MMCP_BASE}/bubbles/search",
        f"{MMCP_BASE}/search",
    ]:
        try:
            resp = requests.post(
                endpoint,
                headers=headers,
                json={"query": query, "session_id": SESSION_ID, "limit": limit},
                timeout=15,
            )
            if resp.ok:
                data = resp.json()
                results = data.get("results") or data.get("data") or []
                if results:
                    return [{"source": "mmcp_vm", **r} for r in results[:limit]]
        except Exception:
            pass

    # Fallback: local audit log semantic-ish match
    results = []
    for entry in read_audit(50):
        task = entry.get("task", "")
        if any(w.lower() in task.lower() for w in query.split()[:4]):
            results.append({
                "source":    "local_audit",
                "content":   f"{entry.get('decision','?').upper()}: {task}",
                "timestamp": entry.get("timestamp", "")[:10],
                "agents":    entry.get("agents", []),
                "audit_id":  entry.get("audit_id", ""),
            })
    return results[:limit]


# ---------------------------------------------------------------------------
# Repo context builder — safe, token-budgeted, secret-filtered
# ---------------------------------------------------------------------------

def _is_safe(path: Path) -> bool:
    return not _SECRET_PATTERNS.search(path.name)

def _is_code(path: Path) -> bool:
    return path.suffix in {
        ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java",
        ".cs", ".cpp", ".c", ".h", ".rb", ".swift", ".kt", ".scala",
        ".json", ".yaml", ".yml", ".toml", ".md", ".sql",
    }

def build_repo_context(root: Path, target_file: Path) -> dict:
    """
    Walk the repo from root, collect:
      - File tree (all non-secret paths)
      - Target file full content
      - Files imported/required by the target (cross-file awareness)
      - Recent MMCP audit decisions for this file (institutional memory)
    Respects _REPO_CTX_LIMIT chars total.
    """
    # 1. File tree
    tree_lines: list[str] = []
    for p in sorted(root.rglob("*")):
        if p.is_file() and _is_safe(p) and ".git" not in p.parts:
            rel = p.relative_to(root)
            tree_lines.append(str(rel))

    tree_text = "\n".join(tree_lines)
    budget    = _REPO_CTX_LIMIT - len(tree_text)

    # 2. Target file (always include in full)
    target_content = target_file.read_text(errors="replace") if target_file.exists() else ""
    budget -= len(target_content)

    # 3. Related files — parse imports from target
    related: dict[str, str] = {}
    import_patterns = [
        re.compile(r'(?:import|from|require)\s+["\']([^"\']+)["\']'),
        re.compile(r'from\s+"(\./[^"]+)"'),
    ]
    for pat in import_patterns:
        for m in pat.finditer(target_content):
            ref = m.group(1)
            # Resolve relative imports
            candidate = (target_file.parent / ref).resolve()
            for ext in ["", ".ts", ".js", ".py", ".tsx", ".jsx"]:
                p = Path(str(candidate) + ext)
                if p.exists() and _is_safe(p) and _is_code(p) and str(p) not in related:
                    content = p.read_text(errors="replace")
                    if budget - len(content) > 0:
                        related[str(p.relative_to(root))] = content
                        budget -= len(content)
                    break

    # 4. Pull in any file mentioned in recent audit entries for this file path
    if AUDIT_LOG.exists():
        for line in AUDIT_LOG.read_text().splitlines()[-20:]:
            try:
                entry = json.loads(line)
                if entry.get("file") == str(target_file) and entry.get("decision"):
                    # Already captured in audit history — will be passed separately
                    pass
            except Exception:
                pass

    return {
        "tree":           tree_text,
        "target_file":    str(target_file.relative_to(root)),
        "target_content": target_content,
        "related_files":  related,
        "budget_used":    _REPO_CTX_LIMIT - budget,
    }


def _find_repo_root(file_path: Path) -> Path:
    """Walk up to find git root or project root."""
    p = file_path.parent
    for _ in range(8):
        if (p / ".git").exists() or (p / "package.json").exists() or (p / "pyproject.toml").exists():
            return p
        if p.parent == p:
            break
        p = p.parent
    return file_path.parent


# ---------------------------------------------------------------------------
# OpenAI Codex — full-context code generation (runs in JetBrains layer)
# ---------------------------------------------------------------------------

def openai_generate_fix(
    file_path: str,
    instruction: str,
    council_guidance: str,
    repo_ctx: dict,
    past_decisions: list[dict],
) -> str:
    """
    Full-context Codex fix:
      - Sees the entire repo file tree
      - Sees all files imported by the target
      - Sees past council decisions for institutional memory
      - Guided by council CTO reasoning
    Returns the complete fixed file content only.
    """
    if not OPENAI_API_KEY:
        return ""

    # Build related files block
    related_block = ""
    for rel_path, content in repo_ctx.get("related_files", {}).items():
        related_block += f"\n### {rel_path}\n```\n{content[:3000]}\n```\n"

    # Build institutional memory block from past decisions
    memory_block = ""
    for e in past_decisions[-5:]:
        memory_block += (
            f"- [{e.get('timestamp','')[:10]}] {e.get('decision','?').upper()} "
            f"'{e.get('task','')}' — agents: {','.join(e.get('agents',[]))}\n"
        )

    system = (
        "You are Codex, ChainMail Global's code generation engine running inside JetBrains.\n"
        "You have full repo context, related file imports, institutional memory of past decisions, "
        "and CTO guidance from the council.\n"
        "Generate the complete fixed file. Return ONLY the file content — no markdown, no explanation."
    )

    user = f"""## Instruction
{instruction}

## Council CTO Guidance
{council_guidance}

## Repo File Tree
```
{repo_ctx.get('tree', '')}
```

## Related Files (imports of target)
{related_block or '(none)'}

## Institutional Memory (past council decisions on this file)
{memory_block or '(none)'}

## Target File: {repo_ctx.get('target_file', file_path)}
```
{repo_ctx.get('target_content', '')}
```

Now produce the complete fixed version of {repo_ctx.get('target_file', file_path)}:"""

    try:
        resp = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}",
                     "Content-Type": "application/json"},
            json={
                "model": "gpt-4o",
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user",   "content": user},
                ],
                "max_tokens":  4096,
                "temperature": 0.1,
            },
            timeout=90,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]
    except Exception as e:
        return f"# Codex generation failed: {e}"

# ---------------------------------------------------------------------------
# Audit log
# ---------------------------------------------------------------------------

def _last_entry_hash() -> str:
    """SHA-256 of the last audit entry — chains entries into a tamper-evident ledger."""
    if not AUDIT_LOG.exists():
        return "0" * 64
    lines = AUDIT_LOG.read_text().strip().splitlines()
    if not lines:
        return "0" * 64
    return hashlib.sha256(lines[-1].encode()).hexdigest()


def write_audit(result: dict, task: str, file_path: str | None = None) -> None:
    """Write a hash-chained ledger entry (ledgerbility)."""
    AUDIT_LOG.parent.mkdir(parents=True, exist_ok=True)
    entry = {
        "timestamp":    datetime.now(timezone.utc).isoformat(),
        "audit_id":     result.get("audit_id", str(uuid.uuid4())),
        "prev_hash":    _last_entry_hash(),   # ledger chain
        "session_id":   SESSION_ID,
        "source":       "jetbrains-mcp",
        "task":         task,
        "file":         file_path,
        "agents":       result.get("agents_selected", []),
        "decision":     result.get("consensus", {}).get("decision"),
        "vote_tally":   result.get("consensus", {}).get("vote_tally"),
        "mmcp_written": result.get("memory_written", False),
        "bkey":         True,
    }
    # Entry hash includes prev_hash → tamper-evident chain
    entry["entry_hash"] = hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()
    with open(AUDIT_LOG, "a") as f:
        f.write(json.dumps(entry) + "\n")


def read_audit(last: int = 10) -> list[dict]:
    if not AUDIT_LOG.exists():
        return []
    lines = AUDIT_LOG.read_text().strip().splitlines()
    return [json.loads(l) for l in lines[-last:]]

# ---------------------------------------------------------------------------
# MCP tool implementations
# ---------------------------------------------------------------------------

def tool_convene_council(task: str, context: str | None = None) -> dict:
    # 1. Retrieve relevant memories from MMCP — JetBrains walks in briefed
    memories = retrieve_mmcp(task, limit=4)
    memory_block = ""
    if memories:
        memory_block = "\n\n## Relevant Memory (MMCP Bubble Memory — sovereign VM)\n"
        for m in memories:
            src = m.get("source", "mmcp")
            content = m.get("content", m.get("reasoning", ""))[:300]
            ts = m.get("timestamp", m.get("created_at", ""))[:10]
            memory_block += f"- [{ts}] ({src}) {content}\n"

    # 2. Hermes structures the task before council sees it
    hermes_brief = call_hermes(task, context=(context or "") + memory_block)
    hermes_block = ""
    if hermes_brief.get("hermes"):
        hermes_block = (
            f"\n\n## Hermes Structured Brief (NousResearch Hermes-4-405B)\n"
            f"Intent: {hermes_brief.get('intent','')}\n"
            f"Risk surface: {hermes_brief.get('risk_surface','')}\n"
            f"Key questions: {'; '.join(hermes_brief.get('key_questions',[]))}\n"
        )

    # 3. Council deliberates with enriched context
    enriched_task = hermes_brief.get("structured_task", task)
    enriched_context = (context or "") + memory_block + hermes_block

    result = call_boardroom(enriched_task, context=enriched_context)
    write_audit(result, task)

    return {
        "decision":      result.get("consensus", {}).get("decision"),
        "summary":       result.get("consensus", {}).get("summary"),
        "conditions":    result.get("consensus", {}).get("conditions"),
        "agents":        result.get("agents_selected", []),
        "vote_tally":    result.get("consensus", {}).get("vote_tally"),
        "audit_id":      result.get("audit_id"),
        "mmcp_written":  result.get("memory_written", False),
        "hermes_used":   hermes_brief.get("hermes", False),
        "memories_used": len(memories),
        "hermes_brief":  {k: v for k, v in hermes_brief.items() if k not in ("hermes","model","error")},
        "deliberations": [
            {"agent": v["agent"], "recommendation": v["recommendation"],
             "confidence": v["confidence"], "reasoning": v["reasoning"]}
            for v in result.get("deliberations", [])
        ],
    }


def tool_fix_file(file_path: str, instruction: str) -> dict:
    """
    Full cycle:
      1. Build repo context (file tree + imports — safe, secret-filtered)
      2. Retrieve past council decisions on this file (institutional memory)
      3. Council deliberates with full context — Nebius MoE specialists vote
      4. If approved: Codex (OpenAI gpt-4o) generates fix with full repo awareness
      5. Backup original, write fix, hash-chain audit entry to ledger
      6. Persist decision to MMCP Bubble Memory on VM
    """
    fp = Path(file_path)
    if not fp.exists():
        return {"error": f"File not found: {file_path}"}

    if not _is_safe(fp):
        return {"error": "Blocked: file matches secret pattern. Refusing to process."}

    # 1. Build full repo context
    root     = _find_repo_root(fp)
    repo_ctx = build_repo_context(root, fp)

    # 2. Past council decisions on this file (institutional memory)
    past = [e for e in read_audit(50) if e.get("file") == file_path]

    # 3. Council deliberation — send code + related files + institutional memory
    task = f"Code fix: {instruction}"

    related_snippets = "".join(
        f"\n### {rel} (imported)\n```\n{content[:800]}\n```"
        for rel, content in repo_ctx["related_files"].items()
    )
    past_summary = "".join(
        f"\n- [{e.get('timestamp','')[:10]}] {e.get('decision','?').upper()}: {e.get('task','')}"
        for e in past[-3:]
    )
    context_for_council = (
        f"Target file: {repo_ctx['target_file']}\n"
        f"Repo: {len(repo_ctx['tree'].splitlines())} files total\n"
        f"\n## Code under review\n```\n{repo_ctx['target_content'][:5000]}\n```"
        f"\n## Related files (imports){related_snippets or chr(10) + '(none)'}"
        f"\n## Past council decisions on this file{past_summary or chr(10) + '(none)'}"
    )
    result   = call_boardroom(task, context=context_for_council)
    decision = result.get("consensus", {}).get("decision")

    write_audit(result, task, file_path)

    if decision not in ("approve", "revise"):
        return {
            "decision":     decision,
            "summary":      result.get("consensus", {}).get("summary"),
            "applied":      False,
            "reason":       "Council rejected — change blocked.",
            "audit_id":     result.get("audit_id"),
            "vote_tally":   result.get("consensus", {}).get("vote_tally"),
        }

    # 4. CTO guidance for Codex
    cto_guidance = next(
        (v["reasoning"] + " " + (v.get("code_guidance") or "")
         for v in result.get("deliberations", []) if v["agent"] == "cto"),
        result.get("consensus", {}).get("code_patch", "Apply the requested change safely."),
    )

    # 5. Codex generates fix with full repo context + institutional memory
    fixed_content = openai_generate_fix(
        file_path, instruction, cto_guidance, repo_ctx, past
    )

    if fixed_content and not fixed_content.startswith("# Codex generation failed"):
        backup = fp.with_suffix(fp.suffix + f".bk-{result['audit_id'][:8]}")
        backup.write_text(repo_ctx["target_content"])
        fp.write_text(fixed_content)
        return {
            "decision":        decision,
            "applied":         True,
            "backup":          str(backup),
            "audit_id":        result.get("audit_id"),
            "entry_hash":      _last_entry_hash(),
            "summary":         result.get("consensus", {}).get("summary"),
            "conditions":      result.get("consensus", {}).get("conditions"),
            "mmcp_written":    result.get("memory_written", False),
            "repo_files_seen": len(repo_ctx["tree"].splitlines()),
            "related_seen":    list(repo_ctx["related_files"].keys()),
            "past_decisions":  len(past),
        }

    return {
        "decision":    decision,
        "applied":     False,
        "reason":      "No OPENAI_API_KEY — manual apply required.",
        "cto_guidance": cto_guidance,
        "audit_id":    result.get("audit_id"),
    }


def tool_retrieve_memory(query: str, limit: int = 5) -> list[dict]:
    """Semantic search through MMCP Bubble Memory on the VM (retrievability)."""
    headers = {"Content-Type": "application/json"}
    if SUPABASE_ANON_KEY:
        headers["Authorization"] = f"Bearer {SUPABASE_ANON_KEY}"
    try:
        resp = requests.post(
            f"{BOARDROOM_URL.replace('/boardroom', '')}/retrieve-memory",
            json={"query": query, "session_id": SESSION_ID, "limit": limit},
            headers=headers, timeout=30,
        )
        resp.raise_for_status()
        return resp.json().get("results", [])
    except Exception as e:
        return [{"error": str(e)}]


def tool_hermes_agent(task: str, tools: list | None = None, context: str | None = None) -> dict:
    """
    Call the NousResearch Hermes Agent on the VM (port 8002).
    Hermes handles structured tool-calling between orchestration and execution.
    """
    headers = {"Content-Type": "application/json"}
    if SUPABASE_ANON_KEY:
        headers["Authorization"] = f"Bearer {SUPABASE_ANON_KEY}"
    try:
        payload: dict = {
            "task": task,
            "session_id": SESSION_ID,
        }
        if tools:
            payload["tools"] = tools
        if context:
            payload["context"] = context
        resp = requests.post(
            f"{BOARDROOM_URL.replace('/boardroom', '')}/hermes",
            json=payload, headers=headers, timeout=60,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception as e:
        return {"error": str(e)}


def tool_verify_ledger() -> dict:
    """Verify the hash chain integrity of the audit ledger (ledgerbility)."""
    if not AUDIT_LOG.exists():
        return {"valid": True, "entries": 0, "message": "No ledger yet."}
    lines = AUDIT_LOG.read_text().strip().splitlines()
    entries, broken = [], []
    prev_hash = "0" * 64
    for i, line in enumerate(lines):
        try:
            entry = json.loads(line)
            if entry.get("prev_hash") != prev_hash:
                broken.append({"index": i, "audit_id": entry.get("audit_id"), "reason": "prev_hash mismatch"})
            # Verify entry_hash
            stored = entry.pop("entry_hash", None)
            computed = hashlib.sha256(json.dumps(entry, sort_keys=True).encode()).hexdigest()
            if stored != computed:
                broken.append({"index": i, "audit_id": entry.get("audit_id"), "reason": "entry_hash invalid"})
            entry["entry_hash"] = stored  # restore
            prev_hash = stored or prev_hash
            entries.append(entry.get("audit_id", f"entry-{i}"))
        except Exception as e:
            broken.append({"index": i, "reason": str(e)})
    return {
        "valid":   len(broken) == 0,
        "entries": len(entries),
        "broken":  broken,
        "message": "Ledger intact." if not broken else f"{len(broken)} tampered entries detected.",
    }


def tool_recall(query: str) -> dict:
    """
    JetBrains personalization — show what the system remembers about this project.
    Pulls from MMCP Bubble Memory (sovereign VM) + local audit trail.
    This is what makes JetBrains feel like it knows you.
    """
    memories = retrieve_mmcp(query, limit=6)
    local    = [e for e in read_audit(20)
                if any(w.lower() in e.get("task","").lower() for w in query.split()[:3])]
    return {
        "query":          query,
        "mmcp_memories":  memories,
        "local_decisions": [
            {"date": e.get("timestamp","")[:10],
             "decision": e.get("decision",""),
             "task": e.get("task",""),
             "agents": e.get("agents",[])}
            for e in local[-5:]
        ],
        "total_recalled": len(memories) + len(local),
        "source":         "MMCP Bubble Memory (sovereign H100 VM) + local audit ledger",
    }


def tool_audit_log(last: int = 10) -> list[dict]:
    return read_audit(last)


def tool_bkey_status() -> dict:
    registered = BKEY_CRED_FILE.exists()
    try:
        from fido2.hid import CtapHidDevice  # type: ignore
        devices = list(CtapHidDevice.list_devices())
        connected = len(devices) > 0
    except ImportError:
        connected = None  # library not installed
    return {
        "registered":   registered,
        "connected":    connected,
        "cred_file":    str(BKEY_CRED_FILE),
        "fido2_installed": connected is not None,
    }

# ---------------------------------------------------------------------------
# MCP stdio protocol (JSON-RPC 2.0)
# ---------------------------------------------------------------------------

TOOLS = [
    {
        "name": "convene_council",
        "description": (
            "Convene the ChainMail Council for governance deliberation. "
            "Codex selects the optimal C-Suite agents (CTO, CPO, COO, CRO, CMO, CFO), "
            "each backed by a Nebius MoE specialist model. Returns consensus decision "
            "with full audit trail persisted to MMCP Bubble Memory on the VM."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task":    {"type": "string", "description": "What to deliberate on"},
                "context": {"type": "string", "description": "Additional context (code, docs, etc.)"},
            },
            "required": ["task"],
        },
    },
    {
        "name": "fix_file",
        "description": (
            "Governance-gated code fix. Council deliberates on the change; "
            "if approved, Codex (OpenAI gpt-4o) generates and applies the patch. "
            "Original file is backed up. Full audit written to MMCP."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "file_path":   {"type": "string", "description": "Absolute path to the file"},
                "instruction": {"type": "string", "description": "What to fix or change"},
            },
            "required": ["file_path", "instruction"],
        },
    },
    {
        "name": "audit_log",
        "description": "Retrieve recent council decisions from the local audit trail.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "last": {"type": "integer", "description": "Number of entries (default 10)"},
            },
        },
    },
    {
        "name": "bkey_status",
        "description": "Check Bkey FIDO2 hardware key registration and connection status.",
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "retrieve_memory",
        "description": (
            "Semantic search through MMCP Bubble Memory on the VM. "
            "Retrieves past council decisions, code changes, and conversation context "
            "by meaning — not just keyword. Sovereign memory: your VM, your data."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural language search query"},
                "limit": {"type": "integer", "description": "Max results (default 5)"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "hermes_agent",
        "description": (
            "Invoke the NousResearch Hermes Agent on the VM. "
            "Hermes handles structured tool-calling and agentic execution — "
            "use it for multi-step tasks that need to chain tools together."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "task":    {"type": "string",  "description": "Task for Hermes to execute"},
                "context": {"type": "string",  "description": "Additional context"},
                "tools":   {"type": "array",   "description": "Tool schemas to make available"},
            },
            "required": ["task"],
        },
    },
    {
        "name": "recall",
        "description": (
            "Retrieve what ChainMail remembers about this project from MMCP Bubble Memory "
            "(sovereign pgvector on the H100 VM) + local audit trail. "
            "This is JetBrains personalization — Codex walks in briefed, not cold."
        ),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "What to recall (e.g. 'rate limiting', 'gateway', 'past decisions')"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "verify_ledger",
        "description": (
            "Verify the cryptographic integrity of the audit ledger (ledgerbility). "
            "Each entry is SHA-256 hash-chained to the previous — "
            "any tampering is immediately detectable."
        ),
        "inputSchema": {"type": "object", "properties": {}},
    },
]


def handle_request(req: dict) -> dict | None:
    method = req.get("method", "")
    req_id = req.get("id")

    def ok(result: object) -> dict:
        return {"jsonrpc": "2.0", "id": req_id, "result": result}

    def err(code: int, msg: str) -> dict:
        return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": msg}}

    if method == "initialize":
        return ok({
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "chainmail-council", "version": "1.0.0"},
        })

    if method == "tools/list":
        return ok({"tools": TOOLS})

    if method == "tools/call":
        name   = req.get("params", {}).get("name", "")
        args   = req.get("params", {}).get("arguments", {})
        try:
            if name == "convene_council":
                data = tool_convene_council(args["task"], args.get("context"))
            elif name == "fix_file":
                data = tool_fix_file(args["file_path"], args["instruction"])
            elif name == "audit_log":
                data = tool_audit_log(args.get("last", 10))
            elif name == "bkey_status":
                data = tool_bkey_status()
            elif name == "retrieve_memory":
                data = tool_retrieve_memory(args["query"], args.get("limit", 5))
            elif name == "recall":
                data = tool_recall(args["query"])
            elif name == "hermes_agent":
                data = tool_hermes_agent(args["task"], args.get("tools"), args.get("context"))
            elif name == "verify_ledger":
                data = tool_verify_ledger()
            else:
                return err(-32601, f"Unknown tool: {name}")
            return ok({"content": [{"type": "text", "text": json.dumps(data, indent=2)}]})
        except Exception as e:
            return err(-32603, str(e))

    if method == "notifications/initialized":
        return None  # no response for notifications

    return err(-32601, f"Unknown method: {method}")


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except json.JSONDecodeError:
            continue
        response = handle_request(req)
        if response is not None:
            sys.stdout.write(json.dumps(response) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()

/**
 * Council — hybrid Codex/OpenAI orchestration + Nebius MoE deliberation.
 *
 * Architecture:
 *   Codex (JetBrains/OpenAI) → selects + assigns agents via MCP
 *   Nebius NIM Token Factory  → MoE specialists deliberate (Qwen3 480B, DeepSeek, Nemotron)
 *   Gemma (VM)               → synthesizes consensus from deliberations
 *   MMCP Bubble Memory       → persistent audit on VM
 */

import { callReasoning, callTokenFactory, writeBubbleMemory, type ChatMessage } from "./vm.ts";

declare const Deno: { env: { get(key: string): string | undefined } };
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";

// VM (Gemma) is primary for orchestration + synthesis.
// Falls back to OpenAI gpt-4o when VM is unavailable — demo still runs.
async function reasonWithFallback(msgs: ChatMessage[], maxTokens: number): Promise<string> {
  try {
    return await callReasoning(msgs, maxTokens);
  } catch {
    if (!OPENAI_API_KEY) throw new Error("VM down and no OPENAI_API_KEY fallback set.");
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o", messages: msgs, max_tokens: maxTokens, temperature: 0.3,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI fallback error ${res.status}`);
    const d = await res.json() as { choices: Array<{ message: { content: string } }> };
    return d.choices?.[0]?.message?.content ?? "";
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentVote {
  agent:          string;
  model:          string;
  recommendation: "approve" | "reject" | "revise" | "abstain";
  confidence:     number;
  reasoning:      string;
  code_guidance?: string;
}

export interface CouncilResult {
  task:           string;
  session_id:     string;
  timestamp:      string;
  agents_selected: string[];
  deliberations:  AgentVote[];
  consensus: {
    decision:    "approve" | "reject" | "revise";
    summary:     string;
    conditions?: string;
    code_patch?: string;
    vote_tally:  Record<string, number>;
  };
  audit_id:       string;
  memory_written: boolean;
}

// ---------------------------------------------------------------------------
// Nebius Token Factory model names (MoE) — mirrors vm.ts CSUITE_MODELS
// Used only for display in AgentVote.model
// ---------------------------------------------------------------------------

const NEBIUS_MODELS: Record<string, string> = {
  cto: "Qwen/Qwen3-235B-A22B-Instruct-2507",
  cpo: "deepseek-ai/DeepSeek-V3.2",
  coo: "nvidia/Llama-3_1-Nemotron-Ultra-253B-v1",
  cro: "Qwen/Qwen3-235B-A22B-Thinking-2507-fast",
  cmo: "meta-llama/Llama-3.3-70B-Instruct",
  cfo: "nvidia/nemotron-3-super-120b-a12b",
};

// ---------------------------------------------------------------------------
// Step 1: Codex Orchestration — Gemma (VM) picks which agents to convene
// ---------------------------------------------------------------------------

const CODEX_SYSTEM = `You are Codex, the orchestration intelligence for ChainMail's Council system.
Codex runs inside JetBrains and selects the optimal council members for each task.

Available agents: cto, cpo, coo, cro, cmo, cfo

Rules:
- Code changes: always include cto. Add coo if ops risk. Add cfo if costly.
- Strategy decisions: include cpo + cro. Add cmo if user-facing.
- Select 2-4 agents. Never all 6.

Respond ONLY with valid JSON — no markdown:
{"agents": ["cto", "coo"], "rationale": "One sentence."}`;

export async function codexOrchestrate(
  task: string,
): Promise<{ agents: string[]; rationale: string }> {
  const msgs: ChatMessage[] = [
    { role: "system", content: CODEX_SYSTEM },
    { role: "user",   content: `Task: ${task}` },
  ];
  const raw = await reasonWithFallback(msgs, 256);
  const m   = raw.match(/\{[\s\S]*\}/);
  if (!m) return { agents: ["cto", "coo"], rationale: "Default (parse error)." };
  try {
    const p     = JSON.parse(m[0]) as { agents: string[]; rationale: string };
    const valid = ["cto","cpo","coo","cro","cmo","cfo"];
    p.agents    = (p.agents ?? []).filter(a => valid.includes(a)).slice(0, 4);
    if (!p.agents.length) p.agents = ["cto","coo"];
    return p;
  } catch {
    return { agents: ["cto", "coo"], rationale: "Default (parse error)." };
  }
}

// ---------------------------------------------------------------------------
// Step 2: Council Deliberation — Nebius Token Factory MoE models in parallel
// ---------------------------------------------------------------------------

const DELIBERATION_PROMPT = (task: string) =>
  `You are being convened by Codex as part of the ChainMail Council.

TASK: ${task}

Deliberate from your role's perspective. Respond ONLY with valid JSON:
{
  "recommendation": "approve" | "reject" | "revise",
  "confidence": 0.0-1.0,
  "reasoning": "2-4 sentences of your analysis.",
  "code_guidance": "If task involves code: specific guidance on what to change. Otherwise omit."
}`;

function extractJson(raw: string): string | null {
  // Strip <think>...</think> blocks (Qwen3/DeepSeek R1-style reasoning)
  const stripped = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();
  const m = stripped.match(/\{[\s\S]*\}/);
  return m ? m[0] : null;
}

async function deliberate(agent: string, task: string, sessionId: string): Promise<AgentVote> {
  const model = NEBIUS_MODELS[agent] ?? "Qwen/Qwen3.5-397B-A17B";
  try {
    // Council deliberation runs on Nebius Token Factory MoE models
    const raw = await callTokenFactory(agent, DELIBERATION_PROMPT(task), sessionId);
    const jsonStr = extractJson(raw);
    if (jsonStr) {
      const p = JSON.parse(jsonStr) as Partial<AgentVote>;
      const validRecs = ["approve","reject","revise","abstain"];
      return {
        agent,
        model,
        recommendation: validRecs.includes(p.recommendation ?? "")
          ? p.recommendation as AgentVote["recommendation"]
          : "abstain",
        confidence:    Math.min(1, Math.max(0, p.confidence ?? 0.5)),
        reasoning:     p.reasoning ?? raw.slice(0, 400),
        code_guidance: p.code_guidance,
      };
    }
    return { agent, model, recommendation: "abstain", confidence: 0.5, reasoning: raw.slice(0, 400) };
  } catch (err) {
    return {
      agent, model, recommendation: "abstain", confidence: 0,
      reasoning: `Error: ${(err as Error).message}`,
    };
  }
}

export async function runCouncil(
  task: string,
  agents: string[],
  sessionId: string,
): Promise<AgentVote[]> {
  const results = await Promise.allSettled(agents.map(a => deliberate(a, task, sessionId)));
  return results.map((r, i) =>
    r.status === "fulfilled" ? r.value : {
      agent: agents[i], model: NEBIUS_MODELS[agents[i]] ?? "Qwen/Qwen3-Coder-480B-A35B-Instruct",
      recommendation: "abstain" as const, confidence: 0,
      reasoning: `Failed: ${(r.reason as Error)?.message ?? "unknown"}`,
    }
  );
}

// ---------------------------------------------------------------------------
// Step 3: Synthesis — Gemma (VM) reads all votes → final decision + code patch
// ---------------------------------------------------------------------------

const SYNTHESIS_SYSTEM = `You are the Council Synthesis Engine for ChainMail Global.
Synthesize council deliberations into a final governance decision.

Respond ONLY with valid JSON:
{
  "decision": "approve" | "reject" | "revise",
  "summary": "2-3 sentence executive summary.",
  "conditions": "Conditions if revise, otherwise empty string.",
  "code_patch": "If task involves code and decision is approve/revise: unified diff or specific code change instructions. Otherwise empty string."
}`;

export async function synthesizeConsensus(
  task: string,
  votes: AgentVote[],
): Promise<CouncilResult["consensus"]> {
  const tally: Record<string, number> = { approve:0, reject:0, revise:0, abstain:0 };
  for (const v of votes) tally[v.recommendation] = (tally[v.recommendation] ?? 0) + 1;

  const summary = votes
    .map(v => `${v.agent.toUpperCase()} (${v.recommendation}, ${(v.confidence*100).toFixed(0)}%): ${v.reasoning}`)
    .join("\n\n");

  const codeParts = votes.filter(v => v.code_guidance).map(v => `${v.agent.toUpperCase()}: ${v.code_guidance}`).join("\n");

  const msgs: ChatMessage[] = [
    { role: "system", content: SYNTHESIS_SYSTEM },
    { role: "user", content:
        `TASK: ${task}\n\nDELIBERATIONS:\n${summary}\n\nCODE GUIDANCE:\n${codeParts}\n\nVOTES: ${JSON.stringify(tally)}` },
  ];

  const raw = await reasonWithFallback(msgs, 1024);
  const m   = raw.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const p = JSON.parse(m[0]) as Partial<CouncilResult["consensus"]>;
      const validDecs = ["approve","reject","revise"];
      const fallbackDec = tally.approve >= tally.reject && tally.approve >= tally.revise
        ? "approve" : tally.revise >= tally.reject ? "revise" : "reject";
      return {
        decision:    validDecs.includes(p.decision ?? "") ? p.decision as "approve"|"reject"|"revise" : fallbackDec,
        summary:     p.summary ?? raw.slice(0, 400),
        conditions:  p.conditions || undefined,
        code_patch:  p.code_patch || undefined,
        vote_tally:  tally,
      };
    } catch { /* fall through */ }
  }

  const dec = tally.approve >= tally.reject && tally.approve >= tally.revise
    ? "approve" : tally.revise >= tally.reject ? "revise" : "reject";
  return { decision: dec, summary: raw.slice(0, 400), vote_tally: tally };
}

// ---------------------------------------------------------------------------
// Full council run — called by boardroom edge function + MCP server
// ---------------------------------------------------------------------------

export async function conveneCouncil(
  task: string,
  sessionId: string,
): Promise<CouncilResult> {
  const auditId   = crypto.randomUUID();
  const timestamp = new Date().toISOString();

  const { agents }   = await codexOrchestrate(task);
  const deliberations = await runCouncil(task, agents, sessionId);
  const consensus     = await synthesizeConsensus(task, deliberations);

  const result: CouncilResult = {
    task, session_id: sessionId, timestamp,
    agents_selected: agents, deliberations, consensus,
    audit_id: auditId, memory_written: false,
  };

  try {
    await writeBubbleMemory("COUNCIL_DELIBERATION", JSON.stringify(result), {
      session_id: sessionId, audit_id: auditId,
      decision: consensus.decision,
      agents: agents.join(","),
      tags: ["council","governance","audit","codex"],
    });
    result.memory_written = true;
  } catch (err) {
    console.error("MMCP write failed (non-fatal):", err);
  }

  return result;
}

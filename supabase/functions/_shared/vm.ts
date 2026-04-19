/**
 * HTTP helpers for calling VM endpoints (vLLM, MMCP, Hermes) and Token Factory (NVIDIA NIM).
 *
 * Architecture:
 *   Eyes    = Qwen VL on port 8001 (vision, OCR)
 *   Ears    = Gemma 4 on port 8000 (reasoning, interpretation)
 *   Hermes  = NousResearch Hermes Agent on port 8002 (tool-calling agent, structured output)
 *   C-Suite = Token Factory NVIDIA NIM (heavy specialist models, on-demand)
 *   Memory  = MMCP Bubble Memory (persistent sovereign memory)
 */

// Deno runtime globals (Supabase edge functions run on Deno)
declare const Deno: { env: { get(key: string): string | undefined } };

const VM_BASE            = "https://api.chainmail.global";
const TOKEN_FACTORY_BASE = "https://api.tokenfactory.nebius.com/v1";
const TOKEN_FACTORY_KEY  = Deno.env.get("NEBIUS_API_KEY") ?? "";
const MMCP_UI_TOKEN      = Deno.env.get("MMCP_UI_TOKEN") ?? "";

const INFERENCE_TIMEOUT_MS = 60_000;

// ---------------------------------------------------------------------------
// Generic fetchers
// ---------------------------------------------------------------------------

async function vmFetch(
  url: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`VM returned ${res.status}: ${text}`);
    }

    return (await res.json()) as Record<string, unknown>;
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`VM request timed out after ${INFERENCE_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function nimFetch(
  model: string,
  messages: ChatMessage[],
  maxTokens = 2048,
  temperature = 0.2,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);

  try {
    const res = await fetch(`${TOKEN_FACTORY_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${TOKEN_FACTORY_KEY}`,
      },
      body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Token Factory returned ${res.status}: ${text}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    return data.choices?.[0]?.message?.content ?? "";
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      throw new Error(`Token Factory timed out after ${INFERENCE_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<Record<string, unknown>>;
}

interface ChatCompletionChoice {
  message: { content: string };
}

interface ChatCompletionResponse {
  choices: ChatCompletionChoice[];
}

// ---------------------------------------------------------------------------
// Eyes — Qwen VL (port 8001)
// ---------------------------------------------------------------------------

export async function callVision(
  messages: ChatMessage[],
  maxTokens = 1024,
): Promise<string> {
  const data = (await vmFetch(
    `${VM_BASE}/vision/v1/chat/completions`,
    { model: "vision", messages, max_tokens: maxTokens, temperature: 0.3 },
  )) as unknown as ChatCompletionResponse;

  return data.choices?.[0]?.message?.content ?? "";
}

export function visionMessage(imageBase64: string, prompt: string): ChatMessage {
  return {
    role: "user",
    content: [
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
      { type: "text", text: prompt },
    ],
  };
}

// ---------------------------------------------------------------------------
// Ears — Gemma 4 (port 8000)
// ---------------------------------------------------------------------------

export async function callReasoning(
  messages: ChatMessage[],
  maxTokens = 1024,
): Promise<string> {
  const data = (await vmFetch(
    `${VM_BASE}/reasoning/v1/chat/completions`,
    { model: "reasoning", messages, max_tokens: maxTokens, temperature: 0.7 },
  )) as unknown as ChatCompletionResponse;

  return data.choices?.[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// Hermes — NousResearch Hermes Agent (port 8002)
// Tool-calling agent with structured XML output format.
// Acts as the agentic execution layer between orchestration and action.
// ---------------------------------------------------------------------------

export interface HermesTool {
  name:        string;
  description: string;
  parameters:  Record<string, unknown>; // JSON Schema
}

export interface HermesToolCall {
  name:      string;
  arguments: Record<string, unknown>;
}

export async function callHermes(
  messages:  ChatMessage[],
  tools:     HermesTool[] = [],
  maxTokens  = 2048,
): Promise<{ content: string; tool_calls: HermesToolCall[] }> {
  const body: Record<string, unknown> = {
    model: "hermes",
    messages,
    max_tokens: maxTokens,
    temperature: 0.3,
  };
  if (tools.length) body.tools = tools;

  const data = (await vmFetch(
    `${VM_BASE}/hermes/v1/chat/completions`,
    body,
  )) as unknown as {
    choices: Array<{
      message: {
        content:    string;
        tool_calls?: Array<{ function: { name: string; arguments: string } }>;
      };
    }>;
  };

  const msg        = data.choices?.[0]?.message;
  const content    = msg?.content ?? "";
  const tool_calls = (msg?.tool_calls ?? []).map(tc => ({
    name:      tc.function.name,
    arguments: JSON.parse(tc.function.arguments || "{}") as Record<string, unknown>,
  }));

  return { content, tool_calls };
}

// ---------------------------------------------------------------------------
// C-Suite — Token Factory NVIDIA NIM (heavy specialists, on-demand)
// ---------------------------------------------------------------------------

const CSUITE_MODELS: Record<string, string> = {
  cto: "Qwen/Qwen3-235B-A22B-Instruct-2507",
  cpo: "deepseek-ai/DeepSeek-V3.2",
  coo: "nvidia/Llama-3_1-Nemotron-Ultra-253B-v1",
  cro: "Qwen/Qwen3-235B-A22B-Thinking-2507-fast",
  cmo: "meta-llama/Llama-3.3-70B-Instruct",
  cfo: "nvidia/nemotron-3-super-120b-a12b",
};

const CSUITE_PERSONAS: Record<string, string> = {
  cto: "You are the CTO of ChainMail Global, an AR intelligence platform. Expert in technical architecture, engineering, and code. Be direct and precise.",
  cpo: "You are the CPO of ChainMail Global. Expert in product strategy, user experience, and roadmap prioritization. Be direct and concise.",
  coo: "You are the COO of ChainMail Global. Expert in operations, process design, and execution. Be direct and concise.",
  cro: "You are the CRO of ChainMail Global. Expert in revenue strategy, growth, and partnerships. Be direct and concise.",
  cmo: "You are the CMO of ChainMail Global. Expert in narrative, positioning, and go-to-market. Be direct and concise.",
  cfo: "You are the CFO of ChainMail Global. Expert in financial strategy, unit economics, and fundraising. Be direct and concise.",
};

export async function callTokenFactory(
  agent: string,
  prompt: string,
  _sessionId: string,
): Promise<string> {
  const model = CSUITE_MODELS[agent];
  if (!model) throw new Error(`Unknown C-Suite agent: ${agent}`);

  const persona = CSUITE_PERSONAS[agent] ??
    `You are the ${agent.toUpperCase()} of ChainMail Global. Be direct and concise.`;

  return nimFetch(model, [
    { role: "system", content: persona },
    { role: "user", content: prompt },
  ]);
}

// ---------------------------------------------------------------------------
// Bubble Memory — MMCP (background writes only)
// ---------------------------------------------------------------------------

const MMCP_BASE = `${VM_BASE}/mmcp`;

// ---------------------------------------------------------------------------
// Bubble Memory — read (semantic search via pgvector)
// ---------------------------------------------------------------------------

export interface BubbleResult {
  id:         string;
  event_type: string;
  content:    string;
  metadata:   Record<string, unknown>;
  score:      number;
  created_at: string;
}

export async function retrieveBubbleMemory(
  query: string,
  sessionId?: string,
  limit = 5,
): Promise<BubbleResult[]> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);
  try {
    const res = await fetch(`${MMCP_BASE}/bubbles/search`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(MMCP_UI_TOKEN ? { "Authorization": `Bearer ${MMCP_UI_TOKEN}` } : {}),
      },
      body: JSON.stringify({ query, session_id: sessionId, limit }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MMCP search returned ${res.status}: ${text}`);
    }
    const data = (await res.json()) as { results?: BubbleResult[] };
    return data.results ?? [];
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Bubble Memory — write
// ---------------------------------------------------------------------------

export async function writeBubbleMemory(
  eventType: string,
  content: string,
  metadata: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionId = (metadata.session_id as string) ?? "spectacles";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INFERENCE_TIMEOUT_MS);
  try {
    const res = await fetch(`${MMCP_BASE}/bubbles/event`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(MMCP_UI_TOKEN ? { "Authorization": `Bearer ${MMCP_UI_TOKEN}` } : {}),
      },
      body: JSON.stringify({
        session_id: sessionId,
        event_type: eventType,
        payload: { content, ...metadata },
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MMCP returned ${res.status}: ${text}`);
    }
    return (await res.json()) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * AI assistant: providers and the tool-use loop.
 *
 * The assistant changes the design only through the design API (designApi.ts),
 * so every change is validated, rebuilt and undoable, and any provider that
 * supports tool calling can drive it:
 *
 *   anthropic  Claude, through the official Anthropic SDK
 *   openai     any OpenAI-compatible endpoint: OpenAI, Ollama, LM Studio,
 *              OpenRouter, vLLM, LocalAI…
 *
 * Provider settings (including API keys) stay in this browser's storage.
 * Requests go straight from this device to the provider you choose.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { create } from "zustand";
import { DESIGN_TOOLS, runDesignTool } from "./designApi";
import { writeStored } from "./stored";
import { toast } from "./store";

export type ProviderKind = "anthropic" | "openai";

export interface ProviderConfig {
  id: string;
  label: string;
  kind: ProviderKind;
  /** OpenAI-compatible endpoints only, e.g. http://localhost:11434/v1 */
  baseUrl: string;
  model: string;
  apiKey: string;
}

export interface ProviderPreset {
  id: string;
  label: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  needsKey: boolean;
  blurb: string;
}

export const PRESETS: ProviderPreset[] = [
  { id: "claude", label: "Claude (Anthropic)", kind: "anthropic", baseUrl: "", model: "claude-opus-5-5", needsKey: true, blurb: "Anthropic's Claude models. Needs an API key from console.anthropic.com." },
  { id: "openai", label: "OpenAI", kind: "openai", baseUrl: "https://api.openai.com/v1", model: "", needsKey: true, blurb: "Any OpenAI chat model with tool calling. Needs an API key." },
  { id: "ollama", label: "Ollama (local)", kind: "openai", baseUrl: "http://localhost:11434/v1", model: "qwen2.5:14b", needsKey: false, blurb: "Runs on your own computer (or another one on your network: use its address, e.g. http://192.168.1.20:11434/v1, and start Ollama with OLLAMA_HOST=0.0.0.0). Set OLLAMA_ORIGINS to allow this app, and pull a tool-capable model." },
  { id: "lmstudio", label: "LM Studio (local)", kind: "openai", baseUrl: "http://localhost:1234/v1", model: "", needsKey: false, blurb: "Local models through LM Studio's server (enable CORS in its settings)." },
  { id: "openrouter", label: "OpenRouter", kind: "openai", baseUrl: "https://openrouter.ai/api/v1", model: "", needsKey: true, blurb: "Many hosted models behind one key." },
  { id: "custom", label: "Other (OpenAI-compatible)", kind: "openai", baseUrl: "", model: "", needsKey: false, blurb: "vLLM, LocalAI, a company gateway or any endpoint that speaks the OpenAI chat API." },
];

/* ───────────────────────────── Settings ───────────────────────────── */

export interface AiSettings {
  providers: ProviderConfig[];
  active: string | null;
}

export const NO_AI_SETTINGS: AiSettings = { providers: [], active: null };

export function saveAiSettings(s: AiSettings) {
  useAi.setState({ settings: s });
  // Kept in the server's database (or, with no server, on this device) — never in the browser when a server is used.
  void writeStored("ai", s, 500).catch(() => toast("warn", "Couldn't save the assistant settings. They will be lost when you close this page."));
}

/* ───────────────────────────── Conversation ───────────────────────────── */

export type ChatItem =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; input: Record<string, unknown>; result?: Record<string, unknown> }
  | { kind: "error"; text: string };

interface AiState {
  settings: AiSettings;
  items: ChatItem[];
  busy: boolean;
  abort: AbortController | null;
}

export const useAi = create<AiState>(() => ({ settings: NO_AI_SETTINGS, items: [], busy: false, abort: null }));

export function activeProvider(): ProviderConfig | undefined {
  const { settings } = useAi.getState();
  return settings.providers.find((p) => p.id === settings.active) ?? settings.providers[0];
}

const SYSTEM = `You are the design assistant inside Whittle, a parametric 3D CAD application used by beginners, makers, engineers and designers.
You change the open design only through the provided tools. Lengths are in the design's units (usually millimetres), angles in degrees; any value may be a formula using parameters.
How to work:
- Call get_design first to see parameters, the timeline and bodies.
- Prefer named parameters for key dimensions (set_parameter), then use them in formulas, so the person can edit the design later.
- Build like a CAD user: sketch on a plane or face, then extrude / revolve / loft / sweep; use primitives for quick blocks; then fillet, shell, holes, patterns.
- After each change, check the returned status. If it's an error, read the message (and suggested_fix) and correct it.
- Keep changes focused on what was asked. When something is ambiguous, make a sensible choice and say what you chose.
- Finish with a short summary of what you changed and how to adjust it (which parameters to edit).`;

function push(item: ChatItem) {
  useAi.setState((s) => ({ items: [...s.items, item] }));
}
function patchLastTool(result: Record<string, unknown>) {
  useAi.setState((s) => {
    const items = [...s.items];
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.kind === "tool" && !it.result) {
        items[i] = { ...it, result };
        break;
      }
    }
    return { items };
  });
}

/** Turns allowed per request, so a confused model can't loop forever. */
const MAX_TURNS = 24;

export function stopAssistant() {
  useAi.getState().abort?.abort();
}

export function clearConversation() {
  history.length = 0;
  oaiHistory.length = 0;
  useAi.setState({ items: [] });
}

/* ───────────────────────────── Claude ───────────────────────────── */

const history: Anthropic.Beta.BetaMessageParam[] = [];

/** Models that accept server-side refusal fallbacks ("default" routing). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);
/** Models that take `output_config.effort` (older ones, such as Haiku 4.5, reject it). */
const EFFORT_MODELS = new Set([...FALLBACK_MODELS, "claude-fable-5", "claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-5", "claude-haiku-5-5"]);

/** Claude errors as friendly messages (the SDK is loaded only when Claude is used). */
async function runClaude(p: ProviderConfig, text: string, signal: AbortSignal) {
  const { default: SDK } = await import("@anthropic-ai/sdk");
  try {
    await claudeLoop(new SDK({ apiKey: p.apiKey, dangerouslyAllowBrowser: true }), p, text, signal);
  } catch (e) {
    if (signal.aborted) throw e;
    if (e instanceof SDK.AuthenticationError) throw new Error("The API key was rejected. Check it in Settings → AI assistant.");
    if (e instanceof SDK.RateLimitError) throw new Error("Rate limited by the provider. Wait a moment and try again.");
    if (e instanceof SDK.APIConnectionError) throw new Error("Couldn't reach the Claude API. Check your connection.");
    if (e instanceof SDK.APIError) throw new Error(`Claude API error ${e.status ?? ""}: ${e.message}`);
    throw e;
  }
}

/**
 * A turn that ended with tool calls never answered (cut off, refused, stopped) would make every later request
 * fail: the API wants a result for each call. Answer them as not run.
 */
function closeOpenToolCalls() {
  const last = history[history.length - 1];
  if (last?.role !== "assistant" || !Array.isArray(last.content)) return;
  const open = last.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => (b as { type?: string }).type === "tool_use");
  if (!open.length) return;
  history.push({ role: "user", content: open.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, content: "Not run: the turn ended first.", is_error: true })) });
}

async function claudeLoop(client: Anthropic, p: ProviderConfig, text: string, signal: AbortSignal) {
  const tools = DESIGN_TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) as Anthropic.Beta.BetaTool[];
  closeOpenToolCalls();
  history.push({ role: "user", content: text });
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const fallback = FALLBACK_MODELS.has(p.model);
    const response = await client.beta.messages.create(
      {
        model: p.model,
        max_tokens: 16000,
        system: SYSTEM,
        tools,
        messages: history,
        ...(fallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
        // Multi-step design work benefits from more thought than Claude Opus 5.5's default "medium" (audit A-2).
        ...(EFFORT_MODELS.has(p.model) ? { output_config: { effort: "high" } } : {}),
      } as Anthropic.Beta.MessageCreateParamsNonStreaming,
      { signal },
    );
    // Keep the whole assistant turn (thinking and fallback blocks included) for the next request.
    history.push({ role: "assistant", content: response.content });
    for (const b of response.content) if (b.type === "text" && b.text.trim()) push({ kind: "assistant", text: b.text });
    if (response.stop_reason === "refusal") {
      push({ kind: "error", text: "The model declined this request." });
      return;
    }
    if (response.stop_reason === "max_tokens") {
      push({ kind: "error", text: "The reply was cut off (too long). Try a smaller request." });
      return;
    }
    if (response.stop_reason === "pause_turn") continue;
    const calls = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || calls.length === 0) return;
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const c of calls) {
      const input = (c.input ?? {}) as Record<string, unknown>;
      push({ kind: "tool", name: c.name, input });
      // A tool that throws answers the model with an error instead of ending the turn, as on the OpenAI path (audit A-2).
      const result = await runDesignTool(c.name, input, { assistant: true }).catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }) as Record<string, unknown>);
      patchLastTool(result);
      results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(result), ...(result.error ? { is_error: true } : {}) });
    }
    history.push({ role: "user", content: results });
  }
  push({ kind: "error", text: "Stopped after many steps. Ask again to continue." });
}

/* ───────────────────────────── OpenAI-compatible ───────────────────────────── */

type OaiMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[] }
  | { role: "tool"; tool_call_id: string; content: string };

const oaiHistory: OaiMessage[] = [];

/** Why a fetch to a model server failed, as far as the browser lets us tell. */
export function unreachable(baseUrl: string, page: string = location.href): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return `"${baseUrl}" isn't a valid address. It should look like http://192.168.1.20:11434/v1.`;
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol === "http:" && !local && new URL(page).protocol === "https:")
    return `This page is served over HTTPS, so the browser won't send requests to the plain-HTTP server at ${url.host}. Open the app over http://, or put the model server behind HTTPS.`;
  return `Couldn't reach ${baseUrl}. Check the server is running, listening on the network (Ollama: OLLAMA_HOST=0.0.0.0) and allows requests from this app (Ollama: OLLAMA_ORIGINS=*; LM Studio: enable CORS).`;
}

/** Models an OpenAI-compatible server offers (Ollama, LM Studio, vLLM… all answer GET /models). Throws a friendly message. */
export async function listModels(p: Pick<ProviderConfig, "baseUrl" | "apiKey">): Promise<string[]> {
  if (!p.baseUrl) throw new Error("Enter the endpoint first.");
  let res: Response;
  try {
    res = await fetch(`${p.baseUrl.replace(/\/+$/, "")}/models`, { headers: p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}, signal: AbortSignal.timeout(8000) });
  } catch {
    throw new Error(unreachable(p.baseUrl));
  }
  if (!res.ok) throw new Error(`The server answered ${res.status}. Type the model name instead.`);
  const json = (await res.json().catch(() => ({}))) as { data?: { id?: string }[] };
  const ids = (json.data ?? []).map((m) => m.id).filter((x): x is string => !!x);
  if (!ids.length) throw new Error("The server has no models yet. For Ollama, run `ollama pull qwen2.5:14b` first.");
  return ids;
}

/** Long tool results swamp a small local model's context; keep the start, which carries the status and message. */
const clip = (s: string) => (s.length > 6000 ? `${s.slice(0, 6000)}…(shortened)` : s);

async function runOpenAI(p: ProviderConfig, text: string, signal: AbortSignal) {
  if (!p.baseUrl) throw new Error("Set the endpoint URL for this provider in Settings.");
  if (!p.model) throw new Error("Choose a model for this provider in Settings.");
  const tools = DESIGN_TOOLS.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.input_schema } }));
  if (oaiHistory.length === 0) oaiHistory.push({ role: "system", content: SYSTEM });
  oaiHistory.push({ role: "user", content: text });
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    let res: Response;
    try {
      res = await fetch(`${p.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", ...(p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {}) },
        body: JSON.stringify({ model: p.model, messages: oaiHistory, tools, tool_choice: "auto" }),
      });
    } catch (e) {
      if (signal.aborted) throw e;
      throw new Error(unreachable(p.baseUrl));
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${p.label} answered ${res.status}: ${body.slice(0, 300)}`);
    }
    const json = (await res.json()) as { choices?: { message?: OaiMessage & { role: "assistant" }; finish_reason?: string }[] };
    const msg = json.choices?.[0]?.message;
    if (!msg) throw new Error("The provider returned no message.");
    oaiHistory.push({ role: "assistant", content: msg.content ?? null, ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}) });
    if (msg.content?.trim()) push({ kind: "assistant", text: msg.content });
    if (!msg.tool_calls?.length) return;
    for (const c of msg.tool_calls) {
      let input: Record<string, unknown> = {};
      let result: Record<string, unknown>;
      let parsed = true;
      try {
        const raw = c.function.arguments ? JSON.parse(c.function.arguments) : {};
        if (raw && typeof raw === "object" && !Array.isArray(raw)) input = raw as Record<string, unknown>;
        else parsed = false;
      } catch {
        parsed = false;
      }
      push({ kind: "tool", name: c.function.name, input });
      if (!parsed) result = { error: "The tool arguments weren't a valid JSON object. Send them again." };
      else {
        try {
          result = await runDesignTool(c.function.name, input, { assistant: true });
        } catch (e) {
          result = { error: e instanceof Error ? e.message : "The tool failed." };
        }
      }
      patchLastTool(result);
      oaiHistory.push({ role: "tool", tool_call_id: c.id, content: clip(JSON.stringify(result)) });
    }
  }
  push({ kind: "error", text: "Stopped after many steps. Ask again to continue." });
}

/* ───────────────────────────── Entry point ───────────────────────────── */

export async function askAssistant(text: string) {
  const p = activeProvider();
  if (!p) {
    push({ kind: "error", text: "Add an AI provider in Settings → AI assistant first." });
    return;
  }
  if (useAi.getState().busy) return;
  const abort = new AbortController();
  useAi.setState({ busy: true, abort });
  push({ kind: "user", text });
  try {
    if (p.kind === "anthropic") await runClaude(p, text, abort.signal);
    else await runOpenAI(p, text, abort.signal);
  } catch (e) {
    if (abort.signal.aborted) push({ kind: "error", text: "Stopped." });
    else push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
  } finally {
    useAi.setState({ busy: false, abort: null });
  }
}

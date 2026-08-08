export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamEvents {
  onText?: (delta: string) => void;
  onReasoning?: (delta: string) => void;
  onToolCallStart?: (call: ToolCall) => void;
  onToolCallArg?: (call: ToolCall, argDelta: string) => void;
  onUsage?: (usage: { input: number; output: number }) => void;
  /** User-supplied abort signal (e.g. ESC to cancel). */
  signal?: AbortSignal;
}

export interface StreamResult {
  content: string;
  reasoning: string;
  toolCalls: ToolCall[];
  usage: { input: number; output: number };
  /** e.g. "stop", "length", "tool_calls" — undefined if the provider omits it. */
  finishReason?: string;
}

export function parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  return (async function* () {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data:")) continue;
          yield trimmed.slice(5).trim();
        }
      }
      if (buffer.trim()) yield buffer.trim().slice(5).trim();
    } finally {
      reader.releaseLock();
    }
  })();
}

export class ProviderError extends Error {
  constructor(
    public status: number,
    public body: string,
    message: string,
  ) {
    super(message);
  }
}

export interface OpenAICompatClientOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
  /** Max ms for the whole request (default 600s). */
  requestTimeoutMs?: number;
  /** Abort if no stream data for this many ms (default 120s). */
  idleTimeoutMs?: number;
  /** Max output tokens per call (default 8192). */
  maxTokens?: number;
}

export class OpenAICompatClient {
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private extraHeaders: Record<string, string>;
  private requestTimeoutMs: number;
  private idleTimeoutMs: number;
  private maxTokens: number;

  constructor(opts: OpenAICompatClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.extraHeaders = opts.extraHeaders ?? {};
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 600_000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 120_000;
    this.maxTokens = opts.maxTokens ?? 8192;
  }

  async listModels(): Promise<string[]> {
    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return [];
      const data = (await res.json()) as { data?: Array<{ id: string }> };
      return (data.data ?? []).map((m) => m.id);
    } catch {
      return [];
    }
  }

  async stream(
    messages: ChatMessage[],
    tools: ToolDef[],
    events: StreamEvents = {},
  ): Promise<StreamResult> {
    const payload = {
      model: this.model,
      messages,
      tools: tools.length ? tools : undefined,
      max_tokens: this.maxTokens,
      stream: true,
    };

    // idle/stall guard: abort if the provider sends nothing for idleTimeoutMs
    const idleController = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    const resetIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => idleController.abort(new Error(`no data from provider for ${Math.round(this.idleTimeoutMs / 1000)}s`)),
        this.idleTimeoutMs,
      );
    };

    const signals = [
      AbortSignal.timeout(this.requestTimeoutMs),
      idleController.signal,
    ];
    if (events.signal) signals.push(events.signal);
    const signal = AbortSignal.any(signals);

    resetIdle();

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
          ...this.extraHeaders,
        },
        body: JSON.stringify(payload),
        signal,
      });
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }

    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => "");
      throw new ProviderError(
        res.status,
        body,
        `Provider error ${res.status}: ${body.slice(0, 500)}`,
      );
    }

    const toolCalls: ToolCall[] = [];
    const byId = new Map<string, ToolCall>();
    let content = "";
    let reasoning = "";
    let sawDeltaContent = false;
    let finishReason: string | undefined;
    let usage = { input: 0, output: 0 };

    // Accumulation is index-based (some providers send chunks with only an
    // index, the id arrives later). Generated ids use a prefix providers never
    // emit (`gen_call_`) so they can't collide with real ids.
    const ensureIndex = (index: number, id?: string): ToolCall => {
      while (toolCalls.length <= index) {
        const genId = `gen_call_${toolCalls.length}`;
        const call: ToolCall = { id: genId, type: "function", function: { name: "", arguments: "" } };
        toolCalls.push(call);
        byId.set(genId, call);
      }
      const call = toolCalls[index]!;
      if (id && id !== call.id) {
        byId.delete(call.id);
        call.id = id;
        byId.set(id, call);
      }
      return call;
    };

    /** Pick the slot a chunk belongs to (handles missing id AND missing index). */
    const slotFor = (tc: { index?: number; id?: string; function?: { name?: string } }): ToolCall => {
      if (tc.id) {
        const existing = byId.get(tc.id);
        if (existing) return existing;
        return ensureIndex(tc.index ?? toolCalls.length, tc.id);
      }
      if (typeof tc.index === "number") return ensureIndex(tc.index);
      // no id, no index: continuation of the current call unless a new
      // function name appears (arg-splitting providers omit both)
      const last = toolCalls[toolCalls.length - 1];
      if (last && (!tc.function?.name || !last.function.name || last.function.name === tc.function.name)) {
        return last;
      }
      return ensureIndex(toolCalls.length);
    };

    try {
      for await (const raw of parseSse(res.body)) {
        resetIdle();
        if (raw === "[DONE]") break;
        let data: unknown;
        try {
          data = JSON.parse(raw);
        } catch {
          continue;
        }
        if (!data || typeof data !== "object") continue;
          const chunk = data as {
          error?: { message?: string; type?: string; code?: unknown };
          choices?: Array<{
            delta?: {
              content?: string | null;
              reasoning_content?: string | null;
              tool_calls?: Array<{
                index?: number;
                id?: string;
                function?: { name?: string; arguments?: string };
              }>;
            };
            message?: {
              content?: string | null;
              reasoning_content?: string | null;
              tool_calls?: Array<{
                id: string;
                function: { name: string; arguments: string };
              }>;
            };
            finish_reason?: string | null;
          }>;
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
  
        if (chunk.error?.message) {
          throw new ProviderError(
            0,
            "",
            `Provider error: ${chunk.error.message}${chunk.error.type ? ` (${chunk.error.type})` : ""}`,
          );
        }
  
        if (chunk.usage) {
          // max() guards against proxies that report cumulative usage per chunk
          usage = {
            input: Math.max(usage.input, chunk.usage.prompt_tokens ?? 0),
            output: Math.max(usage.output, chunk.usage.completion_tokens ?? 0),
          };
        }
  
        const choice = chunk.choices?.[0];
        if (!choice) continue;

        if (choice.finish_reason) finishReason = choice.finish_reason;
  
        const delta = choice.delta ?? {};
        if (delta.content) {
          content += delta.content;
          sawDeltaContent = true;
          events.onText?.(delta.content);
        }

        if (delta.reasoning_content) {
          reasoning += delta.reasoning_content;
          events.onReasoning?.(delta.reasoning_content);
        }
  
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const call = slotFor(tc);
            // name arrives once (first chunk); resends are idempotent
            if (tc.function?.name) {
              if (!call.function.name) call.function.name = tc.function.name;
              else if (tc.function.name.startsWith(call.function.name)) call.function.name = tc.function.name;
            }
            if (tc.function?.arguments) {
              call.function.arguments += tc.function.arguments;
              events.onToolCallArg?.(call, tc.function.arguments);
            }
          }
        }
  
        const msg = choice.message;
        if (msg) {
          // avoid double-counting: providers that stream deltas may also send
          // the full text in the final message chunk
          if (msg.content && !sawDeltaContent) {
            content += msg.content;
            events.onText?.(msg.content);
          }
          if (msg.reasoning_content && !sawDeltaContent) {
            reasoning += msg.reasoning_content;
            events.onReasoning?.(msg.reasoning_content);
          }
          if (msg.tool_calls) {
            for (const tc of msg.tool_calls) {
              const existing = byId.get(tc.id);
              if (existing) {
                existing.function = tc.function;
              } else {
                const empty = toolCalls.find((c) => !c.function.name && !c.function.arguments);
                if (empty) {
                  byId.delete(empty.id);
                  empty.id = tc.id;
                  empty.function = tc.function;
                  byId.set(tc.id, empty);
                } else {
                  const call: ToolCall = { id: tc.id, type: "function", function: tc.function };
                  toolCalls.push(call);
                  byId.set(tc.id, call);
                }
              }
            }
          }
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
    }

    return { content, toolCalls, usage, finishReason, reasoning };
  }
}

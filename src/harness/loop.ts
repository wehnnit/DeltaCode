import { resolveAllowedRoots, FREE_PROVIDER_ID, type DeltaConfig } from "../config";
import { tryReserve, addTokens } from "../usage";
import type { AgentDef } from "../agents/types";
import { agentByName } from "../agents/loader";
import type { Skill } from "../skills/loader";
import type { McpRegistry } from "../mcp/registry";
import { OpenAICompatClient, type ChatMessage, type ToolCall, type ToolDef } from "../providers/openai-compat";
import { getPreset, createClient, type ProviderPreset } from "../providers/index";
import { readTool, writeTool, editTool, deleteTool, fileInfoTool } from "../tools/fs";
import { bashTool } from "../tools/bash";
import { globTool, grepTool } from "../tools/search";
import type { Tool, ToolResult, ToolContext, PermissionKind, Activity } from "../tools/types";
import { buildLeadPrompt, buildSkillBlock, TOOL_CALLING_PROTOCOL, WORKFLOW, TOOL_REFERENCE, HARNESS_RULES, type SystemPromptContext } from "../prompts/system";
import { LEAD_AGENT_NAME } from "../agents/types";

export interface HarnessCallbacks {
  onText: (agent: string, delta: string) => void;
  onToolCall: (agent: string, name: string, args: unknown) => number | void;
  onReasoning?: (agent: string, delta: string) => void;
  onToolResult?: (agent: string, name: string, args: unknown, result: string) => void;
  onActivity: (a: Activity) => void;
  onAgentStart: (agent: string) => void;
  onAgentEnd: (agent: string, usage: { input: number; output: number }) => void;
  confirm: (kind: PermissionKind, detail: string, agent: string) => Promise<boolean>;
  /** A provider call is being retried after a transient failure. */
  onRetry?: (agent: string, attempt: number, reason: string) => void;
  /** The partial text of the current stream was discarded before retrying. */
  onStreamReset?: (agent: string) => void;
}

export interface HarnessOptions {
  config: DeltaConfig;
  projectDir: string;
  agents: AgentDef[];
  skills: Skill[];
  mcp: McpRegistry;
  callbacks: HarnessCallbacks;
}

const MAX_DEPTH = 4;
/** Safety cap on tool-call rounds in a single run — prevents runaway loops. */
const MAX_ROUNDS = 40;
/** Max messages / chars of conversation history re-sent each turn. */
const MAX_HISTORY_MSGS = 30;
const MAX_HISTORY_CHARS = 150_000;

const STATIC_TOOLS: Tool[] = [
  readTool,
  writeTool,
  editTool,
  deleteTool,
  fileInfoTool,
  bashTool,
  globTool,
  grepTool,
];

interface ParsedArgs {
  args: Record<string, unknown>;
  error?: string;
}

function safeParse(raw: string): ParsedArgs {
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return { args: v as Record<string, unknown> };
    }
    return { args: {}, error: `arguments must be a JSON object, got: ${raw.slice(0, 120)}` };
  } catch {
    return { args: {}, error: `invalid JSON arguments: ${raw.slice(0, 200)}` };
  }
}

export function trimHistory(
  history: ChatMessage[],
  maxMsgs = MAX_HISTORY_MSGS,
  maxChars = MAX_HISTORY_CHARS,
): ChatMessage[] {
  let msgs = history.slice(-maxMsgs);
  let chars = msgs.reduce((n, m) => n + m.content.length, 0);
  while (chars > maxChars && msgs.length > 2) {
    chars -= msgs.shift()!.content.length;
  }
  return msgs;
}

const CONTINUE_PROMPT =
  "[System: the previous response was cut off because it hit the output token limit. Continue exactly where you stopped — do not repeat content that was already written.]";

/** Network/DNS-level failures (proxy down, bad URL, connection refused). */
export function isNetworkError(e: Error & { status?: number }): boolean {
  if (typeof e.status === "number" && e.status > 0) return false;
  const msg = e.message ?? "";
  return /fetch failed|socket|ECONN|ENOTFOUND|network|connection|typo in the url|aborted|closed unexpectedly/i.test(msg);
}

/** Transient failures worth retrying (429 / 5xx / 408 / timeouts / stalls / overload). */
export function isRetryable(e: Error & { status?: number }): boolean {
  const msg = e.message ?? "";
  if (e.name === "TimeoutError") return true;
  if (msg.includes("no data from provider")) return true;
  if (e.name === "AbortError") return false; // user cancelled — never retry
  if (typeof e.status === "number") {
    if (e.status === 429 || e.status === 408) return true;
    if (e.status >= 500 && e.status <= 599) return true;
    return false;
  }
  if (/overloaded|rate|temporar|try again|busy|limit|queue/i.test(msg)) return true;
  return false;
}

export function retryReason(e: Error & { status?: number }): string {
  const msg = e.message ?? "";
  if (typeof e.status === "number" && e.status > 0) return `provider ${e.status}`;
  if (msg.includes("no data from provider")) return "provider stalled (idle)";
  if (e.name === "TimeoutError") return "request timed out";
  const m = /(fetch failed|socket|ECONN|ENOTFOUND|network|connection|overloaded|rate|temporar|try again|busy|limit|queue)/i.exec(msg);
  return m?.[1] ?? msg.slice(0, 60);
}

function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class Harness {
  private config: DeltaConfig;
  private projectDir: string;
  private agents: AgentDef[];
  private skills: Skill[];
  private mcp: McpRegistry;
  private callbacks: HarnessCallbacks;
  private preset: ProviderPreset;
  private activeController: AbortController | null = null;
  private wasAborted = false;

  constructor(opts: HarnessOptions) {
    this.config = opts.config;
    this.projectDir = opts.projectDir;
    this.agents = opts.agents;
    this.skills = opts.skills;
    this.mcp = opts.mcp;
    this.callbacks = opts.callbacks;
    const preset = getPreset(this.config.provider);
    if (!preset) throw new Error(`Unknown provider: ${this.config.provider}`);
    this.preset = preset;
  }

  /** Every agent except the lead can be spawned via the task tool. */
  private delegatableAgents(): AgentDef[] {
    return this.agents.filter((a) => a.name !== LEAD_AGENT_NAME);
  }

  private async clientFor(model?: string): Promise<OpenAICompatClient> {
    // Delta Free Models is pinned to the free GLM-4.7-Flash — the catalog is
    // managed by Delta, so no other model id is ever accepted.
    const modelName =
      this.config.provider === FREE_PROVIDER_ID ? "glm-4.7-flash" : (model ?? this.config.model);
    const t = this.config.timeouts;
    return createClient(this.preset, this.config.apiKey, modelName, {
      requestTimeoutMs: t.requestMs,
      idleTimeoutMs: t.idleMs,
      maxTokens: this.config.maxTokens,
    });
  }

  private toolsFor(agent: AgentDef): { tools: Tool[]; toolDefs: ToolDef[] } {
    const tools = STATIC_TOOLS.filter((t) => agent.tools.includes(t.name));
    if (agent.tools.includes("task")) {
      tools.push(this.taskTool());
    }
    const mcpTools: ToolDef[] = [];
    for (const mcpTool of this.mcp.toolsDefs) {
      if (agent.tools.includes(mcpTool.function.name)) {
        tools.push(this.mcpTool(mcpTool));
        mcpTools.push(mcpTool);
      }
    }
    const defs: ToolDef[] = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
    return { tools, toolDefs: defs };
  }

  private mcpTool(def: ToolDef): Tool {
    const entry = this.mcp.tools.get(def.function.name);
    return {
      name: def.function.name,
      description: def.function.description,
      parameters: def.function.parameters,
      handler: async (_ctx, args) => {
        if (!entry) return { output: `MCP tool unavailable: ${def.function.name}` };
        try {
          const text = await entry.client.callTool(def.function.name, args);
          return { output: text };
        } catch (e) {
          return { output: `MCP tool ${def.function.name} error: ${(e as Error).message}` };
        }
      },
    };
  }

  private taskTool(): Tool {
    const self = this;
    return {
      name: "task",
      description:
        "Spawn a specialist agent to complete a focused task and return its result. Use for coding, frontend, backend, review, or web research. Give the specialist complete context — it cannot see this conversation.",
      parameters: {
        type: "object",
        properties: {
          agent: {
            type: "string",
            description: "Specialist to spawn (see the Delegation section of your prompt for available agents)",
          },
          prompt: {
            type: "string",
            description: "Complete, self-contained task description with file paths and constraints",
          },
          description: { type: "string", description: "Short summary shown to the user" },
        },
        required: ["agent", "prompt"],
      },
      handler: async (ctx, args) => {
        const name = typeof args.agent === "string" ? args.agent : "";
        const prompt = typeof args.prompt === "string" ? args.prompt : "";
        const agent = agentByName(self.agents, name);
        if (!agent || name === LEAD_AGENT_NAME) {
          return {
            output: `Unknown specialist "${name}". Available: ${self.delegatableAgents().map((a) => a.name).join(", ")}`,
          };
        }
        const description = typeof args.description === "string" ? args.description : name;
        ctx.onActivity?.({ kind: "agent", text: `${name}: ${description.slice(0, 80)}` });
        const result = await self.runSubagent(agent, prompt, (ctx.depth ?? 0) + 1);
        return { output: result };
      },
    };
  }

  private makeContext(agent: AgentDef, depth: number): ToolContext {
    const self = this;
    return {
      cwd: this.projectDir,
      allowedRoots: resolveAllowedRoots(this.projectDir),
      bashTimeoutMs: this.config.timeouts.bashMs,
      depth,
      confirm: (kind, detail) => self.callbacks.confirm(kind, detail, agent.name),
      onActivity: (a) => self.callbacks.onActivity(a),
    };
  }

  private buildSystemPrompt(agent: AgentDef, tools: Tool[]): string {
    const agentSkills = this.skills.filter((s) => agent.skills.includes(s.name));
    const mcpTools = this.mcp.toolsDefs
      .map((d) => d.function.name)
      .filter((n) => agent.tools.includes(n))
      .map((name) => {
        const entry = this.mcp.tools.get(name);
        return {
          name,
          description: entry?.mcpTool.description ?? "",
          inputSchema: entry?.mcpTool.inputSchema ?? {},
        };
      });
    const ctx: SystemPromptContext = {
      agent,
      skills: agentSkills,
      availableTools: tools.map((t) => t.name),
      mcpTools,
      delegatableNames: this.delegatableAgents().map((a) => a.name),
      projectDir: this.projectDir,
      projectName: this.projectDir.split("/").filter(Boolean).pop() ?? "workspace",
      model: agent.model ?? this.config.model,
      providerName: this.preset.name,
    };
    return agent.name === LEAD_AGENT_NAME
      ? buildLeadPrompt(ctx)
      : this.buildSpecialistPrompt(ctx, agent);
  }

  private buildSpecialistPrompt(ctx: SystemPromptContext, agent: AgentDef): string {
    return `# Role

You are the Delta "${agent.name}" specialist agent — an elite software engineer working in the project "${ctx.projectName}" at ${ctx.projectDir}.

${agent.instructions.trim() ? agent.instructions.trim() + "\n" : ""}
You are working on a task delegated by the lead agent. You have the same tools and permissions as the lead — you can read, write, edit, run commands, and search. The task is NOT done until the actual files exist on disk and you verified them. Do the task completely, then report back with a concise summary of what you changed and how it was verified.

${TOOL_CALLING_PROTOCOL}

${WORKFLOW}

${TOOL_REFERENCE}

${HARNESS_RULES}

${buildSkillBlock(ctx.skills)}

# Environment

- Project: ${ctx.projectName} (${ctx.projectDir})
- Model: ${ctx.model} via ${ctx.providerName}
- Available tools: ${ctx.availableTools.join(", ") || "none"}
${
  ctx.mcpTools.length
    ? `- Web tools (Exa, free, no API key): ${ctx.mcpTools.map((t) => t.name).join(", ")}`
    : ""
}`;
  }

  private async runLoop(
    agent: AgentDef,
    messages: ChatMessage[],
    depth: number,
    streamEvents: boolean,
  ): Promise<{ content: string; usage: { input: number; output: number } }> {
    if (depth > MAX_DEPTH) {
      throw new Error(`Agent recursion too deep (${depth} levels)`);
    }
    const { tools, toolDefs } = this.toolsFor(agent);
    const system = this.buildSystemPrompt(agent, tools);
    const msgs: ChatMessage[] = [{ role: "system", content: system }, ...messages];
    const ctx = this.makeContext(agent, depth);
    const client = await this.clientFor(agent.model);
    const toolByName = new Map(tools.map((t) => [t.name, t]));
    const total = { input: 0, output: 0 };
    let fullContent = "";
    let rounds = 0;
    let continuations = 0;

    this.callbacks.onAgentStart(agent.name);

    while (true) {
      rounds++;
      if (rounds > MAX_ROUNDS) {
        this.callbacks.onAgentEnd(agent.name, total);
        throw new Error(`Turn exceeded ${MAX_ROUNDS} tool-call rounds — stopping. The model may be looping; try /model or /new.`);
      }

      let result;
      // auto-retry transient provider failures (429/5xx/timeouts/stalls/overload)
      // with exponential backoff, like opencode. Network/DNS failures are NOT
      // transient — they fail fast (0 retries on the free pool, 2 elsewhere).
      // The free pool caps transient retries at 10 so a retry storm can't burn
      // the day's quota.
      let attempt = 0;
      for (;;) {
        attempt++;
        if (this.config.provider === FREE_PROVIDER_ID) {
          const ok = await tryReserve();
          if (!ok) {
            this.callbacks.onAgentEnd(agent.name, total);
            throw new Error(
              "Delta Free Models: daily token budget reached (500 units = 50M tokens — resets at local midnight). " +
              "Run /usage to check, /models for the catalog, or switch provider via setup.",
            );
          }
        }
        try {
          result = await client.stream(msgs, toolDefs, {
            signal: this.activeController?.signal,
            onText: (d) => {
              if (streamEvents) this.callbacks.onText(agent.name, d);
            },
            onReasoning: (d) => {
              if (streamEvents) this.callbacks.onReasoning?.(agent.name, d);
            },
            onUsage: (u) => {
              total.input += u.input;
              total.output += u.output;
            },
          });
          break;
        } catch (e) {
          const err = e as Error & { status?: number };
          if (this.activeController?.signal.aborted) {
            this.callbacks.onAgentEnd(agent.name, total);
            throw e; // user cancelled — stop immediately, no retry
          }
          const isNet = isNetworkError(err);
          const cap = isNet
            ? this.config.provider === FREE_PROVIDER_ID ? 0 : 2
            : this.config.provider === FREE_PROVIDER_ID
              ? Math.min(this.config.retries, 10)
              : this.config.retries;
          if (attempt > cap || (!isNet && !isRetryable(err))) {
            this.callbacks.onAgentEnd(agent.name, total);
            throw e;
          }
          // discard any partial streamed text so the retry doesn't duplicate it
          if (streamEvents) this.callbacks.onStreamReset?.(agent.name);
          this.callbacks.onRetry?.(agent.name, attempt, retryReason(err));
          const backoff = Math.min(1000 * 2 ** Math.min(attempt - 1, 4), 15_000) + Math.floor(Math.random() * 250);
          await sleepAbortable(backoff, this.activeController?.signal);
        }
      }
      // charge the free pool with the tokens this call actually used. Some
      // providers (Z.AI streaming) don't report usage — estimate from chars.
      if (this.config.provider === FREE_PROVIDER_ID) {
        let used = result.usage.input + result.usage.output;
        if (used === 0) {
          const chars = msgs.reduce((n, m) => n + (m.content?.length ?? 0), 0) + (result.content?.length ?? 0);
          used = Math.ceil(chars / 3);
        }
        if (used > 0) await addTokens(used);
      }

      fullContent += result.content;

      // Sanitize tool calls before echoing them back to the provider. Strict
      // providers (Cohere, some gateways) 400 the whole request when a tool
      // call has empty/non-JSON arguments or a missing name — e.g. a call the
      // model started but whose arguments got truncated. Nameless calls are
      // dropped entirely; malformed-argument calls are normalized to "{}"
      // (their ids are kept so tool results still line up).
      const sanitized: Array<{ call: ToolCall; parsed: ParsedArgs }> = [];
      for (const call of result.toolCalls) {
        if (!call.function.name.trim()) continue;
        const parsed = safeParse(call.function.arguments);
        sanitized.push({
          call: { ...call, function: { ...call.function, arguments: parsed.error ? "{}" : call.function.arguments } },
          parsed,
        });
      }

      const assistant: ChatMessage = {
        role: "assistant",
        content: result.content,
        tool_calls: sanitized.length ? sanitized.map((s) => s.call) : undefined,
      };
      msgs.push(assistant);

      // output token limit hit with no tool calls: continue from where it stopped
      if (sanitized.length === 0 && result.finishReason === "length" && continuations < 3) {
        continuations++;
        msgs.push({ role: "user", content: CONTINUE_PROMPT });
        continue;
      }

      if (sanitized.length === 0) {
        this.callbacks.onAgentEnd(agent.name, total);
        return { content: fullContent, usage: total };
      }

      for (const { call, parsed } of sanitized) {
        const itemId = this.callbacks.onToolCall(agent.name, call.function.name, parsed.args);
        const tool = toolByName.get(call.function.name);
        let toolResult: ToolResult;
        if (!tool) {
          toolResult = { output: `Unknown tool: ${call.function.name}. Available: ${[...toolByName.keys()].join(", ")}` };
        } else if (parsed.error) {
          toolResult = {
            output: `Error: tool call arguments were malformed — ${parsed.error}. Reformulate the call with valid JSON arguments.`,
          };
        } else {
          try {
            toolResult = await tool.handler(ctx, parsed.args);
          } catch (e) {
            const msg = (e as Error).message;
            // let recursion errors unwind the whole delegation chain fast
            if (msg.includes("recursion too deep") || msg.includes("exceeded")) throw e;
            toolResult = { output: `Tool error: ${msg}` };
          }
        }
        if (toolResult.activity) this.callbacks.onActivity(toolResult.activity);
        this.callbacks.onToolResult?.(agent.name, call.function.name, parsed.args, toolResult.output);
        void itemId;
        msgs.push({
          role: "tool",
          tool_call_id: call.id,
          content: toolResult.output,
        });
      }
    }
  }

  private async runSubagent(agent: AgentDef, prompt: string, depth: number): Promise<string> {
    const messages: ChatMessage[] = [{ role: "user", content: prompt }];
    try {
      const res = await this.runLoop(agent, messages, depth, false);
      return res.content;
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes("recursion too deep") || msg.includes("exceeded")) throw e;
      return `Subagent "${agent.name}" failed: ${msg}`;
    }
  }

  async send(userText: string, history: ChatMessage[]): Promise<{ content: string; usage: { input: number; output: number } }> {
    const lead = agentByName(this.agents, LEAD_AGENT_NAME) ?? this.agents[0]!;
    const messages = [...trimHistory(history), { role: "user" as const, content: userText }];
    const controller = new AbortController();
    this.activeController = controller;
    this.wasAborted = false;
    try {
      return await this.runLoop(lead, messages, 0, true);
    } finally {
      this.activeController = null;
    }
  }

  /** Abort the current turn (ESC). */
  cancel(): void {
    if (this.activeController) {
      this.wasAborted = true;
      this.activeController.abort();
    }
  }

  get aborted(): boolean {
    return this.wasAborted;
  }
}

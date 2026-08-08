import { memo, useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { Harness } from "../harness/loop";
import type { ChatMessage } from "../providers/openai-compat";
import { saveConfig, isConfigured, resolveAllowedRoots, FREE_PROVIDER_ID, type DeltaConfig, type TimeoutConfig } from "../config";
import type { AgentDef } from "../agents/types";
import type { Skill } from "../skills/loader";
import type { McpRegistry } from "../mcp/registry";
import { appendMsg, newSession, type SessionMsg } from "../sessions";
import { getUsage, FREE_UNITS, TOKENS_PER_UNIT } from "../usage";
import { InputBox } from "./input";
import { SetupScreen } from "./setup";
import { SplashScreen } from "./splash";
import { HomeScreen } from "./home";
import { ModelPicker } from "./modelpicker";
import { getPreset } from "../providers/index";
import { theme } from "./theme";
import { Markdown } from "./markdown";
import { AgentStatus, OceanBox, ShimmerText, WaveDivider, WaterSpinner } from "./animations";
import { isNetworkError } from "../harness/loop";

interface ChatItem {
  id: number;
  kind: "user" | "assistant" | "tool" | "error" | "info";
  text: string;
  reasoning?: string;
  thoughtSecs?: number;
  toolName?: string;
  toolArgs?: string;
  toolResult?: string;
  toolError?: boolean;
  agent?: string;
}

interface PendingPermission {
  kind: "bash" | "write";
  detail: string;
  agent: string;
  resolve: (ok: boolean) => void;
}

const MAX_VISIBLE = 100;

interface DeltaAppProps {
  config: DeltaConfig;
  projectDir: string;
  agents: AgentDef[];
  skills: Skill[];
  mcp: McpRegistry;
  initialHistory: SessionMsg[];
  sessionFile: string;
  forceSetup?: boolean;
}

const COMMAND_LIST = ["/help", "/model", "/models", "/usage", "/agents", "/skills", "/new", "/clear", "/exit"];

const COMMANDS = [
  "~ /help — show commands",
  "~ /model — pick a model (or /model <id>)",
  "~ /models — Delta Free Models catalog",
  "~ /usage — free-model usage today (Delta Free Models)",
  "~ /agents — list specialist agents",
  "~ /skills — list loaded skills",
  "~ /new — new chat (home screen)",
  "~ /clear — clear the chat view",
  "~ /exit — quit",
];

const ItemView = memo(function ItemView({ item }: { item: ChatItem }) {
  switch (item.kind) {
    case "user":
      return (
        <Box>
          <Text color={theme.ocean} bold>
            You:
          </Text>
          <Text color={theme.foam}> {item.text}</Text>
        </Box>
      );
    case "assistant": {
      const streamingThought = item.reasoning && !item.text;
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={theme.teal} bold>
              Δ
            </Text>
            <Box paddingLeft={1}>
              {streamingThought ? (
                <Box flexDirection="column">
                  <Text color={theme.mist} italic>
                    thinking…
                  </Text>
                  <Text color={theme.mist} dimColor>
                    {item.reasoning}
                  </Text>
                </Box>
              ) : item.text ? (
                <Box flexDirection="column">
                  {item.thoughtSecs ? (
                    <Text color={theme.mist} dimColor>
                      thought for {item.thoughtSecs}s
                    </Text>
                  ) : null}
                  <Markdown text={item.text} />
                </Box>
              ) : (
                <Box gap={1}>
                  <WaterSpinner ms={110} />
                  <Text color={theme.mist}>thinking</Text>
                </Box>
              )}
            </Box>
          </Box>
        </Box>
      );
    }
    case "tool":
      return (
        <Box flexDirection="column">
          <Box>
            <Text color={theme.oceanDim}>  {TOOL_ICONS[item.toolName ?? ""] ?? "⚙"} </Text>
            <Text color={theme.mist} bold>
              {item.toolName}
            </Text>
            {item.toolArgs ? <Text color={theme.mist}> · {item.toolArgs}</Text> : null}
          </Box>
          {item.toolResult ? (
            <Box paddingLeft={4}>
              <Text color={item.toolError ? theme.coral : theme.oceanDim} italic dimColor>
                {previewResult(item.toolResult)}
              </Text>
            </Box>
          ) : null}
        </Box>
      );
    case "error":
      return (
        <Box>
          <Text color={theme.coral} bold>
            〰 error: {item.text}
          </Text>
        </Box>
      );
    case "info":
      return (
        <Box>
          <Text color={theme.mist}>  ~ </Text>
          <Text color={theme.mist} italic>
            {item.text}
          </Text>
        </Box>
      );
  }
});

const TOOL_ICONS: Record<string, string> = {
  write: "✎",
  edit: "✎",
  delete: "✕",
  read: "⌕",
  glob: "⌕",
  grep: "⌕",
  file_info: "⌕",
  bash: "⚙",
  task: "⚙",
  ask: "⚙",
};

function sanitizeControl(s: string): string {
  return s.replace(/[\u0000-\u001f\u007f]/g, "");
}

function previewResult(s: string, maxLines = 8): string {
  const lines = sanitizeControl(s.replace(/\r\n/g, "\n")).split("\n");
  const clipped = lines.slice(0, maxLines).map((l) => (l.length > 120 ? l.slice(0, 119) + "…" : l));
  return clipped.join("\n") + (lines.length > maxLines ? "\n…" : "");
}

function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  if (typeof a.path === "string") return sanitizeControl(a.path);
  if (typeof a.command === "string") return sanitizeControl(a.command).split("\n")[0]!.slice(0, 60);
  if (typeof a.prompt === "string") return sanitizeControl(a.prompt).slice(0, 60);
  if (typeof a.pattern === "string") return sanitizeControl(a.pattern);
  return sanitizeControl(JSON.stringify(args)).slice(0, 60);
}

function sanitizeText(s: string): string {
  // strip control bytes (fixes garbled terminal output) and cap length
  return s.replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 400);
}

function friendlyError(e: Error & { name?: string }, t: TimeoutConfig, provider?: string): string {
  if (provider === FREE_PROVIDER_ID && isNetworkError(e)) {
    return "Delta Free Models: can't reach the Delta proxy. Is the proxy online? Set DELTA_FREE_BASE_URL to your proxy URL (e.g. your *.workers.dev) and try again.";
  }
  if (e.name === "TimeoutError") {
    const mins = Math.round(t.requestMs / 60000);
    const when = mins >= 1 ? `${mins} min` : `${Math.round(t.requestMs / 1000)}s`;
    return sanitizeText(`request timed out after ${when} — the provider is slow or the model is thinking too long. Use /model for a faster model, or esc twice to stop.`);
  }
  if (e.message.includes("no data from provider")) {
    return sanitizeText(`provider stalled — no data for ${Math.round(t.idleMs / 1000)}s. Use /model for a faster model, or esc twice to stop.`);
  }
  return sanitizeText(e.message ?? String(e));
}

function PermissionPrompt({ permission, onChoice }: { permission: PendingPermission; onChoice: (c: "allow" | "deny" | "always") => void }) {
  useInput((input) => {
    const key = input.toLowerCase();
    if (key === "a") onChoice("allow");
    else if (key === "d") onChoice("deny");
    else if (key === "A") onChoice("always");
  });
  return (
    <OceanBox title={`permission — ${permission.agent}`}>
      <Text color={theme.foam}>{permission.detail.slice(0, 300)}</Text>
      <Text color={theme.ocean}>[a] allow · [d] deny · [A] allow always (this session)</Text>
    </OceanBox>
  );
}

function FreeStatement({ onAccept, onDismiss }: { onAccept: () => void; onDismiss: () => void }) {
  useInput((input, key) => {
    if (key.return || /[\n\r]+$/.test(input)) onAccept();
    else if (key.escape) onDismiss();
  });
  return (
    <OceanBox title="Delta Free Models — powered by Z.AI">
      <Text color={theme.foam}>
        Delta Free Models uses GLM-4.7-Flash through Z.AI&apos;s official API, which Z.AI offers free of charge.
      </Text>
      <Text color={theme.mist}>By using it you agree to:</Text>
      <Text color={theme.mist}>· fair use: token-based — {FREE_UNITS} units/day (1M tokens = 10 units), reset at local midnight</Text>
      <Text color={theme.mist}>· a random, hashed device identifier is sent to the Delta proxy to enforce the fair-use pool; no personal data</Text>
      <Text color={theme.mist}>· your prompts are sent to Z.AI&apos;s servers for processing — don&apos;t send sensitive data</Text>
      <Text color={theme.mist}>· DeltaCode is not affiliated with Z.AI; Z.AI services are subject to Z.AI&apos;s Terms of Use (docs.z.ai/legal-agreement/terms-of-use)</Text>
      <Text color={theme.mist}>· DeltaCode is not responsible for Z.AI availability, rate limits, or changes to the free tier</Text>
      <Text color={theme.ocean}>[enter] I agree · [esc] go back</Text>
    </OceanBox>
  );
}

export function DeltaApp(props: DeltaAppProps) {
  const { exit } = useApp();
  const { projectDir, agents, skills, mcp } = props;

  const [config, setConfig] = useState<DeltaConfig>(props.config);
  const [phase, setPhase] = useState<"splash" | "setup" | "home" | "chat">("splash");
  const [items, setItems] = useState<ChatItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [permission, setPermission] = useState<PendingPermission | null>(null);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [freeStatementOpen, setFreeStatementOpen] = useState(false);
  const [currentAgent, setCurrentAgent] = useState("lead");
  const [activity, setActivity] = useState<string[]>([]);
  const [modelLabel, setModelLabel] = useState(config.model);

  const idRef = useRef(0);
  const streamRef = useRef<{ id: number; text: string; reasoning: string; startedAt: number; thoughtSecs?: number } | null>(null);
  const retryRef = useRef<{ id: number; hidden: boolean } | null>(null);
  const hiddenIds = useRef<Set<number>>(new Set());
  const lastToolIdRef = useRef<number | null>(null);
  const historyRef = useRef<ChatMessage[]>([]);
  const harnessRef = useRef<Harness | null>(null);
  const allowlistRef = useRef<Set<string>>(new Set());
  const sessionFileRef = useRef(props.sessionFile);
  const busyRef = useRef(false);
  const chatInitRef = useRef(false);
  const sessionStartHistoryRef = useRef(props.initialHistory);

  const preset = getPreset(config.provider);
  const inputLocked = busy || !!permission || modelPickerOpen || freeStatementOpen;

  const pushItem = (item: Omit<ChatItem, "id">): number => {
    const id = ++idRef.current;
    setItems((prev) => [...prev, { ...item, id }]);
    return id;
  };

  const updateItem = (id: number, patch: Partial<ChatItem>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  };

  const noteActivity = (text: string) => {
    setActivity((prev) => [text, ...prev].slice(0, 3));
  };

  const handleInterrupt = () => {
    harnessRef.current?.cancel();
  };

  const handleCancel = () => {
    exit();
  };

  const acceptFreeModels = () => {
    config.acceptedFreeModels = true;
    void saveConfig(config);
    setConfig({ ...config });
    setFreeStatementOpen(false);
    pushItem({
      kind: "info",
      text: "Delta Free Models activated — GLM-4.7-Flash-Free, 500 units/day (1M tokens = 10 units), resets at local midnight. /usage to check, /models for the catalog.",
    });
  };

  const dismissFreeModels = () => {
    setFreeStatementOpen(false);
    pushItem({
      kind: "info",
      text: "Delta Free Models stays locked until you accept the statement — run `deltacode setup` and pick Delta Free Models.",
    });
  };

  // Hard screen clear. Ink's frame renderer counts \\n, not physical
  // (wrapped) terminal lines, so when a tall chat view shrinks to the home
  // screen stale wrapped lines can survive above. Blanking the screen (and
  // scrollback) before the next render makes the full redraw clean.
  const clearScreen = () => {
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H");
  };

  // ---- effects ---------------------------------------------------------

  // black background for the whole session (OSC 11), restored on exit
  useEffect(() => {
    process.stdout.write("\x1b]11;#04070c\x07");
    return () => {
      process.stdout.write("\x1b]111\x07");
    };
  }, []);

  // splash → setup (if not configured / forced) → home (fresh) or chat (resumed)
  useEffect(() => {
    const t = setTimeout(() => {
      if (!isConfigured(config) || props.forceSetup) setPhase("setup");
      else if (props.initialHistory.length) setPhase("chat");
      else setPhase("home");
    }, 900);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // build the harness once we are configured and in a chat-capable phase.
  // NEVER nulled on phase change (home → chat on first submit would race).
  useEffect(() => {
    if ((phase !== "home" && phase !== "chat") || harnessRef.current) return;
    const harness = new Harness({
      config,
      projectDir,
      agents,
      skills,
      mcp,
      callbacks: {
        onText: (agent, delta) => {
          const s = streamRef.current;
          if (!s) return;
          if (retryRef.current && delta) {
            hiddenIds.current.add(retryRef.current.id);
            retryRef.current = null;
          }
          if (!s.thoughtSecs && delta && s.reasoning) {
            s.thoughtSecs = Math.max(1, Math.round((Date.now() - s.startedAt) / 1000));
            updateItem(s.id, { thoughtSecs: s.thoughtSecs });
          }
          s.text += delta;
          updateItem(s.id, { text: s.text });
        },
        onReasoning: (agent, delta) => {
          const s = streamRef.current;
          if (!s) return;
          s.reasoning += delta;
          updateItem(s.id, { reasoning: s.reasoning });
        },
        onToolCall: (agent, name, args) => {
          lastToolIdRef.current = pushItem({ kind: "tool", toolName: name, toolArgs: summarizeArgs(args), text: "" });
          return lastToolIdRef.current;
        },
        onToolResult: (agent, name, args, result) => {
          const last = lastToolIdRef.current;
          if (last === null) return;
          const err = /^(error|tool error|unknown tool|mcp tool .* error)/i.test(result);
          updateItem(last, { toolResult: result.slice(0, 2000), toolError: err });
          lastToolIdRef.current = null;
        },
        onActivity: (a) => noteActivity(a.text),
        onAgentStart: (agent) => setCurrentAgent(agent),
        onAgentEnd: (_agent, usage) => {
          setCurrentAgent("lead");
          void usage;
        },
        onStreamReset: () => {
          const s = streamRef.current;
          if (s) {
            s.text = "";
            s.reasoning = "";
            updateItem(s.id, { text: "", reasoning: "" });
          }
        },
        onRetry: (agent, attempt, reason) => {
          if (retryRef.current) {
            updateItem(retryRef.current.id, { text: `retrying… (${reason}, attempt ${attempt})` });
          } else {
            retryRef.current = { id: pushItem({ kind: "info", text: `retrying… (${reason}, attempt ${attempt})` }), hidden: false };
          }
        },
        confirm: (kind, detail, agent) =>
          new Promise<boolean>((resolve) => {
            if (allowlistRef.current.has(detail)) {
              resolve(true);
              return;
            }
            setPermission({ kind, detail, agent, resolve });
          }),
      },
    });
    harnessRef.current = harness;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, config]);

  // unmount-only cleanup
  useEffect(() => {
    return () => {
      harnessRef.current = null;
    };
  }, []);

  // entering chat once: resume history / ready line (fresh home → chat adds nothing)
  useEffect(() => {
    if (phase !== "chat" || chatInitRef.current) return;
    chatInitRef.current = true;
    const history = sessionStartHistoryRef.current;
    if (!history.length) return;
    pushItem({
      kind: "info",
      text: `DeltaCode ready · ${projectDir} · ${preset?.name ?? config.provider}/${config.model} · type / for commands`,
    });
    for (const m of history) {
      if (m.role === "user") pushItem({ kind: "user", text: m.content });
      else if (m.role === "assistant") pushItem({ kind: "assistant", text: m.content, reasoning: m.reasoning, agent: "lead" });
    }
    pushItem({ kind: "info", text: "resumed previous session" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // ---- handlers --------------------------------------------------------

  const handlePermissionChoice = (choice: "allow" | "deny" | "always") => {
    const p = permission;
    if (!p) return;
    if (choice === "always") {
      allowlistRef.current.add(p.detail);
      noteActivity("allowed always: " + p.detail.split("\n")[0]!.slice(0, 60));
    }
    p.resolve(choice !== "deny");
    setPermission(null);
  };

  const finalizeStream = () => {
    const s = streamRef.current;
    streamRef.current = null;
    return s;
  };

  const applyModel = async (id: string) => {
    config.model = id;
    await saveConfig(config);
    setConfig({ ...config });
    setModelLabel(id);
    pushItem({ kind: "info", text: `model set to ${id}` });
  };

  const handleSlash = async (raw: string): Promise<boolean> => {
    const [cmd, ...rest] = raw.slice(1).split(" ");
    switch (cmd) {
      case "help":
        pushItem({ kind: "info", text: COMMANDS.join("\n") });
        return true;
      case "model": {
        const id = rest.join(" ");
        if (!id) {
          setModelPickerOpen(true);
          return true;
        }
        await applyModel(id);
        return true;
      }
      case "usage": {
        const u = await getUsage();
        if (config.provider !== FREE_PROVIDER_ID) {
          pushItem({
            kind: "info",
            text: "not using Delta Free Models — /usage applies to the Delta Free Models provider. Pick it in setup.",
          });
          return true;
        }
        const mins = Math.floor(u.resetMs / 60000);
        const h = Math.floor(mins / 60);
        const m = mins % 60;
        const remaining = Math.max(0, u.limitUnits - u.units);
        pushItem({
          kind: "info",
          text: `Delta Free Models (GLM-4.7-Flash-Free) — ${u.units}/${u.limitUnits} units used today (${(u.tokens / 1_000_000).toFixed(2)}M tokens) · ${remaining} units left · 1M tokens = 10 units · resets in ${h}h ${m}m · /models for the catalog`,
        });
        return true;
      }
      case "models":
        pushItem({
          kind: "info",
          text: "Delta Free Models catalog:\n· glm-4.7-flash — GLM 4.7 Flash · free · 200K context\nmore free models coming soon — check back with /models",
        });
        return true;
      case "agents":
        pushItem({
          kind: "info",
          text: agents.map((a) => `· ${a.name} — ${a.description}`).join("\n"),
        });
        return true;
      case "skills":
        pushItem({
          kind: "info",
          text: skills.map((s) => `· ${s.name}${s.builtin ? " (built-in)" : ""} — ${s.description}`).join("\n"),
        });
        return true;
      case "new": {
        clearScreen();
        sessionFileRef.current = newSession(projectDir);
        historyRef.current = [];
        sessionStartHistoryRef.current = [];
        chatInitRef.current = false;
        setItems([]);
        setPhase("home");
        return true;
      }
      case "clear":
        clearScreen();
        setItems([]);
        return true;
      case "exit":
      case "quit":
        exit();
        return true;
      default:
        return false;
    }
  };

  const submit = async (text: string) => {
    if (!text) return;
    if (busyRef.current) return;
    if (text.startsWith("/")) {
      const handled = await handleSlash(text);
      if (handled) return;
      pushItem({ kind: "info", text: `unknown command: ${text} — try /` });
      return;
    }

    if (config.provider === FREE_PROVIDER_ID && !config.acceptedFreeModels) {
      setFreeStatementOpen(true);
      return;
    }

    const harness = harnessRef.current;
    if (!harness) {
      pushItem({ kind: "error", text: "harness not ready" });
      return;
    }

    busyRef.current = true;
    if (retryRef.current) {
      hiddenIds.current.add(retryRef.current.id);
      retryRef.current = null;
    }
    setBusy(true);
    setCurrentAgent("lead");
    pushItem({ kind: "user", text });
    historyRef.current.push({ role: "user", content: text });
    void appendMsg(sessionFileRef.current, { role: "user", content: text, ts: Date.now() }).catch(() => {});

    streamRef.current = { id: pushItem({ kind: "assistant", text: "", agent: "lead" }), text: "", reasoning: "", startedAt: Date.now() };

    try {
      const history = historyRef.current.filter((m) => m.role === "user" || m.role === "assistant");
      const res = await harness.send(text, history);
      const s = finalizeStream();
      const reasoning = s?.reasoning ?? "";
      if (!res.content.trim()) {
        if (s) updateItem(s.id, { kind: "error", text: "empty response — the model may not support chat. Try /model." });
        pushItem({
          kind: "info",
          text: "The model returned an empty reply. Run /model to list models, or /help for commands.",
        });
      } else {
        if (s) updateItem(s.id, { text: res.content });
        historyRef.current.push({ role: "assistant", content: res.content });
        void appendMsg(sessionFileRef.current, { role: "assistant", content: res.content, reasoning, ts: Date.now() }).catch(() => {});
        const tokens = res.usage.input + res.usage.output;
        if (tokens > 0) {
          pushItem({
            kind: "info",
            text: `▲ ${tokens.toLocaleString()} tokens · ${preset?.name ?? config.provider} · ${modelLabel} (in ${res.usage.input.toLocaleString()} / out ${res.usage.output.toLocaleString()})`,
          });
        }
      }
    } catch (e) {
      const s = finalizeStream();
      const err = e as Error & { name?: string };
      if (harness.aborted || err.name === "AbortError") {
        const partial = s?.text ?? "";
        if (s) updateItem(s.id, { text: partial || "(interrupted)" });
        pushItem({ kind: "info", text: "turn stopped (esc)" });
      } else {
        const msg = friendlyError(err, config.timeouts, config.provider);
        if (s) updateItem(s.id, { kind: "error", text: msg });
        else pushItem({ kind: "error", text: msg });
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
      setCurrentAgent("lead");
    }
  };

  // ---- phases ----------------------------------------------------------

  if (phase === "splash") {
    return <SplashScreen tagline="free coding tool framework — the harness handles the rest" />;
  }

  if (phase === "setup") {
    return (
      <SetupScreen
        config={config}
        mcp={mcp}
        onDone={(cfg) => {
          setConfig({ ...cfg });
          setModelLabel(cfg.model);
          clearScreen();
          setPhase("home");
        }}
        onQuit={() => exit()}
      />
    );
  }

  if (phase === "home") {
    const scopeLabel = resolveAllowedRoots(projectDir)[0] === "/" ? "global scope" : "project scope";
    return (
      <Box flexDirection="column">
        {freeStatementOpen && (
          <Box paddingY={1}>
            <FreeStatement onAccept={acceptFreeModels} onDismiss={dismissFreeModels} />
          </Box>
        )}
        {modelPickerOpen && preset && (
          <Box paddingY={1}>
            <ModelPicker
              preset={preset}
              apiKey={config.apiKey}
              currentModel={config.model}
              onSelect={(m) => {
                config.model = m;
                void saveConfig(config);
                setConfig({ ...config });
                setModelLabel(m);
                setModelPickerOpen(false);
                pushItem({ kind: "info", text: `model set to ${m}` });
              }}
              onClose={() => setModelPickerOpen(false)}
            />
          </Box>
        )}
        <HomeScreen
          projectDir={projectDir}
          providerLabel={preset?.name ?? config.provider}
          model={modelLabel}
          scopeLabel={scopeLabel}
          commands={COMMAND_LIST}
          onSubmit={(text) => {
            setPhase("chat");
            void submit(text);
          }}
          onInterrupt={handleInterrupt}
          onCancel={handleCancel}
        />
      </Box>
    );
  }

  return (
    <Box flexDirection="column" height="100%">
      <Box justifyContent="space-between">
        <ShimmerText text="Δ DeltaCode" />
        <Text color={theme.mist}>
          {projectDir.split("/").filter(Boolean).pop()} · {preset?.name ?? config.provider} · {modelLabel} · {currentAgent}
        </Text>
      </Box>
      <Box>
        <WaveDivider width={40} />
      </Box>
      <Box flexDirection="column" flexGrow={1}>
        {items.filter((it) => !hiddenIds.current.has(it.id)).slice(-MAX_VISIBLE).map((item) => (
          <ItemView key={item.id} item={item} />
        ))}
      </Box>
      <Box flexDirection="column">
        {busy ? (
          <AgentStatus agent={currentAgent} />
        ) : (
          activity.map((a, i) => (
            <Text key={i} color={theme.mist}>
              {i === 0 ? "  ∿ " : "    "}
              {a}
            </Text>
          ))
        )}
      </Box>
      {permission && <PermissionPrompt permission={permission} onChoice={handlePermissionChoice} />}
      {freeStatementOpen && (
        <Box paddingY={1}>
          <FreeStatement onAccept={acceptFreeModels} onDismiss={dismissFreeModels} />
        </Box>
      )}
      {modelPickerOpen && preset && (
        <Box paddingY={1}>
          <ModelPicker
            preset={preset}
            apiKey={config.apiKey}
            currentModel={config.model}
            onSelect={(m) => {
              setModelPickerOpen(false);
              void applyModel(m);
            }}
            onClose={() => setModelPickerOpen(false)}
          />
        </Box>
      )}
      <InputBox
        placeholder={busy ? "working… (esc twice to stop)" : 'ask anything — e.g. "build a todo app"'}
        disabled={inputLocked}
        busy={busy}
        commands={COMMAND_LIST}
        onSubmit={submit}
        onInterrupt={handleInterrupt}
        onCancel={handleCancel}
      />
      {!busy && !permission && !modelPickerOpen && (
        <Text color={theme.oceanDim}>type / for commands · esc clears input · ctrl-c quits</Text>
      )}
    </Box>
  );
}

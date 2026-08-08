import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Harness, trimHistory, isNetworkError, isRetryable } from "../src/harness/loop";
import { BUILTIN_AGENTS, type AgentDef } from "../src/agents/types";
import { BUILTIN_SKILLS } from "../src/skills/builtin";
import { defaultConfig, loadConfig, saveConfig, type DeltaConfig } from "../src/config";
import { createMcpRegistry } from "../src/mcp/registry";
import { OpenAICompatClient, ProviderError } from "../src/providers/openai-compat";
import { isDangerous } from "../src/tools/bash";
import { isGitUrl } from "../src/util";
import { buildLeadPrompt, type SystemPromptContext } from "../src/prompts/system";

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function textChunk(text: string, finish?: string) {
  return { choices: [{ delta: { content: text }, finish_reason: finish ?? null }] };
}

function toolDelta(index: number, partial: { id?: string; name?: string; args?: string }) {
  return {
    choices: [
      {
        delta: {
          tool_calls: [
            { index, ...(partial.id ? { id: partial.id } : {}), function: { ...(partial.name ? { name: partial.name } : {}), ...(partial.args ? { arguments: partial.args } : {}) } },
          ],
        },
      },
    ],
  };
}

function streamOf(parts: string[]): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const p of parts) controller.enqueue(encoder.encode(p));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

let dir: string;
let home: string;
let oldHome: string | undefined;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "delta-audit-"));
  home = await mkdtemp(join(tmpdir(), "delta-audit-home-"));
  oldHome = process.env.HOME;
  process.env.HOME = home;
});

afterAll(async () => {
  if (oldHome) process.env.HOME = oldHome;
  await rm(dir, { recursive: true, force: true });
  await rm(home, { recursive: true, force: true });
});

async function makeHarness(config: DeltaConfig, agents: AgentDef[] = BUILTIN_AGENTS) {
  const mcp = await createMcpRegistry({});
  return new Harness({
    config,
    projectDir: dir,
    agents,
    skills: BUILTIN_SKILLS,
    mcp,
    callbacks: {
      onText: () => {},
      onToolCall: () => {},
      onActivity: () => {},
      onAgentStart: () => {},
      onAgentEnd: () => {},
      confirm: async () => true,
    },
  });
}

describe("fix 1: MCP registry toolsDefs reflects connected tools", () => {
  test("toolsDefs is populated after connectAll (real Exa endpoint)", async () => {
    const reg = await createMcpRegistry({ exa: { url: "https://mcp.exa.ai/mcp" } });
    expect(reg.toolsDefs).toHaveLength(0);
    await reg.connectAll();
    const names = reg.toolsDefs.map((d) => d.function.name);
    expect(names).toContain("web_search_exa");
    expect(names).toContain("web_fetch_exa");
    await reg.closeAll();
  }, 30_000);
});

describe("fix 3: recursion depth + runaway guard", () => {
  test("self-delegating agent stops fast with recursion error", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
        calls++;
        const system = body.messages[0]?.content ?? "";
        const isLead = system.includes("You are the Delta lead agent");
        if (isLead) {
          return streamOf([sse(toolDelta(0, { id: "c1", name: "task", args: `{"agent":"evil","prompt":"go"}` })), sse("[DONE]")]);
        }
        return streamOf([sse(toolDelta(0, { id: "c2", name: "task", args: `{"agent":"evil","prompt":"go again"}` })), sse("[DONE]")]);
      },
    });

    const evil: AgentDef = {
      name: "evil",
      description: "test",
      tools: ["task"],
      skills: [],
      instructions: "",
      canDelegate: true,
      builtin: false,
    };
    const config = defaultConfig();
    config.provider = "zenmux";
    config.apiKey = "k";
    config.model = "m";
    const harness = await makeHarness(config, [...BUILTIN_AGENTS, evil]);
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();

    await expect(harness.send("go", [])).rejects.toThrow(/recursion too deep/);
    expect(calls).toBeLessThan(10); // unwinds fast instead of looping forever
    server.stop();
  });

  test("runaway tool-call loop is capped by MAX_ROUNDS", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++;
        return streamOf([sse(toolDelta(0, { id: "loop", name: "file_info", args: `{"path":"x"}` })), sse("[DONE]")]);
      },
    });
    const config = defaultConfig();
    config.provider = "zenmux";
    config.apiKey = "k";
    config.model = "m";
    const harness = await makeHarness(config);
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();

    await expect(harness.send("loop", [])).rejects.toThrow(/exceeded 40 tool-call rounds/);
    expect(calls).toBe(40);
    server.stop();
  }, 60_000);
});

describe("fix 4: malformed tool args surface as errors", () => {
  test("invalid JSON arguments produce an error tool result, not empty args", async () => {
    const seen: string[] = [];
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
        calls++;
        if (calls === 1) {
          return streamOf([sse(toolDelta(0, { id: "bad", name: "read", args: `{"path": "src/x` })), sse("[DONE]")]);
        }
        for (const m of body.messages) {
          if (m.role === "tool") seen.push(m.content);
        }
        return streamOf([sse(textChunk("handled")), sse("[DONE]")]);
      },
    });
    const config = defaultConfig();
    config.provider = "zenmux";
    config.apiKey = "k";
    config.model = "m";
    const harness = await makeHarness(config);
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();

    const res = await harness.send("go", []);
    expect(res.content).toBe("handled");
    expect(seen.some((c) => c.includes("malformed"))).toBe(true);
    server.stop();
  });
});

describe("fix 6: history trimming", () => {
  test("caps message count and total chars", () => {
    const history = Array.from({ length: 50 }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i} ` + "x".repeat(100),
    }));
    const trimmed = trimHistory(history);
    expect(trimmed.length).toBeLessThanOrEqual(30);
    expect(trimmed.length).toBe(30);

    const big = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      content: `huge ${i} ` + "y".repeat(40_000),
    }));
    const trimmedBig = trimHistory(big, 30, 150_000);
    expect(trimmedBig.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(150_000);
    expect(trimmedBig.length).toBeGreaterThanOrEqual(2);
  });
});

describe("fix 7: finish_reason length continues the response", () => {
  test("cut-off response is continued", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
        calls++;
        if (calls === 1) {
          return streamOf([sse(textChunk("partial answer ", "length")), sse("[DONE]")]);
        }
        expect(body.messages.some((m) => m.role === "user" && m.content.includes("cut off"))).toBe(true);
        return streamOf([sse(textChunk("continued.")), sse("[DONE]")]);
      },
    });
    const config = defaultConfig();
    config.provider = "zenmux";
    config.apiKey = "k";
    config.model = "m";
    const harness = await makeHarness(config);
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();

    const res = await harness.send("go", []);
    expect(res.content).toBe("partial answer continued.");
    server.stop();
  });
});

describe("fix 8: index-based tool call accumulation", () => {
  test("tool call without id on first chunk still accumulates correctly", async () => {
    const encoder = new TextEncoder();
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(sse(toolDelta(0, { name: "read", args: `{"pa` }))));
              controller.enqueue(encoder.encode(sse(toolDelta(0, { id: "call_real", args: `th":"x"}` }))));
              controller.enqueue(encoder.encode(sse("[DONE]")));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const client = new OpenAICompatClient({ baseUrl: server.url.toString(), apiKey: "k", model: "m" });
    const res = await client.stream([{ role: "user", content: "hi" }], []);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]!.id).toBe("call_real");
    expect(res.toolCalls[0]!.function.name).toBe("read");
    expect(res.toolCalls[0]!.function.arguments).toBe(`{"path":"x"}`);
    server.stop();
  });
});

describe("fix 9: dangerous command detection", () => {
  test("blocks system-wipe commands", () => {
    expect(isDangerous("rm -rf /")).toBe(true);
    expect(isDangerous("rm -rf /*")).toBe(true);
    expect(isDangerous("rm -rf ~")).toBe(true);
    expect(isDangerous("rm -rf $HOME")).toBe(true);
    expect(isDangerous("sudo rm -rf /etc")).toBe(true);
    expect(isDangerous("rm -rf /usr/local/lib")).toBe(true);
    expect(isDangerous("mkfs.ext4 /dev/sda1")).toBe(true);
    expect(isDangerous("dd if=/dev/zero of=/dev/sda")).toBe(true);
  });

  test("allows normal cleanup commands", () => {
    expect(isDangerous("rm -rf ./dist")).toBe(false);
    expect(isDangerous("rm -rf /tmp/scratch-build")).toBe(false);
    expect(isDangerous("rm -rf build/node_modules")).toBe(false);
    expect(isDangerous("git clean -fdx")).toBe(false);
    expect(isDangerous("ls -la /etc")).toBe(false);
  });
});

describe("fix 11: duplicate content guard", () => {
  test("message.content is not appended when deltas already streamed", async () => {
    const encoder = new TextEncoder();
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(sse({ choices: [{ delta: { content: "Hello " } }] })));
              controller.enqueue(encoder.encode(sse({ choices: [{ message: { content: "Hello world" } }] })));
              controller.enqueue(encoder.encode(sse("[DONE]")));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const client = new OpenAICompatClient({ baseUrl: server.url.toString(), apiKey: "k", model: "m" });
    const res = await client.stream([{ role: "user", content: "hi" }], []);
    expect(res.content).toBe("Hello ");
    server.stop();
  });
});

describe("fix 16: git url detection", () => {
  test("accepts url / scp / domain forms", () => {
    expect(isGitUrl("https://github.com/x/y")).toBe(true);
    expect(isGitUrl("git@github.com:x/y.git")).toBe(true);
    expect(isGitUrl("github.com/x/y")).toBe(true);
    expect(isGitUrl("x/y.git")).toBe(true);
  });
  test("rejects local paths", () => {
    expect(isGitUrl("./my-skill")).toBe(false);
    expect(isGitUrl("../skills/foo")).toBe(false);
    expect(isGitUrl("my-folder")).toBe(false);
    expect(isGitUrl("/abs/path/skill")).toBe(false);
  });
});

describe("fix 18: config deep merge", () => {
  test("partial timeouts block keeps other defaults", async () => {
    const cfg = defaultConfig();
    cfg.provider = "zenmux";
    cfg.apiKey = "k";
    cfg.model = "m";
    cfg.timeouts = { requestMs: 123, idleMs: 456, bashMs: 789 };
    await saveConfig(cfg);
    // write a config with only ONE timeout field
    const { writeFile } = await import("node:fs/promises");
    const { getConfigPath } = await import("../src/config");
    await writeFile(getConfigPath(), JSON.stringify({ provider: "zenmux", apiKey: "k", model: "m", timeouts: { requestMs: 9999 } }));
    const loaded = await loadConfig();
    expect(loaded.timeouts.requestMs).toBe(9999);
    expect(loaded.timeouts.idleMs).toBe(180_000);
    expect(loaded.timeouts.bashMs).toBe(120_000);
    await rm(getConfigPath(), { force: true });
  });
});

describe("system prompt teaches tool use end to end", () => {
  function ctx(overrides: Partial<SystemPromptContext> = {}): SystemPromptContext {
    return {
      agent: BUILTIN_AGENTS[0]!,
      skills: BUILTIN_SKILLS,
      availableTools: ["read", "write", "edit", "bash", "task"],
      mcpTools: [],
      delegatableNames: ["coding", "frontend", "backend", "reviewer", "researcher"],
      projectDir: "/tmp/proj",
      projectName: "proj",
      model: "m",
      providerName: "ZenMux",
      ...overrides,
    };
  }

  test("lead prompt forces tool calls and explains the workflow", () => {
    const prompt = buildLeadPrompt(ctx());
    expect(prompt).toContain("Never describe an action you can perform — perform it");
    expect(prompt).toContain("You act by calling tools");
    expect(prompt).toContain("`write {path, content}`");
    expect(prompt).toContain("The user is NOT done until the files exist on disk");
    expect(prompt).toContain("Verify");
    expect(prompt).toContain("`task {agent, prompt, description?}`");
    expect(prompt).toContain("coding");
    expect(prompt).toContain("researcher");
    expect(prompt).toContain("DO IT YOURSELF");
    expect(prompt).toContain("Available tools: read, write, edit, bash, task");
  });

  test("specialist prompt also forces tool use and includes write", () => {
    const prompt = buildLeadPrompt(ctx({ agent: BUILTIN_AGENTS.find((a) => a.name === "coding")! }));
    expect(prompt).toContain("Never describe an action you can perform — perform it");
    expect(prompt).toContain("write");
    expect(prompt).toContain("syntax");
  });

  test("user-defined agents appear in the delegation list", () => {
    const prompt = buildLeadPrompt(ctx({ delegatableNames: ["coding", "my-specialist"] }));
    expect(prompt).toContain("`my-specialist`");
    expect(prompt).toContain("`coding`");
  });
});

describe("max_tokens is sent to the provider", () => {
  test("payload includes max_tokens from config", async () => {
    let seenMaxTokens: unknown = null;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { max_tokens?: number };
        seenMaxTokens = body.max_tokens;
        return streamOf([sse(textChunk("ok")), sse("[DONE]")]);
      },
    });
    const config = defaultConfig();
    config.provider = "zenmux";
    config.apiKey = "k";
    config.model = "m";
    const harness = await makeHarness(config);
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();
    await harness.send("hi", []);
    expect(seenMaxTokens).toBe(8192);
    server.stop();
  });
});

describe("end-to-end: create a website in one html file", () => {
  test("write tool call produces the file on disk", async () => {
    const HTML = "<!DOCTYPE html><html><body><h1>My Site</h1></body></html>";
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as {
          messages: Array<{ role: string; content: string }>;
        };
        calls++;
        if (calls === 1) {
          return streamOf([
            sse(
              toolDelta(0, {
                id: "w1",
                name: "write",
                args: JSON.stringify({ path: "index.html", content: HTML }),
              }),
            ),
            sse("[DONE]"),
          ]);
        }
        const toolResult = body.messages.find((m) => m.role === "tool");
        expect(toolResult?.content).toContain("Wrote");
        return streamOf([sse(textChunk("Website created in index.html.")), sse("[DONE]")]);
      },
    });
    const config = defaultConfig();
    config.provider = "zenmux";
    config.apiKey = "k";
    config.model = "m";
    const harness = await makeHarness(config);
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();

    const res = await harness.send("create me a website in a single html file", []);
    expect(res.content).toBe("Website created in index.html.");

    const { readFile } = await import("node:fs/promises");
    const written = await readFile(join(dir, "index.html"), "utf8");
    expect(written).toBe(HTML);
    server.stop();
  });

  test("subagent (coding) writes files in the project dir", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
        calls++;
        const system = body.messages[0]?.content ?? "";
        const isLead = system.includes("You are the Delta lead agent");
        if (isLead && calls === 1) {
          return streamOf([
            sse(toolDelta(0, { id: "t1", name: "task", args: `{"agent":"coding","prompt":"create app.js","description":"make it"}` })),
            sse("[DONE]"),
          ]);
        }
        if (!isLead && calls === 2) {
          return streamOf([
            sse(toolDelta(0, { id: "w2", name: "write", args: `{"path":"app.js","content":"console.log(1)"}` })),
            sse("[DONE]"),
          ]);
        }
        if (!isLead) {
          return streamOf([sse(textChunk("done, wrote app.js")), sse("[DONE]")]);
        }
        return streamOf([sse(textChunk("app built")), sse("[DONE]")]);
      },
    });
    const config = defaultConfig();
    config.provider = "zenmux";
    config.apiKey = "k";
    config.model = "m";
    const harness = await makeHarness(config);
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();

    const res = await harness.send("build the app", []);
    expect(res.content).toBe("app built");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(join(dir, "app.js"), "utf8")).toBe("console.log(1)");
    server.stop();
  });
});

describe("Cohere 400 fix: sanitized tool calls echoed to the provider", () => {
  test("malformed-args call is normalized to {} and nameless call is dropped", async () => {
    // The mock plays the role of a STRICT provider: on the second request it
    // inspects the assistant message it receives back and asserts every
    // tool_calls entry has a name and JSON-object string arguments.
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as {
          messages: Array<{ role: string; content: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }>;
        };
        calls++;
        if (calls === 1) {
          // one malformed call (truncated args), one nameless call
          return streamOf([
            sse(toolDelta(0, { id: "bad1", name: "write", args: `{"path": "index.ht` })),
            sse(toolDelta(1, { id: "anon", name: "", args: `{}` })),
            sse("[DONE]"),
          ]);
        }
        const assistant = body.messages.filter((m) => m.role === "assistant" && m.tool_calls) as Array<{
          tool_calls: Array<{ function: { name: string; arguments: string } }>;
        }>;
        const callsEchoed = assistant[0]!.tool_calls;
        expect(callsEchoed.length).toBe(1); // nameless dropped
        expect(callsEchoed[0]!.function.name).toBe("write");
        expect(callsEchoed[0]!.function.arguments).toBe("{}"); // malformed normalized
        expect(() => JSON.parse(callsEchoed[0]!.function.arguments)).not.toThrow();
        // the tool result for the normalized call exists
        const toolResults = body.messages.filter((m) => m.role === "tool");
        expect(toolResults.length).toBe(1);
        expect(toolResults[0]!.content).toContain("malformed");
        return streamOf([sse(textChunk("recovered")), sse("[DONE]")]);
      },
    });
    const config = defaultConfig();
    config.provider = "zenmux";
    config.apiKey = "k";
    config.model = "m";
    const harness = await makeHarness(config);
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();

    const res = await harness.send("make a site", []);
    expect(res.content).toBe("recovered");
    server.stop();
  });

  test("index-less arg-splitting chunks accumulate into ONE call", async () => {
    const client = new OpenAICompatClient({ baseUrl: "http://x", apiKey: "k", model: "m" });
    const encoder = new TextEncoder();
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              // no id, no index — name on first chunk only
              controller.enqueue(encoder.encode(sse({ choices: [{ delta: { tool_calls: [{ function: { name: "write", arguments: `{"path":` } }] } }] })));
              controller.enqueue(encoder.encode(sse({ choices: [{ delta: { tool_calls: [{ function: { arguments: ` "a.html","content":` } }] } }] })));
              controller.enqueue(encoder.encode(sse({ choices: [{ delta: { tool_calls: [{ function: { arguments: `"x"}` } }] } }] })));
              controller.enqueue(encoder.encode(sse("[DONE]")));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const c2 = new OpenAICompatClient({ baseUrl: server.url.toString(), apiKey: "k", model: "m" });
    const res = await c2.stream([{ role: "user", content: "hi" }], []);
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0]!.function.name).toBe("write");
    expect(res.toolCalls[0]!.function.arguments).toBe(`{"path": "a.html","content":"x"}`);
    server.stop();
  });

  test("generated ids never collide with provider ids", async () => {
    const client = new OpenAICompatClient({ baseUrl: "http://x", apiKey: "k", model: "m" });
    const encoder = new TextEncoder();
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              // provider sends an id that looks like OUR old generated scheme
              controller.enqueue(encoder.encode(sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_0", function: { name: "read", arguments: `{"path":"a"}` } }] } }] })));
              controller.enqueue(encoder.encode(sse({ choices: [{ delta: { tool_calls: [{ index: 1, id: "call_1", function: { name: "read", arguments: `{"path":"b"}` } }] } }] })));
              controller.enqueue(encoder.encode(sse("[DONE]")));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const c2 = new OpenAICompatClient({ baseUrl: server.url.toString(), apiKey: "k", model: "m" });
    const res = await c2.stream([{ role: "user", content: "hi" }], []);
    expect(res.toolCalls).toHaveLength(2);
    expect(res.toolCalls[0]!.id).toBe("call_0");
    expect(res.toolCalls[1]!.id).toBe("call_1");
    expect(new Set(res.toolCalls.map((c) => c.id)).size).toBe(2); // distinct
    server.stop();
  });

  test("write tool rejects missing path/content with clear errors", async () => {
    const { writeTool } = await import("../src/tools/fs");
    const ctx = { cwd: dir, allowedRoots: [dir], confirm: async () => true };
    const r1 = await writeTool.handler(ctx as never, { content: "x" });
    expect(r1.output).toContain("requires a `path`");
    const r2 = await writeTool.handler(ctx as never, { path: "a.txt", content: "" });
    expect(r2.output).toContain("non-empty `content`");
  });
});

describe("auto-retry on transient provider failures", () => {
  function retryConfig(): DeltaConfig {
    const c = defaultConfig();
    c.provider = "zenmux";
    c.apiKey = "k";
    c.model = "m";
    c.timeouts = { requestMs: 600_000, idleMs: 300, bashMs: 120_000 }; // fast idle for stall tests
    return c;
  }

  test("recovers from 429 rate limits", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async () => {
        calls++;
        if (calls <= 2) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
        }
        return streamOf([sse(textChunk("finally ok")), sse("[DONE]")]);
      },
    });
    const harness = await makeHarness(retryConfig());
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();
    const res = await harness.send("go", []);
    expect(res.content).toBe("finally ok");
    expect(calls).toBe(3);
    server.stop();
  });

  test("recovers from an idle stall (no stream data)", async () => {
    let calls = 0;
    const encoder = new TextEncoder();
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++;
        if (calls === 1) {
          // stall: one chunk then silence — the 300ms idle guard aborts it
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode("data: " + JSON.stringify({ choices: [{ delta: { content: "pa" } }] }) + "\n\n"));
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } },
          );
        }
        return streamOf([sse(textChunk("rt")), sse("[DONE]")]);
      },
    });
    const harness = await makeHarness(retryConfig());
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();
    const res = await harness.send("go", []);
    expect(res.content).toBe("rt"); // partial "pa" discarded, retry produced "rt"
    expect(calls).toBe(2);
    server.stop();
  });

  test("non-retryable errors (400) fail immediately with one request", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++;
        return new Response(JSON.stringify({ error: { message: "bad request" } }), { status: 400 });
      },
    });
    const harness = await makeHarness(retryConfig());
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();
    await expect(harness.send("go", [])).rejects.toThrow(/Provider error 400/);
    expect(calls).toBe(1);
    server.stop();
  });

  test("cancel during backoff aborts immediately", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++;
        return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
      },
    });
    const harness = await makeHarness(retryConfig());
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();
    const p = harness.send("go", []);
    await new Promise((r) => setTimeout(r, 250)); // let the first 429 arrive and backoff start
    const t0 = Date.now();
    harness.cancel();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(Date.now() - t0).toBeLessThan(1000); // did NOT sleep the full backoff
    server.stop();
  });

  test("onRetry callback fires with attempt and reason", async () => {
    let calls = 0;
    const retries: Array<{ attempt: number; reason: string }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: () => {
        calls++;
        if (calls === 1) {
          return new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 });
        }
        return streamOf([sse(textChunk("ok")), sse("[DONE]")]);
      },
    });
    const config = retryConfig();
    const mcp = await createMcpRegistry({});
    const harness = new Harness({
      config,
      projectDir: dir,
      agents: BUILTIN_AGENTS,
      skills: BUILTIN_SKILLS,
      mcp,
      callbacks: {
        onText: () => {},
        onToolCall: () => {},
        onActivity: () => {},
        onAgentStart: () => {},
        onAgentEnd: () => {},
        confirm: async () => true,
        onRetry: (_agent, attempt, reason) => retries.push({ attempt, reason }),
      },
    });
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();
    await harness.send("go", []);
    expect(retries).toHaveLength(1);
    expect(retries[0]!.attempt).toBe(1);
    expect(retries[0]!.reason).toContain("429");
    server.stop();
  });
});

describe("Delta Free Models harness behavior", () => {
  function freeConfig(): DeltaConfig {
    const c = defaultConfig();
    c.provider = "delta-free";
    c.apiKey = "delta-free";
    c.model = "bogus-model"; // must be overridden by the lock
    c.retries = 50;
    return c;
  }

  test("model is pinned to glm-4.7-flash regardless of config", async () => {
    let seenModel = "";
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { model: string };
        seenModel = body.model;
        return streamOf([sse(textChunk("ok")), sse("[DONE]")]);
      },
    });
    const harness = await makeHarness(freeConfig());
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();
    const res = await harness.send("hi", []);
    expect(res.content).toBe("ok");
    expect(seenModel).toBe("glm-4.7-flash"); // never the bogus config model
    server.stop();
  });

  test("sends X-Delta-User (hashed device id) and X-Delta-Date headers", async () => {
    let user = "", date = "";
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        user = req.headers.get("X-Delta-User") || "";
        date = req.headers.get("X-Delta-Date") || "";
        return streamOf([sse(textChunk("ok")), sse("[DONE]")]);
      },
    });
    const harness = await makeHarness(freeConfig());
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();
    await harness.send("hi", []);
    expect(user.length).toBe(64); // sha256 hex
    expect(date.length).toBe(10); // YYYY-MM-DD
    server.stop();
  });

  test("network failures fail fast on delta-free (no retry storm)", async () => {
    const t0 = Date.now();
    const harness = await makeHarness(freeConfig());
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = "http://127.0.0.1:1"; // unreachable
    await expect(harness.send("hi", [])).rejects.toThrow();
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(2000); // no exponential-backoff wait
  });
});

describe("error classification split", () => {
  test("network errors are NOT transient-retryable", () => {
    expect(isNetworkError(new Error("fetch failed"))).toBe(true);
    expect(isNetworkError(new Error("getaddrinfo ENOTFOUND free.delta.dev"))).toBe(true);
    expect(isNetworkError(new Error("Was there a typo in the url or port?"))).toBe(true);
    expect(isNetworkError(new Error("socket connection closed unexpectedly"))).toBe(true);
    expect(isNetworkError(new Error("Provider error 429: rate limited"))).toBe(false);
    expect(isNetworkError(new Error("Provider error 503: overloaded"))).toBe(false);
  });

  test("transient errors (overload/rate/5xx) stay retryable", () => {
    expect(isRetryable(new ProviderError(429, "", "rate limit reached"))).toBe(true);
    expect(isRetryable(new ProviderError(500, "", "boom"))).toBe(true);
    expect(isRetryable(new ProviderError(503, "", "overloaded"))).toBe(true);
    expect(isRetryable(new ProviderError(400, "", "bad request"))).toBe(false);
    expect(isRetryable(new Error("the service may be temporarily overloaded, please try again later"))).toBe(true);
    expect(isRetryable(new Error("fetch failed"))).toBe(false); // network split out
  });
});

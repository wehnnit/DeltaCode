import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Harness } from "../src/harness/loop";
import type { AgentDef } from "../src/agents/types";
import { BUILTIN_AGENTS } from "../src/agents/types";
import { BUILTIN_SKILLS } from "../src/skills/builtin";
import { defaultConfig, type DeltaConfig } from "../src/config";
import { createMcpRegistry } from "../src/mcp/registry";

function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function toolCallChunk(index: number, id: string, name: string, args: string) {
  return { choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: args } }] } }] };
}

function textChunk(text: string) {
  return { choices: [{ delta: { content: text } }] };
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

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "delta-harness-"));
  await mkdir(join(dir, "src"), { recursive: true });
  await writeFile(join(dir, "src", "a.ts"), "export const a = 1;\n");
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeHarness(config: DeltaConfig) {
  const mcp = await createMcpRegistry({});
  return new Harness({
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
    },
  });
}

describe("harness integration (mock provider)", () => {
  test("lead delegates to coding specialist via task tool, merges result", async () => {
    const leadTurns: number[] = [];
    const codingTurns: number[] = [];
    const observed: Array<{ agent: string; turn: number; tools: string[]; hasSystem: boolean }> = [];

    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as {
          messages: Array<{ role: string; content: string }>;
          tools?: Array<{ function: { name: string } }>;
        };
        const system = body.messages[0]?.content ?? "";
        const isLead = system.includes("You are the Delta lead agent");
        const bucket = isLead ? leadTurns : codingTurns;
        bucket.push(0);
        const turn = bucket.length - 1;
        observed.push({
          agent: isLead ? "lead" : "coding",
          turn,
          tools: body.tools?.map((t) => t.function.name) ?? [],
          hasSystem: system.length > 100,
        });

        if (isLead && turn === 0) {
          return streamOf([sse(toolCallChunk(0, "call_task", "task", `{"agent":"coding","prompt":"fix src/a.ts","description":"fix it"}`)), sse("[DONE]")]);
        }
        if (!isLead && turn === 0) {
          return streamOf([sse(toolCallChunk(0, "call_read", "read", `{"path":"src/a.ts"}`)), sse("[DONE]")]);
        }
        if (!isLead && turn === 1) {
          return streamOf([sse(textChunk("Fixed and verified.")), sse("[DONE]")]);
        }
        if (isLead && turn === 1) {
          return streamOf([sse(textChunk("Done: ")), sse(textChunk("fixed it.")), sse("[DONE]")]);
        }
        return streamOf([sse(textChunk("ok")), sse("[DONE]")]);
      },
    });

    const config = defaultConfig();
    config.provider = "zenmux";
    config.apiKey = "k";
    config.model = "m";
    const harness = await makeHarness(config);
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();

    const res = await harness.send("fix the file", []);

    expect(res.content).toBe("Done: fixed it.");
    expect(observed.length).toBe(4);

    const lead0 = observed[0]!;
    expect(lead0.agent).toBe("lead");
    expect(lead0.turn).toBe(0);
    expect(lead0.tools).toContain("task");
    expect(lead0.hasSystem).toBe(true);

    const coding0 = observed[1]!;
    expect(coding0.agent).toBe("coding");
    expect(coding0.tools).toContain("read");
    expect(coding0.tools).not.toContain("task");
    expect(coding0.tools).not.toContain("web_search_exa");

    const lead1 = observed[3]!;
    expect(lead1.agent).toBe("lead");
    expect(lead1.turn).toBe(1);

    server.stop();
  });

  test("tool results flow back into the conversation", async () => {
    let calls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as {
          messages: Array<{ role: string; content: string; tool_call_id?: string }>;
        };
        calls++;
        if (calls === 1) {
          return streamOf([sse(toolCallChunk(0, "c1", "read", `{"path":"src/a.ts"}`)), sse("[DONE]")]);
        }
        const hasToolResult = body.messages.some((m) => m.role === "tool" && m.tool_call_id === "c1");
        expect(hasToolResult).toBe(true);
        return streamOf([sse(textChunk("ok")), sse("[DONE]")]);
      },
    });

    const config = defaultConfig();
    config.provider = "zenmux";
    config.apiKey = "k";
    config.model = "m";
    const harness = await makeHarness(config);
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();

    const res = await harness.send("read it", []);
    expect(res.content).toBe("ok");
    server.stop();
  });

  test("unknown agent name in task tool returns error output", async () => {
    let leadCalls = 0;
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { messages: Array<{ role: string; content: string }> };
        void body;
        leadCalls++;
        if (leadCalls === 1) {
          return streamOf([sse(toolCallChunk(0, "c1", "task", `{"agent":"nope","prompt":"x"}`)), sse("[DONE]")]);
        }
        const msg = JSON.stringify(body.messages.find((m) => m.role === "tool"));
        expect(msg).toContain("Unknown specialist");
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
    server.stop();
  });

  test("cancel() aborts an in-flight turn", async () => {
    const encoder = new TextEncoder();
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  "data: " + JSON.stringify({ choices: [{ delta: { content: "long " } }] }) + "\n\n",
                ),
              );
              // never close — turn would hang forever unless aborted
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });

    const config = defaultConfig();
    config.provider = "zenmux";
    config.apiKey = "k";
    config.model = "m";
    const harness = await makeHarness(config);
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();

    const sendP = harness.send("hi", []);
    setTimeout(() => harness.cancel(), 150);

    await expect(sendP).rejects.toMatchObject({ name: "AbortError" });
    expect(harness.aborted).toBe(true);
    server.stop();
  });

  test("lead model override is respected for specialists", async () => {
    const agents: AgentDef[] = BUILTIN_AGENTS.map((a) =>
      a.name === "coding" ? { ...a, model: "cheap-model" } : a,
    );
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { model: string; messages: Array<{ role: string; content: string }> };
        const system = body.messages[0]?.content ?? "";
        const isLead = system.includes("You are the Delta lead agent");
        if (isLead) {
          const alreadyDelegated = body.messages.some((m) => m.role === "tool");
          if (alreadyDelegated) {
            return streamOf([sse(textChunk("merged")), sse("[DONE]")]);
          }
          return streamOf([sse(toolCallChunk(0, "c1", "task", `{"agent":"coding","prompt":"go"}`)), sse("[DONE]")]);
        }
        expect(body.model).toBe("cheap-model");
        return streamOf([sse(textChunk("sub done")), sse("[DONE]")]);
      },
    });

    const config = defaultConfig();
    config.provider = "zenmux";
    config.apiKey = "k";
    config.model = "m";
    const mcp = await createMcpRegistry({});
    const harness = new Harness({
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
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();

    await harness.send("go", []);
    server.stop();
  });
});

describe("reasoning + tool result callbacks", () => {
  test("forwards reasoning deltas and tool results", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        const body = (await req.json()) as { messages: Array<{ role: string }> };
        const n = body.messages.length;
        if (n <= 2) {
          return streamOf([
            sse({ choices: [{ delta: { reasoning_content: "thinking…", content: "" } }] }),
            sse(toolCallChunk(0, "call_1", "write", `{"path":"out.txt","content":"x"}`)),
            sse("[DONE]"),
          ]);
        }
        return streamOf([sse(textChunk("done.")), sse("[DONE]")]);
      },
    });

    const config = defaultConfig();
    config.provider = "zenmux";
    config.apiKey = "k";
    config.model = "m";
    const mcp = await createMcpRegistry({});
    const reasoning: string[] = [];
    const results: Array<{ name: string; result: string }> = [];
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
        onReasoning: (_a, d) => reasoning.push(d),
        onToolResult: (_a, name, _args, result) => results.push({ name, result }),
        confirm: async () => true,
      },
    });
    (harness as unknown as { preset: { baseUrl: string } }).preset.baseUrl = server.url.toString();

    await harness.send("go", []);
    server.stop();

    expect(reasoning.join("")).toBe("thinking…");
    expect(results.length).toBe(1);
    expect(results[0]!.name).toBe("write");
    expect(results[0]!.result).toContain("Wrote 1 chars to out.txt");
  });
});

import { describe, expect, test, afterAll, beforeAll } from "bun:test";
import { OpenAICompatClient, parseSse, type ChatMessage } from "../src/providers/openai-compat";

function ssePayload(delta: string, extra: { reasoning?: boolean } = {}): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: { content: delta, ...(extra.reasoning ? { reasoning_content: "let me think…" } : {}) } }],
  })}\n\n`;
}

describe("parseSse", () => {
  test("parses data lines and stops at [DONE]", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(ssePayload("hel")));
        controller.enqueue(encoder.encode(ssePayload("lo")));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const raw of parseSse(stream)) out.push(raw);
    expect(out).toEqual([JSON.stringify({ choices: [{ delta: { content: "hel" } }] }), JSON.stringify({ choices: [{ delta: { content: "lo" } }] }), "[DONE]"]);
  });

  test("handles partial lines across chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: {"));
        controller.enqueue(encoder.encode(`"x":1}`));
        controller.enqueue(encoder.encode("\n\n"));
        controller.close();
      },
    });
    const out: string[] = [];
    for await (const raw of parseSse(stream)) out.push(raw);
    expect(out).toEqual([`{"x":1}`]);
  });
});

describe("OpenAICompatClient", () => {
  let server: ReturnType<typeof Bun.serve>;
  const requests: Array<{ path: string; body: unknown }> = [];

  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/models") {
          return Response.json({ data: [{ id: "mock-model" }] });
        }
        if (url.pathname === "/chat/completions") {
          void req.json().then((body) => requests.push({ path: url.pathname, body })).catch(() => {});
          const encoder = new TextEncoder();
          const body = new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(ssePayload("", { reasoning: true })));
              controller.enqueue(encoder.encode(ssePayload("Hello ")));
              controller.enqueue(
                encoder.encode(
                  "data: " + JSON.stringify({
                    choices: [
                      {
                        delta: {
                          tool_calls: [
                            { index: 0, id: "call_1", function: { name: "read", arguments: '{"pa' } },
                          ],
                        },
                      },
                    ],
                  }) + "\n\n",
                ),
              );
              controller.enqueue(
                encoder.encode(
                  "data: " +
                    JSON.stringify({
                      choices: [
                        {
                          delta: {
                            tool_calls: [
                              {
                                index: 0,
                                function: {
                                  name: "read",
                                  arguments: 'th":"x"}',
                                },
                              },
                            ],
                          },
                        },
                      ],
                    }) +
                    "\n\n",
                ),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          });
          return new Response(body, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return new Response("not found", { status: 404 });
      },
    });
  });

  afterAll(() => {
    server.stop();
  });

  test("streams text and accumulates tool call args", async () => {
    const client = new OpenAICompatClient({
      baseUrl: server.url.toString(),
      apiKey: "test-key",
      model: "mock-model",
    });
    const texts: string[] = [];
    const calls: Array<{ name: string; args: string }> = [];
    const result = await client.stream(
      [{ role: "user", content: "hi" }],
      [{ type: "function", function: { name: "read", description: "r", parameters: {} } }],
      {
        onText: (d) => texts.push(d),
        onToolCallStart: (c) => calls.push({ name: c.function.name, args: c.function.arguments }),
      },
    );
    expect(texts.join("")).toBe("Hello ");
    expect(result.content).toBe("Hello ");
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.function.name).toBe("read");
    expect(result.toolCalls[0]!.function.arguments).toBe(`{"path":"x"}`);
  });

  test("extracts reasoning_content and emits onReasoning", async () => {
    const events: string[] = [];
    const client = new OpenAICompatClient({
      baseUrl: server.url.toString(),
      apiKey: "k",
      model: "m",
    });
    const result = await client.stream(
      [{ role: "user", content: "hi" }],
      [],
      {
        onReasoning: (d) => events.push(d),
        onText: () => {},
      },
    );
    expect(events.join("")).toBe("let me think…");
    expect(result.reasoning).toBe("let me think…");
    expect(result.content).toBe("Hello ");
  });

  test("lists models", async () => {
    const client = new OpenAICompatClient({ baseUrl: server.url.toString(), apiKey: "k", model: "m" });
    expect(await client.listModels()).toEqual(["mock-model"]);
  });

  test("sends proper auth header", () => {
    const client = new OpenAICompatClient({ baseUrl: server.url.toString(), apiKey: "k", model: "m" });
    expect(client).toBeDefined();
  });

  test("throws ProviderError with status on non-ok response", async () => {
    const errServer = Bun.serve({
      port: 0,
      fetch: () => new Response("bad key", { status: 401 }),
    });
    const client = new OpenAICompatClient({
      baseUrl: errServer.url.toString(),
      apiKey: "bad",
      model: "m",
    });
    await expect(client.stream([{ role: "user", content: "hi" }], [])).rejects.toThrow(
      /Provider error 401/,
    );
    errServer.stop();
  });

  test("throws on error event inside the stream (was silently ignored)", async () => {
    const encoder = new TextEncoder();
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  "data: " + JSON.stringify({ error: { message: "model not found", type: "invalid_request_error" } }) + "\n\n",
                ),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const client = new OpenAICompatClient({
      baseUrl: server.url.toString(),
      apiKey: "k",
      model: "bad-model",
    });
    await expect(client.stream([{ role: "user", content: "hi" }], [])).rejects.toThrow(
      /model not found/,
    );
    server.stop();
  });

  test("captures content from final message chunk (some providers don't stream delta.content)", async () => {
    const encoder = new TextEncoder();
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  "data: " + JSON.stringify({ choices: [{ message: { content: "hello back" } }] }) + "\n\n",
                ),
              );
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              controller.close();
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const client = new OpenAICompatClient({
      baseUrl: server.url.toString(),
      apiKey: "k",
      model: "m",
    });
    const result = await client.stream([{ role: "user", content: "hi" }], []);
    expect(result.content).toBe("hello back");
    server.stop();
  });

  test("user abort signal cancels the stream", async () => {
    const encoder = new TextEncoder();
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("data: " + JSON.stringify({ choices: [{ delta: { content: "a" } }] }) + "\n\n"));
              // never closes
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const client = new OpenAICompatClient({
      baseUrl: server.url.toString(),
      apiKey: "k",
      model: "m",
    });
    const controller = new AbortController();
    const p = client.stream([{ role: "user", content: "hi" }], [], { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    server.stop();
  });

  test("idle timeout aborts when the provider stalls mid-stream", async () => {
    const encoder = new TextEncoder();
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode("data: " + JSON.stringify({ choices: [{ delta: { content: "a" } }] }) + "\n\n"));
              // then stalls forever
            },
          }),
          { headers: { "Content-Type": "text/event-stream" } },
        ),
    });
    const client = new OpenAICompatClient({
      baseUrl: server.url.toString(),
      apiKey: "k",
      model: "m",
      idleTimeoutMs: 300,
    });
    await expect(client.stream([{ role: "user", content: "hi" }], [])).rejects.toThrow(
      /no data from provider/,
    );
    server.stop();
  });

  test("request timeout aborts a never-responding provider", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>(() => {}), // never responds
    });
    const client = new OpenAICompatClient({
      baseUrl: server.url.toString(),
      apiKey: "k",
      model: "m",
      requestTimeoutMs: 300,
    });
    await expect(client.stream([{ role: "user", content: "hi" }], [])).rejects.toMatchObject({
      name: "TimeoutError",
    });
    server.stop();
  });
});

describe("harness message shapes", () => {
  test("ChatMessage serializes cleanly", () => {
    const msg: ChatMessage = {
      role: "assistant",
      content: "hi",
      tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }],
    };
    expect(JSON.stringify(msg)).toContain('"tool_calls"');
  });
});

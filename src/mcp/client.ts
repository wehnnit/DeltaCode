import {
  Client,
} from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { McpServerConfig } from "../config";

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export class McpClient {
  private client: Client | null = null;
  private tools: McpTool[] = [];
  private timeoutMs: number;

  constructor(
    private config: McpServerConfig,
    private name: string,
  ) {
    this.timeoutMs = config.timeoutMs ?? 60_000;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    const transport = new StreamableHTTPClientTransport(new URL(this.config.url), {
      requestInit: {
        headers: this.config.headers ?? {},
      },
    });
    const client = new Client(
      { name: "delta", version: "0.1.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
      const list = await client.listTools();
      this.tools = (list.tools ?? []).map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: (t.inputSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      }));
      this.client = client;
    } catch (e) {
      throw new Error(`Failed to connect MCP server ${this.name}: ${(e as Error).message}`);
    }
  }

  getTools(): McpTool[] {
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    if (!this.client) throw new Error(`MCP server ${this.name} not connected`);
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { signal: AbortSignal.timeout(this.timeoutMs) },
    );
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content
      .map((c) => {
        const c2 = c as { type?: string; text?: string };
        return c2.type === "text" ? (c2.text ?? "") : JSON.stringify(c);
      })
      .filter(Boolean)
      .join("\n");
    if (result.isError) {
      return `MCP tool ${name} error: ${text.slice(0, 2000)}`;
    }
    return text.slice(0, 24000);
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // ignore
    }
    this.client = null;
  }
}

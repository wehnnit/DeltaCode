import { McpClient, type McpTool } from "./client";
import type { McpServerConfig } from "../config";
import type { ToolDef } from "../providers/openai-compat";

export interface McpRegistry {
  clients: McpClient[];
  tools: Map<string, { client: McpClient; mcpTool: McpTool }>;
  connectAll: () => Promise<void>;
  closeAll: () => Promise<void>;
  /** Recomputed on access — always reflects the tools discovered by connectAll. */
  readonly toolsDefs: ToolDef[];
}

export async function createMcpRegistry(
  servers: Record<string, McpServerConfig>,
): Promise<McpRegistry> {
  const clients = Object.entries(servers).map(
    ([name, config]) => new McpClient(config, name),
  );
  const tools = new Map<string, { client: McpClient; mcpTool: McpTool }>();

  const connectAll = async () => {
    const results = await Promise.allSettled(clients.map((c) => c.connect()));
    for (const [i, client] of clients.entries()) {
      const res = results[i];
      if (!res || res.status === "rejected") {
        continue;
      }
      for (const mcpTool of client.getTools()) {
        tools.set(mcpTool.name, { client, mcpTool });
      }
    }
  };

  const closeAll = async () => {
    await Promise.allSettled(clients.map((c) => c.close()));
  };

  const registry: McpRegistry = {
    clients,
    tools,
    connectAll,
    closeAll,
    get toolsDefs(): ToolDef[] {
      return [...tools.entries()].map(([name, { mcpTool }]) => ({
        type: "function",
        function: {
          name,
          description: mcpTool.description ?? `MCP tool: ${name}`,
          parameters: mcpTool.inputSchema,
        },
      }));
    },
  };

  return registry;
}

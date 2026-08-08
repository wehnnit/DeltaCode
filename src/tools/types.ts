export interface ToolContext {
  cwd: string;
  /** Paths the agent is allowed to write to (typically the project dir). */
  allowedRoots: string[];
  /** Resolve a permission request. Returns true if allowed. */
  confirm: (kind: PermissionKind, detail: string) => Promise<boolean>;
  onActivity?: (activity: Activity) => void;
  /** Max ms for a bash command (default 120s). */
  bashTimeoutMs?: number;
  /** Delegation depth of the current agent run (0 = lead). */
  depth?: number;
}

export type PermissionKind = "bash" | "write";

export interface Activity {
  kind: "tool" | "agent" | "error";
  text: string;
}

export interface ToolResult {
  /** Text returned to the model. */
  output: string;
  activity?: Activity;
}

export interface ToolCallRequest {
  id: string;
  name: string;
  args: unknown;
}

export type ToolHandler = (
  ctx: ToolContext,
  args: Record<string, unknown>,
) => Promise<ToolResult>;

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: ToolHandler;
}

export function strArg(args: Record<string, unknown>, key: string, fallback = ""): string {
  const v = args[key];
  if (typeof v === "string") return v;
  return fallback;
}

export function isWithin(path: string, root: string): boolean {
  const p = path.replace(/\/+$/, "");
  const r = root.replace(/\/+$/, "");
  return p === r || p.startsWith(r + "/");
}

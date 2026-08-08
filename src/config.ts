import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";

export interface McpServerConfig {
  url: string;
  headers?: Record<string, string>;
  /** Max ms for a single MCP tool call (default 60s). */
  timeoutMs?: number;
}

export interface PermissionConfig {
  bash: "ask" | "allow" | "deny";
}

export interface TimeoutConfig {
  /** Max ms for a single provider request (total, incl. streaming). Default 10 min. */
  requestMs: number;
  /** Abort if no stream data arrives for this long. Default 2 min. */
  idleMs: number;
  /** Max ms for a bash command. Default 2 min. */
  bashMs: number;
}

export interface DeltaConfig {
  version: 1;
  provider: string;
  model: string;
  apiKey: string;
  models: Record<string, string>;
  mcpServers: Record<string, McpServerConfig>;
  permissions: PermissionConfig;
  timeouts: TimeoutConfig;
  /** Max output tokens per provider call (default 8192). */
  maxTokens: number;
  /** User accepted the Delta Free Models statement (legal/terms disclosure). */
  acceptedFreeModels?: boolean;
  /**
   * Auto-retry count for transient provider failures (429, 5xx, timeouts,
   * stalls, network errors). 0 disables. Default 100 like opencode.
   */
  retries: number;
}

// Paths resolve at CALL time so a changed HOME (tests, `sudo -u`) is honored.
// node caches os.homedir(), so prefer process.env.HOME when set.
export function getDeltaDir(): string {
  return join(process.env.HOME ?? homedir(), ".delta");
}
export function getConfigPath(): string {
  return join(getDeltaDir(), "config.json");
}
export function getAgentsDir(): string {
  return join(getDeltaDir(), "agents");
}
export function getSkillsDir(): string {
  return join(getDeltaDir(), "skills");
}
export function getSessionsDir(): string {
  return join(getDeltaDir(), "sessions");
}

export function projectDeltaDir(cwd = process.cwd()): string {
  return join(cwd, ".delta");
}

export function defaultConfig(): DeltaConfig {
  return {
    version: 1,
    provider: "",
    model: "",
    apiKey: "",
    models: {},
    mcpServers: {
      exa: { url: "https://mcp.exa.ai/mcp" },
    },
    permissions: { bash: "ask" },
    timeouts: { requestMs: 600_000, idleMs: 180_000, bashMs: 120_000 },
    maxTokens: 8192,
    retries: 100,
  };
}

export function hasApiKey(config: DeltaConfig): boolean {
  return config.apiKey.trim().length > 0;
}

/** Delta Free Models is managed by Delta — no user API key required. */
export const FREE_PROVIDER_ID = "delta-free";

export function isConfigured(config: DeltaConfig): boolean {
  if (config.provider === FREE_PROVIDER_ID) return true;
  return hasApiKey(config) && config.provider.trim().length > 0;
}

export async function ensureDirs(): Promise<void> {
  await mkdir(getDeltaDir(), { recursive: true });
  await mkdir(getAgentsDir(), { recursive: true });
  await mkdir(getSkillsDir(), { recursive: true });
  await mkdir(getSessionsDir(), { recursive: true });
}

export async function loadConfig(): Promise<DeltaConfig> {
  await ensureDirs();
  const base = defaultConfig();
  try {
    const raw = await readFile(getConfigPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<DeltaConfig>;
    // deep-merge nested sections so a partial `timeouts`/`permissions`/`mcpServers`
    // block doesn't silently drop the other fields
    return {
      ...base,
      ...parsed,
      timeouts: { ...base.timeouts, ...(parsed.timeouts ?? {}) },
      permissions: { ...base.permissions, ...(parsed.permissions ?? {}) },
      mcpServers: { ...base.mcpServers, ...(parsed.mcpServers ?? {}) },
    };
  } catch {
    return base;
  }
}

export async function saveConfig(config: DeltaConfig): Promise<void> {
  await ensureDirs();
  await writeFile(getConfigPath(), JSON.stringify(config, null, 2), "utf8");
  await chmod(getConfigPath(), 0o600);
}

export function sessionDirFor(cwd: string): string {
  const hash = createHash("sha1")
    .update(cwd)
    .digest("hex")
    .slice(0, 12);
  return join(getSessionsDir(), hash);
}

export function projectSlug(cwd: string): string {
  const base = resolve(cwd);
  return base.split("/").filter(Boolean).pop() ?? "workspace";
}

const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "composer.json",
  "tsconfig.json",
  "deno.json",
  "bunfig.toml",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
  ".sln",
  "Makefile",
  "CMakeLists.txt",
  "Dockerfile",
  "mix.exs",
  "Gemfile",
  "pubspec.yaml",
  "workspace.json",
];

/**
 * Adaptive scope, like other coding tools:
 * - Inside a coding project → edits are scoped to that project root (walked up
 *   from cwd until a project marker is found).
 * - In a global/home terminal → the whole computer is editable (like running
 *   opencode/claude code in your home dir), with permission prompts for writes
 *   outside cwd.
 */
export function resolveAllowedRoots(cwd: string): string[] {
  const home = process.env.HOME ?? homedir();
  let dir = resolve(cwd);

  while (true) {
    const parent = dirname(dir);
    if (parent === dir || dir === "/" || dir === home) break;
    for (const marker of PROJECT_MARKERS) {
      if (existsSync(join(dir, marker))) return [dir];
    }
    dir = parent;
  }

  if (isWithinPath(resolve(cwd), home)) {
    return ["/"];
  }
  return [resolve(cwd)];
}

function isWithinPath(path: string, root: string): boolean {
  const p = path.replace(/\/+$/, "");
  const r = root.replace(/\/+$/, "");
  return p === r || p.startsWith(r + "/");
}

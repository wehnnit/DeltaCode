import { exec } from "node:child_process";
import { promisify } from "node:util";
import type { Tool, ToolContext, ToolResult } from "./types";
import { strArg } from "./types";

const execAsync = promisify(exec);

// Root-level system directories: removing these with -rf is never a legit
// coding action. /Users and /home are handled specially (whole-tree wipes are
// dangerous; the user's own home too).
const SYSTEM_DIRS = [
  "/System", "/Library", "/Applications", "/etc", "/usr", "/bin", "/sbin",
  "/var", "/opt", "/srv", "/mnt", "/boot", "/dev", "/private", "/Volumes",
];

const ALWAYS_DANGEROUS = /\b(mkfs\.|dd\s+if=|:\s*\(\s*\)\s*\{|>\s*\/dev\/sd[a-z]|chmod\s+(-R\s+)?777\s+\/)/;

const RM_FLAG = /\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*|[a-zA-Z]*f[a-zA-Z]*r[a-zA-Z]*|-r\s+-f|-f\s+-r)\b/;

/** Detect genuinely dangerous shell commands (root-wipe / disk / fork bombs). */
export function isDangerous(command: string): boolean {
  const c = command.trim();
  if (ALWAYS_DANGEROUS.test(c)) return true;

  const rm = RM_FLAG.exec(c);
  if (rm) {
    const rest = c.slice(rm.index + rm[0].length);
    // `rm -rf ~`, `rm -rf $HOME`, `rm -rf /`, `rm -rf /*`, `rm -rf /home/...`
    if (/^\s*(?:~|\$HOME|\/\*|\/home\/)/.test(rest)) return true;
    if (rest.trim() === "/") return true;
    const target = /\s(\/\S+)/.exec(rest)?.[1];
    if (!target) return false;
    if (target === "/Users" || target === "/home") return true;
    if (process.env.HOME && target === process.env.HOME) return true;
    if (SYSTEM_DIRS.some((d) => target === d || target.startsWith(d + "/"))) return true;
  }

  return false;
}

export const bashTool: Tool = {
  name: "bash",
  description:
    "Run a shell command in the project directory. Use for builds, tests, installs, git. Timeout defaults to 2 minutes (max 10 minutes). Commands are visible to the user.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "Shell command to execute" },
      timeoutMs: { type: "number", description: "Timeout in ms (default from config, max 600000)" },
    },
    required: ["command"],
  },
  handler: async (ctx: ToolContext, args): Promise<ToolResult> => {
    const command = strArg(args, "command");
    const requestedTimeout = typeof args.timeoutMs === "number" ? args.timeoutMs : (ctx.bashTimeoutMs ?? 120000);
    const timeoutMs = Math.min(requestedTimeout, 600000);

    if (isDangerous(command)) {
      return {
        output: "Blocked: command would delete or destroy system-level files. Reformulate the command.",
      };
    }

    const permission = await ctx.confirm("bash", command);
    if (!permission) {
      return { output: "Permission denied by user. Explain the command and ask how to proceed." };
    }

    ctx.onActivity?.({ kind: "tool", text: command.split("\n")[0]!.slice(0, 80) });

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: ctx.cwd,
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024 * 4,
        env: { ...process.env, PWD: ctx.cwd },
      });
      const out = (stdout + (stderr ? `\n${stderr}` : "")).trim();
      if (!out) return { output: "(command completed with no output)" };
      return { output: out.slice(0, 24000) };
    } catch (e) {
      const err = e as Error & { stdout?: string; stderr?: string; killed?: boolean };
      const reason = err.killed ? `timed out after ${timeoutMs}ms` : err.message;
      const body = [err.stdout, err.stderr].filter(Boolean).join("\n").slice(0, 8000);
      return { output: `Error: ${reason}${body ? `\n${body}` : ""}` };
    }
  },
};

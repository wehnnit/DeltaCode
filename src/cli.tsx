import { render } from "ink";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, rm, readdir } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig, isConfigured, ensureDirs, getSkillsDir } from "./config";
import { loadAgents } from "./agents/loader";
import { loadSkills } from "./skills/loader";
import { createMcpRegistry } from "./mcp/registry";
import { Harness } from "./harness/loop";
import { startSession } from "./sessions";
import { DeltaApp } from "./tui/app";
import { AnimationProvider } from "./tui/animations";
import { getPreset } from "./providers/index";
import { isGitUrl } from "./util";

const execFileAsync = promisify(execFile);

const VERSION = "0.1.0";

const HELP = `deltacode — free coding tool framework. Connect an API key, let the harness handle the rest.

Usage:
  deltacode                Launch the app (big title, then setup screen on first run)
  deltacode "<prompt>"     One-shot: run a prompt headless and print the result
  deltacode -y "<prompt>"  Headless + auto-approve bash/write permissions
  deltacode setup          Open the app straight to the setup screen
  deltacode skill list     List loaded skills
  deltacode skill add <dir-or-git-url>   Install a skill from someone else
  deltacode --version      Print version
  deltacode --help         Print this help

Scope:
  Run inside a coding project → edits stay inside that project.
  Run from your home/global terminal → the whole computer is editable
  (writes outside the current folder ask for permission first).

Headless permissions:
  Without -y, bash commands and writes outside the current folder are denied
  unless you answer the y/n prompt (TTY mode).`;

function printError(msg: string): void {
  console.error(`deltacode: ${msg}`);
}

async function headlessRun(prompt: string, autoApprove: boolean): Promise<void> {
  const config = await loadConfig();
  if (!isConfigured(config)) {
    console.error("Delta is not configured yet. Run `deltacode` in a terminal — the setup screen will guide you. You need at least one API key to code.");
    process.exit(1);
  }
  const projectDir = process.cwd();
  const mcp = await createMcpRegistry(config.mcpServers);
  await mcp.connectAll();
  const agents = await loadAgents(projectDir);
  const skills = await loadSkills(projectDir);
  const harness = new Harness({
    config,
    projectDir,
    agents,
    skills,
    mcp,
    callbacks: {
      onText: (_agent, delta) => process.stdout.write(delta),
      onToolCall: (agent, name) => console.log(`\n[tool] ${agent}: ${name}`),
      onActivity: () => {},
      onAgentStart: (agent) => console.log(`\n[agent] ${agent} starting…`),
      onAgentEnd: () => {},
      confirm: async (kind, detail, agent) => {
        if (autoApprove) return true;
        if (process.stdin.isTTY) {
          process.stdout.write(`\n[deltacode] ${agent}: allow ${kind}? ${detail.slice(0, 200)}\n[y] yes / [n] no > `);
          return await readYesNo();
        }
        console.log(`\n[denied] ${agent}: ${kind} — ${detail.slice(0, 200)}\n(headless runs deny commands unless you pass -y)`);
        return false;
      },
    },
  });
  try {
    await harness.send(prompt, []);
  } catch (e) {
    console.error(`\ndeltacode: ${(e as Error).message}`);
    process.exitCode = 1;
  } finally {
    await mcp.closeAll();
  }
}

function readYesNo(): Promise<boolean> {
  return new Promise((resolve) => {
    const { stdin } = process;
    const onData = (buf: Buffer) => {
      const ch = buf.toString().trim().toLowerCase();
      if (ch === "y" || ch === "yes") {
        cleanup();
        resolve(true);
      } else if (ch === "n" || ch === "no" || ch === "") {
        cleanup();
        resolve(false);
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
    };
    stdin.setRawMode?.(true);
    stdin.on("data", onData);
  });
}

async function skillList(): Promise<void> {
  const skills = await loadSkills(process.cwd());
  if (!skills.length) {
    console.log("No skills loaded.");
    return;
  }
  for (const s of skills) {
    const origin = s.builtin ? "built-in" : "user";
    console.log(`· ${s.name} (${origin}) — ${s.description}`);
    if (s.whenToUse) console.log(`    when: ${s.whenToUse}`);
  }
}

async function skillAdd(target: string): Promise<void> {
  await ensureDirs();
  await mkdir(getSkillsDir(), { recursive: true });
  const isUrl = isGitUrl(target);

  let source: string;
  if (isUrl) {
    console.log(`Cloning ${target} …`);
    const tmp = join(process.env.TMPDIR ?? "/tmp", `delta-skill-${Date.now()}`);
    try {
      await execFileAsync("git", ["clone", "--depth", "1", target, tmp]);
    } catch {
      console.error(`deltacode: failed to clone ${target}`);
      return;
    }
    source = tmp;
  } else {
    source = resolve(target);
    if (!existsSync(source)) {
      console.error(`deltacode: no such path: ${target}`);
      return;
    }
  }

  const candidates: string[] = [];
  const maybe = join(source, "SKILL.md");
  if (existsSync(maybe)) candidates.push(source);
  try {
    const st = statSync(source);
    if (st.isDirectory()) {
      for (const entry of await readdir(source)) {
        const sub = join(source, entry, "SKILL.md");
        if (existsSync(sub)) candidates.push(join(source, entry));
      }
    }
  } catch {
    // ignore
  }

  if (!candidates.length) {
    console.error("deltacode: no SKILL.md found at that location");
    return;
  }

  for (const c of candidates) {
    const name = basename(c);
    const dest = join(getSkillsDir(), name);
    await cp(c, dest, { recursive: true });
    console.log(`Installed skill "${name}" → ${dest}`);
  }

  if (isUrl) {
    await rm(source, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const autoApprove = args.includes("-y") || args.includes("--yes");
  const rest = args.filter((a) => a !== "-y" && a !== "--yes");

  if (rest.length === 0 || rest[0] === "tui") {
    if (!process.stdout.isTTY) {
      console.error("deltacode: no TTY detected. Use: deltacode \"<prompt>\" for headless mode.");
      process.exit(1);
    }
    await launchTui(false);
    return;
  }

  switch (rest[0]) {
    case "--version":
    case "-v":
      console.log(`deltacode ${VERSION}`);
      return;
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    case "setup":
      if (!process.stdout.isTTY) {
        console.error("deltacode: run `deltacode` in a terminal — setup happens inside the app.");
        process.exit(1);
      }
      await launchTui(true);
      return;
    case "skill":
      if (rest[1] === "list") {
        await skillList();
        return;
      }
      if (rest[1] === "add" && rest[2]) {
        await skillAdd(rest[2]);
        return;
      }
      console.log("Usage: delta skill list | delta skill add <dir-or-git-url>");
      return;
    default:
      if (rest[0]!.startsWith("-")) {
        console.log(HELP);
        process.exit(1);
      }
      await headlessRun(rest.join(" "), autoApprove);
      return;
  }
}

async function launchTui(forceSetup: boolean): Promise<void> {
  const projectDir = process.cwd();
  const config = await loadConfig();
  const mcp = await createMcpRegistry(config.mcpServers);
  await mcp.connectAll();
  const agents = await loadAgents(projectDir);
  const skills = await loadSkills(projectDir);
  const { history, file } = await startSession(projectDir);

  // take over the whole terminal: clears the "deltacode" command echo
  // (screen + scrollback) so the app starts from a clean slate, like opencode
  process.stdout.write("\x1b[2J\x1b[3J\x1b[H");

  const instance = render(
    <AnimationProvider>
      <DeltaApp
        config={config}
        projectDir={projectDir}
        agents={agents}
        skills={skills}
        mcp={mcp}
        initialHistory={history}
        sessionFile={file}
        forceSetup={forceSetup}
      />
    </AnimationProvider>,
  );
  // belt and braces: restore the terminal even on crash/ctrl-c paths
  process.once("exit", () => restoreTerminal());
  await instance.waitUntilExit();
  restoreTerminal();
}

// restore the terminal after the TUI exits: original background, clear the
// screen, cursor home — like a fresh terminal, no remnants of the session.
const RESTORE_SEQ = "\x1b]111\x07\x1b[2J\x1b[H";

function restoreTerminal(): void {
  try {
    process.stdout.write(RESTORE_SEQ);
  } catch {
    // ignore
  }
}

main().catch((e) => {
  printError((e as Error).message);
  process.exit(1);
});

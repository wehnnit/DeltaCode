import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { getAgentsDir } from "../config";
import { BUILTIN_AGENTS, type AgentDef, LEAD_AGENT_NAME } from "./types";

export async function loadAgents(projectDir: string): Promise<AgentDef[]> {
  const agents = [...BUILTIN_AGENTS];

  for (const base of [getAgentsDir(), join(projectDir, ".delta", "agents")]) {
    if (!existsSync(base)) continue;
    let entries: string[] = [];
    try {
      entries = await readdir(base);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const full = join(base, entry);
      const text = await readFile(full, "utf8");
      const agent = parseAgentFile(text);
      if (!agent) continue;
      const idx = agents.findIndex((a) => a.name === agent.name);
      if (idx >= 0) agents[idx] = agent;
      else agents.push(agent);
    }
  }

  return agents;
}

export function parseAgentFile(text: string): AgentDef | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  const fm = m[1]!;
  const body = (m[2] ?? "").trim();
  const get = (key: string): string => {
    const re = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, "m");
    const hit = re.exec(fm);
    return hit ? hit[1]!.trim().replace(/^["']|["']$/g, "") : "";
  };
  const getList = (key: string): string[] =>
    get(key)
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);

  const name = get("name");
  if (!name) return null;

  return {
    name,
    description: get("description"),
    model: get("model") || undefined,
    tools: getList("tools"),
    skills: getList("skills"),
    instructions: body,
    canDelegate: get("canDelegate") === "true",
    builtin: false,
  };
}

export function agentByName(agents: AgentDef[], name: string): AgentDef | undefined {
  return agents.find((a) => a.name === name);
}

export function leadAgent(agents: AgentDef[]): AgentDef {
  return agentByName(agents, LEAD_AGENT_NAME) ?? BUILTIN_AGENTS[0]!;
}

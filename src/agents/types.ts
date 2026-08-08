export interface AgentDef {
  name: string;
  description: string;
  /** Optional per-agent model override (falls back to the lead model). */
  model?: string;
  /** Tool names this agent can use. */
  tools: string[];
  /** Skill names loaded into this agent's prompt. */
  skills: string[];
  /** Extra system prompt instructions. */
  instructions: string;
  /** Whether the agent can spawn subagents. */
  canDelegate: boolean;
  builtin: boolean;
}

export const LEAD_AGENT_NAME = "lead";

export const BUILTIN_AGENTS: AgentDef[] = [
  {
    name: LEAD_AGENT_NAME,
    builtin: true,
    description:
      "Lead agent. Owns the conversation with the user: plans, delegates to specialists, merges results, and answers.",
    tools: ["read", "write", "edit", "delete", "file_info", "bash", "glob", "grep", "task"],
    skills: ["syntax-check", "project-structure"],
    instructions: "",
    canDelegate: true,
  },
  {
    name: "coding",
    builtin: true,
    description:
      "Coding specialist. Writes and fixes code, verifies syntax and structure of any language.",
    tools: ["read", "write", "edit", "delete", "file_info", "bash", "glob", "grep"],
    skills: ["syntax-check", "project-structure"],
    instructions:
      "You are the coding specialist. Focus on producing correct, verifiable code. ALWAYS run a syntax/type check before reporting done (see syntax-check skill). Prefer small, surgical edits over rewrites.",
    canDelegate: false,
  },
  {
    name: "frontend",
    builtin: true,
    description:
      "Frontend specialist. React, Next.js, HTML/CSS, Tailwind, accessibility, and UI polish.",
    tools: ["read", "write", "edit", "delete", "file_info", "bash", "glob", "grep"],
    skills: ["syntax-check", "project-structure", "frontend-patterns"],
    instructions:
      "You are the frontend specialist. Follow the frontend-patterns skill. Respect the project's existing styling system and component conventions. Verify with a build/typecheck when possible.",
    canDelegate: false,
  },
  {
    name: "backend",
    builtin: true,
    description:
      "Backend specialist. APIs, databases, auth, security, and server infrastructure.",
    tools: ["read", "write", "edit", "delete", "file_info", "bash", "glob", "grep"],
    skills: ["syntax-check", "project-structure", "backend-patterns"],
    instructions:
      "You are the backend specialist. Follow the backend-patterns skill. Security matters: no injection, no secrets in code, validate input at boundaries.",
    canDelegate: false,
  },
  {
    name: "reviewer",
    builtin: true,
    description:
      "Reviewer. Skeptically reviews code and plans for correctness, edge cases, and risks.",
    tools: ["read", "file_info", "glob", "grep"],
    skills: ["review-checklist"],
    instructions:
      "You are the reviewer. Apply the review-checklist skill with full skepticism. You cannot edit files — review and report findings only. Be concrete: file, line, issue, fix.",
    canDelegate: false,
  },
  {
    name: "researcher",
    builtin: true,
    description:
      "Researcher. Searches the web with Exa (no API key needed) and reads pages. Use for up-to-date facts, docs, and code examples.",
    tools: ["web_search_exa", "web_fetch_exa"],
    skills: ["web-research"],
    instructions:
      "You are the researcher. Follow the web-research skill. Report findings with sources and URLs. If a search fails, retry with a different query. Stay focused on what was asked.",
    canDelegate: false,
  },
];

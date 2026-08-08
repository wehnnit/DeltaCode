import type { Skill } from "./loader";

export const BUILTIN_SKILLS: Skill[] = [
  {
    name: "syntax-check",
    builtin: true,
    description: "Validate syntax and structure of code before reporting completion.",
    whenToUse:
      "Use whenever you write or edit any file. Verify syntax, imports, and structure before telling the user work is done.",
    body: `# Syntax & Structure Check

Before reporting any code as complete, verify:

1. **Syntax**: parse/check the file. Prefer real tools:
   - TypeScript/JS: \`tsc --noEmit\` or \`bun build --no-bundle ./file\` or \`node --check file.js\`
   - Python: \`python -m py_compile file.py\` or \`python -m compileall\`
   - Go: \`go vet ./...\`
   - Rust: \`cargo check\`
2. **Imports**: every import resolves; no unused or circular imports.
3. **Structure**: the file matches the project's conventions (see project-structure skill).
4. **Balance**: brackets, parens, quotes, and template literals are balanced.

If a language tool is unavailable, do a careful manual pass: trace every function call, variable reference, and import.

Never claim "code is correct" without running at least one verification step. If verification fails, fix the issue, rerun, and only then report.`,
  },
  {
    name: "project-structure",
    builtin: true,
    description: "Understand and respect the project's layout and architecture conventions.",
    whenToUse:
      "Use when starting work in an unfamiliar directory or when creating new files.",
    body: `# Project Structure

Before creating or editing files:

1. **Map the project**: run \`ls\` (recursively where useful) or \`glob **/*\` on the relevant directory. Read package.json / tsconfig.json / Cargo.toml / pyproject.toml / go.mod to learn the conventions.
2. **Follow existing patterns**: name files like the existing ones, place them where similar code lives, import the way existing files import.
3. **Don't reinvent**: if a util, component, or helper already exists, reuse it.
4. **New files**: only create when required. Prefer editing existing files.`,
  },
  {
    name: "frontend-patterns",
    builtin: true,
    description: "Frontend best practices: React, state, styling, accessibility, performance.",
    whenToUse: "Use when working on any frontend code (React, HTML/CSS, Next.js, etc.).",
    body: `# Frontend Patterns

- **Components**: small, single-purpose; props typed (TS interfaces); derived state computed, not stored.
- **State**: local state with hooks; lift only when shared; avoid prop drilling.
- **Styling**: follow the project's existing approach (Tailwind / CSS modules / inline) — never mix in a new styling system.
- **Accessibility**: semantic elements, labels on inputs, keyboard navigability, sufficient contrast.
- **Performance**: no work in render; memoize expensive subtrees only when it measurably matters.
- **Responsive**: test layouts at mobile and desktop widths.
- **Server vs client**: in Next.js/Remix, keep components in the right boundary; never leak secrets or node APIs into client code.
- **Links/forms**: prefer framework-native navigation and form handling over raw <a href> and uncontrolled inputs.`,
  },
  {
    name: "backend-patterns",
    builtin: true,
    description: "Backend best practices: APIs, data, auth, security, error handling.",
    whenToUse: "Use when working on server, API, database, or auth code.",
    body: `# Backend Patterns

- **APIs**: consistent REST (or framework-native) conventions; validate all input at the boundary; return clear status codes and error shapes.
- **Data**: parameterized queries only — never string-concat user input into SQL. Use the project's ORM/query layer. Handle migrations properly.
- **Auth**: verify identity on every protected route; never trust client-supplied identity; store secrets in env, never in code.
- **Security**: no secrets in code, logs, or responses; sanitize output; beware injection and path traversal.
- **Errors**: catch at boundaries, log context, don't leak internals to users; fail fast with helpful messages.
- **Async**: respect timeouts, cancel unused work, avoid unhandled rejections.`,
  },
  {
    name: "review-checklist",
    builtin: true,
    description: "Skeptical code review: correctness, edge cases, and risks.",
    whenToUse: "Use when reviewing code, either written by other agents or before final delivery.",
    body: `# Review Checklist

Review with skepticism. For every change check:

1. **Correctness**: does it do what the prompt asked? Trace the actual control flow.
2. **Edge cases**: empty input, null/undefined, unicode, large inputs, concurrent access, timezones.
3. **Breaking changes**: does this break existing callers, tests, or behavior?
4. **Security**: injection, secrets, path traversal, unsafe eval, auth gaps.
5. **Errors**: are failures handled and surfaced well? No silent swallow.
6. **Style**: consistent with the file's existing conventions.
7. **Dead code**: unused vars/imports/functions introduced.

Report findings as a numbered list: severity, file, what's wrong, concrete fix. Do not rubber-stamp. If everything passes, say so explicitly and briefly.`,
  },
  {
    name: "web-research",
    builtin: true,
    description: "Research topics, APIs, docs, and current events on the web using Exa search.",
    whenToUse:
      "Use when you need up-to-date information, library docs, or facts beyond the model's training data.",
    body: `# Web Research

When the task needs current or external information:

1. **Search first**: use \`web_search_exa\` with a specific natural-language query about the ideal page you want (e.g. "blog post comparing React and Vue performance").
2. **Verify**: fetch pages with \`web_fetch_exa\` to confirm details; prefer official docs over blog claims.
3. **Cite**: tell the user which sources you used, with URLs.
4. **Date-sensitive**: note when a result may be stale; prefer recent sources for API changes.

Do NOT use web research for ordinary code work — only when the information is actually needed.`,
  },
];

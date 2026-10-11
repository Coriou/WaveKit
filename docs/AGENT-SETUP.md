# Agent setup

How coding agents get this repository's instructions, task context and shared memory. The
rules themselves live only in [`AGENTS.md`](../AGENTS.md).

## Instruction loading

`AGENTS.md` at the repository root is the single instruction file; there is no `CLAUDE.md`.
Nested `AGENTS.md` files add scoped context for their directory (e.g.
`packages/brand/AGENTS.md`), and specs are read per task (see
[`docs/specs/README.md`](specs/README.md)), so a session only loads what its task needs.

Tested on 2026-10-10 by asking each harness, with tools disabled, to quote a sentinel line
that existed only in `AGENTS.md`:

| Harness                                                             | Version tested | Result            |
| ------------------------------------------------------------------- | -------------- | ----------------- |
| Codex CLI (`codex exec`), and Codex sessions under Tx Code          | 0.162.1        | Loads `AGENTS.md` |
| Claude Code CLI (`claude -p`), and Agent SDK sessions under Tx Code | 2.1.296        | Loads `AGENTS.md` |
| Grok CLI (`grok -p`)                                                | 1.0.50         | Loads `AGENTS.md` |
| omp (`omp -p`)                                                      | 18.8.9         | Loads `AGENTS.md` |

Not tested: VS Code chat/Copilot, Kiro, Cursor, OpenCode and anything else. If you use one,
confirm it loads `AGENTS.md` the same way and add a row here.

Known conditions:

- **Claude Code** reads `AGENTS.md` only from v2.1.277, with its built-in AGENTS.md plugin
  enabled, and only when no `CLAUDE.md`, `.claude/CLAUDE.md` or `CLAUDE.local.md` exists in
  the working directory or above it
  ([docs](https://code.claude.com/docs/en/memory#agents-md)). A personal `CLAUDE.local.md`
  or a `CLAUDE.md` in a parent directory therefore hides `AGENTS.md`. Keep personal notes in
  `~/.claude/CLAUDE.md` instead, or start the local file with an `@AGENTS.md` import, or set
  **Project instructions** to `claude-md-and-agents-md` in `/config`. The first session
  after upgrading from v2.1.276 or earlier may still miss it.
- **Grok CLI** truncates each rules file at 10,000 characters and skips git-ignored ones;
  the drift test keeps `AGENTS.md` under that limit.
- **Running sessions** keep the instructions they loaded at startup, including subagents
  that inherit them. Restart a session to pick up an instruction change.

## Shared memory

Agents may keep a local, private memory shared by every worktree of this repository. It is
never part of the repository: `.agents/` is git-ignored and excluded from Docker build
contexts. In each worktree, `.agents/memory` is a symlink to that directory, created by:

```bash
node scripts/agents-setup.mjs          # create the link if missing (idempotent)
node scripts/agents-setup.mjs --check  # exit 1 if missing, broken or not private
```

The script links the first directory that exists among:

1. `$WAVEKIT_AGENT_MEMORY_DIR`;
2. the main checkout's `.agents/memory`, when run from a linked worktree;
3. Claude Code's auto-memory directory for the main checkout, which Claude Code already
   loads by itself.

It never replaces an existing link. It refuses to link when `.agents/` is not ignored, or
when the memory directory could be committed to a git repository. With no memory
configured it does nothing.

## Drift checks

`tests/unit/repo/agent-instructions.test.ts` runs with `pnpm test` (and CI). It checks that:

- every `pnpm run`, `make` and `node scripts/...` command in `AGENTS.md` exists;
- repository paths named in the instruction docs exist, and relative links in all tracked
  Markdown resolve;
- the documented compiler flags, lint rules and formatting match `tsconfig.base.json`,
  `eslint.config.js` and `.prettierrc`;
- each spec directory has its three files;
- no competing instruction file is tracked;
- `.agents/` is ignored and untracked, and Docker excludes `.agents` and `.claude`.

`tests/unit/repo/agents-setup.test.ts` exercises the setup script in throwaway repositories
and worktrees. Run both with `pnpm exec vitest run tests/unit/repo`.

# AGENTS.md

Entry point for coding agents that do not read `CLAUDE.md` (Codex and others). It is
a bridge, not a second copy: the conventions live in one place (ROADMAP §10 tracks the
consolidation into a single cross-harness setup).

## Read before acting

1. **`CLAUDE.md`, in full.** It is the project's canonical instruction file for every
   agent, not only Claude Code: layout, commands, architecture, the enforced code
   conventions, testing rules and the Kiro spec workflow. Everything in it binds you.
2. **`.agents/memory/MEMORY.md`, if it exists.** A local-only link to the team's shared
   memory (one fact per file; follow the links you need). It holds standing rules from
   the user that are not in the code, e.g. how to commit in the shared checkout, disk
   and Docker hygiene, and what never to do to the Raspberry Pi receiver. Treat a
   memory as background that was true when written; verify a file, flag or function it
   names before relying on it. Never copy memory content into tracked files: this
   repository is public.
3. **Your brief.** An orchestrator session usually dispatches you with a task brief.
   Its explicit constraints override defaults here.

## Shared-checkout rules (several agents work in this repo at once)

- Stage and commit only your own paths: `git commit -m "…" -- <path> [<path>…]`.
  Never `git add -A`, never commit unrelated changes, never `git stash` without a
  unique tag. Do not push unless your brief says so.
- Prefer your own `git worktree` for multi-file work; never build Docker images from
  the shared checkout.
- Never run Prettier on `docs/CLI-COORDINATION.md` (append-only, hand-formatted).
- Do not deploy to, retune or reboot the Raspberry Pi receiver, and do not stop the
  running `wavekit-app` container, unless your brief says so.
- Before reporting done: run the checks your brief names (at least the touched test
  files, `pnpm run typecheck`, `pnpm run lint`); report failures with their output.

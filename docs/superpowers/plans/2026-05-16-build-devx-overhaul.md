# Build & DX Overhaul Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan phase-by-phase. Each phase below dispatches one fresh subagent that executes the Kiro task list in `.kiro/specs/build-devx-overhaul/tasks.md` for that phase, then returns for review at the verification gate. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the 737-line single Dockerfile, four parallel compose files, divergent Makefile dev flows, and Docker-free CI with: one narrow-staged Dockerfile, one profile-driven compose file, GHCR-backed BuildKit registry cache, a native `pnpm dev` headline loop, and CI that builds at least `final-core` on every PR.

**Architecture:** Sequential phase execution (A→B→C→D→E→F→G→H→I) with verification gates between each phase. Each phase produces a clean image build; downstream phases depend on the previous phase's image-builds-clean property. Phases are independent enough to dispatch as separate subagents (clean context per phase) but must run sequentially because each phase consumes the structural output of the previous one.

**Tech Stack:** Docker BuildKit + buildx + bake (HCL), Compose v2 profiles, s6-overlay v3, GHCR registry cache, GitHub Actions, Node 22 + pnpm 10.28.0 via Corepack, esbuild + node --watch.

---

## Authoritative spec

The Kiro spec at `/Users/ben/Projects/wavekit/.kiro/specs/build-devx-overhaul/` is the canonical source of truth:

- `requirements.md` — 11 user stories, 51 acceptance criteria, Out-of-Scope list
- `design.md` — current-state diagnosis (14 anti-patterns), 20-stage Dockerfile structure, compose topology, cache strategy, s6 contract change, 12 correctness properties, risk register
- `tasks.md` — 60 dependency-sequenced tasks across 9 phases with `_Requirements: X.Y_` traceability, plus 15 Non-negotiables

This plan does NOT duplicate the task list. Each phase below references the corresponding `tasks.md` section and adds: commit/PR boundary guidance, verification gates the subagent MUST hit before returning, and risk flags specific to that phase.

## Execution mode

**Recommended: inline subagent-driven (sequential, one subagent per phase, review checkpoints between phases).**

Rationale: The 9 phases are structurally independent (each touches a distinct slice — file-tree moves, Dockerfile, compose, build scripts, Makefile, CI, sdr-host, docs, dockerignore) so they benefit from clean per-phase contexts. BUT they have a hard sequential dependency: each phase needs the previous phase's "image builds clean" invariant to verify itself. Parallel dispatch would waste tokens running the Dockerfile work twice (once in Phase B's subagent, once again in Phase C's when it discovers it needs a working image to test compose against). Sequential subagent-driven keeps each phase's context narrow while preserving the dependency chain.

The user-facing review checkpoints align with the two natural integration boundaries already called out in `tasks.md`:

- **Checkpoint 1** (after Phase B): Dockerfile refactor complete; old compose files still work because stage names are unchanged. PR boundary 1.
- **Checkpoint 2** (after Phase F): New build system fully functional; CI is green. PR boundary 2.

Phases G/H/I are polish and can land as a single small PR after Checkpoint 2.

## Commit & PR boundary structure

Three PRs total. Inside each PR, one commit per phase is the floor; phase B's Dockerfile work may warrant 2–4 commits at the subagent's discretion (one per logical chunk: ARG block + base-build, runtime-base, all `*-build` stages, final-base + finals).

### PR 1: "build: s6 tree partition + Dockerfile refactor" (Phases A + B)

- Commits: `refactor(s6): partition sdrpp-server into separate overlay tree` (Phase A), then 2–4 commits scoped per the B.2.x subgroups.
- Verification gate before PR open: Non-negotiables 7, 8, 9 (final-core/final residue checks) pass against locally-built images. The old compose files still build (stage names unchanged); this is the safety net for the refactor.
- Why this boundary: After Phase B the image-build domain is fully migrated, but the dev/CI surface area is untouched. Reviewers can validate the Dockerfile contract isolation without juggling compose/Makefile/CI changes simultaneously.

### PR 2: "build: collapse compose, adopt bake, rewrite Makefile + CI" (Phases C + D + E + F)

- Commits: one per phase minimum (`refactor(compose): collapse 4 files into single profile-driven compose.yaml`, `build(bake): introduce GHCR-backed buildx bake pipeline`, `chore(make): trim Makefile to <20 lifecycle targets`, `ci: add docker-build job; bump Node to 22`).
- Verification gate before PR open: Non-negotiables 1–6, 10–13 all pass. The draft-PR smoke test in F.7 is REQUIRED — opening the PR before CI is green wastes reviewer cycles.
- Why this boundary: PR 2 is where the contributor-visible workflow changes (one compose file, new Makefile targets, CI now builds Docker). It needs to land atomically — partial adoption (e.g., new Makefile but old compose) creates a transitional broken state.

### PR 3: "build: sdr-host Corepack alignment + docs + dockerignore audit" (Phases G + H + I)

- Commits: one per phase (`chore(sdr-host): switch pnpm install to Corepack pattern`, `docs: consolidate Docker documentation around compose profiles`, `chore: audit .dockerignore effectiveness`).
- Verification gate before PR open: Non-negotiables 14, 15 pass. The `pnpm dev` headline and `make dev-stack` integration paths in updated docs SHOULD be smoke-tested by the subagent before the PR opens.
- Why this boundary: Pure polish; not blocking the build system itself. Keeping it separate means reviewers can rubber-stamp it.

> **Note on Phase A commit hygiene:** Phase A is a pure file-tree reorganization (`git mv` semantics — though the tasks describe it as create + delete, the subagent should use `git mv` where possible to preserve history). The verification step A.6 is the only "test" available before the Dockerfile consumes the new layout in Phase B.

## Verification gates between phases

Each gate below MUST be cleared before the next phase's subagent is dispatched. If a gate fails, the subagent owning that phase is re-dispatched with the failure context; no skipping.

### Gate A→B: s6 tree partition is structurally correct

Subagent owning Phase A MUST report verification of:

- `find docker/overlay/s6-overlay -iname '*sdrpp*'` returns empty.
- `find docker/overlay/s6-overlay-sdrpp -type f` lists exactly the 6 files in task A.6.
- `cat docker/overlay/s6-overlay/s6-rc.d/wavekit-api/dependencies.d/wavekit-init` exists and is the only file in that directory.

Reviewer checks: file moves preserve git history (look for `R` lines in `git diff --stat`).

### Gate B→C: Dockerfile contract holds for all 4 final stages

Subagent owning Phase B MUST report verification of `tasks.md` task B.2.11 (all 4 targets build via `docker buildx build --target <t> --load`) AND B.2.12 (Properties 8 & 9 against `wavekit:dev-core` and a sdrpp service exists in `wavekit:dev`). Additionally:

- The `--progress=plain` output of a touched-src rebuild SHALL show every `*-build` stage as `CACHED` (manual verification of Property 3).
- `grep -E '^\s*ARG (S6_OVERLAY_VERSION|.*_REF)=' Dockerfile | wc -l` returns ≥ 14 (one S6 + ≥13 decoder refs).

Reviewer checks: each `*-build` stage uses `FROM base-build`, declares its own apt deps (not `base-build`'s), uses pinned ref via `git fetch --depth 1 origin "${REF}" && git checkout --detach FETCH_HEAD`.

### Gate C→D: compose collapse loads each profile cleanly

Subagent owning Phase C MUST report:

- All 4 `docker compose --profile <p> config` runs return zero warnings (tasks C.3–C.6).
- The 4 old compose files and `docker/Dockerfile.demod-test` are deleted from working tree.
- End-to-end task C.12 succeeded (`dev` profile up + 200 on `/health`).

Reviewer checks: `packages/sdr-host/docker-compose.yml` is unchanged (Non-negotiable 14).

### Gate D→E: bake pipeline supersedes plain `docker build`

Subagent owning Phase D MUST report:

- `grep -rn '\bdocker build\b' docker/ Makefile compose.yaml | grep -v buildx` returns no matches (Property 11 / Non-negotiable 5).
- D.2 and D.3 both passed (single-arch and multi-arch local bake).
- `docker/init.sh` has the `.docker-cache` mkdir removed; `docker/push.sh` is GHCR-only with `WAVEKIT_GH_OWNER` env support and no `linux/arm/v7`.
- D.8 cache seed completed (this is the critical bootstrap — without it, downstream `cache-from` calls return "no cache").

Reviewer checks: `docker/bake.hcl` defines exactly the targets and groups in design §4.3 (`final`, `final-core`, `final-sdrpp`, `final-demod`, `ci-core` helper, `default` and `demod` groups).

### Gate E→F: Makefile targets match the canonical list exactly

Subagent owning Phase E MUST report:

- `make help` output enumerates only the canonical targets listed in requirement 6.1 plus `fixtures-*` and `sdr-host-*`. The deletion list in requirement 6.2 is verified absent.
- E.4 end-to-end test passed for `make dev`, `make dev-stack`, `make dev-dashboard`, `make docker-build`, `make demod-test`.
- No emoji or decorative ANSI in newly-introduced output (Non-negotiable 11).

Reviewer checks: `make dev-stack` runs `docker compose --profile dev up --build` literally; `make docker-build` runs `docker buildx bake --file docker/bake.hcl default` literally.

### Gate F→G: CI is green on a no-op PR

Subagent owning Phase F MUST execute task F.7 (open a draft PR with a trivial change, e.g., a whitespace edit to `readme.md`, and verify both jobs complete green). This is mandatory because the bake action's pull-cache-from-GHCR path can only be validated against the live GHCR cache seeded in D.8. If F.7 fails:

- Diagnose: cache-from returning auth error vs no-cache (latter is correct fallback per requirement 4.3, former is a CI config bug).
- Fix the CI yaml; re-push.
- Do NOT proceed to Phase G with a failing CI workflow.

Reviewer checks: the two CI jobs run on `pull_request`; the GHCR login + push only runs on `push` to main (gated by `github.event_name` and `github.ref`).

### Gate G→H: sdr-host build still passes

Subagent owning Phase G MUST report G.2 success (sdr-host build via the existing `build-publish.sh` script with `--load`).

Reviewer checks: pnpm version pinned in `packages/sdr-host/Dockerfile` matches `packageManager` field in root `package.json` exactly (requirement 9.2).

### Gate H→I: docs cross-references are intact

Subagent owning Phase H MUST report:

- `docs/DOCKER-SETUP.md` references the canonical compose file, profiles, Makefile targets, and `pnpm dev` headline.
- `docker/README.md` is either deleted or reduced to a one-line pointer.
- `CLAUDE.md`'s "Day-to-day dev (Docker)" section is one paragraph.

Reviewer checks: `grep -rn 'docker-compose.dev' docs/ CLAUDE.md` returns no matches (no stale references to deleted files).

### Final gate (post-Phase I): all 15 Non-negotiables pass

Before PR 3 opens, the subagent MUST run through the 15 Non-negotiables in `tasks.md` and report pass/fail for each. Failures block the PR.

## Risks the implementer should watch for

Mapped to design §11 risk register, with execution-time mitigations.

### R1: SHA capture in B.1.1 picks a broken upstream commit

The Kiro plan assumes `git ls-remote` HEAD of each decoder repo is buildable. This is true today (the project currently builds against branch tips). But there's a non-zero chance one of the 12 repos has an in-flight breakage at the moment B.1.1 runs.

**Mitigation:** After B.2.11 (smoke-test build), if any stage fails to compile, do NOT debug the upstream code. Instead, walk that decoder's git log back to the most recent green tag (or a SHA 24h older) and use that. Record the choice in the commit message: `pin <decoder> to <sha> (HEAD broken: <error summary>)`.

### R2: arm64 ncurses path during B.2.6

Task B.2.6 says: remove the hardcoded `x86_64-linux-gnu/libncurses*` COPY from `final-core`; test arm64; if missing, add `TARGETARCH`-conditional COPY. The subagent MUST run `docker buildx build --target final-core --platform linux/arm64 --load` after the removal. If `dsd-fme --help` or `find / -name "libncurses*"` shows ncurses is satisfied by the `libncurses6` apt install in `runtime-base`, leave the COPY deleted (requirement 3.13's preferred path). Otherwise restore as `TARGETARCH`-conditional with `amd64→x86_64-linux-gnu`, `arm64→aarch64-linux-gnu`.

### R3: `node-linker=isolated` runtime breakage

Removing the `pnpm config set node-linker hoisted` block (B.2.5) flips the container's effective layout from hoisted to isolated. The `.npmrc` says isolated is already the project default, so this should be a no-op — but the container has been running with the hoisted override for long enough that a transitive dependency might have grown an implicit assumption.

**Mitigation:** After B.2.11, run `docker run --rm wavekit:dev-core node -e "require('fastify'); require('pino'); require('zod'); require('@wavekit/shared'); require('@wavekit/api-types'); console.log('OK')"`. If any require fails, the symbol is `MODULE_NOT_FOUND` for a workspace package, which signals the dist's import path expectations were specific to the hoisted layout. Fall back to the documented escape hatch: re-add the linker reconfigure in `node-build` as a single change (NOT a double install — set the linker BEFORE the single install). Document the regression in a follow-up issue rather than rolling back the whole refactor.

### R4: GHCR cache write race during D.8 bootstrap

The D.8 step does a one-time `--push --cache-to mode=max` from a local machine to seed each `cache-<stage>` ref. If two people run D.8 concurrently (unlikely but possible), the cache-to writes can stomp each other. The result is half-populated cache refs, which manifest as Property 5 failure on cold builds.

**Mitigation:** Coordinate the bootstrap. Only one machine runs D.8. After it returns, verify with `docker buildx imagetools inspect ghcr.io/coriou/wavekit:cache-readsb-build` (or any one cache ref) shows two platform manifests (amd64 + arm64). If only one arch appears, re-run D.8 with `--set "*.platform=linux/amd64,linux/arm64"` explicitly.

### R5: F.7 draft-PR test on a fresh fork without GHCR access

If the PR is opened from a fork (not a branch in the upstream repo), the `docker-build` job runs without `secrets.GITHUB_TOKEN` access to GHCR. The cache-from will return "no cache" rather than error (requirement 4.3 contract), so the build still succeeds — but it will be a 25-40 minute cold build, not a 2-5 minute warm one. This is correct behaviour, not a regression. The subagent owning Phase F MUST validate from a branch in the upstream repo (not a fork) so the cache hit confirms the happy path.

### R6: Compose `cache_from` typed-cache parsing

Compose v2 supports `cache_from: type=registry,ref=...` only in recent versions. The subagent MUST verify locally with `docker compose version` before C.3 — Docker Desktop 4.30+ / docker-compose CLI v2.27+ supports the typed syntax. Older versions silently ignore the cache directive, which manifests as warm-build behaviour being slower than expected (not a build failure, just a missed optimization).

### R7: s6 contract change creates first-run log noise

The s6 hard dep `wavekit-api → sdrpp-server` removal is intentional (design §5). When `final` mode boots, `wavekit-api` may briefly try to connect before `sdrpp-server` binds its port, producing one or two `SourceConnectionError` log lines before `SourceManager`'s exponential backoff retries succeed. This is acceptable per design but will look like a regression in first-launch logs.

**Mitigation:** No code change. Document in the PR description and the `docs/DOCKER-SETUP.md` rewrite (Phase H.1) that early-boot reconnect lines are expected and the source-availability contract has moved from s6 to `SourceManager`. If grafana/log dashboards alert on `SourceConnectionError`, update their thresholds to ignore the first 10 seconds post-boot.

### R8: Renamed Makefile targets break ambient muscle memory

The Phase E rewrite renames `dev-up` → `dev-stack`, `docker-logs` → `dev-stack-logs`, `docker-shell` → `dev-shell`. Contributors with these in shell history or in personal aliases will hit "target not found" errors after pulling.

**Mitigation:** Phase H.3 (`CLAUDE.md` condense) is the only contributor-facing documentation update; ensure the rewritten paragraph explicitly names the new targets. Optionally, ONE Makefile entry can carry a deprecation hint:

```make
dev-up:
	@echo "[wavekit] make dev-up is now 'make dev-stack'" >&2; exit 1
```

This is OPTIONAL — requirement 6.2 says these targets SHALL NOT exist, but a hint that errors out cleanly is arguably "informative null behaviour" rather than a re-introduction. If the subagent adds it, mark it for removal in 30 days. Lean toward NOT adding it — requirement 6.2's wording is "SHALL NOT define", and the cleaner path is just to delete and let muscle memory adjust.

### R9: Property 5 (cold-cache GHCR pull) cannot be verified locally without prune

Property 5 demands a `docker system prune -af && make docker-build` test that pulls cache from GHCR. The subagent owning Phase D MUST NOT run this during routine D.x verification because pruning kills the local layer cache that subsequent tasks rely on. Run it ONCE at the end of Phase F (after CI has successfully written to GHCR via the main-branch push or the D.8 bootstrap), then proceed.

### R10: `final-demod` matplotlib/scipy install bloat

Task B.2.10 apt-installs `python3-matplotlib`, `python3-scipy`. These pull in ~400MB of Debian deps. This is intentional (the demod test environment is interactive and benefits from these), but it WILL make `final-demod` the largest stage. If image size becomes a complaint, requirement 10's "modest, opportunistic" framing covers trimming this in a follow-up — DO NOT trim during this refactor (out-of-scope per requirement 10.5).

## Tasks: defer to `.kiro/specs/build-devx-overhaul/tasks.md`

The 60-task implementation checklist lives in the Kiro spec. The subagent dispatched for each phase below MUST open `tasks.md`, execute that phase's tasks in order, check off each with `- [x]`, and report the verification gate's pass/fail to the dispatching session.

### Phase A: s6 Service Tree Partition (tasks A.1–A.6, 6 tasks)

- Files: `docker/overlay/s6-overlay/` (deletions), `docker/overlay/s6-overlay-sdrpp/` (creations).
- Gate: Gate A→B above.
- Commit: single commit `refactor(s6): partition sdrpp-server into separate overlay tree`.

### Phase B: Dockerfile Refactor (tasks B.1.1–B.2.12, 14 tasks)

- Files: `Dockerfile` (top-to-bottom rewrite).
- Gate: Gate B→C above.
- Commits: 2–4 logical commits per the B.2.x subgroups.
- Risk flags: R1, R2, R3.

### Phase C: Compose Collapse (tasks C.1–C.12, 12 tasks)

- Files: `compose.yaml` (new), 4 old compose files + `docker/Dockerfile.demod-test` (deletions).
- Gate: Gate C→D above.
- Commit: single commit `refactor(compose): collapse 4 files into single profile-driven compose.yaml`.
- Risk flags: R6.

### Phase D: Bake + Registry Cache (tasks D.1–D.8, 8 tasks)

- Files: `docker/bake.hcl` (new), `docker/build.sh` (rewrite or delete), `docker/push.sh` (rewrite), `docker/init.sh` (edit), `docker/platform-utils.sh` (likely delete).
- Gate: Gate D→E above.
- Commit: single commit `build(bake): introduce GHCR-backed buildx bake pipeline`.
- Risk flags: R4.

### Phase E: Makefile Cleanup (tasks E.1–E.4, 4 tasks)

- Files: `Makefile` (rewrite).
- Gate: Gate E→F above.
- Commit: single commit `chore(make): trim Makefile to <20 lifecycle targets`.
- Risk flags: R8.

### Phase F: CI Workflow (tasks F.1–F.7, 7 tasks)

- Files: `.github/workflows/ci.yml` (rewrite).
- Gate: Gate F→G above.
- Commit: single commit `ci: add docker-build job; bump Node to 22; corepack-driven pnpm`.
- Risk flags: R5, R9.

### Phase G: sdr-host Alignment (tasks G.1–G.2, 2 tasks)

- Files: `packages/sdr-host/Dockerfile` (one-line edit).
- Gate: Gate G→H above.
- Commit: single commit `chore(sdr-host): switch pnpm install to Corepack pattern`.

### Phase H: Documentation Consolidation (tasks H.1–H.3, 3 tasks)

- Files: `docs/DOCKER-SETUP.md` (rewrite), `docker/README.md` (delete or one-line), `CLAUDE.md` (condense).
- Gate: Gate H→I above.
- Commit: single commit `docs: consolidate Docker documentation around compose profiles`.
- Risk flags: R7 (mentioned in DOCKER-SETUP.md).

### Phase I: Dockerignore Audit (tasks I.1–I.4, 4 tasks)

- Files: `.dockerignore` (verify only; no functional change expected).
- Gate: Final gate (15 Non-negotiables) above.
- Commit: single commit `chore: audit .dockerignore effectiveness` (may be empty-diff if everything already correct; if so, fold into the Phase H commit and skip a standalone commit).

## Correctness properties to verify

The design's 12 correctness properties (design.md §10) map to the Non-negotiables (tasks.md). The subagent owning each phase MUST verify the properties that phase introduces:

- Phase A introduces no properties (pure file moves; Property 8/9 verified in Phase B).
- Phase B introduces Properties 1, 2, 3, 8, 9.
- Phase C introduces Property 12.
- Phase D introduces Properties 4, 5, 6, 11.
- Phase E introduces no new properties (verified via subset of 1–6).
- Phase F introduces Property 10 (multi-arch in registry, only verifiable after main-branch CI push).
- Phases G/H/I introduce no new properties.
- Property 7 (`pnpm dev` without Docker) is verified once after Phase E (when the Makefile target lands) and again at the final gate.

## Self-review checklist for the implementing subagents

Each phase subagent MUST run this checklist before returning to the dispatching session:

1. **Spec coverage:** Every requirement number cited in this phase's `tasks.md` entries has a check-marked task. Any uncheck-marked tasks are explicitly flagged in the return message as "intentionally deferred" with reason.
2. **No placeholder regressions:** `grep -rn 'TODO\|FIXME\|XXX\|TBD' Dockerfile docker/ compose.yaml Makefile .github/workflows/ci.yml 2>/dev/null` returns no new matches beyond pre-existing ones (capture the baseline at phase start).
3. **No out-of-scope creep:** None of the 12 items in requirements.md "Out-of-Scope" section are touched. Specifically: no tsconfig changes, no decoder removal, no base image swap.
4. **Frequent commits:** Phase B's 14 tasks SHOULD produce 2–4 commits, not one giant commit. Phases A, C, D, E, F, G, H, I produce one commit each. No phase produces zero commits unless its diff is genuinely empty.

## Execution Handoff

Plan complete and saved to `/Users/ben/Projects/wavekit/docs/superpowers/plans/2026-05-16-build-devx-overhaul.md`.

The recommended execution mode is **inline subagent-driven**: dispatch one fresh subagent per phase, run the verification gate after each, review between phases. Phases are sequentially dependent (each consumes the previous phase's "image builds clean" property), so parallel dispatch would waste tokens. Two reviewer-facing PR boundaries are baked in: after Phase B (Checkpoint 1, Dockerfile refactor reviewable in isolation) and after Phase F (Checkpoint 2, full new build system online).

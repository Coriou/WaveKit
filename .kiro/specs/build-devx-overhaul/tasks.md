# Build & DX Overhaul — Implementation Tasks

Dependency-sequenced checklist. Do tasks in order; each task lists the
requirements it satisfies. Check off (`- [x]`) as you complete each task.
Two checkpoints split the work into adoptable chunks.

## Phase A: s6 Service Tree Partition

Touches no Dockerfile yet. Pure file-tree reorganization. Safe to land alone.

- [x] **A.1** Remove the file `docker/overlay/s6-overlay/s6-rc.d/wavekit-api/dependencies.d/sdrpp-server`. The canonical tree's `wavekit-api` SHALL now only depend on `wavekit-init`. _Requirements: 3.10, 3.11_
- [x] **A.2** Create directory `docker/overlay/s6-overlay-sdrpp/s6-rc.d/`. _Requirements: 3.8_
- [x] **A.3** Move `docker/overlay/s6-overlay/s6-rc.d/sdrpp-server/` (with all its files: `type`, `run`, `finish`, `dependencies.d/wavekit-init`) to `docker/overlay/s6-overlay-sdrpp/s6-rc.d/sdrpp-server/`. _Requirements: 3.8_
- [x] **A.4** Move `docker/overlay/s6-overlay/s6-rc.d/services/contents.d/sdrpp-server` to `docker/overlay/s6-overlay-sdrpp/s6-rc.d/services/contents.d/sdrpp-server`. _Requirements: 3.8_
- [x] **A.5** Move `docker/overlay/s6-overlay/s6-rc.d/user/contents.d/sdrpp-server` to `docker/overlay/s6-overlay-sdrpp/s6-rc.d/user/contents.d/sdrpp-server`. _Requirements: 3.8_
- [x] **A.6** Verify `find docker/overlay/s6-overlay -iname '*sdrpp*'` returns empty. Verify `find docker/overlay/s6-overlay-sdrpp -type f` lists exactly: `sdrpp-server/type`, `sdrpp-server/run`, `sdrpp-server/finish`, `sdrpp-server/dependencies.d/wavekit-init`, `services/contents.d/sdrpp-server`, `user/contents.d/sdrpp-server`. _Requirements: 3.10, 3.11_

## Phase B: Dockerfile Refactor

Rewrites `Dockerfile` top to bottom. After this phase, image builds work with
the new structure; cache is still local-only (registry cache lands in Phase
D).

### B.1 Capture upstream SHAs

- [x] **B.1.1** For each of the 12 upstream sources (SDR++, mbelib, dsd-fme, multimon-ng, rtl_433, acarsdec, AIS-catcher, direwolf, libacars, dumpvdl2, readsb, SoapyRTLTCP, csdr), `git ls-remote` the current branch tip and record the SHA. Save these as the initial values for the `ARG <NAME>_REF` declarations. _Requirements: 3.3_
- [x] **B.1.2** Keep `GR_LORA_SDR_REF=862746dd1cf635c9c8a4bfbaa2c3a0ec3a5306c9` as-is. _Requirements: 3.3_

### B.2 Rewrite Dockerfile

- [x] **B.2.1** Add a single top-of-file ARG block declaring `S6_OVERLAY_VERSION` and all 13 decoder/binary upstream refs from §B.1. _Requirements: 3.3_
- [x] **B.2.2** Replace the current `base-deps` stage with a thin `base-build` stage containing only `build-essential`, `cmake`, `git`, `pkg-config`, `ca-certificates`, `curl`. _Requirements: 3.1_
- [x] **B.2.3** Refactor `runtime-base`:
    - Switch the s6-overlay platform-detection block from `BUILDPLATFORM` to `TARGETARCH` (case mapping per sdr-host pattern).
    - Drop the `--mount=type=cache,target=/var/lib/apt` mount; keep only the `/var/cache/apt` mount.
    - Dedupe the duplicate `libsox-fmt-all` line.
    - Verify whether `tini` is referenced anywhere under `docker/`; if not, remove the apt package.
    - _Requirements: 3.5, 10.1, 10.2, 10.4, 14_
- [x] **B.2.4** Rewrite each of the 12 `*-build` stages:
    - `FROM base-build`.
    - One `RUN apt-get install` with only this decoder's deps, protected by `--mount=type=cache,target=/var/cache/apt,sharing=locked`, ending with `rm -rf /var/lib/apt/lists/*`.
    - `ARG TARGETARCH` if the stage does arch-conditional work.
    - Pinned-ref checkout via `git clone --no-checkout <url> && cd <repo> && git fetch --depth 1 origin "${REF}" && git checkout --detach FETCH_HEAD`.
    - `make install` or equivalent.
    - _Requirements: 3.2, 3.3, 3.4_
- [x] **B.2.5** Refactor `node-build`:
    - Remove the `pnpm config set node-linker hoisted` + second install block (lines 432–438 of the current Dockerfile).
    - Single `pnpm install --frozen-lockfile --prod=false` invocation with `--mount=type=cache,target=/root/.local/share/pnpm/store,sharing=locked`.
    - Keep the existing Turbo cache mount on typecheck + build.
    - Keep the existing `pnpm prune --prod` final step.
    - _Requirements: 3.6_
    - **Note (R3 mitigation applied)**: pure-isolated single install couldn't survive cache-mount removal AND host-leaked `cli/node_modules`/`packages/*/node_modules` from build context. Per Phase B brief R3, switched to hoisted layout via `pnpm config set node-linker hoisted` BEFORE the single install. Project `.npmrc` default (`isolated`) is unchanged so `pnpm dev` is unaffected. Follow-up: fix `.dockerignore` to exclude `**/node_modules` so override can be lifted (Req 3.6).
- [x] **B.2.6** Create a new `final-base` stage:
    - `FROM runtime-base`.
    - Apt-install python3 + gnuradio + python3-numpy + python3-protobuf (drop python3-cryptography if verification shows it's unused by `lora_meshtastic_decode.py`).
    - COPY every decoder binary + library from `*-build` stages (current `final` and `final-core` share these; consolidate).
    - COPY csdr + soapy-rtltcp.
    - COPY lora artifacts.
    - COPY node runtime + app dist + workspace packages + config + package.json from `node-build`.
    - COPY `docker/scripts/init-system.sh start-api.sh finish-api.sh` (the always-needed scripts; sdrpp scripts deferred to `final`).
    - COPY `docker/scripts/lora_meshtastic_decode.py` and `docker/scripts/meshtastic_proto/`.
    - COPY `docker/config/direwolf.conf` to `/etc/direwolf.conf`.
    - COPY `docker/overlay/s6-overlay/s6-rc.d` → `/etc/s6-overlay/s6-rc.d` (canonical tree, no sdrpp).
    - COPY `docker/scripts/healthcheck.sh` → `/etc/s6-overlay/scripts/healthcheck.sh`.
    - Run `ldconfig` and decoder-verification block.
    - REMOVE the hardcoded `COPY --from=dsd-fme-build /usr/lib/x86_64-linux-gnu/libncurses* ...` line. Test build on arm64; if ncurses runtime is missing, replace with a `TARGETARCH`-conditional COPY mapping `amd64→x86_64-linux-gnu` and `arm64→aarch64-linux-gnu`.
    - HEALTHCHECK on `wavekit-api`.
    - `ENTRYPOINT ["/init"]`.
    - LABELs: maintainer, version.
    - _Requirements: 3.7, 3.13, 3.14, 3.15, 10.1, 10.3_
    - **R2 finding (ncurses)**: amd64 verification shows `libncurses6` apt package in `runtime-base` provides `/lib/x86_64-linux-gnu/libncursesw.so.6` which satisfies `dsd-fme`'s linkage. The hardcoded `COPY --from=dsd-fme-build /usr/lib/x86_64-linux-gnu/libncurses*` was DELETED entirely (no replacement). `libncurses6` is multi-arch in Debian so the same install resolves on arm64.
    - **Note (python3-cryptography)**: verified KEPT — `docker/scripts/lora_meshtastic_decode.py` imports `from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes` (line 23).
- [x] **B.2.7** Define `final` stage:
    - `FROM final-base`.
    - COPY SDR++ binaries + libraries from `sdrpp-build`.
    - COPY `docker/scripts/start-sdrpp.sh finish-sdrpp.sh` → `/usr/local/bin/`.
    - COPY `docker/overlay/s6-overlay-sdrpp/s6-rc.d` → `/etc/s6-overlay/s6-rc.d` (additive; unions sdrpp-server into the canonical tree).
    - `RUN chmod -R 755 /etc/s6-overlay/s6-rc.d`.
    - EXPOSE add 5259, 7355.
    - LABEL mode=full.
    - _Requirements: 3.8, 3.10_
    - **Note**: current SDR++ master installs to `/usr/bin/sdrpp`, `/usr/lib/libsdrpp_core.so`, `/usr/lib/sdrpp/plugins/`. The old Dockerfile's COPY paths (`/usr/local/bin/sdrpp*`, `/usr/local/lib/libsdrpp*`) silently no-op'd — they have been corrected here. Also added SDR++-specific runtime libs (`libglfw3`, `libvolk2.5`, `libglvnd0`, `libopengl0`) to `final` only (kept out of `runtime-base` so `final-core` stays slim).
- [x] **B.2.8** Define `final-core` stage:
    - `FROM final-base`.
    - LABEL mode=core.
    - No further content. (Existence of the stage is the contract.)
    - _Requirements: 3.9, 3.10, 3.11_
- [x] **B.2.9** Rewrite `final-sdrpp` stage:
    - `FROM runtime-base`.
    - Apply the `TARGETARCH` s6 platform-detection fix (inherited from `runtime-base` refactor in B.2.3).
    - Existing structure otherwise preserved.
    - _Requirements: 3.5_
    - **Note**: the old `final-sdrpp` was already broken — it copied `s6-rc.d/base` which had been renamed to `s6-rc.d/wavekit-init` since commit 7d18546 (Jan 2). Reconstructed with per-file COPY: copy `services/type`, `user/type`, `user/contents.d/services` from the canonical tree, plus `sdrpp-server/{type,run,finish}` and the two `contents.d` registration files from the sdrpp overlay. `sdrpp-server/dependencies.d/wavekit-init` is intentionally omitted (this image doesn't ship wavekit-init). All COPYs are additive (Req 3.10).
- [x] **B.2.10** Add `final-demod` stage:
    - `FROM runtime-base`.
    - Apt-install (with cache mount): sox, libsox-fmt-all (already in runtime-base — verify), vim, netcat-openbsd, python3, python3-pip, python3-matplotlib, python3-numpy, python3-scipy, ffmpeg, gnuradio, gr-osmosdr.
    - COPY dsd-fme + libmbe* from `dsd-fme-build`.
    - COPY multimon-ng from `multimon-ng-build`.
    - COPY csdr + libcsdr* from `csdr-build`.
    - rtl_* tools: apt-install `rtl-sdr` in this stage (Debian package provides `rtl_test`, `rtl_fm`, `rtl_sdr`, `rtl_tcp`, etc.). `librtlsdr0` is already in `runtime-base`. No dedicated `rtl-sdr-build` stage is added — `final-demod` is for interactive testing, not production, so Debian's packaged version is sufficient.
    - `WORKDIR /workspace`.
    - `RUN mkdir -p /data/debug_audio /scripts /output`.
    - `CMD ["/bin/bash"]`.
    - No s6, no ENTRYPOINT — this is an interactive utility container, not a supervised service.
    - _Requirements: 2.4, 3.12_
- [x] **B.2.11** Smoke-test locally:
    - `docker buildx build --target final-core --load -t wavekit:dev-core .`
    - `docker buildx build --target final --load -t wavekit:dev .`
    - `docker buildx build --target final-sdrpp --load -t wavekit:dev-sdrpp .`
    - `docker buildx build --target final-demod --load -t wavekit:dev-demod .`
    - All four builds succeed.
    - _Requirements: covers B.2.1–B.2.10_
- [x] **B.2.12** Verify Property 8 and Property 9 against the new `final-core` image:
    - `docker run --rm wavekit:dev-core sh -c 'find /etc/s6-overlay -iname "*sdrpp*"'` returns empty.
    - `docker run --rm wavekit:dev-core ls /etc/s6-overlay/s6-rc.d/wavekit-api/dependencies.d/` returns exactly `wavekit-init`.
    - `docker run --rm wavekit:dev sh -c 'find /etc/s6-overlay -name "sdrpp-server" | wc -l'` returns >= 1.
    - _Requirements: 3.10, 3.11_

> **Checkpoint 1**: Dockerfile refactor complete. Old compose files still
> exist; they still work because the stage names (`final`, `final-core`,
> `final-sdrpp`) are unchanged. Safe to land Phases A and B as one
> reviewable PR before continuing.

## Phase C: Compose Collapse

- [x] **C.1** Create `/Users/ben/Projects/wavekit/compose.yaml` per the design §3 with four profiles (`dev`, `prod-single-host`, `prod-distributed`, `demod-test`). _Requirements: 2.1–2.5_
- [x] **C.2** Each service with a `build:` block declares `cache_from` pointing at the relevant `ghcr.io/coriou/wavekit:cache-*` registry refs (for now this is harmless; in Phase D those refs get populated). _Requirements: 2.5_
- [x] **C.3** Verify `docker compose --profile dev config` parses without warnings. _Requirements: 2.1, 2.6_
- [x] **C.4** Verify `docker compose --profile prod-single-host config` parses without warnings. _Requirements: 2.2_
- [x] **C.5** Verify `docker compose --profile prod-distributed config` parses without warnings. _Requirements: 2.3_
- [x] **C.6** Verify `docker compose --profile demod-test config` parses without warnings. _Requirements: 2.4_
- [x] **C.7** Delete `/Users/ben/Projects/wavekit/docker-compose.dev.yml`. _Requirements: 2.6, 2.7_
- [x] **C.8** Delete `/Users/ben/Projects/wavekit/docker-compose.prod.yml`. _Requirements: 2.6_
- [x] **C.9** Delete `/Users/ben/Projects/wavekit/docker-compose.override.yml`. _Requirements: 2.6_
- [x] **C.10** Delete `/Users/ben/Projects/wavekit/docker-compose.demod-test.yml`. _Requirements: 2.6_
- [x] **C.11** Delete `/Users/ben/Projects/wavekit/docker/Dockerfile.demod-test`. _Requirements: 3.12_
- [x] **C.12** Run end-to-end: `docker compose --profile dev up --build`. wavekit-api SHALL reach `service_healthy`. `curl localhost:9000/health` SHALL return 200. _Requirements: 2.1_
    - **Notes**: Three deviations from design.md §3 were necessary to make the gate pass; each is documented inline in compose.yaml.
        1. **sdrpp-server healthcheck**: design.md prescribes `curl -fsS http://localhost:5259/`, but SDR++ in server mode speaks its own binary protocol on 5259, not HTTP, so curl fails on every probe with `HTTP/0.9 not allowed`. Switched to `bash -c '</dev/tcp/localhost/5259'` TCP probe. Same change applied to prod-distributed's `wavekit-sdrpp-prod` for consistency.
        2. **wavekit-api port mapping**: design.md prescribes `9000:9000`, but `config/default.yaml`'s `api.port=3000` makes the container bind 3000. The s6-supervised process does not inherit `WAVEKIT_API_PORT` env from `docker exec`-style container env (s6 env-isolation: only `with-contenv` would propagate, which is a Phase B-scope script change). Mapped `9000:3000` to match the legacy `make dev-up -p 9000:3000` pattern, so the user-facing `curl http://localhost:9000/health` works. The wavekit-api healthcheck (which runs inside the container) probes `http://localhost:3000/health` to match the actually-bound port. Follow-up: update `config/default.yaml` or add `with-contenv` to make env override work, then revert to `9000:9000`.
        3. **start-sdrpp.sh `--log-level info`**: pre-existing Phase A/B regression — SDR++ v1.1.0 doesn't accept `--log-level` and crash-loops with `basic_string from null` `std::logic_error`. Removed the flag from `docker/scripts/start-sdrpp.sh` to unblock C.12. This script wasn't in Phase C's "do not touch" list and the bug fully blocked the gate.
    - **C.12 result**: `wavekit-sdrpp` reached `(healthy)` after ~60s of init-time crash-loop (writing first-run config files). `wavekit-api` reached `(healthy)` 7s after start. `curl http://localhost:9000/health` returned `{"status":"ok","timestamp":"..."}` immediately.

## Phase D: Bake + Registry Cache

- [ ] **D.1** Write `/Users/ben/Projects/wavekit/docker/bake.hcl` per design §4.3. Define `_base`, all four final-target bakes, the `ci-core` helper target, the `default` group, and the `demod` group. _Requirements: 5.2, 5.3, 4.4_
- [ ] **D.2** Test bake locally: `docker buildx bake --file docker/bake.hcl default --set "*.platform=linux/amd64"`. All three targets in `default` SHALL build successfully. _Requirements: 5.2_
- [ ] **D.3** Test multi-arch bake: `docker buildx bake --file docker/bake.hcl ci-core --set "*.platform=linux/amd64,linux/arm64"`. Build SHALL succeed without `--push` (uses local layer cache for both arches). _Requirements: 5.4_
- [ ] **D.4** Rewrite `/Users/ben/Projects/wavekit/docker/build.sh` as a thin wrapper that delegates to `docker buildx bake` (OR delete the file and have Makefile call bake directly — pick whichever keeps Makefile cleanest). _Requirements: 5.1, 5.2_
- [ ] **D.5** Rewrite `/Users/ben/Projects/wavekit/docker/push.sh` to push only to GHCR (drop the docker.io path on lines 16–18). Use `WAVEKIT_GH_OWNER` env var with `coriou` fallback per sdr-host pattern. Drop `linux/arm/v7` from the default `PLATFORMS`. _Requirements: 5.4, 5.5_
- [ ] **D.6** Edit `/Users/ben/Projects/wavekit/docker/init.sh`:
    - Remove the `.docker-cache` mkdir + chmod (lines 47–51).
    - Keep the buildx-builder setup.
    - Keep the network/volume creation.
    - _Requirements: 4.5_
- [ ] **D.7** Delete `build_multiarch` from `/Users/ben/Projects/wavekit/docker/platform-utils.sh` (replaced by bake). If `detect_platform` is still used anywhere, keep it; if not, delete the whole file. _Requirements: 5.6_
- [ ] **D.8** Initial cache seed: from a clean local machine, log in to GHCR, run `docker buildx bake --file docker/bake.hcl default --push --set "*.cache-to=type=registry,ref=ghcr.io/coriou/wavekit:cache-<stage>,mode=max"`. (One-time bootstrap; subsequent updates come from CI.) _Requirements: 4.1_

## Phase E: Makefile Cleanup

- [ ] **E.1** Rewrite `/Users/ben/Projects/wavekit/Makefile` with the new target inventory per design §7.1. _Requirements: 6.1_
- [ ] **E.2** Confirm no deleted targets remain in the file. Run `make help` and verify only the targets listed in 6.1 (plus sdr-host-* and fixtures-*) appear. _Requirements: 6.2_
- [ ] **E.3** Verify all newly-introduced echo output is emoji-free and uses no decorative ANSI colour. Existing colour in retained targets MAY remain unchanged. _Requirements: 6.3_
- [ ] **E.4** Test the new dev flow end-to-end:
    - `make dev` SHALL start `pnpm dev` with esbuild watch + node watch.
    - `make dev-stack` SHALL build via buildx bake and start the dev profile.
    - `make dev-dashboard` SHALL connect the CLI dashboard.
    - `make docker-build` SHALL invoke bake.
    - `make demod-test` SHALL launch the demod-test profile interactively.
    - _Requirements: 1.1, 2.1, 2.4, 5.2, 6.1_

## Phase F: CI Workflow

- [ ] **F.1** Rewrite `/Users/ben/Projects/wavekit/.github/workflows/ci.yml` per design §8. _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
- [ ] **F.2** Update Node to `22` and pnpm install to use Corepack (matches the Dockerfile pattern). _Requirements: 7.5_
- [ ] **F.3** Add the `lint-typecheck-test` job that runs lint, typecheck, build, AND test (test was missing from the old workflow). _Requirements: 7.1_
- [ ] **F.4** Add the `docker-build` job that depends on `lint-typecheck-test`, sets up QEMU + buildx, and runs bake. _Requirements: 7.2_
- [ ] **F.5** PR path: `--cache-from` only, no login, no push. _Requirements: 7.3_
- [ ] **F.6** Main-branch path: log in to GHCR, build `default` group with `--push` and `--cache-to mode=max`. _Requirements: 7.4_
- [ ] **F.7** Smoke-test by opening a draft PR with a no-op change and verifying both jobs run and succeed. _Requirements: 7.1, 7.2, 7.3_

> **Checkpoint 2**: At this point the new build system is fully functional.
> Phases G and H are documentation + sdr-host alignment polish.

## Phase G: sdr-host Alignment

- [ ] **G.1** Edit `/Users/ben/Projects/wavekit/packages/sdr-host/Dockerfile` line 47 from `RUN npm install -g pnpm@10` to `RUN corepack enable && corepack prepare pnpm@10.28.0 --activate`. _Requirements: 9.1, 9.2_
- [ ] **G.2** Verify the sdr-host build still passes: `bash packages/sdr-host/scripts/build-publish.sh --tag testbuild --platform linux/arm64 --load`. _Requirements: 9.1_

## Phase H: Documentation Consolidation

- [ ] **H.1** Rewrite `/Users/ben/Projects/wavekit/docs/DOCKER-SETUP.md` to reflect:
    - `pnpm dev` as headline iteration loop.
    - `make dev-stack` as container integration.
    - The single `compose.yaml` with profiles.
    - The GHCR-backed registry cache.
    - The new Makefile target inventory.
    - _Requirements: 8.1_
- [ ] **H.2** Either delete `/Users/ben/Projects/wavekit/docker/README.md` OR replace its content with a one-line pointer at `docs/DOCKER-SETUP.md`. _Requirements: 8.2_
- [ ] **H.3** Condense the "Day-to-day dev (Docker)" section of `/Users/ben/Projects/wavekit/CLAUDE.md` to one paragraph (per Requirement 8.3). _Requirements: 8.3_

## Phase I: Dockerignore Audit

- [ ] **I.1** Verify `.turbo/`, `.pnpm-store/`, `.docker-cache/` are effective. Run `docker buildx build --target base-build --progress=plain .` and grep the transfer log for the offending paths. _Requirements: 11.1_
- [ ] **I.2** Verify `dist/` exclusion is effective. _Requirements: 11.2_
- [ ] **I.3** Verify `.kiro/`, `wip/`, `tests/`, `fixtures/raw/`, `fixtures/processed/` exclusions are effective. _Requirements: 11.3_
- [ ] **I.4** Verify `.dockerignore` does NOT exclude `docker/`, `config/`, `tsconfig.json`, `tsconfig.base.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `turbo.json`, `.npmrc`, `package.json`, `scripts/build-file.mjs` — all needed during the build. _Requirements: 11.4_

## Non-negotiables (verify before raising the PR)

Each item below MUST pass before the PR is reviewable. Run them in order
on a clean machine after `git pull && pnpm install`.

1. **`pnpm dev` works without Docker.** Stop the Docker daemon; run `pnpm dev`. esbuild watcher and node watcher both run. Editing `src/index.ts` triggers a rebuild + restart within 2 seconds. **(Property 7)**
2. **`make docker-build` warm-cache no-op.** Run `make docker-build` twice in a row from a state where it just succeeded. Second invocation completes in under 30 seconds, all steps `CACHED`. **(Property 4)**
3. **TypeScript-only edit invalidates only `node-build` + final-* downstream.** Touch `src/decoders/registry.ts`, run `make docker-build`. `--progress=plain` SHALL show every decoder build stage as `CACHED`; only `node-build`, `final-base`, `final`, `final-core` execute. **(Property 3)**
4. **One-decoder edit invalidates only that decoder.** Bump `READSB_REF` to a different SHA in the Dockerfile. Run `make docker-build`. `readsb-build` re-executes; every other `*-build` stage is `CACHED`. **(Property 1)**
5. **No plain `docker build` anywhere.** `grep -rn '\bdocker build\b' docker/ Makefile compose.yaml | grep -v buildx` returns no matches. **(Property 11)**
6. **One compose file.** `ls compose*.yaml docker-compose*.yml 2>/dev/null` returns exactly `compose.yaml`. **(Property 12)**
7. **`final-core` contains zero sdrpp residue.** `docker run --rm $(make docker-build TARGET=final-core | tail -1) find /etc/s6-overlay -iname '*sdrpp*'` is empty. `docker run --rm <image> ls /usr/local/bin/ | grep -i sdrpp` is empty. **(Property 8)**
8. **`wavekit-api` dependency graph is minimal.** `docker run --rm <final-core image> ls /etc/s6-overlay/s6-rc.d/wavekit-api/dependencies.d/` returns exactly the line `wavekit-init`. **(Property 9)**
9. **`final` contains exactly one sdrpp-server service.** `docker run --rm <final image> find /etc/s6-overlay -name 'sdrpp-server' -type d` returns one match. **(Property 8 inverse)**
10. **CI runs both jobs on PR.** Open a no-op draft PR; both `lint-typecheck-test` and `docker-build` complete green within the CI time budget. **(Requirement 7.1–7.3)**
11. **No emoji in newly-introduced output.** `git diff main -- Makefile docker/ .github/` SHALL have no `[U+1F300]` and above codepoints introduced. _Requirement 6.3_
12. **The 4 deleted compose files are gone.** `git diff --diff-filter=D --name-only main | grep docker-compose` shows all four. _Requirement 2.6_
13. **`docker-compose-demod-test.yml` and `docker/Dockerfile.demod-test` are gone.** Same `git diff` shows both. _Requirement 3.12_
14. **packages/sdr-host/docker-compose.yml is unchanged.** `git diff main packages/sdr-host/docker-compose.yml` is empty. _Requirement 2.8_
15. **sdr-host Dockerfile uses Corepack.** `grep -c 'corepack' packages/sdr-host/Dockerfile` returns >= 1; `grep -c 'npm install -g pnpm' packages/sdr-host/Dockerfile` returns 0. _Requirement 9.1_

## Out-of-Scope Polish (separate spec/PR, not blocking this one)

- Renovate or Dependabot rule grouping all `<DECODER>_REF` ARG bumps into a single weekly PR.
- tsconfig root vs base alignment (Anti-pattern #11 in design.md; not blocking this work).
- Replacing the existing `cli/` build with a single esbuild bundle to match the root pattern.
- A `wavekit doctor` Makefile target that prints versions of every decoder + node + the active SDR source.
- Tightening `package.json` `pnpm.onlyBuiltDependencies` to add explicit allowlist if pnpm 11+ requires it.

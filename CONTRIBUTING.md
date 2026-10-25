# Contributing to WaveKit

Thanks for helping. This page covers the setup, the checks, and how the documentation stays true.
Agents: [`AGENTS.md`](AGENTS.md) is your instruction file; it links back here.

## Setup

- Node.js 24 (`.nvmrc` pins the version) and pnpm 10 through Corepack: `corepack enable`.
- Docker with BuildKit and buildx (`make docker-init` once) for the images.
- An RTL-SDR dongle or an `rtl_tcp` server is optional: the core and the web app both run without one.

```bash
pnpm install --frozen-lockfile
pnpm run doctor                       # checks the local toolchain
make dev-local                        # core without a Pi, dongle, Docker or decoders
pnpm --filter @wavekit/web mock       # web app mock API on :3101
pnpm --filter @wavekit/web dev        # web app on :5173
```

## Layout

| Path                  | What                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `src/`                | The core: sources, channelizer, decoders, REST and WebSocket API |
| `web/`                | The web app (Vite and React), with its mock API in `web/mock/`   |
| `cli/`                | The terminal dashboard (Ink and React)                           |
| `packages/api-types`  | Shared API types (MIT)                                           |
| `packages/brand`      | Logos and the UI kit (`tokens/ui.css`)                           |
| `packages/sdr-host`   | The Raspberry Pi receiver host                                   |
| `native/wavekit-chan` | Rust channelizer                                                 |
| `config/`, `docker/`  | Configurations, image build                                      |
| `docs/`               | Documentation ([index](docs/README.md))                          |

## Checks

Run these before you push. CI runs the same, plus a Docker image build.

```bash
pnpm run lint
pnpm run typecheck
pnpm run build
pnpm test
node scripts/check-docs.mjs
```

A new workspace package needs its manifest copied in the root `Dockerfile` node-build stage, or the
image build breaks.

## Documentation

The docs are plain GitHub Markdown in the repository, so they change in the same commit as the
code they describe.

1. **Change what users see, change its page.** [`docs/doc-map.json`](docs/doc-map.json) lists which
   page covers which code: the web app's features in [`docs/WEB-APP.md`](docs/WEB-APP.md), the API
   in [`docs/API.md`](docs/API.md), the decoders in the README, and so on. A file belongs to the
   entry with the longest matching prefix, and any one page of that entry will do. Add an entry
   when you add an area: a repository test fails when a directory under `src/`, `src/core/`,
   `web/src/features/`, `packages/` or `native/` has none.
2. **Say when there is nothing to document.** If a commit changes mapped code without changing
   anything a user sees (a refactor, a test, a fix that restores documented behaviour), end the
   commit message with the trailer `Docs: none`. If the page already describes the change, or
   another commit updated it, name it instead: `Docs: docs/API.md`. A trailer covers that commit's
   own files only. A merge is checked on what it decided itself: files that conflicted, and files
   that differ from git's automatic merge of its parents. Its own trailer excuses those; a clean
   merge needs nothing. This needs git 2.38 or newer.
3. **Run the checker.** `node scripts/check-docs.mjs` fails on a broken relative link or image.
   With `--since=<ref>` it also fails on mapped code that changed without its page or a trailer.
   CI runs it on every push and pull request. On the first push of a branch, or when `<ref>` is
   not in the history or shares none with `HEAD`, it compares with the merge base of
   `origin/main`. If that merge base is `HEAD` itself (a force push of a commit already on main),
   it checks `HEAD`'s own commit rather than an empty range. If `origin/main` is missing too (a
   shallow clone), it says so and skips the freshness check.
4. **Refresh screenshots** when the UI changes visibly: `pnpm --filter @wavekit/web docs:shots`
   rebuilds the web app, runs it against the mock (the same data on every run) and rewrites
   `docs/assets/screenshots/`. Commit the images that changed.

Write for someone who has never seen WaveKit: short sentences, what it does before how it works,
commands they can paste. Dated research and measurements go in `docs/engineering/` or
`docs/specs/`, not in the user pages.

## Adding a decoder

See [`docs/DECODER-GUIDE.md`](docs/DECODER-GUIDE.md). Add it to the decoders table in the README.

## License

By contributing you agree that your contribution is licensed under AGPL-3.0-or-later, like the rest
of WaveKit (`packages/api-types` is MIT).

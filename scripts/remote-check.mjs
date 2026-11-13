#!/usr/bin/env node
// One-command full check on GitHub runners: `node scripts/remote-check.mjs [<base>]` (default github/main).
//
// Commits the working tree (tracked changes and untracked, non-ignored files) on its merge base with
// the base, with a temporary index, refuses to push anything that fails the hygiene scan, pushes
// ci/<tree12>, waits for .github/workflows/ci-remote.yml, then deletes the branch and the run. The
// merge base must already be on GitHub, so only the scanned diff is ever published. Idempotent by
// tree: a second call prints the stored result offline or attaches to the live run. stdout is only
// the summary, also written to .remote-check/summary.txt. Docs are not checked here: run
// scripts/check-docs.mjs locally.
//
// Exit: 0 green (flaky tests included), 1 failures, 2 infrastructure (run kept), 3 refused,
// 4 still running after 9 minutes: call again.

import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

import * as lib from "./remote-check-lib.mjs"

const { ok, quiet } = lib
const REMOTE = "github"
const WORKFLOW = "CI remote"
const WORKFLOW_FILE = ".github/workflows/ci-remote.yml"
const POLL_MS = 20_000
const BUDGET_MS = 9 * 60_000
const SWEEP_AGE_MS = 60 * 60_000
const KEEP = 20
const NEUTRAL = "remote-check"
const NEUTRAL_EMAIL = `${NEUTRAL}@example.invalid`

/** @typedef {{ cwd?: string, env?: Record<string, string> }} RunOpts */
/** @param {string} cmd @param {string[]} args @param {RunOpts} [o] */
const run = (cmd, args, o = {}) =>
	execFileSync(cmd, args, {
		cwd: o.cwd,
		env: { ...process.env, ...o.env },
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 256 << 20,
	})

/** Process boundaries, injectable for tests. */
export const defaultDeps = {
	/** @param {string[]} args @param {RunOpts} [o] */
	git: (args, o) => run("git", args, o),
	/** @param {string[]} args */
	gh: args => run("gh", args),
	/** @param {number} ms */
	sleep: ms => new Promise(r => setTimeout(r, ms)),
	now: () => Date.now(),
	home: homedir(),
}

/** @param {typeof defaultDeps} d @param {string[]} argv */
export async function remoteCheck(d, argv) {
	const t0 = d.now()
	const root = d.git(["rev-parse", "--show-toplevel"]).trim()
	/** @type {lib.Git} */
	const git = (args, o = {}) => d.git(args, { cwd: root, ...o })
	const slug = lib.repoSlug(git(["remote", "get-url", REMOTE]))
	if (!slug) throw new Error(`remote ${REMOTE} is not a GitHub repository`)
	const gh = (/** @type {string[]} */ args) => d.gh([...args, "-R", slug])
	const out = join(root, ".remote-check")
	fs.mkdirSync(out, { recursive: true })
	const finish = (/** @type {string} */ text, /** @type {number} */ code) => {
		fs.writeFileSync(join(out, "summary.txt"), `${text}\n`)
		return { text, code }
	}
	const refuse = (/** @type {string} */ why, hits = lib.NO_HITS) =>
		finish(lib.refusal(why, hits), 3)
	/** @returns {{ databaseId: number, headBranch: string, createdAt: string, status: string }[]} */
	const ciRuns = (extra = /** @type {string[]} */ ([])) =>
		JSON.parse(
			gh(["run", "list", "--limit", "100", ...extra, "--json", lib.RUN_FIELDS]),
		).filter(
			(/** @type {{ workflowName: string, headBranch: string }} */ r) =>
				r.workflowName === WORKFLOW && lib.BRANCH_RE.test(r.headBranch),
		)

	// The tree and the cache lookup, offline. An untracked file over 1 MB is refused before hashing.
	const untracked = lib.listUntracked(git, root)
	const big = untracked.filter(u => u.size > lib.BIG_FILE_BYTES)
	if (big.length)
		return refuse(
			"untracked",
			lib.untrackedRefusals(big, () => true),
		)
	const tree = lib.writeTree(git)
	const tree12 = tree.slice(0, 12)
	const cache = join(out, tree12)
	// A stored result answers only the base it was checked against ("<code>\t<base>").
	const base = argv[0] ?? `${REMOTE}/main`
	const codeFile = join(cache, "code")
	const cached = () => {
		const [hit, hitBase] = (
			quiet(() => fs.readFileSync(codeFile, "utf8")) ?? ""
		)
			.trim()
			.split("\t")
		const text = quiet(() =>
			fs.readFileSync(join(cache, "summary.txt"), "utf8"),
		)
		return hit && hitBase === base && text
			? finish(text.trimEnd(), Number(hit))
			: undefined
	}
	const hit = cached()
	if (hit) return hit

	// The merge base with the base must be on GitHub, or the push would publish private history.
	const ref = /^github\/(.+)$/.exec(base)?.[1] ?? "main"
	const pub = `${REMOTE}/${ref}`
	if (!ok(() => git(["fetch", "-q", REMOTE, ref])))
		return refuse(`cannot fetch ${pub}`)
	const mb = quiet(() => git(["merge-base", "HEAD", base]).trim())
	if (!mb) return refuse(`base ${base} not found or unrelated to HEAD`)
	if (!ok(() => git(["merge-base", "--is-ancestor", mb, pub])))
		return refuse(`merge base ${mb.slice(0, 8)} of ${base} is not on ${pub}`)
	fs.mkdirSync(cache, { recursive: true })

	// Refusals: the workflow must be in the tree, and the diff must pass the hygiene scan.
	if (!ok(() => git(["cat-file", "-e", `${tree}:${WORKFLOW_FILE}`])))
		return refuse(`tree ${tree12}: no ${WORKFLOW_FILE} (base too old?)`)
	const notes = []
	if (untracked.length)
		notes.push(lib.untrackedLine(untracked.map(u => u.path)))
	const denyFile = join(d.home, lib.DENYLIST_PATH)
	const denylist = lib.parseDenylist(() =>
		fs.existsSync(denyFile) ? fs.readFileSync(denyFile, "utf8") : undefined,
	)
	if ("missing" in denylist)
		notes.push(`denylist missing: ~/${lib.DENYLIST_PATH}`)
	const scan = lib.refusals({ git, mb, tree, untracked, denylist })
	if (scan.hits.length) return refuse(`tree ${tree12}: hygiene`, scan.hits)

	// Old checks (an hour or more) are swept here and again at the end; the sweep never fails a call.
	const sweepOld = () =>
		quiet(() =>
			lib.sweep({
				git,
				gh,
				remote: REMOTE,
				runs: quiet(() => ciRuns()) ?? [],
				now: d.now(),
				maxAgeMs: SWEEP_AGE_MS,
			}),
		)
	sweepOld()

	// Attach to this tree's run (state.json) or a live run of its branch; otherwise delete the
	// branch's completed runs (an earlier INFRA) and push a new one once a slot is free.
	const branch = `ci/${tree12}`
	const stateFile = join(cache, "state.json")
	/** @type {{ runId?: string, rerunAttempt?: number }} */
	const state =
		quiet(() => JSON.parse(fs.readFileSync(stateFile, "utf8"))) ?? {}
	const save = () => fs.writeFileSync(stateFile, JSON.stringify(state))
	const deadline = t0 + BUDGET_MS
	const still = (/** @type {string} */ why) =>
		finish(`remote-check RUNNING  tree ${tree12}: ${why}, call again`, 4)
	if (state.runId && !ok(() => gh(["run", "view", `${state.runId}`])))
		delete state.runId
	if (!state.runId) {
		const runs = ciRuns(["--branch", branch])
		const live = runs.find(r => r.status !== "completed")
		if (live) state.runId = String(live.databaseId)
		else {
			for (const r of runs) ok(() => gh(["run", "delete", `${r.databaseId}`]))
			while (ciRuns().filter(r => r.status !== "completed").length >= 2) {
				if (d.now() + POLL_MS > deadline)
					return still("two other checks are live, waiting for a slot")
				await d.sleep(POLL_MS)
			}
			const message = lib.commitMessage(scan.paths)
			const commit = git(
				["commit-tree", "--no-gpg-sign", tree, "-p", mb, "-m", message],
				{
					env: {
						GIT_AUTHOR_NAME: NEUTRAL,
						GIT_AUTHOR_EMAIL: NEUTRAL_EMAIL,
						GIT_COMMITTER_NAME: NEUTRAL,
						GIT_COMMITTER_EMAIL: NEUTRAL_EMAIL,
					},
				},
			).trim()
			git(["push", "-q", "--force", REMOTE, `${commit}:refs/heads/${branch}`])
			for (let i = 0; !state.runId && i < 24; i++) {
				await d.sleep(5000)
				const r = ciRuns(["--branch", branch])[0]
				if (r) state.runId = String(r.databaseId)
			}
			if (!state.runId) {
				ok(() => git(["push", "-q", REMOTE, "--delete", branch]))
				return finish(`remote-check INFRA  tree ${tree12}: no run started`, 2)
			}
		}
		save()
	}
	const runId = String(state.runId)

	// Wait; jobs without a verdict are rerun once, and a rerun gh refuses is INFRA at once. A run
	// that vanished was finished by another call for this tree: its stored result, else call again.
	const dl = join(cache, "verdicts")
	/** @type {{ status: string, attempt: number, url: string, createdAt: string, updatedAt: string, jobs: { name: string, databaseId: number, conclusion: string }[] }} */
	let view
	let expected = /** @type {string[]} */ ([])
	for (;;) {
		const viewed = quiet(() =>
			JSON.parse(gh(["run", "view", runId, "--json", lib.VIEW_FIELDS])),
		)
		if (!viewed) return cached() ?? still(`run ${runId} is gone or unreadable`)
		view = viewed
		if (
			view.status === "completed" &&
			view.attempt > (state.rerunAttempt ?? 0)
		) {
			fs.rmSync(dl, { recursive: true, force: true })
			ok(() => gh(["run", "download", runId, "-D", dl, "-p", "verdict-*"]))
			const jobs = view.jobs.filter(j => j.conclusion !== "skipped")
			expected = jobs.map(j => lib.artifactName(j.name))
			const missing = jobs.filter(
				j => !fs.existsSync(join(dl, lib.artifactName(j.name), "verdict.json")),
			)
			if (missing.length === 0 || state.rerunAttempt !== undefined) break
			state.rerunAttempt = view.attempt
			save()
			const how =
				missing.length === 1
					? ["--job", `${missing[0]?.databaseId}`]
					: ["--failed"]
			if (!ok(() => gh(["run", "rerun", runId, ...how]))) {
				fs.rmSync(stateFile, { force: true })
				return finish(
					`remote-check INFRA  tree ${tree12}: rerun refused, run ${view.url} kept`,
					2,
				)
			}
		}
		if (d.now() + POLL_MS > deadline)
			return still(`run ${view.url} still running`)
		await d.sleep(POLL_MS)
	}
	const { code, text } = lib.verdictOf({
		dl,
		expected,
		notes,
		view,
		tree12,
		mb,
		root,
		out,
		home: d.home,
		now: d.now(),
	})

	// Cache (a FAIL too: `rm -r .remote-check/<tree12>` forces a recheck), then delete the branch
	// and, unless the infrastructure failed, the run. An INFRA run is never reattached: state.json
	// goes, and the next call deletes it and pushes a new one.
	fs.writeFileSync(join(cache, "summary.txt"), `${text}\n`)
	if (code !== 2) fs.writeFileSync(codeFile, `${code}\t${base}`)
	fs.rmSync(dl, { recursive: true, force: true })
	fs.rmSync(stateFile, { force: true })
	ok(() => git(["push", "-q", REMOTE, "--delete", branch]))
	if (code !== 2) ok(() => gh(["run", "delete", runId]))
	const dirs = fs
		.readdirSync(out, { withFileTypes: true })
		.filter(e => e.isDirectory())
		.map(e => join(out, e.name))
		.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
	for (const p of dirs.slice(KEEP))
		fs.rmSync(p, { recursive: true, force: true })
	sweepOld()
	return finish(text, code)
}

if (
	process.argv[1] &&
	import.meta.url.endsWith(`/${process.argv[1].split("/").pop()}`)
) {
	let result
	try {
		result = await remoteCheck(defaultDeps, process.argv.slice(2))
	} catch (e) {
		const err = /** @type {{ stderr?: string, message?: string }} */ (e)
		const why = lib.trimMessage(err.stderr || err.message || String(e), 200)
		result = { text: `remote-check INFRA  ${why}`, code: 2 }
		const root = lib.quiet(() =>
			defaultDeps.git(["rev-parse", "--show-toplevel"]).trim(),
		)
		if (root)
			lib.quiet(() => {
				fs.mkdirSync(join(root, ".remote-check"), { recursive: true })
				fs.writeFileSync(
					join(root, ".remote-check/summary.txt"),
					`${result.text}\n`,
				)
			})
	}
	process.stdout.write(`${result.text}\n`)
	process.exitCode = result.code
}

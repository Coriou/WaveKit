#!/usr/bin/env node
// One-command full check on GitHub runners: `node scripts/remote-check.mjs [<base>]` (default github/main).
//
// Commits the working tree (tracked changes and untracked, non-ignored files) on its merge base with
// the base, with a temporary index, refuses to push anything that fails the hygiene scan (the
// private deny-list is required), pushes ci/<key> (key: 12 hex of sha1(tree + merge base)), waits
// for .github/workflows/ci-remote.yml, then deletes the branch and its own run. The merge base must
// already be on GitHub, so only the scanned diff is ever published. Idempotent by key: a second
// call prints the stored result offline or attaches to the live run of the same tree and merge
// base. Jobs without a verdict are rerun once per call; an INFRA result is not stored and its run
// is deleted, so a later call starts a fresh run.
// stdout is only the summary, also written to .remote-check/summary.txt. Docs are not checked here:
// run scripts/check-docs.mjs locally.
//
// Exit: 0 green (flaky tests included), 1 failures, 2 infrastructure (not stored), 3 refused,
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
	/** The deny-list text; undefined when the file is absent, throws when it is unreadable. */
	readDenylist: () => {
		try {
			return fs.readFileSync(join(homedir(), lib.DENYLIST_PATH), "utf8")
		} catch (e) {
			if (/** @type {{ code?: string }} */ (e).code === "ENOENT")
				return undefined
			throw e
		}
	},
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
	let tree12 = "-"
	// Every call appends a line to the private usage ledger (outside the repo; never swept).
	const finish = (
		/** @type {string} */ text,
		/** @type {number} */ code,
		cachedHit = 0,
	) => {
		fs.writeFileSync(join(out, "summary.txt"), `${text}\n`)
		const row = [new Date(d.now()).toISOString(), root, tree12, code]
		const wall = Math.round((d.now() - t0) / 1000)
		lib.logCall(d.home, [...row, wall, cachedHit])
		return { text, code }
	}
	const refuse = (/** @type {string} */ why, hits = lib.NO_HITS) =>
		finish(lib.refusal(why, hits), 3)
	/** @returns {{ databaseId: number, headBranch: string, headSha: string, createdAt: string, updatedAt: string, status: string }[]} */
	const ciRuns = (extra = /** @type {string[]} */ ([])) =>
		JSON.parse(
			gh(["run", "list", "--limit", "100", ...extra, "--json", lib.RUN_FIELDS]),
		).filter(
			(/** @type {{ workflowName: string, headBranch: string }} */ r) =>
				r.workflowName === WORKFLOW && lib.BRANCH_RE.test(r.headBranch),
		)

	// The deny-list is required: missing, unreadable, empty or invalid refuses before anything else.
	const denylist = lib.parseDenylist(d.readDenylist)
	if ("error" in denylist) return refuse(denylist.error)

	// The tree and the cache lookup, offline. An untracked file over 1 MB is refused before hashing.
	const untracked = lib.listUntracked(git, root)
	const big = untracked.filter(u => u.size > lib.BIG_FILE_BYTES)
	if (big.length)
		return refuse(
			"untracked",
			lib.untrackedRefusals(big, () => true),
		)
	const tree = lib.writeTree(git)
	tree12 = tree.slice(0, 12)
	// A stored result answers its key (tree and merge base): first from the local base ref, offline,
	// then again after the fetch when that moved the merge base.
	const base = argv[0] ?? `${REMOTE}/main`
	const mergeBase = () => quiet(() => git(["merge-base", "HEAD", base]).trim())
	const at = (/** @type {string} */ m) => {
		const key = lib.checkKey(tree, m)
		const cache = join(out, key)
		return { key, cache, codeFile: join(cache, "code") }
	}
	const cachedAt = (/** @type {ReturnType<typeof at>} */ k) => {
		const hit = (quiet(() => fs.readFileSync(k.codeFile, "utf8")) ?? "")
			.trim()
			.split("\t")[0]
		const text = quiet(() =>
			fs.readFileSync(join(k.cache, "summary.txt"), "utf8"),
		)
		return hit && text ? finish(text.trimEnd(), Number(hit), 1) : undefined
	}
	const localMb = mergeBase()
	const early = localMb ? cachedAt(at(localMb)) : undefined
	if (early) return early

	// The merge base with the base must be on GitHub, or the push would publish private history.
	const ref = /^github\/(.+)$/.exec(base)?.[1] ?? "main"
	const pub = `${REMOTE}/${ref}`
	if (!ok(() => git(["fetch", "-q", REMOTE, ref])))
		return refuse(`cannot fetch ${pub}`)
	const mb = mergeBase()
	if (!mb) return refuse(`base ${base} not found or unrelated to HEAD`)
	if (!ok(() => git(["merge-base", "--is-ancestor", mb, pub])))
		return refuse(`merge base ${mb.slice(0, 8)} of ${base} is not on ${pub}`)
	const k = at(mb)
	const { key, cache, codeFile } = k
	const cached = () => cachedAt(k)
	if (mb !== localMb) {
		const hit = cached()
		if (hit) return hit
	}
	fs.mkdirSync(cache, { recursive: true })

	// Refusals: the workflow must be in the tree, and the diff must pass the hygiene scan.
	if (!ok(() => git(["cat-file", "-e", `${tree}:${WORKFLOW_FILE}`])))
		return refuse(`tree ${tree12}: no ${WORKFLOW_FILE} (base too old?)`)
	const notes = []
	if (untracked.length)
		notes.push(lib.untrackedLine(untracked.map(u => u.path)))
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

	// Attach to this key's run (state.json), else to a run of its branch whose commit is this tree on
	// this merge base (live, or completed: another call's, its verdict reused but the run left to
	// that call or the sweep unless it is older than the sweep's hour); otherwise push a new one once
	// a slot is free. Only the sweep deletes other calls' runs, and only after an hour.
	const branch = `ci/${key}`
	const stateFile = join(cache, "state.json")
	/** @type {{ runId?: string, rerunAttempt?: number }} */
	const state =
		quiet(() => JSON.parse(fs.readFileSync(stateFile, "utf8"))) ?? {}
	const save = () => fs.writeFileSync(stateFile, JSON.stringify(state))
	const deadline = t0 + BUDGET_MS
	const still = (/** @type {string} */ why) =>
		finish(`remote-check RUNNING  tree ${tree12}: ${why}, call again`, 4)
	// A vanished run takes its rerun mark along: a new run starts at attempt 1 again.
	if (state.runId && !ok(() => gh(["run", "view", `${state.runId}`]))) {
		delete state.runId
		delete state.rerunAttempt
		save()
	}
	const ours = (/** @type {{ headSha: string }} */ r) =>
		quiet(() => git(["log", "-1", "--format=%T %P", r.headSha]).trim()) ===
		`${tree} ${mb}`
	// A completed run another call left (it may still be reading it) is not deleted while young.
	let adopted = false
	if (!state.runId) {
		const runs = ciRuns(["--branch", branch]).filter(r => r.headSha && ours(r))
		const found = runs.find(r => r.status !== "completed") ?? runs[0]
		if (found) {
			state.runId = String(found.databaseId)
			adopted =
				found.status === "completed" &&
				!(d.now() - Date.parse(found.updatedAt) > SWEEP_AGE_MS)
		} else {
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
				if (d.now() + 5000 > deadline)
					return still(`run of ${branch} not started yet`)
				await d.sleep(5000)
				const r = ciRuns(["--branch", branch]).find(x => x.headSha === commit)
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

	// Wait; jobs without a verdict or with an infra one (a failed setup step) are rerun once, each by
	// its job id (`--failed` would not pick a job that concluded success without a usable verdict),
	// unless a real failure is already known: then nothing is rerun and the check fails. Still
	// without a verdict after the rerun is INFRA. A rerun gh refuses is INFRA at once (the verdicts
	// read so far are the summary), unless the run is live again (another call for this key reran
	// it): then this call waits for that rerun. A run that vanished was finished by another call for
	// this key: its stored result, else call again.
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
			const read = new Map(
				expected.map(n => [n, lib.readVerdict(join(dl, n, "verdict.json"))]),
			)
			const missing = jobs.filter(j => {
				const v = read.get(lib.artifactName(j.name))
				return !v || v.infra
			})
			const failed = [...read.values()].some(v => v && !v.infra && !v.ok)
			if (missing.length === 0 || failed || state.rerunAttempt !== undefined)
				break
			state.rerunAttempt = view.attempt
			save()
			// GitHub accepts one rerun request per run at a time: one missing job reruns alone,
			// several rerun the whole run in one request.
			const accepted =
				missing.length === 1
					? missing.filter(j =>
							ok(() => gh(["run", "rerun", "--job", `${j.databaseId}`])),
						)
					: ok(() => gh(["run", "rerun", runId]))
						? missing
						: []
			// Live only when a status was read and is not completed; an unreadable one is not live.
			const live = () => {
				const status = quiet(
					() =>
						JSON.parse(gh(["run", "view", runId, "--json", "status"])).status,
				)
				return status !== undefined && status !== "completed"
			}
			if (!accepted.length && !live()) {
				notes.push("rerun refused")
				break
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
		key,
		mb,
		out: cache,
		home: d.home,
		now: d.now(),
		kept: adopted,
	})

	// Cache (a FAIL too: `rm -r .remote-check/<key>` forces a recheck; never INFRA), then delete the
	// branch and the run (INFRA too: the summary keeps the failed steps' last lines as evidence)
	// unless it was adopted young from another call. state.json goes: the next call starts fresh.
	fs.writeFileSync(join(cache, "summary.txt"), `${text}\n`)
	if (code !== 2) fs.writeFileSync(codeFile, `${code}\t${base}`)
	fs.rmSync(dl, { recursive: true, force: true })
	fs.rmSync(stateFile, { force: true })
	ok(() => git(["push", "-q", REMOTE, "--delete", branch]))
	if (!adopted) ok(() => gh(["run", "delete", runId]))
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
		const row = [new Date().toISOString(), root ?? "-", "-", 2, "-", 0]
		lib.logCall(defaultDeps.home, row)
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

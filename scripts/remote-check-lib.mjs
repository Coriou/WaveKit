// Helpers of the remote check (scripts/remote-check.mjs and scripts/remote-check-job.mjs): the
// hygiene scan, shard packing, vitest JSON parsing, verdict classification and the summary, plus
// the client's git-side steps. Nothing here spawns git, gh or vitest itself: the steps take the
// client's injected `git`/`gh`, so every rule is unit tested without a network.

import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export const SHARDS = 6
export const MESSAGE_CHARS = 300
export const SUMMARY_LINES = 30
export const BIG_FILE_BYTES = 1024 * 1024
export const BRANCH_RE = /^ci\/[0-9a-f]{12}$/

// ---------------------------------------------------------------- hygiene

/** Reserved names (RFC 2606, 6761) that are safe in examples. */
const SAFE_DOMAIN =
	/(?:^|\.)(?:example\.(?:com|net|org)|example|invalid|test|localhost)$/i
/** "name@2x.png" and friends are asset names, not addresses. */
const FILE_SUFFIX =
	/\.(?:png|jpe?g|gif|svg|webp|avif|ico|js|mjs|cjs|ts|tsx|json|css|wasm)$/i

/** A private, link-local or carrier-grade NAT IPv4 address. */
export function isLanIpv4(a, b) {
	return (
		a === 10 ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && b === 168) ||
		(a === 169 && b === 254) ||
		(a === 100 && b >= 64 && b <= 127)
	)
}

/**
 * Built-in content rules; `find` returns the matched tokens. A token of a plain rule that already
 * appears in the public base is allowed (it is published already); an `absolute` rule never is.
 * @type {{ label: string, absolute?: boolean, find: (text: string) => string[] }[]}
 */
const CONTENT_RULES = [
	{
		label: "private address",
		find: text => [
			...[
				...text.matchAll(
					/(?<![\d.])(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?![\d])/g,
				),
			]
				.filter(m => {
					const o = m.slice(1, 5).map(Number)
					return o.every(n => n <= 255) && isLanIpv4(o[0] ?? 0, o[1] ?? 0)
				})
				.map(m => m[0]),
			...[...text.matchAll(/(?<![\w:])f[cde][0-9a-f]{2}:[0-9a-f]{0,4}:/gi)].map(
				m => m[0],
			),
		],
	},
	{
		label: "LAN host name",
		find: text =>
			[
				...text.matchAll(
					/(?<![\w.*/-])[a-z0-9][\w-]*\.(?:local|lan)\b(?![.\w-])/gi,
				),
			].map(m => m[0]),
	},
	{
		label: "home directory path",
		find: text =>
			[...text.matchAll(/\/(?:Users|home)\/[\w.-]+/g)].map(m => m[0]),
	},
	{
		label: "email address",
		find: text =>
			[...text.matchAll(/[\w.%+-]+@([\w-]+(?:\.[\w-]+)*\.[a-z]{2,})\b/gi)]
				.filter(m => !SAFE_DOMAIN.test(m[1] ?? "") && !FILE_SUFFIX.test(m[0]))
				.map(m => m[0]),
	},
	{
		label: "private key",
		absolute: true,
		find: text =>
			[...text.matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----/g)].map(m => m[0]),
	},
	{
		label: "GitHub token",
		absolute: true,
		find: text =>
			[
				...text.matchAll(/\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_\w{20,})/g),
			].map(m => m[0]),
	},
]

/** The private deny-list file, relative to the home directory. */
export const DENYLIST_PATH = ".config/wavekit-remote/denylist"

/**
 * The private deny-list: one regular expression per line, blank and `#` lines skipped.
 * A missing file is an empty deny-list marked `missing`; an unreadable file or an invalid line
 * refuses the push.
 * @param {() => string | undefined} read returns the text, undefined when the file is absent, throws when unreadable
 * @returns {{ patterns: RegExp[], missing?: boolean } | { error: string }}
 */
export function parseDenylist(read) {
	let text
	try {
		text = read()
	} catch {
		return { error: "deny-list unreadable" }
	}
	if (text === undefined) return { patterns: [], missing: true }
	const patterns = []
	const lines = text.split("\n")
	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim()
		if (!line || line.startsWith("#")) continue
		try {
			patterns.push(new RegExp(line, "i"))
		} catch {
			return { error: `deny-list line ${i + 1} is not a valid expression` }
		}
	}
	return { patterns }
}

/**
 * Added lines per file from a `git diff -U0` patch. Hunk bodies are consumed by the line counts of
 * their `@@` header, so an added line that looks like a header (`++ /dev/null` added as text) is
 * still an added line; `--- `/`+++ ` are headers only between hunks.
 * @param {string} patch
 * @returns {Map<string, { line: number, text: string }[]>}
 */
export function addedLines(patch) {
	/** @type {Map<string, { line: number, text: string }[]>} */
	const out = new Map()
	let file = ""
	let line = 0
	let oldLeft = 0
	let newLeft = 0
	for (const raw of patch.split("\n")) {
		if (oldLeft > 0 || newLeft > 0) {
			if (raw.startsWith("+") && newLeft > 0) {
				if (file) out.get(file)?.push({ line, text: raw.slice(1) })
				line++
				newLeft--
			} else if (raw.startsWith("-") && oldLeft > 0) oldLeft--
			else if (raw.startsWith(" ")) {
				oldLeft--
				newLeft--
				line++
			} else if (!raw.startsWith("\\")) oldLeft = newLeft = 0
			continue
		}
		if (raw.startsWith("diff --git ")) file = ""
		else if (raw.startsWith("+++ ")) {
			const p = raw.slice(4).replace(/^"(.*)"$/, "$1")
			file = p === "/dev/null" ? "" : p.replace(/^b\//, "")
			if (file && !out.has(file)) out.set(file, [])
		} else {
			const h = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw)
			if (h) {
				oldLeft = h[1] === undefined ? 1 : Number(h[1])
				line = Number(h[2])
				newLeft = h[3] === undefined ? 1 : Number(h[3])
			}
		}
	}
	return out
}

/**
 * Every hygiene hit of a diff. Fails closed: a deny-list error is itself a hit. A built-in rule's
 * token that `inBase` finds in the public base is allowed; deny-list and absolute rules never are.
 * Binaries are allowed under fixtures/ only; the size limit applies everywhere.
 * @param {{
 *   changes: { path: string, status: string, binary: boolean, size: number }[],
 *   added: Map<string, { line: number, text: string }[]>,
 *   denylist: { patterns: RegExp[] } | { error: string },
 *   inBase?: (token: string) => boolean,
 * }} input
 * @returns {{ file: string, line: number, label: string }[]}
 */
export function scanHygiene({
	changes,
	added,
	denylist,
	inBase = () => false,
}) {
	/** @type {{ file: string, line: number, label: string }[]} */
	const hits = []
	if ("error" in denylist)
		hits.push({ file: "(deny-list)", line: 0, label: denylist.error })
	const patterns = "patterns" in denylist ? denylist.patterns : []
	const known = new Map()
	const published = (/** @type {string} */ t) => {
		if (!known.has(t)) known.set(t, inBase(t))
		return known.get(t)
	}
	const scan = (
		/** @type {string} */ file,
		/** @type {number} */ line,
		/** @type {string} */ text,
	) => {
		for (const rule of CONTENT_RULES) {
			const tokens = rule.find(text)
			if (tokens.some(t => rule.absolute || !published(t)))
				hits.push({ file, line, label: rule.label })
		}
		patterns.forEach((re, i) => {
			if (re.test(text))
				hits.push({ file, line, label: `deny-list pattern ${i + 1}` })
		})
	}
	const paths = new Set([...changes.map(c => c.path), ...added.keys()])
	for (const path of paths) {
		if (/(?:^|\/)\.agents(?:\/|$)/.test(path))
			hits.push({ file: path, line: 0, label: "private agent path" })
		scan(path, 0, path)
	}
	for (const c of changes) {
		if (c.status === "D") continue
		if (c.binary && !c.path.startsWith("fixtures/"))
			hits.push({
				file: c.path,
				line: 0,
				label: "binary file outside fixtures/",
			})
		if (c.size > BIG_FILE_BYTES)
			hits.push({ file: c.path, line: 0, label: "file over 1 MB" })
	}
	for (const [file, lines] of added)
		for (const { line, text } of lines) scan(file, line, text)
	return hits
}

/** Where untracked files may come from: anything else must be committed or ignored first. */
export const UNTRACKED_DIRS = [
	"src/",
	"tests/",
	"docs/",
	"scripts/",
	"web/",
	"cli/",
	"packages/",
	"native/",
	"config/",
	"fixtures/",
	".github/",
]

/**
 * Refusals for the untracked files a check would include: over 1 MB anywhere, or outside
 * UNTRACKED_DIRS unless a root-level file of that name is tracked in the base.
 * @param {{ path: string, size: number }[]} untracked
 * @param {(path: string) => boolean} rootFileInBase
 * @returns {{ file: string, line: number, label: string }[]}
 */
export function untrackedRefusals(untracked, rootFileInBase) {
	const hits = []
	for (const u of untracked) {
		if (u.size > BIG_FILE_BYTES)
			hits.push({ file: u.path, line: 0, label: "untracked file over 1 MB" })
		else if (
			!UNTRACKED_DIRS.some(d => u.path.startsWith(d)) &&
			(u.path.includes("/") || !rootFileInBase(u.path))
		)
			hits.push({
				file: u.path,
				line: 0,
				label: "untracked file outside the source directories",
			})
	}
	return hits
}

/** "untracked N: a, b, c (+K)". @param {string[]} paths */
export const untrackedLine = paths =>
	`untracked ${paths.length}: ${paths.slice(0, 3).join(", ")}${paths.length > 3 ? ` (+${paths.length - 3})` : ""}`

// ---------------------------------------------------------------- shards

/** Test files one runner executes at once (vitest uses CPUs - 1; GitHub's Linux runners have 4). */
export const WORKERS = 3

/**
 * Greedy longest-first packing into `bins` shards; files missing from `weights` weigh 1. A shard's
 * cost is the time it is expected to take, max(heaviest file, total / WORKERS), and each file goes
 * to the shard whose cost grows least, then the lightest, then the lowest. Deterministic: ties
 * order by path.
 * @param {string[]} files
 * @param {Record<string, number>} weights
 * @returns {{ files: string[], weight: number, cost: number }[]}
 */
export function packShards(files, weights, bins = SHARDS) {
	const w = (/** @type {string} */ f) => weights[f] ?? 1
	const sorted = [...new Set(files)].sort(
		(a, b) => w(b) - w(a) || (a < b ? -1 : a > b ? 1 : 0),
	)
	const out = Array.from({ length: bins }, () => ({
		files: /** @type {string[]} */ ([]),
		weight: 0,
		cost: 0,
		max: 0,
	}))
	for (const f of sorted) {
		const fw = w(f)
		const costIf = (/** @type {{ weight: number, max: number }} */ b) =>
			Math.max(b.max, fw, (b.weight + fw) / WORKERS)
		let best = out[0]
		for (const bin of out) {
			if (!best) break
			const d = costIf(bin) - costIf(best)
			if (d < 0 || (d === 0 && bin.weight < best.weight)) best = bin
		}
		if (!best) continue
		best.files.push(f)
		best.weight += fw
		best.max = Math.max(best.max, fw)
		best.cost = costIf({ weight: best.weight - fw, max: best.max })
	}
	return out.map(({ files: fs, weight, cost }) => ({
		files: fs.sort(),
		weight,
		cost: Math.round(cost * 10) / 10,
	}))
}

// ---------------------------------------------------------------- vitest results

/** @param {string} s */
const plain = s => s.replace(/\x1b\[[0-9;]*m/g, "")

/**
 * Up to `lines` non-empty lines of a message joined by " | ", without colour codes or stack
 * frames, capped (a fast-check failure keeps its seed and counterexample).
 */
export function trimMessage(message, max = MESSAGE_CHARS, lines = 3) {
	const text = plain(String(message ?? ""))
		.split("\n")
		.map(l => l.trim())
		.filter(l => l.length > 0 && !/^at\s/.test(l))
		.slice(0, lines)
		.join(" | ")
	return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/**
 * A vitest `--reporter=json` report, per file relative to `root`.
 * @param {unknown} report
 * @param {string} root absolute repository root
 * @returns {Map<string, { ok: boolean, seconds: number, failures: { test: string, message: string }[] }>}
 */
export function parseVitestReport(report, root) {
	const out = new Map()
	const results =
		/** @type {{ testResults?: unknown[] }} */ (report ?? {}).testResults ?? []
	for (const r of results) {
		const tr = /** @type {Record<string, unknown>} */ (r ?? {})
		const name = String(tr["name"] ?? "")
		const file = name.startsWith(`${root}/`)
			? name.slice(root.length + 1)
			: name
		const start = Number(tr["startTime"] ?? 0)
		const end = Number(tr["endTime"] ?? start)
		const failures = []
		for (const a of /** @type {Record<string, unknown>[]} */ (
			tr["assertionResults"] ?? []
		)) {
			if (a["status"] !== "failed") continue
			const titles = [
				.../** @type {string[]} */ (a["ancestorTitles"] ?? []),
				String(a["title"] ?? ""),
			]
			const messages = /** @type {string[]} */ (a["failureMessages"] ?? [])
			failures.push({
				test: titles.filter(Boolean).join(" > "),
				message: trimMessage(messages[0] ?? ""),
			})
		}
		const ok = tr["status"] !== "failed"
		if (!ok && failures.length === 0)
			failures.push({
				test: "",
				message: trimMessage(tr["message"] ?? "file failed"),
			})
		out.set(file, {
			ok,
			seconds: Math.round(Math.max(0, end - start) / 100) / 10,
			failures,
		})
	}
	return out
}

/**
 * Failed and flaky entries from the shard run and the rerun of its failed files. A file failing
 * twice is failed (rerun messages win); passing on its rerun is flaky. Without `reruns` (too many
 * failures to rerun) every failure is real.
 * @param {Map<string, { ok: boolean, failures: { test: string, message: string }[] }>} first
 * @param {Map<string, { ok: boolean, failures: { test: string, message: string }[] } | undefined>} [reruns]
 */
export function classifyShard(first, reruns) {
	/** @type {{ file: string, test: string, message: string }[]} */
	const failed = []
	/** @type {{ file: string, test: string, message: string }[]} */
	const flaky = []
	for (const [file, result] of first) {
		if (result.ok) continue
		const again = reruns?.get(file)
		if (again?.ok) for (const f of result.failures) flaky.push({ file, ...f })
		else {
			const fs =
				again && again.failures.length > 0 ? again.failures : result.failures
			for (const f of fs) failed.push({ file, ...f })
			if (reruns && !again)
				failed.push({ file, test: "", message: "rerun produced no report" })
		}
	}
	return { failed, flaky }
}

// ---------------------------------------------------------------- verdicts

/**
 * The job name GitHub shows ("root (3)") as its verdict artifact name ("verdict-root-3").
 * @param {string} job
 */
export const artifactName = job =>
	`verdict-${job.replace(/ \((\d+)\)$/, "-$1")}`

/**
 * Exit code of a check: 1 any real failure (including local docs), 3 a job without a verdict,
 * 2 flaky only, 0 green.
 * @param {{ verdicts: Map<string, { ok: boolean, flaky?: unknown[] }>, expected: string[], docsOk: boolean }} input
 */
export function exitCode({ verdicts, expected, docsOk }) {
	const present = [...verdicts.values()]
	if (!docsOk || present.some(v => !v.ok)) return 1
	if (expected.some(name => !verdicts.has(name))) return 3
	if (present.some(v => (v.flaky?.length ?? 0) > 0)) return 2
	return 0
}

/** Ratio of the slowest to the fastest root shard's test phase; 1 when there is nothing to compare. */
export function shardSpread(seconds) {
	const s = seconds.filter(x => x > 0)
	if (s.length < 2) return 1
	return Math.max(...s) / Math.min(...s)
}

/**
 * A new weight table from the durations of a whole run, averaged with the previous table so one
 * noisy run moves it only halfway; files of at least one second are kept.
 * @param {Record<string, number>[]} durations
 * @param {Record<string, number>} [previous]
 */
export function durationTable(durations, previous = {}) {
	/** @type {Record<string, number>} */
	const files = {}
	const merged = Object.assign({}, ...durations)
	for (const f of Object.keys(merged).sort()) {
		const s = f in previous ? (merged[f] + (previous[f] ?? 0)) / 2 : merged[f]
		if (s >= 1) files[f] = Math.round(s)
	}
	return files
}

/** @param {number} s */
export const mmss = s =>
	`${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`

const WORD = { 0: "PASS", 1: "FAIL", 2: "FLAKY", 3: "INFRA" }

/**
 * The summary, at most 30 lines.
 * @param {{
 *   code: 0 | 1 | 2 | 3, tree: string, base: string, seconds: number,
 *   static?: { ok: boolean, seconds: number, steps: Record<string, number> } | undefined,
 *   docsOk: boolean,
 *   root: ({ ok: boolean, seconds: number, steps: Record<string, number>, failed: { file: string, test: string, message: string }[], flaky: { file: string, test: string, message: string }[] } | undefined)[],
 *   others?: { name: string, ok: boolean, seconds: number, steps: Record<string, number> }[],
 *   missing: string[], url: string, runNote: string, notes?: string[],
 * }} s
 */
export function formatSummary(s) {
	const head = [
		`remote-check ${WORD[s.code]}  tree ${s.tree}  base ${s.base.slice(0, 8)}  ${mmss(s.seconds)}`,
	]
	const bad = (/** @type {Record<string, number>} */ steps) =>
		Object.entries(steps)
			.filter(([, c]) => c !== 0)
			.map(([n]) => n)
	const st = s.static
	const staticBad = [
		...(st ? bad(st.steps) : []),
		...(s.docsOk ? [] : ["docs"]),
	]
	head.push(
		st
			? `static ${st.ok && s.docsOk ? "ok" : "FAIL"} ${st.seconds}s${staticBad.length ? `  (${staticBad.join(" ")})` : ""}`
			: `static MISSING${s.docsOk ? "" : "  (docs)"}`,
	)
	const word = (
		/** @type {{ ok: boolean, flaky?: unknown[] } | undefined} */ v,
	) =>
		!v
			? "MISSING"
			: !v.ok
				? "FAIL"
				: (v.flaky?.length ?? 0) > 0
					? "flaky"
					: "ok"
	head.push(
		`root ${s.root.map(word).join(" ")}  (${s.root.map(v => (v ? v.seconds : "-")).join(" ")} s)`,
	)
	for (const o of s.others ?? [])
		head.push(
			`${o.name} ${o.ok ? "ok" : "FAIL"} ${o.seconds}s${bad(o.steps).length ? `  (${bad(o.steps).join(" ")})` : ""}`,
		)
	if (s.missing.length) head.push(`no verdict: ${s.missing.join(", ")}`)

	const failed = s.root.flatMap((v, i) => [
		...(v ? bad(v.steps).filter(n => n !== "root-tests") : []).map(n => ({
			file: `root ${i + 1}`,
			test: `step ${n}`,
			message: "",
		})),
		...(v?.failed ?? []),
	])
	const flaky = s.root.flatMap(v => v?.flaky ?? [])
	const tail = [...(s.notes ?? [])]
	if (s.code !== 0 && s.url)
		tail.push(`run ${s.url}${s.runNote ? `  (${s.runNote})` : ""}`)
	const body = []
	let room = SUMMARY_LINES - head.length - tail.length
	const list = (
		/** @type {string} */ title,
		/** @type {{ file: string, test: string, message: string }[]} */ items,
		/** @type {boolean} */ withMessage,
	) => {
		if (!items.length || room <= 0) return
		body.push(`${title} ${items.length}`)
		room--
		let shown = 0
		for (const it of items) {
			const need = withMessage && it.message ? 2 : 1
			const left = items.length - shown
			if (shown >= 10 || room - need < (left > 1 ? 1 : 0)) break
			body.push(`  ${it.file}${it.test ? ` > ${it.test}` : ""}`)
			if (need === 2) body.push(`    ${it.message}`)
			room -= need
			shown++
		}
		if (shown < items.length && room > 0) {
			body.push(`  +${items.length - shown} more`)
			room--
		}
	}
	list("failed", failed, true)
	list("flaky", flaky, false)
	return [...head, ...body, ...tail].slice(0, SUMMARY_LINES).join("\n")
}

// ---------------------------------------------------------------- sweep

/**
 * The ci/<12 hex> branches and their runs older than `maxAgeMs`; a branch of unknown age stays.
 * @param {{ branches: { name: string, time: number }[], runs: { id: number, branch: string, createdAt: number }[], now: number, maxAgeMs: number }} input
 */
export function sweepTargets({ branches, runs, now, maxAgeMs }) {
	const old = (/** @type {number} */ t) =>
		Number.isFinite(t) && now - t > maxAgeMs
	return {
		branches: branches
			.filter(b => BRANCH_RE.test(b.name) && old(b.time))
			.map(b => b.name),
		runs: runs
			.filter(r => BRANCH_RE.test(r.branch) && old(r.createdAt))
			.map(r => r.id),
	}
}

// ---------------------------------------------------------------- git inputs

/** "owner/repo" of a GitHub remote URL (an SSH host alias such as github.com-name works), or "". */
export function repoSlug(url) {
	return (
		/github\.com[^:/\s]*[:/]([^/\s]+\/[^/\s]+?)(?:\.git)?\/?\s*$/.exec(
			url,
		)?.[1] ?? ""
	)
}

/**
 * Changed files and added lines between two trees, for scanHygiene. Renames count as an add and a
 * delete, so every line of a moved file is scanned.
 * @param {(args: string[]) => string} git returns stdout
 * @param {string} from
 * @param {string} to
 */
export function collectChanges(git, from, to) {
	const diff = (/** @type {string[]} */ a) =>
		git([
			"-c",
			"core.quotePath=false",
			"diff",
			"--no-renames",
			"--no-ext-diff",
			"--no-textconv",
			...a,
			from,
			to,
		])
	const binary = new Set(
		diff(["--numstat", "-z"])
			.split("\0")
			.filter(l => l.startsWith("-\t-\t"))
			.map(l => l.slice(4)),
	)
	const sizes = new Map(
		git(["ls-tree", "-r", "-l", "-z", to])
			.split("\0")
			.filter(Boolean)
			.map(l => {
				const [meta = "", path = ""] = l.split("\t")
				return [path, Number(meta.trim().split(/\s+/)[3]) || 0]
			}),
	)
	const ns = diff(["--name-status", "-z"]).split("\0")
	const changes = []
	for (let i = 0; i + 1 < ns.length; i += 2) {
		const path = ns[i + 1] ?? ""
		changes.push({
			path,
			status: ns[i] ?? "",
			binary: binary.has(path),
			size: sizes.get(path) ?? 0,
		})
	}
	return { changes, added: addedLines(diff(["-U0", "--no-color"])) }
}

// ---------------------------------------------------------------- client text

/** gh run list / view fields the client reads. */
export const RUN_FIELDS = "databaseId,headBranch,createdAt,status,workflowName"
export const VIEW_FIELDS = "status,attempt,url,createdAt,updatedAt,jobs"

/** @type {{ file: string, line: number, label: string }[]} */
export const NO_HITS = []

/**
 * A refusal: one header line and at most 27 hits, never the matched text.
 * @param {string} why
 * @param {{ file: string, line: number, label: string }[]} hits
 */
export function refusal(why, hits) {
	const lines = hits
		.slice(0, SUMMARY_LINES - 3)
		.map(h => `  ${h.file}${h.line ? `:${h.line}` : ""} ${h.label}`)
	if (hits.length > SUMMARY_LINES - 3)
		lines.push(`  +${hits.length - (SUMMARY_LINES - 3)} more`)
	return [`remote-check REFUSED  ${why}, nothing pushed`, ...lines].join("\n")
}

/**
 * The fixed, neutral message of a check commit; ` [native]` makes the workflow run its native job.
 * @param {string[]} paths changed paths
 */
export const commitMessage = paths =>
	`ci: remote check${paths.some(p => p.startsWith("native/")) ? " [native]" : ""}`

/** The failing lines of check-docs output, trimmed to 200 characters. @param {string} text */
export const docsProblem = text =>
	trimMessage(
		text
			.split("\n")
			.filter(l => /fail|stale|broken|missing|error/i.test(l))
			.join("\n") || text,
		200,
	)

// ---------------------------------------------------------------- client steps

/** @typedef {(args: string[], o?: { env?: Record<string, string> }) => string} Git */

/** @template T @param {() => T} f @returns {T | undefined} */
export const quiet = f => {
	try {
		return f()
	} catch {
		return undefined
	}
}
/** @param {() => unknown} f */
export const ok = f => quiet(() => (f(), true)) ?? false

/**
 * Untracked, non-ignored files and their sizes, from lstat (nothing is hashed yet).
 * @param {Git} git @param {string} root
 */
export const listUntracked = (git, root) =>
	git(["ls-files", "--others", "--exclude-standard", "-z"])
		.split("\0")
		.filter(Boolean)
		.map(path => ({ path, size: fs.lstatSync(join(root, path)).size }))

/**
 * The worktree's tree, from a temporary copy of the index: the shared index and the worktree stay
 * untouched. @param {Git} git
 */
export function writeTree(git) {
	const tmp = fs.mkdtempSync(join(tmpdir(), "remote-check-"))
	try {
		const env = { GIT_INDEX_FILE: join(tmp, "index") }
		const index = git([
			"rev-parse",
			"--path-format=absolute",
			"--git-path",
			"index",
		]).trim()
		if (fs.existsSync(index)) fs.copyFileSync(index, env.GIT_INDEX_FILE)
		else git(["read-tree", "HEAD"], { env })
		git(["add", "-A"], { env })
		return git(["write-tree"], { env }).trim()
	} finally {
		fs.rmSync(tmp, { recursive: true, force: true })
	}
}

/**
 * Every refusal of a check: untracked files, then the hygiene scan of the diff from `mb` to `tree`
 * (a token of a built-in rule is allowed when `git grep` finds it in `mb`). Fails closed.
 * @param {{ git: Git, mb: string, tree: string, untracked: { path: string, size: number }[], denylist: { patterns: RegExp[] } | { error: string } }} input
 */
export function refusals({ git, mb, tree, untracked, denylist }) {
	try {
		const c = collectChanges(a => git(a), mb, tree)
		const hits = [
			...untrackedRefusals(untracked, p =>
				ok(() => git(["cat-file", "-e", `${mb}:${p}`])),
			),
			...scanHygiene({
				...c,
				denylist,
				inBase: t => ok(() => git(["grep", "-F", "-q", "-e", t, mb, "--"])),
			}),
		]
		return { hits, paths: c.changes.map(x => x.path) }
	} catch {
		return {
			hits: [{ file: "(scan)", line: 0, label: "the scan itself failed" }],
			paths: [],
		}
	}
}

/**
 * Deletes ci/<12 hex> branches and runs older than `maxAgeMs`. A branch's age is its newest run's,
 * else its commit's when that object is local; a branch of unknown age stays. Never throws.
 * @param {{ git: Git, gh: (args: string[]) => string, remote: string, runs: { databaseId: number, headBranch: string, createdAt: string }[], now: number, maxAgeMs: number }} input
 */
export function sweep({ git, gh, remote, runs, now, maxAgeMs }) {
	const ls = quiet(() => git(["ls-remote", remote, "refs/heads/ci/*"])) ?? ""
	const branches = ls
		.split("\n")
		.filter(Boolean)
		.map(l => {
			const [sha = "", ref = ""] = l.split("\t")
			const name = ref.replace("refs/heads/", "")
			const times = runs
				.filter(r => r.headBranch === name)
				.map(r => Date.parse(r.createdAt))
			const local = quiet(
				() => Number(git(["log", "-1", "--format=%ct", sha]).trim()) * 1000,
			)
			return {
				name,
				time: times.length ? Math.max(...times) : (local ?? Number.NaN),
			}
		})
	const old = sweepTargets({
		branches,
		runs: runs.map(r => ({
			id: r.databaseId,
			branch: r.headBranch,
			createdAt: Date.parse(r.createdAt),
		})),
		now,
		maxAgeMs,
	})
	for (const b of old.branches)
		quiet(() => git(["push", "-q", remote, "--delete", b]))
	for (const id of old.runs) quiet(() => gh(["run", "delete", String(id)]))
	return old
}

/**
 * The verdict of a completed run: exit code and summary from the downloaded verdicts in `dl`.
 * Side files: `<out>/durations.json` (a candidate table, on a green run whose shards drifted; the
 * tracked table is only read) and the flaky ledger under `<home>/.cache/wavekit-remote`.
 * @param {{
 *   dl: string, expected: string[], docs: { ok: boolean, text: string }, notes: string[],
 *   view: { url: string, createdAt: string, updatedAt: string },
 *   tree12: string, mb: string, root: string, out: string, home: string, now: number,
 * }} r
 */
export function verdictOf(r) {
	/** @type {Map<string, ShardVerdictT>} */
	const verdicts = new Map()
	for (const name of r.expected) {
		const v = quiet(() =>
			JSON.parse(fs.readFileSync(join(r.dl, name, "verdict.json"), "utf8")),
		)
		if (v) verdicts.set(name, v)
	}
	const shards = Array.from({ length: SHARDS }, (_, i) =>
		verdicts.get(`verdict-root-${i + 1}`),
	)
	const code = /** @type {0 | 1 | 2 | 3} */ (
		exitCode({ verdicts, expected: r.expected, docsOk: r.docs.ok })
	)
	const notes = [...r.notes]
	if (!r.docs.ok) notes.push(`docs: ${docsProblem(r.docs.text)}`)
	const spread = shardSpread(shards.map(v => v?.testSeconds ?? 0))
	if (code === 0 && shards.every(Boolean) && spread > 1.5) {
		const table = JSON.parse(
			fs.readFileSync(
				join(r.root, "scripts/remote-check-durations.json"),
				"utf8",
			),
		)
		table.files = durationTable(
			shards.map(v => v?.durations ?? {}),
			table.files ?? {},
		)
		fs.writeFileSync(
			join(r.out, "durations.json"),
			`${JSON.stringify(table, null, "\t")}\n`,
		)
		notes.push(
			`durations drifted ${spread.toFixed(1)}x: cp .remote-check/durations.json scripts/remote-check-durations.json`,
		)
	}
	const flaky = shards.flatMap(v => v?.flaky ?? [])
	if (flaky.length) {
		const ledger = join(r.home, ".cache/wavekit-remote")
		fs.mkdirSync(ledger, { recursive: true })
		const day = new Date(r.now).toISOString()
		fs.appendFileSync(
			join(ledger, "flaky.log"),
			flaky
				.map(f => `${day}\t${r.tree12}\t${f.file}\t${f.test}\t${f.message}\n`)
				.join(""),
		)
	}
	const text = formatSummary({
		code,
		tree: r.tree12,
		base: r.mb,
		seconds:
			(Date.parse(r.view.updatedAt) - Date.parse(r.view.createdAt)) / 1000,
		static: verdicts.get("verdict-static"),
		docsOk: r.docs.ok,
		root: shards,
		others: [...verdicts]
			.filter(([n]) => n !== "verdict-static" && !n.startsWith("verdict-root-"))
			.map(([n, v]) => ({ ...v, name: n.slice(8) })),
		missing: r.expected.filter(n => !verdicts.has(n)).map(n => n.slice(8)),
		url: r.view.url,
		runNote: code === 3 ? "kept for inspection" : "deleted",
		notes,
	})
	return { code, text }
}

/**
 * @typedef {{ ok: boolean, seconds: number, steps: Record<string, number>, failed: { file: string, test: string, message: string }[], flaky: { file: string, test: string, message: string }[], testSeconds?: number, durations?: Record<string, number> }} ShardVerdictT
 */

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

/** The agent paths AGENTS.md names: the memory link and its index. */
const AGENT_LINKS = ["memory", "memory/MEMORY.md"].map(p => `.agents/${p}`)

/**
 * Built-in content rules; `find` returns the matched tokens. A token of a plain rule that already
 * appears as a whole token of the same rule in the public base is allowed (it is published
 * already); an `absolute` rule never is.
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
			// The whole address is the token (no zone, no brackets), so a link-local or unique-local
			// address in the base does not allow a longer one it is a prefix of.
			...[
				...text.matchAll(
					/(?<![\w:])f[cde][0-9a-f]{2}:[0-9a-f]{0,4}:(?:[0-9a-f:]*[0-9a-f])?/gi,
				),
			].map(m => m[0]),
		],
	},
	{
		// A bare name (not a path segment like config/x.local) or the host of a URL
		// (scheme://[user@]a.b.local[:port]/...); /usr/local/bin has no dot before "local".
		label: "LAN host name",
		find: text => [
			...[
				...text.matchAll(
					/(?<![\w.*/-])[a-z0-9][\w-]*\.(?:local|lan)\b(?![.\w-])/gi,
				),
			].map(m => m[0]),
			...[
				...text.matchAll(
					/:\/\/(?:[^\s/@]*@)?((?:[a-z0-9][\w-]*\.)+(?:local|lan))(?![.\w-])/gi,
				),
			].map(m => m[1] ?? ""),
		],
	},
	{
		// Six hex pairs joined by one separator, not part of a longer run of pairs.
		label: "MAC address",
		find: text =>
			[
				...text.matchAll(
					/(?<![0-9a-f]|[0-9a-f][:-])[0-9a-f]{2}([:-])(?:[0-9a-f]{2}\1){4}[0-9a-f]{2}(?![0-9a-f]|[:-][0-9a-f])/gi,
				),
			].map(m => m[0]),
	},
	{
		label: "home directory path",
		find: text =>
			[...text.matchAll(/\/(?:Users|home)\/[^\s"'`)]+/g)].map(m => m[0]),
	},
	{
		label: "email address",
		find: text =>
			[...text.matchAll(/[\w.%+-]+@([\w-]+(?:\.[\w-]+)*\.[a-z]{2,})\b/gi)]
				.filter(m => !SAFE_DOMAIN.test(m[1] ?? "") && !FILE_SUFFIX.test(m[0]))
				.map(m => m[0]),
	},
	{
		// The private agent directory may be named on its own, as may the shared memory link and its
		// index file that AGENTS.md names (AGENT_LINKS); anything else inside it only when the base
		// already holds that whole path (it is public already).
		label: "private agent path",
		find: text =>
			[...text.matchAll(/(?<![\w-])\.agents\/[\w.\/-]*\w/g)]
				.map(m => m[0])
				.filter(t => !AGENT_LINKS.includes(t)),
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
 * token is allowed when `inBase` finds it in the public base as a whole token of that rule (it
 * gets the rule's `find` to check the base lines with); deny-list and absolute rules never are.
 * Binaries are allowed under fixtures/ only; the size limit applies everywhere.
 * @param {{
 *   changes: { path: string, status: string, binary: boolean, size: number }[],
 *   added: Map<string, { line: number, text: string }[]>,
 *   denylist: { patterns: RegExp[] } | { error: string },
 *   inBase?: (token: string, find: (text: string) => string[]) => boolean,
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
	const seen = new Set()
	const hit = (
		/** @type {string} */ file,
		/** @type {number} */ line,
		/** @type {string} */ label,
	) => {
		const key = `${file}\0${line}\0${label}`
		if (seen.has(key)) return
		seen.add(key)
		hits.push({ file, line, label })
	}
	if ("error" in denylist) hit("(deny-list)", 0, denylist.error)
	const patterns = "patterns" in denylist ? denylist.patterns : []
	const known = new Map()
	const published = (
		/** @type {(typeof CONTENT_RULES)[number]} */ rule,
		/** @type {string} */ t,
	) => {
		const key = `${rule.label}\0${t}`
		if (!known.has(key)) known.set(key, inBase(t, rule.find))
		return known.get(key)
	}
	const scan = (
		/** @type {string} */ file,
		/** @type {number} */ line,
		/** @type {string} */ text,
	) => {
		for (const rule of CONTENT_RULES) {
			const tokens = rule.find(text)
			if (tokens.some(t => rule.absolute || !published(rule, t)))
				hit(file, line, rule.label)
		}
		patterns.forEach((re, i) => {
			if (re.test(text)) hit(file, line, `deny-list pattern ${i + 1}`)
		})
	}
	const paths = new Set([...changes.map(c => c.path), ...added.keys()])
	for (const path of paths) {
		if (/(?:^|\/)\.agents(?:\/|$)/.test(path))
			hit(path, 0, "private agent path")
		scan(path, 0, path)
	}
	for (const c of changes) {
		if (c.status === "D") continue
		if (c.binary && !c.path.startsWith("fixtures/"))
			hit(c.path, 0, "binary file outside fixtures/")
		if (c.size > BIG_FILE_BYTES) hit(c.path, 0, "file over 1 MB")
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
 * Seconds every test file costs beyond its measured duration (vitest's per-file time leaves out
 * the worker's import and collect phase). Fitted on four checks of 1320 files: per shard,
 * c = (WORKERS × (job seconds − 18 s of setup) − measured file seconds) / files, summed over the
 * shards, gave 0.99, 1.12, 0.81 and 1.22 s per file (e.g. 3 × (1352 − 108) − 2449 = 1283 s over
 * 1320 files = 0.97 s); about 1 s.
 */
export const FILE_OVERHEAD_S = 1

/**
 * Greedy longest-first packing into `bins` shards. A file weighs its `weights` entry (0 when
 * unlisted: the table keeps files of a second or more) plus FILE_OVERHEAD_S. A shard's cost is the
 * time it is expected to take, max(heaviest file, total / WORKERS), and each file goes to the
 * shard whose cost grows least, then the lightest, then the lowest. Deterministic: ties order by
 * path.
 * @param {string[]} files
 * @param {Record<string, number>} weights
 * @returns {{ files: string[], weight: number, cost: number }[]}
 */
export function packShards(files, weights, bins = SHARDS) {
	const w = (/** @type {string} */ f) => (weights[f] ?? 0) + FILE_OVERHEAD_S
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

/** Lines of a failed step's output a verdict keeps and a summary prints, in all. */
export const TAIL_LINES = 15

/**
 * The last `lines` lines of a step's output, trimmed like a message: no colour codes, blank lines
 * or stack frames, each capped at `max` characters.
 * @param {string} output
 */
export function tailLines(output, lines = TAIL_LINES, max = 200) {
	return plain(output)
		.split("\n")
		.map(l => (l.replace(/\r+$/, "").split("\r").pop() ?? "").trim())
		.filter(l => l.length > 0 && !/^at\s/.test(l))
		.slice(-lines)
		.map(l => (l.length > max ? `${l.slice(0, max - 1)}…` : l))
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
 * Exit code of a check: 1 any real failure, 2 a job without a verdict, 0 green (flaky tests
 * included: a file that passed on its rerun is a pass).
 * @param {{ verdicts: Map<string, { ok: boolean }>, expected: string[] }} input
 */
export function exitCode({ verdicts, expected }) {
	if ([...verdicts.values()].some(v => !v.ok)) return 1
	if (expected.some(name => !verdicts.has(name))) return 2
	return 0
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

const WORD = { 0: "PASS", 1: "FAIL", 2: "INFRA" }

/**
 * The summary, at most 30 lines; a FAIL ends with how to force a recheck of the same tree. The last
 * lines of a failed step's output (a verdict's `tail`, TAIL_LINES at most in all) are indented
 * under the line naming that step; an identical tail of the same step is printed once.
 * @param {{
 *   code: 0 | 1 | 2, tree: string, base: string, seconds: number,
 *   static?: { ok: boolean, seconds: number, steps: Record<string, number>, tail?: Record<string, string[]> } | undefined,
 *   root: ({ ok: boolean, seconds: number, steps: Record<string, number>, tail?: Record<string, string[]>, failed: { file: string, test: string, message: string }[], flaky: { file: string, test: string, message: string }[] } | undefined)[],
 *   others?: { name: string, ok: boolean, seconds: number, steps: Record<string, number>, tail?: Record<string, string[]> }[],
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
	let tailRoom = TAIL_LINES
	const printed = new Set()
	/** The tail of step `n` that still fits, `extra` lines (a header) reserved; once per text. */
	const tailOf = (
		/** @type {Record<string, string[]> | undefined} */ tail,
		/** @type {string} */ n,
		extra = 0,
	) => {
		const lines = tail?.[n] ?? []
		const key = `${n}\0${lines.join("\n")}`
		if (!lines.length || printed.has(key) || tailRoom - extra < 1) return []
		printed.add(key)
		const out = lines.slice(-(tailRoom - extra))
		tailRoom -= extra + out.length
		return out
	}
	/** A job line, then each failed step's tail under a "  <step>:" line. */
	const job = (
		/** @type {string} */ line,
		/** @type {{ steps: Record<string, number>, tail?: Record<string, string[]> }} */ v,
	) => {
		head.push(line)
		for (const n of bad(v.steps)) {
			const t = tailOf(v.tail, n, 1)
			if (t.length) head.push(`  ${n}:`, ...t.map(l => `    ${l}`))
		}
	}
	const st = s.static
	if (st)
		job(
			`static ${st.ok ? "ok" : "FAIL"} ${st.seconds}s${bad(st.steps).length ? `  (${bad(st.steps).join(" ")})` : ""}`,
			st,
		)
	else head.push("static MISSING")
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
		job(
			`${o.name} ${o.ok ? "ok" : "FAIL"} ${o.seconds}s${bad(o.steps).length ? `  (${bad(o.steps).join(" ")})` : ""}`,
			o,
		)
	if (s.missing.length) head.push(`no verdict: ${s.missing.join(", ")}`)

	/** @type {{ file: string, test: string, message: string, detail?: string[] }[]} */
	const failed = s.root.flatMap((v, i) => [
		...(v ? bad(v.steps).filter(n => n !== "root-tests") : []).map(n => ({
			file: `root ${i + 1}`,
			test: `step ${n}`,
			message: "",
			detail: tailOf(v?.tail, n),
		})),
		...(v?.failed ?? []),
	])
	const flaky = s.root.flatMap(v => v?.flaky ?? [])
	const tail = [...(s.notes ?? [])]
	if (s.code !== 0 && s.url)
		tail.push(`run ${s.url}${s.runNote ? `  (${s.runNote})` : ""}`)
	if (s.code === 1) tail.push(`recheck: rm -r .remote-check/${s.tree}`)
	const body = []
	let room = SUMMARY_LINES - head.length - tail.length
	const list = (
		/** @type {string} */ title,
		/** @type {{ file: string, test: string, message: string, detail?: string[] }[]} */ items,
		/** @type {boolean} */ withMessage,
	) => {
		if (!items.length || room <= 0) return
		body.push(`${title} ${items.length}`)
		room--
		let shown = 0
		for (const it of items) {
			const msg = withMessage && it.message ? 1 : 0
			const reserve = items.length - shown > 1 ? 1 : 0
			if (shown >= 10 || room - 1 - msg < reserve) break
			const detail = (it.detail ?? []).slice(
				0,
				Math.max(0, room - 1 - msg - reserve),
			)
			body.push(`  ${it.file}${it.test ? ` > ${it.test}` : ""}`)
			if (msg) body.push(`    ${it.message}`)
			for (const d of detail) body.push(`    ${d}`)
			room -= 1 + msg + detail.length
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
 * Paths whose change runs the native job: the Rust crates, the files that build or install them
 * (Makefile, the lockfile, this workflow, the esbuild script and its kernel-digest plugin that
 * stamp dist/*.wasm), and the TypeScript references and tests its "Kernels against the JS
 * reference" step pins the Wasm kernels to (ci.yml's channelizer job): the spectrum pipeline, the
 * wideband NFM demodulator, the analog recorder and its decisions. A path missed here only skips
 * the native job of a remote check; ci.yml still runs it on every pull request and push to main and
 * stays the backstop.
 */
export const NATIVE_PREFIXES = [
	"native/",
	"Makefile",
	"pnpm-lock.yaml",
	".github/workflows/ci-remote.yml",
	"scripts/build-file.mjs",
	"scripts/kernel-digest.mjs",
	"src/core/spectrum/",
	"src/core/scanner/channel/wideband-nfm",
	"src/core/scanner/channel/wideband-analog-recorder",
	"src/core/scanner/channel/recorder-decisions",
	"tests/unit/core/spectrum/",
	"tests/unit/core/scanner/channel/",
	"tests/unit/core/scanner/wideband-analog",
	"tests/unit/core/scanner/recorder-decisions",
]

/**
 * The fixed, neutral message of a check commit; ` [native]` makes the workflow run its native job.
 * @param {string[]} paths changed paths
 */
export const commitMessage = paths =>
	`ci: remote check${paths.some(p => NATIVE_PREFIXES.some(n => p.startsWith(n))) ? " [native]" : ""}`

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
 * (a token of a built-in rule is allowed when a line `git grep` finds in `mb` holds it as a whole
 * token of that rule, so a longer address in the base does not allow its prefix). Fails closed.
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
				inBase: (t, find) =>
					(
						quiet(() => git(["grep", "-h", "-I", "-F", "-e", t, mb, "--"])) ??
						""
					)
						.split("\n")
						.some(l => find(l).includes(t)),
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
	const old = (/** @type {number} */ t) =>
		Number.isFinite(t) && t > 0 && now - t > maxAgeMs
	const ls = quiet(() => git(["ls-remote", remote, "refs/heads/ci/*"])) ?? ""
	const branches = []
	for (const l of ls.split("\n").filter(Boolean)) {
		const [sha = "", ref = ""] = l.split("\t")
		const name = ref.replace("refs/heads/", "")
		if (!BRANCH_RE.test(name)) continue
		const times = runs
			.filter(r => r.headBranch === name)
			.map(r => Date.parse(r.createdAt))
		const time = times.length
			? Math.max(...times)
			: Number(
					quiet(() => git(["log", "-1", "--format=%ct", sha]).trim()) || 0,
				) * 1000
		if (old(time)) branches.push(name)
	}
	const ids = runs
		.filter(r => BRANCH_RE.test(r.headBranch) && old(Date.parse(r.createdAt)))
		.map(r => r.databaseId)
	for (const b of branches)
		quiet(() => git(["push", "-q", remote, "--delete", b]))
	for (const id of ids) quiet(() => gh(["run", "delete", String(id)]))
	return { branches, runs: ids }
}

/**
 * The verdict of a completed run: exit code and summary from the downloaded verdicts in `dl`.
 * Side files: `<out>/durations.json` (a refreshed table from every green run with all six shards,
 * for a maintainer to copy over the tracked one; the tracked table is only read) and the flaky
 * ledger under `<home>/.cache/wavekit-remote`.
 * @param {{
 *   dl: string, expected: string[], notes: string[],
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
	const code = /** @type {0 | 1 | 2} */ (
		exitCode({ verdicts, expected: r.expected })
	)
	if (code === 0 && shards.every(Boolean)) {
		const table =
			quiet(() =>
				JSON.parse(
					fs.readFileSync(
						join(r.root, "scripts/remote-check-durations.json"),
						"utf8",
					),
				),
			) ?? {}
		table.files = durationTable(
			shards.map(v => v?.durations ?? {}),
			table.files ?? {},
		)
		fs.writeFileSync(
			join(r.out, "durations.json"),
			`${JSON.stringify(table, null, "\t")}\n`,
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
		root: shards,
		others: [...verdicts]
			.filter(([n]) => n !== "verdict-static" && !n.startsWith("verdict-root-"))
			.map(([n, v]) => ({ ...v, name: n.slice(8) })),
		missing: r.expected.filter(n => !verdicts.has(n)).map(n => n.slice(8)),
		url: r.view.url,
		runNote: code === 2 ? "kept for inspection" : "deleted",
		notes: r.notes,
	})
	return { code, text }
}

/**
 * @typedef {{ ok: boolean, seconds: number, steps: Record<string, number>, failed: { file: string, test: string, message: string }[], flaky: { file: string, test: string, message: string }[], testSeconds?: number, durations?: Record<string, number>, tail?: Record<string, string[]> }} ShardVerdictT
 */

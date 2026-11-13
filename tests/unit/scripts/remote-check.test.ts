/**
 * The remote check: its helpers (scripts/remote-check-lib.mjs: the fail-closed hygiene scan, shard
 * packing, vitest report parsing, flaky classification, exit codes, summary and sweep) and the
 * client (scripts/remote-check.mjs) driven with fake git and gh.
 *
 * Sensitive-looking inputs are assembled at run time, so this file itself passes the scan.
 */
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { remoteCheck, type Deps } from "../../../scripts/remote-check.mjs"
import {
	addedLines,
	artifactName,
	classifyShard,
	collectChanges,
	commitMessage,
	refusal,
	untrackedLine,
	untrackedRefusals,
	durationTable,
	exitCode,
	formatSummary,
	packShards,
	parseDenylist,
	parseVitestReport,
	repoSlug,
	scanHygiene,
	sweep,
	tailLines,
	trimMessage,
	FILE_OVERHEAD_S,
	SUMMARY_LINES,
	type Change,
	type ShardVerdict,
} from "../../../scripts/remote-check-lib.mjs"

const dot = (...parts: (string | number)[]) => parts.join(".")
const at = (user: string, domain: string) => `${user}${"@"}${domain}`
const none = { patterns: [] as RegExp[] }

function scanText(
	text: string,
	denylist: Parameters<typeof scanHygiene>[0]["denylist"] = none,
) {
	return scanHygiene({
		changes: [{ path: "src/a.ts", status: "M", binary: false, size: 10 }],
		added: new Map([["src/a.ts", [{ line: 7, text }]]]),
		denylist,
	})
}

describe("hygiene scan", () => {
	it.each([
		["10/8", dot(10, 1, 2, 3)],
		["172.16/12", dot(172, 20, 0, 9)],
		["192.168/16", `host ${dot(192, 168, 0, 5)}:80`],
		["link-local", dot(169, 254, 0, 1)],
		["carrier NAT", dot(100, 64, 3, 4)],
	])("flags a private address (%s)", (_, text) => {
		expect(scanText(text)).toEqual([
			{ file: "src/a.ts", line: 7, label: "private address" },
		])
	})

	it("passes public, loopback and out-of-range addresses", () => {
		for (const text of [
			dot(127, 0, 0, 1),
			dot(8, 8, 8, 8),
			dot(172, 32, 0, 1),
			dot(10, 300, 0, 1),
			"version 1.2.3",
		])
			expect(scanText(text)).toEqual([])
	})

	it("flags a unique-local IPv6 address and a LAN host name", () => {
		expect(scanText(`fd12${":"}3456::1`)[0]?.label).toBe("private address")
		expect(
			scanText(`ssh pi@${dot("receiver", "local")}`).map(h => h.label),
		).toContain("LAN host name")
		expect(
			scanText(`cp ${dot("config", "local", "yaml")} .${dot("env", "local")}`),
		).toEqual([])
	})

	it("takes a whole IPv6 address as the token, so a shorter one in the base allows nothing longer", () => {
		const c = ":"
		const scan = (text: string, base: string) =>
			scanHygiene({
				changes: [],
				added: new Map([["src/a.ts", [{ line: 1, text }]]]),
				denylist: none,
				inBase: (t, find) => base.includes(t) && find(base).includes(t),
			}).map(h => h.label)
		for (const prefix of ["fe80", "fd00"]) {
			const short = `${prefix}${c}${c}1`
			const base = `listen [${short}%eth0]${c}80`
			expect(scan(`host ${short}`, base)).toEqual([])
			expect(scan(`[${short}]${c}80`, base)).toEqual([])
			for (const longer of [`${short}${c}2`, `${short}2`, `${short}${c}abcd`])
				expect(scan(`host ${longer}`, base)).toEqual(["private address"])
		}
	})

	it("flags LAN host names inside URLs, not paths", () => {
		const local = (...p: string[]) => dot(...p, "local")
		for (const text of [
			`http${":"}//${local("receiver")}${":"}8080/api`,
			`ssh${":"}//${dot("box", "lan")}/x`,
			`ws${":"}//user${"@"}${local("a", "b")}/stream`,
			`see https${":"}//${local("my", "box")}`,
		])
			expect(scanText(text).map(h => h.label)).toContain("LAN host name")
		for (const text of [
			"run /usr/local/bin/node",
			`file${":"}///usr/local/share`,
			`see https${":"}//${dot("example", "com")}/local`,
		])
			expect(scanText(text)).toEqual([])
	})

	it("flags multi-label and sentence-final LAN names, not file names or public hosts", () => {
		const pi = dot("raspberrypi", "local")
		for (const text of [
			`open http${":"}//${pi}.`,
			`ssh ${pi}.`,
			`mount ${dot("nas", "home", "lan")} now`,
			`smb ${"/"}/${dot("nas", "local")}/share`,
		])
			expect(scanText(text).map(h => h.label)).toEqual(["LAN host name"])
		for (const text of [
			`cp .${dot("env", "local")} ${dot("settings", "local", "json")}`,
			`see ${dot("foo", "local", "example", "com")}`,
		])
			expect(scanText(text)).toEqual([])
	})

	it("does not take a Rust or C++ path for an IPv6 address", () => {
		const c = "::"
		expect(scanText(`feed${c}Parser${c}new()`)).toEqual([])
		expect(scanText(`let x: Feed${c}Item`)).toEqual([])
		expect(scanText(`fd00${c}1 and [fe80${c}2]`).map(h => h.label)).toEqual([
			"private address",
		])
	})

	it("flags MAC addresses, allowed when the base holds the same one", () => {
		const mac = (sep: string, pairs: string[]) => pairs.join(sep)
		const one = mac(":", ["b8", "27", "eb", "12", "34", "56"])
		for (const text of [
			`hw ${one}`,
			`hw ${mac("-", ["B8", "27", "EB", "12", "34", "56"])}`,
		])
			expect(scanText(text).map(h => h.label)).toEqual(["MAC address"])
		for (const text of [
			`time 12${":"}34${":"}56`,
			`bytes ${mac(":", ["01", "02", "03", "04", "05", "06", "07"])}`,
			`mixed ${["b8", "27", "eb"].join(":")}-${["12", "34", "56"].join("-")}`,
		])
			expect(scanText(text)).toEqual([])
		const scan = (text: string) =>
			scanHygiene({
				changes: [],
				added: new Map([["src/a.ts", [{ line: 1, text }]]]),
				denylist: none,
				inBase: (t, find) => find(`mac: ${one}`).includes(t),
			}).map(h => h.label)
		expect(scan(`hw ${one}`)).toEqual([])
		expect(
			scan(`hw ${mac(":", ["b8", "27", "eb", "12", "34", "57"])}`),
		).toEqual(["MAC address"])
	})

	it("flags home directory paths", () => {
		expect(scanText(`see /${"Users"}/someone/x`)[0]?.label).toBe(
			"home directory path",
		)
		expect(scanText(`see /${"home"}/someone/x`)[0]?.label).toBe(
			"home directory path",
		)
		expect(scanText("see /usr/local/bin")).toEqual([])
	})

	it("flags references inside the private agent directory unless the base holds the whole path", () => {
		const a = ".agents"
		const baseLine = `see \`${a}/lane-status.md\` and ${a}/memory/notes.md`
		const labels = (text: string, base = "") =>
			scanHygiene({
				changes: [],
				added: new Map([["docs/x.md", [{ line: 3, text }]]]),
				denylist: none,
				inBase: (t, find) => find(base).includes(t),
			}).map(h => h.label)
		expect(labels(`see \`${a}/lane-status.md\``, baseLine)).toEqual([])
		expect(labels(`cat ${a}/memory/notes.md`, baseLine)).toEqual([])
		expect(labels(`cat ${a}/memory/notes.md.bak`, baseLine)).toEqual([
			"private agent path",
		])
		expect(labels(`cat ${a}/memory`, baseLine)).toEqual([])
		// A path in the tree is never allowed, whatever the base holds.
		expect(
			scanHygiene({
				changes: [{ path: `${a}/x.md`, status: "A", binary: false, size: 1 }],
				added: new Map(),
				denylist: none,
				inBase: () => true,
			}).map(h => h.label),
		).toEqual(["private agent path"])
		for (const text of [
			`see \`${a}/lane-status.md\``,
			`cat ${a}/memory/notes.md`,
			`(${a}/handoff)`,
			`x/${a}/decode-matrix.md`,
		])
			expect(labels(text)).toEqual(["private agent path"])
		for (const text of [
			`\`${a}/\` is git-ignored`,
			`${a}/memory/MEMORY.md links to it`,
			`if \`${a}/memory\` is missing`,
			`ignores: ["${a}/**"]`,
			"agents/x.md and my.agents/x",
		])
			expect(labels(text)).toEqual([])
	})

	it("flags email addresses but not reserved domains or asset names", () => {
		expect(scanText(at("someone", dot("mail", "com")))[0]?.label).toBe(
			"email address",
		)
		expect(scanText(at("user", dot("example", "invalid")))).toEqual([])
		expect(scanText(at("user", dot("example", "com")))).toEqual([])
		expect(scanText(at("logo", dot("2x", "png")))).toEqual([])
		expect(scanText('import x from "@wavekit/shared"')).toEqual([])
	})

	it("flags private agent paths and suspicious path names", () => {
		const hits = scanHygiene({
			changes: [
				{
					path: `.agents/${"memory"}/x.md`,
					status: "A",
					binary: false,
					size: 1,
				},
				{
					path: `docs/${dot(192, 168, 0, 1)}.md`,
					status: "A",
					binary: false,
					size: 1,
				},
			],
			added: new Map(),
			denylist: none,
		})
		expect(hits.map(h => h.label)).toEqual([
			"private agent path",
			"private address",
		])
		expect(hits.every(h => h.line === 0)).toBe(true)
	})

	it("flags binaries outside fixtures/ and big files anywhere, for every status but D", () => {
		const mb2 = 2 * 1024 * 1024
		const changes: Change[] = [
			{ path: "docs/capture.bin", status: "A", binary: true, size: 10 },
			{ path: "tests/big.json", status: "A", binary: false, size: mb2 },
			{ path: "fixtures/iq/small.bin", status: "A", binary: true, size: 10 },
			{ path: "fixtures/iq/huge.bin", status: "A", binary: true, size: mb2 },
			{ path: "docs/old.png", status: "M", binary: true, size: 10 },
			{ path: "src/now-binary", status: "T", binary: true, size: 10 },
			{ path: "src/grown.ts", status: "M", binary: false, size: mb2 },
			{ path: "docs/gone.bin", status: "D", binary: true, size: mb2 },
		]
		const hits = scanHygiene({ changes, added: new Map(), denylist: none })
		expect(hits.map(h => `${h.file}: ${h.label}`)).toEqual([
			"docs/capture.bin: binary file outside fixtures/",
			"tests/big.json: file over 1 MB",
			"fixtures/iq/huge.bin: file over 1 MB",
			"docs/old.png: binary file outside fixtures/",
			"src/now-binary: binary file outside fixtures/",
			"src/grown.ts: file over 1 MB",
		])
	})

	it("allows a built-in rule's token already in the public base as a whole token only", () => {
		const home = `/${"Users"}/someone`
		// The base as `git grep` lines; a token counts only where the rule finds it whole.
		const baseLines = [
			`connect ${dot(10, 0, 0, 12)}`,
			`see \`${home}/proj/notes\`.`,
		]
		const inBase = (t: string, find: (text: string) => string[]) =>
			baseLines.some(l => l.includes(t) && find(l).includes(t))
		const scan = (text: string) =>
			scanHygiene({
				changes: [],
				added: new Map([["src/a.ts", [{ line: 1, text }]]]),
				denylist: none,
				inBase,
			}).map(h => h.label)
		expect(scan(`url ${dot(10, 0, 0, 12)}`)).toEqual([])
		expect(scan(`url ${dot(10, 0, 0, 1)}`)).toEqual(["private address"])
		expect(scan(`(${home}/proj/notes)`)).toEqual([])
		expect(scan(`"${home}/proj"`)).toEqual(["home directory path"])
		expect(scan(`${home}/proj/notes/more`)).toEqual(["home directory path"])
	})

	it("allows a built-in rule's token already in the public base, never a deny-list or secret hit", () => {
		const host = dot(10, 0, 0, 1)
		const inBase = (t: string) => t === host || t === "fixed-word"
		const denylist = parseDenylist(() => "fixed-word")
		const scan = (text: string) =>
			scanHygiene({
				changes: [],
				added: new Map([["src/a.ts", [{ line: 1, text }]]]),
				denylist,
				inBase,
			}).map(h => h.label)
		expect(scan(`url ${host}`)).toEqual([])
		expect(scan(`url ${host} and ${dot(10, 0, 0, 2)}`)).toEqual([
			"private address",
		])
		expect(scan("has fixed-word")).toEqual(["deny-list pattern 1"])
	})

	it("flags private keys and GitHub tokens", () => {
		const key = `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`
		const token = `${"ghp"}_${"a1".repeat(18)}`
		const pat = `${"github"}_pat_${"B2".repeat(15)}`
		const all = () => true
		for (const [text, label] of [
			[key, "private key"],
			[token, "GitHub token"],
			[pat, "GitHub token"],
		])
			expect(
				scanHygiene({
					changes: [],
					added: new Map([["x.md", [{ line: 2, text: `t ${text}` }]]]),
					denylist: none,
					inBase: all,
				}),
			).toEqual([{ file: "x.md", line: 2, label }])
		expect(scanText(`${"ghp"}_short`)).toEqual([])
	})

	it("applies deny-list patterns case-insensitively and never prints the match", () => {
		const denylist = parseDenylist(() => "# comment\n\nsecret-word\n")
		expect(denylist).toEqual({ patterns: [/secret-word/i] })
		const hits = scanText("has SECRET-WORD inside", denylist)
		expect(hits).toEqual([
			{ file: "src/a.ts", line: 7, label: "deny-list pattern 1" },
		])
		expect(JSON.stringify(hits)).not.toMatch(/secret/i)
	})

	it("fails closed when the deny-list is unreadable or invalid", () => {
		const unreadable = parseDenylist(() => {
			throw new Error("EACCES")
		})
		expect(unreadable).toEqual({ error: "deny-list unreadable" })
		expect(scanText("clean text", unreadable)).toEqual([
			{ file: "(deny-list)", line: 0, label: "deny-list unreadable" },
		])
		const invalid = parseDenylist(() => "ok\n(unclosed\n")
		expect(invalid).toEqual({
			error: "deny-list line 2 is not a valid expression",
		})
		expect(scanText("clean text", invalid)).toHaveLength(1)
		expect(parseDenylist(() => undefined)).toEqual({
			patterns: [],
			missing: true,
		})
	})

	it("passes a clean diff", () => {
		expect(scanText("const x = 1")).toEqual([])
	})

	it("reads added lines that look like diff headers by the hunk counts", () => {
		const patch = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -1,2 +1,3 @@",
			"---- a removed line that starts with ---",
			"-old",
			"++++ /dev/null",
			"++++ b/hidden.ts",
			"+after",
			"diff --git a/b.ts b/b.ts",
			"--- a/b.ts",
			"+++ b/b.ts",
			"@@ -0,0 +1 @@",
			"+++ /dev/null",
		].join("\n")
		expect([...addedLines(patch)]).toEqual([
			[
				"src/a.ts",
				[
					{ line: 1, text: "+++ /dev/null" },
					{ line: 2, text: "+++ b/hidden.ts" },
					{ line: 3, text: "after" },
				],
			],
			["b.ts", [{ line: 1, text: "++ /dev/null" }]],
		])
	})

	it("reads added lines and their numbers from a -U0 patch", () => {
		const patch = [
			"diff --git a/src/a.ts b/src/a.ts",
			"--- a/src/a.ts",
			"+++ b/src/a.ts",
			"@@ -3,0 +4,2 @@",
			"+first",
			"+second",
			"@@ -10 +12 @@",
			"-gone",
			"+third",
			"diff --git a/old.ts b/old.ts",
			"--- a/old.ts",
			"+++ /dev/null",
			"@@ -1 +0,0 @@",
			"-removed",
			"diff --git a/n.ts b/n.ts",
			"--- /dev/null",
			"+++ b/n.ts",
			"@@ -0,0 +1 @@",
			"+new",
			"\\ No newline at end of file",
		].join("\n")
		expect([...addedLines(patch)]).toEqual([
			[
				"src/a.ts",
				[
					{ line: 4, text: "first" },
					{ line: 5, text: "second" },
					{ line: 12, text: "third" },
				],
			],
			["n.ts", [{ line: 1, text: "new" }]],
		])
	})
})

describe("shard packing", () => {
	const files = Array.from(
		{ length: 200 },
		(_, i) => `tests/f${String(i).padStart(3, "0")}.test.ts`,
	)
	const weights: Record<string, number> = {
		"tests/f000.test.ts": 170,
		"tests/f001.test.ts": 140,
		"tests/f002.test.ts": 130,
		"tests/f003.test.ts": 120,
		"tests/f004.test.ts": 80,
		"tests/f005.test.ts": 70,
	}

	it("is deterministic whatever the input order", () => {
		const a = packShards(files, weights)
		const b = packShards([...files].reverse(), weights)
		expect(b).toEqual(a)
		expect(a.flatMap(x => x.files).sort()).toEqual(files)
	})

	it("balances expected time across six shards", () => {
		// The heaviest file bounds the slowest shard; the light files fill shards below that bound.
		const bins = packShards(files, weights)
		expect(bins).toHaveLength(6)
		expect(Math.max(...bins.map(b => b.cost))).toBe(170 + FILE_OVERHEAD_S)
		// Unlisted files weigh only the per-file overhead.
		expect(bins.reduce((s, b) => s + b.weight, 0)).toBeCloseTo(
			710 + 200 * FILE_OVERHEAD_S,
		)
		// Equal weights: shard time is total / WORKERS, so counts differ by at most one.
		const even = packShards(files, {})
		expect(even.map(b => b.files.length)).toEqual([34, 34, 33, 33, 33, 33])
		// Many mid-size files: costs end within one file of each other.
		const mid = Object.fromEntries(files.map((f, i) => [f, 5 + (i % 7)]))
		const costs = packShards(files, mid).map(b => b.cost)
		expect(Math.max(...costs) - Math.min(...costs)).toBeLessThanOrEqual(11 / 3)
	})

	it("counts the per-file overhead, so many light files do not crowd one shard", () => {
		// One heavy file and 60 unlisted ones: without the overhead every light file would weigh
		// nothing and could share the heavy file's shard for free.
		const many = Array.from({ length: 60 }, (_, i) => `tests/l${i}.test.ts`)
		const bins = packShards([...many, "tests/heavy.test.ts"], {
			"tests/heavy.test.ts": 30,
		})
		const heavy = bins.find(b => b.files.includes("tests/heavy.test.ts"))
		expect(heavy?.files).toEqual(["tests/heavy.test.ts"])
		expect(bins.map(b => b.files.length).sort()).toEqual([
			1, 12, 12, 12, 12, 12,
		])
	})

	it("puts the heaviest files in different shards", () => {
		const bins = packShards(files, weights)
		for (const f of Object.keys(weights))
			expect(bins.filter(b => b.files.includes(f))).toHaveLength(1)
		expect(
			new Set(
				Object.keys(weights).map(f => bins.findIndex(b => b.files.includes(f))),
			).size,
		).toBe(6)
	})
})

describe("vitest report and flaky classification", () => {
	const root = "/repo"
	const report = {
		testResults: [
			{
				name: "/repo/tests/a.test.ts",
				status: "passed",
				startTime: 1000,
				endTime: 3550,
				assertionResults: [],
			},
			{
				name: "/repo/tests/b.test.ts",
				status: "failed",
				startTime: 0,
				endTime: 100,
				assertionResults: [
					{ status: "passed", title: "fine", ancestorTitles: [] },
					{
						status: "failed",
						title: "breaks",
						ancestorTitles: ["suite"],
						failureMessages: [
							`\u001b[31mAssertionError: ${"x".repeat(400)}\u001b[39m\n    at line`,
						],
					},
				],
			},
			{
				name: "/repo/tests/c.test.ts",
				status: "failed",
				message: "\nError: cannot import\n    at load (x.ts:1:1)",
				assertionResults: [],
			},
		],
	}

	it("parses per-file results, durations and trimmed messages", () => {
		const r = parseVitestReport(report, root)
		expect(r.get("tests/a.test.ts")).toEqual({
			ok: true,
			seconds: 2.6,
			failures: [],
		})
		const b = r.get("tests/b.test.ts")
		expect(b?.failures[0]?.test).toBe("suite > breaks")
		expect(b?.failures[0]?.message.length).toBe(300)
		expect(b?.failures[0]?.message.startsWith("AssertionError: x")).toBe(true)
		expect(r.get("tests/c.test.ts")?.failures).toEqual([
			{ test: "", message: "Error: cannot import" },
		])
	})

	it("keeps a fast-check seed line and drops stack frames", () => {
		const msg =
			'Error: Property failed after 3 tests\n{ seed: -71210566, path: "2:1" }\n    at check (a.ts:1:1)\nCounterexample: [1500]'
		expect(trimMessage(msg)).toBe(
			'Error: Property failed after 3 tests | { seed: -71210566, path: "2:1" } | Counterexample: [1500]',
		)
		expect(trimMessage("x".repeat(400))).toHaveLength(300)
	})

	it("reports a file failing twice as failed and one passing on rerun as flaky", () => {
		const first = parseVitestReport(report, root)
		const reruns = new Map([
			["tests/b.test.ts", { ok: true, failures: [] }],
			[
				"tests/c.test.ts",
				{ ok: false, failures: [{ test: "", message: "Error: still broken" }] },
			],
		])
		const { failed, flaky } = classifyShard(first, reruns)
		expect(flaky.map(f => `${f.file} > ${f.test}`)).toEqual([
			"tests/b.test.ts > suite > breaks",
		])
		expect(failed).toEqual([
			{ file: "tests/c.test.ts", test: "", message: "Error: still broken" },
		])
	})

	it("treats every failure as real when there was no rerun", () => {
		const first = parseVitestReport(report, root)
		const { failed, flaky } = classifyShard(first, undefined)
		expect(flaky).toEqual([])
		expect(failed.map(f => f.file)).toEqual([
			"tests/b.test.ts",
			"tests/c.test.ts",
		])
	})

	it("treats a rerun without a report as failed", () => {
		const first = parseVitestReport(report, root)
		const { failed, flaky } = classifyShard(
			first,
			new Map([["tests/b.test.ts", { ok: true, failures: [] }]]),
		)
		expect(flaky).toHaveLength(1)
		expect(failed.map(f => f.message)).toEqual([
			"Error: cannot import",
			"rerun produced no report",
		])
	})
})

describe("exit codes", () => {
	const ok = { ok: true, flaky: [] }
	const expected = ["verdict-static", "verdict-root-1"]
	const v = (a: object, b?: object) =>
		new Map(
			Object.entries({
				"verdict-static": a,
				...(b ? { "verdict-root-1": b } : {}),
			}),
		) as Map<string, { ok: boolean; flaky?: unknown[] }>

	it("maps verdict sets to 0 (flaky included), 1 and 2", () => {
		expect(exitCode({ verdicts: v(ok, ok), expected })).toBe(0)
		expect(
			exitCode({ verdicts: v(ok, { ok: true, flaky: [1] }), expected }),
		).toBe(0)
		expect(
			exitCode({ verdicts: v(ok, { ok: false, flaky: [1] }), expected }),
		).toBe(1)
		expect(exitCode({ verdicts: v(ok), expected })).toBe(2)
		expect(exitCode({ verdicts: v({ ok: false }), expected })).toBe(1)
	})

	it("names verdict artifacts after GitHub's matrix job names", () => {
		expect(artifactName("root (3)")).toBe("verdict-root-3")
		expect(artifactName("static")).toBe("verdict-static")
	})
})

describe("summary", () => {
	const shard = (over: Partial<ShardVerdict> = {}): ShardVerdict => ({
		ok: true,
		seconds: 200,
		steps: { install: 0, "root-tests": 0 },
		failed: [],
		flaky: [],
		...over,
	})
	const base = {
		tree: "3f9a1c2b7d10",
		base: "189327ec5880",
		seconds: 271,
		static: { ok: true, seconds: 228, steps: { lint: 0 } },
		missing: [],
		url: "https://github.com/o/r/actions/runs/1",
		runNote: "deleted",
	}

	it("is three lines when green", () => {
		const text = formatSummary({
			...base,
			code: 0,
			root: Array.from({ length: 6 }, () => shard()),
		})
		expect(text.split("\n")).toEqual([
			"remote-check PASS  tree 3f9a1c2b7d10  base 189327ec  4m31s",
			"static ok 228s",
			"root ok ok ok ok ok ok  (200 200 200 200 200 200 s)",
		])
	})

	it("caps failures at ten and the whole summary at 30 lines", () => {
		const failed = Array.from({ length: 25 }, (_, i) => ({
			file: `tests/f${i}.test.ts`,
			test: "t",
			message: "AssertionError: no",
		}))
		const flaky = Array.from({ length: 12 }, (_, i) => ({
			file: `tests/g${i}.test.ts`,
			test: "t",
			message: "m",
		}))
		const root = [
			shard({
				ok: false,
				failed,
				flaky,
				steps: { install: 0, "root-tests": 1 },
			}),
			...Array.from({ length: 5 }, () => shard()),
		]
		const text = formatSummary({
			...base,
			static: { ok: false, seconds: 228, steps: { lint: 1, typecheck: 0 } },
			code: 1,
			root,
			notes: ["untracked 1: src/x.ts"],
		})
		const lines = text.split("\n")
		expect(lines.length).toBeLessThanOrEqual(SUMMARY_LINES)
		expect(lines[0]).toBe(
			"remote-check FAIL  tree 3f9a1c2b7d10  base 189327ec  4m31s",
		)
		expect(lines[1]).toBe("static FAIL 228s  (lint)")
		expect(lines[2]).toBe(
			"root FAIL ok ok ok ok ok  (200 200 200 200 200 200 s)",
		)
		expect(lines).toContain("failed 25")
		expect(lines.filter(l => l.startsWith("  tests/f"))).toHaveLength(10)
		expect(lines).toContain("  +15 more")
		expect(lines.slice(-3)).toEqual([
			"untracked 1: src/x.ts",
			"run https://github.com/o/r/actions/runs/1  (deleted)",
			"recheck: rm -r .remote-check/3f9a1c2b7d10",
		])
	})

	it("keeps the last 15 trimmed lines of a failed step's output", () => {
		const out = [
			...Array.from({ length: 20 }, (_, i) => `\x1b[31mline ${i}\x1b[0m`),
			"",
			"    at foo (x.js:1:1)",
			"progress 10%\rprogress 100%",
			`${"x".repeat(250)}\r`,
		].join("\n")
		const lines = tailLines(out)
		expect(lines).toHaveLength(15)
		expect(lines[0]).toBe("line 7")
		expect(lines.at(-2)).toBe("progress 100%")
		expect(lines.at(-1)).toBe(`${"x".repeat(199)}…`)
		expect(tailLines("")).toEqual([])
	})

	it("prints failed steps' output tails under their lines, 15 lines at most in all", () => {
		const tail = (n: number, w: string) =>
			Array.from({ length: n }, (_, i) => `${w} ${i}`)
		const setup = (tl: string[]) =>
			shard({
				ok: false,
				steps: { install: 1, "root-tests": -1 },
				tail: { install: tl },
			})
		const text = formatSummary({
			...base,
			code: 1,
			static: {
				ok: false,
				seconds: 228,
				steps: { lint: 1, typecheck: 0 },
				tail: { lint: tail(3, "lint") },
			},
			root: [
				setup(tail(15, "pnpm")),
				setup(tail(15, "pnpm")),
				...Array.from({ length: 4 }, () => shard()),
			],
		})
		const lines = text.split("\n")
		expect(lines.length).toBeLessThanOrEqual(SUMMARY_LINES)
		expect(lines.slice(1, 6)).toEqual([
			"static FAIL 228s  (lint)",
			"  lint:",
			"    lint 0",
			"    lint 1",
			"    lint 2",
		])
		const at = lines.indexOf("  root 1 > step install")
		expect(at).toBeGreaterThan(0)
		// 4 lines went to lint, so the shard's tail keeps its last 11; the same tail of shard 2 is
		// not repeated.
		expect(lines.slice(at + 1, at + 12)).toEqual(
			tail(15, "pnpm")
				.slice(-11)
				.map(l => `    ${l}`),
		)
		expect(lines[at + 12]).toBe("  root 2 > step install")
		expect(lines.filter(l => /^ {4}(lint|pnpm) /.test(l))).toHaveLength(14)
	})

	it("passes with flaky tests and lists them", () => {
		const text = formatSummary({
			...base,
			code: 0,
			root: [
				shard({
					flaky: [{ file: "tests/x.test.ts", test: "t", message: "m" }],
				}),
				...Array.from({ length: 5 }, () => shard()),
			],
		})
		expect(text.split("\n")).toEqual([
			"remote-check PASS  tree 3f9a1c2b7d10  base 189327ec  4m31s",
			"static ok 228s",
			"root flaky ok ok ok ok ok  (200 200 200 200 200 200 s)",
			"flaky 1",
			"  tests/x.test.ts > t",
		])
	})

	it("prints a flaky property's seed or counterexample and a replay note", () => {
		const seed =
			'Property failed after 3 tests | { seed: -71210566, path: "2" } | Counterexample: [1]'
		const text = formatSummary({
			...base,
			code: 0,
			root: [
				shard({
					flaky: [
						{ file: "tests/p.test.ts", test: "p", message: seed },
						{
							file: "tests/q.test.ts",
							test: "q",
							message: "Counterexample: [0] | x",
						},
						{ file: "tests/r.test.ts", test: "r", message: "timeout" },
					],
				}),
				...Array.from({ length: 5 }, () => shard()),
			],
		})
		expect(text.split("\n").slice(0, 1)).toEqual([
			"remote-check PASS  tree 3f9a1c2b7d10  base 189327ec  4m31s",
		])
		expect(text.split("\n").slice(3)).toEqual([
			"flaky 3",
			"  tests/p.test.ts > p  (seed -71210566)",
			"  tests/q.test.ts > q  (counterexample [0])",
			"  tests/r.test.ts > r",
			"property counterexample hidden by rerun: replay with the seed",
		])
	})

	it("lists flaky tests and missing verdicts", () => {
		const root = [
			shard({
				flaky: [{ file: "tests/x.test.ts", test: "s > t", message: "m" }],
			}),
			undefined,
			...Array.from({ length: 4 }, () => shard()),
		]
		const text = formatSummary({
			...base,
			code: 2,
			root,
			missing: ["root-2"],
			runNote: "kept for inspection",
		})
		expect(text).toContain(
			"root flaky MISSING ok ok ok ok  (200 - 200 200 200 200 s)",
		)
		expect(text).toContain("no verdict: root-2")
		expect(text).toContain("flaky 1\n  tests/x.test.ts > s > t")
		expect(text).toContain("(kept for inspection)")
		expect(text.split("\n")[0]).toMatch(/^remote-check INFRA /)
		expect(text).not.toContain("recheck")
	})
})

describe("durations and sweep", () => {
	it("keeps files of a second or more", () => {
		expect(
			durationTable([{ "b.ts": 0.4, "a.ts": 12.6 }, { "c.ts": 1 }]),
		).toEqual({ "a.ts": 13, "c.ts": 1 })
		// One noisy run moves a listed file only halfway.
		expect(
			durationTable([{ "a.ts": 100, "n.ts": 3 }], { "a.ts": 50, "gone.ts": 9 }),
		).toEqual({ "a.ts": 75, "n.ts": 3 })
	})

	it("sweeps only ci/<12 hex> branches and runs older than the limit", () => {
		const hour = 3600_000
		const now = 10 * hour
		const iso = (t: number) => new Date(t).toISOString()
		const calls: string[] = []
		const git = (args: string[]) => {
			calls.push(`git ${args.join(" ")}`)
			if (args[0] === "ls-remote")
				return [
					"a1\trefs/heads/ci/0123456789ab",
					"a2\trefs/heads/ci/aaaaaaaaaaaa",
					"a3\trefs/heads/ci/sharding-trial",
					"a4\trefs/heads/ci/bbbbbbbbbbbb",
					"a5\trefs/heads/ci/cccccccccccc",
				].join("\n")
			// a4's commit is unknown locally; a5's is three hours old.
			if (args[0] === "log" && args.includes("a4"))
				throw new Error("bad object")
			if (args[0] === "log" && args.includes("a5"))
				return `${(now - 3 * hour) / 1000}\n`
			return ""
		}
		const gh = (args: string[]) => {
			calls.push(`gh ${args.join(" ")}`)
			return ""
		}
		const r = sweep({
			git,
			gh,
			remote: "github",
			runs: [
				{
					databaseId: 1,
					headBranch: "ci/0123456789ab",
					createdAt: iso(now - 2 * hour),
				},
				{
					databaseId: 2,
					headBranch: "ci/aaaaaaaaaaaa",
					createdAt: iso(now - 59 * 60_000),
				},
				{ databaseId: 3, headBranch: "main", createdAt: iso(0) },
			],
			now,
			maxAgeMs: hour,
		})
		expect(r).toEqual({
			branches: ["ci/0123456789ab", "ci/cccccccccccc"],
			runs: [1],
		})
		expect(calls.filter(c => / --delete |run delete/.test(c))).toEqual([
			"git push -q github --delete ci/0123456789ab",
			"git push -q github --delete ci/cccccccccccc",
			"gh run delete 1",
		])
	})
})

describe("git inputs", () => {
	it("reads the repository from https and ssh remotes", () => {
		expect(repoSlug("https://github.com/o/r.git\n")).toBe("o/r")
		expect(repoSlug(`git${"@"}github.com:o/r.git`)).toBe("o/r")
		expect(repoSlug(`git${"@"}github.com-alias:o/r.git\n`)).toBe("o/r")
		expect(repoSlug(`ssh://git${"@"}github.com/o/r`)).toBe("o/r")
		expect(repoSlug("https://gitlab.com/o/r")).toBe("")
	})

	it("collects changes, binaries, sizes and added lines from git", () => {
		const calls: string[][] = []
		const git = (args: string[]) => {
			calls.push(args)
			if (args.includes("--numstat"))
				return "1\t0\tsrc/a.ts\0-\t-\tdocs/x.bin\0"
			if (args.includes("--name-status")) return "M\0src/a.ts\0A\0docs/x.bin\0"
			if (args[0] === "ls-tree")
				return "100644 blob aa      12\tsrc/a.ts\u0000100644 blob bb 2000000\tdocs/x.bin\0"
			return "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +2 @@\n+x\n"
		}
		const r = collectChanges(git, "base", "tree")
		expect(r.changes).toEqual([
			{ path: "src/a.ts", status: "M", binary: false, size: 12 },
			{ path: "docs/x.bin", status: "A", binary: true, size: 2000000 },
		])
		expect([...r.added]).toEqual([["src/a.ts", [{ line: 2, text: "x" }]]])
		expect(
			calls
				.filter(c => c.includes("diff"))
				.every(c => c.includes("--no-renames")),
		).toBe(true)
	})
})

describe("untracked files and client text", () => {
	it("refuses big untracked files and files outside the source directories", () => {
		const inBase = (p: string) => p === "tsconfig.json"
		const hits = untrackedRefusals(
			[
				{ path: "tests/new.test.ts", size: 10 },
				{ path: "tsconfig.json", size: 10 },
				{ path: "notes.txt", size: 10 },
				{ path: "tmp/out.json", size: 10 },
				{ path: "fixtures/big.bin", size: 2 * 1024 * 1024 },
			],
			inBase,
		)
		expect(hits.map(h => `${h.file}: ${h.label}`)).toEqual([
			"notes.txt: untracked file outside the source directories",
			"tmp/out.json: untracked file outside the source directories",
			"fixtures/big.bin: untracked file over 1 MB",
		])
		expect(untrackedLine(["a", "b"])).toBe("untracked 2: a, b")
		expect(untrackedLine(["a", "b", "c", "d", "e"])).toBe(
			"untracked 5: a, b, c (+2)",
		)
	})

	it("marks native changes in the fixed commit message and caps refusals", () => {
		expect(commitMessage(["src/a.ts"])).toBe("ci: remote check")
		for (const p of [
			"native/x/src/lib.rs",
			"src/core/spectrum/frame-wasm.ts",
			"src/core/scanner/channel/wideband-nfm-wasm.ts",
			"src/core/scanner/channel/wideband-analog-recorder.ts",
			"src/core/scanner/channel/recorder-decisions.ts",
			"tests/unit/core/scanner/wideband-analog-recorder.test.ts",
			"Makefile",
			"pnpm-lock.yaml",
			".github/workflows/ci-remote.yml",
			"scripts/build-file.mjs",
			"scripts/kernel-digest.mjs",
		])
			expect(commitMessage(["src/a.ts", p])).toBe("ci: remote check [native]")
		expect(commitMessage(["src/core/scanner/channel/channel-tap.ts"])).toBe(
			"ci: remote check",
		)
		const hits = Array.from({ length: 40 }, (_, i) => ({
			file: `f${i}`,
			line: i,
			label: "x",
		}))
		const lines = refusal("why", hits).split("\n")
		expect(lines).toHaveLength(SUMMARY_LINES - 1)
		expect(lines[0]).toBe("remote-check REFUSED  why, nothing pushed")
		expect(lines.at(-1)).toBe("  +13 more")
	})
})

describe("client with fake git and gh", () => {
	const TREE = "abcdef0123456789abcdef0123456789abcdef01"
	const BRANCH = "ci/abcdef012345"
	const MB = "1111111111111111111111111111111111111111"
	const JOBS = ["static", ...[1, 2, 3, 4, 5, 6].map(i => `root (${i})`)]
	let root = ""
	let calls: string[] = []

	type Run = { id: number; status: string; attempt: number; missing: string[] }
	interface World {
		onBase: boolean
		runs: Run[]
		nextId: number
		pushes: number
		rerunFails: boolean
		// The status a newly pushed run reports to `run view` until the clock passes `doneAt`.
		doneAt: number
		clock: number
		missingFirst: string[]
		listLag: boolean
		// A diff of one added line in src/a.ts, and the lines `git grep` finds in the base.
		patch: string
		baseLines: string[]
		// Runs `run view` no longer finds (another call for the tree deleted them).
		gone: Set<number>
	}
	let w: World

	beforeEach(() => {
		root = fs.mkdtempSync(join(tmpdir(), "rc-test-"))
		calls = []
		w = {
			onBase: true,
			runs: [],
			nextId: 7,
			pushes: 0,
			rerunFails: false,
			doneAt: 0,
			clock: 1_000_000,
			missingFirst: [],
			listLag: false,
			patch: "",
			baseLines: [],
			gone: new Set(),
		}
		verdictFor = verdict
	})
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true })
	})

	let verdictFor = (name: string): object => verdict(name)
	const verdict = (name: string) =>
		name === "static"
			? { ok: true, seconds: 100, steps: { lint: 0 }, failed: [], flaky: [] }
			: {
					ok: true,
					seconds: 200,
					testSeconds: 150,
					steps: { install: 0, "root-tests": 0 },
					failed: [],
					flaky: [],
					durations: {},
				}

	const git = (args: string[]) => {
		calls.push(`git ${args.join(" ")}`)
		const [cmd = "", a1 = ""] = args
		if (cmd === "rev-parse" && a1 === "--show-toplevel") return `${root}\n`
		if (cmd === "rev-parse") return join(root, "no-index")
		if (cmd === "remote") return `git${"@"}github.com-alias:o/r.git\n`
		if (cmd === "write-tree") return `${TREE}\n`
		if (cmd === "merge-base" && a1 === "--is-ancestor") {
			if (!w.onBase) throw new Error("not an ancestor")
			return ""
		}
		if (cmd === "merge-base") return `${MB}\n`
		if (cmd === "commit-tree") return "c0ffee\n"
		if (cmd === "grep") {
			const t = args[args.indexOf("-e") + 1] ?? ""
			const lines = w.baseLines.filter(l => l.includes(t))
			if (!lines.length) throw new Error("no match")
			return `${lines.join("\n")}\n`
		}
		if (args.includes("diff") && w.patch) {
			if (args.includes("--name-status")) return "M\0src/a.ts\0"
			if (args.includes("-U0"))
				return `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +2 @@\n+${w.patch}\n`
		}
		if (cmd === "push" && !args.includes("--delete")) {
			w.pushes++
			w.runs.push({
				id: w.nextId++,
				status: "in_progress",
				attempt: 1,
				missing: [...w.missingFirst],
			})
		}
		return ""
	}

	const gh = (args: string[]) => {
		calls.push(`gh ${args.join(" ")}`)
		const [, verb = "", id = ""] = args
		const run = w.runs.find(r => String(r.id) === id)
		if (verb === "list") {
			const branch = args.includes("--branch")
			return JSON.stringify(
				(branch && w.listLag ? [] : w.runs)
					.slice()
					.reverse()
					.map(r => ({
						databaseId: r.id,
						headBranch: BRANCH,
						createdAt: new Date(w.clock).toISOString(),
						status: r.status,
						workflowName: "CI remote",
					})),
			)
		}
		if (!run || w.gone.has(run.id)) throw new Error(`run ${id} not found`)
		if (verb === "view") {
			if (w.clock >= w.doneAt) run.status = "completed"
			return JSON.stringify({
				status: run.status,
				attempt: run.attempt,
				url: `https://github.com/o/r/actions/runs/${run.id}`,
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:04:00Z",
				jobs: JOBS.map((name, i) => ({
					name,
					databaseId: 100 + i,
					conclusion: "success",
				})),
			})
		}
		if (verb === "download") {
			const dir = args[args.indexOf("-D") + 1] ?? ""
			for (const name of JOBS) {
				if (run.missing.includes(name)) continue
				const art = join(dir, artifactName(name))
				fs.mkdirSync(art, { recursive: true })
				fs.writeFileSync(
					join(art, "verdict.json"),
					JSON.stringify(verdictFor(name)),
				)
			}
			return ""
		}
		if (verb === "rerun") {
			if (w.rerunFails) throw new Error("cannot rerun")
			run.attempt++
			run.status = "in_progress"
			return ""
		}
		if (verb === "delete") {
			w.runs = w.runs.filter(r => r !== run)
			return ""
		}
		return ""
	}

	const deps = (): Deps => ({
		git,
		gh,
		sleep: async ms => {
			w.clock += ms
		},
		now: () => w.clock,
		home: root,
	})
	const network = () =>
		calls.filter(c => /^gh |^git (fetch|push|ls-remote)/.test(c))

	it("reads the slug from an SSH host alias and passes a green tree", async () => {
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(0)
		expect(r.text.split("\n")[0]).toMatch(
			/^remote-check PASS {2}tree abcdef012345 {2}base 11111111/,
		)
		expect(r.text).toContain(
			"denylist missing: ~/.config/wavekit-remote/denylist",
		)
		const ghCalls = calls.filter(c => c.startsWith("gh "))
		expect(ghCalls.every(c => c.endsWith("-R o/r"))).toBe(true)
		expect(calls).toContain(
			`git commit-tree --no-gpg-sign ${TREE} -p ${MB} -m ci: remote check`,
		)
		expect(calls).toContain(`git push -q github --delete ${BRANCH}`)
		expect(w.runs).toEqual([])
		// The sweep runs before the push and again at the end.
		const sweeps = calls
			.map((c, i) =>
				c.startsWith("git ls-remote github refs/heads/ci/*") ? i : -1,
			)
			.filter(i => i >= 0)
		const push = calls.findIndex(c => c.startsWith("git push -q --force"))
		expect(sweeps).toHaveLength(2)
		expect(sweeps[0]).toBeLessThan(push)
		expect(sweeps[1]).toBeGreaterThan(push)
		// Even shard times leave no refreshed table; the summary has no note for it.
		expect(fs.existsSync(join(root, ".remote-check/durations.json"))).toBe(
			false,
		)
		expect(r.text.split("\n")).toHaveLength(4)
	})

	it("refreshes the table only when a shard's test time strays over 20 % from the mean", async () => {
		verdictFor = name =>
			name === "root (1)"
				? { ...verdict(name), testSeconds: 200 }
				: verdict(name)
		expect((await remoteCheck(deps(), [])).code).toBe(0)
		expect(fs.existsSync(join(root, ".remote-check/durations.json"))).toBe(true)
	})

	it("logs every call, a cached one too, to the private usage ledger", async () => {
		await remoteCheck(deps(), [])
		w.clock += 5000
		await remoteCheck(deps(), [])
		const rows = fs
			.readFileSync(join(root, ".cache/wavekit-remote/calls.tsv"), "utf8")
			.trim()
			.split("\n")
			.map(l => l.split("\t"))
		expect(rows.map(r => r.slice(1))).toEqual([
			[root, "abcdef012345", "0", expect.any(String), "0"],
			[root, "abcdef012345", "0", "0", "1"],
		])
		expect(rows[0]?.[0]).toMatch(/^\d{4}-\d\d-\d\dT/)
	})

	it("refuses a private address the base holds only inside a longer one", async () => {
		w.patch = `const host = "${dot(10, 0, 0, 1)}"`
		w.baseLines = [`host: ${dot(10, 0, 0, 12)}`]
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(3)
		expect(r.text).toBe(
			"remote-check REFUSED  tree abcdef012345: hygiene, nothing pushed\n  src/a.ts:2 private address",
		)
		expect(w.pushes).toBe(0)
		expect(calls.filter(c => c.startsWith("gh "))).toEqual([])
		// The same address whole in the base is published already.
		w.baseLines = [`host: ${dot(10, 0, 0, 1)}`]
		expect((await remoteCheck(deps(), [])).code).toBe(0)
	})

	it("refuses a base whose merge base is not on GitHub, without pushing", async () => {
		w.onBase = false
		const r = await remoteCheck(deps(), ["HEAD~1"])
		expect(r.code).toBe(3)
		expect(r.text).toBe(
			"remote-check REFUSED  merge base 11111111 of HEAD~1 is not on github/main, nothing pushed",
		)
		expect(w.pushes).toBe(0)
		expect(calls.filter(c => c.startsWith("gh "))).toEqual([])
	})

	it("answers a second call for the same tree from the cache without the network", async () => {
		const first = await remoteCheck(deps(), [])
		calls = []
		const second = await remoteCheck(deps(), [])
		expect(second).toEqual(first)
		expect(network()).toEqual([])
		expect(calls.some(c => c.startsWith("git fetch"))).toBe(false)
		// The stored result is for github/main only: another base is checked again.
		w.onBase = false
		const other = await remoteCheck(deps(), ["HEAD~1"])
		expect(other.code).toBe(3)
	})

	it("stores a FAIL too and says how to force a recheck", async () => {
		const failing = (name: string) =>
			name === "root (2)"
				? {
						...verdict(name),
						ok: false,
						steps: { install: 0, "root-tests": 1 },
						failed: [{ file: "tests/x.test.ts", test: "t", message: "no" }],
					}
				: verdict(name)
		verdictFor = failing
		const first = await remoteCheck(deps(), [])
		expect(first.code).toBe(1)
		expect(first.text.split("\n").at(-1)).toBe(
			"recheck: rm -r .remote-check/abcdef012345",
		)
		calls = []
		expect(await remoteCheck(deps(), [])).toEqual(first)
		expect(network()).toEqual([])
	})

	it("keeps an INFRA run, then deletes it and pushes a new run on the next call", async () => {
		w.missingFirst = ["root (3)"]
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(2)
		expect(r.text).toContain("no verdict: root-3")
		expect(r.text).toMatch(/run https:.*\/7 {2}\(kept\)/)
		expect(w.runs.map(x => [x.id, x.status, x.attempt])).toEqual([
			[7, "completed", 2],
		])
		expect(
			fs.existsSync(join(root, ".remote-check/abcdef012345/state.json")),
		).toBe(false)
		w.missingFirst = []
		calls = []
		const again = await remoteCheck(deps(), [])
		expect(again.code).toBe(0)
		expect(w.pushes).toBe(2)
		const del = calls.indexOf("gh run delete 7 -R o/r")
		const push = calls.findIndex(c => c.startsWith("git push -q --force"))
		expect(del).toBeGreaterThanOrEqual(0)
		expect(del).toBeLessThan(push)
	})

	it("keeps the run of a failed non-test step and deletes a test failure's", async () => {
		verdictFor = name =>
			name === "static"
				? { ...verdict(name), ok: false, steps: { lint: 1 } }
				: verdict(name)
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(1)
		expect(r.text).toContain("actions/runs/7  (kept)")
		expect(w.runs.map(x => x.id)).toEqual([7])
	})

	it("is INFRA at once when gh refuses the rerun", async () => {
		w.missingFirst = ["static"]
		w.rerunFails = true
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(2)
		expect(r.text).toBe(
			"remote-check INFRA  tree abcdef012345: rerun refused, run https://github.com/o/r/actions/runs/7 kept",
		)
		expect(calls.filter(c => c.startsWith("gh run view"))).toHaveLength(1)
	})

	it("returns 4 while the run is live and attaches through state.json on the next call", async () => {
		w.doneAt = Number.POSITIVE_INFINITY
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(4)
		expect(r.text).toMatch(
			/^remote-check RUNNING {2}tree abcdef012345: run .*\/7 still running, call again$/,
		)
		const state = JSON.parse(
			fs.readFileSync(
				join(root, ".remote-check/abcdef012345/state.json"),
				"utf8",
			),
		)
		expect(state).toEqual({ runId: "7" })
		w.doneAt = 0
		w.listLag = true
		calls = []
		const again = await remoteCheck(deps(), [])
		expect(again.code).toBe(0)
		expect(w.pushes).toBe(1)
		expect(calls).toContain(
			"gh run view 7 --json status,attempt,url,createdAt,updatedAt,jobs -R o/r",
		)
	})

	it("drops the rerun mark with a stored run that vanished, so the new run is read", async () => {
		const cache = join(root, ".remote-check/abcdef012345")
		fs.mkdirSync(cache, { recursive: true })
		fs.writeFileSync(
			join(cache, "state.json"),
			JSON.stringify({ runId: "99", rerunAttempt: 1 }),
		)
		const r = await remoteCheck(deps(), [])
		// With the stale mark, attempt 1 of the new run would never count as done (code 4).
		expect(r.code).toBe(0)
		expect(w.pushes).toBe(1)
		expect(calls).toContain(
			"gh run view 7 --json status,attempt,url,createdAt,updatedAt,jobs -R o/r",
		)
	})

	it("asks to call again, not INFRA, when the attached run vanishes without a stored result", async () => {
		w.doneAt = Number.POSITIVE_INFINITY
		const d: Deps = {
			...deps(),
			sleep: async ms => {
				w.clock += ms
				for (const r of w.runs) w.gone.add(r.id)
			},
		}
		const r = await remoteCheck(d, [])
		expect(r.code).toBe(4)
		expect(r.text).toBe(
			"remote-check RUNNING  tree abcdef012345: run 7 is gone or unreadable, call again",
		)
	})

	it("prints the stored result when the run vanishes while it waits", async () => {
		w.doneAt = Number.POSITIVE_INFINITY
		const cache = join(root, ".remote-check/abcdef012345")
		const d: Deps = {
			...deps(),
			sleep: async ms => {
				w.clock += ms
				if (w.runs[0] && !w.gone.has(w.runs[0].id) && w.clock > 1_100_000) {
					w.gone.add(w.runs[0].id)
					fs.writeFileSync(join(cache, "code"), "1\tgithub/main")
					fs.writeFileSync(
						join(cache, "summary.txt"),
						"remote-check FAIL  other\n",
					)
				}
			},
		}
		const r = await remoteCheck(d, [])
		expect(r).toEqual({ code: 1, text: "remote-check FAIL  other" })
	})
})

/**
 * The remote check: its helpers (scripts/remote-check-lib.mjs: the fail-closed hygiene scan, shard
 * packing, vitest report parsing, flaky classification, exit codes, summary and sweep) and the
 * client (scripts/remote-check.mjs) driven with fake git and gh.
 *
 * Sensitive-looking inputs are assembled at run time, so this file itself passes the scan.
 */
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { remoteCheck, type Deps } from "../../../scripts/remote-check.mjs"
import {
	addedLines,
	artifactName,
	checkKey,
	CHECK_STEPS,
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
	setupFailure,
	SETUP_STEPS,
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
	file = "src/a.ts",
) {
	return scanHygiene({
		changes: [{ path: file, status: "M", binary: false, size: 10 }],
		added: new Map([[file, [{ line: 7, text }]]]),
		denylist,
	})
}

describe("hygiene scan", () => {
	const c = ":"
	const local = (...p: string[]) => dot(...p, "local")
	const key = `-----BEGIN ${"OPENSSH"} PRIVATE KEY-----`
	const token = `${"ghp"}_${"a1".repeat(18)}`
	const pat = `${"github"}_pat_${"B2".repeat(15)}`
	const ip = "private address"
	const lan = "LAN host name"
	const home = "home directory path"
	const mail = "email address"

	// Prose (Markdown, YAML, JSON, text): every rule applies to the whole line.
	it.each<[string, string[]]>([
		[dot(10, 1, 2, 3), [ip]],
		[dot(172, 20, 0, 9), [ip]],
		[`host ${dot(192, 168, 0, 5)}${c}80`, [ip]],
		[dot(169, 254, 0, 1), [ip]],
		[dot(100, 64, 3, 4), [ip]],
		[dot(127, 0, 0, 1), []],
		[dot(8, 8, 8, 8), []],
		[dot(172, 32, 0, 1), []],
		[dot(10, 300, 0, 1), []],
		["version 1.2.3", []],
		[`ssh ${local("receiver")}`, [lan]],
		[`set ${dot("this", "local")} first`, [lan]],
		[`http${c}//${local("receiver")}${c}8080/api`, [lan]],
		[`ssh${c}//${dot("box", "lan")}/x`, [lan]],
		[`ws${c}//${at("user", local("a", "b"))}/stream`, [lan, mail]],
		[`see https${c}//${local("my", "box")}`, [lan]],
		[`open http${c}//${local("raspberrypi")}.`, [lan]],
		[`ssh ${local("raspberrypi")}.`, [lan]],
		[`mount ${dot("nas", "home", "lan")} now`, [lan]],
		[`smb ${"/"}/${local("nas")}/share`, [lan]],
		[`cp ${dot("config", "local", "yaml")} .${dot("env", "local")}`, []],
		[`cp .${dot("env", "local")} ${dot("settings", "local", "json")}`, []],
		[`see ${dot("foo", "local", "example", "com")}`, []],
		["run /usr/local/bin/node", []],
		[`file${c}///usr/local/share`, []],
		[`see https${c}//${dot("example", "com")}/local`, []],
		[`see /${"Users"}/someone/x`, [home]],
		[`see /${"home"}/someone/x`, [home]],
		[at("someone", dot("mail", "com")), [mail]],
		[at("user", dot("example", "invalid")), []],
		[at("user", dot("example", "com")), []],
		[at("logo", dot("2x", "png")), []],
		['import x from "@wavekit/shared"', []],
		[`t ${key}`, ["private key"]],
		[`t ${token}`, ["GitHub token"]],
		[`t ${pat}`, ["GitHub token"]],
		[`${"ghp"}_short`, []],
	])("prose %j -> %j", (text, labels) => {
		expect(scanText(text, none, "docs/x.md").map(h => h.label)).toEqual(labels)
	})

	// Source code: a bare LAN name counts only inside a string or a comment; a URL host always.
	it.each<[string, string[]]>([
		[`${dot("this", "local")} = 1`, []],
		[`${dot("opts", "lan")} = 1`, []],
		[`const y = ${dot("x", "local")}?.y`, []],
		[`if (${dot("prev", "local")} !== "settled") return`, []],
		[`const host = "${local("receiver")}"`, [lan]],
		[`const host = '${local("receiver")}'`, [lan]],
		[`// ssh ${local("nas")}`, [lan]],
		[`x = 1 /* ${local("nas")} */`, [lan]],
		[` * see ${local("nas")} for the box`, [lan]],
		[`fetch(base + http${c}//${local("box")}/x)`, [lan]],
		[`const ip = "${dot(10, 0, 0, 1)}"`, [ip]],
		["const x = 1", []],
	])("code %j -> %j", (text, labels) => {
		expect(scanText(text).map(h => h.label)).toEqual(labels)
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

	it("flags every added or changed binary, fixtures/ included, and big files, for every status but D", () => {
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
		const bin = "binary file added or changed"
		expect(hits.map(h => `${h.file}: ${h.label}`)).toEqual([
			`docs/capture.bin: ${bin}`,
			"tests/big.json: file over 1 MB",
			`fixtures/iq/small.bin: ${bin}`,
			`fixtures/iq/huge.bin: ${bin}`,
			"fixtures/iq/huge.bin: file over 1 MB",
			`docs/old.png: ${bin}`,
			`src/now-binary: ${bin}`,
			"src/grown.ts: file over 1 MB",
		])
		// A text file under fixtures/ is content-scanned like any other.
		expect(
			scanText(`host ${dot(10, 1, 2, 3)}`, none, "fixtures/iq/notes.txt").map(
				h => h.label,
			),
		).toEqual(["private address"])
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
		const inBase = (t: string) =>
			t === host || t === "fixed-word" || t === token
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
		expect(scan(`t ${token}`)).toEqual(["GitHub token"])
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

	it("fails closed when the deny-list is missing, unreadable, invalid or empty", () => {
		const file = "~/.config/wavekit-remote/denylist"
		const unreadable = parseDenylist(() => {
			throw new Error("EACCES")
		})
		expect(unreadable).toEqual({ error: `deny-list unreadable: ${file}` })
		expect(scanText("clean text", unreadable)).toEqual([
			{ file: "(deny-list)", line: 0, label: `deny-list unreadable: ${file}` },
		])
		const invalid = parseDenylist(() => "ok\n(unclosed\n")
		expect(invalid).toEqual({ error: `deny-list invalid line 2: ${file}` })
		expect(scanText("clean text", invalid)).toHaveLength(1)
		expect(parseDenylist(() => undefined)).toEqual({
			error: `deny-list missing: create ${file} (one regex per line; see CONTRIBUTING)`,
		})
		for (const text of ["", "# only a comment\n\n  \n"])
			expect(parseDenylist(() => text)).toEqual({
				error: `deny-list empty: add at least one regex to ${file} (see CONTRIBUTING)`,
			})
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

	it("counts an infra verdict as no verdict, never as a failure", () => {
		const infra = { ok: false, infra: true }
		expect(exitCode({ verdicts: v(ok, infra), expected })).toBe(2)
		expect(exitCode({ verdicts: v(infra, ok), expected })).toBe(2)
		expect(exitCode({ verdicts: v(infra, { ok: false }), expected })).toBe(1)
	})

	it("names the first failed setup step, a missing one too, and ignores check steps", () => {
		expect(setupFailure({ pip: 0, corepack: 0, install: 0, lint: 1 })).toBe(
			undefined,
		)
		expect(setupFailure({ pip: 0, install: 1, "build-shared": 1 })).toBe(
			undefined,
		)
		expect(setupFailure({ pip: 1, install: -1 })).toBe("pip")
		expect(setupFailure({ corepack: -1, install: -1 })).toBe("corepack")
		expect(setupFailure({ rust: 124, channelizer: -1 })).toBe("rust")
		expect(setupFailure({ "root-tests": 1 })).toBe(undefined)
	})

	it("keeps only runner tool steps in the setup list: the install and the shared build are checks", () => {
		expect(SETUP_STEPS).toEqual(["pip", "corepack", "rust"])
		expect(CHECK_STEPS).toEqual(
			expect.arrayContaining(["install", "build-shared"]),
		)
	})

	it("puts every step of the workflow in exactly one of the setup and check lists", () => {
		const yml = fs.readFileSync(
			new URL("../../../.github/workflows/ci-remote.yml", import.meta.url),
			"utf8",
		)
		const named = new Set(
			[...yml.matchAll(/step\.sh" ([\w-]+) /g)].map(m => m[1] ?? ""),
		)
		for (const m of yml.matchAll(
			/remote-check-job\.mjs (?:verdict|root \$\{\{ matrix\.shard \}\}) (.+)/g,
		))
			for (const n of (m[1] ?? "").split(" ")) named.add(n)
		named.add("root-tests")
		expect(named.size).toBeGreaterThan(10)
		for (const n of named)
			expect([n, SETUP_STEPS.includes(n) !== CHECK_STEPS.includes(n)]).toEqual([
				n,
				true,
			])
		// The check runs only on pushed ci/** branches: no manual trigger.
		expect(yml).not.toMatch(/workflow_dispatch/)
	})

	it("keys a check by its tree and merge base", () => {
		const tree = "a".repeat(40)
		const k = checkKey(tree, "b".repeat(40))
		expect(k).toBe(
			createHash("sha1")
				.update(`${tree}${"b".repeat(40)}`)
				.digest("hex")
				.slice(0, 12),
		)
		expect(k).toMatch(/^[0-9a-f]{12}$/)
		expect(checkKey(tree, "c".repeat(40))).not.toBe(k)
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

	it("keeps the last 8 trimmed lines of a failed step's output", () => {
		const out = [
			...Array.from({ length: 20 }, (_, i) => `\x1b[31mline ${i}\x1b[0m`),
			"",
			"    at foo (x.js:1:1)",
			"progress 10%\rprogress 100%",
			`${"x".repeat(250)}\r`,
		].join("\n")
		const lines = tailLines(out)
		expect(lines).toHaveLength(8)
		expect(lines[0]).toBe("line 14")
		expect(lines.at(-2)).toBe("progress 100%")
		expect(lines.at(-1)).toBe(`${"x".repeat(199)}…`)
		expect(tailLines("")).toEqual([])
	})

	it("prints the last 8 lines of the first two failed steps' output under their lines", () => {
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
				setup(tail(4, "npm")),
				...Array.from({ length: 3 }, () => shard()),
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
		// The shard's tail keeps its last 8; shard 2's identical tail is not repeated and shard 3's
		// would be a third step.
		expect(lines.slice(at + 1, at + 9)).toEqual(
			tail(15, "pnpm")
				.slice(-8)
				.map(l => `    ${l}`),
		)
		expect(lines.slice(at + 9, at + 11)).toEqual([
			"  root 2 > step install",
			"  root 3 > step install",
		])
		expect(lines.filter(l => /^ {4}(lint|pnpm|npm) /.test(l))).toHaveLength(11)
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

	it("prints one line per flaky file with its first replay hint and a replay note", () => {
		const seed =
			'Property failed after 3 tests | { seed: -71210566, path: "2" } | Counterexample: [1]'
		const text = formatSummary({
			...base,
			code: 0,
			root: [
				shard({
					flaky: [
						{ file: "tests/p.test.ts", test: "p1", message: "timeout" },
						{ file: "tests/p.test.ts", test: "p2", message: seed },
						{ file: "tests/p.test.ts", test: "p3", message: "x" },
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
			"  tests/p.test.ts > p1  +2 tests  (seed -71210566)",
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

	it("names infra jobs with their setup step and recheck by key", () => {
		const text = formatSummary({
			...base,
			code: 2,
			static: undefined,
			root: [shard(), undefined, ...Array.from({ length: 4 }, () => shard())],
			infra: [
				{ name: "static", step: "pip" },
				{ name: "root-2", step: "install" },
			],
		})
		expect(text.split("\n").slice(1, 4)).toEqual([
			"static INFRA",
			"root ok INFRA ok ok ok ok  (200 - 200 200 200 200 s)",
			"infra: static pip, root-2 install",
		])
		expect(
			formatSummary({
				...base,
				code: 1,
				key: "0123456789ab",
				root: [shard({ ok: false })],
			})
				.split("\n")
				.at(-1),
		).toBe("recheck: rm -r .remote-check/0123456789ab")
	})
})

describe("durations and sweep", () => {
	it("merges the shards' seconds and keeps files of 5 s or more", () => {
		expect(
			durationTable([{ "b.ts": 4.4, "a.ts": 12.6 }, { "c.ts": 5 }]),
		).toEqual({ "a.ts": 13, "c.ts": 5 })
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
		const run = (
			databaseId: number,
			headBranch: string,
			updated: number,
			status = "completed",
		) => ({ databaseId, headBranch, status, updatedAt: iso(updated) })
		const r = sweep({
			git,
			gh,
			remote: "github",
			runs: [
				run(1, "ci/0123456789ab", now - 2 * hour),
				run(2, "ci/aaaaaaaaaaaa", now - 59 * 60_000),
				run(3, "main", 0),
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

	it("ages runs by their last update and never sweeps a run that is not completed, nor its branch", () => {
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
					"a3\trefs/heads/ci/bbbbbbbbbbbb",
				].join("\n")
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
				// Created hours ago, rerun since: in progress, then completed minutes ago.
				{
					databaseId: 1,
					headBranch: "ci/0123456789ab",
					status: "in_progress",
					updatedAt: iso(now - 3 * hour),
				},
				{
					databaseId: 4,
					headBranch: "ci/0123456789ab",
					status: "completed",
					updatedAt: iso(now - 5 * hour),
				},
				{
					databaseId: 2,
					headBranch: "ci/aaaaaaaaaaaa",
					status: "completed",
					updatedAt: iso(now - 10 * 60_000),
				},
				{
					databaseId: 3,
					headBranch: "ci/bbbbbbbbbbbb",
					status: "queued",
					updatedAt: iso(now - 4 * hour),
				},
			],
			now,
			maxAgeMs: hour,
		})
		expect(r).toEqual({ branches: [], runs: [4] })
		expect(calls.filter(c => / --delete |run delete/.test(c))).toEqual([
			"gh run delete 4",
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
			if (args.includes("--name-status"))
				return "M\0src/a.ts\0A\0docs/x.bin\0A\0docs/big.txt\0D\0old.ts\0"
			if (args[0] === "ls-tree")
				return [
					"100644 blob aa      12\tsrc/a.ts",
					"100644 blob bb     20\tdocs/x.bin",
					"100644 blob cc 2000000\tdocs/big.txt",
				].join("\0")
			if (args[0] === "cat-file") return args[2] === "bb" ? "PNG\0\x01" : "x\n"
			return "diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +2 @@\n+x\n"
		}
		const r = collectChanges(git, "base", "tree")
		expect(r.changes).toEqual([
			{ path: "src/a.ts", status: "M", binary: false, size: 12 },
			{ path: "docs/x.bin", status: "A", binary: true, size: 20 },
			{ path: "docs/big.txt", status: "A", binary: false, size: 2000000 },
			{ path: "old.ts", status: "D", binary: false, size: 0 },
		])
		expect([...r.added]).toEqual([["src/a.ts", [{ line: 2, text: "x" }]]])
		// Only the small text file is read whole by the line diff, as text.
		expect(calls.filter(c => c[0] === "cat-file").map(c => c[2])).toEqual([
			"aa",
			"bb",
		])
		const lines = calls.find(c => c.includes("-U0")) ?? []
		expect(lines.includes("--text")).toBe(true)
		expect(lines.slice(lines.indexOf("--") + 1)).toEqual([":(literal)src/a.ts"])
		expect(
			calls
				.filter(c => c.includes("diff"))
				.every(c => c.includes("--no-renames")),
		).toBe(true)
	})
})

describe("binaries whatever .gitattributes says", () => {
	let dir = ""
	beforeEach(() => {
		dir = fs.mkdtempSync(join(tmpdir(), "rc-attr-"))
	})
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true })
	})

	it("finds a binary by its NUL bytes and reads text lines despite diff and -diff attributes", () => {
		const g = (...args: string[]) =>
			execFileSync(
				"git",
				[
					"-c",
					"user.name=t",
					"-c",
					`user.email=${at("t", "example.invalid")}`,
					"-c",
					"commit.gpgsign=false",
					...args,
				],
				{
					cwd: dir,
					encoding: "utf8",
					env: {
						...process.env,
						GIT_CONFIG_GLOBAL: "/dev/null",
						GIT_CONFIG_NOSYSTEM: "1",
					},
				},
			)
		g("init", "-q")
		fs.writeFileSync(join(dir, "keep.txt"), "base\n")
		g("add", "-A")
		g("commit", "-q", "-m", "base")
		const base = g("rev-parse", "HEAD").trim()
		// The tree's own attributes call the image text and the source binary.
		fs.writeFileSync(join(dir, ".gitattributes"), "*.png diff\n*.ts -diff\n")
		fs.writeFileSync(
			join(dir, "shot.png"),
			Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0, 0, 0, 0x0d, 0x2b]),
		)
		fs.writeFileSync(join(dir, "a.ts"), "export const x = 1\n")
		g("add", "-A")
		const tree = g("write-tree").trim()
		const r = collectChanges(args => g(...args), base, tree)
		expect(r.changes.map(c => [c.path, c.binary])).toEqual([
			[".gitattributes", false],
			["a.ts", false],
			["shot.png", true],
		])
		expect(r.added.get("a.ts")).toEqual([
			{ line: 1, text: "export const x = 1" },
		])
		expect(r.added.has("shot.png")).toBe(false)
		expect(
			scanHygiene({ ...r, denylist: none }).filter(h => h.file === "shot.png"),
		).toEqual([
			{ file: "shot.png", line: 0, label: "binary file added or changed" },
		])
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
	const MB = "1111111111111111111111111111111111111111"
	const KEY = checkKey(TREE, MB)
	const BRANCH = `ci/${KEY}`
	const JOBS = ["static", ...[1, 2, 3, 4, 5, 6].map(i => `root (${i})`)]
	const VIEW =
		"gh run view 7 --json status,attempt,url,createdAt,updatedAt,jobs -R o/r"
	let root = ""
	let calls: string[] = []

	type Run = {
		id: number
		status: string
		attempt: number
		missing: string[]
		branch: string
		sha: string
		createdAt: number
	}
	interface World {
		onBase: boolean
		mb: string
		runs: Run[]
		nextId: number
		pushes: number
		commits: number
		rerunFails: boolean
		// A rerun job writes its verdict this time.
		rerunHeals: boolean
		// The status a newly pushed run reports to `run view` until the clock passes `doneAt`.
		doneAt: number
		clock: number
		missingFirst: string[]
		listLag: boolean
		// A diff of one added line in src/a.ts, and the lines `git grep` finds in the base.
		patch: string
		baseLines: string[]
		// An untracked binary file the diff adds.
		binary: string
		// Runs `run view` no longer finds (another call for the key deleted them).
		gone: Set<number>
		// The deny-list text; undefined: absent; an Error: unreadable.
		denylist: string | undefined | Error
	}
	let w: World

	beforeEach(() => {
		root = fs.mkdtempSync(join(tmpdir(), "rc-test-"))
		calls = []
		w = {
			onBase: true,
			mb: MB,
			runs: [],
			nextId: 7,
			pushes: 0,
			commits: 0,
			rerunFails: false,
			rerunHeals: false,
			doneAt: 0,
			clock: 1_000_000,
			missingFirst: [],
			listLag: false,
			patch: "",
			baseLines: [],
			binary: "",
			gone: new Set(),
			denylist: "never-matching-word\n",
		}
		verdictFor = verdict
	})
	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true })
	})

	const verdict = (name: string) =>
		name === "static"
			? { ok: true, seconds: 100, steps: { lint: 0 }, failed: [], flaky: [] }
			: {
					ok: true,
					seconds: 200,
					steps: { install: 0, "root-tests": 0 },
					failed: [],
					flaky: [],
					durations: {},
				}
	let verdictFor: (name: string, attempt: number) => object = verdict
	const infraVerdict = (name: string) => ({
		...verdict(name),
		ok: false,
		infra: true,
		steps: { pip: 1, install: -1, "root-tests": -1 },
	})

	// Commits this client wrote: their tree and parent, as `git log --format=%T %P` prints them.
	const commitTrees = new Map<string, string>()
	const git = (args: string[]) => {
		calls.push(`git ${args.join(" ")}`)
		const [cmd = "", a1 = ""] = args
		if (cmd === "rev-parse" && a1 === "--show-toplevel") return `${root}\n`
		if (cmd === "rev-parse") return join(root, "no-index")
		if (cmd === "remote") return `git${"@"}github.com-alias:o/r.git\n`
		if (cmd === "write-tree") return `${TREE}\n`
		if (cmd === "ls-files") return w.binary ? `${w.binary}\0` : ""
		if (cmd === "merge-base" && a1 === "--is-ancestor") {
			if (!w.onBase) throw new Error("not an ancestor")
			return ""
		}
		if (cmd === "merge-base") return `${w.mb}\n`
		if (cmd === "commit-tree") {
			const sha = `c0ffee${w.commits++}`
			commitTrees.set(sha, `${args[2]} ${args[4]}`)
			return `${sha}\n`
		}
		if (cmd === "log" && a1 === "-1" && args[2] === "--format=%T %P") {
			const t = commitTrees.get(args[3] ?? "")
			if (!t) throw new Error("bad object")
			return `${t}\n`
		}
		if (cmd === "grep") {
			const t = args[args.indexOf("-e") + 1] ?? ""
			const lines = w.baseLines.filter(l => l.includes(t))
			if (!lines.length) throw new Error("no match")
			return `${lines.join("\n")}\n`
		}
		if (w.binary) {
			if (args.includes("diff") && args.includes("--name-status"))
				return `A\0${w.binary}\0`
			if (cmd === "ls-tree") return `100644 blob b1 10\t${w.binary}\0`
			if (cmd === "cat-file" && a1 === "-p") return "PNG\0\x01"
		}
		if (args.includes("diff") && w.patch) {
			if (args.includes("--name-status")) return "M\0src/a.ts\0"
			if (args.includes("-U0"))
				return `diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +2 @@\n+${w.patch}\n`
		}
		if (cmd === "push" && !args.includes("--delete")) {
			const [sha = "", ref = ""] = (args.at(-1) ?? "").split(":")
			w.pushes++
			w.runs.push({
				id: w.nextId++,
				status: "in_progress",
				attempt: 1,
				missing: [...w.missingFirst],
				branch: ref.replace("refs/heads/", ""),
				sha,
				createdAt: w.clock,
			})
		}
		return ""
	}

	const gh = (args: string[]) => {
		calls.push(`gh ${args.join(" ")}`)
		const [, verb = "", id = ""] = args
		if (verb === "list") {
			const b = args.includes("--branch")
				? args[args.indexOf("--branch") + 1]
				: undefined
			return JSON.stringify(
				(b && w.listLag ? [] : w.runs)
					.filter(r => !b || r.branch === b)
					.slice()
					.reverse()
					.map(r => ({
						databaseId: r.id,
						headBranch: r.branch,
						headSha: r.sha,
						createdAt: new Date(r.createdAt).toISOString(),
						updatedAt: new Date(r.createdAt).toISOString(),
						status: r.status,
						workflowName: "CI remote",
					})),
			)
		}
		// A job id is its run's id times 100 plus its index.
		const job = verb === "rerun" ? Number(args[args.indexOf("--job") + 1]) : NaN
		const run = w.runs.find(r =>
			Number.isNaN(job) ? String(r.id) === id : r.id === Math.floor(job / 100),
		)
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
					databaseId: run.id * 100 + i,
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
					JSON.stringify(verdictFor(name, run.attempt)),
				)
			}
			return ""
		}
		if (verb === "rerun") {
			if (w.rerunFails) throw new Error("cannot rerun")
			if (w.rerunHeals)
				run.missing = Number.isNaN(job)
					? []
					: run.missing.filter(n => n !== JOBS[job % 100])
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
		readDenylist: () => {
			if (w.denylist instanceof Error) throw w.denylist
			return w.denylist
		},
	})
	const network = () =>
		calls.filter(c => /^gh |^git (fetch|push|ls-remote)/.test(c))
	const deleted = () =>
		calls.filter(c => c.startsWith("gh run delete")).map(c => c.split(" ")[3])

	it("reads the slug from an SSH host alias and passes a green tree", async () => {
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(0)
		expect(r.text.split("\n")[0]).toMatch(
			/^remote-check PASS {2}tree abcdef012345 {2}base 11111111/,
		)
		const ghCalls = calls.filter(c => c.startsWith("gh "))
		expect(ghCalls.every(c => c.endsWith("-R o/r"))).toBe(true)
		expect(calls).toContain(
			`git commit-tree --no-gpg-sign ${TREE} -p ${MB} -m ci: remote check`,
		)
		expect(calls).toContain(
			`git push -q --force github c0ffee0:refs/heads/${BRANCH}`,
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
		expect(r.text.split("\n")).toHaveLength(3)
	})

	it.each<[string, string | undefined | Error, string]>([
		[
			"missing",
			undefined,
			"deny-list missing: create ~/.config/wavekit-remote/denylist (one regex per line; see CONTRIBUTING)",
		],
		[
			"unreadable",
			new Error("EACCES"),
			"deny-list unreadable: ~/.config/wavekit-remote/denylist",
		],
		[
			"invalid",
			"fine\n(open\n",
			"deny-list invalid line 2: ~/.config/wavekit-remote/denylist",
		],
		[
			"empty",
			"# nothing yet\n\n",
			"deny-list empty: add at least one regex to ~/.config/wavekit-remote/denylist (see CONTRIBUTING)",
		],
	])(
		"refuses with exit 3 and one line when the deny-list is %s",
		async (_, text, why) => {
			w.denylist = text
			const r = await remoteCheck(deps(), [])
			expect(r).toEqual({
				code: 3,
				text: `remote-check REFUSED  ${why}, nothing pushed`,
			})
			expect(network()).toEqual([])
			expect(w.pushes).toBe(0)
		},
	)

	it("refuses an untracked binary under fixtures/ without pushing", async () => {
		w.binary = "fixtures/iq/new.bin"
		fs.mkdirSync(join(root, "fixtures/iq"), { recursive: true })
		fs.writeFileSync(join(root, w.binary), Buffer.from([0, 1, 2, 0]))
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(3)
		expect(r.text).toBe(
			"remote-check REFUSED  tree abcdef012345: hygiene, nothing pushed\n  fixtures/iq/new.bin binary file added or changed",
		)
		expect(w.pushes).toBe(0)
	})

	it("writes a green run's per-file seconds into its cache directory, silently", async () => {
		verdictFor = name =>
			name === "root (1)"
				? {
						...verdict(name),
						durations: { "tests/a.test.ts": 7.4, "tests/b.test.ts": 1 },
					}
				: verdict(name)
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(0)
		expect(r.text).not.toMatch(/durations/)
		expect(
			JSON.parse(
				fs.readFileSync(
					join(root, `.remote-check/${KEY}/durations.json`),
					"utf8",
				),
			),
		).toEqual({ files: { "tests/a.test.ts": 7 } })
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

	it("answers a second call for the same key from the cache without the network", async () => {
		const first = await remoteCheck(deps(), [])
		calls = []
		const second = await remoteCheck(deps(), [])
		expect(second).toEqual(first)
		expect(network()).toEqual([])
		expect(calls.some(c => c.startsWith("git fetch"))).toBe(false)
		// Another merge base is another key: checked again.
		w.mb = "2".repeat(40)
		w.onBase = false
		const other = await remoteCheck(deps(), ["HEAD~1"])
		expect(other.code).toBe(3)
	})

	it("keys the branch and the cache by tree and merge base, so two bases never share a run", async () => {
		const mb2 = "2".repeat(40)
		const key2 = checkKey(TREE, mb2)
		expect(key2).not.toBe(KEY)
		// A live run of the first base must not be attached to by a check against the second.
		w.doneAt = Number.POSITIVE_INFINITY
		expect((await remoteCheck(deps(), [])).code).toBe(4)
		w.mb = mb2
		calls = []
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(4)
		expect(w.pushes).toBe(2)
		expect(w.runs.map(x => x.branch)).toEqual([BRANCH, `ci/${key2}`])
		expect(calls).toContain(
			`git commit-tree --no-gpg-sign ${TREE} -p ${mb2} -m ci: remote check`,
		)
		expect(fs.existsSync(join(root, `.remote-check/${key2}/state.json`))).toBe(
			true,
		)
		expect(deleted()).toEqual([])
	})

	it("stores a FAIL too and says how to force a recheck", async () => {
		verdictFor = name =>
			name === "root (2)"
				? {
						...verdict(name),
						ok: false,
						steps: { install: 0, "root-tests": 1 },
						failed: [{ file: "tests/x.test.ts", test: "t", message: "no" }],
					}
				: verdict(name)
		const first = await remoteCheck(deps(), [])
		expect(first.code).toBe(1)
		expect(first.text.split("\n").at(-1)).toBe(
			`recheck: rm -r .remote-check/${KEY}`,
		)
		calls = []
		expect(await remoteCheck(deps(), [])).toEqual(first)
		expect(network()).toEqual([])
	})

	it("keeps an INFRA run, then reattaches by its commit and reruns its missing job", async () => {
		w.missingFirst = ["root (3)"]
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(2)
		expect(r.text).toContain("no verdict: root-3")
		expect(r.text).toMatch(/run https:.*\/7 {2}\(kept\)/)
		expect(calls).toContain("gh run rerun --job 703 -R o/r")
		expect(w.runs.map(x => [x.id, x.status, x.attempt])).toEqual([
			[7, "completed", 2],
		])
		expect(fs.existsSync(join(root, `.remote-check/${KEY}/state.json`))).toBe(
			false,
		)
		w.rerunHeals = true
		calls = []
		const again = await remoteCheck(deps(), [])
		expect(again.code).toBe(0)
		expect(w.pushes).toBe(1)
		expect(calls).toContain("gh run rerun --job 703 -R o/r")
		expect(deleted()).toEqual(["7"])
	})

	it("never deletes another call's young completed run; reuses one of its key, else pushes", async () => {
		// A completed run on this branch whose commit is another tree (or unknown here), one on
		// another check's branch, both younger than the hour.
		const foreign = (id: number, branch: string, sha: string): Run => ({
			id,
			status: "completed",
			attempt: 1,
			missing: [],
			branch,
			sha,
			createdAt: w.clock - 10 * 60_000,
		})
		commitTrees.set("d00d", `${"9".repeat(40)} ${MB}`)
		w.runs = [
			foreign(3, BRANCH, "d00d"),
			foreign(4, BRANCH, "unknown"),
			foreign(5, "ci/0123456789ab", "beef"),
		]
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(0)
		expect(w.pushes).toBe(1)
		expect(deleted()).toEqual(["7"])
		expect(w.runs.map(x => x.id)).toEqual([3, 4, 5])
		// A completed run of this key (its commit is this tree on this merge base) is reused.
		commitTrees.set("cafe", `${TREE} ${MB}`)
		w.runs.push(foreign(6, BRANCH, "cafe"))
		fs.rmSync(join(root, ".remote-check"), { recursive: true })
		calls = []
		const reused = await remoteCheck(deps(), [])
		expect(reused.code).toBe(0)
		expect(w.pushes).toBe(1)
		expect(calls).toContain(VIEW.replace(" 7 ", " 6 "))
		expect(deleted()).toEqual(["6"])
		expect(w.runs.map(x => x.id)).toEqual([3, 4, 5])
	})

	it("attaches to the pushed run by its commit, not an older run of the branch", async () => {
		commitTrees.set("d00d", `${"9".repeat(40)} ${MB}`)
		w.runs = [
			{
				id: 3,
				status: "completed",
				attempt: 1,
				missing: [],
				branch: BRANCH,
				sha: "d00d",
				createdAt: w.clock,
			},
		]
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(0)
		expect(calls).toContain(VIEW)
		expect(calls.some(c => c.startsWith("gh run view 3 "))).toBe(false)
	})

	it("deletes the run of a failure, a failed non-test step's too, and writes no durations", async () => {
		verdictFor = name =>
			name === "static"
				? { ...verdict(name), ok: false, steps: { lint: 1 } }
				: verdict(name)
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(1)
		expect(r.text).toContain("actions/runs/7  (deleted)")
		expect(w.runs).toEqual([])
		expect(
			fs.existsSync(join(root, `.remote-check/${KEY}/durations.json`)),
		).toBe(false)
	})

	it("reruns a job whose setup step failed instead of failing, and passes when it heals", async () => {
		verdictFor = (name, attempt) =>
			name === "root (2)" && attempt === 1 ? infraVerdict(name) : verdict(name)
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(0)
		expect(calls.filter(c => c.startsWith("gh run rerun"))).toEqual([
			"gh run rerun --job 702 -R o/r",
		])
	})

	it("fails, naming the job and its setup step, when the same setup step fails again", async () => {
		verdictFor = name =>
			name === "root (2)" || name === "static"
				? infraVerdict(name)
				: verdict(name)
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(1)
		expect(r.text).toContain("root ok FAIL ok ok ok ok")
		expect(r.text).toContain("static FAIL")
		expect(r.text).toContain("root 2 > step pip")
		expect(r.text).toContain("setup failed on both attempts: static pip")
		expect(r.text).toContain("setup failed on both attempts: root-2 pip")
		expect(r.text).not.toContain("infra:")
		expect(calls.filter(c => c.startsWith("gh run rerun"))).toEqual([
			"gh run rerun 7 -R o/r",
		])
		expect(deleted()).toEqual(["7"])
	})

	it("is INFRA, naming the job and its setup step, when another setup step fails on the rerun", async () => {
		verdictFor = (name, attempt) =>
			name === "root (2)"
				? {
						...infraVerdict(name),
						steps:
							attempt === 1
								? { pip: 1, "root-tests": -1 }
								: { pip: 0, corepack: 1, "root-tests": -1 },
					}
				: verdict(name)
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(2)
		expect(r.text).toContain("infra: root-2 corepack")
		expect(r.text).toContain("root ok INFRA ok ok ok ok")
		expect(r.text).not.toContain("FAIL")
		expect(r.text).toMatch(/run https:.*\/7 {2}\(kept\)/)
		expect(deleted()).toEqual([])
	})

	it("fails a code-caused install failure at once, without a rerun", async () => {
		verdictFor = name =>
			name === "root (4)"
				? {
						...verdict(name),
						ok: false,
						steps: { pip: 0, install: 1, "root-tests": -1 },
					}
				: verdict(name)
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(1)
		expect(r.text).toContain("root 4 > step install")
		expect(calls.some(c => c.startsWith("gh run rerun"))).toBe(false)
	})

	it("never reruns once a real failure is known, and still lists the jobs without a verdict", async () => {
		w.missingFirst = ["static", "root (5)"]
		verdictFor = name =>
			name === "root (3)"
				? {
						...verdict(name),
						ok: false,
						steps: { install: 0, "root-tests": 1 },
						failed: [{ file: "tests/a.test.ts", test: "t", message: "boom" }],
					}
				: verdict(name)
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(1)
		expect(r.text).toContain("no verdict: static, root-5")
		expect(r.text).toContain("tests/a.test.ts > t")
		expect(calls.some(c => c.startsWith("gh run rerun"))).toBe(false)
		expect(deleted()).toEqual(["7"])
	})

	it("reruns the whole run in one request when several jobs lack a verdict", async () => {
		w.missingFirst = ["static", "root (4)", "root (6)"]
		w.rerunHeals = true
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(0)
		expect(calls.filter(c => c.startsWith("gh run rerun"))).toEqual([
			"gh run rerun 7 -R o/r",
		])
		expect(calls.some(c => c.includes("--failed"))).toBe(false)
	})

	it("returns 4 at the deadline while the pushed run has not appeared, then attaches", async () => {
		w.listLag = true
		const d: Deps = {
			...deps(),
			sleep: async ms => {
				w.clock += ms * 12
			},
		}
		const r = await remoteCheck(d, [])
		expect(r).toEqual({
			code: 4,
			text: `remote-check RUNNING  tree abcdef012345: run of ${BRANCH} not started yet, call again`,
		})
		expect(w.clock - 1_000_000).toBeLessThanOrEqual(9 * 60_000)
		w.listLag = false
		const again = await remoteCheck(deps(), [])
		expect(again.code).toBe(0)
		expect(w.pushes).toBe(1)
	})

	it("is INFRA at once when gh refuses the rerun", async () => {
		w.missingFirst = ["static"]
		w.rerunFails = true
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(2)
		expect(r.text).toBe(
			"remote-check INFRA  tree abcdef012345: rerun refused, run https://github.com/o/r/actions/runs/7 kept",
		)
		expect(calls.filter(c => c.startsWith("gh run view"))).toHaveLength(2)
	})

	it("keeps waiting, not INFRA, when the rerun is refused because another call's rerun is live", async () => {
		w.missingFirst = ["static"]
		const base = deps()
		const d: Deps = {
			...base,
			gh: args => {
				if (args[1] === "rerun") {
					calls.push(`gh ${args.join(" ")}`)
					// Another call for this key reran the run first: GitHub refuses a second request.
					const run = w.runs[0]
					if (run) {
						run.attempt++
						run.status = "in_progress"
					}
					w.doneAt = Number.POSITIVE_INFINITY
					throw new Error("run is already being rerun")
				}
				return base.gh(args)
			},
		}
		const r = await remoteCheck(d, [])
		expect(r.code).toBe(4)
		expect(r.text).toMatch(
			/^remote-check RUNNING {2}tree abcdef012345: run .*\/7 still running, call again$/,
		)
		expect(w.clock - 1_000_000).toBeLessThanOrEqual(9 * 60_000)
		const state = JSON.parse(
			fs.readFileSync(join(root, `.remote-check/${KEY}/state.json`), "utf8"),
		)
		expect(state).toMatchObject({ runId: "7", rerunAttempt: 1 })
		// The other call's rerun ends with every verdict: this call reads it, no second rerun.
		w.doneAt = 0
		for (const run of w.runs) run.missing = []
		calls = []
		const again = await remoteCheck(deps(), [])
		expect(again.code).toBe(0)
		expect(calls.some(c => c.startsWith("gh run rerun"))).toBe(false)
	})

	it("returns 4 while the run is live and attaches through state.json on the next call", async () => {
		w.doneAt = Number.POSITIVE_INFINITY
		const r = await remoteCheck(deps(), [])
		expect(r.code).toBe(4)
		expect(r.text).toMatch(
			/^remote-check RUNNING {2}tree abcdef012345: run .*\/7 still running, call again$/,
		)
		const state = JSON.parse(
			fs.readFileSync(join(root, `.remote-check/${KEY}/state.json`), "utf8"),
		)
		expect(state).toEqual({ runId: "7" })
		w.doneAt = 0
		w.listLag = true
		calls = []
		const again = await remoteCheck(deps(), [])
		expect(again.code).toBe(0)
		expect(w.pushes).toBe(1)
		expect(calls).toContain(VIEW)
	})

	it("drops the rerun mark with a stored run that vanished, so the new run is read", async () => {
		const cache = join(root, `.remote-check/${KEY}`)
		fs.mkdirSync(cache, { recursive: true })
		fs.writeFileSync(
			join(cache, "state.json"),
			JSON.stringify({ runId: "99", rerunAttempt: 1 }),
		)
		const r = await remoteCheck(deps(), [])
		// With the stale mark, attempt 1 of the new run would never count as done (code 4).
		expect(r.code).toBe(0)
		expect(w.pushes).toBe(1)
		expect(calls).toContain(VIEW)
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
		const cache = join(root, `.remote-check/${KEY}`)
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

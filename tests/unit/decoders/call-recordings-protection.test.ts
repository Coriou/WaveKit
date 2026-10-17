import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import type { RecordingProtection } from "../../../src/core/recordings/contract.js"
import {
	pruneCallRecordings,
	setCallRecordingProtection,
} from "../../../src/decoders/builtin/call-recordings.js"
import type { Logger } from "../../../src/utils/logger.js"

const NOW = 1_800_000_000_000
const H = 3_600_000
const C1 = "20261001_010101_00001_1_GROUP_TGT_9_SRC_1.wav"
const C2 = "20261002_010101_00002_1_GROUP_TGT_9_SRC_2.wav"
const C3 = "20261003_010101_00003_1_PRIVATE_TGT_9_SRC_3.wav"
const T4 = "TEMP_20261004_010101_1A2B.wav"
const C5 = "20261005_010101_00005_1_GROUP_TGT_9_SRC_5.wav"
const C6 = "20261006_010101_00006_1_GROUP_TGT_9_SRC_6.wav"
const C7 = "20261007_010101_00007_1_GROUP_TGT_9_SRC_7.wav"
/** [subdir, name, bytes, age ms] */
const SCENARIO: ReadonlyArray<readonly [string, string, number, number]> = [
	["", C1, 3000, 200 * H],
	["", C2, 2000, 100 * H],
	["WAV", C3, 4000, 50 * H],
	["", T4, 1500, 40 * H],
	["WAV", C5, 2500, 30 * H],
	["", C6, 1000, 2 * H],
	["", C7, 5000, 5_000],
	["", "notes.wav", 9000, 900 * H],
]
const SMALL_MB = 12000 / 1048576

let dir = ""

function build(): void {
	dir = mkdtempSync(path.join(tmpdir(), "wavekit-calls-keep-"))
	mkdirSync(path.join(dir, "WAV"))
	for (const [sub, name, bytes, age] of SCENARIO) {
		const file = path.join(dir, sub, name)
		writeFileSync(file, Buffer.alloc(bytes))
		const t = (NOW - age) / 1000
		utimesSync(file, t, t)
	}
}

function left(): string[] {
	return [
		...readdirSync(dir),
		...readdirSync(path.join(dir, "WAV")).map(n => `WAV/${n}`),
	].sort()
}

function prune(maxTotalMb: number) {
	return pruneCallRecordings(
		[dir, path.join(dir, "WAV")],
		{ maxTotalMb, maxAgeHours: 168 },
		NOW,
	)
}

function port(isKept: (name: string) => boolean): RecordingProtection {
	return {
		isProtected: () => true,
		isDsdFmeFileProtected: isKept,
		isScannerFileProtected: () => true,
		discoveryHoldsKept: () => true,
	}
}

interface Call {
	level: string
	args: unknown[]
}

function fakeLogger(calls: Call[]): Logger {
	const make = (): Logger => {
		const record =
			(level: string) =>
			(...args: unknown[]): void => {
				calls.push({ level, args })
			}
		return {
			trace: record("trace"),
			debug: record("debug"),
			info: record("info"),
			warn: record("warn"),
			error: record("error"),
			fatal: record("fatal"),
			child: () => make(),
		} as unknown as Logger
	}
	return make()
}

beforeEach(() => {
	build()
})

afterEach(() => {
	setCallRecordingProtection(null)
	rmSync(dir, { recursive: true, force: true })
})

describe("pruneCallRecordings with no protection port (golden from 5669c187)", () => {
	// Recorded by running the frozen pruner on this exact scenario before the WG9 edit.
	it("matches the frozen size-pruning run", async () => {
		const r = await prune(SMALL_MB)
		expect(Object.keys(r)).toEqual(["deleted", "keptFiles", "keptBytes"])
		expect(r.deleted.map(f => path.relative(dir, f))).toEqual([
			C1,
			C2,
			`WAV/${C3}`,
		])
		expect(r.keptFiles).toBe(4)
		expect(r.keptBytes).toBe(10000)
		expect(left()).toEqual([C6, C7, T4, "WAV", `WAV/${C5}`, "notes.wav"])
	})

	it("matches the frozen age-pruning run", async () => {
		const r = await prune(1)
		expect(Object.keys(r)).toEqual(["deleted", "keptFiles", "keptBytes"])
		expect(r.deleted.map(f => path.relative(dir, f))).toEqual([C1])
		expect(r.keptFiles).toBe(6)
		expect(r.keptBytes).toBe(16000)
		expect(left()).toEqual([
			C2,
			C6,
			C7,
			T4,
			"WAV",
			`WAV/${C3}`,
			`WAV/${C5}`,
			"notes.wav",
		])
	})

	it("logs nothing (the frozen pruner had no log site), even with a logger offered for null", async () => {
		const calls: Call[] = []
		setCallRecordingProtection(null, fakeLogger(calls))
		await prune(SMALL_MB)
		expect(calls).toEqual([])
	})
})

describe("pruneCallRecordings with a protection port", () => {
	it("a kept file survives age pruning", async () => {
		setCallRecordingProtection(port(n => n === C1))
		const r = await prune(1)
		expect(r.deleted).toEqual([])
		expect(r.protectedSkipped).toBe(1)
		expect(left()).toContain(C1)
	})

	it("a kept file survives size pruning and still counts toward the total", async () => {
		setCallRecordingProtection(port(n => n === C2))
		const r = await prune(SMALL_MB)
		// 19000 bytes: C1 expired goes (16000); C2 kept but still counted; C3 goes (12000 fits).
		expect(r.deleted.map(f => path.basename(f))).toEqual([C1, C3])
		expect(r.protectedSkipped).toBe(1)
		expect(r.keptBytes).toBe(12000)
		expect(left()).toContain(C2)
	})

	it("a port answering protected for everything (store failed) deletes nothing", async () => {
		setCallRecordingProtection(port(() => true))
		const before = left()
		const r = await prune(SMALL_MB)
		expect(r.deleted).toEqual([])
		expect(r.protectedSkipped).toBe(6)
		expect(left()).toEqual(before)
	})

	it("a throwing port fails closed", async () => {
		setCallRecordingProtection(
			port(() => {
				throw new Error("boom")
			}),
		)
		const before = left()
		const r = await prune(SMALL_MB)
		expect(r.deleted).toEqual([])
		expect(left()).toEqual(before)
	})

	it("passes basenames, never paths, and only for files it would delete", async () => {
		const asked: string[] = []
		setCallRecordingProtection(
			port(n => {
				asked.push(n)
				return false
			}),
		)
		await prune(SMALL_MB)
		expect(asked).toEqual([C1, C2, C3])
	})

	it("logs the skipped count only, never a name or path", async () => {
		const calls: Call[] = []
		setCallRecordingProtection(
			port(() => true),
			fakeLogger(calls),
		)
		await prune(SMALL_MB)
		expect(calls).toEqual([
			{
				level: "info",
				args: [
					{ protectedSkipped: 6 },
					"Per-call recording retention skipped kept recordings",
				],
			},
		])
		const text = JSON.stringify(calls)
		for (const [, name] of SCENARIO) expect(text).not.toContain(name)
		expect(text).not.toContain(dir)
	})

	it("logs nothing when nothing was skipped", async () => {
		const calls: Call[] = []
		setCallRecordingProtection(
			port(() => false),
			fakeLogger(calls),
		)
		const r = await prune(SMALL_MB)
		expect(r.protectedSkipped).toBe(0)
		expect(calls).toEqual([])
	})
})

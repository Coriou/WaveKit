/**
 * WG9 R2: an operator-configured dsd-fme recording directory that is itself a symlink is
 * resolved once (operator config is trusted) and pruned through its real directory; a symlink
 * below it stays refused, a real root whose identity changed is refused, and a non-symlinked
 * root keeps the ecccc22e results byte for byte.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import type { RecordingProtection } from "../../../src/core/recordings/contract.js"
import {
	pruneCallRecordings,
	resetRecordingRootPins,
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

let base = ""

function populate(dir: string): void {
	mkdirSync(path.join(dir, "WAV"), { recursive: true })
	for (const [sub, name, bytes, age] of SCENARIO) {
		const file = path.join(dir, sub, name)
		writeFileSync(file, Buffer.alloc(bytes))
		const t = (NOW - age) / 1000
		utimesSync(file, t, t)
	}
}

function left(dir: string): string[] {
	return [
		...readdirSync(dir),
		...readdirSync(path.join(dir, "WAV")).map(n => `WAV/${n}`),
	].sort()
}

function prune(root: string, maxTotalMb: number, withRoot = true) {
	return pruneCallRecordings(
		[root, path.join(root, "WAV")],
		{ maxTotalMb, maxAgeHours: 168 },
		NOW,
		...(withRoot ? [root] : []),
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

function captureLogger(): { logger: Logger; lines: unknown[][] } {
	const lines: unknown[][] = []
	const logger = {
		child: () => logger,
		info: (...a: unknown[]) => lines.push(["info", ...a]),
		warn: (...a: unknown[]) => lines.push(["warn", ...a]),
		debug: () => undefined,
		error: () => undefined,
	} as unknown as Logger
	return { logger, lines }
}

/** A symlinked configured root `<base>/configured -> <base>/real`; returns both. */
function symlinkedRoot(): { configured: string; real: string } {
	const real = path.join(base, "real")
	mkdirSync(real)
	populate(real)
	const configured = path.join(base, "configured")
	symlinkSync(real, configured)
	return { configured, real }
}

beforeEach(() => {
	base = realpathSync(mkdtempSync(path.join(tmpdir(), "wavekit-calls-root-")))
	resetRecordingRootPins()
})

afterEach(() => {
	setCallRecordingProtection(null)
	resetRecordingRootPins()
	rmSync(base, { recursive: true, force: true })
})

for (const mode of ["port", "no port"] as const) {
	describe(`call recording pruner, symlinked configured root (${mode})`, () => {
		beforeEach(() => {
			if (mode === "port")
				setCallRecordingProtection(
					port(n => n === C2),
					captureLogger().logger,
				)
		})

		it("prunes and retains through the real directory", async () => {
			const { configured, real } = symlinkedRoot()
			const result = await prune(configured, SMALL_MB)
			// C1 expired; C2 kept with a port; the size rule then takes the oldest unkept.
			// Deleted paths name the pinned real directory.
			if (mode === "port") {
				expect(result.deleted).toEqual(
					[C1, `WAV/${C3}`].map(n => path.join(real, n)),
				)
				expect(result.protectedSkipped).toBe(1)
				expect(left(real)).toEqual(
					[C2, C6, C7, T4, "notes.wav", "WAV", `WAV/${C5}`].sort(),
				)
			} else {
				expect(result.deleted).toEqual(
					[C1, C2, `WAV/${C3}`].map(n => path.join(real, n)),
				)
				expect(left(real)).toEqual(
					[C6, C7, T4, "notes.wav", "WAV", `WAV/${C5}`].sort(),
				)
			}
		})

		it("refuses a real root whose identity changed after the first resolution", async () => {
			const { configured, real } = symlinkedRoot()
			// First resolution pins the real directory (nothing to delete at a huge cap and age).
			await pruneCallRecordings(
				[configured],
				{ maxTotalMb: 1e6, maxAgeHours: 1e6 },
				NOW,
				configured,
			)
			renameSync(real, path.join(base, "moved"))
			mkdirSync(real)
			populate(real)
			const result = await prune(configured, SMALL_MB)
			expect(result.deleted).toEqual([])
			expect(left(real)).toEqual(
				[
					C1,
					C2,
					C6,
					C7,
					T4,
					"notes.wav",
					"WAV",
					`WAV/${C3}`,
					`WAV/${C5}`,
				].sort(),
			)
			expect(left(path.join(base, "moved")).length).toBe(9)
		})

		it("ignores a runtime re-point of the configured link: the pinned real directory stays the base", async () => {
			const { configured, real } = symlinkedRoot()
			await pruneCallRecordings(
				[configured],
				{ maxTotalMb: 1e6, maxAgeHours: 1e6 },
				NOW,
				configured,
			)
			const other = path.join(base, "other")
			mkdirSync(other)
			populate(other)
			unlinkSync(configured)
			symlinkSync(other, configured)
			const result = await prune(configured, SMALL_MB)
			expect(result.deleted.length).toBeGreaterThan(0)
			for (const f of result.deleted)
				expect(f.startsWith(real + path.sep)).toBe(true)
			expect(left(other).length).toBe(9)
		})
	})
}

describe("call recording pruner, symlink below a symlinked configured root (port)", () => {
	it("refuses a symlinked WAV folder and a symlinked candidate under the real root", async () => {
		const { logger, lines } = captureLogger()
		setCallRecordingProtection(
			port(() => false),
			logger,
		)
		const real = path.join(base, "real")
		mkdirSync(real)
		const outside = path.join(base, "outside")
		populate(outside)
		symlinkSync(path.join(outside, "WAV"), path.join(real, "WAV"))
		symlinkSync(path.join(outside, C1), path.join(real, C1))
		const configured = path.join(base, "configured")
		symlinkSync(real, configured)
		const result = await prune(configured, 0)
		expect(result.deleted).toEqual([])
		expect(left(outside).length).toBe(9)
		expect(
			lines.some(l => (l[1] as { unsafeSkipped?: number }).unsafeSkipped === 2),
		).toBe(true)
	})
})

describe("call recording pruner, root missing at the first resolution (port)", () => {
	it("keeps today's behaviour: a link that appears later is still refused", async () => {
		setCallRecordingProtection(
			port(() => false),
			captureLogger().logger,
		)
		const configured = path.join(base, "configured")
		expect((await prune(configured, 0)).deleted).toEqual([])
		const real = path.join(base, "real")
		populate(real)
		symlinkSync(real, configured)
		const result = await prune(configured, 0)
		expect(result.deleted).toEqual([])
		expect(result.protectedSkipped).toBe(0)
		expect(left(real).length).toBe(9)
	})
})

describe("call recording pruner, non-symlinked root golden (ecccc22e)", () => {
	/** Results relative to the root, as ecccc22e produced them for the same scenario. */
	const GOLDEN = {
		port: {
			deleted: [C1, `WAV/${C3}`],
			keptFiles: 5,
			keptBytes: 12000,
			protectedSkipped: 1,
			left: [C2, C6, C7, T4, "notes.wav", "WAV", `WAV/${C5}`],
		},
		"no port": {
			deleted: [C1, C2, `WAV/${C3}`],
			keptFiles: 4,
			keptBytes: 10000,
			protectedSkipped: undefined,
			left: [C6, C7, T4, "notes.wav", "WAV", `WAV/${C5}`],
		},
	} as const
	for (const mode of ["port", "no port"] as const)
		for (const withRoot of [true, false])
			it(`${mode}, ${withRoot ? "with" : "without"} the root argument`, async () => {
				if (mode === "port")
					setCallRecordingProtection(
						port(n => n === C2),
						captureLogger().logger,
					)
				const root = path.join(base, "plain")
				populate(root)
				const result = await prune(root, SMALL_MB, withRoot)
				const g = GOLDEN[mode]
				// Absolute paths under the configured root, in deletion order, exactly as before.
				expect(result.deleted).toEqual(g.deleted.map(n => path.join(root, n)))
				expect(result.keptFiles).toBe(g.keptFiles)
				expect(result.keptBytes).toBe(g.keptBytes)
				expect(result.protectedSkipped).toBe(g.protectedSkipped)
				expect(Object.keys(result).sort()).toEqual(
					mode === "port"
						? ["deleted", "keptBytes", "keptFiles", "protectedSkipped"]
						: ["deleted", "keptBytes", "keptFiles"],
				)
				expect(left(root)).toEqual([...g.left].sort())
			})
})

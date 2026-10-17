import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import type * as LoggerModule from "../../../src/utils/logger.js"
import { afterEach, expect, it, vi } from "vitest"

import type { RecordingProtection } from "../../../src/core/recordings/contract.js"

const spy = vi.hoisted(() => {
	const info = vi.fn()
	const created = vi.fn()
	const logger: Record<string, unknown> = {
		info,
		warn: vi.fn(),
		debug: vi.fn(),
		error: vi.fn(),
		trace: vi.fn(),
		fatal: vi.fn(),
	}
	logger["child"] = () => logger
	return { info, created, logger }
})

vi.mock("../../../src/utils/logger.js", async importOriginal => {
	const real = await importOriginal<typeof LoggerModule>()
	return {
		...real,
		createLogger: (...args: unknown[]) => {
			spy.created(...args)
			return spy.logger
		},
	}
})

const { pruneCallRecordings, setCallRecordingProtection } =
	await import("../../../src/decoders/builtin/call-recordings.js")

const NOW = 1_800_000_000_000
const C1 = "20261001_010101_00001_1_GROUP_TGT_9_SRC_1.wav"
let dir = ""

afterEach(() => {
	setCallRecordingProtection(null)
	if (dir) rmSync(dir, { recursive: true, force: true })
	spy.info.mockClear()
	spy.created.mockClear()
})

function build(): void {
	dir = mkdtempSync(path.join(tmpdir(), "wavekit-calls-log-"))
	const file = path.join(dir, C1)
	writeFileSync(file, Buffer.alloc(100))
	const t = (NOW - 200 * 3_600_000) / 1000
	utimesSync(file, t, t)
}

const protectAll: RecordingProtection = {
	isProtected: () => true,
	isDsdFmeFileProtected: () => true,
	isScannerFileProtected: () => true,
	discoveryHoldsKept: () => true,
}

it("finding 6: the one-argument port logs the protected-skip count, never a name", async () => {
	build()
	setCallRecordingProtection(protectAll)
	const r = await pruneCallRecordings(
		[dir],
		{ maxTotalMb: 0, maxAgeHours: 1 },
		NOW,
	)
	expect(r.protectedSkipped).toBe(1)
	expect(spy.info).toHaveBeenCalledTimes(1)
	expect(spy.info.mock.calls[0]).toEqual([
		{ protectedSkipped: 1 },
		"Per-call recording retention skipped kept recordings",
	])
	expect(JSON.stringify(spy.info.mock.calls)).not.toContain(C1)
	expect(JSON.stringify(spy.info.mock.calls)).not.toContain(dir)
})

it("finding 6: a port-null run creates no logger and logs nothing", async () => {
	build()
	await pruneCallRecordings([dir], { maxTotalMb: 0, maxAgeHours: 1 }, NOW)
	expect(spy.created).not.toHaveBeenCalled()
	expect(spy.info).not.toHaveBeenCalled()
})

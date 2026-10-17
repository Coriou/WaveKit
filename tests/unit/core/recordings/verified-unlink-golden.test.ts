/**
 * WG10 RK2 goldens: the dsd-fme delete responses and log lines recorded from the frozen WG9 code
 * (1e5b4c1f) before the verified-unlink extraction; asserted unchanged after it.
 */
import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import { openRecordingKeepService } from "../../../../src/core/recordings/keep-service.js"
import type { Logger } from "../../../../src/utils/logger.js"

const NAME = "20261016_120000_01234_1_GROUP_TGT_100_SRC_2001.wav"
const DSD_ID = `dsd:0~${NAME}`

function wav(dataBytes: number): Buffer {
	const b = Buffer.alloc(44 + dataBytes)
	b.write("RIFF", 0, "ascii")
	b.writeUInt32LE(36 + dataBytes, 4)
	b.write("WAVEfmt ", 8, "ascii")
	b.writeUInt32LE(16, 16)
	b.writeUInt16LE(1, 20)
	b.writeUInt16LE(1, 22)
	b.writeUInt32LE(8000, 24)
	b.writeUInt32LE(16000, 28)
	b.writeUInt16LE(2, 32)
	b.writeUInt16LE(16, 34)
	b.write("data", 36, "ascii")
	b.writeUInt32LE(dataBytes, 40)
	return b
}

const roots: string[] = []
afterEach(async () => {
	for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true })
})

async function setup(): Promise<{
	dsd: string
	stateDir: string
	logs: unknown[][]
	open: () => ReturnType<typeof openRecordingKeepService>
}> {
	const root = await mkdtemp(path.join(tmpdir(), "wk-golden-"))
	roots.push(root)
	const now = Date.now() + 60_000
	const stateDir = path.join(root, "state")
	const dsd = path.join(root, "dsd")
	await mkdir(stateDir)
	await mkdir(dsd)
	const file = path.join(dsd, NAME)
	await writeFile(file, wav(16_000))
	const t = (now - 30_000) / 1000
	await utimes(file, t, t)
	const logs: unknown[][] = []
	const l: Record<string, unknown> = {}
	for (const level of ["warn", "info", "debug", "error", "trace", "fatal"])
		l[level] = vi.fn((...args: unknown[]) => {
			logs.push([level, ...args])
		})
	l["child"] = () => l
	const logger = l as unknown as Logger
	const inventory = createRecordingInventory({
		dsdFmeDirs: () => [{ decoderId: "a", dir: dsd }],
		scannerRecordingsDir: () => null,
		now: () => now,
		logger,
	})
	return {
		dsd,
		stateDir,
		logs,
		open: () =>
			openRecordingKeepService({ stateDir, inventory, logger, now: () => now }),
	}
}

async function outcome(p: Promise<unknown>): Promise<unknown> {
	try {
		return { ok: await p }
	} catch (error: unknown) {
		const e = error as { code?: unknown; status?: unknown; message?: unknown }
		return { code: e.code, status: e.status, message: e.message }
	}
}

describe("dsd-fme delete goldens (recorded from the frozen WG9 code)", () => {
	it("success, repeat, kept, unsupported, malformed responses and logs", async () => {
		const s = await setup()
		const svc = await s.open()
		const got = {
			unsupported: await outcome(svc.remove("scan:d_x~call.wav")),
			malformed: await outcome(svc.remove("../x")),
			kept: await (async () => {
				await svc.keep(DSD_ID)
				const r = await outcome(svc.remove(DSD_ID))
				await svc.unkeep(DSD_ID)
				return r
			})(),
			success: await outcome(svc.remove(DSD_ID)),
			repeat: await outcome(svc.remove(DSD_ID)),
		}
		expect(got).toEqual(GOLDEN_RESPONSES)
		expect(s.logs).toEqual(GOLDEN_LOGS)
	})

	it("a group-writable directory answers 500 with the frozen log lines", async () => {
		const s = await setup()
		await chmod(s.dsd, 0o775)
		const svc = await s.open()
		const got = await outcome(svc.remove(DSD_ID))
		expect({ got, logs: s.logs }).toEqual(GOLDEN_SHARED)
	})

	it("a failed store answers 503", async () => {
		const s = await setup()
		await writeFile(path.join(s.stateDir, "recording-keeps.json"), "{bad")
		const svc = await s.open()
		expect(await outcome(svc.remove(DSD_ID))).toEqual(GOLDEN_FAILED)
	})
})

const notFound = {
	code: "RECORDING_NOT_FOUND",
	message: "Recording not found",
	status: 404,
}
const GOLDEN_RESPONSES = {
	kept: {
		code: "RECORDING_KEPT",
		message: "Recording is kept; unkeep it first",
		status: 409,
	},
	malformed: notFound,
	repeat: notFound,
	success: { ok: { deleted: true, id: DSD_ID } },
	unsupported: {
		code: "RECORDING_DELETE_UNSUPPORTED",
		message: "This recording cannot be deleted",
		status: 409,
	},
}
const GOLDEN_LOGS = [
	["info", { kept: 1 }, "Recording kept"],
	["info", { kept: 0 }, "Recording unkept"],
	["info", {}, "Recording deleted"],
]
const GOLDEN_SHARED = {
	got: {
		code: "RECORDING_DELETE_FAILED",
		message: "Recording could not be deleted",
		status: 500,
	},
	logs: [
		[
			"warn",
			{},
			"Recording delete refused: the recording directory is writable by other users",
		],
		[
			"warn",
			{ err: { code: "RECORDING_DELETE_FAILED", type: "WaveKitError" } },
			"Recording delete failed",
		],
	],
}
const GOLDEN_FAILED = {
	code: "RECORDING_KEEPS_UNAVAILABLE",
	message: "Recording keep store is unavailable",
	status: 503,
}

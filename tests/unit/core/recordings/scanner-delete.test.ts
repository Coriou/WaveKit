/**
 * WG10 RK2: the keep service's `scan:` delete through a ScannerRecordingDeleter and the keep
 * totals (requirements 1.1, 1.2, 1.4, 1.8).
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createRecordingInventory } from "../../../../src/core/recordings/inventory.js"
import type { RecordingInventory } from "../../../../src/core/recordings/inventory.js"
import { openRecordingKeepService } from "../../../../src/core/recordings/keep-service.js"
import type { RecordingKeepServiceInternal } from "../../../../src/core/recordings/keep-service.js"
import { RecordingKeepError } from "../../../../src/core/recordings/contract.js"
import type { ScannerRecordingDeleter } from "../../../../src/core/recordings/contract.js"
import type { Logger } from "../../../../src/utils/logger.js"

const SCAN_ID = "scan:d_x~call.wav"
const REC_ID = "d_x~call.wav"
const ANALOG_ID = "scan:d_x~analog-0123abcd-0123-4567-89ab-0123456789ab.wav"

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

interface Fx {
	root: string
	stateDir: string
	logs: unknown[][]
	invalidations: number
	inventory: RecordingInventory
	open(deleter?: ScannerRecordingDeleter): Promise<RecordingKeepServiceInternal>
}

async function fixture(): Promise<Fx> {
	const root = await mkdtemp(path.join(tmpdir(), "wk-scandel-"))
	roots.push(root)
	const now = Date.now() + 60_000
	const stateDir = path.join(root, "state")
	const scan = path.join(root, "scan")
	await mkdir(stateDir)
	const p = path.join(scan, "dv", "d_x", "call.wav")
	await mkdir(path.dirname(p), { recursive: true })
	await writeFile(p, wav(16_000))
	const t = (now - 30_000) / 1000
	await utimes(p, t, t)
	const logs: unknown[][] = []
	const l: Record<string, unknown> = {}
	for (const level of ["warn", "info", "debug", "error", "trace", "fatal"])
		l[level] = vi.fn((...args: unknown[]) => {
			logs.push([level, ...args])
		})
	l["child"] = () => l
	const logger = l as unknown as Logger
	const base = createRecordingInventory({
		dsdFmeDirs: () => [],
		scannerRecordingsDir: () => scan,
		now: () => now,
		logger,
	})
	const fx: Fx = {
		root,
		stateDir,
		logs,
		invalidations: 0,
		inventory: {
			...base,
			invalidate: () => {
				fx.invalidations++
				base.invalidate?.()
			},
		},
		open: async deleter =>
			(await openRecordingKeepService({
				stateDir,
				inventory: fx.inventory,
				logger,
				now: () => now,
				...(deleter ? { scannerDeleter: deleter } : {}),
			})) as RecordingKeepServiceInternal,
	}
	return fx
}

function fakeDeleter(
	answer: (
		id: string,
		stillDeletable: () => boolean,
	) => Promise<"deleted" | "not-found">,
): ScannerRecordingDeleter & { calls: string[] } {
	const calls: string[] = []
	return {
		calls,
		deleteRecording: async (id, still) => {
			calls.push(id)
			return answer(id, still)
		},
	}
}

function noSecrets(fx: Fx): void {
	const text = JSON.stringify(fx.logs)
	for (const s of ["d_x", "call.wav", fx.root, "scan:"])
		expect(text).not.toContain(s)
}

describe("keep service scan: delete (WG10 req 1.1)", () => {
	it("without a deleter answers 409 RECORDING_DELETE_UNSUPPORTED as today", async () => {
		const fx = await fixture()
		const svc = await fx.open()
		await expect(svc.remove(SCAN_ID)).rejects.toMatchObject({
			code: "RECORDING_DELETE_UNSUPPORTED",
			status: 409,
		})
		expect(fx.invalidations).toBe(0)
	})

	it("deleted answers 200 {id, deleted:true} with the scanner recording id and invalidates", async () => {
		const fx = await fixture()
		let decision: boolean | null = null
		const d = fakeDeleter(async (_id, still) => {
			decision = still()
			return "deleted"
		})
		const svc = await fx.open(d)
		await expect(svc.remove(SCAN_ID)).resolves.toEqual({
			id: SCAN_ID,
			deleted: true,
		})
		expect(d.calls).toEqual([REC_ID])
		expect(decision).toBe(true)
		expect(fx.invalidations).toBe(1)
		expect(svc.mutexCount()).toBe(0)
		expect(svc.isScannerFileProtected("d_x", "call.wav")).toBe(false)
		noSecrets(fx)
	})

	it("is protected while the delete runs (every deletion decision on the key)", async () => {
		const fx = await fixture()
		let seen: boolean | null = null
		let svc: RecordingKeepServiceInternal | null = null
		const d = fakeDeleter(async () => {
			seen = svc?.isScannerFileProtected("d_x", "call.wav") ?? null
			return "deleted"
		})
		svc = await fx.open(d)
		await svc.remove(SCAN_ID)
		expect(seen).toBe(true)
	})

	it("kept answers 409 RECORDING_KEPT and never calls the deleter", async () => {
		const fx = await fixture()
		const d = fakeDeleter(async () => "deleted")
		const svc = await fx.open(d)
		await svc.keep(SCAN_ID)
		await expect(svc.remove(SCAN_ID)).rejects.toMatchObject({
			code: "RECORDING_KEPT",
			status: 409,
		})
		expect(d.calls).toEqual([])
	})

	it("a delete queued behind a Keep sees it kept and refuses", async () => {
		const fx = await fixture()
		const d = fakeDeleter(async () => "deleted")
		const svc = await fx.open(d)
		const k = svc.keep(SCAN_ID)
		const r = svc.remove(SCAN_ID)
		await expect(k).resolves.toMatchObject({ changed: true })
		await expect(r).rejects.toMatchObject({ code: "RECORDING_KEPT" })
		expect(d.calls).toEqual([])
	})

	it("a Keep during the delete answers 409 RECORDING_BUSY", async () => {
		const fx = await fixture()
		let release = (): void => undefined
		let entered = (): void => undefined
		const inside = new Promise<void>(r => {
			entered = r
		})
		const d = fakeDeleter(
			() =>
				new Promise(resolve => {
					entered()
					release = () => resolve("deleted")
				}),
		)
		const svc = await fx.open(d)
		const r = svc.remove(SCAN_ID)
		await inside
		await expect(svc.keep(SCAN_ID)).rejects.toMatchObject({
			code: "RECORDING_BUSY",
			status: 409,
		})
		release()
		await expect(r).resolves.toMatchObject({ deleted: true })
	})

	it("not-found answers 404 and still invalidates", async () => {
		const fx = await fixture()
		const svc = await fx.open(fakeDeleter(async () => "not-found"))
		await expect(svc.remove(SCAN_ID)).rejects.toMatchObject({
			code: "RECORDING_NOT_FOUND",
			status: 404,
		})
		expect(fx.invalidations).toBe(1)
	})

	it("the deleter's busy (discovery being removed) and unsupported (analog) refusals are 409", async () => {
		const fx = await fixture()
		const svc = await fx.open(
			fakeDeleter(async id => {
				if (id.includes("analog-"))
					throw new RecordingKeepError(
						"RECORDING_DELETE_UNSUPPORTED",
						"This recording cannot be deleted",
					)
				throw new RecordingKeepError(
					"RECORDING_BUSY",
					"Another operation on this recording is in progress",
				)
			}),
		)
		await expect(svc.remove(SCAN_ID)).rejects.toMatchObject({
			code: "RECORDING_BUSY",
			status: 409,
		})
		await expect(svc.remove(ANALOG_ID)).rejects.toMatchObject({
			code: "RECORDING_DELETE_UNSUPPORTED",
			status: 409,
		})
	})

	it("any other deleter error is 500 RECORDING_DELETE_FAILED with a fixed-text log", async () => {
		const fx = await fixture()
		const svc = await fx.open(
			fakeDeleter(async () => {
				throw new Error(`EIO at ${fx.root}/scan/dv/d_x/call.wav`)
			}),
		)
		await expect(svc.remove(SCAN_ID)).rejects.toMatchObject({
			code: "RECORDING_DELETE_FAILED",
			status: 500,
		})
		noSecrets(fx)
	})

	it("store not ready answers 503 and calls nothing", async () => {
		const fx = await fixture()
		await writeFile(path.join(fx.stateDir, "recording-keeps.json"), "{bad")
		const d = fakeDeleter(async () => "deleted")
		const svc = await fx.open(d)
		await expect(svc.remove(SCAN_ID)).rejects.toMatchObject({
			code: "RECORDING_KEEPS_UNAVAILABLE",
			status: 503,
		})
		expect(d.calls).toEqual([])
	})

	it("after an unkeep the decision is true again and the delete proceeds", async () => {
		const fx = await fixture()
		let svc: RecordingKeepServiceInternal | null = null
		// The deleter sees a false decision; the keep service tells the caller why.
		const d = fakeDeleter(async (_id, still) =>
			still() ? "deleted" : "not-found",
		)
		svc = await fx.open(d)
		await svc.keep(SCAN_ID)
		await svc.unkeep(SCAN_ID)
		await expect(svc.remove(SCAN_ID)).resolves.toMatchObject({ deleted: true })
	})

	it("malformed ids answer 404 without calling the deleter", async () => {
		const fx = await fixture()
		const d = fakeDeleter(async () => "deleted")
		const svc = await fx.open(d)
		for (const id of ["scan:../x.wav", "scan:d_x~../a.wav", "scan:d_x~a", ""])
			await expect(svc.remove(id)).rejects.toMatchObject({ status: 404 })
		expect(d.calls).toEqual([])
	})
})

describe("keep totals (WG10 req 1.8)", () => {
	it("counts committed keeps and their bytes, null unless ready", async () => {
		const fx = await fixture()
		const svc = await fx.open()
		expect(svc.state()).toBe("ready")
		expect(svc.totals()).toEqual({ recordings: 0, bytes: 0 })
		await svc.keep(SCAN_ID)
		expect(svc.totals()).toEqual({ recordings: 1, bytes: 16_044 })
		await svc.keep(SCAN_ID)
		expect(svc.totals()).toEqual({ recordings: 1, bytes: 16_044 })
		await svc.unkeep(SCAN_ID)
		expect(svc.totals()).toEqual({ recordings: 0, bytes: 0 })
		await svc.keep(SCAN_ID)
		await svc.close()
		const again = await fx.open()
		expect(again.totals()).toEqual({ recordings: 1, bytes: 16_044 })
	})

	it("a failed store reports failed with null totals", async () => {
		const fx = await fixture()
		await writeFile(path.join(fx.stateDir, "recording-keeps.json"), "{bad")
		const svc = await fx.open()
		expect(svc.state()).toBe("failed")
		expect(svc.totals()).toBeNull()
	})
})

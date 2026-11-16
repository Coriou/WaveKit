/**
 * A scanner analog recording's `cut`, `part` and `parts` in the inventory: read from its receipt
 * (`.analog-operations/<id>/receipt.json` beside `recordings/`), mapped without guessing,
 * fail closed on a missing or malformed receipt, and numbered per observation in start order (a
 * name's leading stamp), else finish order.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import {
	createRecordingInventory,
	nodeRecordingFs,
	RECORDINGS_RECEIPT_WAIT_MS,
} from "../../../../src/core/recordings/inventory.js"
import {
	RECORDING_RECEIPT_MAX_BYTES,
	readRecordingReceipt,
	receiptFactsOf,
	recordingCutOf,
	recordingParts,
} from "../../../../src/core/recordings/recording-cut.js"

const logger = pino({ level: "silent" })
const roots: string[] = []
const closers: (() => void)[] = []
afterEach(async () => {
	for (const c of closers.splice(0)) c()
	await Promise.all(
		roots.splice(0).map(r => rm(r, { recursive: true, force: true })),
	)
})

const D = "d_01ABC"
const uuid = (n: number): string =>
	`00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

function wav(): Buffer {
	const b = Buffer.alloc(44 + 1600)
	b.write("RIFF", 0, "ascii")
	b.writeUInt32LE(36 + 1600, 4)
	b.write("WAVE", 8, "ascii")
	b.write("fmt ", 12, "ascii")
	b.writeUInt32LE(16, 16)
	b.writeUInt16LE(1, 20)
	b.writeUInt16LE(1, 22)
	b.writeUInt32LE(8000, 24)
	b.writeUInt32LE(16000, 28)
	b.writeUInt16LE(2, 32)
	b.writeUInt16LE(16, 34)
	b.write("data", 36, "ascii")
	b.writeUInt32LE(1600, 40)
	return b
}

function receipt(
	id: string,
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		version: 1,
		operationId: id,
		observationId: "o_1",
		outcome: "finalized",
		cutReason: "completed",
		...extra,
	}
}

async function storage(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "wk-rec-cut-"))
	roots.push(root)
	await mkdir(join(root, "recordings", "analog", D), { recursive: true })
	return root
}

/** An analog file finished `ageS` seconds ago, with `body` as its receipt (undefined: none). */
async function put(
	root: string,
	n: number,
	ageS: number,
	body?: unknown,
): Promise<string> {
	const id = uuid(n)
	const file = join(root, "recordings", "analog", D, `analog-${id}.wav`)
	await writeFile(file, wav())
	const at = (Date.now() - ageS * 1000) / 1000
	await utimes(file, at, at)
	if (body !== undefined) {
		const dir = join(root, ".analog-operations", id)
		await mkdir(dir, { recursive: true })
		await writeFile(
			join(dir, "receipt.json"),
			typeof body === "string" ? body : JSON.stringify(body),
		)
	}
	return `scan:${D}~analog-${id}.wav`
}

async function list(root: string) {
	const inv = createRecordingInventory({
		dsdFmeDirs: () => [],
		scannerRecordingsDir: () => join(root, "recordings"),
		logger,
	})
	closers.push(() => inv.close?.())
	return (await inv.list({})).items
}

describe("recordingCutOf", () => {
	it("maps only the reasons that mean the same thing; the rest and unknown are null", () => {
		expect(recordingCutOf("epoch-changed")).toBe("scanner-moved")
		expect(recordingCutOf("duration-limit")).toBe("duration-rollover")
		expect(recordingCutOf("source-lost")).toBe("source-lost")
		expect(recordingCutOf("shutdown")).toBe("shutdown")
		for (const other of [
			"completed",
			"track-ended",
			"cancelled",
			"discovery-deleted",
			"stream-changed",
			"channel-invalidated",
			"engine-failed",
			"something-new",
			null,
			undefined,
			42,
		])
			expect(recordingCutOf(other)).toBeNull()
	})
})

describe("receiptFactsOf", () => {
	it("reads a finalized receipt of the same operation, nothing else", () => {
		const id = uuid(1)
		expect(
			receiptFactsOf(receipt(id, { cutReason: "epoch-changed" }), id),
		).toEqual({ cut: "scanner-moved", observationId: "o_1" })
		expect(receiptFactsOf(receipt(id, { observationId: null }), id)).toEqual({
			cut: null,
			observationId: null,
		})
		expect(receiptFactsOf(receipt(uuid(2)), id)).toBeNull()
		expect(receiptFactsOf(receipt(id, { outcome: "aborted" }), id)).toBeNull()
		expect(receiptFactsOf(receipt(id, { version: 2 }), id)).toBeNull()
		expect(
			receiptFactsOf(receipt(id, { observationId: "../x" }), id),
		).toBeNull()
		expect(receiptFactsOf("not an object", id)).toBeNull()
		expect(receiptFactsOf(null, id)).toBeNull()
	})
})

describe("readRecordingReceipt", () => {
	it("reads up to RECORDING_RECEIPT_MAX_BYTES and refuses one byte past it", async () => {
		const root = await storage()
		const dir = join(root, ".analog-operations", uuid(1))
		await mkdir(dir, { recursive: true })
		const base = JSON.stringify(receipt(uuid(1), { cutReason: "shutdown" }))
		// Padded with trailing spaces (valid JSON) to exactly the bound, then one past it.
		const at = base + " ".repeat(RECORDING_RECEIPT_MAX_BYTES - base.length)
		expect(Buffer.byteLength(at)).toBe(16_384)
		await writeFile(join(dir, "receipt.json"), at)
		const name = `analog-${uuid(1)}.wav`
		const recordings = join(root, "recordings")
		expect(
			await readRecordingReceipt(nodeRecordingFs, recordings, name),
		).toEqual({ cut: "shutdown", observationId: "o_1" })
		await writeFile(join(dir, "receipt.json"), `${at} `)
		expect(
			await readRecordingReceipt(nodeRecordingFs, recordings, name),
		).toBeNull()
	})

	it("is null for a name that is not an analog file, and for a missing receipt", async () => {
		const root = await storage()
		const recordings = join(root, "recordings")
		expect(
			await readRecordingReceipt(nodeRecordingFs, recordings, "dv-1.wav"),
		).toBeNull()
		expect(
			await readRecordingReceipt(
				nodeRecordingFs,
				recordings,
				`analog-${uuid(9)}.wav`,
			),
		).toBeNull()
	})
})

describe("recordingParts", () => {
	it("numbers unstamped files in finish order (time, then id); a single file has none", () => {
		const a = { mtimeMs: 30, id: "a" }
		const b = { mtimeMs: 10, id: "b" }
		const c = { mtimeMs: 10, id: "c" }
		const out = recordingParts([a, b, c])
		expect(out.get(b)).toEqual({ part: 1, parts: 3 })
		expect(out.get(c)).toEqual({ part: 2, parts: 3 })
		expect(out.get(a)).toEqual({ part: 3, parts: 3 })
		expect(recordingParts([a]).get(a)).toEqual({ part: null, parts: null })
	})

	it("numbers files whose names carry a start stamp in start order, whatever their finish times", () => {
		// A part promoted late (parked for its close) finished after the part that followed it.
		const early = { mtimeMs: 50, id: "scan:d~20261115_101500_a.wav" }
		const late = { mtimeMs: 20, id: "scan:d~20261115_101700_b.wav" }
		const out = recordingParts([late, early])
		expect(out.get(early)).toEqual({ part: 1, parts: 2 })
		expect(out.get(late)).toEqual({ part: 2, parts: 2 })
		// An explicit name wins over the id's file part; equal starts fall back to finish order.
		const x = { mtimeMs: 9, id: "x", name: "20261115_101500_x.wav" }
		const y = { mtimeMs: 3, id: "y", name: "20261115_101500_y.wav" }
		const z = { mtimeMs: 1, id: "z", name: "20261115_101400_z.wav" }
		const named = recordingParts([x, y, z])
		expect([
			named.get(z)!.part,
			named.get(y)!.part,
			named.get(x)!.part,
		]).toEqual([1, 2, 3])
	})

	it("falls back to finish order for the whole group when any name has no parseable stamp", () => {
		// The store's analog names (analog-<uuid>.wav) carry no start; a bad date is unparseable.
		const stamped = { mtimeMs: 30, id: "scan:d~20261115_101500_a.wav" }
		const analog = { mtimeMs: 10, id: `scan:d~analog-${uuid(1)}.wav` }
		const bad = { mtimeMs: 20, id: "scan:d~20261345_101500_c.wav" }
		const out = recordingParts([stamped, analog, bad])
		expect(out.get(analog)).toEqual({ part: 1, parts: 3 })
		expect(out.get(bad)).toEqual({ part: 2, parts: 3 })
		expect(out.get(stamped)).toEqual({ part: 3, parts: 3 })
	})
})

describe("inventory cut and parts", () => {
	it("lists each receipt's cut and the observation's parts in finish order", async () => {
		const root = await storage()
		const first = await put(
			root,
			1,
			300,
			receipt(uuid(1), { cutReason: "duration-limit" }),
		)
		const second = await put(
			root,
			2,
			200,
			receipt(uuid(2), { cutReason: "duration-limit" }),
		)
		const last = await put(
			root,
			3,
			100,
			receipt(uuid(3), { cutReason: "epoch-changed" }),
		)
		// Another observation's single file: no part numbers.
		const alone = await put(
			root,
			4,
			50,
			receipt(uuid(4), { observationId: "o_2", cutReason: "source-lost" }),
		)
		const items = await list(root)
		const by = new Map(items.map(i => [i.id, i]))
		expect(by.get(first)).toMatchObject({
			cut: "duration-rollover",
			part: 1,
			parts: 3,
		})
		expect(by.get(second)).toMatchObject({
			cut: "duration-rollover",
			part: 2,
			parts: 3,
		})
		expect(by.get(last)).toMatchObject({
			cut: "scanner-moved",
			part: 3,
			parts: 3,
		})
		expect(by.get(alone)).toMatchObject({
			cut: "source-lost",
			part: null,
			parts: null,
		})
	})

	it("reads a missing, malformed or foreign receipt as null, never guessed", async () => {
		const root = await storage()
		const missing = await put(root, 1, 100)
		const garbage = await put(root, 2, 90, "{not json")
		const foreign = await put(
			root,
			3,
			80,
			receipt(uuid(7), { cutReason: "epoch-changed" }),
		)
		const unknown = await put(
			root,
			4,
			70,
			receipt(uuid(4), { observationId: null, cutReason: "new-reason" }),
		)
		const items = await list(root)
		for (const id of [missing, garbage, foreign, unknown])
			expect(items.find(i => i.id === id)).toMatchObject({
				cut: null,
				part: null,
				parts: null,
			})
	})
	it("re-reads a missing receipt of a young analog file on each pass up to RECORDINGS_RECEIPT_WAIT_MS after its last write, not past it", async () => {
		expect(RECORDINGS_RECEIPT_WAIT_MS).toBe(300_000)
		for (const [ageMs, read] of [
			[RECORDINGS_RECEIPT_WAIT_MS, true],
			[RECORDINGS_RECEIPT_WAIT_MS + 1, false],
		] as const) {
			const root = await storage()
			const n = read ? 1 : 2
			const id = uuid(n)
			const file = join(root, "recordings", "analog", D, `analog-${id}.wav`)
			await writeFile(file, wav())
			// A whole-second mtime well in the past: the injected clock sets its age exactly.
			const mtimeMs = Math.floor(Date.now() / 1000) * 1000 - 3_600_000
			await utimes(file, mtimeMs / 1000, mtimeMs / 1000)
			// First pass 60 s after the last write (settled, past the in-progress window): the
			// store linked the WAV but has not written its receipt yet.
			let clock = mtimeMs + 60_000
			const inv = createRecordingInventory({
				dsdFmeDirs: () => [],
				scannerRecordingsDir: () => join(root, "recordings"),
				logger,
				now: () => clock,
			})
			closers.push(() => inv.close?.())
			const key = `scan:${D}~analog-${id}.wav`
			const first = (await inv.list({})).items.find(i => i.id === key)
			expect(first).toMatchObject({ cut: null })
			// The receipt appears; the next pass runs at `ageMs` after the last write.
			const dir = join(root, ".analog-operations", id)
			await mkdir(dir, { recursive: true })
			await writeFile(
				join(dir, "receipt.json"),
				JSON.stringify(receipt(id, { cutReason: "epoch-changed" })),
			)
			clock = mtimeMs + ageMs
			await inv.touchDiscoveries?.([D])
			const second = (await inv.list({})).items.find(i => i.id === key)
			// At the bound it is read again (cut known); one ms past it the null stands.
			expect(second).toMatchObject({ cut: read ? "scanner-moved" : null })
		}
	})
})

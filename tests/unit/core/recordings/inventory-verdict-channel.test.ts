/**
 * The catalogue item's verdict facts and channel scopes: a scanner analog file's receipt carries
 * what the recorder knew at its finish (`keptBy`, `speechHeard`, `startedAt`, the observation),
 * listed as `keptBy`, `speech`, `startedAt` and `observationId`; anything missing or malformed
 * reads as unknown (`unchecked`, null). `channelHz` and `nearHz` + `toleranceHz` match the
 * owner's frequency (the channel frequency), and a `nearHz` listing counts its matches per
 * channel (`matchedByChannel`). Synthetic files and receipts only.
 */
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import {
	DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
	RECORDINGS_CHANNELS_MAX,
	RECORDINGS_NEAR_MAX_TOLERANCE_HZ,
} from "@wavekit/api-types"
import { parseInventoryQuery } from "../../../../src/core/recordings/cursor.js"
import {
	channelCounts,
	createRecordingInventory,
} from "../../../../src/core/recordings/inventory.js"
import {
	receiptFactsOf,
	recordingSpeechOf,
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

/** Two discovery folders on neighbouring 12.5 kHz channels (modelled). */
const A = { id: "d_01CHANA", hz: 446_006_250 }
const B = { id: "d_01CHANB", hz: 446_018_750.2 }
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
	const root = await mkdtemp(join(tmpdir(), "wk-rec-verdict-"))
	roots.push(root)
	for (const d of [A, B])
		await mkdir(join(root, "recordings", "analog", d.id), { recursive: true })
	return root
}

async function put(
	root: string,
	folder: string,
	n: number,
	body?: unknown,
): Promise<string> {
	const id = uuid(n)
	const file = join(root, "recordings", "analog", folder, `analog-${id}.wav`)
	await writeFile(file, wav())
	const at = (Date.now() - (600 - n) * 1000) / 1000
	await utimes(file, at, at)
	if (body !== undefined) {
		const dir = join(root, ".analog-operations", id)
		await mkdir(dir, { recursive: true })
		await writeFile(join(dir, "receipt.json"), JSON.stringify(body))
	}
	return `scan:${folder}~analog-${id}.wav`
}

function inventory(root: string) {
	const inv = createRecordingInventory({
		dsdFmeDirs: () => [],
		scannerRecordingsDir: () => join(root, "recordings"),
		discoveryOwner: id => {
			const d = [A, B].find(x => x.id === id)
			return d === undefined ? null : { id: d.id, frequencyHz: d.hz }
		},
		logger,
	})
	closers.push(() => inv.close?.())
	return inv
}

describe("the recorder's verdict on a catalogue item", () => {
	it("lists keptBy, speech, startedAt and the observation from the receipt; unknown when absent or malformed", async () => {
		const root = await storage()
		const heard = await put(
			root,
			A.id,
			1,
			receipt(uuid(1), {
				keptBy: "final",
				speechHeard: true,
				startedAt: "2026-11-16T10:00:00.250Z",
			}),
		)
		const silent = await put(
			root,
			A.id,
			2,
			receipt(uuid(2), {
				observationId: "o_2",
				keptBy: "prior-none",
				speechHeard: false,
			}),
		)
		const unmeasured = await put(
			root,
			A.id,
			3,
			receipt(uuid(3), { keptBy: "own-tone", speechHeard: null }),
		)
		// Older receipt (no verdict), and malformed values: unknown, never guessed.
		const older = await put(root, A.id, 4, receipt(uuid(4)))
		const malformed = await put(
			root,
			A.id,
			5,
			receipt(uuid(5), {
				keptBy: "Not A Code!",
				speechHeard: "yes",
				startedAt: "yesterday",
			}),
		)
		const noReceipt = await put(root, A.id, 6)
		const items = (await inventory(root).list({})).items
		const by = new Map(items.map(i => [i.id, i]))
		expect(by.get(heard)).toMatchObject({
			keptBy: "final",
			speech: "heard",
			startedAt: "2026-11-16T10:00:00.250Z",
			observationId: "o_1",
		})
		expect(by.get(silent)).toMatchObject({
			keptBy: "prior-none",
			speech: "not-heard",
			startedAt: null,
			observationId: "o_2",
		})
		expect(by.get(unmeasured)).toMatchObject({
			keptBy: "own-tone",
			speech: "unchecked",
		})
		for (const id of [older, malformed, noReceipt])
			expect(by.get(id)).toMatchObject({
				keptBy: null,
				speech: "unchecked",
				startedAt: null,
			})
		expect(by.get(noReceipt)?.observationId).toBeNull()
	})

	it("reads speech only from a boolean, and an ISO time with a zone in UTC", () => {
		expect(recordingSpeechOf(true)).toBe("heard")
		expect(recordingSpeechOf(false)).toBe("not-heard")
		for (const other of [null, undefined, 1, "true", {}])
			expect(recordingSpeechOf(other)).toBe("unchecked")
		const id = uuid(9)
		expect(
			receiptFactsOf(
				receipt(id, { startedAt: "2026-11-16T12:00:00.000+02:00" }),
				id,
			)?.startedAt,
		).toBe("2026-11-16T10:00:00.000Z")
		expect(
			receiptFactsOf(receipt(id, { startedAt: "2026-11-16T12:00:00" }), id)
				?.startedAt,
		).toBeNull()
	})
})

describe("recordings of a channel", () => {
	async function scene() {
		const root = await storage()
		const onA = [
			await put(root, A.id, 1, receipt(uuid(1))),
			await put(root, A.id, 2, receipt(uuid(2))),
		]
		const onB = [await put(root, B.id, 3, receipt(uuid(3)))]
		return { inv: inventory(root), onA, onB }
	}

	it("channelHz matches the channel frequency in whole Hz, nearHz the channels within the tolerance", async () => {
		const { inv, onA, onB } = await scene()
		const a = await inv.list({ channelHz: A.hz })
		expect(a.items.map(i => i.id).sort()).toEqual([...onA].sort())
		expect(a.matched).toBe(2)
		expect(a.matchedByChannel).toBeUndefined()
		const b = await inv.list({ channelHz: String(Math.round(B.hz)) })
		expect(b.items.map(i => i.id)).toEqual(onB)
		// The default tolerance (6.25 kHz) holds A only; 12.5 kHz holds both.
		const near = await inv.list({ nearHz: A.hz })
		expect(near.matched).toBe(2)
		expect(near.matchedByChannel).toEqual([{ frequencyHz: A.hz, count: 2 }])
		const wide = await inv.list({ nearHz: A.hz, toleranceHz: 12_500 })
		expect(wide.matched).toBe(3)
		expect(wide.matchedByChannel).toEqual([
			{ frequencyHz: A.hz, count: 2 },
			{ frequencyHz: Math.round(B.hz), count: 1 },
		])
		const sum = (wide.matchedByChannel ?? []).reduce((n, c) => n + c.count, 0)
		expect(sum).toBe(wide.matched)
		expect((await inv.list({ channelHz: A.hz + 1 })).matched).toBe(0)
	})

	it("refuses a contradictory or out-of-range channel scope", () => {
		expect(parseInventoryQuery({ toleranceHz: "10" })).toBeNull()
		expect(parseInventoryQuery({ channelHz: "1", nearHz: "1" })).toBeNull()
		expect(parseInventoryQuery({ channelHz: "1.5" })).toBeNull()
		expect(
			parseInventoryQuery({
				nearHz: "1",
				toleranceHz: String(RECORDINGS_NEAR_MAX_TOLERANCE_HZ),
			}),
		).toMatchObject({ nearToleranceHz: RECORDINGS_NEAR_MAX_TOLERANCE_HZ })
		expect(
			parseInventoryQuery({
				nearHz: "1",
				toleranceHz: String(RECORDINGS_NEAR_MAX_TOLERANCE_HZ + 1),
			}),
		).toBeNull()
		expect(parseInventoryQuery({ nearHz: "5" })).toMatchObject({
			nearHz: 5,
			nearToleranceHz: DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
		})
	})

	it("matchedByChannel keeps the RECORDINGS_CHANNELS_MAX largest, count then frequency", () => {
		const many = new Map<number, number>()
		for (let i = 0; i <= RECORDINGS_CHANNELS_MAX; i++)
			many.set(1000 + i, i === 5 ? 3 : 1)
		const out = channelCounts(many)
		expect(out).toHaveLength(RECORDINGS_CHANNELS_MAX)
		expect(out[0]).toEqual({ frequencyHz: 1005, count: 3 })
		expect(out[1]).toEqual({ frequencyHz: 1000, count: 1 })
		expect(out.at(-1)?.frequencyHz).toBe(1000 + RECORDINGS_CHANNELS_MAX - 1)
		const exactly = new Map([...many].slice(0, RECORDINGS_CHANNELS_MAX))
		expect(channelCounts(exactly)).toHaveLength(RECORDINGS_CHANNELS_MAX)
	})
})

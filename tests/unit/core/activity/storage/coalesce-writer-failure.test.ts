/**
 * Held entity rows through an asynchronous writer (as the worker thread writes): a write that
 * settles after the coalesce timer's callback, and a writer that dies with a held row in flight.
 * The writer here wraps the inline SQLite session, so each write settles when the test says.
 */
import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ActivityWriter } from "../../../../../src/core/activity/storage/store.js"
import { ActivityUnavailableError } from "../../../../../src/core/activity/storage/errors.js"
import type {
	ActivitySession,
	WriterWorkResult,
} from "../../../../../src/core/activity/storage/writer-session.js"
import type { BuiltActivityRow } from "../../../../../src/core/activity/storage/row.js"
import type { DecodeEnvelope } from "../../../../../src/core/activity/types.js"
import {
	envelope,
	FIXTURE_CLOCK_ANCHOR_MS,
	openStore,
	readRecords,
	roots,
	stores,
} from "./helpers.js"

afterEach(async () => {
	vi.useRealTimers()
	await Promise.all(
		stores.splice(0).map(store => store.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

const T0 = FIXTURE_CLOCK_ANCHOR_MS
const WINDOW = 1_000
const RETRY = 250

function plane(icao: string, at: number, lat = 1): DecodeEnvelope {
	return envelope({
		eventId: `${icao}-${at}`,
		decoderId: "adsb",
		outputType: "aircraft",
		receivedAt: new Date(at).toISOString(),
		decodedData: { icao, lat, lon: 2 },
	})
}

interface Pending {
	rows: readonly BuiltActivityRow[]
	nowMs: number
	resolve: (result: WriterWorkResult) => void
	reject: (error: Error) => void
}

/** Writes pass straight through unless the test fails or holds the next ones. */
class GatedWriter implements ActivityWriter {
	failNext = 0
	hold = false
	pending: Pending | undefined
	writes = 0
	private dead = false
	private gone: (() => void) | undefined

	constructor(private readonly session: ActivitySession) {}

	onGone(listener: () => void): void {
		this.gone = listener
	}

	onSeeded(): void {}

	write(
		rows: readonly BuiltActivityRow[],
		nowMs: number,
	): Promise<WriterWorkResult> {
		this.writes++
		if (this.dead)
			return Promise.reject(
				new ActivityUnavailableError("activity writer is gone"),
			)
		if (this.failNext > 0) {
			this.failNext--
			return Promise.resolve({ ok: false, message: "write failed" })
		}
		if (this.hold)
			return new Promise((resolve, reject) => {
				this.pending = { rows, nowMs, resolve, reject }
			})
		return Promise.resolve(this.session.write(rows, nowMs))
	}

	/** As the worker client does on exit: the store hears first, then the request fails. */
	die(): void {
		this.dead = true
		this.gone?.()
		this.pending?.reject(new ActivityUnavailableError("activity writer exited"))
		this.pending = undefined
	}

	checkpoint(
		reason: "threshold" | "close",
	): ReturnType<ActivityWriter["checkpoint"]> {
		return Promise.resolve(this.session.checkpoint(reason))
	}

	close(): Promise<void> {
		this.session.close()
		return Promise.resolve()
	}
}

async function open(maxEntities?: number) {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: T0 })
	let writer: GatedWriter | undefined
	const store = await openStore({
		now: () => Date.now(),
		inlineWriter: session => (writer = new GatedWriter(session)),
		limits: {
			batchWindowMs: 0,
			positionCoalesceMs: WINDOW,
			pauseRetryMs: RETRY,
			...(maxEntities === undefined
				? {}
				: { positionCoalesceMaxEntities: maxEntities }),
		},
	})
	if (!writer) throw new Error("writer not created")
	return { store, writer }
}

describe("held entity rows and an asynchronous writer", () => {
	it("retries a held row whose write failed after the coalesce timer ran, with no further input", async () => {
		const { store, writer } = await open()
		expect(store.admit(plane("A00001", T0)).admitted).toBe(true)
		await vi.advanceTimersByTimeAsync(0)
		expect(store.admit(plane("A00001", T0 + 100, 1.5))).toEqual({
			admitted: false,
			reason: "coalesced",
		})
		writer.failNext = 1
		// The timer queues the held row; its write fails on a later turn.
		await vi.advanceTimersByTimeAsync(WINDOW + 100)
		expect(writer.writes).toBe(2)
		expect(writer.failNext).toBe(0)
		// The source is silent: only a timer can carry the restored receptions.
		await vi.advanceTimersByTimeAsync(WINDOW + RETRY)
		const records = await readRecords(store.dbPath)
		expect(records).toHaveLength(2)
		expect(store.stats().dropped["write-failed"]).toBe(0)
		expect(store.stats().queueDepth).toBe(0)
	})

	it("does not spin while the writer keeps failing: a restored row waits its window again", async () => {
		const { store, writer } = await open()
		expect(store.admit(plane("A00001", T0)).admitted).toBe(true)
		await vi.advanceTimersByTimeAsync(0)
		store.admit(plane("A00001", T0 + 100, 1.5))
		writer.failNext = 1_000
		await vi.advanceTimersByTimeAsync(WINDOW + 100)
		const after = writer.writes
		await vi.advanceTimersByTimeAsync(4 * WINDOW)
		expect(writer.writes - after).toBeGreaterThanOrEqual(1)
		expect(writer.writes - after).toBeLessThanOrEqual(4)
		writer.failNext = 0
		await vi.advanceTimersByTimeAsync(2 * WINDOW)
		expect(await readRecords(store.dbPath)).toHaveLength(2)
		expect(store.stats().dropped["write-failed"]).toBe(0)
	})

	it("retries an evicted entity's restored row one window after its failed write, not every pauseRetryMs", async () => {
		const { store, writer } = await open(1)
		expect(store.admit(plane("A00001", T0)).admitted).toBe(true)
		await vi.advanceTimersByTimeAsync(0)
		store.admit(plane("A00001", T0 + 100, 1.5))
		// B evicts A: A's held row is queued with B's and held in flight past A's due
		// time, so no coalesce timer is armed when that write fails.
		writer.hold = true
		expect(store.admit(plane("B00001", T0 + 200)).admitted).toBe(true)
		await vi.advanceTimersByTimeAsync(WINDOW + 100)
		expect(writer.pending?.rows).toHaveLength(2)
		writer.hold = false
		writer.failNext = 1_000
		const after = writer.writes
		writer.pending?.resolve({ ok: false, message: "write failed" })
		// Several pauseRetryMs pass: nothing is tried before the window.
		await vi.advanceTimersByTimeAsync(WINDOW - 10)
		expect(writer.writes - after).toBe(0)
		await vi.advanceTimersByTimeAsync(20)
		expect(writer.writes - after).toBe(1)
		writer.failNext = 0
		await vi.advanceTimersByTimeAsync(WINDOW + RETRY)
		const kinds = (await readRecords(store.dbPath)).map(r => r.kind)
		// B's own row was a counted loss; A's first sighting and its held row are stored.
		expect(kinds.filter(kind => kind === "decoder-reception")).toHaveLength(2)
		expect(store.stats().dropped["write-failed"]).toBe(1)
	})

	it("counts a held row in flight when the writer dies, and every row still held", async () => {
		const { store, writer } = await open()
		expect(store.admit(plane("A00001", T0)).admitted).toBe(true)
		expect(store.admit(plane("B00001", T0 + 10)).admitted).toBe(true)
		await vi.advanceTimersByTimeAsync(0)
		expect(store.admit(plane("A00001", T0 + 100, 1.5))).toMatchObject({
			reason: "coalesced",
		})
		await vi.advanceTimersByTimeAsync(100)
		expect(store.admit(plane("B00001", T0 + 200, 1.5))).toMatchObject({
			reason: "coalesced",
		})
		writer.hold = true
		// A's held row is due and in flight; B's is still held when the writer dies.
		await vi.advanceTimersByTimeAsync(WINDOW - 50)
		expect(writer.pending?.rows).toHaveLength(1)
		writer.die()
		await vi.advanceTimersByTimeAsync(0)
		const stats = store.stats()
		expect(stats.writer).toBe("stopped")
		expect(stats.dropped["write-failed"]).toBe(2)
		expect(stats.queueDepth).toBe(0)
		// Nothing is left held for a later flush to find.
		await store.close()
		expect(store.stats().dropped["write-failed"]).toBe(2)
	})
})

import { rm } from "node:fs/promises"
import { afterEach, describe, expect, it } from "vitest"
import { envelope, openStore, readRecords, roots, stores } from "./helpers.js"

afterEach(async () => {
	await Promise.all(
		stores.splice(0).map(store => store.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

const T0 = Date.parse("2026-10-13T00:00:00.000Z")
const AIRCRAFT = 10
const SECONDS = 600

/**
 * A rare page at t=0, then a busy ADS-B feed: 10 aircraft at 1 Hz for 10
 * minutes (6,000 receptions) against the minimum row cap of 1,000. Returns
 * whether the page is still stored and the row count.
 */
async function busyFeed(positionCoalesceMs: number) {
	const store = await openStore({
		limits: {
			maxRows: 1_000,
			globalRatePerSec: 1_000_000,
			globalBurst: 1_000_000,
			decoderRatePerSec: 100_000,
			decoderBurst: 1_000_000,
			positionCoalesceMs,
			// Batch the feed so the test stays fast; nothing is dropped.
			batchWindowMs: 1,
			batchMaxItems: 512,
			queueMaxItems: 100_000,
			queueMaxBytes: 256 * 1024 * 1024,
		},
	})
	expect(
		store.admit(
			envelope({
				eventId: "rare-page",
				decoderId: "pocsag",
				outputType: "page",
				protocol: "pocsag",
				category: "paging",
				receivedAt: new Date(T0).toISOString(),
				decodedData: { capcode: 1234567, message: "rare" },
			}),
		).admitted,
	).toBe(true)
	for (let s = 1; s <= SECONDS; s++) {
		if (s % 30 === 0) await new Promise(resolve => setTimeout(resolve, 5))
		for (let a = 0; a < AIRCRAFT; a++)
			store.admit(
				envelope({
					decoderId: "readsb",
					outputType: "aircraft",
					receivedAt: new Date(T0 + s * 1_000).toISOString(),
					decodedData: { icao: `abc${a}`, lat: 51 + s / 1e4, lon: 4 },
				}),
			)
	}
	await new Promise(resolve => setTimeout(resolve, 100))
	const records = await readRecords(store.dbPath)
	return {
		rareKept: records.some(r => r.eventId === "rare-page"),
		rows: records.length,
		coalesced: store.stats().coalescedPositions,
		dropped: Object.values(store.stats().dropped).reduce((a, b) => a + b, 0),
	}
}

// WG1 req 7.8: coalescing keeps rare events past a busy position feed.
describe("position coalescing and retention", () => {
	it("keeps a rare page through 10 minutes of a busy ADS-B feed at the row cap", async () => {
		const on = await busyFeed(60_000)
		// 10 aircraft, one stored update per minute each: 10 + 10 × 10 rows.
		expect(on.rows).toBe(1 + AIRCRAFT * (SECONDS / 60 + 0))
		expect(on.rareKept).toBe(true)
		expect(on.dropped).toBe(0)
		expect(on.coalesced).toBe(AIRCRAFT * SECONDS - AIRCRAFT * (SECONDS / 60))
	}, 20_000)

	it("loses the same page within seconds of the feed without coalescing", async () => {
		const off = await busyFeed(0)
		expect(off.rareKept).toBe(false)
		expect(off.dropped).toBe(0)
		expect(off.rows).toBeLessThanOrEqual(1_000)
		expect(off.coalesced).toBe(0)
	}, 20_000)
})

// WG1 req 7.9: a failed write rolls back the entity's coalescing state.
describe("position coalescing and failed writes", () => {
	it("stores the retransmission of a name-bearing report whose first write failed", async () => {
		const store = await openStore({ failNextWrites: 1 })
		const report = (eventId: string, ms: number) =>
			envelope({
				eventId,
				decoderId: "readsb",
				outputType: "aircraft",
				receivedAt: new Date(T0 + ms).toISOString(),
				decodedData: { icao: "abc123", callsign: "UAL1", lat: 51, lon: 4 },
			})
		expect(store.admit(report("lost", 0)).admitted).toBe(true)
		await new Promise(resolve => setTimeout(resolve, 20))
		expect(store.admit(report("retry", 1_000)).admitted).toBe(true)
		await new Promise(resolve => setTimeout(resolve, 20))
		const records = await readRecords(store.dbPath)
		expect(records.map(r => r.eventId)).toEqual(["retry"])
		expect(store.admit(report("again", 2_000))).toEqual({
			admitted: false,
			reason: "coalesced",
		})
	})
})

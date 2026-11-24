/**
 * Rollback proof for transmission ids in Activity: rows written the way this core writes them (a
 * `recording-change` with txId, moreTxIds and startedAt, an `analog-transmission` with txId, a
 * call row with a txId ref, and their `txId` refs in activity_refs) go into a real store and are
 * read back through every production read path: search, detail, facets, band map, timeline,
 * trails and the channel ref. None answers ACTIVITY_RECORD_CORRUPT.
 *
 * Why this covers an older core: the read modules (query/read.ts readSummary/readRecord and the
 * channel ref read, query/trails.ts, query/aggregates.ts) are unchanged since the base, and they
 * read record_json and summary_json loosely, check only kind and category columns (P1 adds no
 * kind or category) and read activity_refs only by a named ref type (`txId` rows are never read
 * by them). The strict payload checks (storage/row.ts isRecordingChange, transmissionKeysOk) run
 * only when a core builds a row from its own new record, never on stored rows.
 *
 * Also: a summary relinked the old way (summaryWithRecording rebuilds it from the keys it knows)
 * still yields the id and the file's start through record_json, on the detail read and the route.
 */
import { afterEach, describe, expect, it } from "vitest"
import type { TransmissionDto } from "@wavekit/api-types"
import { ActivityQueryError } from "../../../../src/core/activity/query/errors.js"
import {
	TX_A,
	TX_B,
	TX_C,
	harness,
	keyOf,
	type Harness,
} from "../../api/transmission-harness.js"

const at = Date.now()

async function noCorrupt<T>(run: () => Promise<T>): Promise<T> {
	try {
		return await run()
	} catch (err) {
		if (err instanceof ActivityQueryError)
			throw new Error(`read failed: ${err.code}`)
		throw err
	}
}

describe("P1 Activity rows through the production read paths", () => {
	let h: Harness | null = null
	afterEach(async () => {
		await h?.close()
		h = null
	})

	async function written(): Promise<Harness> {
		const hh = await harness(at)
		hh.kept({
			recordingId: keyOf(1),
			txId: TX_A,
			moreTxIds: [TX_B],
			startedAt: new Date(at - 3_500).toISOString(),
			channel: { discoveryId: "d_01JTESTDISCOVERY", frequencyHz: 100_000_000 },
		})
		hh.analog({
			transmissionId: "t-1",
			txId: TX_A,
			tone: { ctcssHz: 88.5, dtmf: null, dcs: null },
		})
		hh.publish("dsd-a", {
			timestamp: new Date(at),
			decoder: "dsd-a",
			type: "call_end",
			data: {
				callId: "call-1",
				protocol: "ysf",
				talkgroup: 100,
				source: 2001,
				duration: 4_200,
				encryptionKnown: true,
				flags: { encrypted: false },
				txId: TX_C,
			},
		})
		await hh.rows(3)
		return hh
	}

	it("search, detail, facets, band map, timeline, trails and refs read every row", async () => {
		h = await written()
		const service = h.runtime.service
		const all = await noCorrupt(() => service.search({ query: {}, limit: 100 }))
		expect(new Set(all.items.map(i => i.kind))).toEqual(
			new Set(["recording-change", "analog-transmission", "decoder-reception"]),
		)
		for (const item of all.items) {
			const record = await noCorrupt(() => service.detail(item.eventId))
			expect(record?.eventId).toBe(item.eventId)
		}
		// Each txId ref finds its rows (the file names both of its transmissions).
		const byRef = async (value: string) =>
			(
				await noCorrupt(() =>
					service.search({ query: { refs: [{ type: "txId", value }] } }),
				)
			).items.map(i => i.kind)
		expect((await byRef(TX_A)).sort()).toEqual([
			"analog-transmission",
			"recording-change",
		])
		expect(await byRef(TX_B)).toEqual(["recording-change"])
		expect(await byRef(TX_C)).toEqual(["decoder-reception"])
		// The older ref types still answer beside the txId rows.
		expect(
			(
				await noCorrupt(() =>
					service.search({
						query: { refs: [{ type: "recordingId", value: keyOf(1) }] },
					}),
				)
			).items.map(i => i.kind),
		).toEqual(["recording-change"])
		const facets = await noCorrupt(() =>
			service.facets({
				query: {},
				dimensions: [
					"category",
					"protocol",
					"decoderId",
					"sourceId",
					"kind",
					"channel",
				],
			}),
		)
		expect(facets.scanned).toBe(3)
		// The channel ref read (a channel query over the stored channel refs).
		const channel = await noCorrupt(() =>
			service.search({ query: { channelHz: 100_000_000 } }),
		)
		expect(channel.items.map(i => i.kind)).toContain("recording-change")
		const window = {
			producedFrom: new Date(at - 3_600_000).toISOString(),
			producedTo: new Date(at + 60_000).toISOString(),
		}
		await noCorrupt(() => service.bandMap(window))
		const timeline = await noCorrupt(() => service.timeline(window))
		expect(timeline).toBeDefined()
		await noCorrupt(() => service.trails(window))
	})

	it("a summary relinked the old way keeps the id and start in record_json, for detail and the route", async () => {
		h = await written()
		const service = h.runtime.service
		const before = (
			await service.search({
				query: { refs: [{ type: "txId", value: TX_B }] },
			})
		).items[0]!
		expect(before.recording?.id).toBe(keyOf(1))
		// The file was deleted: the link op rebuilds the summary from its known keys.
		h.runtime.recordingLinks?.()?.link({
			type: "unlink",
			recordingIds: [keyOf(1)],
		})
		await expect
			.poll(
				async () =>
					(await service.search({ query: { hasRecording: true } })).items
						.length,
			)
			.toBe(0)
		const after = (
			await service.search({
				query: { refs: [{ type: "txId", value: TX_B }] },
			})
		).items[0]!
		expect(after.eventId).toBe(before.eventId)
		expect(after).not.toHaveProperty("recording")
		expect(after).not.toHaveProperty("txId")
		const record = await service.detail(after.eventId)
		expect(record).toMatchObject({
			kind: "recording-change",
			payload: {
				txId: TX_A,
				moreTxIds: [TX_B],
				startedAt: new Date(at - 3_500).toISOString(),
			},
		})
		// The route: no registry entry, the file gone; the id and the file start come from the record.
		const app = await h.app()
		const res = await app.inject({
			method: "GET",
			url: `/api/transmissions/${encodeURIComponent(`evt:${after.eventId}`)}`,
		})
		expect(res.statusCode).toBe(200)
		const dto = res.json<TransmissionDto>()
		expect(dto.id).toBe(TX_A)
		expect(dto.refs.recordingKeys).toContain(keyOf(1))
		expect(dto.gone).toContain("audio")
		const byTx = await app.inject({
			method: "GET",
			url: `/api/transmissions/${TX_B}`,
		})
		expect(byTx.statusCode).toBe(200)
		expect(byTx.json<TransmissionDto>()).toMatchObject({
			id: TX_B,
			startedAt: new Date(at - 3_500).toISOString(),
		})
	})
})

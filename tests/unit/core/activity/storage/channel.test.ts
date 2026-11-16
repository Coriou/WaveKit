/**
 * Channels in the Activity store: a row's `channel` (its raster frequency and discovery) lives in
 * its summary and in one internal `channelHz` ref; `channelHz` and `nearHz` + `toleranceHz` read
 * it, rows without one (stored before it existed) match by their own frequency within half the
 * fallback step and the answer says `channelMatch: "mixed"`; the `channel` facet counts rows per
 * channel. A scanner recording kept on a channel is titled "FM voice" on the channel frequency,
 * the measured centre kept in its record. Synthetic rows only.
 */
import { rm } from "node:fs/promises"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import {
	ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ,
	ACTIVITY_CHANNEL_NEAR_MAX_TOLERANCE_HZ,
} from "@wavekit/api-types"
import { withEnvelopeMetadata } from "../../../../../src/core/activity/envelope.js"
import { createActivityQueryService } from "../../../../../src/core/activity/query/service.js"
import type {
	ActivityStoreHandle,
	RecordingChangePayload,
} from "../../../../../src/core/activity/storage/contract.js"
import { MAX_SUMMARY_BYTES } from "../../../../../src/core/activity/storage/contract.js"
import {
	activityChannelOf,
	buildActivityRow,
	CHANNEL_MAX_HZ,
	CHANNEL_REF_DIGITS,
	channelHzOfRef,
	channelRefValue,
	isActivityChannel,
	rowWithRecording,
	SCANNER_RECORDING_TITLE,
} from "../../../../../src/core/activity/storage/row.js"
import type { DecodeEnvelope } from "../../../../../src/core/activity/types.js"
import { envelope, logger, openStore, roots, stores } from "./helpers.js"

const CHANNEL_HZ = 446_006_250
const DISCOVERY = "d_01JTESTCHANNEL"
const SCAN_KEY = `scan:${DISCOVERY}~analog-6f0a2c1e-1111-4222-8333-444455556666.wav`

afterEach(async () => {
	await Promise.all(
		stores.splice(0).map(store => store.close().catch(() => undefined)),
	)
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

function service(store: ActivityStoreHandle) {
	return createActivityQueryService({ store, logger, execution: "inline" })
}

/** A kept scanner file: measured 300 Hz above its channel; `channel` absent = an older record. */
function kept(
	channel: RecordingChangePayload["channel"] | undefined,
	patch: Partial<RecordingChangePayload> = {},
): RecordingChangePayload {
	return {
		change: "finalized",
		recordingId: SCAN_KEY,
		recordingKind: "scanner-analog",
		discoveryId: DISCOVERY,
		observationId: "o_01JTESTOBSERVATION",
		sourceId: "source-1",
		frequencyHz: CHANNEL_HZ + 300,
		observationStartedAt: "2026-10-12T00:00:00.000Z",
		durationMs: 3500,
		finalizedAt: "2026-10-12T00:00:30.000Z",
		...(channel === undefined ? {} : { channel }),
		...patch,
	}
}

/** A voice reception at `hz` (no entity: never coalesced), on `channel` when given. */
function voice(
	eventId: string,
	hz: number | null,
	channel?: { discoveryId: string | null; frequencyHz: number },
): DecodeEnvelope {
	const plain = envelope({
		eventId,
		decoderId: "scan-abc1234-dstar-1",
		outputType: "call_start",
		protocol: "dstar",
		category: "voice",
		entityKey: null,
		title: "N0CALL → CQCQCQ",
		frequencyHz: hz,
	})
	return channel === undefined
		? plain
		: withEnvelopeMetadata(plain, { channel })
}

describe("a row's channel", () => {
	it("a recording kept on a channel is FM voice on the channel frequency; its record keeps the measured centre", async () => {
		const store = await openStore()
		const payload = kept({ discoveryId: DISCOVERY, frequencyHz: CHANNEL_HZ })
		expect(
			store.admitRecording?.({
				payload,
				receivedAt: "2026-10-12T00:00:30.100Z",
			}),
		).toEqual({ admitted: true })
		const q = service(store)
		const page = await q.search({ query: { channelHz: CHANNEL_HZ } })
		expect(page.channelMatch).toBe("exact")
		expect(page.items).toHaveLength(1)
		const item = page.items[0]!
		expect(item).toMatchObject({
			kind: "recording-change",
			title: SCANNER_RECORDING_TITLE,
			frequencyHz: CHANNEL_HZ,
			channel: { discoveryId: DISCOVERY, frequencyHz: CHANNEL_HZ },
			recording: { id: SCAN_KEY, durationMs: 3500 },
		})
		expect(item.title).not.toMatch(/\d/)
		const detail = await q.detail(item.eventId)
		expect(detail?.kind === "recording-change" && detail.payload).toMatchObject(
			{
				frequencyHz: CHANNEL_HZ + 300,
				channel: { discoveryId: DISCOVERY, frequencyHz: CHANNEL_HZ },
			},
		)
		await q.close()
	})

	it("an older recording record keeps its title and frequency, and matches by its frequency (mixed)", async () => {
		const store = await openStore()
		store.admitRecording?.({
			payload: kept(undefined),
			receivedAt: "2026-10-12T00:00:30.100Z",
		})
		const q = service(store)
		const page = await q.search({ query: { channelHz: CHANNEL_HZ } })
		expect(page.items).toHaveLength(1)
		expect(page.items[0]).toMatchObject({
			title: "Recording 446.00655 MHz",
			frequencyHz: CHANNEL_HZ + 300,
		})
		expect(page.items[0]?.channel).toBeUndefined()
		expect(page.channelMatch).toBe("mixed")
		await q.close()
	})

	it("a probe reception's channel is in its summary and finds it by its discovery", async () => {
		const store = await openStore()
		const on = voice("probe-row", CHANNEL_HZ - 600, {
			discoveryId: DISCOVERY,
			frequencyHz: CHANNEL_HZ,
		})
		expect(store.admit(on)).toEqual({ admitted: true })
		const q = service(store)
		const page = await q.search({ query: { channelHz: CHANNEL_HZ } })
		expect(page.items.map(i => i.eventId)).toEqual(["probe-row"])
		expect(page.items[0]).toMatchObject({
			frequencyHz: CHANNEL_HZ - 600,
			channel: { discoveryId: DISCOVERY, frequencyHz: CHANNEL_HZ },
		})
		const byDiscovery = await q.search({
			query: { refs: [{ type: "discoveryId", value: DISCOVERY }] },
		})
		expect(byDiscovery.items.map(i => i.eventId)).toEqual(["probe-row"])
		await q.close()
	})

	it("channelHz, nearHz and the channel facet agree with the list over new and old rows", async () => {
		const store = await openStore()
		const next = CHANNEL_HZ + 12_500
		const rows = [
			voice("on-a", CHANNEL_HZ + 400, {
				discoveryId: DISCOVERY,
				frequencyHz: CHANNEL_HZ,
			}),
			voice("on-a-2", CHANNEL_HZ - 800, {
				discoveryId: null,
				frequencyHz: CHANNEL_HZ,
			}),
			// Measured far off, but stored on its channel: the channel decides, never the carrier.
			voice("far-carrier", CHANNEL_HZ + 9_000, {
				discoveryId: DISCOVERY,
				frequencyHz: CHANNEL_HZ,
			}),
			voice("on-b", next + 100, {
				discoveryId: "d_01JTESTNEXT",
				frequencyHz: next,
			}),
			// Old rows: inside [c − half, c + half) match; the upper edge belongs to the next channel.
			voice(
				"old-low-edge",
				CHANNEL_HZ - ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ,
			),
			voice(
				"old-high-edge",
				CHANNEL_HZ + ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ,
			),
			voice("old-no-frequency", null),
			voice("far", CHANNEL_HZ + 200_000, {
				discoveryId: null,
				frequencyHz: CHANNEL_HZ + 200_000,
			}),
		]
		for (const row of rows) expect(store.admit(row)).toEqual({ admitted: true })
		const q = service(store)
		const exact = await q.search({ query: { channelHz: CHANNEL_HZ } })
		expect(exact.items.map(i => i.eventId).sort()).toEqual(
			["far-carrier", "old-low-edge", "on-a", "on-a-2"].sort(),
		)
		expect(exact.channelMatch).toBe("mixed")
		const facets = await q.facets({
			query: { channelHz: CHANNEL_HZ },
			dimensions: ["channel"],
		})
		expect(facets.channelMatch).toBe("mixed")
		expect(facets.facets["channel"]).toEqual([
			{ value: String(CHANNEL_HZ), count: 3 },
			{ value: null, count: 1 },
		])
		const sum = (facets.facets["channel"] ?? []).reduce(
			(n, f) => n + f.count,
			0,
		)
		expect(sum).toBe(exact.items.length)

		const near = { nearHz: CHANNEL_HZ, toleranceHz: 12_500 }
		const nearby = await q.search({ query: near })
		expect(nearby.items.map(i => i.eventId).sort()).toEqual(
			[
				"far-carrier",
				"old-high-edge",
				"old-low-edge",
				"on-a",
				"on-a-2",
				"on-b",
			].sort(),
		)
		const nearFacets = await q.facets({
			query: near,
			dimensions: ["channel", "kind"],
		})
		expect(nearFacets.facets["channel"]).toEqual([
			{ value: String(CHANNEL_HZ), count: 3 },
			{ value: null, count: 2 },
			{ value: String(next), count: 1 },
		])
		const nearSum = (nearFacets.facets["channel"] ?? []).reduce(
			(n, f) => n + f.count,
			0,
		)
		expect(nearSum).toBe(nearby.items.length)

		// Only rows with a stored channel: exact.
		const onB = await q.search({ query: { channelHz: next } })
		expect(onB.items.map(i => i.eventId).sort()).toEqual(
			["old-high-edge", "on-b"].sort(),
		)
		const farOnly = await q.search({
			query: { channelHz: CHANNEL_HZ + 200_000 },
		})
		expect(farOnly.items.map(i => i.eventId)).toEqual(["far"])
		expect(farOnly.channelMatch).toBe("exact")
		// No channel scope: no channelMatch, every dimension in one read.
		const plain = await q.search({ query: {} })
		expect(plain.channelMatch).toBeUndefined()
		const all = await q.facets({
			query: {},
			dimensions: [
				"category",
				"protocol",
				"decoderId",
				"sourceId",
				"kind",
				"channel",
			],
		})
		expect(all.channelMatch).toBeUndefined()
		expect((all.facets["channel"] ?? []).reduce((n, f) => n + f.count, 0)).toBe(
			rows.length,
		)
		await q.close()
	})

	it("channelMatch is exact when every in-scope row carries a channel, even one whose carrier sits in the fallback window", async () => {
		const store = await openStore()
		const rows = [
			voice("on-a", CHANNEL_HZ + 400, {
				discoveryId: DISCOVERY,
				frequencyHz: CHANNEL_HZ,
			}),
			voice("on-a-2", CHANNEL_HZ - 700, {
				discoveryId: null,
				frequencyHz: CHANNEL_HZ,
			}),
			// Its carrier is inside this channel's fallback window, but it is stored on the next
			// channel: it neither matches nor makes the answer mixed.
			voice("on-next", CHANNEL_HZ + 1_000, {
				discoveryId: null,
				frequencyHz: CHANNEL_HZ + 12_500,
			}),
		]
		for (const row of rows) expect(store.admit(row)).toEqual({ admitted: true })
		const q = service(store)
		const page = await q.search({ query: { channelHz: CHANNEL_HZ } })
		expect(page.items.map(i => i.eventId).sort()).toEqual(["on-a", "on-a-2"])
		expect(page.channelMatch).toBe("exact")
		const facets = await q.facets({
			query: { channelHz: CHANNEL_HZ },
			dimensions: ["channel"],
		})
		expect(facets.channelMatch).toBe("exact")
		expect(facets.facets["channel"]).toEqual([
			{ value: String(CHANNEL_HZ), count: 2 },
		])
		const near = await q.search({
			query: { nearHz: CHANNEL_HZ, toleranceHz: 12_500 },
		})
		expect(near.items).toHaveLength(3)
		expect(near.channelMatch).toBe("exact")
		await q.close()
	})

	it("channelMatch is mixed for a single old row in scope, and the other filters decide whether it counts", async () => {
		const store = await openStore()
		const rows = [
			voice("on-a", CHANNEL_HZ + 400, {
				discoveryId: DISCOVERY,
				frequencyHz: CHANNEL_HZ,
			}),
			// One old row (no stored channel) of another decoder, inside the fallback window.
			envelope({
				eventId: "old-other-decoder",
				decoderId: "scan-abc1234-nfm-1",
				outputType: "call_start",
				protocol: "nfm",
				category: "voice",
				entityKey: null,
				title: "FM voice",
				frequencyHz: CHANNEL_HZ + 2_000,
			}),
			// An old row outside the window never makes the answer mixed.
			voice("old-outside", CHANNEL_HZ + ACTIVITY_CHANNEL_FALLBACK_HALF_STEP_HZ),
		]
		for (const row of rows) expect(store.admit(row)).toEqual({ admitted: true })
		const q = service(store)
		const all = await q.search({ query: { channelHz: CHANNEL_HZ } })
		expect(all.items.map(i => i.eventId).sort()).toEqual([
			"old-other-decoder",
			"on-a",
		])
		expect(all.channelMatch).toBe("mixed")
		const allFacets = await q.facets({
			query: { channelHz: CHANNEL_HZ },
			dimensions: ["channel"],
		})
		expect(allFacets.channelMatch).toBe("mixed")
		// The decoder filter leaves the old row out: the probe applies it too.
		const filtered = await q.search({
			query: { channelHz: CHANNEL_HZ, decoderIds: ["scan-abc1234-dstar-1"] },
		})
		expect(filtered.items.map(i => i.eventId)).toEqual(["on-a"])
		expect(filtered.channelMatch).toBe("exact")
		const filteredFacets = await q.facets({
			query: { channelHz: CHANNEL_HZ, decoderIds: ["scan-abc1234-dstar-1"] },
			dimensions: ["channel"],
		})
		expect(filteredFacets.channelMatch).toBe("exact")
		await q.close()
	})

	it("refuses contradictory or out-of-range channel scopes", async () => {
		const store = await openStore()
		const q = service(store)
		await expect(q.search({ query: { toleranceHz: 100 } })).rejects.toThrow(
			/toleranceHz requires nearHz/,
		)
		await expect(
			q.search({ query: { channelHz: CHANNEL_HZ, nearHz: CHANNEL_HZ } }),
		).rejects.toThrow(/channelHz/)
		await expect(
			q.search({ query: { channelHz: CHANNEL_HZ + 0.5 } }),
		).rejects.toThrow(/integer/)
		// At the tolerance bound: accepted; past it: refused.
		await expect(
			q.search({
				query: {
					nearHz: CHANNEL_HZ,
					toleranceHz: ACTIVITY_CHANNEL_NEAR_MAX_TOLERANCE_HZ,
				},
			}),
		).resolves.toMatchObject({ channelMatch: "exact" })
		await expect(
			q.search({
				query: {
					nearHz: CHANNEL_HZ,
					toleranceHz: ACTIVITY_CHANNEL_NEAR_MAX_TOLERANCE_HZ + 1,
				},
			}),
		).rejects.toThrow()
		await q.close()
	})
})

describe("channel values", () => {
	it("a recording linked or unlinked later keeps the row's channel and its ref", () => {
		const env = voice("late", CHANNEL_HZ + 100, {
			discoveryId: DISCOVERY,
			frequencyHz: CHANNEL_HZ,
		})
		const row = buildActivityRow({
			version: 1,
			eventId: env.eventId,
			commitSeq: "0",
			producedAt: env.producedAt,
			receivedAt: env.receivedAt,
			kind: "decoder-reception",
			payload: env,
		})
		const linked = rowWithRecording(row, {
			id: "dsd~20261012_100000_12345_DMR_CC_1_GROUP_TGT_9_SRC_2001.wav",
			durationMs: 1000,
		})
		const unlinked = rowWithRecording(linked, null)
		for (const r of [linked, unlinked]) {
			expect(
				(JSON.parse(r.summaryJson) as Record<string, unknown>)["channel"],
			).toEqual({ discoveryId: DISCOVERY, frequencyHz: CHANNEL_HZ })
			expect(r.refs).toContainEqual({
				type: "channelHz",
				value: channelRefValue(CHANNEL_HZ),
			})
		}
	})

	it("checks a channel and leaves anything else out", () => {
		expect(isActivityChannel({ discoveryId: null, frequencyHz: 1 })).toBe(true)
		expect(
			isActivityChannel({ discoveryId: "d_1", frequencyHz: CHANNEL_MAX_HZ }),
		).toBe(true)
		for (const bad of [
			null,
			{ discoveryId: null, frequencyHz: 0 },
			{ discoveryId: null, frequencyHz: CHANNEL_MAX_HZ + 1 },
			{ discoveryId: null, frequencyHz: 1.5 },
			{ discoveryId: "", frequencyHz: 1 },
			{ discoveryId: "x".repeat(129), frequencyHz: 1 },
			{ discoveryId: "a\nb", frequencyHz: 1 },
			{ discoveryId: null },
			{ discoveryId: null, frequencyHz: 1, extra: 1 },
		])
			expect(isActivityChannel(bad)).toBe(false)
		expect(
			activityChannelOf({ discoveryId: "d_1", frequencyHz: 446_006_250.4 }),
		).toEqual({
			discoveryId: "d_1",
			frequencyHz: 446_006_250,
		})
		expect(activityChannelOf({ frequencyHz: 10 })).toEqual({
			discoveryId: null,
			frequencyHz: 10,
		})
		expect(activityChannelOf({ discoveryId: 5, frequencyHz: 10 })).toBeNull()
		expect(channelHzOfRef("1")).toBeNull()
		expect(channelHzOfRef("0".repeat(CHANNEL_REF_DIGITS))).toBeNull()
	})

	it("ref values sort as the frequencies they hold and read back", () => {
		// Feature: app-coherence-contract, Property 1: channel ref order is frequency order
		// Validates: Requirements C2.1, C2.5
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: CHANNEL_MAX_HZ }),
				fc.integer({ min: 1, max: CHANNEL_MAX_HZ }),
				(a, b) => {
					const ra = channelRefValue(a)
					const rb = channelRefValue(b)
					expect(ra).toHaveLength(CHANNEL_REF_DIGITS)
					expect(channelHzOfRef(ra)).toBe(a)
					expect(Math.sign(a - b)).toBe(ra < rb ? -1 : ra > rb ? 1 : 0)
				},
			),
			{ numRuns: 200 },
		)
	})

	it("a summary with a channel stays within the 4 KiB budget and keeps the channel whole", () => {
		// Feature: app-coherence-contract, Property 2: the channel fits the summary budget
		// Validates: Requirements C2.1
		fc.assert(
			fc.property(
				fc.stringMatching(/^[A-Za-z0-9 éü→·]{0,256}$/),
				fc.array(fc.stringMatching(/^[A-Za-z0-9 éü]{0,400}$/), {
					maxLength: 64,
				}),
				fc.option(fc.stringMatching(/^[A-Za-z0-9_]{1,128}$/), { nil: null }),
				fc.integer({ min: 1, max: CHANNEL_MAX_HZ }),
				(title, values, discoveryId, frequencyHz) => {
					const env = withEnvelopeMetadata(
						envelope({
							title: title.length > 0 ? title : null,
							category: "voice",
							entityKey: null,
							fields: values.map((value, i) => ({
								key: `k${i}`,
								label: `Label ${i}`,
								value,
							})),
						}),
						{ channel: { discoveryId, frequencyHz } },
					)
					const row = buildActivityRow({
						version: 1,
						eventId: env.eventId,
						commitSeq: "0",
						producedAt: env.producedAt,
						receivedAt: env.receivedAt,
						kind: "decoder-reception",
						payload: env,
					})
					expect(
						Buffer.byteLength(row.summaryJson, "utf8"),
					).toBeLessThanOrEqual(MAX_SUMMARY_BYTES)
					const summary = JSON.parse(row.summaryJson) as Record<string, unknown>
					expect(summary["channel"]).toEqual({ discoveryId, frequencyHz })
					expect(row.refs).toContainEqual({
						type: "channelHz",
						value: channelRefValue(frequencyHz),
					})
				},
			),
			{ numRuns: 100 },
		)
	})

	it("a summary at every member's largest size stays within 4 KiB and keeps coalesced, recording and channel whole", () => {
		// The members a fit never drops, at their bounds (JSON bytes): eventId, decoderId and
		// sourceId 128 characters each, every one escaped ('"' writes 2 bytes, 256), protocol 64
		// (128), entityKey 128 (about 254), two timestamps (2 × 24), coalesced (about 110), a
		// 256-character recording id (about 290) and a channel whose 128-character id is
		// multi-byte: '→' (3 bytes, 384) or a lone surrogate written as \udXXX (6 bytes, 768).
		// Their sum, with the member names, is below 3 KiB; fields, title, aircraft and position
		// shrink or go first.
		const quoted = (n: number): string => '"'.repeat(n)
		const recordingId = `dsd~20261012_100000_12345_${"A".repeat(200)}.wav`
		expect(recordingId.length).toBeLessThanOrEqual(256)
		for (const discoveryId of ["→".repeat(128), "\ud800".repeat(128)]) {
			expect(
				isActivityChannel({ discoveryId, frequencyHz: CHANNEL_MAX_HZ }),
			).toBe(true)
			const base = envelope({
				eventId: quoted(128),
				decoderId: quoted(128),
				sourceId: quoted(128),
				protocol: quoted(64),
				entityKey: `a:${quoted(126)}`,
				category: "voice",
				title: "→".repeat(256),
				fields: Array.from({ length: 64 }, (_, i) => ({
					key: `k${i}`,
					label: quoted(128),
					value: quoted(4096),
				})),
			})
			// Set on the envelope directly: ingress holds ids to 128 bytes, the store's check
			// (activityChannelOf) to 128 characters, the wider bound this measures.
			const env: DecodeEnvelope = {
				...base,
				coalesced: {
					receptions: Number.MAX_SAFE_INTEGER,
					firstSeenAt: "2026-10-12T00:00:00.000Z",
					lastSeenAt: "2026-10-12T00:00:01.000Z",
				},
				aircraft: {
					callsign: quoted(64),
					registration: quoted(64),
					typeCode: quoted(64),
					typeDescription: quoted(64),
					operator: quoted(64),
				},
				position: {
					lat: -89.123456789,
					lon: -179.123456789,
					altM: -12345.6789,
				},
				channel: { discoveryId, frequencyHz: CHANNEL_MAX_HZ },
			}
			const row = rowWithRecording(
				buildActivityRow({
					version: 1,
					eventId: env.eventId,
					commitSeq: "0",
					producedAt: env.producedAt,
					receivedAt: env.receivedAt,
					kind: "decoder-reception",
					payload: env,
				}),
				{ id: recordingId, durationMs: 86_399_999 },
			)
			expect(Buffer.byteLength(row.summaryJson, "utf8")).toBeLessThanOrEqual(
				MAX_SUMMARY_BYTES,
			)
			const summary = JSON.parse(row.summaryJson) as Record<string, unknown>
			expect(summary).toMatchObject({
				eventId: quoted(128),
				decoderId: quoted(128),
				sourceId: quoted(128),
				coalesced: env.coalesced,
				recording: { id: recordingId, durationMs: 86_399_999 },
				channel: { discoveryId, frequencyHz: CHANNEL_MAX_HZ },
			})

			// The scanner recording row at its bounds: 128-character ids, the channel's multi-byte.
			const scanKey = `scan:d_${"Z".repeat(40)}~${"a".repeat(200)}.wav`
			expect(scanKey.length).toBeLessThanOrEqual(256)
			const recordingRow = buildActivityRow({
				version: 1,
				eventId: quoted(128),
				commitSeq: "0",
				producedAt: "2026-10-12T00:00:30.000Z",
				receivedAt: "2026-10-12T00:00:30.100Z",
				kind: "recording-change",
				payload: kept(
					{ discoveryId, frequencyHz: CHANNEL_MAX_HZ },
					{
						recordingId: scanKey,
						discoveryId: "\ud800".repeat(128),
						observationId: "\ud800".repeat(128),
						sourceId: "\ud800".repeat(128),
					},
				),
			})
			expect(
				Buffer.byteLength(recordingRow.summaryJson, "utf8"),
			).toBeLessThanOrEqual(MAX_SUMMARY_BYTES)
			expect(JSON.parse(recordingRow.summaryJson)).toMatchObject({
				title: SCANNER_RECORDING_TITLE,
				recording: { id: scanKey },
				channel: { discoveryId, frequencyHz: CHANNEL_MAX_HZ },
			})
		}

		// Past the bound: a 129-character id is not a channel, so a row never stores it.
		const past = "→".repeat(129)
		expect(isActivityChannel({ discoveryId: past, frequencyHz: 1 })).toBe(false)
		expect(activityChannelOf({ discoveryId: past, frequencyHz: 1 })).toBeNull()
		// Ingress refuses it; a row built from an envelope carrying it anyway stores no channel.
		expect(() =>
			voice("past", CHANNEL_HZ, { discoveryId: past, frequencyHz: CHANNEL_HZ }),
		).toThrow(/Invalid decoder event envelope/)
		const pastEnv: DecodeEnvelope = {
			...voice("past", CHANNEL_HZ),
			channel: { discoveryId: past, frequencyHz: CHANNEL_HZ },
		}
		const pastRow = buildActivityRow({
			version: 1,
			eventId: pastEnv.eventId,
			commitSeq: "0",
			producedAt: pastEnv.producedAt,
			receivedAt: pastEnv.receivedAt,
			kind: "decoder-reception",
			payload: pastEnv,
		})
		expect(
			(JSON.parse(pastRow.summaryJson) as Record<string, unknown>)["channel"],
		).toBeUndefined()
		expect(pastRow.refs.some(ref => ref.type === "channelHz")).toBe(false)
	})
})

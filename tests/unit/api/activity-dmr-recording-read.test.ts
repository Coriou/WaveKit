/**
 * A stored dsd-fme recording link is presented only while its file may be served
 * (dsdFmeNameServable): a DMR call link stored before the DMR recording gate closed, a dsd-fme
 * P25, NXDN, dPMR or ProVoice call name and a call name with a label off the allow-list are not
 * presented on the REST list or the WebSocket records; a YSF link and dv call recorder links are
 * (decided by the row's decoder, so a recorder name of a decoder whose id starts with `dmr` is
 * presented). A link is presented only
 * while its row's own call trust admits it (callTrustAdmits): a P25 phase 1 or NXDN link only
 * when its call_end carries the call's own clear print (`clearEvidence: true` with
 * `encryptionKnown: true`), so a link stored before that rule (no encryptionKnown, or
 * `encryptionKnown: true` without the marker) loses its play control, the row stays; a P25
 * phase 2, dPMR, ProVoice, EDACS or M17 link never plays; a D-STAR or YSF link is unchanged.
 * Synthetic rows only.
 */
import { rm } from "node:fs/promises"
import Fastify from "fastify"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	createActivitySubscriptions,
	type ActivityClientTransport,
	type ActivityWireMessage,
} from "../../../src/api/activity-subscriptions.js"
import { activityRoutes } from "../../../src/api/routes/activity.js"
import { createActivityQueryService } from "../../../src/core/activity/query/service.js"
import type { ActivitySummary } from "../../../src/core/activity/storage/contract.js"
import type { JsonValue } from "../../../src/core/activity/types.js"
import {
	envelope,
	logger,
	openStore,
	roots,
	stores,
} from "../core/activity/storage/helpers.js"

// These cases exercise the dv call recorder's catalogue path, which is off in production
// (DV_CALL_RECORDINGS_SERVED: no call tap feeds the recorder yet); they pin it for its re-enable.
vi.mock("../../../src/core/recordings/names.js", async importOriginal => ({
	...(await importOriginal<Record<string, unknown>>()),
	DV_CALL_RECORDINGS_SERVED: true,
}))

const DMR_KEY = "dsd~20261012_100000_12345_DMR_CC_1_GROUP_TGT_9_SRC_2001.wav"
const P25_KEY = "dsd~20261012_100100_12346_P25_1A3_GROUP_TGT_9_SRC_2002.wav"
const YSF_KEY = "dsd~20261012_100500_12350_YSF_GROUP_TGT_9_SRC_2006.wav"
/** The dv call recorder's name: its first field is the decoder id, not a protocol. */
const DV_KEY = "dsd~20261012_100200_12347_dsd-fme_GROUP_TGT_9_SRC_2003.wav"
/** The dv call recorder's name of decoder `dmr-main`: its field reads `dmr` as a protocol. */
const DV_DMR_ID_KEY =
	"dsd~20261012_100300_12348_dmr-main_GROUP_TGT_9_SRC_2004.wav"
/** A P25 call_end's data with its own clear print (callTrustAdmits admits it). */
const CLEAR_P25 = {
	protocol: "p25p1",
	encryptionKnown: true,
	clearEvidence: true,
}
/** A dsd-fme call name whose label is not on the recordable allow-list. */
const FOO_KEY = "dsd~20261012_100400_12349_FOO_1_GROUP_TGT_9_SRC_2005.wav"

afterEach(async () => {
	await Promise.all(stores.splice(0).map(s => s.close().catch(() => undefined)))
	await Promise.all(
		roots.splice(0).map(r => rm(r, { recursive: true, force: true })),
	)
})

type Store = Awaited<ReturnType<typeof openStore>>

function admitCalls(store: Store): void {
	store.admit(
		envelope({
			eventId: "dmr-call",
			category: "voice",
			outputType: "call_end",
			protocol: "dmr",
			entityKey: null,
		}),
		undefined,
		{ id: DMR_KEY, durationMs: 4200 },
	)
	store.admit(
		envelope({
			eventId: "p25-call",
			category: "voice",
			outputType: "call_end",
			protocol: "p25",
			entityKey: null,
			decodedData: CLEAR_P25,
		}),
		undefined,
		{ id: P25_KEY, durationMs: 3100 },
	)
	store.admit(
		envelope({
			eventId: "dv-call",
			decoderId: "dsd-fme",
			category: "voice",
			outputType: "call_end",
			protocol: "p25",
			entityKey: null,
			decodedData: CLEAR_P25,
		}),
		undefined,
		{ id: DV_KEY, durationMs: 2000 },
	)
	store.admit(
		envelope({
			eventId: "dv-dmr-id-call",
			decoderId: "dmr-main",
			category: "voice",
			outputType: "call_end",
			protocol: "p25",
			entityKey: null,
			decodedData: CLEAR_P25,
		}),
		undefined,
		{ id: DV_DMR_ID_KEY, durationMs: 1500 },
	)
	store.admit(
		envelope({
			eventId: "ysf-call",
			category: "voice",
			outputType: "call_end",
			protocol: "ysf",
			entityKey: null,
			decodedData: { protocol: "ysf" },
		}),
		undefined,
		{ id: YSF_KEY, durationMs: 900 },
	)
	store.admit(
		envelope({
			eventId: "foo-call",
			category: "voice",
			outputType: "call_end",
			protocol: "p25",
			entityKey: null,
			decodedData: CLEAR_P25,
		}),
		undefined,
		{ id: FOO_KEY, durationMs: 1200 },
	)
}

function expectPresented(items: readonly ActivitySummary[]): void {
	expect(recordingOf(items, "dv-call")).toEqual({
		id: DV_KEY,
		durationMs: 2000,
	})
	expect(recordingOf(items, "dv-dmr-id-call")).toEqual({
		id: DV_DMR_ID_KEY,
		durationMs: 1500,
	})
	expect(recordingOf(items, "ysf-call")).toEqual({
		id: YSF_KEY,
		durationMs: 900,
	})
	// A dsd-fme P25 call file is never served, so its link is not presented, clear or not.
	expect(recordingOf(items, "p25-call")).toBeUndefined()
	expect(recordingOf(items, "dmr-call")).toBeUndefined()
	expect(recordingOf(items, "foo-call")).toBeUndefined()
}

const recordingOf = (items: readonly ActivitySummary[], eventId: string) =>
	items.find(i => i.eventId === eventId)?.recording

class Transport implements ActivityClientTransport {
	readonly delivered: ActivityWireMessage[] = []
	constructor(readonly key: string) {}
	send(message: ActivityWireMessage): boolean {
		this.delivered.push(message)
		return true
	}
	close(): void {}
}

/**
 * The seeded shape of an image acceptance (modelled: shape from a private state, ids
 * synthetic): six dsd-fme DMR call_end rows linked by the baseline image, five to dsd-fme DMR
 * names (a two-digit colour code included) and one to a name whose system field dsd-fme left
 * empty, one of them through its late file update (wavFileUpdate). A YSF row stays presented.
 */
const SEEDED_DMR_KEYS = [
	"dsd~20261012_110000_10001_DMR_CC_11_GROUP_TGT_90001_SRC_901.wav",
	"dsd~20261012_110010_10002_DMR_CC_11_GROUP_TGT_90001_SRC_902.wav",
	"dsd~20261012_110020_10003_DMR_CC_11_GROUP_TGT_90001_SRC_903.wav",
	"dsd~20261012_110030_10004_DMR_CC_1_GROUP_TGT_90002_SRC_904.wav",
	"dsd~20261012_110040_10005_DMR_CC_11_GROUP_TGT_90001_SRC_9.wav",
	"dsd~20261012_110050_10006__GROUP_TGT_9_SRC_9.wav",
]

function admitSeeded(store: Store): void {
	SEEDED_DMR_KEYS.forEach((id, i) =>
		store.admit(
			envelope({
				eventId: `seeded-dmr-${i}`,
				decoderId: "dsd-fme",
				category: "voice",
				outputType: "call_end",
				protocol: "dmr",
				entityKey: null,
				decodedData:
					i === 2
						? { callId: `c${i}`, flags: { wavFileUpdate: true } }
						: { callId: `c${i}` },
			}),
			undefined,
			{ id, durationMs: 1000 + i },
		),
	)
	store.admit(
		envelope({
			eventId: "seeded-ysf",
			decoderId: "dsd-fme",
			category: "voice",
			outputType: "call_end",
			protocol: "ysf",
			entityKey: null,
			decodedData: { protocol: "ysf" },
		}),
		undefined,
		{ id: YSF_KEY, durationMs: 900 },
	)
}

function expectSeededHidden(items: readonly ActivitySummary[], body: string) {
	for (let i = 0; i < SEEDED_DMR_KEYS.length; i++)
		expect(recordingOf(items, `seeded-dmr-${i}`)).toBeUndefined()
	for (const key of SEEDED_DMR_KEYS)
		expect(body).not.toContain(key.slice("dsd~".length))
	expect(recordingOf(items, "seeded-ysf")).toEqual({
		id: YSF_KEY,
		durationMs: 900,
	})
}

describe("activity: rows a baseline image linked to DMR call files (seeded store)", () => {
	it("the REST list and a hasRecording query never present their recording", async () => {
		const store = await openStore()
		admitSeeded(store)
		const service = createActivityQueryService({
			store,
			logger,
			execution: "inline",
		})
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, { service, enabled: true })
		try {
			const all = await app.inject({ method: "GET", url: "/api/activity" })
			expect(all.statusCode).toBe(200)
			const items = (all.json() as { items: ActivitySummary[] }).items
			expect(items).toHaveLength(SEEDED_DMR_KEYS.length + 1)
			expectSeededHidden(items, all.body)
			// The stored link still matches hasRecording until the link sweep removes it
			// (recording-links.ts; the catalogue answers false for these keys at once), but no
			// row of that page presents a DMR recording either.
			const linked = await app.inject({
				method: "GET",
				url: "/api/activity?hasRecording=true",
			})
			expect(linked.statusCode).toBe(200)
			expectSeededHidden(
				(linked.json() as { items: ActivitySummary[] }).items,
				linked.body,
			)
		} finally {
			await app.close()
			await service.close()
		}
	})

	it("the WebSocket records never present their recording", async () => {
		const store = await openStore()
		const service = createActivityQueryService({
			store,
			logger,
			execution: "inline",
		})
		const start = await service.search({ query: {} })
		admitSeeded(store)
		const hub = createActivitySubscriptions({ service, enabled: true })
		const transport = new Transport("client-seeded")
		try {
			hub.handleMessage(transport, {
				type: "activity:subscribe",
				id: "seeded",
				query: {},
				cursor: start.replayCursor,
			})
			const items = (): ActivitySummary[] =>
				transport.delivered.flatMap(m => {
					const message = m as {
						type?: string
						data?: { items?: ActivitySummary[] }
					}
					return message.type === "activity:records"
						? [...(message.data?.items ?? [])]
						: []
				})
			await expect
				.poll(() => items().length, { timeout: 5_000 })
				.toBe(SEEDED_DMR_KEYS.length + 1)
			expectSeededHidden(items(), JSON.stringify(transport.delivered))
		} finally {
			hub.close()
			await service.close()
		}
	})
})

describe("activity: dsd-fme recording links at read time", () => {
	it("the REST list presents YSF and dv recorder links, never a stored DMR, dsd-fme P25 or unlisted-label link", async () => {
		const store = await openStore()
		admitCalls(store)
		const service = createActivityQueryService({
			store,
			logger,
			execution: "inline",
		})
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, { service, enabled: true })
		try {
			const res = await app.inject({ method: "GET", url: "/api/activity" })
			expect(res.statusCode).toBe(200)
			const items = (res.json() as { items: ActivitySummary[] }).items
			expect(items.map(i => i.eventId).sort()).toEqual([
				"dmr-call",
				"dv-call",
				"dv-dmr-id-call",
				"foo-call",
				"p25-call",
				"ysf-call",
			])
			expectPresented(items)
			expect(res.body).not.toContain(DMR_KEY)
			expect(res.body).not.toContain(P25_KEY)
			expect(res.body).not.toContain(FOO_KEY)
		} finally {
			await app.close()
			await service.close()
		}
	})

	it("the WebSocket records present YSF and dv recorder links, never a stored DMR, dsd-fme P25 or unlisted-label link", async () => {
		const store = await openStore()
		const service = createActivityQueryService({
			store,
			logger,
			execution: "inline",
		})
		const start = await service.search({ query: {} })
		admitCalls(store)
		const hub = createActivitySubscriptions({ service, enabled: true })
		const transport = new Transport("client-a")
		try {
			hub.handleMessage(transport, {
				type: "activity:subscribe",
				id: "one",
				query: {},
				cursor: start.replayCursor,
			})
			const items = (): ActivitySummary[] =>
				transport.delivered.flatMap(m => {
					const message = m as {
						type?: string
						data?: { items?: ActivitySummary[] }
					}
					return message.type === "activity:records"
						? [...(message.data?.items ?? [])]
						: []
				})
			await expect.poll(() => items().length, { timeout: 5_000 }).toBe(6)
			expectPresented(items())
			expect(JSON.stringify(transport.delivered)).not.toContain(DMR_KEY)
			expect(JSON.stringify(transport.delivered)).not.toContain(FOO_KEY)
		} finally {
			hub.close()
			await service.close()
		}
	})
})

/**
 * dv call recorder links (served whatever their protocol) stored before the per-call trust rule
 * (fail open: a call_end without encryptionKnown, or with `encryptionKnown: true` from an older
 * rule but no `clearEvidence` marker), next to rows whose own data admits them, and one dsd-fme
 * P25 call file of a known clear row (never served: not presented either). Modelled shapes,
 * synthetic ids.
 */
const TRUST_ROWS: Array<{
	eventId: string
	protocol: string
	key: string
	data: { [key: string]: JsonValue }
	presented: boolean
}> = [
	{
		eventId: "p25-open",
		protocol: "p25",
		key: "dsd~20261012_120000_20001_dsd-fme_GROUP_TGT_56_SRC_1234.wav",
		data: { callId: "t1", protocol: "p25p1" },
		presented: false,
	},
	{
		eventId: "p25-unknown",
		protocol: "p25",
		key: "dsd~20261012_120010_20002_dsd-fme_GROUP_TGT_56_SRC_1235.wav",
		data: { callId: "t2", protocol: "p25p1", encryptionKnown: false },
		presented: false,
	},
	{
		eventId: "p25-encrypted",
		protocol: "p25",
		key: "dsd~20261012_120020_20003_dsd-fme_GROUP_TGT_56_SRC_1236.wav",
		data: {
			callId: "t3",
			protocol: "p25p1",
			encryptionKnown: true,
			flags: { encrypted: true },
		},
		presented: false,
	},
	{
		eventId: "p25p2-open",
		protocol: "p25",
		key: "dsd~20261012_120030_20004_dsd-fme_GROUP_TGT_7070_SRC_40820.wav",
		data: { callId: "t4", protocol: "p25p2" },
		presented: false,
	},
	{
		eventId: "nxdn-open",
		protocol: "nxdn",
		key: "dsd~20261012_120040_20005_dsd-fme_GROUP_TGT_5678_SRC_1234.wav",
		data: { callId: "t5", protocol: "nxdn48" },
		presented: false,
	},
	{
		eventId: "dpmr-open",
		protocol: "dpmr",
		key: "dsd~20261012_120050_20006_dsd-fme_GROUP_TGT_0_SRC_0.wav",
		data: { callId: "t6", protocol: "dpmr" },
		presented: false,
	},
	{
		eventId: "provoice-open",
		protocol: "provoice",
		key: "dsd~20261012_120100_20007_dsd-fme_GROUP_TGT_0_SRC_0.wav",
		data: { callId: "t7", protocol: "provoice" },
		presented: false,
	},
	{
		eventId: "p25-clear",
		protocol: "p25",
		key: "dsd~20261012_120110_20008_dsd-fme_GROUP_TGT_56_SRC_1237.wav",
		data: {
			callId: "t8",
			protocol: "p25p1",
			encryptionKnown: true,
			clearEvidence: true,
		},
		presented: true,
	},
	{
		eventId: "nxdn-clear",
		protocol: "nxdn",
		key: "dsd~20261012_120120_20009_dsd-fme_GROUP_TGT_5678_SRC_1238.wav",
		data: {
			callId: "t9",
			protocol: "nxdn48",
			encryptionKnown: true,
			clearEvidence: true,
		},
		presented: true,
	},
	{
		eventId: "p25-known-unproven",
		protocol: "p25",
		key: "dsd~20261012_120300_20013_dsd-fme_GROUP_TGT_56_SRC_1240.wav",
		data: { callId: "t13", protocol: "p25p1", encryptionKnown: true },
		presented: false,
	},
	{
		eventId: "nxdn-known-unproven",
		protocol: "nxdn",
		key: "dsd~20261012_120310_20014_dsd-fme_GROUP_TGT_5678_SRC_1241.wav",
		data: { callId: "t14", protocol: "nxdn96", encryptionKnown: true },
		presented: false,
	},
	{
		eventId: "p25-marker-not-known",
		protocol: "p25",
		key: "dsd~20261012_120320_20015_dsd-fme_GROUP_TGT_56_SRC_1242.wav",
		data: { callId: "t15", protocol: "p25p1", clearEvidence: true },
		presented: false,
	},
	{
		eventId: "p25p2-marked",
		protocol: "p25",
		key: "dsd~20261012_120330_20016_dsd-fme_GROUP_TGT_7070_SRC_40821.wav",
		data: {
			callId: "t16",
			protocol: "p25p2",
			encryptionKnown: true,
			clearEvidence: true,
		},
		presented: false,
	},
	{
		eventId: "edacs-open",
		protocol: "edacs",
		key: "dsd~20261012_120340_20017_dsd-fme_GROUP_TGT_0_SRC_0.wav",
		data: { callId: "t17", protocol: "edacs" },
		presented: false,
	},
	{
		eventId: "m17-open",
		protocol: "m17",
		key: "dsd~20261012_120350_20018_dsd-fme_GROUP_TGT_0_SRC_0.wav",
		data: { callId: "t18", protocol: "m17" },
		presented: false,
	},
	{
		eventId: "p25-clear-dsd-file",
		protocol: "p25",
		key: "dsd~20261012_120150_20012_P25_1A3_GROUP_TGT_56_SRC_1239.wav",
		data: {
			callId: "t12",
			protocol: "p25p1",
			encryptionKnown: true,
			clearEvidence: true,
		},
		presented: false,
	},
	{
		eventId: "dstar-open",
		protocol: "dstar",
		key: "dsd~20261012_120130_20010_dsd-fme_GROUP_TGT_0_SRC_0.wav",
		data: { callId: "t10", protocol: "dstar" },
		presented: true,
	},
	{
		eventId: "ysf-open",
		protocol: "ysf",
		key: "dsd~20261012_120140_20011_dsd-fme_GROUP_TGT_0_SRC_0.wav",
		data: { callId: "t11", protocol: "ysf" },
		presented: true,
	},
]

function admitTrustRows(store: Store): void {
	for (const row of TRUST_ROWS)
		store.admit(
			envelope({
				eventId: row.eventId,
				decoderId: "dsd-fme",
				category: "voice",
				outputType: "call_end",
				protocol: row.protocol,
				entityKey: null,
				decodedData: row.data,
			}),
			undefined,
			{ id: row.key, durationMs: 2500 },
		)
}

function expectTrusted(items: readonly ActivitySummary[], body: string): void {
	// Every call row is kept: only the play control follows the trust.
	expect(items.map(i => i.eventId).sort()).toEqual(
		TRUST_ROWS.map(r => r.eventId).sort(),
	)
	for (const row of TRUST_ROWS) {
		if (row.presented)
			expect(recordingOf(items, row.eventId)).toEqual({
				id: row.key,
				durationMs: 2500,
			})
		else {
			expect(recordingOf(items, row.eventId)).toBeUndefined()
			expect(body).not.toContain(row.key)
		}
	}
}

describe("activity: a stored dsd-fme link is presented only while its row's call trust admits it", () => {
	it("the REST list keeps every call row and drops the play control of fail-open or unproven P25 and NXDN links and of P25 phase 2, dPMR, ProVoice, EDACS and M17 links", async () => {
		const store = await openStore()
		admitTrustRows(store)
		const service = createActivityQueryService({
			store,
			logger,
			execution: "inline",
		})
		const app = Fastify({ logger: false })
		await app.register(activityRoutes, { service, enabled: true })
		try {
			const res = await app.inject({ method: "GET", url: "/api/activity" })
			expect(res.statusCode).toBe(200)
			expectTrusted(
				(res.json() as { items: ActivitySummary[] }).items,
				res.body,
			)
		} finally {
			await app.close()
			await service.close()
		}
	})

	it("the WebSocket records keep every call row and drop the same play controls", async () => {
		const store = await openStore()
		const service = createActivityQueryService({
			store,
			logger,
			execution: "inline",
		})
		const start = await service.search({ query: {} })
		admitTrustRows(store)
		const hub = createActivitySubscriptions({ service, enabled: true })
		const transport = new Transport("client-trust")
		try {
			hub.handleMessage(transport, {
				type: "activity:subscribe",
				id: "trust",
				query: {},
				cursor: start.replayCursor,
			})
			const items = (): ActivitySummary[] =>
				transport.delivered.flatMap(m => {
					const message = m as {
						type?: string
						data?: { items?: ActivitySummary[] }
					}
					return message.type === "activity:records"
						? [...(message.data?.items ?? [])]
						: []
				})
			await expect
				.poll(() => items().length, { timeout: 5_000 })
				.toBe(TRUST_ROWS.length)
			expectTrusted(items(), JSON.stringify(transport.delivered))
		} finally {
			hub.close()
			await service.close()
		}
	})
})

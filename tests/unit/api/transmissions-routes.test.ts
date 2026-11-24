/**
 * GET /api/transmissions/:ref over the production Activity runtime (real SQLite), a registry and a
 * memory catalogue double: malformed refs are 400 and unknown ones 404 (the ref never echoed),
 * each ref form resolves (registry, then the id its stored record names), the id and start come
 * from the stored record, audio is listed only where the recordings route serves it, a digital
 * call lists audio only when the decoder linked its file, and the reads stay bounded.
 */
import { afterEach, describe, expect, it } from "vitest"
import type { TransmissionDto } from "@wavekit/api-types"
import {
	TRANSMISSION_RECORDS_MAX,
	TRANSMISSION_ROWS_MAX,
} from "../../../src/api/routes/transmissions.js"
import { TRANSMISSION_GROUP_MEMBERS_MAX } from "../../../src/core/transmissions/dto.js"
import {
	DSD_NAME,
	TX_A,
	TX_B,
	analogItem,
	harness,
	keyOf,
	type Harness,
} from "./transmission-harness.js"

const at = Date.now()

describe("GET /api/transmissions/:ref", () => {
	let h: Harness | null = null
	afterEach(async () => {
		await h?.close()
		h = null
	})
	const get = async (ref: string, raw = false) => {
		const app = await h!.app()
		return app.inject({
			method: "GET",
			url: `/api/transmissions/${raw ? ref : encodeURIComponent(ref)}`,
		})
	}

	it("answers 400 for a malformed ref and 404 for an unknown one, never echoing it", async () => {
		h = await harness(at)
		const long = `rec:${"k".repeat(513)}`
		for (const ref of [
			"bogus",
			`tx_01jtesttx${"a".repeat(17)}`,
			`tx_01JTESTTX${"A".repeat(16)}`,
			"rec:",
			"rec:a b",
			"obs:\tx",
			long,
		]) {
			const res = await get(ref)
			expect(res.statusCode).toBe(400)
			expect(res.json()).toMatchObject({ code: "TRANSMISSION_REF_INVALID" })
			expect(res.body).not.toContain(ref)
		}
		for (const ref of [TX_A, "rec:scan:nothing", "evt:none", "obs:none"]) {
			const res = await get(ref)
			expect(res.statusCode).toBe(404)
			expect(res.json()).toMatchObject({ code: "TRANSMISSION_NOT_FOUND" })
			expect(res.body).not.toContain(ref)
		}
	})

	it("a registry transmission with a kept file: its audio, part, recorder tone and group", async () => {
		h = await harness(at)
		const key = keyOf(1)
		const claim = h.registry.claim({
			origin: "scanner-observation",
			kind: "voice-analog",
			sourceId: "source-1",
			hz: 100_000_000,
			halfWidthHz: 6_000,
			epoch: 1,
			stream: 0,
			sample: 0,
			atMs: at - 5_000,
			alias: "obs:o_01JTESTOBSERVATION",
		})!
		h.registry.attach(claim.txId, `rec:${key}`)
		h.items.set(
			key,
			analogItem(key, {
				txId: claim.txId,
				tone: { kind: "ctcss", hz: 88.5 },
				part: 1,
				parts: 2,
			}),
		)
		const res = await get(claim.txId)
		expect(res.statusCode).toBe(200)
		const dto = res.json<TransmissionDto>()
		expect(dto).toMatchObject({
			id: claim.txId,
			kind: "voice-analog",
			recordingKind: "scanner-analog",
			sourceId: "source-1",
			refs: {
				recordingKeys: [key],
				observationId: "o_01JTESTOBSERVATION",
				discoveryId: "d_01JTESTDISCOVERY",
				operationId: "op-1",
			},
			part: { index: 1, of: 2 },
			tone: { state: "heard", ctcssHz: 88.5, from: "recorder" },
			artefacts: [{ kind: "audio", id: key, inventoryId: key }],
			privacy: null,
			sameTime: null,
			channelSummary: null,
			signal: null,
		})
		expect(dto.group?.members.map(m => m.ref)).toEqual([claim.txId])
		// The alias reads the same transmission.
		expect((await get(`rec:${key}`)).json<TransmissionDto>().id).toBe(
			claim.txId,
		)
		// Without the recordings route (legacy mode) no audio is listed.
		const bare = await h.app({ inventory: undefined as never })
		const res2 = await bare.inject({
			method: "GET",
			url: `/api/transmissions/${claim.txId}`,
		})
		expect(res2.json<TransmissionDto>().artefacts).toEqual([])
	})

	it("an id the registry no longer holds: Activity rows by txId and the catalogue index; times from record_json", async () => {
		h = await harness(at)
		const key = keyOf(2)
		const started = new Date(at - 4_000).toISOString()
		h.kept({ recordingId: key, txId: TX_A, startedAt: started })
		h.analog({ transmissionId: "t-9", txId: TX_A })
		await h.rows(2)
		h.items.set(key, analogItem(key, { txId: TX_A }))
		const res = await get(TX_A)
		expect(res.statusCode).toBe(200)
		const dto = res.json<TransmissionDto>()
		expect(dto.id).toBe(TX_A)
		expect(dto.refs.eventIds).toHaveLength(2)
		expect(dto.refs.recordingKeys).toEqual([key])
		expect(dto.artefacts.map(a => a.id)).toEqual([key])
		// The live row's own start (record_json), not a summary.
		expect(dto.startedAt).toBe(new Date(at - 2_500).toISOString())
		expect(dto.group).toBeNull()
		expect(dto.close).toBeNull()
	})

	it("evt: and rec: aliases retry the registry with the id their stored artefact names", async () => {
		h = await harness(at)
		const claim = h.registry.claim({
			origin: "live-demod",
			kind: "voice-analog",
			sourceId: "source-1",
			hz: 100_000_000,
			halfWidthHz: 6_000,
			atMs: at - 3_000,
			alias: "evt:t-live",
		})!
		h.analog({ transmissionId: "t-2", txId: claim.txId })
		await h.rows(1)
		const row = (await h.runtime.service.search({ query: {}, limit: 10 }))
			.items[0]!
		const byEvent = await get(`evt:${row.eventId}`)
		expect(byEvent.statusCode).toBe(200)
		expect(byEvent.json<TransmissionDto>()).toMatchObject({
			id: claim.txId,
			group: { id: expect.any(String) as string },
		})
		const key = keyOf(3)
		h.items.set(key, analogItem(key, { txId: claim.txId }))
		const byRec = await get(`rec:${key}`)
		expect(byRec.json<TransmissionDto>().id).toBe(claim.txId)
	})

	it("a pre-id row read by its alias has a null id", async () => {
		h = await harness(at)
		h.analog({ transmissionId: "t-old" })
		await h.rows(1)
		const row = (await h.runtime.service.search({ query: {}, limit: 10 }))
			.items[0]!
		const res = await get(`evt:${row.eventId}`)
		expect(res.statusCode).toBe(200)
		expect(res.json<TransmissionDto>()).toMatchObject({
			id: null,
			kind: "voice-analog",
			startedAt: new Date(at - 2_500).toISOString(),
		})
	})

	it("a long recording key (past the router's 100-character param) still resolves", async () => {
		h = await harness(at)
		const key = `scan:${"d".repeat(120)}~x.wav`
		h.items.set(key, analogItem(key))
		const res = await get(`rec:${key}`)
		expect(res.statusCode).toBe(200)
		expect(res.json<TransmissionDto>().refs.recordingKeys).toEqual([key])
	})

	describe("digital calls", () => {
		const dvClaim = (hh: Harness, txAt: number) =>
			hh.registry.claim({
				origin: "dv-call",
				kind: "voice-digital",
				sourceId: null,
				dvKey: "dv:dsd-a",
				lane: 0,
				run: "dsd-a#1",
				atMs: txAt,
				alias: "call:dsd-a:call-1",
			})!
		const callEnd = (txId: string, encrypted: boolean) => ({
			timestamp: new Date(at),
			decoder: "dsd-a",
			type: "call_end" as const,
			data: {
				callId: "call-1",
				protocol: "ysf",
				talkgroup: 100,
				source: 2001,
				duration: 4_200,
				encryptionKnown: true,
				encrypted,
				flags: { encrypted },
				txId,
			},
		})

		it("a call whose file the decoder linked is clear and lists it", async () => {
			h = await harness(at)
			const claim = dvClaim(h, at - 4_200)
			h.publish("dsd-a", callEnd(claim.txId, false))
			await h.rows(1)
			const key = `dsd~${DSD_NAME}`
			h.runtime.recordingLinks?.()?.link({
				type: "link-call",
				decoderId: "dsd-a",
				callId: "call-1",
				recording: { id: key, durationMs: 4_200 },
			})
			await expect
				.poll(
					async () =>
						(
							await h!.runtime.service.search({
								query: { hasRecording: true },
							})
						).items.length,
				)
				.toBe(1)
			h.items.set(key, {
				...analogItem(key),
				kind: "dsd-fme-call",
				discoveryId: null,
				facts: null,
			})
			const dto = (await get(claim.txId)).json<TransmissionDto>()
			expect(dto).toMatchObject({
				id: claim.txId,
				kind: "voice-digital",
				privacy: "clear",
				tone: null,
				identity: { talkgroup: "100", radio: "2001" },
				artefacts: [{ id: key }],
				recordingKind: "dsd-fme-call",
			})
		})

		it("a call never proven clear lists no audio (unproven); an encrypted one says so", async () => {
			h = await harness(at)
			const claim = dvClaim(h, at - 4_200)
			h.publish("dsd-a", callEnd(claim.txId, false))
			await h.rows(1)
			const unproven = (await get(claim.txId)).json<TransmissionDto>()
			expect(unproven.privacy).toBe("unproven")
			expect(unproven.artefacts).toEqual([])
			h.registry.noteRefusal(claim.txId, "encrypted")
			const enc = (await get(claim.txId)).json<TransmissionDto>()
			expect(enc.privacy).toBe("encrypted")
			expect(enc.artefacts).toEqual([])
			expect(enc.noAudioReason).toBe("encrypted")
		})
	})

	it.each([
		[TRANSMISSION_RECORDS_MAX, TRANSMISSION_RECORDS_MAX],
		[TRANSMISSION_RECORDS_MAX + 1, TRANSMISSION_RECORDS_MAX],
		[TRANSMISSION_ROWS_MAX, TRANSMISSION_RECORDS_MAX],
		[TRANSMISSION_ROWS_MAX + 1, TRANSMISSION_RECORDS_MAX],
	])(
		"%i rows on the id: one search of at most TRANSMISSION_ROWS_MAX rows, %i record reads",
		async (rows, details) => {
			h = await harness(at)
			for (let i = 0; i < rows; i++)
				h.analog({ transmissionId: `t-${i}`, txId: TX_B })
			await h.rows(rows)
			h.counts.search = 0
			h.counts.detail = 0
			const res = await get(TX_B)
			expect(res.statusCode).toBe(200)
			expect(res.json<TransmissionDto>().refs.eventIds).toHaveLength(
				Math.min(rows, TRANSMISSION_ROWS_MAX),
			)
			expect(h.counts.search).toBe(1)
			expect(h.counts.detail).toBe(details)
		},
	)

	it.each([TRANSMISSION_GROUP_MEMBERS_MAX, TRANSMISSION_GROUP_MEMBERS_MAX + 1])(
		"a group of %i held transmissions lists at most TRANSMISSION_GROUP_MEMBERS_MAX members",
		async n => {
			h = await harness(at)
			const ids: string[] = []
			// One channel's overs 1 s apart: each joins the previous one's group (15 s gap).
			for (let i = 0; i < n; i++) {
				const c = h.registry.claim({
					origin: "live-demod",
					kind: "voice-analog",
					sourceId: "source-1",
					hz: 100_000_000,
					halfWidthHz: 6_000,
					atMs: at + i * 1_000,
					alias: `evt:t-${i}`,
				})!
				h.registry.end(c.claimant, at + i * 1_000 + 500)
				ids.push(c.txId)
			}
			const dto = (await get(ids[0]!)).json<TransmissionDto>()
			expect(dto.group?.members.map(m => m.ref)).toEqual(
				ids.slice(0, TRANSMISSION_GROUP_MEMBERS_MAX),
			)
		},
	)
})

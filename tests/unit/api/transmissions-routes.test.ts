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

	it("answers 503, not 404, when nothing resolved because an Activity read failed", async () => {
		h = await harness(at)
		const busy = () => Promise.reject(new Error("busy"))
		const app = await h.app({
			activity: { ...h.runtime.service, search: busy, detail: busy },
		})
		for (const ref of [TX_A, "evt:none"]) {
			const res = await app.inject({
				method: "GET",
				url: `/api/transmissions/${encodeURIComponent(ref)}`,
			})
			expect(res.statusCode).toBe(503)
			expect(res.json()).toMatchObject({ code: "TRANSMISSIONS_UNAVAILABLE" })
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

	it("the recorder's DCS code reads with its polarity; a DCS code or a recorder none says DCS was looked for", async () => {
		h = await harness(at)
		const claimAt = (i: number) => {
			const claim = h!.registry.claim({
				origin: "scanner-observation",
				kind: "voice-analog",
				sourceId: "source-1",
				hz: 100_000_000 + i * 100_000,
				halfWidthHz: 6_000,
				epoch: 1,
				stream: 0,
				sample: 0,
				atMs: at - 5_000,
				alias: `obs:o_01JTESTOBSERVATIO${i}`,
			})!
			return claim.txId
		}
		const toneOf = async (
			i: number,
			tone: NonNullable<Parameters<typeof analogItem>[1]>["tone"],
		) => {
			const txId = claimAt(i)
			const key = keyOf(10 + i)
			h!.registry.attach(txId, `rec:${key}`)
			h!.items.set(
				key,
				analogItem(key, { txId, ...(tone !== undefined ? { tone } : {}) }),
			)
			return (await get(txId)).json<TransmissionDto>().tone
		}
		expect(
			await toneOf(1, { kind: "dcs", code: "023", polarity: "inverted" }),
		).toEqual({
			state: "heard",
			ctcssHz: null,
			dcs: { code: "023", polarity: "inverted" },
			dcsChecked: true,
			from: "recorder",
			why: null,
		})
		// A sidecar that stored no polarity reads it as unknown.
		expect(await toneOf(2, { kind: "dcs", code: "754" })).toMatchObject({
			dcs: { code: "754", polarity: null },
			dcsChecked: true,
		})
		// "No tone heard" needs the DCS decoder's analysis too.
		expect(await toneOf(3, null)).toMatchObject({
			state: "none",
			dcsChecked: true,
			from: "recorder",
		})
		// A CTCSS fact may predate the recorder's DCS decoder: not proof DCS was looked for.
		expect(await toneOf(4, { kind: "ctcss", hz: 88.5 })).toMatchObject({
			state: "heard",
			dcsChecked: false,
		})
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
		// `known` false: dsd-fme could not tell encryption, so the call is never proven clear and
		// the ingress links none of its file (callTrustAdmits).
		const callEnd = (txId: string, encrypted: boolean, known = true) => ({
			timestamp: new Date(at),
			decoder: "dsd-a",
			type: "call_end" as const,
			data: {
				callId: "call-1",
				protocol: "ysf",
				talkgroup: 100,
				source: 2001,
				duration: 4_200,
				encryptionKnown: known,
				encrypted,
				flags: { encrypted },
				// dsd-fme names the call's file whatever its clearance: the ingress keeps the name.
				wavFile: `/rec/${DSD_NAME}`,
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

		it("a pre-id call reached by evt: or rec: uses its decoder link: clear with the linked file, else unproven", async () => {
			h = await harness(at)
			// A clear call whose file dsd-fme had not named yet (the link comes later).
			const { txId: _none, wavFile: _late, ...data } = callEnd(TX_A, false).data
			h.publish("dsd-a", { ...callEnd(TX_A, false), data })
			await h.rows(1)
			const row = (await h.runtime.service.search({ query: {}, limit: 10 }))
				.items[0]!
			const key = `dsd~${DSD_NAME}`
			h.items.set(key, {
				...analogItem(key),
				kind: "dsd-fme-call",
				discoveryId: null,
				facts: null,
			})
			// Not linked yet: unproven and no audio by its call row; its file's key is no ref at all.
			const dto = (await get(`evt:${row.eventId}`)).json<TransmissionDto>()
			expect(dto).toMatchObject({
				id: null,
				kind: "voice-digital",
				privacy: "unproven",
				artefacts: [],
			})
			// The raw block never shows the file an unproven call lists none of.
			expect(dto.raw.recording).toBeNull()
			expect((await get(`rec:${key}`)).statusCode).toBe(404)
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
			for (const ref of [`evt:${row.eventId}`, `rec:${key}`]) {
				const dto = (await get(ref)).json<TransmissionDto>()
				expect(dto).toMatchObject({
					id: null,
					kind: "voice-digital",
					privacy: "clear",
					artefacts: [{ id: key }],
				})
				expect(dto.raw.recording).toMatchObject({ key })
			}
			// Without the recordings route the linked call lists no audio.
			const bare = await h.app({ inventory: undefined as never })
			const res = await bare.inject({
				method: "GET",
				url: `/api/transmissions/${encodeURIComponent(`evt:${row.eventId}`)}`,
			})
			expect(res.json<TransmissionDto>().artefacts).toEqual([])
		})

		it("a call never proven clear lists no audio (unproven); an encrypted one says so", async () => {
			h = await harness(at)
			const claim = dvClaim(h, at - 4_200)
			h.publish("dsd-a", callEnd(claim.txId, false, false))
			await h.rows(1)
			const unproven = (await get(claim.txId)).json<TransmissionDto>()
			expect(unproven.privacy).toBe("unproven")
			expect(unproven.artefacts).toEqual([])
			h.registry.noteRefusal(claim.txId, "encrypted")
			// An encrypted call's file reached by its recording alias: listed nowhere, raw included.
			const key = `dsd~${DSD_NAME}`
			h.registry.attach(claim.txId, `rec:${key}`)
			h.items.set(key, {
				...analogItem(key),
				kind: "dsd-fme-call",
				discoveryId: null,
				facts: null,
			})
			const encByFile = await get(`rec:${key}`)
			expect(encByFile.statusCode).toBe(404)
			expect(encByFile.json()).toMatchObject({ code: "TRANSMISSION_NOT_FOUND" })
			const enc = (await get(claim.txId)).json<TransmissionDto>()
			expect(enc.privacy).toBe("encrypted")
			expect(enc.artefacts).toEqual([])
			expect(enc.noAudioReason).toBe("encrypted")
		})

		// A file with distinctive values, so any of them in a body is a leak.
		const LEAK = {
			hz: 123_456_789,
			measuredHz: 123_456_987,
			operationId: "op-leak-7f3",
			observationId: "o_01JLEAKOBSERVATION",
			discoveryId: "d_01JLEAKDISCOVERY",
			startedAt: "2025-03-04T05:06:07.000Z",
			endedAt: "2025-03-04T05:06:19.000Z",
		}
		const leakyItem = (key: string) => {
			const base = analogItem(key)
			return {
				...base,
				kind: "dsd-fme-call" as const,
				frequencyHz: LEAK.hz,
				discoveryId: LEAK.discoveryId,
				ownerDiscoveryId: LEAK.discoveryId,
				observationId: LEAK.observationId,
				startedAt: LEAK.startedAt,
				part: 2,
				parts: 3,
				facts: {
					...base.facts!,
					operationId: LEAK.operationId,
					discoveryId: LEAK.discoveryId,
					observationId: LEAK.observationId,
					frequencyHz: LEAK.measuredHz,
					startedAt: LEAK.startedAt,
					endedAt: LEAK.endedAt,
				},
			}
		}
		const expectNoLeak = (body: string, key: string) => {
			expect(body).not.toContain(key)
			expect(body).not.toContain(DSD_NAME)
			for (const v of Object.values(LEAK)) expect(body).not.toContain(String(v))
		}

		it.each([false, true])(
			"an unlinked digital call's file (encrypted: %s) leaks no key, facts, times or frequency by tx_, evt: or rec:",
			async encrypted => {
				h = await harness(at)
				const claim = dvClaim(h, at - 4_200)
				h.publish("dsd-a", callEnd(claim.txId, encrypted, false))
				await h.rows(1)
				const row = (await h.runtime.service.search({ query: {}, limit: 10 }))
					.items[0]!
				const key = `dsd~${DSD_NAME}`
				h.registry.attach(claim.txId, `rec:${key}`)
				h.items.set(key, leakyItem(key))
				const unknown = await get(`rec:dsd~${DSD_NAME.replace("SRC", "SRX")}`)
				// The file's own key answers exactly as an unknown ref: no oracle, no body.
				const byFile = await get(`rec:${key}`)
				expect(byFile.statusCode).toBe(404)
				expect(byFile.body).toBe(unknown.body)
				expectNoLeak(byFile.body, key)
				for (const ref of [claim.txId, `evt:${row.eventId}`]) {
					const res = await get(ref)
					expect(res.statusCode).toBe(200)
					const dto = res.json<TransmissionDto>()
					expect(dto).toMatchObject({
						id: claim.txId,
						kind: "voice-digital",
						privacy: encrypted ? "encrypted" : "unproven",
						protocol: "ysf",
						artefacts: [],
						part: null,
						verdict: { speech: "unchecked", keptBy: null },
						raw: { recording: null, facts: null },
						refs: {
							recordingKeys: [],
							operationId: null,
							discoveryId: null,
							ownerDiscoveryId: null,
						},
						channel: { measuredHz: null },
					})
					// Times fall back to the registry's own.
					expect(dto.startedAt).toBe(new Date(at - 4_200).toISOString())
					expect(
						dto.group?.members.every(m => m.audioId === null && !m.hasAudio),
					).toBe(true)
					expectNoLeak(res.body, key)
				}
			},
		)

		it("a pre-id unproven call reached by evt: or rec: leaks nothing of its file", async () => {
			h = await harness(at)
			const { txId: _none, ...data } = callEnd(TX_A, false, false).data
			h.publish("dsd-a", { ...callEnd(TX_A, false, false), data })
			await h.rows(1)
			const row = (await h.runtime.service.search({ query: {}, limit: 10 }))
				.items[0]!
			const key = `dsd~${DSD_NAME}`
			h.items.set(key, leakyItem(key))
			const res = await get(`evt:${row.eventId}`)
			expect(res.statusCode).toBe(200)
			expect(res.json<TransmissionDto>()).toMatchObject({
				id: null,
				privacy: "unproven",
				startedAt: null,
				raw: { recording: null, facts: null },
				refs: { recordingKeys: [] },
			})
			expectNoLeak(res.body, key)
			expect((await get(`rec:${key}`)).statusCode).toBe(404)
		})

		it("an unlisted dsd-fme key and a key nothing holds answer byte-identical 404s", async () => {
			h = await harness(at)
			const claim = dvClaim(h, at - 4_200)
			h.publish("dsd-a", callEnd(claim.txId, false, false))
			await h.rows(1)
			const key = `dsd~${DSD_NAME}`
			h.registry.attach(claim.txId, `rec:${key}`)
			h.items.set(key, leakyItem(key))
			const held = await get(`rec:${key}`)
			const none = await get(
				"rec:dsd~20261016_120200_05555_YSF_1_GROUP_TGT_100_SRC_2003.wav",
			)
			expect(held.statusCode).toBe(404)
			expect(none.statusCode).toBe(404)
			expect(held.body).toBe(none.body)
			expect(held.headers["content-type"]).toBe(none.headers["content-type"])
			expect(held.headers["cache-control"]).toBe(none.headers["cache-control"])
			expect(held.json()).toMatchObject({ code: "TRANSMISSION_NOT_FOUND" })
		})

		it("a clear call shows only its decoder-linked file, not another file it names", async () => {
			h = await harness(at)
			const claim = dvClaim(h, at - 4_200)
			h.publish("dsd-a", callEnd(claim.txId, false))
			await h.rows(1)
			const key = `dsd~${DSD_NAME}`
			const other = "dsd~20261016_120100_09876_YSF_1_GROUP_TGT_100_SRC_2002.wav"
			h.registry.attach(claim.txId, `rec:${other}`)
			h.items.set(other, leakyItem(other))
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
			const res = await get(claim.txId)
			const dto = res.json<TransmissionDto>()
			expect(dto).toMatchObject({
				privacy: "clear",
				artefacts: [{ id: key }],
				refs: { recordingKeys: [key] },
				raw: { recording: { key } },
			})
			expect(res.body).not.toContain(other)
			expect(res.body).not.toContain(LEAK.operationId)
			// The linked file's name stays in the raw call row; its key resolves, the other's does not.
			expect(
				(dto.raw.activity as { payload: { decodedData: { wavFile?: string } } })
					.payload.decodedData.wavFile,
			).toBe(DSD_NAME)
			const byKey = await get(`rec:${key}`)
			expect(byKey.statusCode).toBe(200)
			expect(byKey.json<TransmissionDto>()).toMatchObject({
				privacy: "clear",
				artefacts: [{ id: key }],
			})
			expect((await get(`rec:${other}`)).statusCode).toBe(404)
			expect(res.body).not.toContain(String(LEAK.hz))
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

import { EventEmitter } from "node:events"
import { rmSync } from "node:fs"
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { makeObs } from "../../../mocks/scanner/observations.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import {
	CHANNEL_OWNER_REACH_HZ,
	type DiscoveryStore,
} from "../../../../src/core/scanner/store/discovery-store.js"
import type {
	DecodeEvidence,
	Identity,
} from "../../../../src/core/scanner/types.js"
import type { DecoderConfig } from "../../../../src/decoders/types.js"

/**
 * A decoder-output envelope from a placed acarsdec or dumpvdl2 to a decoded discovery, with no
 * spectrum track at all (short ACARS blocks and VDL2 frames rarely open one). Synthetic
 * channels, identities and text only.
 */
const ACARS_HZ = 130_050_000
const VDL2_HZ = 130_100_000

interface Case {
	decoder: "acarsdec" | "dumpvdl2"
	type: "acars" | "vdl2"
	protocol: "acars" | "vdl2"
	channelHz: number
	/** The placement's channel; dumpvdl2 decimates a span centred between its channels. */
	placedHz: number
	identity: Identity
	/** Another aircraft on the same channel. */
	otherIdentity: Identity
	data: (n: number, value?: string) => Record<string, unknown>
	unclean: (n: number) => Record<string, unknown>
}

const CASES: Case[] = [
	{
		decoder: "acarsdec",
		type: "acars",
		protocol: "acars",
		channelHz: ACARS_HZ,
		placedHz: ACARS_HZ,
		identity: { kind: "acars-reg", value: "TEST01" },
		otherIdentity: { kind: "acars-reg", value: "TEST02" },
		// acarsdec reading channel audio prints no frequency: the placement names the channel.
		data: (n, value = "TEST01") => ({
			frequency: 0,
			error: 0,
			errorKnown: true,
			tail: `.${value}`,
			label: "H1",
			msgno: `M0${n}A`,
			text: `SYNTHETIC ${n}`,
		}),
		unclean: n => ({
			frequency: 0,
			error: 1,
			errorKnown: true,
			tail: ".TEST01",
			msgno: `M0${n}A`,
			text: `SYNTHETIC ${n}`,
		}),
	},
	{
		decoder: "dumpvdl2",
		type: "vdl2",
		protocol: "vdl2",
		channelHz: VDL2_HZ,
		placedHz: VDL2_HZ - 25_000,
		identity: { kind: "vdl2-addr", value: "ABC001" },
		otherIdentity: { kind: "vdl2-addr", value: "ABC002" },
		data: (n, value = "ABC001") => ({
			frequency: VDL2_HZ,
			fromaddr: value.toLowerCase(),
			toaddr: "100001",
			msgType: "acars",
			acars: {
				error: 0,
				tail: "TEST01",
				msgno: `M0${n}`,
				text: `SYNTHETIC ${n}`,
			},
		}),
		unclean: n => ({
			frequency: VDL2_HZ,
			fromaddr: "abc001",
			msgType: "acars",
			acars: {
				error: 0,
				crcOk: false,
				tail: "TEST01",
				msgno: `M0${n}`,
				text: `SYNTHETIC ${n}`,
			},
		}),
	},
]

async function rig(c: Case) {
	const clock = { at: 100_000 }
	const trust = { value: "commanded" as "commanded" | "unverified" }
	const trustCalls: unknown[][] = []
	const h = serviceHarness({
		centreHz: c.channelHz - 100_000,
		patch: settings => {
			settings.passive.enabled = false
		},
		decoderConfigs: [
			{
				id: "synthetic",
				type: c.decoder,
				enabled: true,
				sourceId: "rtl",
				frequencies: [c.channelHz],
				options: {},
			} as DecoderConfig,
		],
		ambientTrust: (...args) => {
			trustCalls.push(args)
			return trust.value
		},
	})
	const status = {
		id: "synthetic",
		type: c.decoder,
		owner: "config",
		running: true,
		health: "running",
	}
	Object.assign(h.decoders, {
		getAllStatus: () => [status],
		getStatus: () => status,
		getDecoder: () =>
			Object.assign(new EventEmitter(), {
				caps: { input: "iq" },
				getChannelRequest: () => ({ bandwidthHz: 100_000 }),
			}),
	})
	const internal = h.service as unknown as {
		now: () => number
		store: DiscoveryStore
		live: Map<string, LiveObservation>
		ambientObservations: {
			upsert(o: LiveObservation): void
			remove(id: string): void
		}
		classify(t: unknown, s: string): LiveObservation["classification"]
		ingest(l: LiveObservation, t: unknown, endReason?: string): void
		ambientConfirmScope(ctx: {
			sourceId: string
			hz: number
			at: number
			protocol: "acars" | "vdl2"
		}): string | null
	}
	internal.now = () => clock.at
	await h.service.start()
	await h.service.createJob({
		sourceId: "rtl",
		mode: "in-window",
		signalsOnly: true,
	})
	const send = (data: Record<string, unknown>) => {
		h.decoders.emitOutput("synthetic", {
			type: c.type,
			data,
			timestamp: new Date(clock.at),
			provenanceBinding: { sourceId: "rtl", channelHz: c.placedHz },
		} as never)
		clock.at += 2_000
	}
	const discoveries = () => internal.store.snapshot().discoveries
	/**
	 * A live observation at the channel the ambient index places decodes on: discovery-backed
	 * (a stored spectrum discovery, its observation `id`) or observation-only (no discovery).
	 */
	const place = (id: string, backed: boolean): string | null => {
		let discoveryId: string | null = null
		if (backed) {
			discoveryId = internal.store.ingest(
				makeObs({
					id,
					centreHz: c.channelHz,
					startedAt: clock.at - 1_000,
					blocks: 2,
					sourceId: "rtl",
				}),
			).discoveryId
			if (discoveryId === null) throw new Error("spectrum did not surface")
		}
		const track = trackOf({
			trackId: id,
			centreHz: c.channelHz,
			obwHz: 9_000,
			epoch: 1,
		})
		const live = {
			observationId: id,
			sourceId: "rtl",
			trackId: id,
			epoch: 1,
			jobIds: [],
			discoveryId,
			startedAt: clock.at - 1_000,
			classification: internal.classify(track, "rtl"),
			probeIds: new Set(),
			lastActivityAt: clock.at,
			lastIngestAt: clock.at,
			lastTrack: backed ? track : undefined,
			decoded: false,
			encrypted: false,
		} as unknown as LiveObservation
		internal.live.set(id, live)
		internal.ambientObservations.upsert(
			backed ? live : ({ ...live, lastTrack: track } as LiveObservation),
		)
		return discoveryId
	}
	const unplace = (id: string) => {
		internal.live.delete(id)
		internal.ambientObservations.remove(id)
	}
	const stop = async () => {
		await h.service.stop()
		rmSync(h.dir, { recursive: true, force: true })
	}
	return {
		h,
		clock,
		trust,
		trustCalls,
		internal,
		send,
		discoveries,
		place,
		unplace,
		stop,
	}
}

describe.each(CASES)("$decoder envelope to a decoded discovery", c => {
	it("two CRC-clean spaced messages open a decoded discovery at the channel with a checked proof", async () => {
		const r = await rig(c)
		try {
			r.send(c.data(1))
			// One message alone is no identity: nothing is discovered.
			expect(r.discoveries()).toHaveLength(0)
			r.send(c.data(2))
			const all = r.discoveries()
			expect(all).toHaveLength(1)
			const d = r.internal.store.get(all[0]!.id)!
			expect(d).toMatchObject({
				anchor: "decode",
				frequencyHz: c.channelHz,
				protocol: c.protocol,
				confidence: "decoded",
				proof: {
					kind: "decoded",
					protocol: c.protocol,
					transport: "ambient",
					identity: c.identity,
				},
			})
			expect(d.proof!.summary).toContain(c.identity.value)
			expect(r.h.service.trialMemoryOf(d.id)).toEqual([
				expect.objectContaining({
					protocol: c.protocol,
					decoder: c.decoder,
					decoded: 1,
				}),
			])
			// Trust is read at the placement the decode was trusted at.
			expect(r.trustCalls.at(-1)).toEqual([
				"synthetic",
				c.placedHz,
				"rtl",
				{ sourceId: "rtl", channelHz: c.placedHz },
			])
			// A later confirmed message refreshes the same discovery.
			r.send(c.data(3))
			expect(r.discoveries()).toHaveLength(1)
		} finally {
			await r.stop()
		}
	})

	it("messages that failed their CRC never discover or prove, however many arrive", async () => {
		const r = await rig(c)
		try {
			for (let n = 1; n <= 5; n++) r.send(c.unclean(n))
			expect(r.discoveries()).toHaveLength(0)
		} finally {
			await r.stop()
		}
	})

	it("untrusted tuning never discovers, and does not prime the pairing", async () => {
		const r = await rig(c)
		try {
			r.trust.value = "unverified"
			r.send(c.data(1))
			r.send(c.data(2))
			expect(r.discoveries()).toHaveLength(0)
			r.trust.value = "commanded"
			r.send(c.data(3))
			expect(r.discoveries()).toHaveLength(0)
			r.send(c.data(4))
			expect(r.discoveries()).toHaveLength(1)
		} finally {
			await r.stop()
		}
	})

	it("an identical repeat of one message never confirms", async () => {
		const r = await rig(c)
		try {
			r.send(c.data(1))
			r.send(c.data(1))
			r.send(c.data(1))
			expect(r.discoveries()).toHaveLength(0)
		} finally {
			await r.stop()
		}
	})
})

describe.each(CASES)("$decoder pairing scope across placements", c => {
	it("keeps one channel scope whether a decode is unplaced, observation-only or discovery-backed", async () => {
		const r = await rig(c)
		try {
			const scope = () =>
				r.internal.ambientConfirmScope({
					sourceId: "rtl",
					hz: c.channelHz,
					at: r.clock.at,
					protocol: c.protocol,
				})
			const channel = `a:${JSON.stringify(["rtl", c.protocol, c.channelHz])}`
			expect(scope()).toBe(channel)
			r.place("o_only", false)
			expect(scope()).toBe(channel)
			r.unplace("o_only")
			r.place("o_backed", true)
			expect(scope()).toBe(channel)
			r.unplace("o_backed")
			expect(scope()).toBe(channel)
		} finally {
			await r.stop()
		}
	})

	it("unplaced then discovery-backed: the pair confirms on the placed discovery, no anchor", async () => {
		const r = await rig(c)
		try {
			r.send(c.data(1))
			const id = r.place("o_backed", true)!
			r.send(c.data(2))
			const all = r.discoveries()
			expect(all.map(d => d.id)).toEqual([id])
			expect(r.internal.store.get(id)).toMatchObject({
				protocol: c.protocol,
				confidence: "decoded",
				identity: c.identity,
				proof: { kind: "decoded", protocol: c.protocol },
			})
		} finally {
			await r.stop()
		}
	})

	it("discovery-backed then unplaced: the pair proves the stored discovery at the channel, no anchor", async () => {
		const r = await rig(c)
		try {
			const id = r.place("o_backed", true)!
			r.send(c.data(1))
			expect(r.internal.store.get(id)!.confidence).not.toBe("decoded")
			// Its observation has since closed: no live placement names the discovery.
			r.unplace("o_backed")
			r.send(c.data(2))
			expect(r.discoveries().map(d => d.id)).toEqual([id])
			expect(r.internal.store.get(id)).toMatchObject({
				protocol: c.protocol,
				confidence: "decoded",
				identity: c.identity,
			})
			expect(r.h.service.trialMemoryOf(id)).toEqual([
				expect.objectContaining({ protocol: c.protocol, decoder: c.decoder }),
			])
		} finally {
			await r.stop()
		}
	})

	it("unplaced then observation-only and back: the pair anchors at the channel", async () => {
		const r = await rig(c)
		try {
			r.send(c.data(1))
			r.place("o_only", false)
			r.send(c.data(2))
			const all = r.discoveries()
			expect(all).toHaveLength(1)
			expect(all[0]).toMatchObject({
				anchor: "decode",
				frequencyHz: c.channelHz,
				protocol: c.protocol,
			})
			r.unplace("o_only")
			r.send(c.data(3))
			expect(r.discoveries().map(d => d.id)).toEqual([all[0]!.id])
		} finally {
			await r.stop()
		}
	})

	it("the observation-only placement an anchor took stays with it through further ingests and its close", async () => {
		const r = await rig(c)
		try {
			r.send(c.data(1))
			r.place("o_only", false)
			r.send(c.data(2))
			const [anchor] = r.discoveries()
			expect(anchor).toMatchObject({ anchor: "decode", protocol: c.protocol })
			const live = r.internal.live.get("o_only")!
			live.jobIds = r.h.service.listJobs().map(j => j.id)
			expect(live.jobIds).toHaveLength(1)
			const track = trackOf({
				trackId: "o_only",
				centreHz: c.channelHz,
				obwHz: 9_000,
				epoch: 1,
			})
			expect(r.internal.store.anchorHeldCount()).toBe(1)
			r.internal.ingest(live, track)
			r.internal.ingest(live, { ...track, blocks: 40 })
			expect(r.discoveries().map(d => d.id)).toEqual([anchor!.id])
			r.internal.ingest(live, { ...track, blocks: 60 }, "quiet")
			expect(r.discoveries().map(d => d.id)).toEqual([anchor!.id])
			expect(r.internal.store.discoveryIdOf("o_only")).toBeUndefined()
			// The close released the hold.
			expect(r.internal.store.anchorHeldCount()).toBe(0)
		} finally {
			await r.stop()
		}
	})

	it("an anchor that took a closed observation-only placement holds nothing", async () => {
		const r = await rig(c)
		try {
			r.send(c.data(1))
			r.place("o_closed", false)
			// Closed, still indexed for placement, as the service keeps it after its close.
			const closed = r.internal.live.get("o_closed")!
			closed.endedAt = r.clock.at
			r.internal.ambientObservations.upsert({
				...closed,
				lastTrack: trackOf({
					trackId: "o_closed",
					centreHz: c.channelHz,
					obwHz: 9_000,
					epoch: 1,
				}),
			} as LiveObservation)
			r.send(c.data(2))
			expect(r.discoveries()).toEqual([
				expect.objectContaining({ anchor: "decode", protocol: c.protocol }),
			])
			expect(r.internal.store.anchorHeldCount()).toBe(0)
		} finally {
			await r.stop()
		}
	})

	it("observation-only then unplaced: the pair anchors at the channel", async () => {
		const r = await rig(c)
		try {
			r.place("o_only", false)
			r.send(c.data(1))
			expect(r.discoveries()).toHaveLength(0)
			r.unplace("o_only")
			r.send(c.data(2))
			expect(r.discoveries()).toEqual([
				expect.objectContaining({ anchor: "decode", protocol: c.protocol }),
			])
		} finally {
			await r.stop()
		}
	})
})

it("an ACARS message without a printed error count (unknown CRC status) never discovers", async () => {
	const c = CASES[0]!
	const r = await rig(c)
	try {
		for (let n = 1; n <= 4; n++) {
			const { errorKnown: _known, ...data } = c.data(n)
			r.send(data)
		}
		expect(r.discoveries()).toHaveLength(0)
	} finally {
		await r.stop()
	}
})

/** The service internals the ownership tests drive beyond the rig's. */
interface Owned {
	ambient: EventEmitter
	deps: { iqCapture?: unknown }
	onAmbientEvidence(e: {
		decoderId: string
		sourceId: string
		hz: number
		ev: DecodeEvidence
		placement?: { sourceId: string; channelHz: number | null }
	}): void
}

/** A confirmed (identity, CRC-clean) live decode of either channel protocol at `hz`. */
function confirmed(
	protocol: "acars" | "vdl2",
	n: number,
	at: number,
): DecodeEvidence {
	return {
		protocol,
		origin: "ambient",
		crcClean: true,
		epoch: 1,
		at,
		identity:
			protocol === "acars"
				? { kind: "acars-reg", value: `TEST0${n}` }
				: { kind: "vdl2-addr", value: `ABC00${n}` },
		metadata: {},
	}
}

/** Records of the source within the channel's 4 000 Hz reach that publish decoded. */
function decodedNear(store: DiscoveryStore, hz: number): string[] {
	return store
		.snapshot()
		.discoveries.filter(
			d =>
				Math.abs(d.frequencyHz - hz) < CHANNEL_OWNER_REACH_HZ &&
				store.get(d.id)?.confidence === "decoded",
		)
		.map(d => d.id)
		.sort()
}

describe.each(CASES)("$decoder channel ownership at a placed discovery", c => {
	it("M1: another aircraft at a discovery-backed placement keeps one record, its proof citing the latest", async () => {
		const r = await rig(c)
		try {
			const id = r.place("o_backed", true)!
			r.send(c.data(1))
			r.send(c.data(2))
			expect(r.internal.store.get(id)).toMatchObject({
				confidence: "decoded",
				proof: { kind: "decoded", identity: c.identity },
			})
			r.send(c.data(3, c.otherIdentity.value))
			r.send(c.data(4, c.otherIdentity.value))
			expect(r.discoveries().map(d => d.id)).toEqual([id])
			expect(decodedNear(r.internal.store, c.channelHz)).toEqual([id])
			expect(r.internal.store.get(id)).toMatchObject({
				protocol: c.protocol,
				confidence: "decoded",
				proof: {
					kind: "decoded",
					protocol: c.protocol,
					identity: c.otherIdentity,
				},
			})
			// The first aircraft again: still the one record, the proof follows it.
			r.send(c.data(5))
			r.send(c.data(6))
			expect(r.discoveries().map(d => d.id)).toEqual([id])
			expect(r.internal.store.get(id)!.proof!.identity).toEqual(c.identity)
		} finally {
			await r.stop()
		}
	})

	it("M2: a decode of the other protocol at a placed discovery decoded as this one is refused", async () => {
		const r = await rig(c)
		try {
			const id = r.place("o_backed", true)!
			r.send(c.data(1))
			r.send(c.data(2))
			const other = c.protocol === "acars" ? "vdl2" : "acars"
			const internal = r.internal as unknown as Owned
			internal.onAmbientEvidence({
				decoderId: "synthetic",
				sourceId: "rtl",
				hz: c.channelHz,
				ev: confirmed(other, 9, r.clock.at),
				placement: { sourceId: "rtl", channelHz: c.channelHz },
			})
			expect(r.discoveries().map(d => d.id)).toEqual([id])
			expect(r.internal.store.get(id)).toMatchObject({
				protocol: c.protocol,
				confidence: "decoded",
				proof: { protocol: c.protocol, identity: c.identity },
			})
			const observation = r.internal.store
				.snapshot()
				.observations.find(o => o.id === "o_backed")!
			expect(
				(observation.decode ?? []).filter(ev => ev.protocol === other),
			).toEqual([])
		} finally {
			await r.stop()
		}
	})

	it("M2: a decode of the other protocol at a channel anchor is refused, the anchor keeps the channel", async () => {
		const r = await rig(c)
		try {
			r.send(c.data(1))
			r.send(c.data(2))
			const [anchor] = r.discoveries()
			expect(anchor).toMatchObject({ anchor: "decode", protocol: c.protocol })
			const other = c.protocol === "acars" ? "vdl2" : "acars"
			const internal = r.internal as unknown as Owned
			// Unplaced, then observation-only and discovery-backed placements alike.
			internal.onAmbientEvidence({
				decoderId: "synthetic",
				sourceId: "rtl",
				hz: c.channelHz,
				ev: confirmed(other, 9, r.clock.at),
			})
			r.place("o_only", false)
			internal.onAmbientEvidence({
				decoderId: "synthetic",
				sourceId: "rtl",
				hz: c.channelHz,
				ev: confirmed(other, 8, r.clock.at + 1),
			})
			expect(r.discoveries().map(d => d.id)).toEqual([anchor!.id])
			expect(r.internal.store.decodeAnchorFor("rtl", c.channelHz)?.id).toBe(
				anchor!.id,
			)
		} finally {
			await r.stop()
		}
	})

	it("M3: a discovery-backed placement re-reads trust at the decode's placement and refuses when untrusted", async () => {
		const r = await rig(c)
		try {
			const id = r.place("o_backed", true)!
			const internal = r.internal as unknown as Owned
			let confirmedSeen = 0
			// Acceptance read trust as commanded; the tuning moved before the decode is placed.
			internal.ambient.prependListener(
				"evidence",
				(e: { ev: DecodeEvidence }) => {
					if (e.ev.identity === undefined) return
					confirmedSeen += 1
					r.trust.value = "unverified"
				},
			)
			r.send(c.data(1))
			r.send(c.data(2))
			expect(confirmedSeen).toBeGreaterThan(0)
			expect(r.discoveries().map(d => d.id)).toEqual([id])
			expect(r.internal.store.get(id)!.confidence).not.toBe("decoded")
			// The observation holds no checked identity either (only the lone first message).
			expect(
				(
					r.internal.store
						.snapshot()
						.observations.find(o => o.id === "o_backed")!.decode ?? []
				).filter(ev => ev.identity !== undefined),
			).toEqual([])
			// The re-read named the decode's placement.
			expect(r.trustCalls.at(-1)).toEqual([
				"synthetic",
				c.placedHz,
				"rtl",
				{ sourceId: "rtl", channelHz: c.placedHz },
			])
		} finally {
			await r.stop()
		}
	})

	it("M3: a replayed decode at a discovery-backed placement from an untrusted capture proves nothing", async () => {
		const r = await rig(c)
		try {
			const id = r.place("o_backed", true)!
			const internal = r.internal as unknown as Owned
			const capture = { trust: "unverified" as "commanded" | "unverified" }
			internal.deps.iqCapture = {
				view: () => ({
					captureId: "cap-1",
					sourceId: "rtl",
					observationId: "o_backed",
					epoch: 1,
					rfHz: c.channelHz,
					tuningTrust: capture.trust,
					capturedAtMs: r.clock.at,
					durationMs: 500,
					gapSamples: 0,
				}),
			}
			const replay = (captureId: string) =>
				r.h.service.applyReplayResult({
					captureId,
					sourceId: "rtl",
					observationId: "o_backed",
					epoch: 1,
					rfHz: c.channelHz,
					trials: [
						{
							protocol: c.protocol,
							decoderType: c.decoder,
							known: true,
							outcome: "decoded",
						},
					],
					decoded: { protocol: c.protocol, identity: c.identity },
				})
			replay("cap-1")
			expect(r.internal.store.get(id)!.confidence).not.toBe("decoded")
			expect(r.discoveries().map(d => d.id)).toEqual([id])
			capture.trust = "commanded"
			replay("cap-2")
			expect(r.internal.store.get(id)).toMatchObject({
				confidence: "decoded",
				proof: { identity: c.identity },
			})
		} finally {
			await r.stop()
		}
	})
})

describe.each(CASES)("$decoder replay at an anchor-owned channel", c => {
	it("a replay on an observation with its own spectrum record goes to the channel's anchor", async () => {
		const r = await rig(c)
		try {
			r.send(c.data(1))
			r.send(c.data(2))
			const [anchor] = r.discoveries()
			expect(anchor).toMatchObject({ anchor: "decode", protocol: c.protocol })
			// The anchor is stale by the store's clock (its decodes are at the rig's): a record opens.
			const id = r.place("o_backed", true)!
			const internal = r.internal as unknown as Owned
			internal.deps.iqCapture = {
				view: () => ({
					captureId: "cap-1",
					sourceId: "rtl",
					observationId: "o_backed",
					epoch: 1,
					rfHz: c.channelHz,
					tuningTrust: "commanded",
					capturedAtMs: r.clock.at,
					durationMs: 500,
					gapSamples: 0,
				}),
			}
			r.h.service.applyReplayResult({
				captureId: "cap-1",
				sourceId: "rtl",
				observationId: "o_backed",
				epoch: 1,
				rfHz: c.channelHz,
				trials: [
					{
						protocol: c.protocol,
						decoderType: c.decoder,
						known: true,
						outcome: "decoded",
					},
				],
				decoded: { protocol: c.protocol, identity: c.otherIdentity },
			})
			r.internal.store.stopAnchorExpiry()
			expect(r.internal.store.get(id)!.confidence).not.toBe("decoded")
			expect(decodedNear(r.internal.store, c.channelHz)).toEqual([anchor!.id])
			expect(r.internal.store.get(anchor!.id)!.proof).toMatchObject({
				transport: "replay",
				identity: c.otherIdentity,
			})
		} finally {
			await r.stop()
		}
	})
})

interface ReplayStep {
	k: "replay"
	protocol: "acars" | "vdl2"
	n: number
	onLive: boolean
}

describe("one owner per channel through the service", () => {
	type Step =
		| { k: "open"; backed: boolean }
		| { k: "close" }
		| { k: "live"; protocol: "acars" | "vdl2"; n: number }
		| ReplayStep
	const protocol = fc.constantFrom<"acars" | "vdl2">("acars", "vdl2")
	const n = fc.integer({ min: 1, max: 3 })
	const step: fc.Arbitrary<Step> = fc.oneof(
		fc.record({ k: fc.constant("open" as const), backed: fc.boolean() }),
		fc.constant({ k: "close" as const }),
		fc.record({ k: fc.constant("live" as const), protocol, n }),
		fc.record({
			k: fc.constant("replay" as const),
			protocol,
			n,
			onLive: fc.boolean(),
		}),
	)
	const c = CASES[0]!

	// Feature: ACARS and VDL2 channel identity, Property 3: one owner per channel through the service
	// Validates: M1 (another aircraft at a discovery-backed placement never splits the record), M2
	// (one owner per source and channel across ACARS and VDL2), M4 (a stale anchor lets a spectrum
	// record open, and the one-owner rule holds when the anchor is next proven), live ambient and
	// replayed decodes alike
	it("any interleaving of placements, aircraft and protocols ends with exactly one decoded record (property)", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.tuple(step, fc.integer({ min: 0, max: 90_000 })), {
					maxLength: 14,
				}),
				async steps => {
					const r = await rig(c)
					const internal = r.internal as unknown as Owned
					// The store's freshness clock is the rig's (a stale anchor needs > 60 000 ms).
					;(r.internal.store as unknown as { now: () => number }).now = () =>
						r.clock.at
					internal.deps.iqCapture = {
						view: (captureId: string) => ({
							captureId,
							sourceId: "rtl",
							observationId: null,
							epoch: 1,
							rfHz: c.channelHz,
							tuningTrust: "commanded",
							capturedAtMs: r.clock.at,
							durationMs: 500,
							gapSamples: 0,
						}),
					}
					const opened: string[] = []
					let seq = 0
					const claims = () => decodedNear(r.internal.store, c.channelHz)
					try {
						for (const [st, dt] of steps) {
							r.clock.at += dt
							if (st.k === "open") {
								const id = `o${seq++}`
								let backed = st.backed
								if (backed) {
									try {
										r.place(id, true)
									} catch {
										// A fresh anchor keeps the record from opening: observation-only.
										backed = false
									}
								}
								if (!backed) r.place(id, false)
								opened.push(id)
							} else if (st.k === "close") {
								const id = opened.shift()
								if (id !== undefined) r.unplace(id)
							} else if (st.k === "live") {
								internal.onAmbientEvidence({
									decoderId: "synthetic",
									sourceId: "rtl",
									hz: c.channelHz,
									ev: confirmed(st.protocol, st.n, r.clock.at),
									placement: { sourceId: "rtl", channelHz: c.channelHz },
								})
							} else {
								const observationId = st.onLive
									? (opened.at(-1) ?? `o_gone${seq++}`)
									: `o_gone${seq++}`
								r.h.service.applyReplayResult({
									captureId: `cap${seq++}`,
									sourceId: "rtl",
									observationId,
									epoch: 1,
									rfHz: c.channelHz + 1_500,
									trials: [
										{
											protocol: st.protocol,
											decoderType:
												st.protocol === "acars" ? "acarsdec" : "dumpvdl2",
											known: true,
											outcome: "decoded",
										},
									],
									decoded: {
										protocol: st.protocol,
										identity: confirmed(st.protocol, st.n, 0).identity!,
									},
								})
							}
							expect(claims().length).toBeLessThanOrEqual(1)
						}
						// A last decode of the channel's protocol (the owner's, else ACARS) proves its owner.
						r.clock.at += 1
						const [owner] = claims()
						const last =
							owner === undefined
								? "acars"
								: (r.internal.store.get(owner)!.protocol as "acars" | "vdl2")
						internal.onAmbientEvidence({
							decoderId: "synthetic",
							sourceId: "rtl",
							hz: c.channelHz,
							ev: confirmed(last, 3, r.clock.at),
							placement: { sourceId: "rtl", channelHz: c.channelHz },
						})
						r.internal.store.stopAnchorExpiry()
						const owners = claims()
						expect(owners).toHaveLength(1)
						expect(r.internal.store.get(owners[0]!)).toMatchObject({
							confidence: "decoded",
							evidenceLevel: "proven",
							proof: { kind: "decoded", protocol: last },
						})
					} finally {
						await r.stop()
					}
				},
			),
			{
				numRuns: 100,
				examples: [
					// M2: an ACARS anchor, then a VDL2 decode at its channel.
					[
						[
							[{ k: "live", protocol: "acars", n: 1 }, 0],
							[{ k: "live", protocol: "vdl2", n: 1 }, 0],
						],
					],
					// M1: a discovery-backed placement, then another aircraft (the last decode's).
					[
						[
							[{ k: "open", backed: true }, 0],
							[{ k: "live", protocol: "acars", n: 1 }, 0],
						],
					],
					// M4: an anchor gone stale, a spectrum record opening, the anchor proven again.
					[
						[
							[{ k: "live", protocol: "acars", n: 1 }, 0],
							[{ k: "open", backed: true }, 60_001],
							[{ k: "live", protocol: "acars", n: 2 }, 0],
						],
					],
					// Replays of both protocols at a discovery-backed placement.
					[
						[
							[{ k: "open", backed: true }, 0],
							[{ k: "replay", protocol: "vdl2", n: 1, onLive: true }, 0],
							[{ k: "replay", protocol: "acars", n: 2, onLive: true }, 0],
						],
					],
				],
			},
		)
	}, 600_000)
})

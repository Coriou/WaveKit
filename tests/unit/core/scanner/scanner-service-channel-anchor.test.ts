import { EventEmitter } from "node:events"
import { rmSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { makeObs } from "../../../mocks/scanner/observations.js"
import type { LiveObservation } from "../../../../src/core/scanner/job-runner.js"
import type { DiscoveryStore } from "../../../../src/core/scanner/store/discovery-store.js"
import type { DecoderConfig } from "../../../../src/decoders/types.js"

/**
 * A decoder-output envelope from a placed acarsdec or dumpvdl2 to a decoded discovery, with no
 * spectrum track at all (short ACARS blocks and VDL2 frames rarely open one). Synthetic
 * channels, identities and text only.
 */
const ACARS_HZ = 130_025_000
const VDL2_HZ = 130_075_000

interface Case {
	decoder: "acarsdec" | "dumpvdl2"
	type: "acars" | "vdl2"
	protocol: "acars" | "vdl2"
	channelHz: number
	/** The placement's channel; dumpvdl2 decimates a span centred between its channels. */
	placedHz: number
	identity: { kind: string; value: string }
	data: (n: number) => Record<string, unknown>
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
		// acarsdec reading channel audio prints no frequency: the placement names the channel.
		data: n => ({
			frequency: 0,
			error: 0,
			errorKnown: true,
			tail: ".TEST01",
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
		data: n => ({
			frequency: VDL2_HZ,
			fromaddr: "abc001",
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

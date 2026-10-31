import { EventEmitter } from "node:events"
import { rmSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { serviceHarness } from "../../../mocks/scanner/service-fakes.js"
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
	const stop = async () => {
		await h.service.stop()
		rmSync(h.dir, { recursive: true, force: true })
	}
	return { h, clock, trust, trustCalls, internal, send, discoveries, stop }
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

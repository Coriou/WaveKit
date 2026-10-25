import type { EventEmitter } from "node:events"
import { expect, it } from "vitest"
import {
	CENTRE,
	feedTones,
	serviceHarness,
	tick,
} from "../../../mocks/scanner/service-fakes.js"

type Internals = {
	ambient: EventEmitter
	live: Map<string, { epoch: number; lastTrack: { centreHz: number } | null }>
}

async function setup() {
	const h = serviceHarness({
		patch: s => {
			s.passive.enabled = false
		},
	})
	await h.service.start()
	await h.service.createJob({
		sourceId: "rtl",
		mode: "in-window",
		ranges: [{ startHz: CENTRE, endHz: CENTRE + 400_000 }],
	})
	feedTones(h.fanout, 2, [
		{ offsetHz: 56_250, amp: 0.1 },
		{ offsetHz: 156_250, amp: 0.4 },
	])
	await tick(50)
	const internals = h.service as unknown as Internals
	const epoch = [...internals.live.values()][0]?.epoch ?? 0
	const emit = (centreHz: number, halfHz: number) =>
		internals.ambient.emit("evidence", {
			decoderId: "rtl433",
			sourceId: "rtl",
			hz: centreHz,
			passband: { centreHz, halfHz },
			ev: {
				protocol: "ism",
				identity: { kind: "ism-model", value: "Acurite-Tower:42" },
				metadata: { ismModels: ["Acurite-Tower"] },
				crcClean: true,
				at: Date.now(),
				epoch,
				origin: "ambient",
				decoderId: "rtl433",
			},
		})
	const identified = () =>
		h.service
			.listDiscoveries({})
			.items.filter(d =>
				h.service
					.discoveryObservations(d.id, null, 10)
					.items.some(o =>
						(o.decode ?? []).some(
							e => e.identity?.value === "Acurite-Tower:42",
						),
					),
			)
			.map(d => d.frequencyHz)
	return { h, emit, identified }
}

it("an rtl433 channel decode identifies one discovery inside the passband", async () => {
	const { h, emit, identified } = await setup()
	// Passband 131.25 kHz +/- 70 kHz (61.25-201.25 kHz) holds the 156.25 kHz tone, not 56.25 kHz.
	emit(CENTRE + 131_250, 70_000)
	const got = identified()
	expect(got).toHaveLength(1)
	expect(Math.abs(got[0]! - (CENTRE + 156_250))).toBeLessThan(2_000)
	await h.service.stop()
}, 20_000)

it("an rtl433 channel decode with no discovery in its passband identifies nothing", async () => {
	const { h, emit, identified } = await setup()
	emit(CENTRE + 300_000, 20_000)
	expect(identified()).toEqual([])
	await h.service.stop()
}, 20_000)

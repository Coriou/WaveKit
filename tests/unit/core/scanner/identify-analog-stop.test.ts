import { verifiedLinkLine } from "./verified-link-fake.js"
/** WG11 req 1.2: analog evidence ends only the other live-audio trials; digital trials run to their own end. */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { ScannerIdentifyTrial } from "@wavekit/api-types"
import type { AmbientCoverageLike } from "../../../../src/core/scanner/identify.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { flushAsync } from "../../../mocks/scanner/probe-fakes.js"
import { harness, tx } from "./identify-heard-fakes.js"

const AIS: AmbientCoverageLike = {
	decoderId: "a1",
	type: "ais-catcher",
	protocol: "ais",
}
const dmrTrack = () => trackOf({ acf30: -0.94, acf60: 0.99 })
const FINAL = ["identified", "candidate", "unidentified"]

function outcomes(trials: readonly ScannerIdentifyTrial[]) {
	return Object.fromEntries(trials.map(t => [t.protocol, t.outcome]))
}

describe("analog evidence does not stop digital trials (WG11 1.2)", () => {
	it("an ambient digital trial keeps running after an analog match and ends by its deadline", async () => {
		const h = harness({
			ambient: () => [AIS],
			request: { protocols: ["analog-fm", "analog-am", "ais"] },
		})
		h.port.list = [tx()]
		await h.start()
		// Analog decided at once; the AIS trial is still running (WG10 ended it not-needed here).
		expect(outcomes(h.last()!.trials)).toEqual({
			"analog-fm": "decoded",
			"analog-am": "not-needed",
			ais: "running",
		})
		expect(FINAL).not.toContain(h.last()?.state)
		await h.settle()
		expect(outcomes(h.last()!.trials)).toMatchObject({ ais: "timeout" })
		expect(h.last()?.state).toBe("identified")
		expect(h.events.filter(e => FINAL.includes(e.state))).toHaveLength(1)
	})

	it("a probe run keeps its hold after an analog match (no not-needed); the target finishes once after it", async () => {
		const h = harness({ request: { protocols: [] } })
		h.port.list = [tx({ ctcssHz: null })]
		h.engine.push(1_100_000)
		await h.start(dmrTrack())
		await h.settle(500, 120)
		const last = h.last()!
		for (const t of last.trials)
			if (t.decoder !== "live-audio") expect(t.outcome).not.toBe("not-needed")
		expect(last.trials.find(t => t.protocol === "dmr")?.outcome).toBe("no-sync")
		expect(h.events.filter(e => FINAL.includes(e.state))).toHaveLength(1)
		expect(h.record.state).toBe("completed")
	})

	it("a digital decode still ends the others not-needed (not exhaustive)", async () => {
		const h = harness({ request: { protocols: [] }, ambient: () => [AIS] })
		h.port.list = []
		h.engine.push(1_100_000)
		await h.start(dmrTrack())
		const id = [...h.decoders.created.values()][0]?.id ?? ""
		h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now))
		h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now + 30))
		await flushAsync()
		await h.settle(500, 120)
		const o = outcomes(h.last()!.trials)
		expect(o["dmr"]).toBe("decoded")
		expect(o["analog-fm"]).toBe("not-needed")
		expect(o["ais"]).toBe("not-needed")
	})

	// Feature: web-gaps-11, Property 2: Analog never stops digital
	// Validates: Requirements 1.2
	it("property: no non-analog trial ends not-needed unless a digital decode (not exhaustive); one final state", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.record({
					analog: fc.constantFrom("none", "tone", "plain"),
					ambient: fc.boolean(),
					exhaustive: fc.boolean(),
					decodeAfterMs: fc.oneof(
						fc.constant<null>(null),
						fc.integer({ min: 0, max: 3000 }),
					),
				}),
				async c => {
					const h = harness({
						request: {
							protocols: ["dmr", "analog-fm", "analog-am", "ais"],
							exhaustive: c.exhaustive,
						},
						...(c.ambient ? { ambient: () => [AIS] } : {}),
					})
					h.port.list =
						c.analog === "none"
							? []
							: [tx(c.analog === "plain" ? { ctcssHz: null } : {})]
					h.engine.push(1_100_000)
					await h.start(dmrTrack())
					let decoded = false
					if (c.decodeAfterMs !== null) {
						await h.advance(c.decodeAfterMs)
						const id = [...h.decoders.created.values()][0]?.id
						if (id && !FINAL.includes(h.last()?.state ?? "")) {
							h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now))
							h.decoders.emitLink(id, verifiedLinkLine(1, h.clock.now + 30))
							await flushAsync()
							decoded =
								h
									.last()
									?.trials.some(
										t => t.outcome === "decoded" && t.decoder !== "live-audio",
									) ?? false
						}
					}
					await h.settle(3000, 12)
					const last = h.last()!
					for (const t of last.trials)
						if (t.decoder !== "live-audio" && t.outcome === "not-needed")
							expect(decoded && !c.exhaustive).toBe(true)
					expect(h.events.filter(e => FINAL.includes(e.state))).toHaveLength(1)
					expect(h.record.state).toBe("completed")
				},
			),
			{ numRuns: 100 },
		)
	}, 20_000) // load headroom: about 1.5-3 s on an idle machine
})

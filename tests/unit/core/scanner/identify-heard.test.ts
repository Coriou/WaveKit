/** WG11 req 1.1: a live-audio match without a CTCSS tone or DCS code is `heard`, not `decoded`. */
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { AnalogEvidenceTransmission } from "../../../../src/core/scanner/identify-analog-contract.js"
import { trackOf } from "../../../mocks/scanner/identify-fakes.js"
import { START, harness, tx } from "./identify-heard-fakes.js"

const analogOnly = {
	request: { protocols: ["analog-fm" as const, "analog-am" as const] },
}

async function run(list: AnalogEvidenceTransmission[]) {
	const h = harness(analogOnly)
	h.port.list = list
	await h.start()
	await h.settle()
	return h
}

describe("heard versus decoded (WG11 1.1)", () => {
	it("an NFM match without tone or code is heard; the verdict stays candidate", async () => {
		const h = await run([tx({ ctcssHz: null })])
		expect(h.trials()).toEqual({
			"analog-fm": "heard",
			"analog-am": "not-needed",
		})
		expect(h.last()?.state).toBe("candidate")
		expect(h.last()?.result?.analog).toMatchObject({ ctcssHz: null, dcs: null })
	})

	it("a CTCSS tone decodes (identified on a commanded frequency)", async () => {
		const h = await run([tx()])
		expect(h.trials()["analog-fm"]).toBe("decoded")
		expect(h.last()?.state).toBe("identified")
	})

	it("a DCS code decodes", async () => {
		const h = await run([
			tx({ ctcssHz: null, dcs: { code: "023", polarity: "normal" } }),
		])
		expect(h.trials()["analog-fm"]).toBe("decoded")
	})

	it("the newest matching transmission decides: older tone, newest without is heard", async () => {
		const h = await run([
			tx({ transmissionId: "old", endedAtMs: START - 2000 }),
			tx({ transmissionId: "new", endedAtMs: START - 500, ctcssHz: null }),
		])
		expect(h.trials()["analog-fm"]).toBe("heard")
		expect(h.last()?.result?.analog?.transmissionId).toBe("new")
	})

	it("the newest matching transmission decides: newest with a tone is decoded", async () => {
		const h = await run([
			tx({ transmissionId: "old", endedAtMs: START - 2000, ctcssHz: null }),
			tx({ transmissionId: "new", endedAtMs: START - 500 }),
		])
		expect(h.trials()["analog-fm"]).toBe("decoded")
	})

	it("a non-standard tone is no tone: heard", async () => {
		const h = await run([tx({ ctcssHz: 99.9 })])
		expect(h.trials()["analog-fm"]).toBe("heard")
	})

	it("heard is final: later ticks never reset it", async () => {
		const h = harness(analogOnly)
		h.port.list = [tx({ ctcssHz: null })]
		await h.start()
		await h.advance(100)
		const seen = h.events
			.flatMap(e => e.trials)
			.filter(t => t.protocol === "analog-fm")
		const firstHeard = seen.findIndex(t => t.outcome === "heard")
		expect(firstHeard).toBeGreaterThanOrEqual(0)
		expect(seen.slice(firstHeard).every(t => t.outcome === "heard")).toBe(true)
	})

	it("no probe or ambient digital trial ever ends heard", async () => {
		const h = harness({ request: { protocols: [] } })
		h.port.list = [tx({ ctcssHz: null })]
		h.engine.push(1_100_000)
		await h.start(trackOf({ obwHz: 11_000, spectralShape: "flat" }))
		await h.settle(1000, 80)
		for (const e of h.events)
			for (const t of e.trials)
				if (t.outcome === "heard") expect(t.decoder).toBe("live-audio")
		expect(h.trials()["analog-fm"]).toBe("heard")
	})

	// Feature: web-gaps-11, Property 1: Heard is honest
	// Validates: Requirements 1.1
	it("property: decoded iff the newest match carried a tone or code, heard otherwise, verdict as WG10", async () => {
		const tone = fc.oneof(
			fc.constant<null>(null),
			fc.constantFrom(67, 88.5, 99.9),
		)
		const dcs = fc.oneof(
			fc.constant<null>(null),
			fc.constantFrom(
				{ code: "023", polarity: "normal" as const },
				{ code: "999", polarity: "inverted" as const },
			),
		)
		const one = fc.record({
			ctcssHz: tone,
			dcs,
			tuningTrust: fc.constantFrom(
				"commanded" as const,
				"relay" as const,
				"unverified" as const,
			),
			modulation: fc.constantFrom("nfm", "am", "usb"),
			endedOffset: fc.integer({ min: 100, max: 5000 }),
		})
		await fc.assert(
			fc.asyncProperty(
				fc.uniqueArray(one, {
					minLength: 1,
					maxLength: 3,
					selector: x => x.endedOffset,
				}),
				async xs => {
					const list = xs.map((x, i) =>
						tx({
							transmissionId: `t${i}`,
							ctcssHz: x.ctcssHz,
							dcs: x.dcs,
							tuningTrust: x.tuningTrust,
							modulation: x.modulation,
							startedAtMs: START - x.endedOffset - 1000,
							endedAtMs: START - x.endedOffset,
						}),
					)
					const h = await run(list)
					const standardTone = (x: (typeof xs)[number]) =>
						(x.ctcssHz !== null && x.ctcssHz !== 99.9) ||
						(x.dcs !== null && x.dcs.code === "023")
					const newest = (mods: string[]) =>
						xs
							.filter(x => mods.includes(x.modulation))
							.sort((a, b) => a.endedOffset - b.endedOffset)[0]
					const fm = newest(["nfm"])
					const am = newest(["am"])
					const expectFor = (m: (typeof xs)[number] | undefined) =>
						m ? (standardTone(m) ? "decoded" : "heard") : null
					const got = h.trials()
					const efm = expectFor(fm)
					const eam = expectFor(am)
					if (efm) expect(got["analog-fm"]).toBe(efm)
					else expect(got["analog-fm"]).not.toMatch(/^(heard|decoded)$/)
					if (eam) expect(got["analog-am"]).toBe(eam)
					else expect(got["analog-am"]).not.toMatch(/^(heard|decoded)$/)
					// The WG10 verdict: the newest match of either protocol; identified only with a tone on a trusted frequency.
					const best = newest(["nfm", "am"])
					const state = h.last()?.state
					if (!best) expect(state).not.toBe("identified")
					else
						expect(state).toBe(
							standardTone(best) && best.tuningTrust !== "unverified"
								? "identified"
								: "candidate",
						)
				},
			),
			{ numRuns: 100 },
		)
	}, 20_000) // load headroom: about 1.5-3 s on an idle machine
})

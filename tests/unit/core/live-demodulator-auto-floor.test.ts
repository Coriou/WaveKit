/**
 * WG10 req 2.6, measureRun side: in auto nfm/wfm a block the carrier
 * observer marks quieted never seeds or raises the floor; falls still apply.
 * The gate-before-floor decision lives in ChannelSquelch (its own tests).
 */

import { describe, it, expect, afterEach } from "vitest"
import fc from "fast-check"
import { createDemodHarness } from "./live-demodulator-continuity-fakes.js"

type Harness = Awaited<ReturnType<typeof createDemodHarness>>
let harness: Harness | null = null

afterEach(async () => {
	await harness?.dispose()
	harness = null
})

interface FakeSquelch {
	powerDbfs: number | null
	quieted: boolean
	open: boolean
	floors: Array<number | null>
	blockQuieted(): boolean
	setNoiseFloorDbfs(value: number | null): void
	setThreshold(value: number | null): void
}

function fakeSquelch(): FakeSquelch {
	return {
		powerDbfs: null,
		quieted: false,
		open: false,
		floors: [],
		blockQuieted() {
			return this.quieted
		},
		setNoiseFloorDbfs(value) {
			this.floors.push(value)
		},
		setThreshold() {
			// threshold is read back through getStatus
		},
	}
}

type Run = { squelch: unknown; noiseFloorDbfs: number | null }
type Internals = { run: Run | null; measureRun(run: Run): void }

async function setup(config: Record<string, unknown>) {
	harness = await createDemodHarness({ config })
	await harness.demod.start()
	const internals = harness.demod as unknown as Internals
	const run = internals.run!
	const squelch = fakeSquelch()
	run.squelch = squelch
	run.noiseFloorDbfs = null
	const step = (power: number, quieted: boolean, open = false) => {
		squelch.powerDbfs = power
		squelch.quieted = quieted
		squelch.open = open
		internals.measureRun(run)
		return run.noiseFloorDbfs
	}
	return { h: harness, run, squelch, step }
}

describe("LiveDemodulator auto floor (WG10 req 2.6, measureRun)", () => {
	it("a quieted block never seeds the floor; the first unquieted block does", async () => {
		const { step } = await setup({ squelchMode: "auto", modulation: "nfm" })
		expect(step(-5, true)).toBeNull()
		expect(step(-5, true)).toBeNull()
		expect(step(-60, false)).toBe(-60)
	})

	it("a quieted block never raises the floor but a fall still applies", async () => {
		const { step } = await setup({ squelchMode: "auto", modulation: "wfm" })
		expect(step(-60, false)).toBe(-60)
		expect(step(-5, true)).toBe(-60)
		expect(step(-5, true, true)).toBe(-60)
		expect(step(-70, true)).toBe(-70)
		// An unquieted block rises at 1 dB/s closed: 0.01 dB per block.
		expect(step(-50, false)).toBeCloseTo(-69.99, 6)
	})

	it("after a retune the remembered floor waits for the first unquieted block", async () => {
		const { h, run, step } = await setup({
			squelchMode: "auto",
			modulation: "nfm",
		})
		expect(step(-80, false)).toBe(-80)
		h.sourceManager.emitCaps({ centerFreq: 446_100_000 })
		expect(run.noiseFloorDbfs).toBeNull()
		expect(step(-3, true)).toBeNull()
		// WG9 5.6: seed min(previous floor, power) once.
		expect(step(-60, false)).toBe(-80)
	})

	// Feature: web-gaps-10, Property 6: A carrier never seeds the floor
	// Validates: Requirements 2.6
	it("property 6: no quieted block's power is ever the seed or raises the floor", async () => {
		const { h, run, step } = await setup({
			squelchMode: "auto",
			modulation: "nfm",
		})
		const block = fc.oneof(
			fc.record({
				kind: fc.constant("block" as const),
				power: fc.double({ min: -160, max: -0.001, noNaN: true }),
				quieted: fc.boolean(),
				open: fc.boolean(),
			}),
			fc.record({ kind: fc.constant("retune" as const) }),
		)
		fc.assert(
			fc.property(fc.array(block, { maxLength: 60 }), sequence => {
				run.noiseFloorDbfs = null
				;(
					run as unknown as { retuneFloorDbfs: number | null }
				).retuneFloorDbfs = null
				for (const item of sequence) {
					if (item.kind === "retune") {
						h.sourceManager.emitCaps({ centerFreq: 446_000_000 })
						continue
					}
					const before = run.noiseFloorDbfs
					const after = step(item.power, item.quieted, item.open)
					if (!item.quieted) continue
					if (before === null) expect(after).toBeNull()
					else expect(after).toBe(Math.min(before, item.power))
				}
			}),
			{ numRuns: 200 },
		)
	})

	for (const [name, config] of [
		["manual nfm", { squelchMode: "manual", modulation: "nfm" }],
		["noise nfm", { squelchMode: "noise", modulation: "nfm" }],
		["auto am", { squelchMode: "auto", modulation: "am" }],
	] as const) {
		it(`builds no carrier observer in ${name} (blockQuieted stays false)`, async () => {
			harness = await createDemodHarness({ config })
			await harness.demod.start()
			const run = (harness.demod as unknown as Internals).run!
			const squelch = run.squelch as {
				blockQuieted(): boolean
				hasCarrierObserver: boolean
			}
			expect(squelch.hasCarrierObserver).toBe(false)
			expect(squelch.blockQuieted()).toBe(false)
		})
	}

	it("builds the carrier observer in auto nfm and wfm", async () => {
		for (const modulation of ["nfm", "wfm"]) {
			harness = await createDemodHarness({
				config: { squelchMode: "auto", modulation },
			})
			await harness.demod.start()
			const run = (harness.demod as unknown as Internals).run!
			const squelch = run.squelch as { hasCarrierObserver: boolean }
			expect(squelch.hasCarrierObserver).toBe(true)
			await harness.dispose()
			harness = null
		}
	})
})

describe("LiveDemodulator auto floor after a runtime mode switch (WG10 req 2.6)", () => {
	it("a run built in auto nfm that switches to manual seeds from power alone", async () => {
		harness = await createDemodHarness({
			config: { squelchMode: "auto", modulation: "nfm" },
		})
		await harness.demod.start()
		const internals = harness.demod as unknown as Internals
		const run = internals.run!
		await harness.demod.reconfigure({ squelchMode: "manual", squelch: -40 })
		const squelch = fakeSquelch()
		run.squelch = squelch
		run.noiseFloorDbfs = null
		squelch.powerDbfs = -5
		squelch.quieted = true
		internals.measureRun(run)
		expect(run.noiseFloorDbfs).toBe(-5)
	})
})

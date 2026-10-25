import { describe, expect, it } from "vitest"
import type { ChannelGate } from "../../../../src/core/spectrum/channel-gate.js"
import { createChannelGate } from "../../../../src/core/spectrum/channel-gate.js"
import {
	CHANNEL_GATE_K_DB,
	CHANNEL_GATE_MAX_SLOTS,
	CHANNEL_GATE_MAX_WIDTH_HZ,
	CHANNEL_GATE_MIN_WIDTH_HZ,
	type ChannelPlan,
} from "../../../../src/core/scanner/scanner-redesign-contract.js"
import {
	CFAR_MAX_RAISE_DB,
	CFAR_STEP_DB,
} from "../../../../src/core/spectrum/detector.js"

const TUNE = 100_000_000
const BIN_HZ = 1_000
const BINS = 32
const BLOCK_MS = 50
const WIDTH = 12_500
const FLOOR = -100
const KEY = "range"

function windowOf(
	tune: number,
	bins: number,
	binHz: number,
): {
	lo: number
	hi: number
} {
	const half = (bins / 2) * binHz
	return { lo: tune - half, hi: tune + half }
}

/** One raster channel, entry covering the whole tuned window (no gap grid). */
function oneChannel(opts: {
	tune?: number
	bins?: number
	binHz?: number
	centre: number
	widthHz: number
	burst?: boolean
	rangeKey?: string
}): ChannelPlan {
	const tune = opts.tune ?? TUNE
	const bins = opts.bins ?? BINS
	const binHz = opts.binHz ?? BIN_HZ
	const win = windowOf(tune, bins, binHz)
	return {
		sourceId: "src",
		defaultWidthHz: WIDTH,
		entries: [
			{
				startHz: win.lo,
				endHz: win.hi,
				widthHz: opts.widthHz,
				// One step wider than the window, so only `centre` lands inside.
				rasterHz: win.hi - win.lo,
				firstChannelHz: opts.centre,
				burst: opts.burst ?? false,
				rangeKey: opts.rangeKey ?? KEY,
			},
		],
	}
}

function openGate(opts: {
	tune?: number
	bins?: number
	binHz?: number
	blockMs?: number
	now?: () => number
	centre?: number
	widthHz?: number
	burst?: boolean
	plan?: ChannelPlan
}): {
	gate: ChannelGate
	centre: number
	bins: number
	binHz: number
	tune: number
} {
	const tune = opts.tune ?? TUNE
	const bins = opts.bins ?? BINS
	const binHz = opts.binHz ?? BIN_HZ
	const centre = opts.centre ?? tune
	const blockMs = opts.blockMs ?? BLOCK_MS
	const gate = opts.now
		? createChannelGate({
				binHz,
				blockMs,
				centreHz: tune,
				bins,
				now: opts.now,
			})
		: createChannelGate({ binHz, blockMs, centreHz: tune, bins })
	gate.setPlan(
		opts.plan ??
			oneChannel({
				tune,
				bins,
				binHz,
				centre,
				widthHz: opts.widthHz ?? WIDTH,
				burst: opts.burst ?? false,
			}),
	)
	return { gate, centre, bins, binHz, tune }
}

function spectrum(
	bins: number,
	snrDb: number,
	hot?: (i: number) => boolean,
): { power: Float32Array; floor: Float32Array } {
	const power = new Float32Array(bins)
	const floor = new Float32Array(bins)
	for (let i = 0; i < bins; i++) {
		floor[i] = FLOOR
		power[i] = FLOOR + (!hot || hot(i) ? snrDb : 0)
	}
	return { power, floor }
}

function feed(
	gate: ChannelGate,
	bins: number,
	snrDb: number,
	blocks: number,
	sample0: number,
	masked?: Uint8Array,
	hot?: (i: number) => boolean,
): void {
	const { power, floor } = spectrum(bins, snrDb, hot)
	const mask = masked ?? new Uint8Array(bins)
	for (let b = 0; b < blocks; b++) gate.block(power, floor, mask, sample0 + b)
}

function binCentres(tune: number, bins: number, binHz: number): number[] {
	const half = bins / 2
	const out: number[] = []
	for (let i = 0; i < bins; i++) out.push(tune + (i - half) * binHz)
	return out
}

describe("channel gate", () => {
	it("a 12.5 kHz channel at 7 dB for 300 ms passes on block 6, not block 5", () => {
		// 300 ms / 50 ms = 6 blocks. Block 5 is 250 ms, still pending.
		const { gate, centre, bins } = openGate({})
		expect(gate.stats().slots).toBe(1)
		feed(gate, bins, 7, 5, 1)
		expect(gate.gateOf(centre, WIDTH)).toMatchObject({
			state: "pending",
			passedSample: null,
			runStartSample: null,
		})
		gate.block(
			spectrum(bins, 7).power,
			spectrum(bins, 7).floor,
			new Uint8Array(bins),
			6,
		)
		const got = gate.gateOf(centre, WIDTH)
		expect(got.state).toBe("passed")
		expect(got.passedSample).toBe(6)
		expect(got.runStartSample).toBe(1)
		expect(got.channelSnrDb).toBeCloseTo(7, 6)
	})

	it("gateInto writes into the caller object and matches gateOf", () => {
		const { gate, centre, bins } = openGate({})
		feed(gate, bins, 7, 6, 1)
		const out = {
			state: "below" as const,
			channelSnrDb: 0,
			passedSample: 1,
			runStartSample: 1,
			minDurationMs: 1,
			kDb: 0,
			marginDb: 0,
			valid: false,
		}
		expect(gate.gateInto(centre, WIDTH, out)).toBe(out)
		expect(out.state).toBe("passed")
		expect(out.passedSample).toBe(6)
		expect(gate.gateOf(centre, WIDTH)).toMatchObject(out)
	})

	it("one off block inside the run counts as on; two end the run", () => {
		const { gate, centre, bins } = openGate({})
		const on = spectrum(bins, 7)
		const off = spectrum(bins, 0)
		const mask = new Uint8Array(bins)
		// 3 on, 1 off, 2 on: the off counts, so block 6 completes 300 ms.
		const pattern = [on, on, on, off, on, on]
		for (let i = 0; i < pattern.length; i++) {
			const frame = pattern[i]!
			gate.block(frame.power, frame.floor, mask, i + 1)
			if (i < 5) expect(gate.gateOf(centre, WIDTH).state).toBe("pending")
		}
		expect(gate.gateOf(centre, WIDTH)).toMatchObject({
			state: "passed",
			passedSample: 6,
		})

		const ended = openGate({})
		const quiet = spectrum(ended.bins, 0)
		const loud = spectrum(ended.bins, 7)
		const m = new Uint8Array(ended.bins)
		// 4 on + 1 tolerated off is 250 ms; the second off ends the run short of 300 ms.
		for (const frame of [loud, loud, loud, loud, quiet, quiet]) {
			ended.gate.block(frame.power, frame.floor, m, 1)
		}
		expect(ended.gate.gateOf(ended.centre, WIDTH).state).toBe("pending")
		expect(ended.gate.stats().falseAlarms).toBe(1)
		feed(ended.gate, ended.bins, 7, 5, 10)
		expect(ended.gate.gateOf(ended.centre, WIDTH).state).toBe("pending")
		feed(ended.gate, ended.bins, 7, 1, 15)
		expect(ended.gate.gateOf(ended.centre, WIDTH).state).toBe("passed")
	})

	it("a burst entry passes after 2 blocks at 9.5 dB and not at 8.5 dB", () => {
		// Burst minimum is 100 ms = 2 × 50 ms. Pass SNR is kCh + 6 = 9 dB.
		const hot = openGate({ burst: true })
		feed(hot.gate, hot.bins, 9.5, 1, 1)
		expect(hot.gate.gateOf(hot.centre, WIDTH).state).toBe("pending")
		feed(hot.gate, hot.bins, 9.5, 1, 2)
		expect(hot.gate.gateOf(hot.centre, WIDTH)).toMatchObject({
			state: "passed",
			passedSample: 2,
		})

		const cool = openGate({ burst: true })
		feed(cool.gate, cool.bins, 8.5, 2, 1)
		expect(cool.gate.gateOf(cool.centre, WIDTH).state).toBe("pending")
		feed(cool.gate, cool.bins, 8.5, 8, 3)
		expect(cool.gate.gateOf(cool.centre, WIDTH).state).toBe("pending")
	})

	it("a 2 kHz blip at 3.5 dB per-bin SNR in a 12.5 kHz channel reads 0.8 ± 0.1 dB and never turns on", () => {
		// 10·log10(1 + (2 000/12 500)·(10^(3.5/10) − 1)) ≈ 0.785 dB, below kCh 3 dB.
		const centre = TUNE + 500
		const { gate, bins, tune, binHz } = openGate({ centre })
		expect(gate.stats().slots).toBe(1)
		const lo = centre - WIDTH / 2
		const hi = centre + WIDTH / 2
		const inside = binCentres(tune, bins, binHz)
			.map((hz, i) => ({ hz, i }))
			.filter(b => b.hz >= lo && b.hz < hi)
		expect(inside.length).toBe(12)
		// 2 bins at +3.5 dB; the rest of the channel sits on the floor.
		const blip = new Set(inside.slice(0, 2).map(b => b.i))
		const { power, floor } = spectrum(bins, 0, () => false)
		for (const i of blip) power[i] = FLOOR + 3.5
		const mask = new Uint8Array(bins)
		for (let s = 1; s <= 20; s++) gate.block(power, floor, mask, s)
		const got = gate.gateOf(centre, WIDTH)
		expect(Math.abs(got.channelSnrDb - 0.8)).toBeLessThanOrEqual(0.1)
		expect(got.state).toBe("pending")
		feed(gate, bins, 0, 2, 21)
		expect(gate.gateOf(centre, WIDTH).state).toBe("pending")
		expect(gate.stats().falseAlarms).toBe(0)
	})

	it("a slot with 7 of 12 bins masked is skipped; with 6 of 12 it is tested", () => {
		const centre = TUNE + 500
		const opened = openGate({ centre })
		const inside = binCentres(opened.tune, opened.bins, opened.binHz)
			.map((hz, i) => ({ hz, i }))
			.filter(b => b.hz >= centre - WIDTH / 2 && b.hz < centre + WIDTH / 2)
		expect(inside.length).toBe(12)

		const skipped = new Uint8Array(opened.bins)
		for (const b of inside.slice(0, 7)) skipped[b.i] = 1
		feed(opened.gate, opened.bins, 30, 8, 1, skipped)
		expect(opened.gate.gateOf(centre, WIDTH).state).toBe("pending")
		expect(opened.gate.stats().maskedSkipped).toBe(8)

		const tested = openGate({ centre })
		const mask = new Uint8Array(tested.bins)
		for (const b of inside.slice(0, 6)) mask[b.i] = 1
		feed(tested.gate, tested.bins, 30, 5, 1, mask)
		expect(tested.gate.gateOf(centre, WIDTH).state).toBe("pending")
		feed(tested.gate, tested.bins, 30, 1, 6, mask)
		expect(tested.gate.gateOf(centre, WIDTH).state).toBe("passed")
		expect(tested.gate.stats().maskedSkipped).toBe(0)
	})

	it("gateOf stays passed through one quiet block and is pending after the run ends", () => {
		const { gate, centre, bins } = openGate({})
		feed(gate, bins, 7, 6, 1)
		const passed = gate.gateOf(centre, WIDTH)
		expect(passed.state).toBe("passed")
		const alarms = gate.stats().falseAlarms
		// One tolerated off: the passing run continues.
		feed(gate, bins, 0, 1, 7)
		const held = gate.gateOf(centre, WIDTH)
		expect(held.state).toBe("passed")
		expect(held.passedSample).toBe(passed.passedSample)
		// A second off ends the run. A passed run is not a false alarm.
		feed(gate, bins, 0, 1, 8)
		expect(gate.gateOf(centre, WIDTH)).toMatchObject({
			state: "pending",
			passedSample: null,
		})
		expect(gate.stats().falseAlarms).toBe(alarms)
	})

	it("a later noise run in the same slot does not read passed", () => {
		const { gate, centre, bins } = openGate({})
		feed(gate, bins, 7, 6, 1)
		feed(gate, bins, 0, 2, 7)
		expect(gate.gateOf(centre, WIDTH).state).toBe("pending")
		// Above kCh (3 dB) but under the 6 dB margin, so the new run must not pass
		// and must not inherit the previous run's passed flag.
		feed(gate, bins, 4, 8, 20)
		expect(gate.gateOf(centre, WIDTH)).toMatchObject({
			state: "pending",
			passedSample: null,
		})
	})

	it("accumulates observed CFAR minutes across retunes and gain epochs, excluding away time", () => {
		let t = 0
		const plan = oneChannel({ centre: TUNE, widthHz: WIDTH })
		const { gate } = openGate({ now: () => t, plan })
		const quiet = (): void => feed(gate, BINS, 0, 1, 10)
		feed(gate, BINS, 30, 1, 1)
		feed(gate, BINS, 0, 2, 2)
		t += 2 * 60_000
		quiet()
		gate.recentre(TUNE + 1_000_000)
		quiet()
		t += 60 * 60_000
		quiet()
		expect(gate.kFor(KEY)).toBe(3)
		gate.recentre(TUNE)
		quiet()
		t += 2 * 60_000
		quiet()
		// Same centre, new gain epoch: windows stay, slot runs break.
		gate.recentre(TUNE)
		quiet()
		t += 60_000
		quiet()
		expect(gate.kFor(KEY)).toBe(3.5)
		gate.recentre(TUNE + 1_000_000)
		t += 60 * 60_000
		quiet()
		gate.recentre(TUNE)
		quiet()
		expect(gate.kFor(KEY)).toBe(3.5)
		for (let i = 0; i < 3; i++) {
			t += 10 * 60_000
			quiet()
			gate.recentre(TUNE)
			quiet()
		}
		expect(gate.kFor(KEY)).toBe(3)
		// Removing an inactive range forgets its windows too.
		gate.recentre(TUNE + 1_000_000)
		gate.setPlan({ ...plan, entries: [] })
		gate.setPlan(plan)
		gate.recentre(TUNE)
		expect(gate.kFor(KEY)).toBe(3)
	})

	it("keeps independent raise windows across alternating planned ranges and forgets a removed inactive range", () => {
		let t = 0
		const other = TUNE + 1_000_000
		const plan = oneChannel({ centre: TUNE, widthHz: WIDTH })
		plan.entries.push(
			...oneChannel({
				tune: other,
				centre: other,
				widthHz: WIDTH,
				rangeKey: "other",
			}).entries,
		)
		const { gate } = openGate({ now: () => t, plan })
		for (let visit = 0; visit < 10; visit++) {
			gate.recentre(visit % 2 === 0 ? TUNE : other)
			if (visit < 2) {
				feed(gate, BINS, 30, 1, 1)
				feed(gate, BINS, 0, 2, 2)
			} else feed(gate, BINS, 0, 1, 1)
			t += 60_000
			feed(gate, BINS, 0, 1, 3)
		}
		expect(gate.kFor(KEY)).toBe(3.5)
		expect(gate.kFor("other")).toBe(3.5)
		// KEY is away from the current window; deleting it must forget it anyway.
		gate.setPlan({
			...plan,
			entries: plan.entries.filter(e => e.rangeKey !== KEY),
		})
		expect(gate.kFor(KEY)).toBe(3)
		gate.setPlan(plan)
		gate.recentre(TUNE)
		expect(gate.kFor(KEY)).toBe(3)
		expect(gate.kFor("other")).toBe(3.5)
	})

	it("invalidates cached floors on in-place changes and mask changes", () => {
		const { gate, centre } = openGate({})
		const { power, floor } = spectrum(BINS, 7)
		const mask = new Uint8Array(BINS)
		gate.block(power, floor, mask, 1)
		expect(gate.gateOf(centre, WIDTH).channelSnrDb).toBeCloseTo(7)
		floor.fill(FLOOR + 4)
		gate.block(power, floor, mask, 2)
		expect(gate.gateOf(centre, WIDTH).channelSnrDb).toBeCloseTo(3)
		mask.fill(1, 0, 16)
		floor.fill(FLOOR + 6)
		gate.block(power, floor, mask, 3)
		mask.fill(0)
		gate.block(power, floor, mask, 4)
		expect(gate.gateOf(centre, WIDTH).channelSnrDb).toBeCloseTo(1)
	})

	it("kCh survives a re-sent identical plan", () => {
		let t = 0
		const plan = oneChannel({ centre: TUNE, widthHz: WIDTH })
		const { gate } = openGate({ now: () => t, plan })
		gate.setFaTargets(new Map(), 1)
		feed(gate, BINS, 30, 1, 1)
		feed(gate, BINS, 0, 2, 2)
		t += 5 * 60 * 1000
		feed(gate, BINS, 0, 1, 4)
		expect(gate.kFor(KEY)).toBeCloseTo(CHANNEL_GATE_K_DB + CFAR_STEP_DB, 6)
		gate.setPlan(plan)
		expect(gate.kFor(KEY)).toBeCloseTo(CHANNEL_GATE_K_DB + CFAR_STEP_DB, 6)
	})

	it("a run in progress survives a re-sent identical plan and passes on schedule", () => {
		const plan = oneChannel({ centre: TUNE, widthHz: WIDTH })
		const { gate, centre, bins } = openGate({ plan, centre: TUNE })
		feed(gate, bins, 7, 5, 1)
		expect(gate.gateOf(centre, WIDTH).state).toBe("pending")
		gate.setPlan(plan)
		expect(gate.gateOf(centre, WIDTH).state).toBe("pending")
		const { power, floor } = spectrum(bins, 7)
		gate.block(power, floor, new Uint8Array(bins), 6)
		expect(gate.gateOf(centre, WIDTH)).toMatchObject({
			state: "passed",
			passedSample: 6,
		})
	})

	it("a removed rangeKey is forgotten", () => {
		let t = 0
		const plan = oneChannel({ centre: TUNE, widthHz: WIDTH, rangeKey: "drop" })
		const { gate } = openGate({ now: () => t, plan })
		gate.setFaTargets(new Map(), 1)
		feed(gate, BINS, 30, 1, 1)
		feed(gate, BINS, 0, 2, 2)
		t += 5 * 60 * 1000
		feed(gate, BINS, 0, 1, 4)
		expect(gate.kFor("drop")).toBeCloseTo(CHANNEL_GATE_K_DB + CFAR_STEP_DB, 6)
		gate.setPlan(oneChannel({ centre: TUNE, widthHz: WIDTH, rangeKey: "keep" }))
		expect(gate.kFor("drop")).toBe(CHANNEL_GATE_K_DB)
		expect(gate.kFor("keep")).toBe(CHANNEL_GATE_K_DB)
	})

	it("entries outside the tuned window are not counted or coarsened", () => {
		const bins = 32
		const binHz = BIN_HZ
		const tune = TUNE
		const win = windowOf(tune, bins, binHz)
		const inside = oneChannel({
			tune,
			bins,
			binHz,
			centre: tune,
			widthHz: WIDTH,
		})
		const huge = (CHANNEL_GATE_MAX_SLOTS + 1) * (WIDTH / 2)
		const withOutside: ChannelPlan = {
			sourceId: "src",
			defaultWidthHz: WIDTH,
			entries: [
				...inside.entries,
				{
					startHz: win.hi + 10_000,
					endHz: win.hi + 10_000 + huge,
					widthHz: WIDTH,
					rasterHz: null,
					firstChannelHz: null,
					burst: false,
					rangeKey: "out",
				},
			],
		}
		const a = openGate({ tune, bins, binHz, plan: inside }).gate
		const b = openGate({ tune, bins, binHz, plan: withOutside }).gate
		expect(a.stats().slots).toBe(1)
		expect(b.stats().slots).toBe(a.stats().slots)
		expect(b.stats().coarsened).toBe(0)
		// A sliding entry that begins far below the window is clipped to it.
		const sliding: ChannelPlan = {
			sourceId: "src",
			defaultWidthHz: WIDTH,
			entries: [
				{
					startHz: win.lo,
					endHz: win.hi,
					widthHz: WIDTH,
					rasterHz: null,
					firstChannelHz: null,
					burst: false,
					rangeKey: KEY,
				},
			],
		}
		const overhang: ChannelPlan = {
			sourceId: "src",
			defaultWidthHz: WIDTH,
			entries: [
				{
					startHz: win.lo - huge,
					endHz: win.hi,
					widthHz: WIDTH,
					rasterHz: null,
					firstChannelHz: null,
					burst: false,
					rangeKey: KEY,
				},
			],
		}
		const base = openGate({ tune, bins, binHz, plan: sliding }).gate
		const over = openGate({ tune, bins, binHz, plan: overhang }).gate
		expect(over.stats().slots).toBe(base.stats().slots)
		expect(over.stats().coarsened).toBe(base.stats().coarsened)
		expect(over.stats().coarsened).toBe(0)
	})

	it("kCh rises by 0.5 dB after 5 min of unpassed runs above target and stops at +4 dB", () => {
		let t = 0
		const { gate } = openGate({ now: () => t })
		// One false alarm over a 32 kHz span (0.032 MHz) in 5 min is 6.25 /MHz/min,
		// above the target of 1.
		gate.setFaTargets(new Map(), 1)
		expect(gate.kFor(KEY)).toBe(CHANNEL_GATE_K_DB)
		const pulse = (): void => {
			feed(gate, BINS, 30, 1, 1)
			feed(gate, BINS, 0, 2, 2)
		}
		const closeFiveMin = (): void => {
			t += 5 * 60 * 1000
			feed(gate, BINS, 0, 1, 4)
		}
		pulse()
		closeFiveMin()
		expect(gate.kFor(KEY)).toBeCloseTo(CHANNEL_GATE_K_DB + CFAR_STEP_DB, 6)
		// 3 → 7 dB is 8 steps of 0.5. The cap is 3 + 4.
		for (let i = 0; i < 7; i++) {
			pulse()
			closeFiveMin()
		}
		expect(gate.kFor(KEY)).toBeCloseTo(CHANNEL_GATE_K_DB + CFAR_MAX_RAISE_DB, 6)
		pulse()
		closeFiveMin()
		expect(gate.kFor(KEY)).toBeCloseTo(CHANNEL_GATE_K_DB + CFAR_MAX_RAISE_DB, 6)
	})

	it("kCh never drops below CHANNEL_GATE_K_DB", () => {
		let t = 0
		const { gate } = openGate({ now: () => t })
		gate.setFaTargets(new Map(), 1)
		feed(gate, BINS, 0, 1, 1)
		t += 30 * 60 * 1000
		feed(gate, BINS, 0, 1, 2)
		expect(gate.kFor(KEY)).toBe(CHANNEL_GATE_K_DB)

		feed(gate, BINS, 30, 1, 3)
		feed(gate, BINS, 0, 2, 4)
		t += 5 * 60 * 1000
		feed(gate, BINS, 0, 1, 6)
		expect(gate.kFor(KEY)).toBeCloseTo(CHANNEL_GATE_K_DB + CFAR_STEP_DB, 6)

		t += 30 * 60 * 1000
		feed(gate, BINS, 0, 1, 7)
		expect(gate.kFor(KEY)).toBe(CHANNEL_GATE_K_DB)
		t += 30 * 60 * 1000
		feed(gate, BINS, 0, 1, 8)
		expect(gate.kFor(KEY)).toBe(CHANNEL_GATE_K_DB)
	})

	it("pinned offset 2 dB pins kCh at 5 dB and disables adaptation", () => {
		// kCh = CHANNEL_GATE_K_DB + 2 = 5. Pass needs 5 + 3 = 8 dB.
		let t = 0
		const { gate, centre, bins } = openGate({ now: () => t })
		gate.setPinnedOffsetDb(2)
		gate.setFaTargets(new Map(), 0.001)
		expect(gate.kFor(KEY)).toBe(5)
		expect(gate.kFor("other")).toBe(5)
		feed(gate, bins, 7, 6, 1)
		expect(gate.gateOf(centre, WIDTH).state).toBe("pending")
		feed(gate, bins, 0, 2, 7)
		for (let i = 0; i < 4; i++) {
			feed(gate, bins, 30, 1, 20)
			feed(gate, bins, 0, 2, 21)
			t += 5 * 60 * 1000
			feed(gate, bins, 0, 1, 23)
		}
		expect(gate.kFor(KEY)).toBe(5)

		const passes = openGate({})
		passes.gate.setPinnedOffsetDb(2)
		feed(passes.gate, passes.bins, 8, 6, 1)
		expect(passes.gate.gateOf(passes.centre, WIDTH).state).toBe("passed")
	})

	it("slot count over 4096 coarsens the grid and counts it", () => {
		// Step is width/2 = 6 250 Hz. 4 096 steps equal the cap.
		// 4 097 steps double once: ceil(4 097 / 2) = 2 049 slots.
		const sliding = (slots: number): ChannelGate => {
			const step = WIDTH / 2
			const span = slots * step
			const tune = TUNE
			// The tuned window is the entry, so clipping does not drop slots.
			const binHz = step
			const bins = slots
			const plan: ChannelPlan = {
				sourceId: "src",
				defaultWidthHz: WIDTH,
				entries: [
					{
						startHz: tune - span / 2,
						endHz: tune + span / 2,
						widthHz: WIDTH,
						rasterHz: null,
						firstChannelHz: null,
						burst: false,
						rangeKey: KEY,
					},
				],
			}
			return openGate({ tune, bins, binHz, plan, centre: tune }).gate
		}
		const under = sliding(CHANNEL_GATE_MAX_SLOTS)
		expect(under.stats().slots).toBe(CHANNEL_GATE_MAX_SLOTS)
		expect(under.stats().coarsened).toBe(0)
		const over = sliding(CHANNEL_GATE_MAX_SLOTS + 1)
		expect(over.stats().slots).toBe(2049)
		expect(over.stats().coarsened).toBe(1)
	})

	it("widths clamp to [6250, 200000]", () => {
		// binHz 1 Hz. Channel centre sits 0.25 Hz above a bin so a bin centre
		// falls in (3 124.5, 3 125): inside the clamped 6 250 Hz slot, outside
		// an unclamped 6 249 Hz slot. The max edge uses a 0.75 Hz offset so a
		// bin falls in [100 000, 100 000.5): inside an unclamped 200 001 Hz slot.
		const bins = 262_144
		const binHz = 1
		const tune = 150_000_000
		const snrAt = (
			widthHz: number,
			frac: number,
			binOffsetFromTune: number,
		): number => {
			const centre = tune + frac
			const { gate } = openGate({
				tune,
				bins,
				binHz,
				centre,
				widthHz,
			})
			expect(gate.stats().slots).toBe(1)
			const { power, floor } = spectrum(bins, 0, () => false)
			const i = bins / 2 + binOffsetFromTune
			power[i] = FLOOR + 60
			gate.block(power, floor, new Uint8Array(bins), 1)
			return gate.gateOf(centre, 1).channelSnrDb
		}
		// Half of 6 250 is 3 125. Probe offset from centre 0.25 is 3 124.75.
		expect(snrAt(CHANNEL_GATE_MIN_WIDTH_HZ - 1, 0.25, 3125)).toBeGreaterThan(1)
		expect(snrAt(CHANNEL_GATE_MIN_WIDTH_HZ, 0.25, 3125)).toBeGreaterThan(1)
		expect(
			Math.abs(snrAt(CHANNEL_GATE_MIN_WIDTH_HZ - 1, 0.25, 3126)),
		).toBeLessThan(0.05)
		expect(Math.abs(snrAt(CHANNEL_GATE_MIN_WIDTH_HZ, 0.25, 3126))).toBeLessThan(
			0.05,
		)
		// Half of 200 000 is 100 000. Probe offset from centre 0.75 is 99 999.25
		// (inside) and 100 000.25 (one past, and inside an unclamped 200 001).
		expect(snrAt(CHANNEL_GATE_MAX_WIDTH_HZ, 0.75, 100_000)).toBeGreaterThan(1)
		expect(snrAt(CHANNEL_GATE_MAX_WIDTH_HZ + 1, 0.75, 100_000)).toBeGreaterThan(
			1,
		)
		expect(
			Math.abs(snrAt(CHANNEL_GATE_MAX_WIDTH_HZ, 0.75, 100_001)),
		).toBeLessThan(0.05)
		expect(
			Math.abs(snrAt(CHANNEL_GATE_MAX_WIDTH_HZ + 1, 0.75, 100_001)),
		).toBeLessThan(0.05)
	})

	it("a track wider than one slot sums the covering slots and passes if any passed", () => {
		// Two abutting 12.5 kHz rasters. The track OBW is their union.
		const bins = 32
		const binHz = BIN_HZ
		const tune = TUNE
		const win = windowOf(tune, bins, binHz)
		const c1 = tune - WIDTH / 2
		const c2 = tune + WIDTH / 2
		const plan: ChannelPlan = {
			sourceId: "src",
			defaultWidthHz: WIDTH,
			entries: [
				{
					startHz: win.lo,
					endHz: win.hi,
					widthHz: WIDTH,
					rasterHz: WIDTH,
					firstChannelHz: c1,
					burst: false,
					rangeKey: KEY,
				},
			],
		}
		const { gate } = openGate({ tune, bins, binHz, plan, centre: c1 })
		expect(gate.stats().slots).toBe(2)
		const { power, floor } = spectrum(bins, 0, () => false)
		for (let i = 0; i < bins; i++) {
			const hz = tune + (i - bins / 2) * binHz
			if (hz >= c1 - WIDTH / 2 && hz < c1 + WIDTH / 2) power[i] = FLOOR + 10
		}
		const mask = new Uint8Array(bins)
		for (let s = 1; s <= 6; s++) gate.block(power, floor, mask, s)
		const low = gate.gateOf(c1, 1)
		const high = gate.gateOf(c2, 1)
		const wide = gate.gateOf(tune, WIDTH * 2)
		expect(low.state).toBe("passed")
		expect(high.state).toBe("pending")
		expect(wide.state).toBe("passed")
		expect(wide.passedSample).toBe(low.passedSample)
		expect(wide.channelSnrDb).toBeGreaterThan(high.channelSnrDb)
		expect(wide.channelSnrDb).toBeLessThan(low.channelSnrDb)
		// WG16 SC: admission reads the best covering slot of a wide track, not the sum.
		expect(wide.peakChannelSnrDb).toBeCloseTo(low.channelSnrDb, 9)
		expect(low.peakChannelSnrDb).toBe(low.channelSnrDb)
		expect(high.peakChannelSnrDb).toBe(high.channelSnrDb)
		// An idle query carries the sentinel in both fields.
		const idle = gate.gateOf(Number.NaN, 1)
		expect(idle.peakChannelSnrDb).toBe(Number.NEGATIVE_INFINITY)
	})

	it("a non-finite power or floor does not pass and does not count a false alarm", () => {
		// One 12.5 kHz slot, 50 ms blocks. Six blocks would pass a finite 7 dB run.
		const cases: { name: string; power: number; floor: number }[] = [
			{ name: "NaN floor", power: -93, floor: Number.NaN },
			{ name: "-Infinity floor", power: -93, floor: Number.NEGATIVE_INFINITY },
			{ name: "+Infinity floor", power: -93, floor: Number.POSITIVE_INFINITY },
			{ name: "+Infinity power", power: Number.POSITIVE_INFINITY, floor: -100 },
			{ name: "NaN power", power: Number.NaN, floor: -100 },
		]
		for (const c of cases) {
			const { gate, centre, bins } = openGate({})
			const power = new Float32Array(bins)
			const floor = new Float32Array(bins)
			power.fill(c.power)
			floor.fill(c.floor)
			const mask = new Uint8Array(bins)
			for (let s = 1; s <= 6; s++) gate.block(power, floor, mask, s)
			const got = gate.gateOf(centre, WIDTH)
			expect(got.state, c.name).toBe("pending")
			expect(got.passedSample, c.name).toBeNull()
			expect(got.channelSnrDb, c.name).toBe(Number.NEGATIVE_INFINITY)
			expect(gate.stats().falseAlarms, c.name).toBe(0)
		}
	})

	it("a short power or floor array invalidates the slot", () => {
		const { gate, centre, bins } = openGate({})
		const floor = new Float32Array(bins)
		floor.fill(FLOOR)
		const mask = new Uint8Array(bins)
		for (let s = 1; s <= 6; s++) gate.block(new Float32Array(0), floor, mask, s)
		expect(gate.gateOf(centre, WIDTH).state).toBe("pending")
		expect(gate.gateOf(centre, WIDTH).channelSnrDb).toBe(
			Number.NEGATIVE_INFINITY,
		)
		expect(gate.stats().falseAlarms).toBe(0)

		const opened = openGate({})
		const power = new Float32Array(opened.bins)
		power.fill(-93)
		// One finite bin, then missing floors across the rest of the slot.
		const shortFloor = new Float32Array(1)
		shortFloor[0] = FLOOR
		for (let s = 1; s <= 6; s++) {
			opened.gate.block(power, shortFloor, new Uint8Array(opened.bins), s)
		}
		expect(opened.gate.gateOf(opened.centre, WIDTH).state).toBe("pending")
		expect(opened.gate.gateOf(opened.centre, WIDTH).channelSnrDb).toBe(
			Number.NEGATIVE_INFINITY,
		)
		expect(opened.gate.stats().falseAlarms).toBe(0)
	})

	it("an invalid block ends a run without a false alarm and is not a measurement", () => {
		const { gate, centre, bins } = openGate({})
		feed(gate, bins, 7, 3, 1)
		expect(gate.gateOf(centre, WIDTH).channelSnrDb).toBeCloseTo(7, 5)
		const power = new Float32Array(bins)
		const floor = new Float32Array(bins)
		power.fill(-93)
		floor.fill(Number.NaN)
		gate.block(power, floor, new Uint8Array(bins), 4)
		const after = gate.gateOf(centre, WIDTH)
		expect(after.state).toBe("pending")
		expect(after.passedSample).toBeNull()
		expect(after.channelSnrDb).toBe(Number.NEGATIVE_INFINITY)
		expect(after.valid).toBe(false)
		expect(gate.stats().falseAlarms).toBe(0)
		// The run ended, so one more good block does not pass.
		feed(gate, bins, 7, 1, 5)
		expect(gate.gateOf(centre, WIDTH).state).toBe("pending")
		expect(gate.stats().falseAlarms).toBe(0)
		feed(gate, bins, 7, 6, 10)
		const passed = gate.gateOf(centre, WIDTH)
		expect(passed.state).toBe("passed")
		expect(passed.channelSnrDb).toBeCloseTo(7, 5)
		expect(Number.isFinite(passed.channelSnrDb)).toBe(true)
	})

	it("an invalid block ends a passed run without counting a false alarm", () => {
		const { gate, centre, bins } = openGate({})
		feed(gate, bins, 7, 6, 1)
		expect(gate.gateOf(centre, WIDTH).state).toBe("passed")
		const alarms = gate.stats().falseAlarms
		const power = new Float32Array(bins)
		const floor = new Float32Array(bins)
		power.fill(Number.POSITIVE_INFINITY)
		floor.fill(FLOOR)
		gate.block(power, floor, new Uint8Array(bins), 7)
		const got = gate.gateOf(centre, WIDTH)
		expect(got.state).toBe("pending")
		expect(got.passedSample).toBeNull()
		expect(got.channelSnrDb).toBe(Number.NEGATIVE_INFINITY)
		expect(got.valid).toBe(false)
		expect(gate.stats().falseAlarms).toBe(alarms)
	})

	it("masking more than half the bins leaves a run in progress", () => {
		const centre = TUNE + 500
		const opened = openGate({ centre })
		const inside = binCentres(opened.tune, opened.bins, opened.binHz)
			.map((hz, i) => ({ hz, i }))
			.filter(b => b.hz >= centre - WIDTH / 2 && b.hz < centre + WIDTH / 2)
		expect(inside.length).toBe(12)
		feed(opened.gate, opened.bins, 7, 3, 1)
		const skipped = new Uint8Array(opened.bins)
		for (const b of inside.slice(0, 7)) skipped[b.i] = 1
		const frame = spectrum(opened.bins, 7)
		opened.gate.block(frame.power, frame.floor, skipped, 4)
		expect(opened.gate.stats().falseAlarms).toBe(0)
		expect(opened.gate.stats().maskedSkipped).toBe(1)
		// The masked block is not counted, so three more on blocks complete 300 ms.
		feed(opened.gate, opened.bins, 7, 3, 5)
		expect(opened.gate.gateOf(centre, WIDTH).state).toBe("passed")
		expect(opened.gate.stats().falseAlarms).toBe(0)
	})

	it("gateOf with a non-finite centre or a non-positive OBW stays pending", () => {
		const { gate, centre, bins } = openGate({})
		feed(gate, bins, 7, 6, 1)
		expect(gate.gateOf(centre, WIDTH).state).toBe("passed")
		const queries: [number, number][] = [
			[Number.NaN, Number.NaN],
			[Number.NaN, WIDTH],
			[centre, Number.NaN],
			[centre, 0],
			[centre, -WIDTH],
			[Number.POSITIVE_INFINITY, WIDTH],
			[centre, Number.POSITIVE_INFINITY],
			[Number.NEGATIVE_INFINITY, WIDTH],
		]
		for (const [hz, obw] of queries) {
			const got = gate.gateOf(hz, obw)
			expect(got.state).toBe("pending")
			expect(got.passedSample).toBeNull()
			expect(got.channelSnrDb).toBe(Number.NEGATIVE_INFINITY)
		}
		// The bad query does not clear the slot.
		expect(gate.gateOf(centre, WIDTH).state).toBe("passed")
	})

	it("4096 one-slot entries stay at the cap and 4097 cannot pass it", () => {
		const bins = 32
		const binHz = BIN_HZ
		const tune = TUNE
		const win = windowOf(tune, bins, binHz)
		const span = win.hi - win.lo
		const entry = (key: string): ChannelPlan["entries"][number] => ({
			startHz: win.lo,
			endHz: win.hi,
			widthHz: span,
			rasterHz: span,
			firstChannelHz: tune,
			burst: false,
			rangeKey: key,
		})
		const planOf = (n: number, distinct: boolean): ChannelPlan => ({
			sourceId: "src",
			defaultWidthHz: WIDTH,
			entries: Array.from({ length: n }, (_, i) =>
				entry(distinct ? `k${i}` : KEY),
			),
		})
		const atCap = openGate({
			tune,
			bins,
			binHz,
			plan: planOf(CHANNEL_GATE_MAX_SLOTS, false),
		}).gate
		expect(atCap.stats().slots).toBe(CHANNEL_GATE_MAX_SLOTS)
		expect(atCap.stats().coarsened).toBe(0)

		// Same (lo, hi, rangeKey, burst) 4097 times. Doubling cannot shrink a
		// one-slot raster, so the duplicates collapse to one slot.
		const dup = openGate({
			tune,
			bins,
			binHz,
			plan: planOf(CHANNEL_GATE_MAX_SLOTS + 1, false),
		}).gate
		expect(dup.stats().slots).toBe(1)
		expect(dup.stats().slots).toBeLessThanOrEqual(CHANNEL_GATE_MAX_SLOTS)
		expect(dup.stats().coarsened).toBe(0)

		// Distinct range keys do not collapse. The layout becomes one sliding
		// grid of the default width. 32 kHz / 6 250 Hz → 6 slots, one coarsen.
		const distinct = openGate({
			tune,
			bins,
			binHz,
			plan: planOf(CHANNEL_GATE_MAX_SLOTS + 1, true),
		}).gate
		expect(distinct.stats().slots).toBeLessThanOrEqual(CHANNEL_GATE_MAX_SLOTS)
		expect(distinct.stats().slots).toBe(6)
		expect(distinct.stats().coarsened).toBeGreaterThan(0)
	})

	it("blockLinear agrees with block on the same spectrum", () => {
		const dbGate = openGate({})
		const linGate = openGate({})
		const frames = 50
		const { power, floor } = spectrum(dbGate.bins, 7)
		const mask = new Uint8Array(dbGate.bins)
		const acc = linearAcc(power, frames)
		for (let i = 1; i <= 6; i++) {
			dbGate.gate.block(power, floor, mask, i)
			linGate.gate.blockLinear(acc, frames, floor, mask, i)
		}
		const fromDb = dbGate.gate.gateOf(dbGate.centre, WIDTH)
		const fromLin = linGate.gate.gateOf(linGate.centre, WIDTH)
		expect(fromLin.state).toBe("passed")
		expect(fromLin.state).toBe(fromDb.state)
		expect(fromLin.passedSample).toBe(fromDb.passedSample)
		expect(fromLin.runStartSample).toBe(1)
		expect(fromLin.runStartSample).toBe(fromDb.runStartSample)
		expect(fromLin.channelSnrDb).toBeCloseTo(fromDb.channelSnrDb, 5)
	})

	it("resetRuns drops the run without a false alarm and the next blocks start over", () => {
		const { gate, centre, bins } = openGate({})
		feed(gate, bins, 7, 3, 1)
		const alarms = gate.stats().falseAlarms
		const k = gate.kFor(KEY)
		gate.resetRuns()
		const cleared = gate.gateOf(centre, WIDTH)
		expect(cleared.state).toBe("pending")
		expect(cleared.passedSample).toBeNull()
		expect(cleared.runStartSample).toBeNull()
		expect(cleared.channelSnrDb).toBeCloseTo(7, 5)
		expect(gate.stats().falseAlarms).toBe(alarms)
		expect(gate.kFor(KEY)).toBe(k)
		// Three more on blocks do not finish the cleared run.
		feed(gate, bins, 7, 3, 4)
		expect(gate.gateOf(centre, WIDTH).state).toBe("pending")
		expect(gate.stats().falseAlarms).toBe(alarms)
		feed(gate, bins, 7, 3, 7)
		const passed = gate.gateOf(centre, WIDTH)
		expect(passed.state).toBe("passed")
		expect(passed.passedSample).toBe(9)
		expect(passed.runStartSample).toBe(4)
		expect(gate.stats().falseAlarms).toBe(alarms)
	})

	it("resetRuns of a passed run is not a false alarm and keeps a raised kCh", () => {
		let t = 0
		const { gate, centre, bins } = openGate({ now: () => t })
		gate.setFaTargets(new Map(), 1)
		feed(gate, bins, 7, 6, 1)
		expect(gate.gateOf(centre, WIDTH).state).toBe("passed")
		const alarms = gate.stats().falseAlarms
		gate.resetRuns()
		expect(gate.gateOf(centre, WIDTH).state).toBe("pending")
		expect(gate.gateOf(centre, WIDTH).runStartSample).toBeNull()
		expect(gate.stats().falseAlarms).toBe(alarms)

		// One unpassed run over this span in 5 min is above the target of 1 /MHz/min.
		feed(gate, BINS, 30, 1, 20)
		feed(gate, BINS, 0, 2, 21)
		t += 5 * 60 * 1000
		feed(gate, BINS, 0, 1, 23)
		expect(gate.kFor(KEY)).toBeCloseTo(CHANNEL_GATE_K_DB + CFAR_STEP_DB, 6)
		const raisedAlarms = gate.stats().falseAlarms
		gate.resetRuns()
		expect(gate.kFor(KEY)).toBeCloseTo(CHANNEL_GATE_K_DB + CFAR_STEP_DB, 6)
		expect(gate.stats().falseAlarms).toBe(raisedAlarms)
		expect(gate.gateOf(centre, WIDTH).state).toBe("pending")
	})
})

/** Rebuild the linear accumulator `powerToDb` would turn back into `power`. */
function linearAcc(power: Float32Array, frames: number): Float64Array {
	const n = power.length
	const scale = 1 / (Math.max(1, frames) * (n / 2) * (n / 2))
	const acc = new Float64Array(n)
	const ln = Math.LN10 / 10
	for (let i = 0; i < n; i++) acc[i] = Math.exp(power[i]! * ln) / scale
	return acc
}

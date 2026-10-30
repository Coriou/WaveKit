import { expect, it } from "vitest"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import {
	channelizerBranchId,
	type RunningPlacement,
	type WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"

/**
 * Late drops are charged to the fanout branch that dropped. One source "s"
 * with the branches the core creates: a raw decoder's own branch
 * (`decoder-<id>`), the channelizer's (`channelizer-s`) and live audio's
 * (`live-demod-s`), keyed `<branch>#<instance>` as the source router reports
 * them. The monitor and the gate read one fake monotonic clock (`mono`),
 * the gate's own time source; samples are taken on it every 2000 ms.
 */
type Spec = {
	key: string
	reach: "raw" | "channel"
	tuned?: boolean
}

const BRANCHES = [
	"decoder-readsb",
	"decoder-other",
	"channelizer-s",
	"live-demod-s",
]

function harness(specs: readonly Spec[]) {
	let mono = 0
	const totals = new Map(BRANCHES.map(b => [b, 0]))
	const monitor = createEfficiencyMonitor({
		sources: () => ["s"],
		branchCounters: () =>
			new Map(
				[...totals].map(([branch, n]) => [
					`${branch}#0`,
					{ droppedBytesTotal: n, droppedChunksTotal: n },
				]),
			),
		topology: () => "fixed",
		cpu: { normalisedPercent: 10 },
		now: () => mono,
		monoNow: () => mono,
		setInterval: () => ({ cancel() {} }),
	})
	const gate = createEfficiencyGate(
		{ budgetCores: 10, cpuGuardPercent: 90 },
		{ drops: monitor },
	)
	const running: RunningPlacement[] = []
	const tick = () => {
		mono += 2_000
		gate.record(monitor.sampleNow())
	}
	// A clean source (60 s clear window) admits; one probationer per source,
	// so each placement graduates before the next is admitted.
	for (let i = 0; i < 32; i++) tick()
	// Admitted in order: the last spec is the newest placement.
	for (const spec of specs) {
		const placement: WantedPlacement = {
			key: spec.key,
			decoderId: spec.key,
			sourceId: "s",
			reach: spec.reach,
			channelHz: null,
			costCores: 0.1,
			origin: "band",
			primary: true,
			sampleRateHz: 2_400_000,
			...(spec.tuned ? { tunedBand: true as const } : {}),
		}
		expect(gate.admit(placement, running, mono).admit).toBe(true)
		running.push({
			key: spec.key,
			sourceId: "s",
			reach: spec.reach,
			costCores: 0.1,
			sampleRateHz: placement.sampleRateHz,
			admittedAtMs: mono,
			mode: "auto",
			startMode: "auto",
			inputBranch:
				spec.reach === "channel"
					? channelizerBranchId("s")
					: `decoder-${spec.key}`,
			...(spec.tuned ? { tunedBand: true as const } : {}),
		})
		for (let i = 0; i < 17; i++) {
			tick()
			expect(gate.probation(running, mono)).toEqual([])
		}
	}
	/** Drops on `dropping` every sample for `ms`; the verdicts in order. */
	const dropFor = (dropping: readonly string[], ms: number) => {
		const verdicts: { key: string; detail: string }[] = []
		for (let t = 0; t < ms; t += 2_000) {
			for (const branch of dropping) totals.set(branch, totals.get(branch)! + 1)
			tick()
			verdicts.push(...gate.probation(running, mono))
		}
		return verdicts
	}
	return { dropFor, monitor }
}

const SPECS: readonly Spec[] = [
	{ key: "chan-old", reach: "channel" },
	{ key: "chan-tuned", reach: "channel", tuned: true },
	{ key: "readsb", reach: "raw" },
]

it("drops only on the live audio branch shed no decoder", () => {
	const h = harness(SPECS)
	expect(h.dropFor(["live-demod-s"], 60_000)).toEqual([])
	// The windows are condemning (a slow consumer), but scoped to live audio.
	expect(h.monitor.lateWindows("s").at(-1)).toMatchObject({
		condemning: true,
		condemnedBranches: ["live-demod-s"],
	})
})

it("channelizer drops shed a channel decoder, untuned first, never the raw readsb", () => {
	// readsb is the newest placement: a source-wide late shed took it first.
	const h = harness(SPECS)
	const verdicts = h.dropFor(["channelizer-s"], 40_000)
	expect(verdicts[0]).toEqual({ key: "chan-old", detail: "late-drops" })
	expect(verdicts.some(v => v.key === "readsb")).toBe(false)
})

it("raw drops on readsb's own branch shed readsb, even when its band is tuned", () => {
	const h = harness([
		{ key: "chan-old", reach: "channel" },
		{ key: "readsb", reach: "raw", tuned: true },
	])
	const verdicts = h.dropFor(["decoder-readsb"], 40_000)
	expect(verdicts[0]).toEqual({ key: "readsb", detail: "late-drops" })
	expect(verdicts.some(v => v.key === "chan-old")).toBe(false)
})

it("raw drops on two raw branches shed the untuned one before the newer tuned one", () => {
	const h = harness([
		{ key: "other", reach: "raw" },
		{ key: "chan-old", reach: "channel" },
		{ key: "readsb", reach: "raw", tuned: true },
	])
	const verdicts = h.dropFor(["decoder-readsb", "decoder-other"], 40_000)
	expect(verdicts[0]).toEqual({ key: "other", detail: "late-drops" })
	expect(verdicts.some(v => v.key === "chan-old")).toBe(false)
})

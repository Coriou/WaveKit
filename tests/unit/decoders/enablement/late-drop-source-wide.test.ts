import { expect, it } from "vitest"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type {
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"

/**
 * Loss upstream of the branch split (burst absorber overflow) names no
 * branch, so it falls on the source as a whole: the newest sheddable
 * placement is shed, untuned before tuned. One source "s" with raw decoder
 * branches, live audio (`live-demod-s`) and the absorber (`@absorber#0`, as
 * the source router reports it). The monitor and the gate read one fake
 * monotonic clock (`mono`), the gate's own time source; samples are taken on
 * it every 2000 ms.
 */
type Spec = {
	key: string
	tuned?: boolean
	pinned?: boolean
}

const COUNTERS = [
	"decoder-readsb#0",
	"decoder-other#0",
	"live-demod-s#0",
	"@absorber#0",
]

function harness(specs: readonly Spec[]) {
	let mono = 0
	const totals = new Map(COUNTERS.map(c => [c, 0]))
	const cpu = { normalisedPercent: 10 as number | null }
	const monitor = createEfficiencyMonitor({
		sources: () => ["s"],
		branchCounters: () =>
			new Map(
				[...totals].map(([key, n]) => [
					key,
					{ droppedBytesTotal: n, droppedChunksTotal: n },
				]),
			),
		topology: () => "fixed",
		cpu,
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
			reach: "raw",
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
			reach: "raw",
			costCores: 0.1,
			sampleRateHz: placement.sampleRateHz,
			admittedAtMs: mono,
			mode: spec.pinned ? "always" : "auto",
			startMode: "auto",
			inputBranch: `decoder-${spec.key}`,
			...(spec.tuned ? { tunedBand: true as const } : {}),
		})
		for (let i = 0; i < 17; i++) {
			tick()
			expect(gate.probation(running, mono)).toEqual([])
		}
	}
	/**
	 * Drops on the `dropping` counters every sample for `ms`; the verdicts in
	 * order. A shed placement stops, as the manager stops it.
	 */
	const dropFor = (dropping: readonly string[], ms: number) => {
		const verdicts: { key: string; detail: string }[] = []
		for (let t = 0; t < ms; t += 2_000) {
			for (const key of dropping) totals.set(key, totals.get(key)! + 1)
			tick()
			for (const verdict of gate.probation(running, mono)) {
				verdicts.push(verdict)
				const i = running.findIndex(p => p.key === verdict.key)
				if (i >= 0) running.splice(i, 1)
				gate.forget(verdict.key)
			}
		}
		return verdicts
	}
	return { dropFor, monitor, cpu }
}

it("absorber overflow under host CPU sheds the one sheddable placement exactly once", () => {
	const h = harness([{ key: "readsb" }])
	h.cpu.normalisedPercent = 99
	const verdicts = h.dropFor(["@absorber#0"], 120_000)
	expect(h.monitor.latestAttribution("s")).toBe("host")
	const windows = h.monitor.lateWindows("s")
	expect(windows.filter(w => w.condemning)).toHaveLength(3)
	expect(windows.at(-1)).toMatchObject({
		condemning: true,
		condemnedBranches: "source",
	})
	expect(verdicts).toEqual([{ key: "readsb", detail: "late-drops" }])
})

it("absorber overflow sheds the untuned placement before the newer tuned one", () => {
	const h = harness([{ key: "other" }, { key: "readsb", tuned: true }])
	h.cpu.normalisedPercent = 99
	const verdicts = h.dropFor(["@absorber#0"], 40_000)
	expect(verdicts[0]).toEqual({ key: "other", detail: "late-drops" })
	expect(verdicts.some(v => v.key === "readsb")).toBe(false)
})

it("absorber overflow never sheds a pinned placement", () => {
	const h = harness([{ key: "other" }, { key: "readsb", pinned: true }])
	h.cpu.normalisedPercent = 99
	const verdicts = h.dropFor(["@absorber#0"], 120_000)
	expect(verdicts).toEqual([{ key: "other", detail: "late-drops" }])
})

it("absorber overflow alongside live audio drops is still source-wide", () => {
	const h = harness([{ key: "readsb" }])
	h.cpu.normalisedPercent = 99
	const verdicts = h.dropFor(["@absorber#0", "live-demod-s#0"], 40_000)
	expect(h.monitor.lateWindows("s").at(-1)).toMatchObject({
		condemning: true,
		condemnedBranches: "source",
	})
	expect(verdicts[0]).toEqual({ key: "readsb", detail: "late-drops" })
})

it("live audio drops alone still shed no decoder", () => {
	const h = harness([{ key: "readsb" }])
	expect(h.dropFor(["live-demod-s#0"], 60_000)).toEqual([])
	expect(h.monitor.lateWindows("s").at(-1)).toMatchObject({
		condemning: true,
		condemnedBranches: ["live-demod-s"],
	})
})

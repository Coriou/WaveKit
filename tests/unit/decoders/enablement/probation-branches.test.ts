import fc from "fast-check"
import { expect, it } from "vitest"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import {
	EFFICIENCY_CLEAR_MS,
	type RunningPlacement,
	type WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"

/**
 * Probation drops are charged to the fanout branch that dropped, like late
 * drops. One source "s" with the branches the core creates: each raw
 * decoder's own branch (`decoder-<id>`), live audio (`live-demod-s`, read by
 * no placement) and the absorber (`@absorber#0`), keyed `<branch>#<instance>`
 * as the source router reports them. Untuned placements a, b and c run
 * graduated; the tuned-band placement readsb is admitted last and is on
 * probation. The monitor and the gate read one fake monotonic clock
 * (`mono`); samples are taken on it every 2000 ms.
 */
const UNTUNED = ["a", "b", "c"]
const COUNTERS = [
	...[...UNTUNED, "readsb"].map(k => `decoder-${k}#0`),
	"live-demod-s#0",
	"@absorber#0",
]

/**
 * `gateGuardPercent` above the monitor's 90 % guard: CPU between them makes
 * the monitor attribute drops to the host while the gate sees no CPU loss.
 */
function harness(gateGuardPercent = 90) {
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
		{ budgetCores: 10, cpuGuardPercent: gateGuardPercent },
		{ drops: monitor },
	)
	const running: RunningPlacement[] = []
	const tick = () => {
		mono += 2_000
		gate.record(monitor.sampleNow())
	}
	const admit = (key: string, tuned: boolean) => {
		const placement: WantedPlacement = {
			key,
			decoderId: key,
			sourceId: "s",
			reach: "raw",
			channelHz: null,
			costCores: 0.1,
			origin: "band",
			primary: true,
			sampleRateHz: 2_400_000,
			...(tuned ? { tunedBand: true as const } : {}),
		}
		expect(gate.admit(placement, running, mono).admit).toBe(true)
		running.push({
			key,
			sourceId: "s",
			reach: "raw",
			costCores: 0.1,
			sampleRateHz: placement.sampleRateHz,
			admittedAtMs: mono,
			mode: "auto",
			startMode: "auto",
			inputBranch: `decoder-${key}`,
			...(tuned ? { tunedBand: true as const } : {}),
		})
	}
	// A clean source (60 s clear window) admits; one probationer per source,
	// so each untuned placement graduates (17 samples = 34 s) before the next.
	for (let i = 0; i < 32; i++) tick()
	for (const key of UNTUNED) {
		admit(key, false)
		for (let i = 0; i < 17; i++) {
			tick()
			expect(gate.probation(running, mono)).toEqual([])
		}
	}
	admit("readsb", true)
	const admittedAt = mono
	/**
	 * Drops `step` returns on its counters every sample for `ms`; the verdicts
	 * with their times. A shed placement stops, as the manager stops it.
	 */
	const dropFor = (step: (sample: number) => readonly string[], ms: number) => {
		const verdicts: { key: string; detail: string; at: number }[] = []
		for (let t = 0, i = 0; t < ms; t += 2_000, i++) {
			for (const key of step(i)) totals.set(key, totals.get(key)! + 1)
			tick()
			for (const verdict of gate.probation(running, mono)) {
				verdicts.push({ ...verdict, at: mono - admittedAt })
				const index = running.findIndex(p => p.key === verdict.key)
				if (index >= 0) running.splice(index, 1)
				gate.forget(verdict.key)
			}
		}
		return verdicts
	}
	return { dropFor, cpu, running }
}

it("live audio drops during a tuned probation shed nothing", () => {
	const h = harness()
	expect(h.dropFor(() => ["live-demod-s#0"], 60_000)).toEqual([])
	// Host loss too: the drops land on a branch no placement reads.
	const host = harness(99)
	host.cpu.normalisedPercent = 95
	expect(host.dropFor(() => ["live-demod-s#0"], 60_000)).toEqual([])
})

it("drops on the tuned probationer's own branch are its own probation loss", () => {
	const h = harness()
	const verdicts = h.dropFor(() => ["decoder-readsb#0"], 60_000)
	expect(verdicts.map(({ key, detail }) => ({ key, detail }))).toEqual([
		{ key: "readsb", detail: "drops" },
	])
	expect(h.running.map(p => p.key)).toEqual(UNTUNED)
})

it("consumer drops on sibling branches do not judge the tuned probationer", () => {
	const h = harness()
	// The host is healthy: loss on the untuned placements' branches only is
	// theirs (late drops judge them once readsb graduates), not readsb's.
	const verdicts = h.dropFor(
		() => ["decoder-a#0", "decoder-b#0", "decoder-c#0"],
		20_000,
	)
	expect(verdicts).toEqual([])
})

it("host loss on a read sibling branch sheds the newest untuned placement, one per clear window", () => {
	const h = harness(99)
	h.cpu.normalisedPercent = 95
	// Host loss on a and b every sample; readsb's own branch stays clean.
	// Within one clear window (60 000 ms) only one scapegoat goes, the
	// newest untuned placement, although the loss goes on (readsb still on
	// probation: 28 s < 30 s).
	expect(
		h
			.dropFor(() => ["decoder-a#0", "decoder-b#0"], 28_000)
			.map(({ key, detail }) => ({ key, detail })),
	).toEqual([{ key: "c", detail: "drops" }])
	// Once readsb graduates, late drops judge a and b by their own branch.
	const later = h.dropFor(() => ["decoder-a#0", "decoder-b#0"], 60_000)
	expect(later.every(v => v.detail === "late-drops")).toBe(true)
	expect(h.running.map(p => p.key)).toContain("readsb")
})

// Feature: decoder-autostart, Property 7: probation drops are charged to the branch that dropped
// Validates: Requirements R2, R7
it("no placement is shed for drops only on unread branches, and at most one scapegoat per clear window", () => {
	const branch = fc.constantFrom(
		"decoder-a#0",
		"decoder-b#0",
		"decoder-c#0",
		"decoder-readsb#0",
		"live-demod-s#0",
	)
	fc.assert(
		fc.property(
			fc.array(
				fc.record({
					drops: fc.uniqueArray(branch, { maxLength: 3 }),
					host: fc.boolean(),
				}),
				{ minLength: 1, maxLength: 60 },
			),
			fc.boolean(),
			(pattern, unreadOnly) => {
				const h = harness()
				const verdicts = h.dropFor(i => {
					const step = pattern[i % pattern.length]!
					h.cpu.normalisedPercent = step.host ? 95 : 10
					return unreadOnly ? ["live-demod-s#0"] : step.drops
				}, 120_000)
				const probationVerdicts = verdicts.filter(
					v => v.detail !== "late-drops",
				)
				if (unreadOnly)
					// CPU is not a drop: only a CPU verdict may come from it.
					expect(probationVerdicts.every(v => v.detail === "cpu")).toBe(true)
				const scapegoats = probationVerdicts.filter(v => v.key !== "readsb")
				for (let i = 1; i < scapegoats.length; i++)
					expect(
						scapegoats[i]!.at - scapegoats[i - 1]!.at,
					).toBeGreaterThanOrEqual(EFFICIENCY_CLEAR_MS)
			},
		),
		{ numRuns: 100 },
	)
	// 100 runs of up to 60 two-second samples through the real monitor take
	// about 3.5 s alone; the bound guards hangs, not speed.
}, 30_000)

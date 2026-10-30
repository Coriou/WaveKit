import { expect, it } from "vitest"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import {
	EFFICIENCY_CLEAR_MS,
	type RunningPlacement,
	type WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"

/**
 * How far a tuned-band probationer's scapegoat window reaches. Each source
 * has the branches the core creates: each raw decoder's own branch
 * (`decoder-<id>`), live audio (`live-demod-<source>`) and the absorber
 * (`@absorber#0`, with the branches that held it when it overflowed). Untuned
 * placements run graduated; the tuned-band placement readsb, on source "s",
 * is admitted last and is on probation. The monitor and the gate read one
 * fake monotonic clock (`mono`); samples are taken on it every 2000 ms.
 */
type Spec = { key: string; source: string; tuned?: boolean }

/**
 * `gateGuardPercent` above the monitor's 90 % guard: CPU between them makes
 * the monitor attribute drops to the host while the gate sees no CPU loss.
 */
function harness(specs: readonly Spec[], gateGuardPercent: number) {
	const sources = [...new Set(specs.map(s => s.source))]
	let mono = 0
	const totals = new Map<string, number>()
	const gatedBy = new Map<string, Record<string, number>>()
	for (const source of sources) {
		gatedBy.set(source, {})
		totals.set(`${source}|live-demod-${source}#0`, 0)
		totals.set(`${source}|@absorber#0`, 0)
	}
	for (const s of specs) totals.set(`${s.source}|decoder-${s.key}#0`, 0)
	const cpu = { normalisedPercent: 10 as number | null }
	const monitor = createEfficiencyMonitor({
		sources: () => sources,
		branchCounters: (id: string) =>
			new Map(
				[...totals]
					.filter(([k]) => k.startsWith(`${id}|`))
					.map(([k, n]) => {
						const key = k.slice(id.length + 1)
						return [
							key,
							{
								droppedBytesTotal: n,
								droppedChunksTotal: n,
								...(key.startsWith("@")
									? { overflowGatedBy: { ...gatedBy.get(id) } }
									: {}),
							},
						]
					}),
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
	const admit = (s: Spec) => {
		const placement: WantedPlacement = {
			key: s.key,
			decoderId: s.key,
			sourceId: s.source,
			reach: "raw",
			channelHz: null,
			costCores: 0.1,
			origin: "band",
			primary: true,
			sampleRateHz: 2_400_000,
			...(s.tuned ? { tunedBand: true as const } : {}),
		}
		expect(gate.admit(placement, running, mono).admit).toBe(true)
		running.push({
			key: s.key,
			sourceId: s.source,
			reach: "raw",
			costCores: 0.1,
			sampleRateHz: placement.sampleRateHz,
			admittedAtMs: mono,
			mode: "auto",
			startMode: "auto",
			inputBranch: `decoder-${s.key}`,
			...(s.tuned ? { tunedBand: true as const } : {}),
		})
	}
	// A clean source (60 s clear window) admits; one probationer per source,
	// so each untuned placement graduates (17 samples = 34 s) before the next.
	for (let i = 0; i < 32; i++) tick()
	for (const s of specs.filter(s => !s.tuned)) {
		admit(s)
		for (let i = 0; i < 17; i++) {
			tick()
			expect(gate.probation(running, mono)).toEqual([])
		}
	}
	for (const s of specs.filter(s => s.tuned)) admit(s)
	const admittedAt = mono
	/** Runs `step` before every sample for `ms`; a shed placement stops. */
	const run = (step: () => void, ms: number) => {
		const verdicts: { key: string; detail: string; at: number }[] = []
		for (let t = 0; t < ms; t += 2_000) {
			step()
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
	/** Absorber overflow on `source` with no holder known: charged source-wide. */
	const overflowNoHolder = (source: string) => {
		const key = `${source}|@absorber#0`
		totals.set(key, totals.get(key)! + 1)
	}
	/** Drops on `key`'s own decoder branch. */
	const dropOn = (source: string, key: string) => {
		const k = `${source}|decoder-${key}#0`
		totals.set(k, totals.get(k)! + 1)
	}
	return { run, overflowNoHolder, dropOn, cpu, running, monitor }
}

it("CPU scapegoats are one per clear window across all sources", () => {
	const h = harness(
		[
			{ key: "a", source: "s" },
			{ key: "b", source: "s" },
			{ key: "x", source: "t" },
			{ key: "y", source: "t" },
			{ key: "readsb", source: "s", tuned: true },
		],
		90,
	)
	h.cpu.normalisedPercent = 95
	// CPU relief is host-wide: within one clear window (60 000 ms) one
	// placement goes, the newest untuned one (y, on the other source), not
	// one per source (y at +2 s and b at +4 s before the fix).
	const verdicts = h.run(() => {}, 120_000)
	const scapegoats = verdicts.filter(v => v.key !== "readsb")
	expect(scapegoats.map(({ key, at }) => ({ key, at }))).toEqual([
		{ key: "y", at: 2_000 },
		{ key: "x", at: 2_000 + EFFICIENCY_CLEAR_MS },
	])
	// At the window's edge, not before: 2 000 + 60 000 - 2 000 sheds nothing.
	for (let i = 1; i < scapegoats.length; i++)
		expect(scapegoats[i]!.at - scapegoats[i - 1]!.at).toBeGreaterThanOrEqual(
			EFFICIENCY_CLEAR_MS,
		)
})

it("host drops keep a scapegoat window per source", () => {
	// Host drops are relieved where they happen: a tuned probationer on each
	// source, host overflow with no holder known on both, and each source
	// sheds its own newest untuned placement in the same sample, then none
	// for the rest of the clear window (58 000 ms < EFFICIENCY_CLEAR_MS).
	const h = harness(
		[
			{ key: "a", source: "s" },
			{ key: "b", source: "s" },
			{ key: "x", source: "t" },
			{ key: "y", source: "t" },
			{ key: "readsb", source: "s", tuned: true },
			{ key: "ais", source: "t", tuned: true },
		],
		99,
	)
	h.cpu.normalisedPercent = 95
	const verdicts = h.run(() => {
		h.overflowNoHolder("s")
		h.overflowNoHolder("t")
	}, 58_000)
	expect(
		verdicts
			.filter(v => v.detail !== "late-drops")
			.sort((l, r) => l.key.localeCompare(r.key)),
	).toEqual([
		{ key: "b", detail: "drops", at: 2_000 },
		{ key: "y", detail: "drops", at: 2_000 },
	])
})

it("host overflow with no holder known sheds an untuned placement before the tuned one", () => {
	const h = harness(
		[
			{ key: "a", source: "s" },
			{ key: "b", source: "s" },
			{ key: "c", source: "s" },
			{ key: "readsb", source: "s", tuned: true },
		],
		99,
	)
	h.cpu.normalisedPercent = 95
	// Overflow charged to the source as a whole is loss elsewhere for the
	// tuned probationer: the newest untuned placement goes, at most one per
	// clear window, and readsb stays (it was shed at +2 s before the fix).
	const verdicts = h.run(() => h.overflowNoHolder("s"), 60_000)
	const probation = verdicts.filter(v => v.detail !== "late-drops")
	expect(probation).toEqual([{ key: "c", detail: "drops", at: 2_000 }])
	expect(h.running.map(p => p.key)).toContain("readsb")
})

it("source-wide loss that is not host loss is loss elsewhere for the tuned probationer", () => {
	// A healthy host: overflow with no holder known is not host load, and no
	// holder is known, so it is not readsb's own loss either (readsb was shed
	// at +2 s before the fix). The untuned placement goes first; with nothing
	// untuned left, readsb is judged by its own branch and CPU only.
	const h = harness(
		[
			{ key: "a", source: "s" },
			{ key: "readsb", source: "s", tuned: true },
		],
		90,
	)
	const verdicts = h.run(() => h.overflowNoHolder("s"), 10_000)
	expect(verdicts.map(({ key, detail }) => ({ key, detail }))).toEqual([
		{ key: "a", detail: "drops" },
	])
	expect(h.running.map(p => p.key)).toEqual(["readsb"])
})

it("loss charged to the tuned probationer's own branch is its own", () => {
	const h = harness(
		[
			{ key: "a", source: "s" },
			{ key: "readsb", source: "s", tuned: true },
		],
		90,
	)
	const verdicts = h.run(() => h.dropOn("s", "readsb"), 10_000)
	expect(verdicts.map(({ key, detail }) => ({ key, detail }))).toEqual([
		{ key: "readsb", detail: "drops" },
	])
	expect(h.running.map(p => p.key)).toEqual(["a"])
})

it("sustained CPU does not shed the tuned probationer while the scapegoat's clear window is open", () => {
	const h = harness(
		[
			{ key: "a", source: "s" },
			{ key: "readsb", source: "s", tuned: true },
		],
		90,
	)
	h.cpu.normalisedPercent = 95
	// a goes at +2 s; nothing untuned is left, but its relief has not had
	// EFFICIENCY_CLEAR_MS to show: readsb was shed at +4 s before the fix.
	const verdicts = h.run(() => {}, 2_000 + EFFICIENCY_CLEAR_MS)
	expect(verdicts.map(({ key, detail, at }) => ({ key, detail, at }))).toEqual([
		{ key: "a", detail: "cpu", at: 2_000 },
		{ key: "readsb", detail: "cpu", at: 2_000 + EFFICIENCY_CLEAR_MS },
	])
})

it("CPU relieved within the scapegoat's clear window keeps the tuned probationer", () => {
	const h = harness(
		[
			{ key: "a", source: "s" },
			{ key: "readsb", source: "s", tuned: true },
		],
		90,
	)
	h.cpu.normalisedPercent = 95
	let t = 0
	const verdicts = h.run(() => {
		if ((t += 2_000) > 6_000) h.cpu.normalisedPercent = 10
	}, 120_000)
	expect(verdicts.map(({ key, detail }) => ({ key, detail }))).toEqual([
		{ key: "a", detail: "cpu" },
	])
	expect(h.running.map(p => p.key)).toEqual(["readsb"])
})

it("late drops do not shed a second placement for loss spent on a scapegoat", () => {
	// Sustained host overflow with no holder known: c is the scapegoat at
	// +2 s and readsb graduates (the overflow is not its own). b was shed by
	// late drops at +56 s before the fix, inside c's clear window.
	const h = harness(
		[
			{ key: "a", source: "s" },
			{ key: "b", source: "s" },
			{ key: "c", source: "s" },
			{ key: "readsb", source: "s", tuned: true },
		],
		99,
	)
	h.cpu.normalisedPercent = 95
	const verdicts = h.run(() => h.overflowNoHolder("s"), EFFICIENCY_CLEAR_MS)
	expect(verdicts).toEqual([{ key: "c", detail: "drops", at: 2_000 }])
})

it("late drops on a CPU scapegoat's source do not shed a second placement for that loss", () => {
	// readsb's CPU loss on source s sheds c on source t at +2 s; t's host
	// drops up to then were the same loss. b was shed by late drops at +16 s
	// before the fix.
	const h = harness(
		[
			{ key: "a", source: "s" },
			{ key: "b", source: "t" },
			{ key: "c", source: "t" },
			{ key: "readsb", source: "s", tuned: true },
		],
		90,
	)
	h.cpu.normalisedPercent = 95
	let t = 0
	const verdicts = h.run(() => {
		if ((t += 2_000) <= 8_000) h.overflowNoHolder("t")
		else h.cpu.normalisedPercent = 10
	}, 120_000)
	expect(verdicts).toEqual([{ key: "c", detail: "cpu", at: 2_000 }])
})

it("late drops on another placement's own branch still shed it inside a scapegoat's clear window", () => {
	// readsb's CPU loss sheds c at +2 s and the CPU recovers at once; then
	// only b's own branch drops (consumer loss, a new episode). The scapegoat
	// window spends the loss that shed c, not b's own: b survived until
	// +62 s before the fix.
	const h = harness(
		[
			{ key: "a", source: "s" },
			{ key: "b", source: "s" },
			{ key: "c", source: "s" },
			{ key: "readsb", source: "s", tuned: true },
		],
		90,
	)
	h.cpu.normalisedPercent = 95
	let t = 0
	const verdicts = h.run(() => {
		if ((t += 2_000) > 2_000) {
			h.cpu.normalisedPercent = 10
			h.dropOn("s", "b")
		}
	}, 2_000 + EFFICIENCY_CLEAR_MS)
	expect(verdicts[0]).toEqual({ key: "c", detail: "cpu", at: 2_000 })
	const b = verdicts.find(v => v.key === "b")
	expect(b?.detail).toBe("late-drops")
	expect(b!.at).toBeLessThan(2_000 + EFFICIENCY_CLEAR_MS)
	expect(verdicts.filter(v => v.key !== "b" && v.key !== "c")).toEqual([])
})

it("the tuned probationer's own branch drops count when no-holder overflow shares the sample", () => {
	// Each sample: readsb's own branch drops and the absorber overflows with
	// no holder known, on a healthy host. The overflow is loss elsewhere; the
	// branch drops are readsb's own. Before the fix the sample was charged to
	// the source as a whole only, and readsb was never shed in 180 s.
	const h = harness([{ key: "readsb", source: "s", tuned: true }], 90)
	const verdicts = h.run(() => {
		h.dropOn("s", "readsb")
		h.overflowNoHolder("s")
	}, 180_000)
	expect(verdicts.map(({ key, detail, at }) => ({ key, detail, at }))).toEqual([
		{ key: "readsb", detail: "drops", at: 2_000 },
	])
	const charged = h.monitor.chargedDropsBetweenMono("s", 0, Infinity)
	expect(charged.at(-1)?.branches).toBe("source")
	expect(charged.at(-2)?.branches).toEqual(["decoder-readsb"])
	expect(charged.at(-2)?.atMono).toBe(charged.at(-1)?.atMono)
})

it("late windows keep explicit branch charges beside source-wide overflow", () => {
	// Host loss (CPU between the monitor's and the gate's guards): readsb's
	// own branch drops beside no-holder overflow are still its own, and the
	// windows name its branch beside the source-wide charge.
	const h = harness([{ key: "readsb", source: "s", tuned: true }], 99)
	h.cpu.normalisedPercent = 95
	const verdicts = h.run(() => {
		h.dropOn("s", "readsb")
		h.overflowNoHolder("s")
	}, 40_000)
	expect(verdicts.map(({ key, detail, at }) => ({ key, detail, at }))).toEqual([
		{ key: "readsb", detail: "drops", at: 2_000 },
	])
	expect(h.monitor.latestAttribution("s")).toBe("host")
	expect(h.monitor.lateWindows("s").at(-1)).toMatchObject({
		condemning: true,
		condemnedBranches: "source",
		explicitBranches: ["decoder-readsb"],
	})
})

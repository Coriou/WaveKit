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
	return { run, overflowNoHolder, cpu, running }
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

it("source-wide loss that is not host loss still judges the tuned probationer", () => {
	// A healthy host: overflow with no holder known is not host load, and
	// probation fails closed on it as before.
	const h = harness(
		[
			{ key: "a", source: "s" },
			{ key: "readsb", source: "s", tuned: true },
		],
		90,
	)
	const verdicts = h.run(() => h.overflowNoHolder("s"), 10_000)
	expect(verdicts.map(({ key, detail }) => ({ key, detail }))).toEqual([
		{ key: "readsb", detail: "drops" },
	])
})

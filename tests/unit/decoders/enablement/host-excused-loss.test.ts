/**
 * L1 is visible: while the host is busy (and the core's own CPU is not over) an untuned placement is not
 * late-stopped for its own loss, and the efficiency view names that excuse on the placement (`hostExcusedLoss`,
 * cause host-busy) with one log line when it begins and one when it ends. Monitor and gate on one fake clock;
 * nothing connects anywhere.
 */
import { expect, it, vi } from "vitest"
import type { Logger } from "../../../../src/utils/logger.js"
import { createEfficiencyMonitor } from "../../../../src/decoders/enablement/efficiency-monitor.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import {
	channelizerBranchId,
	EFFICIENCY_DROP_WINDOW_MS,
	LATE_SHED_WINDOWS,
	placementKey,
	type RunningPlacement,
	type WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import type { OwnCpuSource } from "../../../../src/decoders/enablement/own-cpu.js"
import { OWN_CALM } from "./rx-starvation-harness.js"

const G = 90
/** The placement key of `chan` (a channel) or `a` / `b` (raw). */
const K = (id: "chan" | "a" | "b") =>
	placementKey(id, "s", id === "chan" ? "channel" : "raw", null)

/** Three graduated untuned placements on source `s`: `chan` (channelizer branch), `a` and `b` (raw branches). */
function harness() {
	let mono = 0
	let host = 10
	const branches = [
		"decoder-a",
		"decoder-b",
		"decoder-c",
		"channelizer-s",
		"live-demod-s",
	]
	const totals = new Map(branches.map(b => [b, 0]))
	const ownCpu: OwnCpuSource = {
		sample: () => ({ ownCores: OWN_CALM, capacityCores: 4, available: true }),
	}
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
		cpu: {
			get normalisedPercent() {
				return host
			},
		},
		ownCpu,
		now: () => mono,
		monoNow: () => mono,
		setInterval: () => ({ cancel() {} }),
	})
	const warn = vi.fn()
	const info = vi.fn()
	const log = {
		warn,
		info,
		error: vi.fn(),
		debug: vi.fn(),
	} as unknown as Logger
	const gate = createEfficiencyGate(
		{ budgetCores: 10, cpuGuardPercent: G },
		{ drops: monitor, log },
	)
	const running: RunningPlacement[] = []
	const verdicts: { key: string; detail: string }[] = []
	const tick = () => {
		mono += 2_000
		gate.record(monitor.sampleNow())
		verdicts.push(...gate.probation(running, mono))
	}
	for (let i = 0; i < 32; i++) {
		mono += 2_000
		gate.record(monitor.sampleNow())
	}
	const admit = (id: "chan" | "a" | "b" | "c", reach: "channel" | "raw") => {
		const key = id === "c" ? placementKey(id, "s", "raw", null) : K(id)
		const placement: WantedPlacement = {
			key,
			decoderId: id,
			sourceId: "s",
			reach,
			channelHz: null,
			costCores: 0.1,
			origin: "band",
			primary: true,
			sampleRateHz: 2_400_000,
			...(id === "c" ? { tunedBand: true } : {}),
		}
		if (!gate.admit(placement, running, mono).admit) return false
		running.push({
			key,
			sourceId: "s",
			reach,
			costCores: 0.1,
			sampleRateHz: placement.sampleRateHz,
			admittedAtMs: mono,
			mode: "auto",
			startMode: "auto",
			inputBranch:
				reach === "channel" ? channelizerBranchId("s") : `decoder-${id}`,
			...(id === "c" ? { tunedBand: true } : {}),
		})
		return true
	}
	for (const [id, reach] of [
		["chan", "channel"],
		["a", "raw"],
		["b", "raw"],
	] as const) {
		expect(admit(id, reach)).toBe(true)
		for (let i = 0; i < 17; i++) tick()
	}
	expect(verdicts).toEqual([])
	const excuses = () =>
		Object.fromEntries(
			gate
				.view(running, [], mono)
				.sources.flatMap(source => source.admitted)
				.flatMap(p =>
					p.hostExcusedLoss ? [[p.decoderId, p.hostExcusedLoss] as const] : [],
				),
		)
	const lines = (fn: typeof warn, msg: string) =>
		fn.mock.calls.filter(call => call[1] === msg)
	return {
		gate,
		running,
		verdicts,
		excuses,
		get mono() {
			return mono
		},
		entered: () => lines(warn, "Late loss excused: host busy"),
		cleared: () => lines(info, "Late loss no longer excused"),
		/** Admits a fourth raw placement `c` of the tuned band (the source's newest, on probation) if the gate admits it. */
		admitC() {
			return admit("c", "raw")
		},
		setHost(value: number) {
			host = value
		},
		/** `dropping` branches drop on every 2 s sample for `ms`. */
		run(dropping: readonly string[], ms: number) {
			for (let t = 0; t < ms; t += 2_000) {
				for (const b of dropping) totals.set(b, totals.get(b)! + 1)
				tick()
			}
		},
	}
}

/** Long enough for the latest LATE_SHED_WINDOWS windows to hold no drop. */
const QUIET_MS = (LATE_SHED_WINDOWS + 1) * EFFICIENCY_DROP_WINDOW_MS

it("under host-busy, own-branch loss is excused visibly: on its placement only, with cause host-busy and one warning", () => {
	const h = harness()
	h.setHost(99)
	h.run(["decoder-a"], 40_000)
	expect(h.verdicts).toEqual([])
	const excuses = h.excuses()
	expect(Object.keys(excuses)).toEqual(["a"])
	expect(excuses["a"]).toMatchObject({ cause: "host-busy" })
	expect(excuses["a"]!.windows).toBeGreaterThanOrEqual(1)
	expect(excuses["a"]!.windows).toBeLessThanOrEqual(LATE_SHED_WINDOWS)
	expect(Number.isNaN(Date.parse(excuses["a"]!.since))).toBe(false)
	expect(h.entered()).toHaveLength(1)
	expect(h.entered()[0]![0]).toEqual({
		placement: K("a"),
		sourceId: "s",
		cause: "host-busy",
		windows: expect.any(Number),
	})
	expect(h.cleared()).toHaveLength(0)
})

it("source-wide channelizer loss under host-busy is excused for the placement reading that branch", () => {
	const h = harness()
	h.setHost(99)
	h.run(["channelizer-s"], 40_000)
	expect(h.verdicts).toEqual([])
	expect(Object.keys(h.excuses())).toEqual(["chan"])
})

it("loss on a branch no decoder reads excuses nothing", () => {
	const h = harness()
	h.setHost(99)
	h.run(["live-demod-s"], 40_000)
	expect(h.excuses()).toEqual({})
	expect(h.entered()).toHaveLength(0)
})

it("clears with one info line when the loss stops, the host still busy", () => {
	const h = harness()
	h.setHost(99)
	h.run(["decoder-a"], 40_000)
	expect(Object.keys(h.excuses())).toEqual(["a"])
	h.run([], QUIET_MS)
	expect(h.excuses()).toEqual({})
	expect(h.cleared()).toHaveLength(1)
	expect(h.cleared()[0]![0]).toMatchObject({
		placement: K("a"),
		sourceId: "s",
		cause: "host-busy",
	})
	h.run([], 60_000)
	expect(h.entered()).toHaveLength(1)
	expect(h.cleared()).toHaveLength(1)
})

it("clears when the host calms: the excuse ends (the loss is judged again as the placement's own)", () => {
	const h = harness()
	h.setHost(99)
	h.run(["decoder-a"], 40_000)
	expect(Object.keys(h.excuses())).toEqual(["a"])
	h.setHost(10)
	h.run([], 2_000)
	expect(h.excuses()).toEqual({})
	expect(h.cleared()).toHaveLength(1)
})

it("a long busy run with steady loss stays one entry and one warning (no duplicate, bounded), refreshed in place", () => {
	const h = harness()
	h.setHost(99)
	h.run(["decoder-a", "decoder-b"], 10 * 60_000)
	expect(h.verdicts).toEqual([])
	const excuses = h.excuses()
	expect(Object.keys(excuses).sort()).toEqual(["a", "b"])
	expect(h.entered()).toHaveLength(2)
	expect(h.cleared()).toHaveLength(0)
	const view = h.gate.view(h.running, [], h.mono)
	const admitted = view.sources.flatMap(source => source.admitted)
	expect(admitted.filter(p => p.hostExcusedLoss)).toHaveLength(2)
	// Since stays when the excuse began.
	const since = excuses["a"]!.since
	h.run(["decoder-a", "decoder-b"], 20_000)
	expect(h.excuses()["a"]!.since).toBe(since)
})

it("a placement that stops running loses its excuse with one info line; forget also clears", () => {
	const h = harness()
	h.setHost(99)
	h.run(["decoder-a", "decoder-b"], 40_000)
	expect(Object.keys(h.excuses()).sort()).toEqual(["a", "b"])
	const a = h.running.findIndex(p => p.key === K("a"))
	h.running.splice(a, 1)
	h.run(["decoder-b"], 2_000)
	expect(Object.keys(h.excuses())).toEqual(["b"])
	expect(
		h.cleared().map(call => (call[0] as { placement: string }).placement),
	).toEqual([K("a")])
	h.gate.forget(K("b"))
	expect(
		h.cleared().map(call => (call[0] as { placement: string }).placement),
	).toEqual([K("a"), K("b")])
})

it("one excused window would not have condemned the placement: no excuse, no log line; sparse drops never log", () => {
	const h = harness()
	h.setHost(99)
	h.run(["decoder-a"], 2_000)
	h.run([], QUIET_MS)
	expect(h.excuses()).toEqual({})
	expect(h.entered()).toHaveLength(0)
	// One drop every 36 s: never two excused windows in one window set.
	for (let i = 0; i < 10; i++) {
		h.run(["decoder-a"], 2_000)
		h.run([], 34_000)
	}
	expect(h.verdicts).toEqual([])
	expect(h.entered()).toHaveLength(0)
	expect(h.cleared()).toHaveLength(0)
})

it("two excused windows (LATE_SHED_HITS) begin the excuse; it ends a full window set after its newest excused window", () => {
	const h = harness()
	h.setHost(99)
	h.run(["decoder-a"], 2_000)
	h.run([], 10_000)
	expect(h.entered()).toHaveLength(0)
	h.run(["decoder-a"], 2_000)
	// Once the second drop's window completes.
	h.run([], EFFICIENCY_DROP_WINDOW_MS)
	expect(h.verdicts).toEqual([])
	expect(Object.keys(h.excuses())).toEqual(["a"])
	expect(h.excuses()["a"]!.windows).toBe(2)
	expect(h.entered()).toHaveLength(1)
	// The newest excused window ends at or after its drop: the excuse is still shown just short of a full window
	// set after the drop, and gone once a full set has passed since that window's end.
	h.run([], LATE_SHED_WINDOWS * EFFICIENCY_DROP_WINDOW_MS - 12_000)
	expect(Object.keys(h.excuses())).toEqual(["a"])
	h.run([], EFFICIENCY_DROP_WINDOW_MS + 4_000)
	expect(h.excuses()).toEqual({})
	expect(h.cleared()).toHaveLength(1)
	expect(h.entered()).toHaveLength(1)
})

it("a source whose late pass is skipped (its newest placement on probation) clears its excuses and keeps none while it is skipped", () => {
	const h = harness()
	h.setHost(99)
	h.run(["decoder-a"], 40_000)
	expect(Object.keys(h.excuses())).toEqual(["a"])
	// Host loss does not refuse a tuned-band newcomer.
	expect(h.admitC()).toBe(true)
	expect(h.cleared()).toHaveLength(0)
	h.run(["decoder-a"], 2_000)
	expect(h.excuses()).toEqual({})
	expect(
		h.cleared().map(call => (call[0] as { placement: string }).placement),
	).toEqual([K("a")])
	// No stale excuse comes back while the probationer is on probation.
	h.run(["decoder-a"], 20_000)
	expect(h.excuses()).toEqual({})
	expect(h.entered()).toHaveLength(1)
})

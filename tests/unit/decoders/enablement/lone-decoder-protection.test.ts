import { afterEach, expect, it, vi } from "vitest"
import type {
	ChargedDrop,
	EfficiencyGate,
	RunningPlacement,
} from "../../../../src/decoders/enablement/contract.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type { DecoderManager } from "../../../../src/decoders/manager.js"
import { channelPlacement, gateManager } from "./gate-manager-harness.js"

let manager: DecoderManager | undefined
afterEach(async () => {
	await manager?.destroy()
	manager = undefined
	vi.useRealTimers()
})

function fakeGate() {
	const gate: EfficiencyGate = {
		record: vi.fn(),
		admit: vi.fn<EfficiencyGate["admit"]>(() => ({ admit: true })),
		probation: vi.fn(() => []),
		noteSuspended: vi.fn(),
		forget: vi.fn(),
		view: vi.fn(() => ({ budgetCores: 0.5, cpuGuardPercent: 90, sources: [] })),
	}
	return gate
}

const flags = (placements: readonly RunningPlacement[]) =>
	placements.map(p => [
		p.key.slice(0, p.key.indexOf("#")),
		p.tunedBand ?? false,
	])

it("every placement of the only running decoder is judged and viewed as the tuned one", async () => {
	const gate = fakeGate()
	// A primary placement and a secondary one (a worker of the same decoder).
	const h = gateManager(
		gate,
		["dec"],
		[
			channelPlacement("dec", 162_000_000),
			{ ...channelPlacement("dec", 162_025_000), primary: false },
		],
	)
	manager = h.manager
	await manager.startAll()
	await h.settle()
	await vi.advanceTimersByTimeAsync(2_500)
	const judged = vi.mocked(gate.probation).mock.calls.at(-1)![0]
	expect(flags(judged)).toEqual([
		["dec", true],
		["dec", true],
	])
	manager.efficiencyView()
	expect(flags(vi.mocked(gate.view).mock.calls.at(-1)![0])).toEqual([
		["dec", true],
		["dec", true],
	])
})

it("with two decoders running neither is protected, and a newcomer of another decoder is admitted as itself", async () => {
	const gate = fakeGate()
	const h = gateManager(
		gate,
		["a", "b"],
		[channelPlacement("a", 162_000_000), channelPlacement("b", 162_025_000)],
	)
	manager = h.manager
	await manager.startAll()
	await h.settle()
	await vi.advanceTimersByTimeAsync(2_500)
	expect(flags(vi.mocked(gate.probation).mock.calls.at(-1)![0])).toEqual([
		["a", false],
		["b", false],
	])
	manager.efficiencyView()
	expect(flags(vi.mocked(gate.view).mock.calls.at(-1)![0])).toEqual([
		["a", false],
		["b", false],
	])
	// The admission of b ran with a running: b is not the only decoder.
	const admissions = vi
		.mocked(gate.admit)
		.mock.calls.filter(([placement]) => placement.decoderId === "b")
	expect(admissions.length).toBeGreaterThan(0)
	for (const [placement, running] of admissions)
		if (running.some(p => p.key.startsWith("a#")))
			expect(placement.alone).toBeUndefined()
})

// A valid source id may contain the key's own separators.
const ODD_SOURCE = "rtl#1@lab"

it("the only decoder on a source id containing # and @ keeps its protection in probation and view", async () => {
	const gate = fakeGate()
	const h = gateManager(
		gate,
		["dec"],
		[
			channelPlacement("dec", 162_000_000, ODD_SOURCE),
			{ ...channelPlacement("dec", 162_025_000, ODD_SOURCE), primary: false },
		],
	)
	manager = h.manager
	await manager.startAll()
	await h.settle()
	await vi.advanceTimersByTimeAsync(2_500)
	const judged = vi.mocked(gate.probation).mock.calls.at(-1)![0]
	expect(judged.map(p => [p.sourceId, p.tunedBand ?? false])).toEqual([
		[ODD_SOURCE, true],
		[ODD_SOURCE, true],
	])
	manager.efficiencyView()
	expect(
		vi
			.mocked(gate.view)
			.mock.calls.at(-1)![0]
			.map(p => p.tunedBand ?? false),
	).toEqual([true, true])
})

it("on a source id containing # and @ a decoder's own placements never count as another decoder at admission", async () => {
	const gate = fakeGate()
	const first = channelPlacement("dec", 162_000_000, ODD_SOURCE)
	const second = {
		...channelPlacement("dec", 162_025_000, ODD_SOURCE),
		primary: false,
	}
	const h = gateManager(gate, ["dec", "other"], [first])
	manager = h.manager
	await manager.startAll()
	await h.settle()
	h.plan([first, second])
	await h.settle()
	const own = vi
		.mocked(gate.admit)
		.mock.calls.filter(([placement]) => placement.key === second.key)
	expect(own.length).toBeGreaterThan(0)
	for (const [placement, running] of own) {
		expect(running.some(p => p.key === first.key)).toBe(true)
		expect(placement.alone).toBe(true)
	}
	// Another decoder on the same source is not alone beside dec.
	const third = channelPlacement("other", 162_050_000, ODD_SOURCE)
	h.plan([first, second, third])
	await h.settle()
	const other = vi
		.mocked(gate.admit)
		.mock.calls.filter(([placement]) => placement.key === third.key)
	expect(other.length).toBeGreaterThan(0)
	for (const [placement] of other) expect(placement.alone).toBeUndefined()
})

it("a lone decoder outside the tuned band is admitted while the host is busy (real gate)", async () => {
	// Host loss: two sibling branches (live audio and the channelizer's
	// neighbour) dropped together 4 s ago, the source still reads dropping.
	let drops: ChargedDrop[] = []
	const gate = createEfficiencyGate(
		{ budgetCores: 10, cpuGuardPercent: 90 },
		{
			drops: {
				monoNow: () => performance.now(),
				sources: () => ["rtl"],
				dropState: () => ({ state: "dropping", dropBytesPerSecond: 100 }),
				droppedSinceMono: () => false,
				droppedWithinMs: () => false,
				latestAttribution: () => "none",
				lastSampleMono: () => performance.now(),
				coverageCompleteAtMono: (_id, since, amount) =>
					performance.now() >= since + amount ? since + amount : null,
				chargedDropsBetweenMono: (_id, from, to) =>
					drops.filter(d => d.atMono >= from && d.atMono <= to),
			},
		},
	)
	const admit = vi.spyOn(gate, "admit")
	const h = gateManager(gate, ["dec"], [channelPlacement("dec", 162_000_000)])
	manager = h.manager
	await vi.advanceTimersByTimeAsync(10_000)
	const at = performance.now() - 4_000
	drops = [{ atMono: at, code: "host", branches: ["live-demod-rtl", "other"] }]
	expect(gate.hostBusy?.("rtl")).not.toBeNull()
	await manager.startAll()
	await h.settle()
	expect(admit.mock.calls.at(-1)![0]).toMatchObject({ alone: true })
	expect(admit.mock.calls.at(-1)![0].tunedBand).toBeUndefined()
	expect(admit.mock.results.at(-1)!.value).toMatchObject({ admit: true })
	expect(manager.getStatus("dec")).toMatchObject({ running: true })
	// Without the protection the same newcomer is refused for the drops.
	expect(
		gate.admit(
			{ ...channelPlacement("other", 162_050_000) },
			[],
			performance.now(),
		),
	).toMatchObject({ admit: false, detail: "drops" })
})

it("host busy shows only on a decoder whose own branch the host loss reached", async () => {
	const gate = fakeGate()
	const asked: (readonly string[] | undefined)[] = []
	const busy = {
		cause: "host" as const,
		congestedBranches: 2,
		loopLagP99Ms: 120,
		loopLagMaxMs: 200,
	}
	let reached = ""
	gate.hostBusy = (_sourceId, branches) => {
		asked.push(branches)
		return branches?.includes(reached) ? busy : null
	}
	const h = gateManager(
		gate,
		["a", "b", "idle"],
		[channelPlacement("a", 162_000_000), channelPlacement("b", 162_025_000)],
	)
	manager = h.manager
	await manager.startAll()
	await h.settle()
	// Channel placements read the channelizer's branch.
	reached = "channelizer-rtl"
	expect(manager.getStatus("a")?.hostBusy).toEqual({
		congestedBranches: 2,
		loopLagP99Ms: 120,
	})
	// A decoder with no running placement (no branch read) is never busy.
	expect(manager.getStatus("idle")?.hostBusy).toBeUndefined()
	expect(asked.every(b => b !== undefined && b.length > 0)).toBe(true)
	reached = "decoder-elsewhere"
	expect(manager.getStatus("b")?.hostBusy).toBeUndefined()
})

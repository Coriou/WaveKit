import { describe, expect, it } from "vitest"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import { placementCostCores } from "../../../../src/decoders/enablement/contract.js"
import type {
	EfficiencyGate,
	EfficiencySample,
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"

const placement = (
	key = "p",
	costCores = 0.1,
	sourceId = "s",
	reach: WantedPlacement["reach"] = "channel",
): WantedPlacement => ({
	key,
	decoderId: key,
	sourceId,
	reach,
	costCores,
	sampleRateHz: 2_400_000,
	channelHz: reach === "channel" ? 100 : null,
	origin: "band",
	primary: true,
})
const sample = (
	atMs = 0,
	cpuPercent: number | null = null,
	bytes: number | null = 0,
	chunks: number | null = 0,
): EfficiencySample => ({
	atMs,
	cpuPercent,
	sources: new Map([
		["s", { droppedBytesDelta: bytes, droppedChunksDelta: chunks }],
	]),
})
// Gate unit tests inject a pull reader; monitor integration is tested separately.
const setup = (budgetCores = 1.5): EfficiencyGate => {
	let at = 0
	let dropAt: number | null = null
	let state: "ok" | "dropping" | "unknown" = "ok"
	const gate = createEfficiencyGate(
		{ budgetCores, cpuGuardPercent: 90 },
		{
			drops: {
				sources: () => ["s"],
				monoNow: () => at,
				droppedSinceMono: (_id, since) =>
					state === "unknown" || (dropAt !== null && dropAt >= since),
				dropState: () => ({
					state,
					dropBytesPerSecond: state === "unknown" ? null : 0,
				}),
				droppedWithinMs: (_id, ms) =>
					state === "unknown" || (dropAt !== null && at - dropAt <= ms),
			},
		},
	)
	return {
		...gate,
		record(s) {
			at = s.atMs
			const counters = s.sources.get("s")
			if (
				counters?.droppedBytesDelta === null ||
				!Number.isFinite(counters?.droppedBytesDelta) ||
				counters?.droppedChunksDelta === null ||
				!Number.isFinite(counters?.droppedChunksDelta)
			)
				state = "unknown"
			else if (
				(counters?.droppedBytesDelta ?? 0) > 0 ||
				(counters?.droppedChunksDelta ?? 0) > 0
			) {
				state = "dropping"
				dropAt = at
			} else state = dropAt !== null && at - dropAt < 60000 ? "dropping" : "ok"
			gate.record(s)
		},
	}
}
const running = (p: WantedPlacement, admittedAtMs = 0): RunningPlacement => ({
	...p,
	admittedAtMs,
})
const expectDetail = (
	decision: ReturnType<ReturnType<typeof setup>["admit"]>,
	detail: string,
) => expect(decision).toMatchObject({ admit: false, detail })

describe("efficiency gate", () => {
	it("admits window A on desktop budget", () => {
		const gate = setup()
		const active: RunningPlacement[] = []
		let t = 0
		for (const type of ["ais-catcher", "dsd-fme", "multimon-ng"]) {
			const p = placement(type, placementCostCores(type, "channel"))
			expect(gate.admit(p, active, t)).toEqual({ admit: true })
			active.push(running(p))
			// One probationer per source: the next is admitted after graduation.
			t += 30_000
			gate.record(sample(t))
		}
		expect(gate.view(active, [], t).sources[0]?.coresInUse).toBeCloseTo(0.765)
	})
	it("blocks the four dsd-fme band-plan channels in window C+ with budget", () => {
		const gate = setup()
		const active = [
			running(placement("lora", 0.6, "s", "raw")),
			...["rtl433", "dsd-fme", "multimon-ng"].map(type =>
				running(placement(type, placementCostCores(type, "channel"))),
			),
		]
		for (let i = 0; i < 4; i++)
			expectDetail(gate.admit(placement(String(i), 0.155), active, 0), "budget")
	})
	it("Pi budget 0.75 in window C admits rtl433 and multimon-ng and blocks dsd-fme and LoRa", () => {
		const gate = setup(0.75)
		const active: RunningPlacement[] = []
		let t = 0
		for (const [type, reach] of [
			["rtl433", "channel"],
			["multimon-ng", "channel"],
			["dsd-fme", "channel"],
			["lora-meshtastic", "raw"],
		] as const) {
			const p = placement(type, placementCostCores(type, reach), "s", reach)
			const decision = gate.admit(p, active, t)
			if (type === "rtl433" || type === "multimon-ng") {
				expect(decision.admit).toBe(true)
				active.push(running(p))
				t += 30_000
				gate.record(sample(t))
			} else expectDetail(decision, "budget")
		}
	})
	it("budget exactly equal admits and 0.001 over blocks", () => {
		expect(setup(0.36).admit(placement(), [], 0).admit).toBe(true)
		expectDetail(setup(0.359).admit(placement(), [], 0), "budget")
	})
	it("cpu 90 admits and 90.1 blocks with cpu", () => {
		for (const cpu of [90, 90.1]) {
			const gate = setup()
			gate.record(sample(1, cpu))
			expect(gate.admit(placement(), [], 1)).toMatchObject(
				cpu === 90 ? { admit: true } : { admit: false, detail: "cpu" },
			)
		}
	})
	it("null cpu leaves the decision to budget and drops", () => {
		expect(setup().admit(placement(), [], 0).admit).toBe(true)
		expectDetail(setup(0).admit(placement(), [], 0), "budget")
	})
	it("drop 9.9 s ago blocks; 10.1 s ago still blocks until 60 s after the last drop; 60.1 s admits", () => {
		for (const age of [9900, 10100, 60100]) {
			const gate = setup()
			gate.record(sample(1, null, 1))
			for (let at = 2001; at < age + 1; at += 2000) gate.record(sample(at))
			gate.record(sample(age + 1))
			expect(gate.admit(placement(), [], age + 1)).toMatchObject(
				age < 60000 ? { admit: false, detail: "drops" } : { admit: true },
			)
		}
	})
	it("unreadable counter blocks with unknown", () => {
		const gate = setup()
		gate.record(sample(1, null, null))
		expectDetail(gate.admit(placement(), [], 1), "unknown")
	})
	it("NaN delta blocks with unknown", () => {
		const gate = setup()
		gate.record(sample(1, null, NaN))
		expectDetail(gate.admit(placement(), [], 1), "unknown")
	})
	it("no sample yet blocks with unknown", () => {
		expectDetail(
			createEfficiencyGate({ budgetCores: 1.5, cpuGuardPercent: 90 }).admit(
				placement(),
				[],
				0,
			),
			"unknown",
		)
	})
	it("probation drop suspends the newest probationer only", () => {
		const gate = setup()
		gate.record(sample(1))
		gate.view([running(placement("old"), 1)], [], 1)
		gate.record(sample(10, null, 1))
		expect(
			gate.probation(
				[running(placement("old"), 1), running(placement("new"), 2)],
				10,
			),
		).toEqual([{ key: "new", detail: "drops" }])
	})
	it("drop with no probationer suspends nothing", () => {
		const gate = setup()
		gate.view([running(placement())], [], 0)
		gate.record(sample(40000, null, 1))
		expect(gate.probation([running(placement())], 40000)).toEqual([])
	})
	it("probation failure doubles retry up to 30 min", () => {
		const gate = setup()
		const p = placement()
		gate.noteSuspended(p.key, "budget", 0)
		let now = 300000
		for (const delay of [600000, 1200000, 1800000, 1800000]) {
			for (let at = now - 62000; at < now; at += 2000) gate.record(sample(at))
			gate.record(sample(now))
			expect(gate.admit(p, [], now).admit).toBe(true)
			gate.record(sample(now + 1, null, 1))
			gate.probation([running(p, now)], now + 1)
			gate.noteSuspended(p.key, "drops", now + 1)
			expect(gate.admit(p, [], now + 2)).toEqual({
				admit: false,
				detail: "drops",
				retryAtMs: now + 1 + delay,
			})
			now += delay + 1
		}
	})
	it("channelizer base charged once per source", () => {
		const gate = setup(0.46)
		expect(gate.admit(placement("b"), [running(placement("a"))], 0).admit).toBe(
			true,
		)
		for (let at = 1; at <= 60001; at += 2000)
			gate.record({
				...sample(at),
				sources: new Map([
					["s", { droppedBytesDelta: 0, droppedChunksDelta: 0 }],
					["t", { droppedBytesDelta: 0, droppedChunksDelta: 0 }],
				]),
			})
		expectDetail(
			gate.admit(placement("b", 0.1, "t"), [running(placement("a"))], 60001),
			"budget",
		)
	})
	it("view reports drops unknown and cpu.percent null, never ok or 0", () => {
		const gate = setup()
		gate.record(sample(1, null, null))
		expect(gate.view([running(placement())], [], 1).sources[0]).toMatchObject({
			drops: "unknown",
			cpu: { percent: null },
			dropBytesPerSecond: null,
		})
	})
})

it("record ignores source samples and wall-clock ordering for drop admission", () => {
	const gate = createEfficiencyGate(
		{ budgetCores: 1.5, cpuGuardPercent: 90 },
		{
			drops: {
				dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
				sources: () => ["s"],
				monoNow: () => 0,
				droppedSinceMono: () => false,
				droppedWithinMs: () => false,
			},
		},
	)
	gate.record(sample(Number.MAX_SAFE_INTEGER, null, 100, NaN))
	gate.record(sample(0))
	expect(gate.admit(placement(), [], 0).admit).toBe(true)
})
it("missing and throwing readers fail closed for admission and never condemn a probationer", () => {
	for (const drops of [
		undefined,
		{
			dropState: () => {
				throw new TypeError("read")
			},
			sources: () => ["s"],
			monoNow: () => 0,
			droppedSinceMono: () => true,
			droppedWithinMs: () => {
				throw new TypeError("read")
			},
		},
	]) {
		const gate = createEfficiencyGate(
			{ budgetCores: 1.5, cpuGuardPercent: 90 },
			drops ? { drops } : {},
		)
		expectDetail(gate.admit(placement(), [], 0), "unknown")
		// Unknown evidence closes admission only; probation needs observed drops.
		expect(gate.probation([running(placement())], 0)).toEqual(
			drops ? [{ key: "p", detail: "drops" }] : [],
		)
	}
})

it("view prunes 1000 churned source ids and includes current reader membership", () => {
	let ids: string[] = []
	const gate = createEfficiencyGate(
		{ budgetCores: 1.5, cpuGuardPercent: 90 },
		{
			drops: {
				sources: () => ids,
				monoNow: () => 0,
				dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
				droppedSinceMono: () => false,
				droppedWithinMs: () => false,
			},
		},
	)
	for (let n = 0; n < 1000; n++) {
		ids = [String(n)]
		gate.admit(placement(String(n), 0.1, String(n)), [], 0)
		expect(gate.view([], [], 0).sources.map(s => s.sourceId)).toEqual(ids)
	}
	ids = []
	expect(gate.view([], [], 0).sources).toEqual([])
})

it("wall rollback still targets the tracked newcomer after legacy first observation", () => {
	const gate = setup()
	const legacy = running(placement("legacy"), 99000)
	const newcomer = placement("new")
	gate.record(sample(62000))
	gate.probation([legacy], 100000)
	gate.record(sample(64000))
	expect(gate.admit(newcomer, [legacy], 102000)).toEqual({ admit: true })
	gate.record(sample(64001, null, 1))
	expect(gate.probation([legacy, running(newcomer, 102000)], 50000)).toEqual([
		{ key: "new", detail: "drops" },
	])
})

it("wall forward jump preserves legacy active probation", () => {
	const gate = setup()
	const active = [running(placement("legacy"), 99000)]
	gate.record(sample(62000))
	gate.view(active, [], 100000)
	gate.record(sample(64000, null, 1))
	expect(gate.probation(active, 200000)).toEqual([
		{ key: "legacy", detail: "drops" },
	])
})

it("re-admitting a running legacy key preserves its expired first-observation mark", () => {
	const gate = setup()
	const p = placement("legacy")
	const active = [running(p, 99000)]
	gate.record(sample(62000))
	gate.admit(placement("other"), active, 100000)
	gate.record(sample(94000))
	expect(gate.admit(p, active, 200000)).toEqual({ admit: true })
	gate.record(sample(94001, null, 1))
	expect(gate.probation(active, 50000)).toEqual([])
})

it("preserves expired probation on re-admission and renews it after forget", () => {
	const gate = setup()
	const p = placement()
	gate.record(sample(62000))
	expect(gate.admit(p, [], 100000)).toEqual({ admit: true })
	const active = [running(p, 100000)]
	gate.record(sample(100000))
	expect(gate.admit(p, active, 138000)).toEqual({ admit: true })
	gate.record(sample(102000, null, 1))
	expect(gate.probation(active, 140000)).toEqual([])
	gate.forget(p.key)
	gate.record(sample(164000))
	expect(gate.admit(p, [], 202000)).toEqual({ admit: true })
	gate.record(sample(166000, null, 1))
	expect(gate.probation([running(p, 202000)], 204000)).toEqual([
		{ key: "p", detail: "drops" },
	])
})

it("treats invalid legacy wall timestamps as newest and on probation", () => {
	for (const [now, admittedAtMs] of [
		[NaN, 0],
		[100000, NaN],
		[Infinity, 0],
	]) {
		const gate = setup()
		gate.record(sample(62000, null, 1))
		expect(gate.probation([running(placement(), admittedAtMs)], now!)).toEqual([
			{ key: "p", detail: "drops" },
		])
	}
})

it("view with an empty running list keeps an expired legacy mark across removal and re-add", () => {
	const gate = setup()
	const legacy = running(placement("p"), 0)
	gate.record(sample(0))
	gate.probation([legacy], 0)
	gate.record(sample(40000))
	gate.view([], [], 40000)
	gate.record(sample(40001, null, 1))
	expect(gate.probation([legacy], 40001)).toEqual([])
})

it("admit and view with partial running lists never prune marks", () => {
	const gate = setup()
	const old = placement("old")
	const newer = placement("new")
	gate.record(sample(0))
	expect(gate.admit(old, [], 0)).toEqual({ admit: true })
	gate.record(sample(2000))
	expect(gate.admit(newer, [], 2000)).toEqual({ admit: true })
	gate.view([running(newer, 2000)], [], 2000)
	gate.record(sample(4000, null, 1))
	expect(gate.probation([running(old, 0), running(newer, 2000)], 4000)).toEqual(
		[{ key: "new", detail: "drops" }],
	)
})

it("waiting admissions retry after clean evidence without caching drop rejections", () => {
	let state: "ok" | "dropping" | "unknown" = "unknown"
	let cleanAt: number | null = null
	let mono = 0
	const gate = createEfficiencyGate(
		{ budgetCores: 1.5, cpuGuardPercent: 90 },
		{
			drops: {
				sources: () => ["s"],
				monoNow: () => mono,
				dropState: () => ({ state, dropBytesPerSecond: null }),
				droppedSinceMono: () => false,
				droppedWithinMs: () => false,
				cleanAtMono: () => cleanAt,
			},
		},
	)
	// No clean run yet: the earliest possible clear window from now.
	expect(gate.admit(placement(), [], 1000)).toEqual({
		admit: false,
		detail: "unknown",
		retryAtMs: 61_000,
	})
	cleanAt = 64_000
	for (const now of [2000, 30_000]) {
		mono = now
		expect(gate.admit(placement(), [], now)).toEqual({
			admit: false,
			detail: "unknown",
			retryAtMs: 64_000,
		})
	}
	mono = 63000
	// Never sooner than the next sample.
	expect(gate.admit(placement(), [], 63_000)).toMatchObject({
		retryAtMs: 65_000,
	})
	// No retry hold was recorded: the first read after the window admits.
	state = "ok"
	expect(gate.admit(placement(), [], 64_000)).toEqual({ admit: true })
	// A waiting candidate is distinct from a failed probationer.
	state = "dropping"
	expect(gate.admit(placement("q"), [], 70_000)).toEqual({
		admit: false,
		detail: "drops",
		retryAtMs: 72_000,
	})
	state = "ok"
	expect(gate.admit(placement("q"), [], 100_000).admit).toBe(true)
})

it("admits one gated probationer per source at a time", () => {
	const gate = setup()
	const first = placement("first")
	expect(gate.admit(first, [], 0)).toEqual({ admit: true })
	const active = [running(first)]
	// Another source is independent.
	expect(gate.admit(placement("other", 0.1, "t"), active, 0).admit).toBe(true)
	expect(gate.admit(placement("second"), active, 1000)).toEqual({
		admit: false,
		detail: "unknown",
		retryAtMs: 3000,
	})
	gate.record(sample(30_000))
	expect(gate.admit(placement("second"), active, 30_000)).toEqual({
		admit: true,
	})
})

it("resets retry escalation after a clean probation between isolated failures", () => {
	const gate = setup()
	const p = placement()
	for (let cycle = 0; cycle < 4; cycle++) {
		const now = cycle * 3600000 + 100000
		gate.record(sample(now))
		expect(gate.admit(p, [], now).admit).toBe(true)
		gate.record(sample(now + 30000))
		expect(gate.probation([running(p, now)], now + 30000)).toEqual([])
		// A later admission has its own probation and fails immediately.
		gate.probation([], now + 30000)
		gate.record(sample(now + 32000))
		expect(gate.admit(p, [], now + 32000).admit).toBe(true)
		gate.record(sample(now + 32001, null, 1))
		expect(gate.probation([running(p, now + 32000)], now + 32001)).toEqual([
			{ key: p.key, detail: "drops" },
		])
		gate.noteSuspended(p.key, "drops", now + 32001)
		expect(gate.admit(p, [], now + 32002)).toMatchObject({
			admit: false,
			retryAtMs: now + 32001 + 300000,
		})
	}
})

it("translates a monotonic clean deadline into a wall-clock retry", () => {
	const gate = createEfficiencyGate(
		{ budgetCores: 1, cpuGuardPercent: 90 },
		{
			drops: {
				sources: () => ["s"],
				monoNow: () => 1000,
				dropState: () => ({ state: "clearing", dropBytesPerSecond: 0 }),
				droppedSinceMono: () => false,
				droppedWithinMs: () => false,
				cleanAtMono: () => 61000,
			},
		},
	)
	expect(gate.admit(placement(), [], 1000000)).toMatchObject({
		retryAtMs: 1060000,
	})
})

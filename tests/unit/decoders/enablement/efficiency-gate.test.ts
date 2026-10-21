import { describe, expect, it } from "vitest"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import { placementCostCores } from "../../../../src/decoders/enablement/contract.js"
import type {
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
const setup = (budgetCores = 1.5) => {
	const gate = createEfficiencyGate({ budgetCores, cpuGuardPercent: 90 })
	gate.record(sample())
	return gate
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
		for (const type of ["ais-catcher", "dsd-fme", "multimon-ng"]) {
			const p = placement(type, placementCostCores(type, "channel"))
			expect(gate.admit(p, active, 0)).toEqual({ admit: true })
			active.push(running(p))
		}
		expect(gate.view(active, [], 0).sources[0]?.coresInUse).toBeCloseTo(0.765)
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
		for (const [type, reach] of [
			["rtl433", "channel"],
			["multimon-ng", "channel"],
			["dsd-fme", "channel"],
			["lora-meshtastic", "raw"],
		] as const) {
			const p = placement(type, placementCostCores(type, reach), "s", reach)
			const decision = gate.admit(p, active, 0)
			if (type === "rtl433" || type === "multimon-ng") {
				expect(decision.admit).toBe(true)
				active.push(running(p))
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
		gate.record(sample(40000, null, 1))
		expect(gate.probation([running(placement())], 40000)).toEqual([])
	})
	it("probation failure doubles retry up to 30 min", () => {
		const gate = setup()
		const p = placement()
		gate.noteSuspended(p.key, "budget", 0)
		let now = 300000
		for (const delay of [600000, 1200000, 1800000, 1800000]) {
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
		gate.record({
			...sample(1),
			sources: new Map([
				["s", { droppedBytesDelta: 0, droppedChunksDelta: 0 }],
				["t", { droppedBytesDelta: 0, droppedChunksDelta: 0 }],
			]),
		})
		expectDetail(
			gate.admit(placement("b", 0.1, "t"), [running(placement("a"))], 1),
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
	it.each([undefined, null, NaN, Infinity, -Infinity, -1, "0", {}, []])(
		"fails closed for malformed counters %j",
		value => {
			for (const field of ["droppedBytesDelta", "droppedChunksDelta"]) {
				const gate = setup()
				const observation = sample(1)
				const counters = {
					droppedBytesDelta: 0,
					droppedChunksDelta: 0,
					[field]: value,
				}
				gate.record({
					...observation,
					sources: new Map([["s", counters]]),
				} as unknown as EfficiencySample)
				expectDetail(gate.admit(placement(), [], 1), "unknown")
			}
		},
	)
	it.each([undefined, null, {}, { atMs: NaN }, { atMs: 1, sources: {} }])(
		"fails closed for malformed sample %j",
		value => {
			const gate = setup()
			gate.record(value as EfficiencySample)
			expectDetail(gate.admit(placement(), [], 1), "unknown")
		},
	)
	it("missing source and unknown source cannot establish drop-free status", () => {
		const gate = setup()
		gate.record({ ...sample(1), sources: new Map() })
		expectDetail(gate.admit(placement(), [], 1), "unknown")
		expectDetail(gate.admit(placement("t", 0.1, "absent"), [], 1), "unknown")
	})
	it.each([NaN, Infinity, -Infinity, -1])(
		"invalid cost and budget fail closed %j",
		value => {
			expectDetail(setup(value).admit(placement(), [], 0), "budget")
			expectDetail(setup().admit(placement("p", value), [], 0), "budget")
			expectDetail(
				setup().admit(placement(), [running(placement("bad", value))], 0),
				"budget",
			)
		},
	)
	it.each([NaN, Infinity, -Infinity])("non-finite CPU is null %j", value => {
		const gate = setup()
		gate.record(sample(1, value))
		expect(gate.admit(placement(), [], 1).admit).toBe(true)
		expect(gate.view([], [], 1).sources[0]?.cpu.percent).toBeNull()
	})
	it("retains CPU events since admission and ignores events before admission", () => {
		const gate = setup()
		gate.record(sample(1, 95))
		gate.record(sample(2, 10))
		expect(gate.probation([running(placement(), 0)], 2)).toEqual([
			{ key: "p", detail: "cpu" },
		])
		expect(gate.probation([running(placement(), 2)], 2)).toEqual([])
	})
	it("forget clears backoff and repeated fresh samples remain clean", () => {
		const gate = setup()
		gate.noteSuspended("p", "budget", 0)
		gate.forget("p")
		expect(gate.admit(placement(), [], 0).admit).toBe(true)
		gate.record(sample(0))
		expect(gate.admit(placement(), [], 0)).toEqual({ admit: true })
	})
})

it.each([undefined, null, {}, 0, "clean"])(
	"missing or malformed counter record blocks %j",
	counters => {
		const gate = setup()
		gate.record({
			...sample(1),
			sources: new Map([["s", counters]]),
		} as unknown as EfficiencySample)
		expectDetail(gate.admit(placement(), [], 1), "unknown")
	},
)
it.each([undefined, null, NaN, Infinity, -Infinity, -1, "1"])(
	"invalid timestamp cannot establish drop-free status %j",
	atMs => {
		const gate = setup()
		gate.record({ ...sample(), atMs } as EfficiencySample)
		expectDetail(gate.admit(placement(), [], 1), "unknown")
	},
)
it.each([undefined, null, "0", {}, NaN, Infinity, -1, 0])(
	"invalid channel rate fails closed %j",
	sampleRateHz => {
		const gate = setup()
		expectDetail(
			gate.admit({ ...placement(), sampleRateHz } as WantedPlacement, [], 0),
			"budget",
		)
	},
)
it.each([undefined, null, "0", {}])(
	"malformed costs and budgets fail closed %j",
	value => {
		const gate = createEfficiencyGate({
			budgetCores: value as number,
			cpuGuardPercent: 90,
		})
		gate.record(sample())
		expectDetail(gate.admit(placement(), [], 0), "budget")
		expectDetail(
			setup().admit(
				{ ...placement(), costCores: value } as WantedPlacement,
				[],
				0,
			),
			"budget",
		)
	},
)
it("unknown, drops, CPU and budget have fixed precedence", () => {
	const gate = setup(0)
	gate.record(sample(1, 95, null))
	expectDetail(gate.admit(placement("unknown"), [], 1), "unknown")
	gate.record(sample(2, 95, 1))
	expectDetail(gate.admit(placement("drops"), [], 2), "drops")
	gate.record(sample(60002, 95))
	expectDetail(gate.admit(placement("cpu"), [], 60002), "cpu")
})
it("probation returns at most one verdict per source and never selects a future admission", () => {
	const gate = setup()
	gate.record({ atMs: 10, cpuPercent: 95, sources: new Map() })
	expect(
		gate.probation(
			[
				running(placement("a"), 1),
				running(placement("b"), 2),
				running(placement("t", 0.1, "t"), 3),
				running(placement("future"), 11),
			],
			10,
		),
	).toEqual([
		{ key: "b", detail: "cpu" },
		{ key: "t", detail: "cpu" },
	])
})
it("view keeps admitted and blocked order and charges the base", () => {
	const gate = setup(0.5)
	const p = placement("decoder#100@s")
	const decision = gate.admit(placement("blocked", 1), [], 0)
	const view = gate.view(
		[running(p)],
		[{ placement: placement("blocked", 1), decision }],
		0,
	)
	expect(view.sources[0]).toMatchObject({
		coresInUse: 0.36,
		admitted: [{ decoderId: "decoder", channelHz: 100, probation: true }],
		blocked: [
			{
				decoderId: "blocked",
				detail: "budget",
				retryAt: new Date(300000).toISOString(),
			},
		],
	})
})

it.each([6000, 6001, 598000])("expires clean drops and CPU at age %i", age => {
	const gate = setup()
	gate.record(sample(2000, 95))
	const now = 2000 + age
	expect(gate.view([], [], now).sources[0]).toMatchObject({
		drops: age <= 6000 ? "ok" : "unknown",
		dropBytesPerSecond: age <= 6000 ? 0 : null,
		cpu: { percent: age <= 6000 ? 95 : null },
	})
	expectDetail(
		gate.admit(placement(), [], now),
		age <= 6000 ? "cpu" : "unknown",
	)
})

it("stale CPU follows the null CPU rule when drops are fresh", () => {
	const gate = setup()
	gate.record(sample(2000, 95))
	gate.record(sample(8001, null))
	expect(gate.admit(placement(), [], 8001)).toEqual({ admit: true })
	expect(gate.view([], [], 8001).sources[0]?.cpu.percent).toBeNull()
})

it.each([
	[1, null],
	[null, 1],
])(
	"retains positive evidence with incomplete counters %j / %j",
	(bytes, chunks) => {
		const gate = setup()
		gate.record(sample(10, null, bytes, chunks))
		expectDetail(gate.admit(placement(), [], 10), "unknown")
		expect(gate.probation([running(placement())], 10)).toEqual([
			{ key: "p", detail: "drops" },
		])
	},
)

it.each(["drops", "cpu"] as const)(
	"retains delayed, duplicate and future %s evidence",
	detail => {
		for (const at of [10, 20]) {
			const gate = setup()
			gate.record(sample(20, 10))
			gate.record(
				sample(at, detail === "cpu" ? 95 : 10, detail === "drops" ? 1 : 0),
			)
			expect(gate.probation([running(placement())], 20)).toEqual([
				{ key: "p", detail },
			])
			expectDetail(gate.admit(placement(), [], 20), detail)
		}
		const gate = setup()
		gate.record(
			sample(10, detail === "cpu" ? 95 : 10, detail === "drops" ? 1 : 0),
		)
		gate.record(
			sample(100000, detail === "cpu" ? 95 : 10, detail === "drops" ? 1 : 0),
		)
		expect(gate.probation([running(placement())], 20)).toEqual([
			{ key: "p", detail },
		])
		expectDetail(gate.admit(placement(), [], 20), "unknown")
		expect(gate.view([], [], 20).sources[0]).toMatchObject({
			drops: "unknown",
			dropBytesPerSecond: null,
			cpu: { percent: null },
		})
	},
)

it.each([NaN, Infinity, -Infinity, -1])(
	"fails closed for invalid clocks in every timed method %j",
	now => {
		const gate = setup()
		gate.record(sample(1, 95, 1))
		expectDetail(gate.admit(placement(), [], now), "unknown")
		expect(gate.probation([running(placement())], now)).toEqual([])
		expect(gate.view([], [], now).sources[0]).toMatchObject({
			drops: "unknown",
			dropBytesPerSecond: null,
			cpu: { percent: null },
		})
		gate.record(sample(now))
		expectDetail(gate.admit(placement("other"), [], 2), "unknown")
		for (const existing of [false, true]) {
			const retryGate = setup()
			if (existing) retryGate.noteSuspended("p", "budget", 0)
			retryGate.noteSuspended("p", "drops", now)
			retryGate.record(sample(600000))
			expect(retryGate.admit(placement(), [], 600000)).toEqual({
				admit: false,
				detail: "drops",
				retryAtMs: 900000,
			})
		}
	},
)

it.each(["drops", "cpu"] as const)(
	"retains newest %s evidence after delayed and future observations",
	detail => {
		for (const future of [false, true]) {
			const gate = setup()
			const event = (at: number) =>
				sample(at, detail === "cpu" ? 95 : 10, detail === "drops" ? 1 : 0)
			gate.record(event(100000))
			for (let at = 1; at <= 8; at++)
				gate.record(event(future ? 200000 + at : at))
			gate.record(sample(100001, detail === "cpu" ? 95 : 10))
			expectDetail(gate.admit(placement(), [], 100001), detail)
			expect(gate.probation([running(placement(), 99999)], 100001)).toEqual([
				{ key: "p", detail },
			])
			expect(gate.probation([running(placement(), 0)], 100001)).toEqual([])
		}
	},
)

it("future drop evidence blocks a fresh baseline and fails a probationer", () => {
	const gate = setup()
	gate.record(sample(Number.MAX_VALUE, 10, 1))
	gate.record(sample(100001, 10))
	expectDetail(gate.admit(placement(), [], 100001), "drops")
	expect(gate.view([], [], 100001).sources[0]?.drops).toBe("dropping")
	expect(gate.probation([running(placement(), 99999)], 100001)).toEqual([
		{ key: "p", detail: "drops" },
	])
})

it.each([false, true])(
	"recovers clean baselines after a far-future sample with prior drops %j",
	dropped => {
		const gate = setup()
		if (dropped) gate.record(sample(100000, 10, 1))
		gate.record(sample(Number.MAX_VALUE, 95))
		expectDetail(gate.admit(placement(), [], 100001), "unknown")
		gate.forget("p")
		gate.record(sample(100001, 10))
		expect(gate.view([], [], 100001).sources[0]).toMatchObject({
			cpu: { percent: 10 },
			dropBytesPerSecond: null,
		})
		expect(gate.admit(placement(), [], 100001)).toMatchObject(
			dropped ? { admit: false, detail: "drops" } : { admit: true },
		)
		gate.forget("p")
		gate.record(sample(160000, 10))
		expect(gate.admit(placement(), [], 160000)).toEqual({ admit: true })
	},
)

it("uses arrival order and each baseline's timestamp for freshness and rates", () => {
	const gate = setup()
	gate.record(sample(100000, 95))
	gate.record(sample(99999, 10))
	expect(gate.view([], [], 100000).sources[0]).toMatchObject({
		drops: "ok",
		dropBytesPerSecond: null,
		cpu: { percent: 10 },
	})
	gate.record(sample(1, 95))
	expectDetail(gate.admit(placement(), [], 100000), "unknown")
	expect(gate.view([], [], 100000).sources[0]?.cpu.percent).toBeNull()
	gate.forget("p")
	gate.record(sample(100001, 10))
	expect(gate.admit(placement(), [], 100001)).toEqual({ admit: true })
})

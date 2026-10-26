import { expect, it } from "vitest"
import { ConfigSchema } from "../../../../src/config.js"
import {
	CpuBudgetSchema,
	resolveCpuBudget,
} from "../../../../src/decoders/enablement/cpu-budget.js"

const auto = (cpuCount: number, cpuMax = "max 100000") =>
	resolveCpuBudget("auto", { cpuCount, readCpuMax: () => cpuMax })
it("uses half the CPU availability and the smaller fractional quota", () => {
	expect(auto(8)).toEqual({
		mode: "auto",
		cpus: 8,
		cores: 4,
		label: "auto (8 CPUs → 4 cores)",
	})
	expect(auto(8, "350000 100000")).toMatchObject({ cpus: 3.5, cores: 1.75 })
	expect(auto(4, "800000 100000")).toMatchObject({ cpus: 4, cores: 2 })
})
it.each([
	"",
	"max",
	"0 100",
	"100 0",
	"-1 100",
	"1.5 100",
	"1 2 extra",
	"9007199254740992 100",
	"words 100",
	"max 0",
])("ignores malformed quotas %s", quota => {
	expect(auto(8, quota).cores).toBe(4)
})
it("ignores unreadable quota and fails malformed CPU availability to the floor", () => {
	expect(
		resolveCpuBudget("auto", {
			cpuCount: 8,
			readCpuMax: () => {
				throw new TypeError("unreadable")
			},
		}).cores,
	).toBe(4)
	for (const count of [NaN, Infinity, 0, -1, 1.5])
		expect(auto(count).cores).toBe(0.75)
})
it("clamps at and past both auto bounds", () => {
	expect(auto(8, "150000 100000").cores).toBe(0.75)
	expect(auto(8, "149999 100000").cores).toBe(0.75)
	expect(auto(128).cores).toBe(64)
	expect(auto(129).cores).toBe(64)
})
it("preserves explicit numbers including below the auto floor and at the cap", () => {
	for (const cores of [0.001, 0.75, 3, 64]) {
		expect(
			resolveCpuBudget(cores, {
				cpuCount: 8,
				readCpuMax: () => {
					throw new TypeError("must not read")
				},
			}),
		).toEqual({ mode: "configured", cores, label: "configured" })
	}
	for (const invalid of [0, -1, 64.001, Infinity, NaN, "3", null, {}])
		expect(CpuBudgetSchema.safeParse(invalid).success).toBe(false)
})
it("accepts auto in configuration and defaults an empty efficiency policy to auto", () => {
	for (const value of ["auto", 0.001, 64]) {
		expect(
			ConfigSchema.parse({
				decoderPolicy: { efficiency: { cpuBudgetCores: value } },
			}).decoderPolicy?.efficiency?.cpuBudgetCores,
		).toBe(value)
	}
	expect(
		ConfigSchema.parse({ decoderPolicy: { efficiency: {} } }).decoderPolicy
			?.efficiency?.cpuBudgetCores,
	).toBe("auto")
	for (const value of [0, 64.001, "unknown"])
		expect(
			ConfigSchema.safeParse({
				decoderPolicy: { efficiency: { cpuBudgetCores: value } },
			}).success,
		).toBe(false)
})

it("fails malformed drop snapshots closed as unknown", async () => {
	const { createEfficiencyGate } =
		await import("../../../../src/decoders/enablement/efficiency-gate.js")
	const gate = createEfficiencyGate(
		{ budgetCores: 3, cpuGuardPercent: 90 },
		{
			drops: {
				monoNow: () => 0,
				sources: () => ["s"],
				dropState: () =>
					({ state: "unexpected", dropBytesPerSecond: 0 }) as unknown as {
						state: "ok"
						dropBytesPerSecond: number
					},
				droppedSinceMono: () => false,
				droppedWithinMs: () => false,
			},
		},
	)
	expect(
		gate.admit(
			{
				key: "p",
				decoderId: "p",
				sourceId: "s",
				reach: "raw",
				channelHz: null,
				costCores: 0.1,
				sampleRateHz: 1,
				origin: "band",
				primary: true,
			},
			[],
			0,
		),
	).toMatchObject({ admit: false, detail: "unknown" })
})

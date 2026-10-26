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
function cgroupFilesystem(
	procCgroup: string | undefined,
	files: Record<string, string>,
) {
	const reads: string[] = []
	const result = resolveCpuBudget("auto", {
		cpuCount: 8,
		readProcCgroup: () => {
			if (procCgroup === undefined) throw new TypeError("unreadable")
			return procCgroup
		},
		readCpuMax: path => {
			reads.push(path)
			const content = files[path]
			if (content === undefined) throw new TypeError("unreadable")
			return content
		},
	})
	return { result, reads }
}
it("uses a nested process quota lower than the mount root", () => {
	const { result, reads } = cgroupFilesystem(
		"4:memory:/other\n0::/system.slice/decoder.service\n",
		{
			"cpu.max": "600000 100000",
			"system.slice/cpu.max": "400000 100000",
			"system.slice/decoder.service/cpu.max": "200000 100000",
		},
	)
	expect(result).toMatchObject({ cpus: 2, cores: 1 })
	expect(reads).toEqual([
		"system.slice/decoder.service/cpu.max",
		"system.slice/cpu.max",
		"cpu.max",
	])
})
it.each([undefined, "max 100000", "invalid", "500000 100000"])(
	"inherits a tighter ancestor quota with leaf quota %s",
	leaf => {
		const { result } = cgroupFilesystem("0::/parent/leaf", {
			"cpu.max": "600000 100000",
			"parent/cpu.max": "250000 100000",
			...(leaf === undefined ? {} : { "parent/leaf/cpu.max": leaf }),
		})
		expect(result).toMatchObject({ cpus: 2.5, cores: 1.25 })
	},
)
it("keeps a leaf limit across unreadable and malformed ancestors", () => {
	const { result, reads } = cgroupFilesystem("0::/parent/missing/leaf", {
		"parent/missing/leaf/cpu.max": "200000 100000",
		"parent/cpu.max": "invalid",
		"cpu.max": "max 100000",
	})
	expect(result).toMatchObject({ cpus: 2, cores: 1 })
	expect(reads).toHaveLength(4)
})
it.each([
	undefined,
	"",
	"0:cpu:/parent/leaf",
	"0::relative/path",
	"0::/parent\n0::/other",
	"0::/parent/../outside",
	"0::/../outside",
	"0::/parent/./leaf",
	"0::/parent//leaf",
	"0::/parent\0/leaf",
])(
	"falls back to the root for unreadable or invalid process cgroups %s",
	proc => {
		const { result, reads } = cgroupFilesystem(proc, {
			"cpu.max": "200000 100000",
		})
		expect(result).toMatchObject({ cpus: 2, cores: 1 })
		expect(reads).toEqual(["cpu.max"])
	},
)
it("reads the root process cgroup exactly once", () => {
	const { result, reads } = cgroupFilesystem("0::/\n", {
		"cpu.max": "200000 100000",
	})
	expect(result).toMatchObject({ cpus: 2, cores: 1 })
	expect(reads).toEqual(["cpu.max"])
})
it("allows 31 components plus root and falls back past the 32-level bound", () => {
	for (const depth of [31, 32, 200]) {
		const path = Array.from({ length: depth }, (_, i) => `level${i}`).join("/")
		const { result, reads } = cgroupFilesystem(`0::/${path}`, {
			[`${path}/cpu.max`]: "200000 100000",
			"cpu.max": "600000 100000",
		})
		if (depth === 31) {
			expect(result).toMatchObject({ cpus: 2, cores: 1 })
			expect(reads).toHaveLength(32)
			expect(reads[0]).toBe(`${path}/cpu.max`)
			expect(reads[31]).toBe("cpu.max")
		} else {
			expect(result).toMatchObject({ cpus: 6, cores: 3 })
			expect(reads).toEqual(["cpu.max"])
		}
	}
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
				readProcCgroup: () => {
					throw new TypeError("must not read")
				},
				readCpuMax: () => {
					throw new TypeError("must not read")
				},
			}),
		).toEqual({ mode: "configured", cores, label: "configured" })
	}
	for (const invalid of [0, -1, 64.001, Infinity, NaN, "3", null, {}])
		expect(CpuBudgetSchema.safeParse(invalid).success).toBe(false)
})
it("accepts auto in configuration and preserves an omitted efficiency budget", () => {
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
	).toBeUndefined()
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

it.each([0.75, 0.74999, 0.5, 0.001])(
	"caps the auto floor at quota %s",
	quota => {
		expect(auto(8, `${Math.round(quota * 100000)} 100000`).cores).toBe(quota)
	},
)

it.each(["cpu,cpuacct", "cpu"])(
	"walks nested and inherited v1 quotas in %s",
	mount => {
		for (const leaf of ["200000", "-1", "invalid", "500000"]) {
			const { result } = cgroupFilesystem("5:cpu,cpuacct:/parent/leaf", {
				[`${mount}/parent/leaf/cpu.cfs_quota_us`]: leaf,
				[`${mount}/parent/leaf/cpu.cfs_period_us`]: "100000",
				[`${mount}/parent/cpu.cfs_quota_us`]: "250000",
				[`${mount}/parent/cpu.cfs_period_us`]: "100000",
			})
			expect(result).toMatchObject({
				cpus: leaf === "200000" ? 2 : 2.5,
				cores: leaf === "200000" ? 1 : 1.25,
			})
		}
	},
)
it("uses the tighter quota across hybrid controllers", () => {
	const { result } = cgroupFilesystem(
		"0::/unified/leaf\n5:cpu,cpuacct:/legacy/leaf",
		{
			"unified/cpu.max": "300000 100000",
			"cpu/legacy/cpu.cfs_quota_us": "100000",
			"cpu/legacy/cpu.cfs_period_us": "100000",
		},
	)
	expect(result).toMatchObject({ cpus: 1, cores: 0.75 })
})
it.each(["-1", "0", "bad", "1.5", "9007199254740992"])(
	"skips unlimited or malformed v1 quota %s",
	quota => {
		const { result } = cgroupFilesystem("5:cpu:/nested", {
			"cpu/nested/cpu.cfs_quota_us": quota,
			"cpu/nested/cpu.cfs_period_us": "100000",
		})
		expect(result).toMatchObject({ cpus: 8, cores: 4 })
	},
)
it.each(["0", "bad", "-1", "9007199254740992"])(
	"skips malformed v1 period %s",
	period => {
		const { result } = cgroupFilesystem("5:cpu:/nested", {
			"cpu/nested/cpu.cfs_quota_us": "100000",
			"cpu/nested/cpu.cfs_period_us": period,
		})
		expect(result).toMatchObject({ cpus: 8, cores: 4 })
	},
)

it("bounds v1 ancestry reads at and past 31 components", () => {
	for (const depth of [31, 32]) {
		const path = Array.from({ length: depth }, (_, i) => `level${i}`).join("/")
		const { result, reads } = cgroupFilesystem(`5:cpu:/${path}`, {
			[`cpu/${path}/cpu.cfs_quota_us`]: "100000",
			[`cpu/${path}/cpu.cfs_period_us`]: "100000",
			"cpu/cpu.cfs_quota_us": "200000",
			"cpu/cpu.cfs_period_us": "100000",
		})
		expect(result).toMatchObject({ cores: depth === 31 ? 0.75 : 1 })
		expect(
			reads.filter(path => path.endsWith("cpu.cfs_quota_us")),
		).toHaveLength(depth === 31 ? 64 : 2)
	}
})

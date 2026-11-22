import { describe, expect, it } from "vitest"
import {
	cpusetCount,
	hostCpuCount,
	resolveCpuCapacity,
} from "../../../../src/decoders/enablement/cpu-budget.js"
import { classifyCpuSample } from "../../../../src/decoders/enablement/own-cpu.js"

const quota = (cpuCount: number, cpuMax: string) =>
	resolveCpuCapacity({
		cpuCount,
		readProcCgroup: () => "0::/\n",
		readCpuMax: path => {
			if (path === "cpu.max") return cpuMax
			throw new TypeError("unreadable")
		},
	})

describe("CPU capacity under a fractional quota", () => {
	it("keeps a 1.5-CPU quota fractional", () => {
		expect(quota(8, "150000 100000")).toBe(1.5)
		expect(quota(2, "150000 100000")).toBe(1.5)
		expect(quota(1, "150000 100000")).toBe(1)
		expect(quota(8, "max 100000")).toBe(8)
	})

	it("counts the CPUs before the quota from the cpuset, not a quota-rounded count", () => {
		expect(
			hostCpuCount(
				() => "0-7\n",
				() => 1,
			),
		).toBe(8)
		expect(
			hostCpuCount(
				() => "0-1,4,6-7",
				() => 1,
			),
		).toBe(5)
		expect(
			hostCpuCount(
				() => {
					throw new TypeError("no cpuset")
				},
				() => 8,
			),
		).toBe(8)
		expect(
			hostCpuCount(
				() => "",
				() => 4,
			),
		).toBe(4)
		expect(
			hostCpuCount(
				() => "bogus",
				() => 4,
			),
		).toBe(4)
	})

	it("parses cpuset lists at and past their bounds", () => {
		expect(cpusetCount("0")).toBe(1)
		expect(cpusetCount("0-4095")).toBe(4096)
		expect(cpusetCount("0-4095,4096")).toBeNull()
		expect(cpusetCount("3-1")).toBeNull()
		expect(cpusetCount("0,,1")).toBeNull()
		expect(cpusetCount("12345")).toBeNull()
		expect(cpusetCount(" ")).toBeNull()
	})

	it("an own CPU under the guard share of a 1.5-CPU quota is calm, over it is own-over", () => {
		const capacity = quota(8, "150000 100000")
		// 1.30 / 1.5 = 86.7 % <= 90 %: no CPU evidence.
		expect(classifyCpuSample(null, 1.3, capacity, 90)).toMatchObject({
			label: "calm",
			ownOver: false,
		})
		// 1.35 / 1.5 = 90 % exactly: not over.
		expect(classifyCpuSample(null, 1.35, capacity, 90).ownOver).toBe(false)
		// 1.441 / 1.5 = 96.1 %: the container is at its quota.
		expect(classifyCpuSample(null, 1.441, capacity, 90)).toMatchObject({
			label: "own-over",
			ownOver: true,
		})
		// The defect: capacity read as 1 made 1.0 own cores look 100 % busy.
		expect(classifyCpuSample(null, 1.0, capacity, 90).ownOver).toBe(false)
		expect(classifyCpuSample(null, 1.0, 1, 90).ownOver).toBe(true)
	})
})

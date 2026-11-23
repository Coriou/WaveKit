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

	it("counts the CPUs before the quota from affinity and cpuset, not a quota-rounded count", () => {
		const none = () => {
			throw new TypeError("unreadable")
		}
		const status = (list: string) => () =>
			`Name:\tnode\nCpus_allowed:\tff\nCpus_allowed_list:\t${list}\n`
		// Affinity alone (e.g. taskset or a v1 cpuset), quota-rounded fallback ignored.
		expect(
			hostCpuCount({
				readStatus: status("0-1"),
				online: () => 8,
				fallback: () => 1,
			}),
		).toBe(2)
		// The own cgroup's v2 cpuset, read at the process's cgroup path.
		const reads: string[] = []
		expect(
			hostCpuCount({
				readStatus: none,
				readProcCgroup: () => "0::/app/core\n",
				readCgroupFile: path => {
					reads.push(path)
					return "0-1,4,6-7\n"
				},
				online: () => 8,
				fallback: () => 1,
			}),
		).toBe(5)
		expect(reads).toEqual(["app/core/cpuset.cpus.effective"])
		// A private namespace reads the root file.
		const rootReads: string[] = []
		hostCpuCount({
			readProcCgroup: () => "0::/\n",
			readCgroupFile: path => {
				rootReads.push(path)
				return "0-7"
			},
		})
		expect(rootReads).toEqual(["cpuset.cpus.effective"])
		// The smallest readable count wins.
		expect(
			hostCpuCount({
				readStatus: status("0-3"),
				readProcCgroup: () => "0::/\n",
				readCgroupFile: () => "0-1",
				online: () => 8,
			}),
		).toBe(2)
		// Nothing readable but the online count.
		expect(
			hostCpuCount({ readStatus: none, online: () => 8, fallback: () => 1 }),
		).toBe(8)
		// Unparseable lists are skipped.
		expect(
			hostCpuCount({
				readStatus: status("bogus"),
				online: () => 4,
				fallback: () => 1,
			}),
		).toBe(4)
		// An empty affinity line never reads the next line as its list.
		expect(
			hostCpuCount({
				readStatus: () => "Cpus_allowed_list:\n0-1\nMems_allowed_list:\t0\n",
				online: () => 8,
				fallback: () => 1,
			}),
		).toBe(8)
		// An unreadable cgroup file skips the cpuset, the other counts still apply.
		expect(
			hostCpuCount({
				readStatus: status("0-3"),
				readProcCgroup: () => "0::/app\n",
				readCgroupFile: none,
				online: () => 8,
				fallback: () => 1,
			}),
		).toBe(4)
		// An unreadable /proc/self/cgroup reads the cpuset at the mount root.
		const fallbackReads: string[] = []
		expect(
			hostCpuCount({
				readStatus: none,
				readProcCgroup: none,
				readCgroupFile: path => {
					fallbackReads.push(path)
					return "0-2"
				},
				online: () => 8,
				fallback: () => 1,
			}),
		).toBe(3)
		expect(fallbackReads).toEqual(["cpuset.cpus.effective"])
		// Both unreadable: the online count.
		expect(
			hostCpuCount({
				readStatus: none,
				readProcCgroup: none,
				readCgroupFile: none,
				online: () => 6,
				fallback: () => 1,
			}),
		).toBe(6)
		// Online 0 or NaN and nothing else: the fallback, never below 1.
		expect(hostCpuCount({ online: () => 0, fallback: () => 3 })).toBe(3)
		expect(hostCpuCount({ online: () => Number.NaN, fallback: () => 3 })).toBe(
			3,
		)
		expect(hostCpuCount({ online: () => 0, fallback: () => 0 })).toBe(1)
	})

	it("parses cpuset lists at and past their bounds", () => {
		expect(cpusetCount("0")).toBe(1)
		expect(cpusetCount("0-0")).toBe(1)
		expect(cpusetCount("0-3,")).toBeNull()
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

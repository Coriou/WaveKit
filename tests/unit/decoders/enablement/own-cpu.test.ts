import { describe, expect, it } from "vitest"
import {
	classifyCpuSample,
	OWN_CPU_MAX_GAP_MS,
	OwnCpuMeter,
	privateCgroupNamespace,
} from "../../../../src/decoders/enablement/own-cpu.js"

/** Injected readers only: no real /proc or /sys read in these tests. */
function meter(
	opts: {
		cgroup?: string | null
		stats?: (string | null | Error)[]
		capacity?: number | (() => number)
	} = {},
) {
	const stats = [...(opts.stats ?? [])]
	const reads: string[] = []
	const m = new OwnCpuMeter({
		readProcCgroup: () => (opts.cgroup === undefined ? "0::/\n" : opts.cgroup),
		readCgroup: file => {
			reads.push(file)
			const next = stats.shift()
			if (next instanceof Error) throw next
			return next ?? null
		},
		capacity:
			typeof opts.capacity === "function"
				? opts.capacity
				: () => (opts.capacity as number | undefined) ?? 4,
	})
	return { m, reads }
}
const stat = (usec: number) =>
	`usage_usec ${usec}\nuser_usec 1\nsystem_usec 1\n`

describe("privateCgroupNamespace", () => {
	it("is true only for the one line 0::/", () => {
		expect(privateCgroupNamespace("0::/\n")).toBe(true)
		expect(privateCgroupNamespace("0::/")).toBe(true)
		expect(privateCgroupNamespace("0::/init.scope\n")).toBe(false)
		expect(privateCgroupNamespace("0::/s6/../\n")).toBe(false)
		expect(privateCgroupNamespace("0::/../x\n")).toBe(false)
		expect(
			privateCgroupNamespace(
				"0::/user.slice/user-1000.slice/session-1.scope\n",
			),
		).toBe(false)
		// cgroup v1 (or hybrid) lines: no own reading.
		expect(privateCgroupNamespace("12:cpu,cpuacct:/\n0::/\n")).toBe(false)
		expect(privateCgroupNamespace("4:cpu:/docker/abc\n")).toBe(false)
		expect(privateCgroupNamespace("")).toBe(false)
		expect(privateCgroupNamespace(null)).toBe(false)
	})
})

describe("OwnCpuMeter", () => {
	it("outside a private namespace is unavailable and never reads cpu.stat", () => {
		for (const cgroup of ["0::/init.scope\n", null, "1:cpu:/\n"]) {
			const { m, reads } = meter({ cgroup, stats: [stat(0), stat(1e6)] })
			expect(m.sample(0)).toEqual({
				ownCores: null,
				capacityCores: 4,
				available: false,
			})
			expect(m.sample(2000)).toMatchObject({ ownCores: null, available: false })
			expect(reads).toEqual([])
		}
	})
	it("a /proc/self/cgroup read that throws is unavailable", () => {
		const m = new OwnCpuMeter({
			readProcCgroup: () => {
				throw new Error("EACCES")
			},
			readCgroup: () => stat(0),
			capacity: () => 2,
		})
		expect(m.sample(0)).toMatchObject({ available: false, ownCores: null })
	})
	it("the first reading is null; then cores = Δusage_usec / Δt", () => {
		const { m } = meter({ stats: [stat(1_000_000), stat(4_000_000)] })
		expect(m.sample(10_000)).toEqual({
			ownCores: null,
			capacityCores: 4,
			available: true,
		})
		// 3 000 000 µs over 2000 ms = 1.5 cores.
		expect(m.sample(12_000).ownCores).toBeCloseTo(1.5, 12)
	})
	it("Δt ≤ 0 is null and rebases", () => {
		const { m } = meter({
			stats: [stat(0), stat(1000), stat(5000), stat(9000)],
		})
		m.sample(2000)
		expect(m.sample(2000).ownCores).toBeNull()
		expect(m.sample(1000).ownCores).toBeNull()
		// Rebased at 1000 ms on 5000 µs: 4000 µs over 2000 ms.
		expect(m.sample(3000).ownCores).toBeCloseTo(0.002, 12)
	})
	it("a counter decrease (reset) is null for that interval, then resumes", () => {
		const { m } = meter({
			stats: [stat(9_000_000), stat(100), stat(2_000_100)],
		})
		m.sample(0)
		expect(m.sample(2000).ownCores).toBeNull()
		expect(m.sample(4000).ownCores).toBeCloseTo(1, 12)
	})
	it("a missing, malformed or throwing cpu.stat is null and keeps the last good base", () => {
		const { m } = meter({
			stats: [stat(0), null, "garbage", new Error("EIO"), stat(2_000_000)],
		})
		m.sample(0)
		expect(m.sample(1000).ownCores).toBeNull()
		expect(m.sample(2000).ownCores).toBeNull()
		expect(m.sample(3000).ownCores).toBeNull()
		// 4000 ms after the last good base (the bound): spans it.
		expect(m.sample(4000).ownCores).toBeCloseTo(0.5, 12)
	})
	it("a gap past two samples is null; at the bound it is read", () => {
		expect(OWN_CPU_MAX_GAP_MS).toBe(4000)
		const at = meter({ stats: [stat(0), stat(4_000_000)] })
		at.m.sample(0)
		expect(at.m.sample(4000).ownCores).toBeCloseTo(1, 12)
		const past = meter({ stats: [stat(0), stat(4_000_000), stat(6_000_000)] })
		past.m.sample(0)
		expect(past.m.sample(4000.001).ownCores).toBeNull()
		// The late reading becomes the new base.
		expect(past.m.sample(6000.001).ownCores).toBeCloseTo(1, 9)
	})
	it("a non-finite time is null", () => {
		const { m } = meter({ stats: [stat(0), stat(1)] })
		expect(m.sample(Number.NaN).ownCores).toBeNull()
		expect(m.sample(Number.POSITIVE_INFINITY).ownCores).toBeNull()
	})
	it("capacity is read once; a bad or throwing capacity is null", () => {
		let calls = 0
		const once = meter({
			capacity: () => {
				calls++
				return 2
			},
			stats: [stat(0), stat(1)],
		})
		once.m.sample(0)
		once.m.sample(2000)
		expect(calls).toBe(1)
		for (const capacity of [
			0,
			-1,
			Number.NaN,
			() => Number.POSITIVE_INFINITY,
		]) {
			const { m } = meter({ capacity, stats: [stat(0)] })
			expect(m.sample(0).capacityCores).toBeNull()
		}
		const throwing = meter({
			capacity: () => {
				throw new Error("x")
			},
			stats: [stat(0)],
		})
		expect(throwing.m.sample(0).capacityCores).toBeNull()
	})
})

describe("classifyCpuSample (rows C1-C5)", () => {
	const G = 90
	it("C1: own over the guard share of capacity is own-over, host pushed only over G", () => {
		expect(classifyCpuSample(95, 3.7, 4, G)).toMatchObject({
			label: "own-over",
			ownOver: true,
			hostCpu: true,
		})
		expect(classifyCpuSample(10, 3.7, 4, G)).toMatchObject({
			label: "own-over",
			ownOver: true,
			hostCpu: false,
		})
		expect(classifyCpuSample(null, 3.7, 4, G)).toMatchObject({
			label: "own-over",
			hostCpu: false,
		})
	})
	it("C2: host over G with own within is host-busy", () => {
		const c = classifyCpuSample(100, 0.8, 4, G)
		expect(c).toMatchObject({
			label: "host-busy",
			ownOver: false,
			hostCpu: true,
		})
		expect(c.ownPercent).toBeCloseTo(20, 9)
	})
	it("C3: host within or null with own within is calm", () => {
		for (const h of [90, 0, null])
			expect(classifyCpuSample(h, 0.8, 4, G)).toMatchObject({
				label: "calm",
				ownOver: false,
				hostCpu: false,
			})
	})
	it("C4/C5: own or capacity unknown is host-busy-unattributed or unknown, never own-over", () => {
		for (const [o, c] of [
			[null, 4],
			[3.9, null],
			[Number.NaN, 4],
			[-0.1, 4],
			[3.9, 0],
			[3.9, -4],
			[3.9, Number.NaN],
			[Number.POSITIVE_INFINITY, 4],
			[undefined, 4],
		] as const) {
			expect(classifyCpuSample(99, o, c, G)).toMatchObject({
				label: "host-busy-unattributed",
				ownOver: false,
				hostCpu: true,
				ownPercent: null,
			})
			expect(classifyCpuSample(50, o, c, G)).toMatchObject({
				label: "unknown",
				ownOver: false,
				hostCpu: false,
			})
		}
	})
	it("bounds: O/C = G is not over, G + ε is; H = G is not busy, G + ε is", () => {
		expect(classifyCpuSample(null, 3.6, 4, G).ownOver).toBe(false)
		expect(classifyCpuSample(null, 3.6 + 1e-9, 4, G).ownOver).toBe(true)
		expect(classifyCpuSample(90, 0, 4, G).hostCpu).toBe(false)
		expect(classifyCpuSample(90 + 1e-9, 0, 4, G).hostCpu).toBe(true)
	})
	it("NaN or negative host and an invalid guard are not busy", () => {
		for (const h of [Number.NaN, -1, Number.NEGATIVE_INFINITY])
			expect(classifyCpuSample(h, 0.5, 4, G).hostCpu).toBe(false)
		for (const g of [Number.NaN, -1])
			expect(classifyCpuSample(100, 4, 4, g)).toMatchObject({
				label: "unknown",
				ownOver: false,
				hostCpu: false,
			})
	})
})

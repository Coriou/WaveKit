import { describe, expect, it, vi } from "vitest"
import { CpuMeter } from "../../../../src/core/scanner/cpu-meter.js"
import type { CpuReaders } from "../../../../src/core/scanner/cpu-meter.js"

const cpu = (busy: number, idle: number) => ({
	times: { user: busy, nice: 0, sys: 0, idle, irq: 0 },
})

function fakeReaders(state: {
	cpus: ReturnType<typeof cpu>[]
	stat: string | null
	max: string | null
	now: number
}): CpuReaders {
	return {
		cpus: () => state.cpus,
		readCgroup: file => (file === "cpu.stat" ? state.stat : state.max),
		now: () => state.now,
	}
}

describe("CpuMeter", () => {
	it("normalises os.cpus() deltas across all cores", () => {
		const state = {
			cpus: [
				cpu(1_000, 9_000),
				cpu(1_000, 9_000),
				cpu(1_000, 9_000),
				cpu(1_000, 9_000),
			],
			stat: null,
			max: null,
			now: 0,
		}
		const meter = new CpuMeter({ sampleMs: 5_000, readers: fakeReaders(state) })
		expect(meter.mode).toBe("os")
		meter.sample()
		expect(meter.normalisedPercent).toBeNull()
		// one core fully busy, three idle, over the interval → 25 %
		state.cpus = [
			cpu(6_000, 9_000),
			cpu(1_000, 14_000),
			cpu(1_000, 14_000),
			cpu(1_000, 14_000),
		]
		meter.sample()
		expect(meter.normalisedPercent).toBeCloseTo(25)
	})

	it("reports null without a CPU list", () => {
		const meter = new CpuMeter({
			sampleMs: 5_000,
			source: "os",
			readers: fakeReaders({ cpus: [], stat: null, max: null, now: 0 }),
		})
		meter.sample()
		meter.sample()
		expect(meter.normalisedPercent).toBeNull()
	})

	it("uses cgroup usage over the quota inside a limited container", () => {
		const state = {
			cpus: [cpu(0, 0), cpu(0, 0), cpu(0, 0), cpu(0, 0)],
			stat: "usage_usec 1000000\nuser_usec 800000\n",
			max: "200000 100000\n",
			now: 10_000,
		}
		const meter = new CpuMeter({ sampleMs: 5_000, readers: fakeReaders(state) })
		expect(meter.mode).toBe("cgroup")
		meter.sample()
		state.stat = "usage_usec 2000000\nuser_usec 1600000\n"
		state.now = 11_000
		meter.sample()
		// 1 s of CPU in 1 s of wall time on a 2-core quota → 50 %
		expect(meter.normalisedPercent).toBeCloseTo(50)
	})

	it("falls back to the CPU count without a quota and to null when cpu.stat is unreadable", () => {
		const state = {
			cpus: [cpu(0, 0), cpu(0, 0), cpu(0, 0), cpu(0, 0)],
			stat: "usage_usec 0\n" as string | null,
			max: "max 100000\n",
			now: 0,
		}
		const auto = new CpuMeter({ sampleMs: 5_000, readers: fakeReaders(state) })
		expect(auto.mode).toBe("os")
		const forced = new CpuMeter({
			sampleMs: 5_000,
			source: "cgroup",
			readers: fakeReaders(state),
		})
		forced.sample()
		state.stat = "usage_usec 2000000\n"
		state.now = 1_000
		forced.sample()
		expect(forced.normalisedPercent).toBeCloseTo(50) // 2 core-seconds over 1 s on 4 CPUs
		state.stat = null
		forced.sample()
		expect(forced.normalisedPercent).toBeNull()
	})

	it("clamps to 100 % and samples on an interval between start and stop", () => {
		vi.useFakeTimers()
		try {
			const state = {
				cpus: [cpu(0, 0)],
				stat: "usage_usec 0\n" as string | null,
				max: "100000 100000\n",
				now: 0,
			}
			const meter = new CpuMeter({
				sampleMs: 5_000,
				readers: fakeReaders(state),
			})
			meter.start()
			state.stat = "usage_usec 9000000\n"
			state.now = 5_000
			vi.advanceTimersByTime(5_000)
			expect(meter.normalisedPercent).toBe(100)
			meter.stop()
			state.stat = "usage_usec 9000000\n"
			state.now = 10_000
			vi.advanceTimersByTime(5_000)
			expect(meter.normalisedPercent).toBe(100)
		} finally {
			vi.useRealTimers()
		}
	})
})

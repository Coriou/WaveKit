import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ContainerMonitor } from "../../../src/core/container-monitor.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const T0 = 1_000_000

describe("ContainerMonitor", () => {
	let root: string

	/** A cgroup directory; `nonRoot` adds the file the kernel leaves off the root cgroup. */
	const cgroup = (options: { nonRoot: boolean }): void => {
		mkdirSync(root, { recursive: true })
		writeFileSync(join(root, "cgroup.controllers"), "cpu memory\n")
		if (options.nonRoot) writeFileSync(join(root, "cgroup.type"), "domain\n")
	}
	const usage = (usec: number): void => {
		writeFileSync(join(root, "cpu.stat"), `usage_usec ${usec}\n`)
	}

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "wk-cgroup-"))
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})

	afterEach(() => {
		vi.useRealTimers()
		rmSync(root, { recursive: true, force: true })
	})

	it("reads a non-root cgroup v2 as a container", () => {
		cgroup({ nonRoot: true })
		usage(1_000)
		const monitor = new ContainerMonitor(logger, { cgroupRoot: root })
		expect(monitor.isMonitoringAvailable()).toBe(true)
		expect(monitor.getSnapshot()).toMatchObject({
			available: true,
			cgroupVersion: "v2",
		})
	})

	it("reads the root cgroup v2 as no container: its cpu.stat is the whole machine", () => {
		cgroup({ nonRoot: false })
		usage(9_000_000)
		const monitor = new ContainerMonitor(logger, { cgroupRoot: root })
		expect(monitor.isMonitoringAvailable()).toBe(false)
		monitor.getSnapshot()
		vi.setSystemTime(T0 + 2_000)
		usage(18_000_000)
		expect(monitor.getSnapshot()).toMatchObject({
			available: false,
			cpuUsagePercent: null,
			cgroupVersion: "v2",
		})
	})

	it("shares one reading per poll interval, so another reader takes no CPU window", () => {
		cgroup({ nonRoot: true })
		usage(1_000_000)
		const monitor = new ContainerMonitor(logger, {
			cgroupRoot: root,
			pollIntervalMs: 2_000,
		})
		expect(monitor.getSnapshot().cpuUsagePercent).toBeNull()

		vi.setSystemTime(T0 + 2_000)
		usage(2_000_000)
		expect(monitor.getSnapshot().cpuUsagePercent).toBe(50)

		// A second reader just after: the first's reading, not a 1 ms window over a busy counter.
		vi.setSystemTime(T0 + 2_001)
		usage(2_500_000)
		expect(monitor.getSnapshot().cpuUsagePercent).toBe(50)

		// The next reading covers the whole window since the last real one.
		vi.setSystemTime(T0 + 4_000)
		usage(4_000_000)
		expect(monitor.getSnapshot().cpuUsagePercent).toBe(100)
	})

	it("reads again when the clock moves backwards", () => {
		cgroup({ nonRoot: true })
		usage(1_000_000)
		const monitor = new ContainerMonitor(logger, { cgroupRoot: root })
		const first = monitor.getSnapshot()
		vi.setSystemTime(T0 - 5_000)
		expect(monitor.getSnapshot()).not.toBe(first)
	})
})

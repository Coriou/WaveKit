import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ContainerMonitor } from "../../../src/core/container-monitor.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const T0 = 1_000_000

describe("ContainerMonitor", () => {
	let base: string
	let root: string
	let selfCgroupFile: string

	/** A monitor reading the temp mount root, with this process in the given v2 path. */
	const monitorAt = (
		path: string,
		options: { pollIntervalMs?: number; emitSnapshots?: boolean } = {},
	): ContainerMonitor => {
		writeFileSync(selfCgroupFile, `0::${path}\n`)
		return new ContainerMonitor(logger, {
			cgroupRoot: root,
			selfCgroupFile,
			...options,
		})
	}
	/** A cgroup below the mount root, as the host's full tree shows it. */
	const nested = (path: string, usec: number): void => {
		const dir = join(root, path)
		mkdirSync(dir, { recursive: true })
		writeFileSync(join(dir, "cpu.stat"), `usage_usec ${usec}\n`)
		writeFileSync(join(dir, "memory.current"), "4096\n")
	}

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
		base = mkdtempSync(join(tmpdir(), "wk-cgroup-"))
		root = join(base, "root")
		selfCgroupFile = join(base, "self-cgroup")
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})

	afterEach(() => {
		vi.useRealTimers()
		rmSync(base, { recursive: true, force: true })
	})

	it("reads a private-namespace container's cgroup at the mount root", () => {
		cgroup({ nonRoot: true })
		usage(1_000)
		const monitor = monitorAt("/")
		expect(monitor.isMonitoringAvailable()).toBe(true)
		expect(monitor.getSnapshot()).toMatchObject({
			available: true,
			cgroupVersion: "v2",
		})
	})

	it("reads the whole private-namespace container from a process in a child cgroup", () => {
		cgroup({ nonRoot: true })
		usage(1_000_000)
		nested("init.scope", 5)
		const monitor = monitorAt("/init.scope")
		monitor.getSnapshot()
		vi.setSystemTime(T0 + 2_000)
		usage(2_000_000)
		expect(monitor.getSnapshot().cpuUsagePercent).toBe(50)
	})

	it("keeps a private-namespace container available when /proc/self/cgroup is unreadable", () => {
		cgroup({ nonRoot: true })
		usage(1_000)
		const monitor = new ContainerMonitor(logger, {
			cgroupRoot: root,
			selfCgroupFile: join(base, "missing"),
		})
		expect(monitor.isMonitoringAvailable()).toBe(true)
	})

	it("reads the process's own cgroup under a host cgroup namespace, not the host's root", () => {
		cgroup({ nonRoot: false })
		usage(90_000_000)
		nested("system.slice/wavekit.scope", 1_000_000)
		const monitor = monitorAt("/system.slice/wavekit.scope")
		expect(monitor.isMonitoringAvailable()).toBe(true)
		expect(monitor.getSnapshot()).toMatchObject({
			available: true,
			cgroupVersion: "v2",
			memoryUsageBytes: 4096,
		})
		vi.setSystemTime(T0 + 2_000)
		nested("system.slice/wavekit.scope", 2_000_000)
		usage(180_000_000)
		expect(monitor.getSnapshot().cpuUsagePercent).toBe(50)
	})

	it("starts its CPU window from the process's own cgroup", () => {
		cgroup({ nonRoot: false })
		usage(90_000_000)
		nested("system.slice/wavekit.scope", 1_000_000)
		const monitor = monitorAt("/system.slice/wavekit.scope", {
			emitSnapshots: false,
		})
		monitor.start()
		vi.setSystemTime(T0 + 2_000)
		nested("system.slice/wavekit.scope", 2_000_000)
		expect(monitor.getSnapshot().cpuUsagePercent).toBe(50)
		monitor.stop()
	})

	it("reads a process in the host's root cgroup as unavailable: its cpu.stat is the whole machine", () => {
		cgroup({ nonRoot: false })
		usage(9_000_000)
		const monitor = monitorAt("/")
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

	it("reads an unreadable /proc/self/cgroup or one with no v2 line as unavailable at the host root", () => {
		cgroup({ nonRoot: false })
		usage(9_000_000)
		expect(
			new ContainerMonitor(logger, {
				cgroupRoot: root,
				selfCgroupFile: join(base, "missing"),
			}).isMonitoringAvailable(),
		).toBe(false)
		writeFileSync(selfCgroupFile, "1:name=systemd:/x\n")
		expect(
			new ContainerMonitor(logger, {
				cgroupRoot: root,
				selfCgroupFile,
			}).isMonitoringAvailable(),
		).toBe(false)
	})

	it.each([
		["a parent escape", "/../outside"],
		["an inner parent step", "/system.slice/../../outside"],
		["a relative path", "outside"],
		["an empty path", ""],
		["a doubled slash", "//outside"],
		["a trailing slash", "/outside/"],
		["a current-directory step", "/./outside"],
	])("reads %s as unavailable", (_name, path) => {
		cgroup({ nonRoot: false })
		usage(9_000_000)
		nested("outside", 1_000)
		expect(monitorAt(path).isMonitoringAvailable()).toBe(false)
	})

	it("reads a parent escape as unavailable in a private namespace too", () => {
		cgroup({ nonRoot: true })
		usage(1_000)
		expect(monitorAt("/../outside").isMonitoringAvailable()).toBe(false)
	})

	it("refuses a cgroup that resolves outside the mount root, or does not exist", () => {
		cgroup({ nonRoot: false })
		usage(9_000_000)
		const outside = join(base, "outside")
		mkdirSync(outside)
		writeFileSync(join(outside, "cpu.stat"), "usage_usec 1\n")
		symlinkSync(outside, join(root, "link"))
		expect(monitorAt("/link").isMonitoringAvailable()).toBe(false)
		expect(monitorAt("/gone (deleted)").isMonitoringAvailable()).toBe(false)
	})

	it("shares one reading per poll interval, so another reader takes no CPU window", () => {
		cgroup({ nonRoot: true })
		usage(1_000_000)
		const monitor = monitorAt("/", { pollIntervalMs: 2_000 })
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
		const monitor = monitorAt("/")
		const first = monitor.getSnapshot()
		vi.setSystemTime(T0 - 5_000)
		expect(monitor.getSnapshot()).not.toBe(first)
	})
})

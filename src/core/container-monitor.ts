/**
 * Container Monitor - Reads container resource metrics from cgroups
 *
 * Supports both cgroups v2 (unified hierarchy) and v1 (legacy).
 * Provides CPU usage, memory usage, and OOM kill counts.
 *
 * Detection:
 * - cgroups v2: /sys/fs/cgroup/cgroup.controllers exists. The mount root has cgroup.type, which the
 *   kernel leaves off the root cgroup, in a container with a private cgroup namespace: the mount
 *   root is then the container's own cgroup. Without it the mount root is the host's root, whose
 *   cpu.stat is the whole machine, so the counters come from the process's own cgroup named by
 *   /proc/self/cgroup: the container under --cgroupns=host, the process's service or session on
 *   native Linux. A process in the root itself, or a path that is odd, reads as unavailable.
 * - cgroups v1: /sys/fs/cgroup/memory/ and /sys/fs/cgroup/cpu/ exist. The files cannot tell a
 *   container from a host, so a v1 host outside a container reports the whole machine.
 *
 * Falls back gracefully when running outside containers or on unsupported systems.
 */

import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import type { ContainerResources } from "@wavekit/api-types"

// ============================================================================
// Constants
// ============================================================================

const CGROUP_V2_ROOT = "/sys/fs/cgroup"
const SELF_CGROUP_FILE = "/proc/self/cgroup"

// cgroups v1 paths
const CGROUP_V1_CPUACCT = "/sys/fs/cgroup/cpuacct"
const CGROUP_V1_CPU = "/sys/fs/cgroup/cpu"
const CGROUP_V1_MEMORY = "/sys/fs/cgroup/memory"

// ============================================================================
// Types
// ============================================================================

export interface ContainerMonitorEvents {
	snapshot: (resources: ContainerResources) => void
	error: (error: Error) => void
}

export interface ContainerMonitorOptions {
	/** Poll interval in milliseconds (default: 2000) */
	pollIntervalMs?: number

	/** Enable emitting snapshots on interval (default: true) */
	emitSnapshots?: boolean

	/** Custom cgroup root for testing (default: /sys/fs/cgroup) */
	cgroupRoot?: string

	/** Custom /proc/self/cgroup for testing */
	selfCgroupFile?: string
}

/** An absolute cgroup path with no `..`, `.` or empty component ("/" is the root itself). */
function isPlainCgroupPath(path: string): boolean {
	if (path === "/") return true
	if (!path.startsWith("/") || path.includes("\0")) return false
	return path
		.slice(1)
		.split("/")
		.every(part => part !== "" && part !== "." && part !== "..")
}

// ============================================================================
// ContainerMonitor
// ============================================================================

export class ContainerMonitor extends EventEmitter {
	private readonly log: Logger
	private readonly pollIntervalMs: number
	private readonly emitSnapshots: boolean
	private readonly cgroupRoot: string
	private readonly selfCgroupFile: string
	/** The directory holding this process's v2 counters. */
	private cgroupV2Dir: string

	private pollTimer: ReturnType<typeof setInterval> | null = null
	private cgroupVersion: "v1" | "v2" | "unknown" = "unknown"
	private lastCpuUsage: bigint = 0n
	private lastCpuTime: number = 0
	private isAvailable: boolean = false
	/** The last read of the files; readers inside one poll interval share it. */
	private lastRead: { at: number; snapshot: ContainerResources } | null = null

	constructor(logger: Logger, options: ContainerMonitorOptions = {}) {
		super()
		this.log = createComponentLogger(logger, "ContainerMonitor")
		this.pollIntervalMs = options.pollIntervalMs ?? 2000
		this.emitSnapshots = options.emitSnapshots ?? true
		this.cgroupRoot = options.cgroupRoot ?? CGROUP_V2_ROOT
		this.selfCgroupFile = options.selfCgroupFile ?? SELF_CGROUP_FILE
		this.cgroupV2Dir = this.cgroupRoot

		// Detect cgroup version on construction
		this.detectCgroupVersion()
	}

	// ============================================================================
	// Public API
	// ============================================================================

	/**
	 * Starts periodic polling of container resources.
	 */
	start(): void {
		if (this.pollTimer) {
			this.log.warn("ContainerMonitor already started")
			return
		}

		this.log.info(
			{ cgroupVersion: this.cgroupVersion, available: this.isAvailable },
			"Starting container resource monitoring",
		)

		// Take initial reading for CPU delta calculation
		if (this.isAvailable) {
			this.initializeCpuReading()
		}

		if (this.emitSnapshots) {
			this.pollTimer = setInterval(() => {
				try {
					const snapshot = this.getSnapshot()
					this.emit("snapshot", snapshot)
				} catch (error) {
					this.log.error({ error }, "Failed to get container resource snapshot")
					this.emit("error", error as Error)
				}
			}, this.pollIntervalMs)
		}
	}

	/**
	 * Stops periodic polling.
	 */
	stop(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer)
			this.pollTimer = null
			this.log.info("Stopped container resource monitoring")
		}
	}

	/**
	 * Gets a snapshot of current container resources. Reading the CPU counters moves the window the
	 * next reading is measured over, so several readers (the broadcast, the resources route,
	 * diagnostics) share one reading per poll interval: none shortens another's window, and none
	 * gets a window too short to mean anything.
	 */
	getSnapshot(): ContainerResources {
		const now = Date.now()
		const age = this.lastRead ? now - this.lastRead.at : null
		if (
			this.lastRead &&
			age !== null &&
			age >= 0 &&
			age < this.pollIntervalMs
		) {
			return this.lastRead.snapshot
		}
		const snapshot = this.readSnapshot()
		this.lastRead = { at: now, snapshot }
		return snapshot
	}

	private readSnapshot(): ContainerResources {
		if (!this.isAvailable) {
			return this.unavailableSnapshot()
		}

		try {
			if (this.cgroupVersion === "v2") {
				return this.readCgroupV2()
			} else if (this.cgroupVersion === "v1") {
				return this.readCgroupV1()
			}
		} catch (error) {
			this.log.warn({ error }, "Failed to read cgroup data")
		}

		return this.unavailableSnapshot()
	}

	/**
	 * Returns whether cgroups data is available.
	 */
	isMonitoringAvailable(): boolean {
		return this.isAvailable
	}

	/**
	 * Returns detected cgroup version.
	 */
	getCgroupVersion(): "v1" | "v2" | "unknown" {
		return this.cgroupVersion
	}

	// ============================================================================
	// cgroups Detection
	// ============================================================================

	private detectCgroupVersion(): void {
		// Check for cgroups v2 (unified hierarchy)
		if (this.fileExists(this.v2File("cgroup.controllers"))) {
			this.cgroupVersion = "v2"
			const dir = this.resolveCgroupV2Dir()
			this.isAvailable = dir !== null
			if (dir !== null) this.cgroupV2Dir = dir
			this.log.debug(
				{ available: this.isAvailable },
				"Detected cgroups v2; the host's root cgroup is never read",
			)
			return
		}

		// Check for cgroups v1
		if (
			this.fileExists(`${CGROUP_V1_MEMORY}/memory.usage_in_bytes`) &&
			(this.fileExists(`${CGROUP_V1_CPUACCT}/cpuacct.usage`) ||
				this.fileExists(`${CGROUP_V1_CPU}/cpuacct.usage`))
		) {
			this.cgroupVersion = "v1"
			this.isAvailable = true
			this.log.debug("Detected cgroups v1")
			return
		}

		this.cgroupVersion = "unknown"
		this.isAvailable = false
		this.log.debug("No cgroup data available (likely not running in container)")
	}

	// ============================================================================
	// cgroups v2 Reading
	// ============================================================================

	private v2File(name: string): string {
		return `${this.cgroupV2Dir}/${name}`
	}

	/** Where this process's counters live; null when it has none of its own or the path is odd. */
	private resolveCgroupV2Dir(): string | null {
		const privateNamespace = this.fileExists(this.v2File("cgroup.type"))
		const path = this.readSelfCgroupPath()
		if (path !== null && !isPlainCgroupPath(path)) return null
		// The whole container, wherever inside it this process sits.
		if (privateNamespace) return this.cgroupRoot
		if (path === null || path === "/") return null
		try {
			const root = fs.realpathSync(this.cgroupRoot)
			const dir = fs.realpathSync(`${root}${path}`)
			if (!dir.startsWith(`${root}/`)) return null
			return this.fileExists(`${dir}/cpu.stat`) ? dir : null
		} catch {
			return null
		}
	}

	/** The path on the v2 line of /proc/self/cgroup; null when unreadable or it has no such line. */
	private readSelfCgroupPath(): string | null {
		try {
			const lines = fs.readFileSync(this.selfCgroupFile, "utf8").split("\n")
			const line = lines.find(entry => entry.startsWith("0::"))
			return line === undefined ? null : line.slice(3)
		} catch {
			return null
		}
	}

	private readCgroupV2(): ContainerResources {
		const cpuStats = this.parseCpuStatV2()
		const memoryUsage = this.readMemoryV2()
		const oomKillCount = this.parseMemoryEventsV2()

		return {
			available: true,
			cpuUsagePercent: cpuStats.usagePercent,
			cpuThrottledPercent: cpuStats.throttledPercent,
			memoryUsageBytes: memoryUsage.current,
			memoryLimitBytes: memoryUsage.limit,
			memoryUsagePercent: memoryUsage.percent,
			oomKillCount,
			cgroupVersion: "v2",
		}
	}

	private parseCpuStatV2(): {
		usagePercent: number | null
		throttledPercent: number | null
	} {
		try {
			const content = fs.readFileSync(this.v2File("cpu.stat"), "utf8")
			const lines = content.trim().split("\n")
			const stats: Record<string, number> = {}

			for (const line of lines) {
				const [key, value] = line.split(" ")
				if (key && value) {
					stats[key] = Number(value)
				}
			}

			// usage_usec is cumulative CPU time in microseconds
			const usageUsec = stats["usage_usec"] ?? 0
			const now = Date.now()

			let usagePercent: number | null = null
			if (this.lastCpuTime > 0 && this.lastCpuUsage > 0n) {
				const deltaUsec = BigInt(usageUsec) - this.lastCpuUsage
				const deltaMs = now - this.lastCpuTime
				if (deltaMs > 0) {
					// Convert microseconds to percentage of elapsed time
					usagePercent = (Number(deltaUsec) / 1000 / deltaMs) * 100
				}
			}

			this.lastCpuUsage = BigInt(usageUsec)
			this.lastCpuTime = now

			// Calculate throttled percentage
			let throttledPercent: number | null = null
			const throttledUsec = stats["throttled_usec"] ?? 0
			const nrPeriods = stats["nr_periods"] ?? 0
			const nrThrottled = stats["nr_throttled"] ?? 0

			if (nrPeriods > 0) {
				throttledPercent = (nrThrottled / nrPeriods) * 100
			}

			return { usagePercent, throttledPercent }
		} catch {
			return { usagePercent: null, throttledPercent: null }
		}
	}

	private readMemoryV2(): {
		current: number | null
		limit: number | null
		percent: number | null
	} {
		try {
			const currentStr = fs
				.readFileSync(this.v2File("memory.current"), "utf8")
				.trim()
			const current = Number(currentStr)

			let limit: number | null = null
			let percent: number | null = null

			try {
				const maxStr = fs.readFileSync(this.v2File("memory.max"), "utf8").trim()
				if (maxStr !== "max") {
					limit = Number(maxStr)
					if (limit > 0) {
						percent = (current / limit) * 100
					}
				}
			} catch {
				// No limit set
			}

			return { current, limit, percent }
		} catch {
			return { current: null, limit: null, percent: null }
		}
	}

	private parseMemoryEventsV2(): number | null {
		try {
			const content = fs.readFileSync(this.v2File("memory.events"), "utf8")
			const lines = content.trim().split("\n")

			for (const line of lines) {
				const [key, value] = line.split(" ")
				if (key === "oom_kill") {
					return Number(value)
				}
			}
			return 0
		} catch {
			return null
		}
	}

	// ============================================================================
	// cgroups v1 Reading
	// ============================================================================

	private readCgroupV1(): ContainerResources {
		const cpuStats = this.parseCpuStatV1()
		const memoryUsage = this.readMemoryV1()
		const oomKillCount = this.parseOomControlV1()

		return {
			available: true,
			cpuUsagePercent: cpuStats.usagePercent,
			cpuThrottledPercent: cpuStats.throttledPercent,
			memoryUsageBytes: memoryUsage.current,
			memoryLimitBytes: memoryUsage.limit,
			memoryUsagePercent: memoryUsage.percent,
			oomKillCount,
			cgroupVersion: "v1",
		}
	}

	private parseCpuStatV1(): {
		usagePercent: number | null
		throttledPercent: number | null
	} {
		try {
			// Read total CPU usage in nanoseconds
			const cpuacctPath = this.fileExists(`${CGROUP_V1_CPUACCT}/cpuacct.usage`)
				? `${CGROUP_V1_CPUACCT}/cpuacct.usage`
				: `${CGROUP_V1_CPU}/cpuacct.usage`

			const usageNs = BigInt(fs.readFileSync(cpuacctPath, "utf8").trim())
			const now = Date.now()

			let usagePercent: number | null = null
			if (this.lastCpuTime > 0 && this.lastCpuUsage > 0n) {
				const deltaNs = usageNs - this.lastCpuUsage
				const deltaMs = now - this.lastCpuTime
				if (deltaMs > 0) {
					// Convert nanoseconds to percentage
					usagePercent = (Number(deltaNs) / 1_000_000 / deltaMs) * 100
				}
			}

			this.lastCpuUsage = usageNs
			this.lastCpuTime = now

			// Read throttling stats
			let throttledPercent: number | null = null
			try {
				const throttlePath = `${CGROUP_V1_CPU}/cpu.stat`
				if (this.fileExists(throttlePath)) {
					const content = fs.readFileSync(throttlePath, "utf8")
					const lines = content.trim().split("\n")
					const stats: Record<string, number> = {}

					for (const line of lines) {
						const [key, value] = line.split(" ")
						if (key && value) {
							stats[key] = Number(value)
						}
					}

					const nrPeriods = stats["nr_periods"] ?? 0
					const nrThrottled = stats["nr_throttled"] ?? 0

					if (nrPeriods > 0) {
						throttledPercent = (nrThrottled / nrPeriods) * 100
					}
				}
			} catch {
				// Throttling stats not available
			}

			return { usagePercent, throttledPercent }
		} catch {
			return { usagePercent: null, throttledPercent: null }
		}
	}

	private readMemoryV1(): {
		current: number | null
		limit: number | null
		percent: number | null
	} {
		try {
			const usagePath = `${CGROUP_V1_MEMORY}/memory.usage_in_bytes`
			const limitPath = `${CGROUP_V1_MEMORY}/memory.limit_in_bytes`

			const current = Number(fs.readFileSync(usagePath, "utf8").trim())

			let limit: number | null = null
			let percent: number | null = null

			try {
				const limitValue = Number(fs.readFileSync(limitPath, "utf8").trim())
				// Very large values (near max int) indicate no limit
				if (limitValue < 9_000_000_000_000_000_000) {
					limit = limitValue
					if (limit > 0) {
						percent = (current / limit) * 100
					}
				}
			} catch {
				// No limit set
			}

			return { current, limit, percent }
		} catch {
			return { current: null, limit: null, percent: null }
		}
	}

	private parseOomControlV1(): number | null {
		try {
			const content = fs.readFileSync(
				`${CGROUP_V1_MEMORY}/memory.oom_control`,
				"utf8",
			)
			const lines = content.trim().split("\n")

			for (const line of lines) {
				const [key, value] = line.split(" ")
				if (key === "oom_kill_disable") {
					// oom_kill_disable = 0 means OOM killer is enabled
					// We can't directly get kill count from v1, return 0
					return 0
				}
			}
			return null
		} catch {
			return null
		}
	}

	// ============================================================================
	// Helpers
	// ============================================================================

	private initializeCpuReading(): void {
		// Take initial reading so first snapshot has valid delta
		try {
			if (this.cgroupVersion === "v2") {
				const content = fs.readFileSync(this.v2File("cpu.stat"), "utf8")
				for (const line of content.trim().split("\n")) {
					const [key, value] = line.split(" ")
					if (key === "usage_usec") {
						this.lastCpuUsage = BigInt(value ?? 0)
						this.lastCpuTime = Date.now()
						break
					}
				}
			} else if (this.cgroupVersion === "v1") {
				const cpuacctPath = this.fileExists(
					`${CGROUP_V1_CPUACCT}/cpuacct.usage`,
				)
					? `${CGROUP_V1_CPUACCT}/cpuacct.usage`
					: `${CGROUP_V1_CPU}/cpuacct.usage`
				this.lastCpuUsage = BigInt(fs.readFileSync(cpuacctPath, "utf8").trim())
				this.lastCpuTime = Date.now()
			}
		} catch {
			// Ignore initialization errors
		}
	}

	private unavailableSnapshot(): ContainerResources {
		return {
			available: false,
			cpuUsagePercent: null,
			cpuThrottledPercent: null,
			memoryUsageBytes: null,
			memoryLimitBytes: null,
			memoryUsagePercent: null,
			oomKillCount: null,
			cgroupVersion: this.cgroupVersion,
		}
	}

	private fileExists(path: string): boolean {
		try {
			fs.accessSync(path, fs.constants.R_OK)
			return true
		} catch {
			return false
		}
	}
}

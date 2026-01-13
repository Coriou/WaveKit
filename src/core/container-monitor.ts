/**
 * Container Monitor - Reads container resource metrics from cgroups
 *
 * Supports both cgroups v2 (unified hierarchy) and v1 (legacy).
 * Provides CPU usage, memory usage, and OOM kill counts.
 *
 * Detection:
 * - cgroups v2: /sys/fs/cgroup/cgroup.controllers exists
 * - cgroups v1: /sys/fs/cgroup/memory/ and /sys/fs/cgroup/cpu/ exist
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
const CGROUP_V2_CONTROLLERS = `${CGROUP_V2_ROOT}/cgroup.controllers`

// cgroups v2 files
const CGROUP_V2_CPU_STAT = `${CGROUP_V2_ROOT}/cpu.stat`
const CGROUP_V2_MEMORY_CURRENT = `${CGROUP_V2_ROOT}/memory.current`
const CGROUP_V2_MEMORY_MAX = `${CGROUP_V2_ROOT}/memory.max`
const CGROUP_V2_MEMORY_EVENTS = `${CGROUP_V2_ROOT}/memory.events`

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
}

// ============================================================================
// ContainerMonitor
// ============================================================================

export class ContainerMonitor extends EventEmitter {
	private readonly log: Logger
	private readonly pollIntervalMs: number
	private readonly emitSnapshots: boolean
	private readonly cgroupRoot: string

	private pollTimer: ReturnType<typeof setInterval> | null = null
	private cgroupVersion: "v1" | "v2" | "unknown" = "unknown"
	private lastCpuUsage: bigint = 0n
	private lastCpuTime: number = 0
	private isAvailable: boolean = false

	constructor(logger: Logger, options: ContainerMonitorOptions = {}) {
		super()
		this.log = createComponentLogger(logger, "ContainerMonitor")
		this.pollIntervalMs = options.pollIntervalMs ?? 2000
		this.emitSnapshots = options.emitSnapshots ?? true
		this.cgroupRoot = options.cgroupRoot ?? CGROUP_V2_ROOT

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
	 * Gets a snapshot of current container resources.
	 */
	getSnapshot(): ContainerResources {
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
		const v2ControllerPath =
			this.cgroupRoot === CGROUP_V2_ROOT
				? CGROUP_V2_CONTROLLERS
				: `${this.cgroupRoot}/cgroup.controllers`

		if (this.fileExists(v2ControllerPath)) {
			this.cgroupVersion = "v2"
			this.isAvailable = true
			this.log.debug("Detected cgroups v2")
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
			const content = fs.readFileSync(CGROUP_V2_CPU_STAT, "utf8")
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
				.readFileSync(CGROUP_V2_MEMORY_CURRENT, "utf8")
				.trim()
			const current = Number(currentStr)

			let limit: number | null = null
			let percent: number | null = null

			try {
				const maxStr = fs.readFileSync(CGROUP_V2_MEMORY_MAX, "utf8").trim()
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
			const content = fs.readFileSync(CGROUP_V2_MEMORY_EVENTS, "utf8")
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
				const content = fs.readFileSync(CGROUP_V2_CPU_STAT, "utf8")
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

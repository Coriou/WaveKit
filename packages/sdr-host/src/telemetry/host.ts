import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type {
	Reading,
	ReadingScope,
	SdrHostNetworkInterface,
	SdrHostLastBoot,
	SdrHostTelemetry,
	SdrHostTelemetryHistory,
} from "@wavekit/api-types"
import {
	cpuBusyFraction,
	parseLoadavg,
	parseMeminfo,
	parseMilliCelsius,
	parseNetDev,
	parseNetWireless,
	parseProcStat,
	parseUptimeSeconds,
	type CpuTimes,
	type InterfaceCounters,
} from "./procfs.js"
import { readBootReport } from "./boot-report.js"
import { readSetupStatus, type SetupStatusValue } from "./setup-status.js"

const USER_HZ = 100
const FAST_INTERVAL_MS = 2_000
const POWER_INTERVAL_MS = 1_000
const SETUP_INTERVAL_MS = 5_000
const DISK_INTERVAL_MS = 30_000
const RATE_WINDOW_MS = 10_000
const STALE_AFTER_MS = 30_000
const DISK_STALE_AFTER_MS = 5 * 60_000
const HISTORY_MS = 5 * 60_000

interface Slot<T> {
	scope: ReadingScope
	intervalMs: number
	at: number | null
	value: T | null
	reason: string | null
}

type Value<K extends keyof Omit<SdrHostTelemetry, "generatedAt" | "power">> =
	SdrHostTelemetry[K] extends Reading<infer T> ? T : never

export interface HostCollectorOptions {
	procRoot?: string
	sysRoot?: string
	/** Directory holding the sanitized first-boot `setup.json` (read-only mount). */
	statusDir?: string
	/** Path whose filesystem backs Docker's writable layer. */
	statfsPath?: string
	networkInterfaces?: () => NodeJS.Dict<os.NetworkInterfaceInfo[]>
	/** Monotonic milliseconds. */
	now?: () => number
	/** Wall-clock milliseconds, for ISO timestamps only. */
	wallNow?: () => number
}

function slot<T>(scope: ReadingScope, intervalMs: number): Slot<T> {
	return {
		scope,
		intervalMs,
		at: null,
		value: null,
		reason: "not measured yet",
	}
}

/**
 * Collects Pi host telemetry from procfs/sysfs in the background so any
 * number of page viewers only read the cached snapshot. Runs unprivileged
 * inside the container; anything it cannot see is reported unavailable.
 */
export class HostCollector {
	private readonly procRoot: string
	private readonly sysRoot: string
	private readonly statusDir: string
	private readonly statfsPath: string
	private readonly networkInterfaces: () => NodeJS.Dict<
		os.NetworkInterfaceInfo[]
	>
	private readonly now: () => number
	private readonly wallNow: () => number
	private readonly serviceStartedAt: number

	private timers: Array<ReturnType<typeof setInterval>> = []
	private cpuSamples: Array<{ at: number; times: CpuTimes }> = []
	private containerCpu: Array<{ at: number; usageUsec: number }> = []
	private netSamples = new Map<
		string,
		Array<{ at: number; counters: InterfaceCounters }>
	>()
	private hwmonAlarmPath: string | null | undefined
	private hwmonSearchedAt = -Infinity
	private undervoltageWasActive = false
	private undervoltageEvents = 0
	private undervoltageLastAt: number | null = null
	private eventsAtLastPoint = 0
	/** Trend points keyed by collection time; ages are computed per response. */
	private history: SdrHostTelemetryHistory["points"] = []

	private readonly uptime = slot<Value<"uptime">>("host", FAST_INTERVAL_MS)
	private readonly cpu = slot<Value<"cpu">>("host", FAST_INTERVAL_MS)
	private readonly load = slot<Value<"load">>("host", FAST_INTERVAL_MS)
	private readonly memory = slot<Value<"memory">>("host", FAST_INTERVAL_MS)
	private readonly container = slot<Value<"container">>(
		"container",
		FAST_INTERVAL_MS,
	)
	private readonly disk = slot<Value<"disk">>(
		"docker-storage",
		DISK_INTERVAL_MS,
	)
	private readonly temperature = slot<Value<"temperature">>(
		"host",
		FAST_INTERVAL_MS,
	)
	private readonly network = slot<Value<"network">>("host", FAST_INTERVAL_MS)
	private readonly setup = slot<SetupStatusValue>("host", SETUP_INTERVAL_MS)
	private readonly lastBoot = slot<SdrHostLastBoot>("host", SETUP_INTERVAL_MS)
	private readonly undervoltageNow = slot<boolean>("host", POWER_INTERVAL_MS)

	constructor(options: HostCollectorOptions = {}) {
		this.procRoot = options.procRoot ?? "/proc"
		this.sysRoot = options.sysRoot ?? "/sys"
		this.statusDir = options.statusDir ?? "/host-status"
		this.statfsPath = options.statfsPath ?? "/"
		this.networkInterfaces = options.networkInterfaces ?? os.networkInterfaces
		this.now = options.now ?? (() => performance.now())
		this.wallNow = options.wallNow ?? (() => Date.now())
		this.serviceStartedAt = this.now()
	}

	start(): void {
		if (this.timers.length > 0) return
		this.collectAll()
		const every = (ms: number, task: () => void): void => {
			const timer = setInterval(task, ms)
			timer.unref()
			this.timers.push(timer)
		}
		every(FAST_INTERVAL_MS, () => this.collectFast())
		every(POWER_INTERVAL_MS, () => this.collectPower())
		every(SETUP_INTERVAL_MS, () => this.collectSetup())
		every(DISK_INTERVAL_MS, () => this.collectDisk())
	}

	stop(): void {
		for (const timer of this.timers) clearInterval(timer)
		this.timers = []
	}

	/** Collect everything once; exposed for tests and the first snapshot. */
	collectAll(): void {
		this.collectFast()
		this.collectPower()
		this.collectSetup()
		this.collectDisk()
	}

	snapshot(): SdrHostTelemetry {
		const at = this.now()
		const since =
			this.iso(this.serviceStartedAt) ?? new Date(this.wallNow()).toISOString()
		const power = this.render(this.undervoltageNow, at)
		const observed: SdrHostTelemetry["power"]["undervoltageObserved"] =
			power.state === "unavailable"
				? { ...power, scope: "service", value: null }
				: {
						state: power.state,
						scope: "service",
						observedAt: power.observedAt,
						ageMs: power.ageMs,
						value: {
							events: this.undervoltageEvents,
							lastAt: this.iso(this.undervoltageLastAt),
							since,
							lastAgeMs:
								this.undervoltageLastAt === null
									? null
									: Math.round(at - this.undervoltageLastAt),
							coveredMs: Math.round(at - this.serviceStartedAt),
						},
						reason: null,
					}
		return {
			generatedAt: new Date(this.wallNow()).toISOString(),
			uptime: this.render(this.uptime, at),
			cpu: this.render(this.cpu, at),
			load: this.render(this.load, at),
			memory: this.render(this.memory, at),
			container: this.render(this.container, at),
			disk: this.render(this.disk, at),
			temperature: this.render(this.temperature, at),
			power: {
				undervoltageNow: power,
				undervoltageObserved: observed,
				throttling: {
					state: "unavailable",
					scope: "host",
					observedAt: null,
					ageMs: null,
					value: null,
					reason:
						"firmware throttle flags need /dev/vcio or vcgencmd, which are not granted",
				},
			},
			network: this.render(this.network, at),
			setup: this.render(this.setup, at),
			lastBoot: this.render(this.lastBoot, at),
			history: {
				intervalMs: FAST_INTERVAL_MS,
				windowMs: HISTORY_MS,
				points: this.history
					.filter(([t]) => at - t <= HISTORY_MS)
					.map(([t, ...values]) => [Math.round(at - t), ...values]),
			},
		}
	}

	private render<T>(s: Slot<T>, at: number): Reading<T> {
		const age = s.at === null ? null : Math.round(at - s.at)
		const staleAfter =
			s.scope === "docker-storage" ? DISK_STALE_AFTER_MS : STALE_AFTER_MS
		if (s.value === null || age === null) {
			return {
				state: "unavailable",
				scope: s.scope,
				observedAt: null,
				ageMs: null,
				value: null,
				reason: s.reason ?? "unavailable",
			}
		}
		if (age > staleAfter) {
			return {
				state: "unavailable",
				scope: s.scope,
				observedAt: this.iso(s.at),
				ageMs: age,
				value: null,
				reason: "expired",
			}
		}
		return {
			state: age <= s.intervalMs * 3 ? "ok" : "stale",
			scope: s.scope,
			observedAt: this.iso(s.at),
			ageMs: age,
			value: s.value,
			reason: null,
		}
	}

	private set<T>(
		s: Slot<T>,
		value: T | null,
		reason: string | null,
		at = this.now(),
	): void {
		s.at = at
		s.value = value
		s.reason = value === null ? (reason ?? "unavailable") : null
	}

	private read(file: string): string | null {
		try {
			return fs.readFileSync(file, "utf8")
		} catch {
			return null
		}
	}

	private collectFast(): void {
		const at = this.now()
		this.collectUptime(at)
		this.collectCpu(at)
		const load = this.read(path.join(this.procRoot, "loadavg"))
		this.set(
			this.load,
			load === null ? null : parseLoadavg(load),
			"/proc/loadavg unreadable",
			at,
		)
		const meminfo = this.read(path.join(this.procRoot, "meminfo"))
		this.set(
			this.memory,
			meminfo === null ? null : parseMeminfo(meminfo),
			"/proc/meminfo unreadable",
			at,
		)
		this.collectContainer(at)
		this.collectTemperature(at)
		this.collectNetwork(at)
		this.recordHistory(at)
	}

	/** One trend point per fast collection, from values measured just now. */
	private recordHistory(at: number): void {
		const fresh = <T>(s: Slot<T>): T | null => (s.at === at ? s.value : null)
		const memory = fresh(this.memory)
		this.history.push([
			at,
			fresh(this.cpu)?.busyPercent ?? null,
			memory && memory.totalBytes > 0
				? Math.round(
						((memory.totalBytes - memory.availableBytes) / memory.totalBytes) *
							1000,
					) / 10
				: null,
			fresh(this.temperature)?.celsius ?? null,
			// Rising edges since the previous point; null while unmeasurable.
			this.undervoltageNow.value === null
				? null
				: this.undervoltageEvents - this.eventsAtLastPoint,
		])
		this.eventsAtLastPoint = this.undervoltageEvents
		while ((this.history[0]?.[0] ?? at) < at - HISTORY_MS) this.history.shift()
	}

	private collectUptime(at: number): void {
		const text = this.read(path.join(this.procRoot, "uptime"))
		const hostSec = text === null ? null : parseUptimeSeconds(text)
		if (hostSec === null) {
			this.set(this.uptime, null, "/proc/uptime unreadable", at)
			return
		}
		let containerSec: number | null = null
		const stat = this.read(path.join(this.procRoot, "1", "stat"))
		if (stat !== null) {
			// Field 22 (starttime) counts from the end of the parenthesised comm.
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
			const startTicks = Number(fields[19])
			if (Number.isFinite(startTicks)) {
				containerSec = Math.max(0, Math.round(hostSec - startTicks / USER_HZ))
			}
		}
		this.set(
			this.uptime,
			{
				hostSec: Math.round(hostSec),
				hostBootedAt: new Date(this.wallNow() - hostSec * 1000).toISOString(),
				containerSec,
				serviceSec: Math.round((at - this.serviceStartedAt) / 1000),
			},
			null,
			at,
		)
	}

	private collectCpu(at: number): void {
		const text = this.read(path.join(this.procRoot, "stat"))
		const times = text === null ? null : parseProcStat(text)
		if (!times) {
			this.cpuSamples = []
			this.set(this.cpu, null, "/proc/stat unreadable", at)
			return
		}
		this.cpuSamples.push({ at, times })
		this.cpuSamples = this.cpuSamples.filter(s => at - s.at <= RATE_WINDOW_MS)
		const first = this.cpuSamples[0]
		const busy =
			first && first.at < at ? cpuBusyFraction(first.times, times) : null
		if (busy === null) {
			if (first && first.at < at) this.cpuSamples = [{ at, times }]
			// Keep a previous good value until it ages; a first sample has none.
			if (this.cpu.value === null) this.set(this.cpu, null, "measuring", at)
			return
		}
		this.set(
			this.cpu,
			{
				busyPercent: Math.round(busy * 1000) / 10,
				cores: times.cores,
				windowMs: Math.round(at - (first?.at ?? at)),
			},
			null,
			at,
		)
	}

	private collectContainer(at: number): void {
		const cgroupLine = this.read(path.join(this.procRoot, "self", "cgroup"))
		const relative = cgroupLine
			?.split("\n")
			.find(line => line.startsWith("0::"))
			?.slice(3)
			.trim()
		if (relative === undefined) {
			this.set(this.container, null, "cgroup v2 not available", at)
			return
		}
		const dir = path.join(this.sysRoot, "fs", "cgroup", relative)
		const current = Number(this.read(path.join(dir, "memory.current"))?.trim())
		if (!Number.isFinite(current)) {
			this.set(
				this.container,
				null,
				"container memory accounting not visible",
				at,
			)
			return
		}
		const maxText = this.read(path.join(dir, "memory.max"))?.trim()
		const limit = maxText && maxText !== "max" ? Number(maxText) : null
		const usage = /usage_usec\s+(\d+)/.exec(
			this.read(path.join(dir, "cpu.stat")) ?? "",
		)
		let cpuPercent: number | null = null
		if (usage?.[1]) {
			const usageUsec = Number(usage[1])
			this.containerCpu.push({ at, usageUsec })
			this.containerCpu = this.containerCpu.filter(
				s => at - s.at <= RATE_WINDOW_MS,
			)
			const first = this.containerCpu[0]
			const cores = this.cpu.value?.cores ?? 1
			if (first && first.at < at && usageUsec >= first.usageUsec) {
				cpuPercent =
					Math.round(
						((usageUsec - first.usageUsec) / ((at - first.at) * 1000 * cores)) *
							1000,
					) / 10
			} else if (first && usageUsec < first.usageUsec) {
				this.containerCpu = [{ at, usageUsec }]
			}
		}
		this.set(
			this.container,
			{
				memoryBytes: current,
				memoryLimitBytes:
					limit !== null && Number.isFinite(limit) ? limit : null,
				cpuPercent,
			},
			null,
			at,
		)
	}

	private collectTemperature(at: number): void {
		const base = path.join(this.sysRoot, "class", "thermal")
		let zones: string[]
		try {
			zones = fs
				.readdirSync(base)
				.filter(name => name.startsWith("thermal_zone"))
				.sort()
		} catch {
			this.set(this.temperature, null, "no thermal zones visible", at)
			return
		}
		const candidates = zones.map(zone => ({
			zone,
			type: this.read(path.join(base, zone, "type"))?.trim() ?? zone,
		}))
		candidates.sort(
			(a, b) =>
				Number(/cpu|soc/i.test(b.type)) - Number(/cpu|soc/i.test(a.type)),
		)
		for (const candidate of candidates) {
			const text = this.read(path.join(base, candidate.zone, "temp"))
			const celsius = text === null ? null : parseMilliCelsius(text)
			if (celsius !== null) {
				this.set(this.temperature, { celsius, zone: candidate.type }, null, at)
				return
			}
		}
		this.set(this.temperature, null, "no readable thermal zone", at)
	}

	private collectNetwork(at: number): void {
		const netBase = path.join(this.sysRoot, "class", "net")
		let names: string[]
		try {
			names = fs.readdirSync(netBase)
		} catch {
			this.set(this.network, null, "network interfaces not visible", at)
			return
		}
		// Only physical NICs have a `device` link. Seeing one proves we share the
		// host's network namespace; veth/bridges never qualify.
		const physical = names
			.filter(name => {
				try {
					fs.statSync(path.join(netBase, name, "device"))
					return true
				} catch {
					return false
				}
			})
			.sort()
		if (physical.length === 0) {
			this.set(this.network, null, "host network namespace not visible", at)
			return
		}
		const devText = this.read(path.join(this.procRoot, "net", "dev"))
		const counters =
			devText === null
				? new Map<string, InterfaceCounters>()
				: parseNetDev(devText)
		const wirelessText = this.read(path.join(this.procRoot, "net", "wireless"))
		const wireless =
			wirelessText === null ? new Map() : parseNetWireless(wirelessText)
		const addresses = this.networkInterfaces()

		const result: SdrHostNetworkInterface[] = physical.map(name => {
			const isWireless =
				wireless.has(name) ||
				fs.existsSync(path.join(netBase, name, "wireless"))
			const type = this.read(path.join(netBase, name, "type"))?.trim()
			const current = counters.get(name)
			let rx: number | null = null
			let tx: number | null = null
			if (current) {
				const history = (this.netSamples.get(name) ?? []).filter(
					s => at - s.at <= RATE_WINDOW_MS,
				)
				const first = history[0]
				if (
					first &&
					(current.rxBytes < first.counters.rxBytes ||
						current.txBytes < first.counters.txBytes)
				) {
					history.length = 0
				} else if (first && first.at < at) {
					const seconds = (at - first.at) / 1000
					rx = Math.round((current.rxBytes - first.counters.rxBytes) / seconds)
					tx = Math.round((current.txBytes - first.counters.txBytes) / seconds)
				}
				history.push({ at, counters: current })
				this.netSamples.set(name, history)
			}
			const link = wireless.get(name)
			return {
				name,
				kind: isWireless ? "wireless" : type === "1" ? "ethernet" : "other",
				operstate:
					this.read(path.join(netBase, name, "operstate"))?.trim() ?? "unknown",
				addresses: (addresses[name] ?? [])
					.filter(
						info =>
							!info.internal &&
							!(info.family === "IPv6" && info.address.startsWith("fe80")),
					)
					.map(info => info.address),
				rxBytesPerSec: rx,
				txBytesPerSec: tx,
				wireless: link
					? { linkQuality: link.quality, signalDbm: link.signalDbm }
					: null,
			}
		})
		this.set(this.network, result, null, at)
	}

	private collectPower(): void {
		const at = this.now()
		if (
			this.hwmonAlarmPath === undefined ||
			(this.hwmonAlarmPath === null && at - this.hwmonSearchedAt > 60_000)
		) {
			this.hwmonAlarmPath = this.findUndervoltageAlarm()
			this.hwmonSearchedAt = at
		}
		if (this.hwmonAlarmPath === null) {
			this.set(
				this.undervoltageNow,
				null,
				"rpi_volt hwmon sensor not visible",
				at,
			)
			return
		}
		const text = this.read(this.hwmonAlarmPath)?.trim()
		if (text !== "0" && text !== "1") {
			this.hwmonAlarmPath = undefined
			this.set(this.undervoltageNow, null, "rpi_volt alarm unreadable", at)
			return
		}
		const active = text === "1"
		if (active && !this.undervoltageWasActive) {
			this.undervoltageEvents += 1
		}
		if (active) this.undervoltageLastAt = at
		this.undervoltageWasActive = active
		this.set(this.undervoltageNow, active, null, at)
	}

	private findUndervoltageAlarm(): string | null {
		const base = path.join(this.sysRoot, "class", "hwmon")
		try {
			for (const entry of fs.readdirSync(base)) {
				if (this.read(path.join(base, entry, "name"))?.trim() === "rpi_volt") {
					const alarm = path.join(base, entry, "in0_lcrit_alarm")
					if (this.read(alarm) !== null) return alarm
				}
			}
		} catch {
			// No hwmon class visible.
		}
		return null
	}

	private collectSetup(): void {
		const at = this.now()
		const bootId =
			this.read(
				path.join(this.procRoot, "sys", "kernel", "random", "boot_id"),
			)?.trim() ?? null
		const result = readSetupStatus(this.statusDir, bootId, this.wallNow())
		this.set(this.setup, result.value, result.reason, at)
		const report = readBootReport(this.statusDir, bootId, this.wallNow())
		this.set(this.lastBoot, report.value, report.reason, at)
	}

	private collectDisk(): void {
		const at = this.now()
		try {
			const stats = fs.statfsSync(this.statfsPath)
			const totalBytes = stats.blocks * stats.bsize
			this.set(
				this.disk,
				{
					totalBytes,
					usedBytes: (stats.blocks - stats.bfree) * stats.bsize,
					availableBytes: stats.bavail * stats.bsize,
				},
				null,
				at,
			)
		} catch {
			this.set(this.disk, null, "filesystem statistics unavailable", at)
		}
	}

	private iso(monotonic: number | null): string | null {
		if (monotonic === null) return null
		return new Date(this.wallNow() - (this.now() - monotonic)).toISOString()
	}
}

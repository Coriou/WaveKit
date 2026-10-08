/**
 * Pure parsers for Linux procfs/sysfs text. Inputs are file contents; every
 * parser returns null rather than guessing when the text is not understood.
 */

export interface CpuTimes {
	/** Sum of all jiffies on the aggregate `cpu` line. */
	total: number
	/** idle + iowait jiffies. */
	idle: number
	/** Number of per-core `cpuN` lines. */
	cores: number
}

export function parseProcStat(text: string): CpuTimes | null {
	let aggregate: number[] | null = null
	let cores = 0
	for (const line of text.split("\n")) {
		if (line.startsWith("cpu ")) {
			aggregate = line.trim().split(/\s+/).slice(1).map(Number)
		} else if (/^cpu\d+\s/.test(line)) {
			cores += 1
		}
	}
	if (
		!aggregate ||
		aggregate.length < 4 ||
		aggregate.some(n => !Number.isFinite(n))
	) {
		return null
	}
	// guest/guest_nice (fields 9-10) are already included in user/nice.
	const counted = aggregate.slice(0, 8)
	const total = counted.reduce((sum, n) => sum + n, 0)
	const idle = (aggregate[3] ?? 0) + (aggregate[4] ?? 0)
	return { total, idle, cores: Math.max(cores, 1) }
}

/** Busy fraction (0-1) between two samples, or null when the delta is unusable. */
export function cpuBusyFraction(
	previous: CpuTimes,
	current: CpuTimes,
): number | null {
	const total = current.total - previous.total
	const idle = current.idle - previous.idle
	if (total <= 0 || idle < 0 || idle > total) return null
	return (total - idle) / total
}

export interface LoadAverage {
	one: number
	five: number
	fifteen: number
}

export function parseLoadavg(text: string): LoadAverage | null {
	const [one, five, fifteen] = text.trim().split(/\s+/).map(Number)
	if (
		one === undefined ||
		five === undefined ||
		fifteen === undefined ||
		![one, five, fifteen].every(Number.isFinite)
	) {
		return null
	}
	return { one, five, fifteen }
}

export function parseUptimeSeconds(text: string): number | null {
	const value = Number(text.trim().split(/\s+/)[0])
	return Number.isFinite(value) && value >= 0 ? value : null
}

export interface MemoryInfo {
	totalBytes: number
	availableBytes: number
	swapTotalBytes: number
	swapFreeBytes: number
}

export function parseMeminfo(text: string): MemoryInfo | null {
	const fields = new Map<string, number>()
	for (const line of text.split("\n")) {
		const match = /^(\w+):\s+(\d+)\s*kB/.exec(line)
		if (match?.[1] && match[2]) fields.set(match[1], Number(match[2]) * 1024)
	}
	const total = fields.get("MemTotal")
	const available = fields.get("MemAvailable")
	if (total === undefined || available === undefined || total <= 0) return null
	return {
		totalBytes: total,
		availableBytes: available,
		swapTotalBytes: fields.get("SwapTotal") ?? 0,
		swapFreeBytes: fields.get("SwapFree") ?? 0,
	}
}

export interface InterfaceCounters {
	rxBytes: number
	txBytes: number
	rxDrops: number
	txDrops: number
}

export function parseNetDev(text: string): Map<string, InterfaceCounters> {
	const result = new Map<string, InterfaceCounters>()
	for (const line of text.split("\n").slice(2)) {
		const separator = line.indexOf(":")
		if (separator < 0) continue
		const name = line.slice(0, separator).trim()
		const values = line
			.slice(separator + 1)
			.trim()
			.split(/\s+/)
			.map(Number)
		if (!name || values.length < 16 || values.some(n => !Number.isFinite(n)))
			continue
		result.set(name, {
			rxBytes: values[0] ?? 0,
			rxDrops: values[3] ?? 0,
			txBytes: values[8] ?? 0,
			txDrops: values[11] ?? 0,
		})
	}
	return result
}

export interface WirelessLink {
	/** Link quality as reported by the driver (often /70). */
	quality: number
	/** Signal level in dBm. */
	signalDbm: number
}

export function parseNetWireless(text: string): Map<string, WirelessLink> {
	const result = new Map<string, WirelessLink>()
	for (const line of text.split("\n").slice(2)) {
		const match = /^\s*([^:\s]+):\s+\S+\s+(-?[\d.]+)\.?\s+(-?[\d.]+)\.?/.exec(
			line,
		)
		if (!match?.[1]) continue
		const quality = Number(match[2])
		const signal = Number(match[3])
		if (!Number.isFinite(quality) || !Number.isFinite(signal)) continue
		// Some drivers report unsigned levels offset by 256.
		result.set(match[1], {
			quality,
			signalDbm: signal > 0 ? signal - 256 : signal,
		})
	}
	return result
}

/** Kernel thermal zones report millidegrees Celsius. */
export function parseMilliCelsius(text: string): number | null {
	if (!/^-?\d+$/.test(text.trim())) return null
	const value = Number(text.trim())
	if (!Number.isFinite(value) || value <= -40_000 || value >= 150_000)
		return null
	return Math.round(value / 100) / 10
}

/**
 * Raspberry Pi firmware throttle word, as returned by `vcgencmd get_throttled`
 * and the downstream kernel's `get_throttled` sysfs attribute.
 */
export interface ThrottleFlags {
	raw: number
	now: PowerConditions
	sinceBoot: PowerConditions
}

export interface PowerConditions {
	underVoltage: boolean
	frequencyCapped: boolean
	throttled: boolean
	softTemperatureLimit: boolean
}

export function parseThrottled(text: string): ThrottleFlags | null {
	const trimmed = text.trim().replace(/^throttled=/, "")
	if (!/^(0x)?[0-9a-f]+$/i.test(trimmed)) return null
	const raw = Number.parseInt(trimmed.replace(/^0x/i, ""), 16)
	if (!Number.isFinite(raw)) return null
	const bits = (offset: number): PowerConditions => ({
		underVoltage: (raw & (1 << offset)) !== 0,
		frequencyCapped: (raw & (1 << (offset + 1))) !== 0,
		throttled: (raw & (1 << (offset + 2))) !== 0,
		softTemperatureLimit: (raw & (1 << (offset + 3))) !== 0,
	})
	return { raw, now: bits(0), sinceBoot: bits(16) }
}

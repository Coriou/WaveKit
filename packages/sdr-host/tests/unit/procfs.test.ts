import { describe, it, expect } from "vitest"
import {
	cpuBusyFraction,
	parseLoadavg,
	parseMeminfo,
	parseMilliCelsius,
	parseNetDev,
	parseNetWireless,
	parseProcStat,
	parseThrottled,
	parseUptimeSeconds,
} from "../../src/telemetry/procfs.js"

describe("procfs parsers", () => {
	it("derives CPU busy fraction from aggregate jiffies and counts cores", () => {
		const before = parseProcStat(
			"cpu  100 0 100 700 100 0 0 0 0 0\ncpu0 1 0 1 1 0 0 0 0 0 0\ncpu1 1 0 1 1 0 0 0 0 0 0\nintr 1\n",
		)
		const after = parseProcStat(
			"cpu  200 0 200 1000 100 0 0 0 0 0\ncpu0 1 0 1 1 0 0 0 0 0 0\ncpu1 1 0 1 1 0 0 0 0 0 0\n",
		)
		expect(before?.cores).toBe(2)
		expect(before && after && cpuBusyFraction(before, after)).toBeCloseTo(0.4)
		// A counter reset (e.g. reading a different namespace) is not a measurement.
		expect(before && after && cpuBusyFraction(after, before)).toBeNull()
		expect(parseProcStat("garbage")).toBeNull()
	})

	it("parses load, uptime and memory and rejects malformed text", () => {
		expect(parseLoadavg("0.52 0.58 0.59 1/234 5678\n")).toEqual({
			one: 0.52,
			five: 0.58,
			fifteen: 0.59,
		})
		expect(parseLoadavg("")).toBeNull()
		expect(parseUptimeSeconds("35412.62 120301.11\n")).toBe(35412.62)
		expect(parseUptimeSeconds("nope")).toBeNull()
		expect(
			parseMeminfo(
				"MemTotal:         918424 kB\nMemFree: 100 kB\nMemAvailable:     512000 kB\nSwapTotal: 102396 kB\nSwapFree: 102396 kB\n",
			),
		).toEqual({
			totalBytes: 918424 * 1024,
			availableBytes: 512000 * 1024,
			swapTotalBytes: 102396 * 1024,
			swapFreeBytes: 102396 * 1024,
		})
		// Kernels without MemAvailable must not be reported with a guessed value.
		expect(parseMeminfo("MemTotal: 1000 kB\nMemFree: 10 kB\n")).toBeNull()
	})

	it("parses interface byte and drop counters and Wi-Fi signal", () => {
		const netDev = parseNetDev(
			[
				"Inter-|   Receive                                                |  Transmit",
				" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
				"    lo:    1000      10    0    0    0     0          0         0     1000      10    0    0    0     0       0          0",
				" wlan0: 5000000   4000    0    3    0     0          0         0 900000000  70000    0    7    0     0       0          0",
			].join("\n"),
		)
		expect(netDev.get("wlan0")).toEqual({
			rxBytes: 5000000,
			txBytes: 900000000,
			rxDrops: 3,
			txDrops: 7,
		})
		const wireless = parseNetWireless(
			[
				"Inter-| sta-|   Quality        |   Discarded packets               | Missed | WE",
				" face | tus | link level noise |  nwid  crypt   frag  retry   misc | beacon | 22",
				" wlan0: 0000   58.  -52.  -256        0      0      0      0      0        0",
			].join("\n"),
		)
		expect(wireless.get("wlan0")).toEqual({ quality: 58, signalDbm: -52 })
	})

	it("parses thermal millidegrees within physical bounds", () => {
		expect(parseMilliCelsius("53692\n")).toBe(53.7)
		expect(parseMilliCelsius("")).toBeNull()
		expect(parseMilliCelsius("999999")).toBeNull()
	})

	it("separates active power conditions from conditions seen since boot", () => {
		// Observed on the development Pi during an undervoltage event.
		const active = parseThrottled("0x50005\n")
		expect(active?.now).toEqual({
			underVoltage: true,
			frequencyCapped: false,
			throttled: true,
			softTemperatureLimit: false,
		})
		expect(active?.sinceBoot.underVoltage).toBe(true)
		// Between events only the history bits remain set.
		const historical = parseThrottled("throttled=0x50000")
		expect(historical?.now.underVoltage).toBe(false)
		expect(historical?.now.throttled).toBe(false)
		expect(historical?.sinceBoot).toMatchObject({
			underVoltage: true,
			throttled: true,
		})
		expect(parseThrottled("0x0")?.raw).toBe(0)
		expect(parseThrottled("error")).toBeNull()
	})
})

import { describe, it, expect } from "vitest"
import type { SdrHostSampling, SdrHostTelemetry } from "@wavekit/api-types"
import { HostCollector } from "../../src/telemetry/host.js"
import { SamplingMonitor } from "../../src/telemetry/sampling.js"
import {
	clientSlots,
	diagnostics,
	flowRate,
	formatAgePrecise,
	lastBoot,
	linkState,
	nextDelay,
	plotMax,
	power,
	readouts,
	setupLine,
	setupRow,
	smoothTrace,
	stream,
	tracePath,
	verdict,
	wifiBars,
	type StatusPayload,
} from "../../ui/model.js"

function sampling(
	overrides: Partial<SdrHostSampling> = {},
	upstream: Partial<SdrHostSampling["upstream"]> = {},
): SdrHostSampling {
	return {
		state: "streaming",
		reason: null,
		timeoutMs: 10_000,
		lastSampleAt: "2026-10-08T10:00:00.000Z",
		sampleAgeMs: 1000,
		upstream: {
			bytesTotal: 1e9,
			bytesPerSec: 4_096_000,
			windowMs: 10_000,
			expectedBytesPerSec: 4_096_000,
			rateBasis: "configured",
			rateStatus: "nominal",
			...upstream,
		},
		epoch: {
			rtlmuxPid: 2,
			rtlTcpPid: 1,
			startedAt: null,
			resets: 0,
			lastResetReason: null,
		},
		stats: { state: "ok", observedAt: null, ageMs: 500, lastError: null },
		...overrides,
	}
}

function status(s: SdrHostSampling, present = true): StatusPayload {
	return {
		dongle: {
			present,
			product: "RTL2838UHIDIR",
			driverConflict: false,
			conflictingDriver: null,
		},
		rtlTcp: { running: true, pid: 1, restartCount: 0, lastRestartAt: null },
		rtlmux: { running: true, pid: 2, restartCount: 0, lastRestartAt: null },
		sampling: s,
		delivery: {
			state: "idle",
			clients: [],
			queuedBytesPerSec: null,
			droppedBytesLast60s: 0,
			droppedChunksLast60s: 0,
			droppedBytesSinceMonitorStart: 0,
			monitorStartedAt: "2026-10-08T09:00:00.000Z",
		},
	}
}

function emptyHost(): SdrHostTelemetry {
	const collector = new HostCollector({
		procRoot: "/nonexistent",
		sysRoot: "/nonexistent",
		statusDir: "/nonexistent",
		statfsPath: "/nonexistent",
		networkInterfaces: () => ({}),
	})
	collector.collectAll()
	return collector.snapshot()
}

describe("operator page verdict", () => {
	it("claims sampling only from fresh upstream evidence, not from presence", () => {
		expect(
			verdict({ status: status(sampling()), host: null, fresh: true }),
		).toMatchObject({ state: "ok", title: "Sampling" })
		// Dongle present and processes running, but the counter stopped.
		const stalled = verdict({
			status: status(
				sampling({
					state: "stale",
					reason: "upstream byte count stopped growing",
					sampleAgeMs: 45_000,
				}),
			),
			host: null,
			fresh: true,
		})
		expect(stalled).toMatchObject({ state: "fault", title: "Samples stopped" })
		expect(stalled.detail).toContain("45 s ago")
	})

	it("never shows a green verdict from a stale page snapshot", () => {
		expect(
			verdict({ status: status(sampling()), host: null, fresh: false }),
		).toMatchObject({
			state: "unknown",
			title: "No current reading",
		})
	})

	it("warns on a sustained rate deficit and names under-voltage as the likely cause", () => {
		const host = emptyHost()
		host.power.undervoltageNow = {
			...host.power.undervoltageNow,
			state: "ok",
			value: true,
			reason: null,
		}
		const low = verdict({
			status: status(
				sampling({}, { bytesPerSec: 2_048_000, rateStatus: "low" }),
			),
			host,
			fresh: true,
		})
		expect(low.state).toBe("warn")
		expect(low.detail).toContain("50% of the expected rate.")
		expect(low.detail).toContain("under-voltage")
	})

	it("keeps a full-rate verdict green but names active under-voltage beside it", () => {
		const host = emptyHost()
		host.power.undervoltageNow = {
			...host.power.undervoltageNow,
			state: "ok",
			value: true,
			reason: null,
		}
		const v = verdict({ status: status(sampling()), host, fresh: true })
		expect(v).toMatchObject({ state: "ok", title: "Sampling" })
		expect(v.detail).toContain("under-voltage right now")
		expect(
			verdict({ status: status(sampling()), host: emptyHost(), fresh: true })
				.detail,
		).not.toContain("under-voltage")
	})

	it("reports unknown flow when rtlmux counters cannot be read", () => {
		expect(
			verdict({
				status: status(sampling({ state: "unknown" })),
				host: null,
				fresh: true,
			}).title,
		).toBe("Flow unknown")
		expect(
			verdict({
				status: { dongle: { present: true, product: null } },
				host: null,
				fresh: true,
			}).title,
		).toBe("Flow not reported")
	})

	it("quotes a configured sample rate and labels a client-set one as derived", () => {
		expect(flowRate(status(sampling()), true)).toEqual({
			value: "4.10",
			unit: "MB/s",
			sub: "100% of expected",
			basis: "2.048\u00a0MS/s configured",
		})
		const clientSet = status(
			sampling(
				{},
				{
					bytesPerSec: 4_323_000,
					expectedBytesPerSec: null,
					rateBasis: "client-controlled",
					rateStatus: "unknown",
				},
			),
		)
		expect(flowRate(clientSet, true)).toMatchObject({
			sub: "≈2.16\u00a0MS/s derived",
			basis: "Rate set by a client",
		})
		// Without a current reading the figure says so; what it is set to stays.
		expect(flowRate(clientSet, false)).toMatchObject({
			value: "—",
			sub: "No current reading",
			basis: "Rate set by a client",
		})
	})

	it("describes the stream: dongle, tuning and each client's delivery", () => {
		const s = status(sampling())
		s.rtlTcp = {
			...s.rtlTcp!,
			restartCount: 2,
			config: {
				sampleRate: 2_048_000,
				frequency: 446_524_920,
				agc: false,
				gain: 49,
			},
		}
		s.rtlmux = { ...s.rtlmux!, endpoint: "tcp://pi.local:5555" }
		const idle = stream(s)
		expect(idle?.endpoint).toBe("tcp://pi.local:5555")
		expect(idle?.dongle).toMatchObject({
			state: "ok",
			text: "RTL2838UHIDIR",
			sub: "IQ server restarted 2 times",
		})
		// The frequency is the value; rate and gain are its context line.
		expect(idle?.tuning).toEqual({
			text: "446.525\u00a0MHz",
			sub: "2.048\u00a0MS/s · gain\u00a049\u00a0dB",
		})
		// Zero clients is idle delivery, not a fault and not a guess.
		expect(idle).toMatchObject({
			clientsKnown: true,
			clients: [],
			clientsRow: { state: "unknown", text: "None connected" },
		})
		expect(stream(status(sampling(), false))?.dongle).toMatchObject({
			state: "fault",
			text: "Not detected",
		})
		const client = {
			key: "k",
			address: "192.0.2.20:53812",
			connectedAt: "2026-10-08T09:00:00.000Z",
			queuedBytes: 1,
			queuedBytesPerSec: 4_096_000,
			droppedBytes: 0,
			droppedChunks: 0,
			droppedBytesLast60s: 0,
			commandBytes: 30,
		}
		s.delivery = {
			...s.delivery!,
			state: "dropping",
			clients: [
				client,
				{ ...client, address: "192.0.2.31:1", droppedBytesLast60s: 2_097_152 },
				{ ...client, address: "192.0.2.40:1", queuedBytesPerSec: null },
			],
		}
		s.sampling!.upstream.rateBasis = "client-controlled"
		const busy = stream(s, "2026-10-08T09:58:00.000Z")
		expect(busy?.tuning).toMatchObject({ text: "Set by a client" })
		expect(busy?.clients.map(c => [c.state, c.rate, c.detail])).toEqual([
			["ok", "4.10 MB/s", "Keeping up · connected 58 min"],
			["warn", "4.10 MB/s", "Falling behind · 2.10 MB dropped in 60 s"],
			["unknown", "—", "Measuring · connected 58 min"],
		])
		expect(busy?.clientsRow).toEqual({
			state: "warn",
			text: "3 connected",
			sub: "1 falling behind",
		})
	})

	it("lists every client up to the cap, then puts falling-behind ones first and sums the rest", () => {
		const client = (address: string, state: "ok" | "warn") => ({
			key: address,
			address,
			state,
			rate: "4.10 MB/s",
			bytesPerSec: 4_096_000,
			detail: "",
		})
		const two = [client("a", "ok"), client("b", "warn")]
		// Below the cap: exactly the clients there are, in connection order.
		expect(clientSlots(two, 3)).toEqual({ shown: two, more: null })
		expect(clientSlots([], 3)).toEqual({ shown: [], more: null })
		const five = [
			client("a", "ok"),
			client("b", "ok"),
			client("c", "warn"),
			client("d", "ok"),
			client("e", "warn"),
		]
		// Above the cap: the list stops at three rows, the last a summary.
		const { shown, more } = clientSlots(five, 3)
		expect(shown.map(c => c.address)).toEqual(["c", "e"])
		expect(more).toEqual({
			state: "ok",
			text: "3 more",
			detail: "All keeping up",
		})
	})

	it("renders the server's real verdict for a live monitor", () => {
		const monitor = new SamplingMonitor({ sampleRate: 2_048_000, now: () => 0 })
		monitor.observeProcesses(2, 1)
		expect(
			verdict({ status: status(monitor.sampling()), host: null, fresh: true })
				.title,
		).toBe("Waiting for samples")
	})
})

describe("operator page host readouts", () => {
	it("labels every unmeasurable value unavailable with its reason", () => {
		const values = readouts(emptyHost())
		for (const readout of Object.values(values ?? {})) {
			expect(readout.state).toBe("unavailable")
			expect(readout.value).toBe("Unavailable")
			expect(readout.sub.length).toBeGreaterThan(0)
		}
		expect(power(emptyHost())).toMatchObject({
			state: "unknown",
			text: "Not measurable",
		})
	})

	it("keeps active under-voltage apart from earlier observed dips", () => {
		const host = emptyHost()
		host.power.undervoltageNow = {
			state: "ok",
			scope: "host",
			observedAt: null,
			ageMs: 100,
			value: false,
			reason: null,
		}
		host.power.undervoltageObserved = {
			state: "ok",
			scope: "service",
			observedAt: null,
			ageMs: 100,
			value: {
				events: 3,
				lastAt: new Date(Date.now() - 120_000).toISOString(),
				since: "2026-10-08T09:00:00.000Z",
				lastAgeMs: 120_000,
				coveredMs: 3_600_000,
			},
			reason: null,
		}
		// No dips in the trend window: fine, with the service-long count.
		host.history = {
			intervalMs: 2000,
			windowMs: 300_000,
			points: [
				[0, 5, 30, 50, 0],
				[2000, 5, 30, 50, 0],
			],
		}
		expect(power(host)).toEqual({
			state: "ok",
			text: "Fine",
			sub: "3 dips in 1 h · last 2 min ago",
		})
		// Recent dips: fine this second, but say how often it dips.
		host.history.points[1]![4] = 2
		expect(power(host)).toEqual({
			state: "warn",
			text: "Fine now",
			sub: "2 dips in 4 s · 3 in 1 h",
		})
	})

	it("tells an unexpected restart from a requested one, and says so only while it is news", () => {
		const host = emptyHost()
		expect(lastBoot(host).unexpected).toBe(false)
		const report = (cleanShutdown: boolean) => ({
			state: "ok" as const,
			scope: "host" as const,
			observedAt: null,
			ageMs: 0,
			reason: null,
			value: {
				previous: {
					lastEntryAt: "2026-10-09T12:02:00+00:00",
					lastEntryAgeMs: 480_000,
					cleanShutdown,
				},
				undervoltageSinceBoot: true,
				throttledSinceBoot: false,
				watchdogReset: null,
			},
		})
		host.lastBoot = report(true)
		expect(lastBoot(host)).toEqual({
			unexpected: false,
			text: "Requested reboot or power-off · last log before it 8 min ago",
			short: "Requested reboot or power-off",
			lastLog: "8 min ago",
		})
		host.lastBoot = report(false)
		host.uptime = {
			state: "ok",
			scope: "host",
			observedAt: null,
			ageMs: 0,
			reason: null,
			value: {
				hostSec: 400,
				hostBootedAt: "",
				containerSec: 300,
				serviceSec: 290,
			},
		}
		// The row names the restart briefly; the full sentence is in `text`.
		expect(readouts(host)?.uptime).toEqual({
			state: "warn",
			value: "6 min",
			sub: "Unexpected restart · under-voltage",
		})
		expect(lastBoot(host).text).toBe(
			"Unexpected restart · last log before it 8 min ago · under-voltage since this boot",
		)
		host.uptime.value!.hostSec = 3 * 86_400
		expect(readouts(host)?.uptime.state).toBe("ok")
	})

	it("maps Wi-Fi signal to bars at documented thresholds", () => {
		expect(
			[-40, -55, -56, -67, -68, -75, -76, -90].map(d => wifiBars(d).bars),
		).toEqual([4, 4, 3, 3, 2, 2, 1, 1])
		expect(wifiBars(-70)).toEqual({ bars: 2, word: "Fair", warn: true })
		const host = emptyHost()
		host.network = {
			state: "ok",
			scope: "host",
			observedAt: null,
			ageMs: 0,
			reason: null,
			value: [
				{
					name: "wlan0",
					kind: "wireless",
					operstate: "up",
					addresses: ["192.0.2.23"],
					rxBytesPerSec: 0,
					txBytesPerSec: 4_500_000,
					wireless: { linkQuality: 60, signalDbm: -47 },
				},
			],
		}
		expect(readouts(host)?.network).toMatchObject({
			state: "ok",
			value: "Wi-Fi · Excellent",
			sub: "\u221247 dBm · 4.50 MB/s out",
			bars: 4,
		})
	})

	it("explains setup progress, interruption and absence", () => {
		const base = {
			scope: "host" as const,
			observedAt: null,
			ageMs: 0,
			reason: null,
		}
		expect(
			setupLine({
				...base,
				state: "ok",
				value: {
					state: "running",
					phase: "install",
					updatedAt: "2026-10-08T10:00:00Z",
					updatedAgeMs: 120_000,
					exitCode: null,
				},
			}).text,
		).toContain("installing the receiver")
		expect(
			setupLine({
				...base,
				state: "ok",
				value: {
					state: "interrupted",
					phase: "install",
					updatedAt: "2026-10-08T10:00:00Z",
					updatedAgeMs: 120_000,
					exitCode: null,
				},
			}).state,
		).toBe("fault")
		expect(setupLine(emptyHost().setup).text).toBe(
			"Not reported: not provided by this install",
		)
	})
})

describe("operator page polling and plot", () => {
	it("scales the flow plot to a round figure above the expected rate", () => {
		expect(plotMax(4_096_000, [[0, 4_100_000]])).toBe(5_000_000)
		expect(plotMax(null, [[0, 4_400_000]])).toBe(5_000_000)
		expect(plotMax(null, [[0, 4_600_000]])).toBe(6_000_000)
		expect(plotMax(null, [])).toBe(1)
	})

	it("goes stale, then offline, and backs off boundedly", () => {
		expect(
			linkState({
				lastSuccessAt: null,
				consecutiveFailures: 0,
				now: 0,
				hidden: false,
			}).state,
		).toBe("connecting")
		expect(
			linkState({
				lastSuccessAt: 0,
				consecutiveFailures: 0,
				now: 3000,
				hidden: false,
			}).state,
		).toBe("live")
		expect(
			linkState({
				lastSuccessAt: 0,
				consecutiveFailures: 1,
				now: 4000,
				hidden: false,
			}).state,
		).toBe("reconnecting")
		expect(
			linkState({
				lastSuccessAt: 0,
				consecutiveFailures: 3,
				now: 20_000,
				hidden: false,
			}),
		).toEqual({
			state: "offline",
			text: "Lost · 20 s ago",
		})
		expect(nextDelay(0)).toBe(3000)
		expect(nextDelay(1)).toBe(6000)
		expect(nextDelay(50)).toBe(30_000)
	})

	it("leaves missing measurements as gaps rather than interpolating", () => {
		const { d } = tracePath(
			[
				[300_000, 4e6],
				[200_000, 4e6],
				[150_000, null],
				[100_000, 4e6],
				[0, 4e6],
			],
			{ windowMs: 300_000, width: 600, height: 200, max: 5e6 },
		)
		expect(d.match(/M/g)).toHaveLength(2)
	})

	it("fills under the trace per unbroken run, down to zero, never across a gap", () => {
		const { area } = tracePath(
			[
				[300_000, 4e6],
				[200_000, 4e6],
				[150_000, null],
				[100_000, 4e6],
				[0, 4e6],
			],
			{ windowMs: 300_000, width: 600, height: 200, max: 5e6 },
		)
		expect(area).toBe(
			"M0.0 200.0L0.0 40.0L200.0 40.0L200.0 200.0L0.0 200.0Z" +
				"M400.0 200.0L400.0 40.0L600.0 40.0L600.0 200.0L400.0 200.0Z",
		)
	})

	it("averages the trace over the server's 10 s rate window without reaching across gaps", () => {
		// Whole-chunk counts alternate around the true rate at a 2 s poll.
		const points: Array<[number, number | null]> = [
			[20_000, 4.2e6],
			[18_000, 4.0e6],
			[16_000, 4.2e6],
			[14_000, 4.0e6],
			[12_000, 4.2e6],
			[10_000, 4.0e6],
			[8_000, null],
			[6_000, 1e6],
			[4_000, 3e6],
		]
		const smooth = smoothTrace(points)
		expect(smooth[0]).toEqual([20_000, 4.2e6])
		expect(smooth[4]?.[1]).toBeCloseTo(4.12e6)
		expect(smooth[5]?.[1]).toBeCloseTo(4.08e6)
		// The gap survives, and the run after it starts fresh.
		expect(smooth[6]).toEqual([8_000, null])
		expect(smooth[7]).toEqual([6_000, 1e6])
		expect(smooth[8]).toEqual([4_000, 2e6])
	})
})

describe("operator page review fixes", () => {
	const setupReading = (
		state: "running" | "complete" | "failed" | "interrupted",
	): SdrHostTelemetry["setup"] => ({
		state: "ok",
		scope: "host",
		observedAt: null,
		ageMs: 0,
		reason: null,
		value: {
			state,
			phase: "install",
			updatedAt: "2026-10-08T10:00:00Z",
			updatedAgeMs: 120_000,
			exitCode: state === "failed" ? 23 : null,
		},
	})

	it("leads with setup, not a fault, while first boot is still installing", () => {
		const host = emptyHost()
		host.setup = setupReading("running")
		const stale = status(
			sampling({ state: "stale", lastSampleAt: null, sampleAgeMs: null }),
		)
		expect(verdict({ status: stale, host, fresh: true })).toMatchObject({
			state: "unknown",
			title: "Setting up",
		})
		host.setup = setupReading("failed")
		expect(verdict({ status: stale, host, fresh: true })).toMatchObject({
			state: "fault",
			title: "Setup did not finish",
		})
		host.setup = setupReading("complete")
		expect(verdict({ status: stale, host, fresh: true }).title).toBe(
			"Samples stopped",
		)
		// Flow evidence always wins over setup bookkeeping.
		host.setup = setupReading("running")
		expect(
			verdict({ status: status(sampling()), host, fresh: true }).title,
		).toBe("Sampling")
	})

	it("states what the evidence shows when samples stop with everything present", () => {
		const v = verdict({
			status: status(sampling({ state: "stale", sampleAgeMs: 60_000 })),
			host: null,
			fresh: true,
		})
		expect(v.detail).toContain("rtl_tcp is not delivering samples")
	})

	it("reads the marker to the second and counts dips in words", () => {
		expect(formatAgePrecise(84_000)).toBe("1 min 24 s ago")
		expect(formatAgePrecise(42_400)).toBe("42 s ago")
		const host = emptyHost()
		host.power.undervoltageNow = {
			state: "ok",
			scope: "host",
			observedAt: null,
			ageMs: 0,
			value: true,
			reason: null,
		}
		host.power.undervoltageObserved = {
			state: "ok",
			scope: "service",
			observedAt: null,
			ageMs: 0,
			value: {
				events: 1,
				lastAt: new Date().toISOString(),
				since: "2026-10-08T09:00:00.000Z",
				lastAgeMs: 500,
				coveredMs: 3_600_000,
			},
			reason: null,
		}
		expect(power(host)).toMatchObject({
			state: "fault",
			text: "Under-voltage now",
			sub: "1 dip in 1 h",
		})
	})
})

describe("operator page keeps its shape", () => {
	it("reports first-boot setup as a row in every state", () => {
		const reading = (
			state: "running" | "complete" | "failed" | "interrupted",
		): SdrHostTelemetry["setup"] => ({
			state: "ok",
			scope: "host",
			observedAt: null,
			ageMs: 0,
			reason: null,
			value: {
				state,
				phase: "install",
				updatedAt: "2026-10-08T10:00:00Z",
				updatedAgeMs: 120_000,
				exitCode: state === "failed" ? 23 : null,
			},
		})
		expect(setupRow(reading("complete"))).toEqual({
			state: "ok",
			text: "Complete",
			sub: "Finished 2 min ago",
		})
		expect(setupRow(reading("running"))).toMatchObject({
			state: "ok",
			sub: "Installing the receiver for 2 min",
		})
		expect(setupRow(reading("failed"))).toMatchObject({
			state: "fault",
			text: "Failed (exit 23)",
		})
		expect(setupRow(reading("interrupted")).state).toBe("fault")
		expect(setupRow(emptyHost().setup)).toMatchObject({
			state: "unknown",
			text: "Not reported",
		})
	})

	it("lists the same diagnostics terms with or without a reading", () => {
		const empty = diagnostics({ status: null, host: null })
		const full = diagnostics({ status: status(sampling()), host: emptyHost() })
		expect(full.map(g => [g.key, g.facts.map(f => f.term)])).toEqual(
			empty.map(g => [g.key, g.facts.map(f => f.term)]),
		)
		// Nothing known yet: every value is a dash, never a guess.
		for (const group of empty)
			for (const fact of group.facts) expect(fact.value).toBe("—")
		// An unmeasurable source says so, with its reason as a note.
		const sources = full.find(g => g.key === "sources")!.facts
		expect(sources.find(f => f.term === "CPU")).toMatchObject({
			tone: "unknown",
			word: "Unavailable",
		})
		expect(sources.find(f => f.term === "CPU")?.note?.length).toBeGreaterThan(0)
	})
})

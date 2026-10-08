import { describe, it, expect } from "vitest"
import type { SdrHostSampling, SdrHostTelemetry } from "@wavekit/api-types"
import { HostCollector } from "../../src/telemetry/host.js"
import { SamplingMonitor } from "../../src/telemetry/sampling.js"
import {
	formatAgePrecise,
	linkState,
	nextDelay,
	power,
	readouts,
	setupLine,
	smoothTrace,
	stages,
	tracePath,
	verdict,
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

	it("names chain stages for the operator and keeps process names as facts", () => {
		const chain = stages(status(sampling()))
		expect(chain?.rtltcp).toMatchObject({ word: "Running", fact: "rtl_tcp" })
		expect(chain?.rtlmux).toMatchObject({ word: "Running", fact: "rtlmux" })
		const restarted = status(sampling())
		restarted.rtlTcp = {
			running: false,
			pid: null,
			restartCount: 2,
			lastRestartAt: null,
		}
		expect(stages(restarted)?.rtltcp).toMatchObject({
			state: "fault",
			word: "Stopped",
			fact: "rtl_tcp · 2 restarts",
		})
	})

	it("keeps zero clients as idle delivery, separate from sampling", () => {
		const chain = stages(status(sampling()))
		expect(chain?.clients).toMatchObject({ state: "idle", word: "None" })
		expect(chain?.dongle).toMatchObject({ state: "ok", word: "Present" })
		expect(stages(status(sampling(), false))?.dongle.state).toBe("fault")
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
		const p = power(emptyHost())
		expect(p.windows.map(w => w.state)).toEqual([
			"unknown",
			"unknown",
			"unknown",
		])
		expect(p.windows.every(w => w.text === "Not measurable")).toBe(true)
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
		const p = power(host)
		expect(p.windows[0]).toMatchObject({ state: "clear", text: "Clear now" })
		expect(p.windows[1]).toMatchObject({
			state: "latched",
			text: "3 dips · last 2 min ago",
		})
		expect(p.note).toContain("not since boot")
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
		const { d, gaps } = tracePath(
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
		expect(gaps).toEqual([[300, 400]])
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

	it("does not light a connected client green when nothing flows out", () => {
		const s = status(sampling())
		s.delivery = {
			...s.delivery!,
			state: "delivering",
			clients: [],
			queuedBytesPerSec: 0,
		}
		expect(stages(s)?.clients.state).toBe("idle")
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
		expect(power(host).windows[1]?.text).toBe("1 dip · just now")
	})
})

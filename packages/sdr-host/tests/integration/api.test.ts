import { describe, it, expect, afterEach, vi } from "vitest"
import { createLogger } from "@wavekit/shared"
import { createApiServer } from "../../src/api/server.js"
import { SdrHostConfigSchema } from "../../src/config.js"
import type {
	ProcessManager,
	ProcessState,
} from "../../src/supervisor/process-manager.js"
import {
	startPreflightMonitoring,
	type PreflightResult,
} from "../../src/supervisor/preflight.js"

const logger = createLogger({ level: "fatal" })

function createProcessManager(
	overrides?: Partial<{
		rtlTcp: ProcessState
		rtlmux: ProcessState
		stats: {
			clients: number
			bytesPerSec: number
			totalBytesSent: number
			clientDetails: Array<{
				id: number
				address: string
				bytesDropped: number
			}>
		}
	}>,
): ProcessManager {
	const rtlTcp =
		overrides?.rtlTcp ??
		({
			running: true,
			pid: 111,
			restartCount: 0,
			lastRestartAt: null,
			lastError: null,
		} as ProcessState)
	const rtlmux =
		overrides?.rtlmux ??
		({
			running: true,
			pid: 222,
			restartCount: 0,
			lastRestartAt: null,
			lastError: null,
		} as ProcessState)
	const stats = overrides?.stats ?? {
		clients: 0,
		bytesPerSec: 0,
		totalBytesSent: 0,
		clientDetails: [],
	}

	return {
		getRtlTcpState: () => rtlTcp,
		getRtlmuxState: () => rtlmux,
		getRtlmuxStats: () => stats,
	} as unknown as ProcessManager
}

function createPreflightResult(
	overrides?: Partial<PreflightResult>,
): PreflightResult {
	return {
		ready: true,
		dongle: {
			present: true,
			product: "RTL2838UHIDIR",
			serial: null,
			usb: { vid: "0bda", pid: "2838", bus: 1, device: 4 },
			driverConflict: false,
			conflictingDriver: null,
		},
		warnings: [],
		errors: [],
		...overrides,
	}
}

describe("sdr-host API", () => {
	let fastify: Awaited<ReturnType<typeof createApiServer>> | null = null
	let stopMonitoring: (() => Promise<void>) | null = null

	afterEach(async () => {
		if (stopMonitoring) {
			await stopMonitoring()
			stopMonitoring = null
		}
		vi.useRealTimers()
		if (fastify) {
			await fastify.close()
			fastify = null
		}
	})

	it("updates health, status errors, and fix instructions after unplugging and reconnecting USB", async () => {
		vi.useFakeTimers()
		const present = createPreflightResult()
		const missing = createPreflightResult({
			ready: false,
			dongle: { ...present.dongle, present: false, usb: null },
			errors: ["No RTL-SDR dongle detected. Check USB connection."],
		})
		const shared = { ...missing }
		let current = present
		stopMonitoring = startPreflightMonitoring(shared, logger, {
			intervalMs: 1000,
			refresh: async () => current,
		})
		fastify = await createApiServer({
			config: SdrHostConfigSchema.parse({}),
			logger,
			processManager: createProcessManager(),
			preflightResult: shared,
		})
		expect(
			(await fastify.inject({ method: "GET", url: "/health" })).statusCode,
		).toBe(503)
		await vi.advanceTimersByTimeAsync(1000)
		expect(
			(await fastify.inject({ method: "GET", url: "/health" })).statusCode,
		).toBe(200)
		expect(
			(await fastify.inject({ method: "GET", url: "/api/fix" })).statusCode,
		).toBe(204)
		expect(
			(await fastify.inject({ method: "GET", url: "/api/status" })).json(),
		).toMatchObject({ dongle: { present: true }, errors: [] })
		current = missing
		await vi.advanceTimersByTimeAsync(1000)
		expect(
			(await fastify.inject({ method: "GET", url: "/health" })).statusCode,
		).toBe(503)
		expect(
			(await fastify.inject({ method: "GET", url: "/api/fix" })).json(),
		).toMatchObject({ issue: "dongle_not_detected" })
		expect(
			(await fastify.inject({ method: "GET", url: "/api/status" })).json(),
		).toMatchObject({ dongle: { present: false }, errors: missing.errors })
	})

	it("returns healthy status when services are running", async () => {
		const config = SdrHostConfigSchema.parse({})
		fastify = await createApiServer({
			config,
			logger,
			processManager: createProcessManager(),
			preflightResult: createPreflightResult(),
		})
		await fastify.ready()

		const response = await fastify.inject({ method: "GET", url: "/health" })
		const payload = response.json() as { healthy: boolean }

		expect(response.statusCode).toBe(200)
		expect(payload.healthy).toBe(true)
	})

	it("reports unhealthy when rtlmux is down", async () => {
		const config = SdrHostConfigSchema.parse({})
		fastify = await createApiServer({
			config,
			logger,
			processManager: createProcessManager({
				rtlmux: {
					running: false,
					pid: undefined,
					restartCount: 0,
					lastRestartAt: null,
					lastError: "rtlmux not running",
				},
			}),
			preflightResult: createPreflightResult(),
		})
		await fastify.ready()

		const response = await fastify.inject({ method: "GET", url: "/health" })
		const payload = response.json() as { healthy: boolean; reason?: string }

		expect(response.statusCode).toBe(503)
		expect(payload.healthy).toBe(false)
		expect(payload.reason).toContain("rtlmux")
	})

	it("uses request hostname when bind is wildcard", async () => {
		const config = SdrHostConfigSchema.parse({
			rtlmux: { bind: "0.0.0.0", port: 5555 },
		})
		fastify = await createApiServer({
			config,
			logger,
			processManager: createProcessManager(),
			preflightResult: createPreflightResult(),
		})
		await fastify.ready()

		const response = await fastify.inject({
			method: "GET",
			url: "/api/status",
			headers: { host: "pi.local:8080" },
		})
		const payload = response.json() as {
			rtlmux: { endpoint: string; statsUrl: string }
		}

		expect(payload.rtlmux.endpoint).toBe("tcp://pi.local:5555")
		expect(payload.rtlmux.statsUrl).toBe("http://pi.local:5556/stats.json")
	})

	it("returns fix instructions for driver conflict", async () => {
		const config = SdrHostConfigSchema.parse({})
		fastify = await createApiServer({
			config,
			logger,
			processManager: createProcessManager(),
			preflightResult: createPreflightResult({
				dongle: {
					present: true,
					product: "RTL2838UHIDIR",
					serial: null,
					usb: { vid: "0bda", pid: "2838", bus: 1, device: 4 },
					driverConflict: true,
					conflictingDriver: "dvb_usb_rtl28xxu",
				},
			}),
		})
		await fastify.ready()

		const response = await fastify.inject({ method: "GET", url: "/api/fix" })
		const payload = response.json() as { issue: string }

		expect(response.statusCode).toBe(200)
		expect(payload.issue).toBe("dvb_driver_conflict")
	})
})

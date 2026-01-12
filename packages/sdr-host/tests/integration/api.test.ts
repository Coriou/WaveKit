import { describe, it, expect, afterEach } from "vitest"
import { createLogger } from "@wavekit/shared"
import { createApiServer } from "../../src/api/server.js"
import { SdrHostConfigSchema } from "../../src/config.js"
import type {
	ProcessManager,
	ProcessState,
} from "../../src/supervisor/process-manager.js"
import type { PreflightResult } from "../../src/supervisor/preflight.js"

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

	afterEach(async () => {
		if (fastify) {
			await fastify.close()
			fastify = null
		}
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

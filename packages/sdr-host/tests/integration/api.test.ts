import { describe, it, expect, afterEach, vi } from "vitest"
import { createLogger } from "@wavekit/shared"
import type { SdrHostTelemetry } from "@wavekit/api-types"
import { createApiServer } from "../../src/api/server.js"
import { SdrHostConfigSchema } from "../../src/config.js"
import { HostCollector } from "../../src/telemetry/host.js"
import { SamplingMonitor } from "../../src/telemetry/sampling.js"
import type {
	ProcessManager,
	ProcessState,
} from "../../src/supervisor/process-manager.js"
import {
	startPreflightMonitoring,
	type PreflightResult,
} from "../../src/supervisor/preflight.js"

const logger = createLogger({ level: "fatal" })
const sampling = new SamplingMonitor({ sampleRate: 2_048_000 })
// No procfs/sysfs: every host reading must be reported unavailable.
const emptyHost = new HostCollector({
	procRoot: "/nonexistent/proc",
	sysRoot: "/nonexistent/sys",
	statusDir: "/nonexistent/status",
	statfsPath: "/nonexistent",
	networkInterfaces: () => ({}),
})

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
		getSampling: () => sampling.sampling(),
		getDelivery: () => sampling.delivery(),
		getSamplingHistory: () => sampling.recentHistory(),
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
			hostTelemetry: emptyHost,
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
			hostTelemetry: emptyHost,
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
			hostTelemetry: emptyHost,
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
			hostTelemetry: emptyHost,
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
			hostTelemetry: emptyHost,
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

describe("operator page and telemetry API", () => {
	let fastify: Awaited<ReturnType<typeof createApiServer>> | null = null

	afterEach(async () => {
		await fastify?.close()
		fastify = null
	})

	const create = async (config = SdrHostConfigSchema.parse({})) => {
		fastify = await createApiServer({
			hostTelemetry: emptyHost,
			config,
			logger,
			processManager: createProcessManager(),
			preflightResult: createPreflightResult(),
		})
		await fastify.ready()
		return fastify
	}

	it("keeps legacy status keys and adds sampling evidence separately", async () => {
		const app = await create()
		const response = await app.inject({ method: "GET", url: "/api/status" })
		const payload = response.json() as {
			rtlmux: Record<string, unknown>
			sampling: unknown
			delivery: unknown
			samplingHistory: unknown
		}
		expect(response.headers["cache-control"]).toBe("no-store")
		expect(Object.keys(payload.rtlmux)).toEqual(
			expect.arrayContaining([
				"running",
				"pid",
				"endpoint",
				"statsUrl",
				"stats",
			]),
		)
		expect(payload.rtlmux["stats"]).toEqual({
			clients: 0,
			bytesPerSec: 0,
			totalBytesSent: 0,
			clientDetails: [],
		})
		expect(payload.sampling).toMatchObject({
			timeoutMs: 10_000,
			upstream: { expectedBytesPerSec: 4_096_000 },
		})
		expect(payload.delivery).toHaveProperty("state")
		expect(payload.samplingHistory).toMatchObject({
			pollIntervalMs: 2000,
			windowMs: 300_000,
		})
	})

	it("adds informational sampling to /health without changing its verdict", async () => {
		const app = await create()
		const response = await app.inject({ method: "GET", url: "/health" })
		const payload = response.json() as {
			healthy: boolean
			sampling: string
			checks: object
		}
		expect(response.statusCode).toBe(200)
		expect(payload.healthy).toBe(true)
		expect(payload.checks).toEqual({ dongle: "ok", rtlTcp: "ok", rtlmux: "ok" })
		expect([
			"waiting",
			"unknown",
			"disconnected",
			"streaming",
			"stale",
		]).toContain(payload.sampling)
	})

	it("serves host telemetry with explicit unavailable states", async () => {
		const app = await create()
		const response = await app.inject({ method: "GET", url: "/api/host" })
		const payload = response.json() as SdrHostTelemetry
		expect(response.statusCode).toBe(200)
		expect(response.headers["cache-control"]).toBe("no-store")
		expect(payload.cpu).toMatchObject({ state: "unavailable", value: null })
		expect(payload.power.throttling.state).toBe("unavailable")
	})

	it("does not let arbitrary sites read the API, but honours an allowlist", async () => {
		let app = await create()
		let response = await app.inject({
			method: "GET",
			url: "/api/host",
			headers: { origin: "https://evil.example" },
		})
		expect(response.headers["access-control-allow-origin"]).toBeUndefined()
		await app.close()
		app = await create(
			SdrHostConfigSchema.parse({
				api: { corsOrigins: "http://laptop.local:3000" },
			}),
		)
		response = await app.inject({
			method: "GET",
			url: "/api/host",
			headers: { origin: "http://laptop.local:3000" },
		})
		expect(response.headers["access-control-allow-origin"]).toBe(
			"http://laptop.local:3000",
		)
	})

	it("serves the page same-origin with a strict CSP, revalidation and compression", async () => {
		const app = await create()
		const page = await app.inject({
			method: "GET",
			url: "/",
			headers: { "accept-encoding": "gzip" },
		})
		expect(page.statusCode).toBe(200)
		expect(page.headers["content-type"]).toContain("text/html")
		expect(page.headers["content-encoding"]).toBe("gzip")
		expect(page.headers["content-security-policy"]).toContain(
			"default-src 'none'",
		)
		expect(page.headers["content-security-policy"]).toContain(
			"connect-src 'self'",
		)
		const etag = page.headers.etag as string
		const again = await app.inject({
			method: "GET",
			url: "/",
			headers: { "if-none-match": etag },
		})
		expect(again.statusCode).toBe(304)
		const script = await app.inject({ method: "GET", url: "/app.js" })
		expect(script.headers["content-type"]).toContain("text/javascript")
		expect(script.body).toContain("api/host")
		const font = await app.inject({
			method: "GET",
			url: "/brand/D-DINCondensed.woff2",
		})
		expect(font.headers["cache-control"]).toContain("max-age")
		expect(
			(await app.inject({ method: "GET", url: "/../src/index.ts" })).statusCode,
		).toBe(404)
		expect(
			(await app.inject({ method: "GET", url: "/brand/OFL-D-DIN.txt" }))
				.statusCode,
		).toBe(404)
	})
})

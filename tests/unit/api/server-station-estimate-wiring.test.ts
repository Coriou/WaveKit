/**
 * GET /api/station/estimate through the real ApiServer (WG4 req 2, Main wiring): the
 * estimator passed in the dependencies serves the route without a prefix; without one the
 * route is not mounted. In protected mode it is an ordinary authenticated read.
 */

import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { StationEstimate } from "@wavekit/api-types"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeOptions } from "../../../src/access/runtime-context.js"
import { createStationEstimator } from "../../../src/core/station-estimate/provider.js"
import type { StationEstimateProvider } from "../../../src/core/station-estimate/contract.js"

const origin = "http://receiver.lan:9000"
const host = "receiver.lan:9000"

function runtimeOptions(directory: string): NamedAccessRuntimeOptions {
	return {
		directory,
		ownership: "single-host-pid-namespace",
		bootstrap: {
			mode: "protected",
			listenerScheme: "http",
			allowedAuthorities: [host],
			allowedOrigins: [origin],
			externalAudioOrigins: [
				"http://receiver.lan:9001",
				"http://receiver.lan:9002",
			],
		},
		audio: {
			analog: {
				listenerScheme: "http",
				allowedAuthorities: ["receiver.lan:9001"],
			},
			digital: {
				listenerScheme: "http",
				allowedAuthorities: ["receiver.lan:9002"],
			},
		},
	}
}

function dependencies(
	stationEstimate: StationEstimateProvider | undefined,
	access?: ApiServerDependencies["access"],
): ApiServerDependencies {
	return {
		...(stationEstimate ? { stationEstimate } : {}),
		...(access ? { access } : {}),
		logger: pino({ level: "silent" }),
		sourceManager: Object.assign(new EventEmitter(), {
			getAllStatus: () => [],
		}),
		decoderManager: Object.assign(new EventEmitter(), {
			getAllDecoders: () => [],
			getAllStatus: () => [],
			getAllHealth: () => new Map(),
		}),
		fanoutManager: Object.assign(new EventEmitter(), {
			getTelemetrySnapshot: () => ({
				timestamp: new Date().toISOString(),
				branches: [],
				backpressureActiveCount: 0,
				droppedBytesTotal: 0,
				droppedChunksTotal: 0,
			}),
		}),
		audioOutput: Object.assign(new EventEmitter(), {
			getConnectedClients: () => 0,
			getPort: () => 0,
		}),
	} as unknown as ApiServerDependencies
}

function estimator(): StationEstimateProvider {
	return createStationEstimator({
		aircraft: () => [],
		vessels: () => [],
		aprs: () => [],
		mesh: () => [],
		stationConfigured: () => false,
	})
}

describe("station estimate through the API server", () => {
	const cleanup: Array<() => Promise<void>> = []

	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step()
	})

	async function open(
		stationEstimate: StationEstimateProvider | undefined,
	): Promise<ApiServer> {
		const server = new ApiServer(dependencies(stationEstimate), {
			host: "127.0.0.1",
			port: 0,
		})
		cleanup.push(() => server.stop())
		await server.start()
		return server
	}

	it("mounts GET and HEAD /api/station/estimate when the estimator is present", async () => {
		const app = (await open(estimator())).getApp()
		const get = await app.inject({
			method: "GET",
			url: "/api/station/estimate",
		})
		expect(get.statusCode).toBe(200)
		expect(get.headers["cache-control"]).toBe("no-store")
		const body = get.json<StationEstimate>()
		expect(body.available).toBe(false)
		expect(body.reason).toBe("too-few-positions")
		const head = await app.inject({
			method: "HEAD",
			url: "/api/station/estimate",
		})
		expect(head.statusCode).toBe(200)
		expect(head.body).toBe("")
	})

	it("answers 404 when no estimator is wired", async () => {
		const app = (await open(undefined)).getApp()
		for (const method of ["GET", "HEAD"] as const)
			expect(
				(await app.inject({ method, url: "/api/station/estimate" })).statusCode,
			).toBe(404)
	})

	it("is an ordinary authenticated read in protected mode", async () => {
		const root = await fs.mkdtemp(join(tmpdir(), "station-estimate-wiring-"))
		cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
		const directory = join(root, "private")
		const storage = await PrivateAccessStorage.open({
			directory,
			ownership: "single-host-pid-namespace",
			mode: "provision",
		})
		const token = storage.useMachineCredential(value => value)
		await storage.close()
		const access = await openAccessRuntime(runtimeOptions(directory))
		cleanup.push(() => access.close())
		const server = new ApiServer(dependencies(estimator(), access), {
			host: "127.0.0.1",
			port: 0,
			accessBootstrap: runtimeOptions(directory).bootstrap,
			publicOrigins: {
				api: origin,
				analogAudio: "http://receiver.lan:9001",
				digitalAudio: "http://receiver.lan:9002",
			},
		})
		cleanup.push(() => server.stop())
		await server.start()
		const app = server.getApp()
		for (const method of ["GET", "HEAD"] as const) {
			const authorized = await app.inject({
				method,
				url: "/api/station/estimate",
				headers: { host, authorization: `Bearer ${token}` },
			})
			expect(authorized.statusCode).toBe(200)
			const anonymous = await app.inject({
				method,
				url: "/api/station/estimate",
				headers: { host },
			})
			expect(anonymous.statusCode).toBe(401)
		}
		expect(
			(
				await app.inject({
					method: "POST",
					url: "/api/station/estimate",
					headers: { host, authorization: `Bearer ${token}` },
				})
			).statusCode,
		).toBe(404)
	})
})

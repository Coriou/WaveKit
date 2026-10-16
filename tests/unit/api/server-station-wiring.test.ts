/**
 * Live station identity through the real ApiServer (WG4 req 6, Main wiring): GET serves the
 * service's identity; PATCH mounts only with the access controller while
 * STATION_WRITE_REQUIRES_ACCESS; a PATCH that moves the station more than 1 km resets
 * coverage, and readsb reads the new location at its next start.
 */

import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type {
	AircraftState,
	CoverageResponse,
	StationIdentity,
	StationUpdateResult,
} from "@wavekit/api-types"
import { ApiServer } from "../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../src/api/server.js"
import { ConfigSchema } from "../../../src/config.js"
import { PrivateAccessStorage } from "../../../src/access/private-storage.js"
import { openAccessRuntime } from "../../../src/access/runtime-context.js"
import type { NamedAccessRuntimeOptions } from "../../../src/access/runtime-context.js"
import { openStationService } from "../../../src/core/station/station-service.js"
import { STATION_WRITE_REQUIRES_ACCESS } from "../../../src/core/station/contract.js"
import type { StationService } from "../../../src/core/station/contract.js"
import { CoverageManager } from "../../../src/core/coverage/coverage-manager.js"
import { readsbDecoderFactory } from "../../../src/decoders/builtin/readsb.js"

const origin = "http://receiver.lan:9000"
const host = "receiver.lan:9000"
const logger = pino({ level: "silent" })
const NOW = Date.parse("2026-10-16T12:00:00.000Z")

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
	extra: Partial<ApiServerDependencies>,
): ApiServerDependencies {
	return {
		...extra,
		logger,
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

function readsbLocation(station: () => { lat: number; lon: number } | null) {
	const decoder = readsbDecoderFactory(station)(
		{
			id: "adsb",
			type: "readsb",
			enabled: true,
			options: { outputFormat: "sbs" },
		},
		logger,
	)
	const argv = (decoder as unknown as { getArgs(): string[] }).getArgs()
	const joined = argv.join(" ")
	const lat = /--lat (\S+)/.exec(joined)?.[1]
	const lon = /--lon (\S+)/.exec(joined)?.[1]
	return lat === undefined || lon === undefined ? null : [lat, lon]
}

describe("station service through the API server", () => {
	const cleanup: Array<() => Promise<void> | void> = []

	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step()
	})

	async function stateDir(): Promise<string> {
		const root = await fs.mkdtemp(join(tmpdir(), "station-wiring-"))
		cleanup.push(() => fs.rm(root, { recursive: true, force: true }))
		return root
	}

	async function service(
		root: string,
		writable: boolean,
		onLocationChange?: (location: { lat: number; lon: number } | null) => {
			cleared: boolean
		},
	): Promise<StationService> {
		const opened = await openStationService({
			config: ConfigSchema.parse({}),
			region: "EU",
			stateDir: join(root, "state"),
			logger,
			writable,
			...(onLocationChange ? { onLocationChange } : {}),
		})
		cleanup.push(() => opened.close())
		return opened
	}

	it("serves the live identity in legacy mode and mounts PATCH only when the constant allows", async () => {
		const root = await stateDir()
		const station = await service(root, !STATION_WRITE_REQUIRES_ACCESS)
		const server = new ApiServer(
			dependencies({ station: station.identity(), stationService: station }),
			{ host: "127.0.0.1", port: 0 },
		)
		cleanup.push(() => server.stop())
		await server.start()
		const app = server.getApp()
		await station.update({ name: "Roof" })
		const get = await app.inject({ method: "GET", url: "/api/station" })
		expect(get.statusCode).toBe(200)
		const identity = get.json<StationIdentity>()
		expect(identity.name).toEqual({ value: "Roof", provenance: "ui" })
		expect(identity.writable).toBe(!STATION_WRITE_REQUIRES_ACCESS)
		const patch = await app.inject({
			method: "PATCH",
			url: "/api/station",
			payload: { name: "Mast" },
		})
		if (STATION_WRITE_REQUIRES_ACCESS) expect(patch.statusCode).toBe(404)
		else expect(patch.statusCode).toBe(200)
	})

	it("mounts an authorized PATCH in protected mode, resets coverage on a far move and feeds readsb", async () => {
		const root = await stateDir()
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

		// Same composition as src/index.ts: the service exists before coverage, which
		// is wired through onLocationChange once built.
		let apply = (
			_location: { lat: number; lon: number } | null,
		): { cleared: boolean } => ({ cleared: false })
		const station = await service(root, true, location => apply(location))
		const air = new EventEmitter()
		const coverage = new CoverageManager({
			station: station.location(),
			aircraft: air,
			now: () => NOW,
		})
		apply = location => coverage.setStation(location)
		coverage.start()
		cleanup.push(() => coverage.stop())
		const readsb = () => station.location()
		expect(readsbLocation(readsb)).toBeNull()

		const server = new ApiServer(
			dependencies({
				station: station.identity(),
				stationService: station,
				access,
				coverage,
			}),
			{
				host: "127.0.0.1",
				port: 0,
				accessBootstrap: runtimeOptions(directory).bootstrap,
				publicOrigins: {
					api: origin,
					analogAudio: "http://receiver.lan:9001",
					digitalAudio: "http://receiver.lan:9002",
				},
			},
		)
		cleanup.push(() => server.stop())
		await server.start()
		const app = server.getApp()
		const authorized = { host, authorization: `Bearer ${token}` }
		const patch = (
			payload: Record<string, unknown>,
			headers: Record<string, string> = authorized,
		) => app.inject({ method: "PATCH", url: "/api/station", headers, payload })
		const accepted = async () =>
			(
				await app.inject({
					method: "GET",
					url: "/api/coverage?protocol=adsb",
					headers: authorized,
				})
			).json<CoverageResponse>()

		expect((await patch({ lat: 0, lon: 0 }, { host })).statusCode).toBe(401)
		const first = await patch({ lat: 0, lon: 0 })
		expect(first.statusCode).toBe(200)
		expect(first.json<StationUpdateResult>().appliesOnRestart).toEqual([
			"readsb",
		])
		expect(readsbLocation(readsb)).toEqual(["0", "0"])

		air.emit("aircraft:new", {
			icao: "ABC123",
			position: { lat: 0.5, lon: 0 },
			lastUpdated: NOW,
		} as AircraftState)
		let body = await accepted()
		expect(body.station).toEqual({ lat: 0, lon: 0 })
		expect(body.protocols.map(p => p.accepted)).toEqual([1])

		// About 1 m: the map survives
		const near = await patch({ lat: 0.00001, lon: 0 })
		expect(near.json<StationUpdateResult>().coverageCleared).toBe(false)
		expect((await accepted()).protocols.map(p => p.accepted)).toEqual([1])

		// About 55 km: the map is cleared and readsb picks the new pair at its next start
		const far = await patch({ lat: 0.5, lon: 0 })
		expect(far.statusCode).toBe(200)
		expect(far.json<StationUpdateResult>().coverageCleared).toBe(true)
		body = await accepted()
		expect(body.station).toEqual({ lat: 0.5, lon: 0 })
		expect(body.protocols.every(p => p.accepted === 0)).toBe(true)
		expect(readsbLocation(readsb)).toEqual(["0.5", "0"])

		const identity = (
			await app.inject({
				method: "GET",
				url: "/api/station",
				headers: authorized,
			})
		).json<StationIdentity>()
		expect(identity.writable).toBe(true)
		expect(identity.lat).toEqual({ value: 0.5, provenance: "ui" })
	})
})

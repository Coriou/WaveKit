/**
 * The transmission composition src/index.ts uses (composeTransmissions): one registry reaches
 * every producer port and the route (the same instance), a claim through each port reads back
 * through GET /api/transmissions/:ref on the real ApiServer, a lost source and a new spectrum
 * epoch close what they should, and stop() ends the sweep.
 */
import { EventEmitter } from "node:events"
import pino from "pino"
import { afterEach, describe, expect, it } from "vitest"
import type { TransmissionDto } from "@wavekit/api-types"
import { ApiServer } from "../../../../src/api/server.js"
import type { ApiServerDependencies } from "../../../../src/api/server.js"
import { composeTransmissions } from "../../../../src/core/transmissions/compose.js"
import type { TransmissionComposition } from "../../../../src/core/transmissions/compose.js"
import { TX_ID } from "../../../../src/core/transmissions/index.js"

const logger = pino({ level: "silent" })

function serverDeps(
	extra: Partial<ApiServerDependencies>,
): ApiServerDependencies {
	return {
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
		...extra,
	} as unknown as ApiServerDependencies
}

describe("transmission composition", () => {
	const cleanup: (() => Promise<void> | void)[] = []
	afterEach(async () => {
		for (const step of cleanup.splice(0).reverse()) await step()
	})

	function compose(now = 1_000_000): TransmissionComposition {
		const c = composeTransmissions({ logger, now: () => now })
		cleanup.push(() => c.stop())
		return c
	}

	it("every producer port and the route hold the same registry", () => {
		const c = compose()
		const registry = c.wiring.registry
		expect(c.scanner.transmissions).toBe(registry)
		expect(c.liveDemod.transmissions).toBe(registry)
		expect(c.api.transmissions).toBe(registry)
		const decoder = c.dsdFmeFactory(
			{ id: "dv-a", type: "dsd-fme", enabled: true, options: {} },
			logger,
		)
		expect((decoder as unknown as { txPort: unknown }).txPort).toBe(registry)
		// Two decoders of the factory share it too.
		const other = c.dsdFmeFactory(
			{ id: "dv-b", type: "dsd-fme", enabled: true, options: {} },
			logger,
		)
		expect((other as unknown as { txPort: unknown }).txPort).toBe(registry)
	})

	it("a claim through each port reads back through the API server's route", async () => {
		const c = compose()
		const live = c.liveDemod.transmissions.claim({
			origin: "live-demod",
			kind: "voice-analog",
			sourceId: "src-a",
			hz: 100_000_000,
			halfWidthHz: 6_000,
			atMs: 1_000_000,
			alias: "evt:live-1",
		})
		const obs = c.scanner.transmissions.claim({
			origin: "scanner-observation",
			kind: "voice-analog",
			sourceId: "src-a",
			hz: 120_000_000,
			halfWidthHz: 6_000,
			epoch: 1,
			stream: 0,
			sample: 0,
			atMs: 1_000_000,
			alias: "obs:obs-1",
		})
		const call = c.wiring.dv.claim({
			origin: "dv-call",
			kind: "voice-digital",
			sourceId: null,
			dvKey: "dv:dv-a",
			lane: 1,
			run: "dv-a#1",
			atMs: 1_000_000,
			alias: "call:dv-a:c1",
		})
		for (const r of [live, obs, call]) expect(r?.txId).toMatch(TX_ID)

		const server = new ApiServer(serverDeps({ ...c.api }), {
			host: "127.0.0.1",
			port: 0,
		})
		cleanup.push(() => server.stop())
		await server.start()
		const app = server.getApp()
		const read = async (ref: string) =>
			app.inject({
				method: "GET",
				url: `/api/transmissions/${encodeURIComponent(ref)}`,
			})
		for (const [ref, id] of [
			[live!.txId, live!.txId],
			["evt:live-1", live!.txId],
			["obs:obs-1", obs!.txId],
			[call!.txId, call!.txId],
		] as const) {
			const res = await read(ref)
			expect(res.statusCode).toBe(200)
			expect(res.json<TransmissionDto>().id).toBe(id)
		}
		const dv = (await read(call!.txId)).json<TransmissionDto>()
		expect(dv.kind).toBe("voice-digital")
		// No call row links a file: an unproven call lists no audio.
		expect(dv.privacy).toBe("unproven")
		expect(dv.artefacts).toEqual([])
	})

	it("a lost source closes its transmissions; a new spectrum epoch closes the older epochs'", () => {
		const c = compose()
		const sources = new EventEmitter()
		const spectrum = new EventEmitter()
		const unbindSources = c.bindSources(sources)
		const unbindSpectrum = c.bindSpectrum(spectrum)
		const claim = (sourceId: string, hz: number, epoch: number) =>
			c.scanner.transmissions.claim({
				origin: "scanner-observation",
				kind: "voice-analog",
				sourceId,
				hz,
				halfWidthHz: 6_000,
				epoch,
				stream: 0,
				sample: 0,
				atMs: 1_000_000,
				alias: `obs:${sourceId}-${hz}-${epoch}`,
			})!.txId
		const a1 = claim("src-a", 100_000_000, 1)
		const a2 = claim("src-a", 101_000_000, 2)
		const b1 = claim("src-b", 100_000_000, 1)
		const registry = c.wiring.registry
		spectrum.emit("pipeline", "src-a", {
			kind: "epoch-started",
			epoch: 2,
			startSample: 0,
			settleMode: "none",
		})
		expect(registry.get(a1)?.close).toBe("retune")
		expect(registry.get(a2)?.state).toBe("open")
		expect(registry.get(b1)?.state).toBe("open")
		sources.emit("disconnected", "src-b")
		expect(registry.get(b1)?.close).toBe("source-lost")
		expect(registry.get(a2)?.state).toBe("open")
		unbindSources()
		unbindSpectrum()
		expect(sources.listenerCount("disconnected")).toBe(0)
		expect(spectrum.listenerCount("pipeline")).toBe(0)
	})
})

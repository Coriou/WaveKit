/**
 * The production wiring of analog transmissions (WG1 req 3.2, 3.4, 3.9, 4.1,
 * 4.5): squelch edges on a live demodulator reach `live-audio` WebSocket
 * subscribers and, when Activity is ready, the store.
 */

import { EventEmitter } from "node:events"
import { readdir, rm } from "node:fs/promises"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { TunerState } from "@wavekit/api-types"
import { WebSocketEventBroadcaster } from "../../../src/api/websocket/events.js"
import { GracefulShutdown } from "../../../src/utils/graceful-shutdown.js"
import { startActivityRuntime } from "../../../src/core/activity/runtime.js"
import type { ActivityRuntime } from "../../../src/core/activity/runtime.js"
import {
	tunerFrequencyAt,
	wireAnalogTransmissions,
} from "../../../src/core/analog-transmission.js"
import type { AnalogTransmissionSource } from "../../../src/core/analog-transmission.js"
import type {
	LiveDemodConfig,
	LiveDemodStatus,
} from "../../../src/core/live-demodulator.js"
import {
	logger,
	readRecords,
	roots,
	tempDir,
} from "./activity/storage/helpers.js"

class FakeDemod extends EventEmitter implements AnalogTransmissionSource {
	open = false
	readonly config: LiveDemodConfig = {
		enabled: true,
		sourceId: "rtl0",
		httpPort: 8081,
		modulation: "nfm",
		bandwidth: 12_500,
		squelch: -40,
		squelchMode: "manual",
		noiseReduction: "off",
		lowPass: 0,
		highPass: 0,
		gain: 2,
		deEmphasis: false,
		deEmphasisTau: 50,
		audioFormat: "s16le",
		iqDcBlock: false,
		offsetHz: 6_250,
	}

	getStatus(): LiveDemodStatus {
		return {
			enabled: true,
			running: true,
			sourceId: "rtl0",
			sourceConnected: true,
			sourceIqSampleRate: 2_048_000,
			config: this.config,
			effectiveSampleRate: 25_000,
			decimationFactor: 1,
			httpUrl: "http://127.0.0.1/stream",
			wavUrl: "http://127.0.0.1/stream.wav",
			clientCount: 0,
			bytesStreamed: 0,
			pipelineHealth: "running",
			pipelineRestarts: 0,
			squelchOpen: this.open,
			thresholdDbfs: -40,
		}
	}
	isSquelchOpen(): boolean {
		return this.open
	}
	squelchHangMs(): number {
		return 250
	}
	gate(open: boolean): void {
		this.open = open
		this.emit("squelch-changed", open)
	}
}

function liveAudioClient(broadcaster: WebSocketEventBroadcaster) {
	const messages: { type: string; channel: string; data: unknown }[] = []
	;(broadcaster as unknown as { clients: Map<string, unknown> }).clients.set(
		"c1",
		{
			socket: {
				readyState: 1,
				bufferedAmount: 0,
				send: (d: string) => messages.push(JSON.parse(d) as never),
				close: vi.fn(),
				on: vi.fn(),
			},
			subscriptions: new Set(["live-audio"]),
			id: "c1",
		},
	)
	return messages
}

const tuner = (state: Partial<TunerState> | undefined) =>
	tunerFrequencyAt(() =>
		state
			? { frequency: 446_000_000, controlMode: "internal", ...state }
			: undefined,
	)

const runtimes: ActivityRuntime[] = []

afterEach(async () => {
	await Promise.all(runtimes.splice(0).map(r => r.close()))
	await Promise.all(
		roots.splice(0).map(root => rm(root, { recursive: true, force: true })),
	)
})

describe("analog transmission wiring", () => {
	it("sends open and closed on live-audio and stores one record when Activity is ready", async () => {
		const stateDir = await tempDir()
		const runtime = await startActivityRuntime({
			enabled: true,
			stateDir,
			logger,
			execution: "inline",
			queryExecution: "inline",
			limits: { batchWindowMs: 0 },
			setPublisher: () => {},
		})
		runtimes.push(runtime)
		expect(runtime.status).toBe("ready")
		const broadcaster = new WebSocketEventBroadcaster(logger)
		const messages = liveAudioClient(broadcaster)
		const demod = new FakeDemod()
		let now = 1_760_000_000_000
		const tracker = wireAnalogTransmissions({
			source: demod,
			frequencyAt: tuner({}),
			broadcast: e => broadcaster.broadcastLiveAudioTransmission(e),
			sink: () => runtime.transmissionSink(),
			now: () => now,
		})
		demod.gate(true)
		now += 3_000
		demod.gate(false)
		tracker.stop()

		const tx = messages.filter(m => m.type === "live-audio:transmission")
		expect(
			tx.map(m => [m.channel, (m.data as { state: string }).state]),
		).toEqual([
			["live-audio", "open"],
			["live-audio", "closed"],
		])
		const closed = tx[1]?.data as {
			transmissionId: string
			frequency: unknown
			closeReason: string
		}
		expect(closed.frequency).toEqual({
			hz: 446_006_250,
			tuningTrust: "commanded",
		})
		expect(closed.closeReason).toBe("squelch")
		const records = await readRecords(join(stateDir, "activity", "activity.db"))
		expect(records).toHaveLength(1)
		expect(records[0]).toMatchObject({
			kind: "analog-transmission",
			eventId: closed.transmissionId,
		})
	})

	// Main registers "api-server", then "activity", then "analog-transmissions"
	// (src/index.ts); LIFO runs the tracker first. Moving either teardown ahead
	// of it loses the final close on WS or in the store.
	it("stores and sends the final close of an open transmission at the real shutdown order", async () => {
		const stateDir = await tempDir()
		const runtime = await startActivityRuntime({
			enabled: true,
			stateDir,
			logger,
			execution: "inline",
			queryExecution: "inline",
			limits: { batchWindowMs: 0 },
			setPublisher: () => {},
		})
		runtimes.push(runtime)
		expect(runtime.status).toBe("ready")
		const broadcaster = new WebSocketEventBroadcaster(logger)
		const messages = liveAudioClient(broadcaster)
		const demod = new FakeDemod()
		const tracker = wireAnalogTransmissions({
			source: demod,
			frequencyAt: tuner({}),
			broadcast: e => broadcaster.broadcastLiveAudioTransmission(e),
			sink: () => runtime.transmissionSink(),
		})
		const shutdown = new GracefulShutdown({ logger })
		shutdown.register({
			name: "api-server",
			handler: async () => {
				broadcaster.closeAll()
			},
			timeout: 1000,
		})
		shutdown.register({
			name: "activity",
			handler: () => runtime.close(),
			timeout: 5000,
		})
		shutdown.register({
			name: "analog-transmissions",
			handler: async () => {
				tracker.stop()
			},
			timeout: 1000,
		})
		demod.gate(true)
		await shutdown.shutdown()

		const tx = messages.filter(m => m.type === "live-audio:transmission")
		expect(tx.map(m => (m.data as { state: string }).state)).toEqual([
			"open",
			"closed",
		])
		const closed = tx[1]?.data as {
			transmissionId: string
			closeReason: string
		}
		expect(closed.closeReason).toBe("stopped")
		const records = await readRecords(join(stateDir, "activity", "activity.db"))
		expect(records.map(r => [r.kind, r.eventId])).toEqual([
			["analog-transmission", closed.transmissionId],
		])
	})

	it("still sends both events with Activity disabled and stores nothing", async () => {
		const stateDir = await tempDir()
		const runtime = await startActivityRuntime({
			enabled: false,
			stateDir,
			logger,
			setPublisher: () => {},
		})
		runtimes.push(runtime)
		const broadcaster = new WebSocketEventBroadcaster(logger)
		const messages = liveAudioClient(broadcaster)
		const demod = new FakeDemod()
		const tracker = wireAnalogTransmissions({
			source: demod,
			frequencyAt: tuner({}),
			broadcast: e => broadcaster.broadcastLiveAudioTransmission(e),
			sink: () => runtime.transmissionSink(),
		})
		demod.gate(true)
		tracker.stop()
		const tx = messages.filter(m => m.type === "live-audio:transmission")
		expect(tx.map(m => (m.data as { state: string }).state)).toEqual([
			"open",
			"closed",
		])
		expect((tx[1]?.data as { closeReason: string }).closeReason).toBe("stopped")
		await expect(readdir(stateDir)).resolves.toEqual([])
	})

	it("derives frequency and trust from the tuner like the spectrum engine", () => {
		expect(tuner({})("rtl0", 100)).toEqual({
			hz: 446_000_100,
			tuningTrust: "commanded",
		})
		expect(tuner({ controlMode: "external" })("rtl0", 0)).toEqual({
			hz: 446_000_000,
			tuningTrust: "relay",
		})
		expect(tuner({ unknownFields: ["frequency"] })("rtl0", 0)).toBeNull()
		expect(tuner({ unknownFields: ["gain"] })("rtl0", 0)?.hz).toBe(446_000_000)
		expect(tuner(undefined)("rtl0", 0)).toBeNull()
	})
})

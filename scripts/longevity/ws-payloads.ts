/**
 * Longevity: WebSocket payload sizes and serialisation cost (measure only, not CI). Builds the
 * messages the core broadcasts with the real producers (AircraftTracker state, encodeBins) and
 * reports the JSON bytes on the wire, the bytes a binary encoding would need, and the main-thread
 * JSON.stringify cost per message. `broadcast()` serialises each message once, on the first
 * subscribed client, then queues the same string per subscribed client.
 *
 * Then the `aircraft` channel per client, in real time for `--seconds` (default 10): `--aircraft`
 * (default 150) with full 100-point trails, each heard `--rate` times a second (default 6, SBS-like),
 * through the real AircraftTracker → AircraftUpdatePublisher → WebSocketEventBroadcaster to one fake
 * subscribed socket that counts bytes. "before" is what the previous wiring sent (every tracker
 * update with its whole state), measured on the same updates; "before1Hz" is that at one update per
 * aircraft per second (the LE report's 1.07 MB/s estimate). The publisher is told of every aircraft
 * first (aircraft:new, as in the core), so "after" is the steady state: the staggered full-trail
 * resync every 300 updates (≈ 24 B/s per aircraft) mostly falls outside a short run.
 *
 *   pnpm exec esbuild scripts/longevity/ws-payloads.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/longevity/ws-payloads.mjs
 *   node output/longevity/ws-payloads.mjs
 *
 * Synthetic data only.
 */
import os from "node:os"
import { performance } from "node:perf_hooks"
import process from "node:process"
import pino from "pino"
import { EventEmitter } from "node:events"
import { parseArgs } from "node:util"
import { AircraftUpdatePublisher } from "../../src/api/websocket/aircraft-updates.js"
import { WebSocketEventBroadcaster } from "../../src/api/websocket/events.js"
import { AircraftTracker } from "../../src/core/aircraft-tracker.js"
import { encodeBins } from "../../src/core/spectrum/spectrum-service.js"

const silent = pino({ level: "silent" })

function stringifyCostUs(message: unknown, reps = 2_000): number {
	JSON.stringify(message)
	const t0 = performance.now()
	for (let i = 0; i < reps; i++) JSON.stringify(message)
	return ((performance.now() - t0) * 1000) / reps
}

// aircraft:update as broadcast: the whole AircraftState, track history included.
const clock = { t: Date.parse("2026-01-01T00:00:00.000Z") }
const realNow = Date.now
Date.now = () => clock.t
const tracker = new AircraftTracker({}, silent)
const aircraftSizes: {
	trackPoints: number
	bytes: number
	stringifyUs: number
}[] = []
for (let i = 0; i < 400; i++) {
	clock.t += 1_000
	tracker.processUpdate({
		hex: "A00001",
		flight: "WKA100",
		squawk: "1000",
		lat: 50 + i * 0.002,
		lon: 4 + i * 0.002,
		alt_baro: 30_000 + i,
		gs: 420,
		track: 45,
		baro_rate: 0,
		category: "A3",
	})
	const state = tracker.get("A00001")
	const points = state?.trackHistory?.length ?? 0
	if (
		[1, 10, 50, 100].includes(points) &&
		!aircraftSizes.some(s => s.trackPoints === points)
	) {
		const message = {
			type: "aircraft:update",
			data: state,
			channel: "aircraft",
		}
		aircraftSizes.push({
			trackPoints: points,
			bytes: JSON.stringify(message).length,
			stringifyUs: Number(stringifyCostUs(message).toFixed(1)),
		})
	}
}
Date.now = realNow

// spectrum:frame: base64 bins inside JSON (binEncoding u8 half-dB).
const spectrum = [512, 2048, 8192].map(bins => {
	const dbfs = Array.from({ length: bins }, (_, i) => -90 + (i % 13))
	const frame = {
		type: "spectrum:frame",
		data: {
			sourceId: "source-1",
			profile: `10:${bins}`,
			epoch: 3,
			tuningTrust: "commanded",
			centerHz: 100_000_000,
			sampleRateHz: 2_048_000,
			binHz: 2_048_000 / bins,
			nativeBinHz: 250,
			startHz: 98_976_000,
			binCount: bins,
			bins: encodeBins(dbfs),
			binEncoding: "u8-half-db",
			floorDbfs: -92.5,
			thresholdDb: 6,
			tracks: Array.from({ length: 4 }, (_, i) => ({
				id: `t-${i}`,
				startHz: 99_000_000 + i * 100_000,
				endHz: 99_012_500 + i * 100_000,
				peakDbfs: -60,
			})),
			masks: { dcHz: 100_000_000, dcGuardHz: 2_000, spurRanges: [] },
		},
		channel: "spectrum",
	}
	const json = JSON.stringify(frame).length
	const meta = json - (frame.data.bins.length + 2)
	return {
		bins,
		jsonBytes: json,
		binaryBytesEstimate: bins + meta,
		perClientKiBps10Hz: Number(((json * 10) / 1024).toFixed(1)),
		stringifyUs: Number(stringifyCostUs(frame).toFixed(1)),
	}
})

// aircraft channel per client, before and after the 1 Hz publisher with trail deltas
const { values: flags } = parseArgs({
	options: {
		aircraft: { type: "string", default: "150" },
		rate: { type: "string", default: "6" },
		seconds: { type: "string", default: "10" },
	},
})
const fleetSize = Math.max(1, Number(flags.aircraft))
const ratePerAircraft = Math.max(1, Number(flags.rate))
const seconds = Math.min(60, Math.max(1, Number(flags.seconds)))

async function aircraftChannel() {
	const fleet = new AircraftTracker({}, silent)
	const hexes = Array.from({ length: fleetSize }, (_, i) =>
		(0xa00000 + i).toString(16).toUpperCase(),
	)
	const lat = new Map(hexes.map((h, i) => [h, 40 + i * 0.05]))
	const hear = (hex: string) => {
		// 450 kn ≈ 232 m/s; per message 232 / rate metres north
		const next = (lat.get(hex) ?? 0) + 232 / ratePerAircraft / 111_320
		lat.set(hex, next)
		fleet.processUpdate({
			hex,
			flight: `WK${hex.slice(-4)}`,
			squawk: "1000",
			lat: next,
			lon: 4,
			alt_baro: 30_000,
			gs: 450,
			track: 0,
			category: "A3",
		})
	}
	// warm-up on a fake clock: full 100-point trails (≥ 50 m apart) before anyone listens
	const warm = { t: Date.now() - 3_600_000 }
	const wallNow = Date.now
	Date.now = () => warm.t
	for (let k = 0; k < 120 * ratePerAircraft; k++) {
		warm.t += 1000 / ratePerAircraft
		for (const hex of hexes) hear(hex)
	}
	Date.now = wallNow

	const broadcaster = new WebSocketEventBroadcaster(silent)
	let afterBytes = 0
	let afterMessages = 0
	const socket = Object.assign(new EventEmitter(), {
		readyState: 1,
		bufferedAmount: 0,
		send(data: string) {
			afterBytes += Buffer.byteLength(data)
			afterMessages += 1
		},
		close() {},
		ping() {},
		terminate() {},
	})
	;(
		broadcaster as unknown as { handleConnection(s: unknown): void }
	).handleConnection(socket)
	socket.emit(
		"message",
		JSON.stringify({ type: "subscribe", channels: ["aircraft"] }),
	)
	afterBytes = 0
	afterMessages = 0
	const publisher = new AircraftUpdatePublisher({
		publishNew: a => broadcaster.broadcastAircraftNew(a),
		publishUpdate: d => broadcaster.broadcastAircraftUpdate(d),
		publishLost: (icao, a) => broadcaster.broadcastAircraftLost(icao, a),
	})
	// as in the core, the publisher saw every aircraft arrive (aircraft:new, full trail)
	for (const hex of hexes) {
		const state = fleet.get(hex)
		if (state) publisher.onNew(state)
	}
	afterBytes = 0
	afterMessages = 0
	let beforeBytes = 0
	let beforeMessages = 0
	const lastFull = new Map<string, number>()
	let before1HzBytes = 0
	fleet.on("aircraft:update", state => {
		const bytes = Buffer.byteLength(
			JSON.stringify({
				type: "aircraft:update",
				data: state,
				channel: "aircraft",
			}),
		)
		beforeBytes += bytes
		beforeMessages += 1
		const now = Date.now()
		if (now - (lastFull.get(state.icao) ?? 0) >= 1000) {
			lastFull.set(state.icao, now)
			before1HzBytes += bytes
		}
		publisher.onUpdate(state)
	})
	const cpu0 = process.cpuUsage()
	const t0 = performance.now()
	// one tick per 1/rate s hears every aircraft once, spread over the tick
	await new Promise<void>(resolve => {
		const tickMs = 1000 / ratePerAircraft
		let ticks = 0
		const timer = setInterval(() => {
			for (const hex of hexes) hear(hex)
			ticks += 1
			if (ticks >= seconds * ratePerAircraft) {
				clearInterval(timer)
				// let the last trailing updates flush
				setTimeout(resolve, 1100)
			}
		}, tickMs)
	})
	const elapsedS = (performance.now() - t0) / 1000
	const cpu = process.cpuUsage(cpu0)
	publisher.stop()
	broadcaster.closeAll()
	const perS = (bytes: number) => Math.round(bytes / elapsedS)
	return {
		aircraft: fleetSize,
		messagesPerAircraftPerS: ratePerAircraft,
		elapsedS: Number(elapsedS.toFixed(2)),
		before: {
			messagesPerS: Math.round(beforeMessages / elapsedS),
			bytesPerS: perS(beforeBytes),
		},
		before1Hz: { bytesPerS: perS(before1HzBytes) },
		after: {
			messagesPerS: Math.round(afterMessages / elapsedS),
			bytesPerS: perS(afterBytes),
			meanMessageBytes: Math.round(afterBytes / Math.max(1, afterMessages)),
		},
		reductionVsBefore: Number((1 - afterBytes / beforeBytes).toFixed(4)),
		reductionVsBefore1Hz: Number((1 - afterBytes / before1HzBytes).toFixed(4)),
		processCpuMsPerS: Number(
			((cpu.user + cpu.system) / 1000 / elapsedS).toFixed(1),
		),
	}
}
const aircraftPerClient = await aircraftChannel()

console.log(
	JSON.stringify(
		{
			aircraftUpdate: aircraftSizes,
			aircraftChannelPerClient: aircraftPerClient,
			spectrumFrame: spectrum,
			loadavg: os.loadavg().map(x => Number(x.toFixed(2))),
			node: process.version,
		},
		null,
		1,
	),
)

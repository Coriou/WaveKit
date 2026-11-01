/**
 * Longevity: WebSocket payload sizes and serialisation cost (measure only, not CI). Builds the
 * messages the core broadcasts with the real producers (AircraftTracker state, encodeBins) and
 * reports the JSON bytes on the wire, the bytes a binary encoding would need, and the main-thread
 * JSON.stringify cost per message. `broadcast()` serialises each message once, whether or not a
 * client subscribes, then queues the same string per subscribed client.
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

console.log(
	JSON.stringify(
		{
			aircraftUpdate: aircraftSizes,
			spectrumFrame: spectrum,
			loadavg: os.loadavg().map(x => Number(x.toFixed(2))),
			node: process.version,
		},
		null,
		1,
	),
)

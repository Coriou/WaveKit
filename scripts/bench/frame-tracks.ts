/**
 * WG11 req 5.5 (lane TR): frame-track field cost, measure only (not CI). Prints the JSON growth
 * per track (typical and worst-case lengths) and the per-frame cost at 20 and 64 tracks, before
 * (frozen segments, no fields) and after (fields recorded per block + a scanner identity looked
 * up per track), with the load average.
 *
 *   pnpm exec esbuild scripts/bench/frame-tracks.ts --bundle \
 *     --platform=node --format=esm --packages=external \
 *     --outfile=output/bench/frame-tracks.mjs
 *   node output/bench/frame-tracks.mjs [--frames 20000]
 *
 * "worker" is the pipeline's per-block track build (blockTrackOf vs the frozen literal);
 * "frame" is the service's per-frame track copy with the identity lookup (the real private
 * `frameTracks`) plus the frame JSON.stringify a WebSocket send does.
 */
import os from "node:os"
import { performance } from "node:perf_hooks"
import process from "node:process"
import pino from "pino"
import type { SpectrumFrameTrackScanner } from "@wavekit/api-types"
import {
	FRAME_TRACK_AGE_MS_MAX,
	FRAME_TRACK_BLOCKS_MAX,
	FRAME_TRACK_DISCOVERY_ID_MAX_CHARS,
	FRAME_TRACK_ID_MAX_CHARS,
	blockTrackOf,
	type TrackAssociation,
} from "../../src/core/spectrum/frame-tracks.js"
import { SpectrumService } from "../../src/core/spectrum/spectrum-service.js"
import type { BlockTrack } from "../../src/core/spectrum/types.js"

const arg = (name: string, fallback: number): number => {
	const i = process.argv.indexOf(`--${name}`)
	const v = i >= 0 ? Number(process.argv[i + 1]) : Number.NaN
	return Number.isFinite(v) && v > 0 ? v : fallback
}
const FRAMES = arg("frames", 20_000)
const FS = 2_048_000
const FLAGS = { burst: false, iqImage: false, edge: false }

function association(i: number, worst: boolean): TrackAssociation {
	const trackId = worst
		? "t".repeat(FRAME_TRACK_ID_MAX_CHARS)
		: `mguu1x2s-${(i + 1).toString(36)}` // the frame id: no `rtl-`
	return {
		trackId,
		trackerId: trackId,
		snrDb: worst ? -999.5 : 12.26 + i,
		peakDbfs: worst ? -999.5 : -40.74 + i / 3,
		blocks: worst ? FRAME_TRACK_BLOCKS_MAX : 3 + i,
		startSample: 0,
		lastSample: worst
			? (FRAME_TRACK_AGE_MS_MAX / 1000) * FS
			: 102_400 * (i + 1),
		maxBlockSnrDb: 20,
		thresholdDb: 10,
		spur: false,
		iqImage: false,
		burst: i % 3 === 0,
	}
}
const range = (i: number) => ({
	startHz: 446_000_000 + i * 12_500,
	endHz: 446_006_250 + i * 12_500,
})
const before = (n: number): BlockTrack[] =>
	Array.from({ length: n }, (_, i) => ({ ...range(i), flags: { ...FLAGS } }))
const after = (n: number, worst = false): BlockTrack[] =>
	Array.from({ length: n }, (_, i) =>
		blockTrackOf(
			range(i).startHz,
			range(i).endHz,
			{ ...FLAGS },
			association(i, worst),
			FS,
			2,
		),
	)

const identity = (worst: boolean): SpectrumFrameTrackScanner => ({
	discoveryId: worst
		? "d".repeat(FRAME_TRACK_DISCOVERY_ID_MAX_CHARS)
		: "d_01JABCDEFGHJKMNPQRSTVWXYZ0",
	protocol: "digital-unknown",
	confidence: "classified",
})

// The service with only what frameTracks touches (logger, clock); the lookup is a Map read.
const service = new SpectrumService({
	logger: pino({ level: "silent" }),
	now: () => 0,
} as unknown as ConstructorParameters<typeof SpectrumService>[0])
const frameTracks = (
	service as unknown as {
		frameTracks(sourceId: string, tracks: BlockTrack[]): BlockTrack[]
	}
).frameTracks.bind(service)

function frameOf(tracks: unknown[]): object {
	return {
		sourceId: "rtl",
		profile: "10:512",
		epoch: 1,
		tuningTrust: "commanded",
		centerHz: 446_100_000,
		sampleRateHz: FS,
		binHz: 4_000,
		nativeBinHz: 1_000,
		startHz: 445_100_000,
		binCount: 512,
		bins: "x".repeat(684),
		binEncoding: "u8-halfdb-127.5",
		floorDbfs: -90,
		thresholdDb: 10,
		tracks,
		masks: { dcHz: 446_100_000, dcGuardHz: 1_500, spurRanges: [] },
		at: "2026-10-17T12:00:00.000Z",
	}
}

function time(fn: () => void, iterations: number): number {
	for (let i = 0; i < Math.min(2_000, iterations); i++) fn() // warm-up
	const t0 = performance.now()
	for (let i = 0; i < iterations; i++) fn()
	return ((performance.now() - t0) * 1000) / iterations
}

let sink = 0
const out: Record<string, unknown> = {}
for (const n of [20, 64]) {
	const plain = before(n)
	const typical = after(n)
	// keyed on the full tracker id the service rebuilds (`${sourceId}-${trackId}`)
	const ids = new Map(
		typical.map(t => [`rtl-${t.trackId ?? ""}`, identity(false)]),
	)
	const worker = {
		beforeUs: time(() => {
			sink += before(n).length
		}, FRAMES),
		afterUs: time(() => {
			sink += after(n).length
		}, FRAMES),
	}
	service.setTrackIdentityLookup(null)
	const frameBefore = time(() => {
		sink += JSON.stringify(frameOf(frameTracks("rtl", plain))).length
	}, FRAMES)
	service.setTrackIdentityLookup((_s, id) => ids.get(id) ?? null)
	const frameAfter = time(() => {
		sink += JSON.stringify(frameOf(frameTracks("rtl", typical))).length
	}, FRAMES)
	const bytes = (tracks: unknown[]) => Buffer.byteLength(JSON.stringify(tracks))
	service.setTrackIdentityLookup(() => identity(true))
	const worstTracks = frameTracks("rtl", after(n, true))
	service.setTrackIdentityLookup((_s, id) => ids.get(id) ?? null)
	const typicalTracks = frameTracks("rtl", typical)
	service.setTrackIdentityLookup(null)
	out[`tracks${n}`] = {
		workerPerBlockUs: {
			before: +worker.beforeUs.toFixed(2),
			after: +worker.afterUs.toFixed(2),
		},
		framePerFrameUs: {
			before: +frameBefore.toFixed(2),
			after: +frameAfter.toFixed(2),
		},
		growthPerTrackBytes: {
			typicalNoScanner: (bytes(typical) - bytes(plain)) / n,
			typicalWithScanner: (bytes(typicalTracks) - bytes(plain)) / n,
			worst: (bytes(worstTracks) - bytes(plain)) / n,
		},
		frameJsonBytes: {
			before: Buffer.byteLength(JSON.stringify(frameOf(plain))),
			after: Buffer.byteLength(JSON.stringify(frameOf(typicalTracks))),
		},
	}
}
out["frames"] = FRAMES
out["loadAvg"] = os.loadavg().map(x => +x.toFixed(2))
out["cpus"] = os.cpus().length
process.stdout.write(`${JSON.stringify(out, null, 2)}\n`)
if (sink < 0) process.stdout.write("unreachable\n")

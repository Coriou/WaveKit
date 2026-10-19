import { SpectrumPipeline } from "../../../../src/core/spectrum/pipeline.js"
import type { Logger } from "../../../../src/utils/logger.js"
import type {
	FreqRange,
	PendingEpoch,
	PipelineConfig,
	PipelineEvent,
	Raster,
	TrackSnapshot,
} from "../../../../src/core/spectrum/types.js"
import type { WorkerPipelineInput } from "../../../../src/core/spectrum/worker-protocol.js"
import { packCu8, packF32 } from "../../../mocks/scanner/signals.js"
import type { Iq } from "../../../mocks/scanner/signals.js"

export const FS = 256_000
export const N = 256
export const BIN_HZ = FS / N
export const BLOCK = 12_800 // 50 frames of 256 at T = 50 ms
export const CENTRE = 446_100_000

export function pipelineConfig(
	over: Partial<PipelineConfig> = {},
): PipelineConfig {
	return {
		sourceId: "s1",
		format: "U8_IQ",
		sampleRateHz: FS,
		fftSize: N,
		integrationMs: 50,
		usableFraction: 0.8,
		dcGuardHz: 1500,
		ppmMargin: 2,
		hysteresisDb: 3,
		clipFraction: 1e-3,
		minSurfaceBlocks: 2,
		thresholdDb: null,
		faTargetPerMhzMin: 1,
		spectrumBins: 512,
		trackHangMs: 500,
		maxTracks: 512,
		maxTrackMs: 120_000,
		...over,
	}
}

/** A macrotask boundary: minutes of synchronous DSP would otherwise starve vitest's worker RPC ("Timeout calling onTaskUpdate"). */
export const yieldToRpc = (): Promise<void> =>
	new Promise(resolve => setImmediate(resolve))

type EventOf<K extends PipelineEvent["kind"]> = Extract<
	PipelineEvent,
	{ kind: K }
>

/** Drives a SpectrumPipeline with absolute sample indices, like the engine (Task 32) does. */
export class Harness {
	readonly events: PipelineEvent[] = []
	readonly pipeline: SpectrumPipeline
	readonly config: PipelineConfig
	sample = 0
	private readonly bps: number

	constructor(
		over: Partial<PipelineConfig> = {},
		deps: {
			provisionalWindowMs?: number
			logger?: Logger
			now?: () => number
		} = {},
	) {
		this.config = pipelineConfig(over)
		this.pipeline = new SpectrumPipeline(this.config, { now: () => 0, ...deps })
		this.bps =
			this.config.format === "U8_IQ"
				? 2
				: this.config.format === "S16_IQ"
					? 4
					: 8
	}

	send(input: WorkerPipelineInput): PipelineEvent[] {
		const ev = this.pipeline.handle(input)
		this.events.push(...ev)
		return ev
	}

	start(
		opts: {
			centreHz?: number
			feed?: boolean
			inWindow?: boolean
			rasters?: Raster[]
			exclusions?: FreqRange[]
		} = {},
	): void {
		this.sample = 0
		this.send({
			kind: "masks",
			exclusions: opts.exclusions ?? [],
			cfarRanges: [],
			burstRanges: [],
			rasters: opts.rasters ?? [],
			obwHz: [],
			inWindow: opts.inWindow ?? true,
		})
		this.send({ kind: "spectrum-feed", enabled: opts.feed ?? true })
		this.send({
			kind: "new-stream",
			stream: 1,
			centreHz: opts.centreHz ?? CENTRE,
			sampleRateHz: FS,
			gainKey: "m:496",
			tuningTrust: "commanded",
		})
	}

	push(iq: Iq, chunkSamples = 4096): void {
		const bytes =
			this.config.format === "U8_IQ"
				? packCu8(iq.re, iq.im)
				: packF32(iq.re, iq.im)
		this.pushBytes(bytes, chunkSamples)
	}

	pushBytes(bytes: Uint8Array, chunkSamples = 4096): void {
		const step = chunkSamples * this.bps
		for (let off = 0; off < bytes.length; off += step) {
			const part = bytes.subarray(off, Math.min(bytes.length, off + step))
			this.send({ kind: "bytes", startSample: this.sample, bytes: part })
			this.sample += part.length / this.bps
		}
	}

	gap(samples: number): void {
		this.send({ kind: "gap", startSample: this.sample, samples })
		this.sample += samples
	}

	pending(over: Partial<PendingEpoch> & { centreHz: number }): void {
		this.send({
			kind: "pending-epoch",
			pending: {
				epoch: 0,
				commandSample: this.sample,
				bufferedSamples: 0,
				settleSamples: 0,
				expectMarker: false,
				markerTimeoutSamples: 2 * FS,
				pllSettleSamples: 0,
				sampleRateHz: FS,
				gainKey: "m:496",
				tuningTrust: "commanded",
				centreChanged: true,
				...over,
			},
		})
	}

	of<K extends PipelineEvent["kind"]>(kind: K): EventOf<K>[] {
		return this.events.filter((e): e is EventOf<K> => e.kind === kind)
	}

	tracks(): TrackSnapshot[] {
		return this.events.flatMap(e =>
			e.kind === "track-open" ||
			e.kind === "track-update" ||
			e.kind === "track-close"
				? [e.track]
				: [],
		)
	}
}

/**
 * One per source with at least one consumer (scanner jobs, `spectrum` WS
 * subscribers; spec § 3, § 4.1).
 * Owns the fanout branch `scanner-${sourceId}`, the absolute sample index of
 * each stream (received + dropped samples), the IQ ring, the pipeline host
 * and the epoch triggers (§ 4.6). Implements EpochClock for the arbiter.
 */
import { EventEmitter } from "node:events"
import type { Readable } from "node:stream"
import type { TunerCommandOrigin, TunerState } from "@wavekit/api-types"
import type { SourceCaps } from "../../config.js"
import type { BranchTelemetry, FanoutManager } from "../fanout-manager.js"
import type { SourceFanoutRouter } from "../source-fanout-router.js"
import type { SourceManager } from "../source-manager.js"
import type { TunerController } from "../tuner-controller.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import { WaveKitError } from "../../utils/errors.js"
import { defaultFftSize } from "./fft.js"
import type {
	CfarMaskRange,
	EngineState,
	FreqRange,
	IqFormat,
	PendingEpoch,
	PipelineConfig,
	PipelineEvent,
	PipelineInput,
	PipelineStats,
	Raster,
	SpectrumSettings,
	SettleMode,
	TuningTrust,
} from "./types.js"
import { bytesPerSample } from "./frame-source.js"
import type { ArtefactMasks } from "./artefacts.js"
import { IqRing } from "./iq-ring.js"
import {
	createPipelineHost,
	type PipelineHost,
	type PipelineHostHandlers,
	type PipelineHostMode,
} from "./pipeline-host.js"

/** Pre-channelizer usable fraction of the captured span (§ 5.3). */
export const USABLE_FRACTION = 0.8
export const SCANNER_BRANCH_HWM = 262_144
export const MAX_INFLIGHT_BYTES = 4 * 1024 * 1024
const DEFAULT_BATCH_BYTES = 131_072
const BATCH_FLUSH_MS = 20

/** Commands that change what the samples mean (§ 4.6). */
const EPOCH_COMMANDS: ReadonlySet<string> = new Set([
	"set-frequency",
	"set-sample-rate",
	"set-gain-mode",
	"set-gain",
	"set-freq-correction",
	"set-if-gain",
	"set-agc-mode",
	"set-direct-sampling",
	"set-offset-tuning",
	"set-rtl-xtal",
	"set-tuner-xtal",
	"set-tuner-gain-index",
	"set-tuner-if-gain",
])

const IQ_FORMATS: ReadonlySet<string> = new Set([
	"U8_IQ",
	"S16_IQ",
	"FLOAT32LE",
])

export interface EngineTuning {
	fftSize: number | null
	integrationMs: number | null
	thresholdDb: number | null
	sensitivity: "low" | "normal" | "high" | null
}

export const DEFAULT_TUNING: EngineTuning = {
	fftSize: null,
	integrationMs: null,
	thresholdDb: null,
	sensitivity: null,
}

export interface EngineEpoch {
	stream: number
	epoch: number
	startSample: number | null
	centreHz: number
	sampleRateHz: number
	gainKey: string
	tuningTrust: TuningTrust
	settleMode: SettleMode | null
}

export interface EngineMasks {
	exclusions: FreqRange[]
	/** SF1: per-range false-alarm target optional (CfarMaskRange). */
	cfarRanges: CfarMaskRange[]
	burstRanges: FreqRange[]
	rasters: Raster[]
	obwHz: number[]
	/** True while no sweep lease holds the source (§ 6.2: truncated segments report as `edge`). */
	inWindow: boolean
}

/** Trust warning (§ 4.7): the pipeline's untracked retune, or a host-reported centre mismatch. */
export interface EngineWarning {
	code: "untracked-retune" | "host-centre-mismatch"
	deltaHz: number | null
	at: number
}

const MAX_WARNINGS = 16

/** What the arbiter needs from the engine of a leased source (Task 33). */
export interface EpochClock {
	sampleClock(): {
		commandSample: number
		bufferedSamples: number
		sampleRateHz: number
	}
	allocateEpoch(): number
	submitEpoch(pending: PendingEpoch): void
	suppressExternal(on: boolean): void
	currentEpoch(): EngineEpoch
	readonly markerSupported: boolean | null
}

/** Host-side truth about the tuner centre (sdr-host status); null = unknown. */
export interface HostCentreReader {
	read(sourceId: string): Promise<number | null>
}

export const nullHostCentreReader: HostCentreReader = {
	read: () => Promise.resolve(null),
}

const HOST_CENTRE_TOLERANCE_HZ = 1000

/** Why a `"stream"` event fired: a new stream starts, or the engine stopped (the last stream ended). */
export type EngineStreamReason = "restart" | "stop"

export interface SpectrumEngineEvents {
	pipeline: (ev: PipelineEvent, epoch: EngineEpoch) => void
	/**
	 * `"restart"`: stream `stream` starts; emitted before its first pipeline event
	 * (start, reconnect boundary, rate change, reconfigure). `"stop"`: emitted by
	 * stop() after the last pipeline event, with the stream that ended.
	 */
	stream: (stream: number, reason: EngineStreamReason) => void
	error: (err: Error) => void
	warning: (code: EngineWarning["code"], deltaHz: number | null) => void
}

export interface SpectrumEngineDeps {
	sourceId: string
	sources: Pick<SourceManager, "getCaps" | "getStream"> &
		Pick<EventEmitter, "on" | "off">
	routing: Pick<SourceFanoutRouter, "getFanout" | "releaseUnused">
	tuner:
		| (Pick<TunerController, "getState"> & Pick<EventEmitter, "on" | "off">)
		| null
	settings: () => SpectrumSettings
	tuning?: () => EngineTuning
	logger: Logger
	host?: PipelineHostMode
	workerUrl?: URL
	persistedEngine?: EngineState
	createHost?: (
		cfg: PipelineConfig,
		handlers: PipelineHostHandlers,
	) => PipelineHost
	batchBytes?: number
	hostCentre?: HostCentreReader
	hostCentrePollMs?: number
}

export function isScannerIqFormat(
	caps: SourceCaps | undefined,
): caps is SourceCaps & { format: IqFormat } {
	return (
		caps !== undefined &&
		(caps.kind === "iq" || caps.kind === "recording") &&
		IQ_FORMATS.has(caps.format)
	)
}

export function gainKeyOf(state: TunerState | undefined): string {
	if (!state) return "na"
	return state.gainMode === "manual" ? `m:${state.gain}` : "agc"
}

/**
 * False-alarm target (per MHz per minute) for a sensitivity preset.
 * `normal` keeps `settingsFa`; `low` is 0.25 and `high` is 2.
 */
export function faTargetForSensitivity(
	sensitivity: SpectrumSettings["detection"]["sensitivity"],
	settingsFa: number,
): number {
	if (sensitivity === "low") return 0.25
	if (sensitivity === "high") return 2
	return settingsFa
}

export function buildPipelineConfig(
	sourceId: string,
	format: IqFormat,
	sampleRateHz: number,
	s: SpectrumSettings,
	tuning: EngineTuning,
	persisted?: EngineState,
): PipelineConfig {
	const sensitivity = tuning.sensitivity ?? s.detection.sensitivity
	const fftSize =
		tuning.fftSize ??
		(s.detection.fftSize === "auto"
			? defaultFftSize(sampleRateHz)
			: s.detection.fftSize)
	const integrationMs =
		tuning.integrationMs ??
		(sensitivity === "high" ? 100 : s.detection.integrationMs)
	const faTargetPerMhzMin = faTargetForSensitivity(
		sensitivity,
		s.detection.faTargetPerMhzMin,
	)
	return {
		sourceId,
		format,
		sampleRateHz,
		fftSize,
		integrationMs,
		usableFraction: USABLE_FRACTION,
		dcGuardHz: s.detection.dcGuardHz,
		ppmMargin: s.detection.ppmMargin,
		hysteresisDb: s.detection.hysteresisDb,
		clipFraction: s.detection.clipFraction,
		minSurfaceBlocks: s.detection.minSurfaceBlocks,
		thresholdDb: tuning.thresholdDb,
		faTargetPerMhzMin,
		spectrumBins: s.ws.spectrumSummaryBins, // engine summary budget; client bins are applied by SpectrumService (Task 37a)
		trackHangMs: 500,
		maxTracks: 512,
		maxTrackMs: 120_000,
		shortIntegrationMs: s.detection.shortIntegrationMs,
		overlap: s.detection.overlap,
		...(persisted ? { persistedEngine: persisted } : {}),
	}
}

interface Batch {
	buf: ArrayBuffer
	used: number
	start: number
}

/** Something that happens when the engine's branch byte counter reaches `atBranchByte`. */
type BranchMark =
	| { kind: "gap"; atBranchByte: number; droppedBytes: number }
	| { kind: "stream"; atBranchByte: number; trust: TuningTrust }

export class SpectrumEngine extends EventEmitter implements EpochClock {
	readonly sourceId: string
	private readonly log: Logger
	private readonly branchId: string
	private readonly batchBytes: number
	private host: PipelineHost | null = null
	private cfg: PipelineConfig | null = null
	private fanout: Pick<
		FanoutManager,
		"addBranch" | "removeBranch" | "getBranchTelemetry" | "on" | "off"
	> | null = null
	private branch: Readable | null = null
	private ring: IqRing | null = null
	/** The ring's sample rate and capacity (samples), set with the ring. */
	private ringRateHz = 0
	private ringCapacity = 0
	/** Floor on the ring length from setRingSeconds (burst capture pre-roll); 0 = settings only. */
	private ringSecondsMin = 0
	private bps = 2
	private fmt: IqFormat = "U8_IQ"
	private running = false
	private failed = false
	private generation = 0
	private stopping: Promise<EngineState | null> | null = null
	private restarting = false
	private persisted: EngineState | undefined
	// Stream and sample accounting
	private stream = -1
	private nextSample = 0
	private branchBytes = 0
	/** Branch byte position where the current (or last queued) stream starts. */
	private streamStartByte = 0
	private remainder = new Uint8Array(0)
	private skipBytes = 0
	private awaitingPayload = false
	private gapSamplesTotal = 0
	private workerDroppedSamples = 0
	/** Gaps and stream boundaries, ordered by the branch byte where they apply. */
	private readonly branchQueue: BranchMark[] = []
	/** Open fanout drop episode: accepted bytes at its start, dropped total at its start. */
	private bpMark: { atBranchByte: number; droppedAt: number } | null = null
	// Batching
	private batch: Batch | null = null
	private readonly pool: ArrayBuffer[] = []
	private inflightBytes = 0
	private flushTimer: NodeJS.Timeout | null = null
	// Epochs
	private lastEpoch = 0
	private suppressed = 0
	private externalPending: {
		trust: TuningTrust
		commandSample: number
		bufferedSamples: number
	} | null = null
	private readonly pendingMeta = new Map<number, EngineEpoch>()
	/**
	 * Streams posted to the host whose own `epoch-started` (settleMode "none")
	 * has not arrived yet, in post order. A thread host can still deliver the
	 * old stream's events after a new-stream was posted.
	 */
	private readonly openingStreams: EngineEpoch[] = []
	private current: EngineEpoch
	private lastTunerKey: string | null = null
	private marker: boolean | null = null
	// Consumers
	private readonly taps = new Set<
		(startSample: number, bytes: Uint8Array) => void
	>()
	private masks: EngineMasks | null = null
	private spectrumFeed = false
	private lastStats: PipelineStats | null = null
	private readonly warningList: EngineWarning[] = []
	private centreOverride: number | null = null
	private hostTimer: NodeJS.Timeout | null = null

	constructor(private readonly deps: SpectrumEngineDeps) {
		super()
		this.sourceId = deps.sourceId
		this.branchId = `scanner-${deps.sourceId}`
		this.batchBytes = deps.batchBytes ?? DEFAULT_BATCH_BYTES
		this.persisted = deps.persistedEngine
		this.log = createComponentLogger(
			deps.logger,
			`SpectrumEngine:${deps.sourceId}`,
		)
		this.current = {
			stream: 0,
			epoch: 0,
			startSample: null,
			centreHz: 0,
			sampleRateHz: 0,
			gainKey: "na",
			tuningTrust: "unverified",
			settleMode: null,
		}
	}

	get format(): IqFormat {
		return this.fmt
	}

	get isRunning(): boolean {
		return this.running && !this.failed
	}

	get markerSupported(): boolean | null {
		return this.marker
	}

	/** A0 / `stuckTestMode` outcome for this source's transport (§ 4.6). */
	setMarkerSupported(value: boolean | null): void {
		this.marker = value
	}

	async start(): Promise<void> {
		if (this.running) return
		if (this.failed)
			throw new WaveKitError(
				"Spectrum engine failed; acquire a new instance",
				"SCANNER_ENGINE_FAILED",
			)
		const caps = this.deps.sources.getCaps(this.sourceId)
		if (!isScannerIqFormat(caps)) {
			throw new WaveKitError(
				`Source ${this.sourceId} is not an IQ source the scanner can read`,
				"SCANNER_SOURCE_NOT_IQ",
			)
		}
		this.fmt = caps.format
		this.bps = bytesPerSample(this.fmt)
		this.host = this.createHost(caps.sampleRate)
		this.running = true
		this.subscribe()
		const fanout = this.deps.routing.getFanout(this.sourceId)
		this.fanout = fanout
		fanout.on("backpressure", this.onBackpressure)
		fanout.on("drain", this.onDrain)
		const branch = fanout.addBranch({
			id: this.branchId,
			sourceId: this.sourceId,
			highWaterMark: SCANNER_BRANCH_HWM,
		})
		branch.on("data", this.onData)
		branch.on("error", this.onBranchError)
		this.branch = branch
		// A fresh branch counts from byte 0.
		this.branchBytes = 0
		this.branchQueue.length = 0
		this.bpMark = null
		this.awaitingPayload = false
		this.streamStartByte = 0
		this.pendingMeta.clear()
		this.openingStreams.length = 0
		this.beginStream(this.initialTrust())
		const reader = this.deps.hostCentre ?? nullHostCentreReader
		if (reader !== nullHostCentreReader) {
			this.hostTimer = setInterval(
				() => void this.checkHostCentre(reader),
				this.deps.hostCentrePollMs ?? 5000,
			)
			this.hostTimer.unref()
		}
		this.log.info(
			{ format: this.fmt, sampleRateHz: caps.sampleRate },
			"Spectrum engine started",
		)
	}

	/** Stops the engine; returns the pipeline's engine state for persistence. */
	stop(): Promise<EngineState | null> {
		if (this.stopping) return this.stopping
		const stopping = this.stopOnce()
		this.stopping = stopping
		void stopping
			.finally(() => {
				if (this.stopping === stopping) this.stopping = null
			})
			.catch(() => undefined)
		return stopping
	}

	private async stopOnce(): Promise<EngineState | null> {
		if (!this.running) return null
		this.running = false
		if (this.hostTimer) clearInterval(this.hostTimer)
		this.hostTimer = null
		this.flushBatch()
		this.unsubscribe()
		if (this.flushTimer) clearTimeout(this.flushTimer)
		this.flushTimer = null
		if (this.branch) {
			this.branch.off("data", this.onData)
			this.branch.off("error", this.onBranchError)
		}
		if (this.fanout) {
			this.fanout.off("backpressure", this.onBackpressure)
			this.fanout.off("drain", this.onDrain)
			this.fanout.removeBranch(this.branchId)
		}
		this.deps.routing.releaseUnused(this.sourceId)
		this.branch = null
		this.fanout = null
		this.taps.clear()
		// S1-B final review, finding 9: a stopped engine holds no IQ ring (MBs per source).
		this.ring = null
		const host = this.host
		this.host = null
		let state: EngineState | null = null
		if (host) {
			state = await host.exportState().catch((err: unknown) => {
				this.log.warn({ err }, "Engine state export failed")
				return this.persisted ?? null
			})
			await host.close()
		}
		// After close: a worker delivers its last events before it exits (R2).
		this.emit("stream", this.stream, "stop")
		this.log.info(
			{ gapSamples: this.gapSamplesTotal },
			"Spectrum engine stopped",
		)
		return state
	}

	// === EpochClock ===

	sampleClock(): {
		commandSample: number
		bufferedSamples: number
		sampleRateHz: number
	} {
		const telemetry = this.fanout?.getBranchTelemetry(this.branchId)
		const sourceBuffered =
			this.deps.sources.getStream(this.sourceId)?.readableLength ?? 0
		const bufferedBytes =
			(telemetry?.bufferBytes ?? 0) + sourceBuffered + this.remainder.length
		return {
			commandSample: this.nextSample,
			bufferedSamples: Math.ceil(bufferedBytes / this.bps),
			sampleRateHz: this.cfg?.sampleRateHz ?? 0,
		}
	}

	allocateEpoch(): number {
		this.lastEpoch += 1
		return this.lastEpoch
	}

	submitEpoch(pending: PendingEpoch): void {
		if (!this.running || !this.host || this.restarting) return
		if (pending.sampleRateHz !== this.cfg?.sampleRateHz) {
			this.log.info(
				{ from: this.cfg?.sampleRateHz, to: pending.sampleRateHz },
				"Sample rate change starts a new stream",
			)
			this.restartInBackground(pending.tuningTrust)
			return
		}
		this.flushBatch()
		this.pendingMeta.set(pending.epoch, {
			stream: this.stream,
			epoch: pending.epoch,
			startSample: null,
			centreHz: pending.centreHz,
			sampleRateHz: pending.sampleRateHz,
			gainKey: pending.gainKey,
			tuningTrust: pending.tuningTrust,
			settleMode: null,
		})
		this.send({ kind: "pending-epoch", pending })
	}

	suppressExternal(on: boolean): void {
		this.suppressed = Math.max(0, this.suppressed + (on ? 1 : -1))
		if (!on && this.suppressed === 0) this.checkSuppressedCentre()
	}

	currentEpoch(): EngineEpoch {
		return { ...this.current }
	}

	// === Consumers ===

	/** Absolute index of the next sample (the live edge) in the current stream. */
	liveEdge(): number {
		return this.nextSample
	}

	readRing(
		fromSample: number,
		toSample: number,
	): { startSample: number; bytes: Uint8Array } | null {
		return this.ring?.read(fromSample, toSample) ?? null
	}

	/** Live bytes after they reach the ring; returns an unsubscribe function. */
	tap(listener: (startSample: number, bytes: Uint8Array) => void): () => void {
		this.taps.add(listener)
		return () => this.taps.delete(listener)
	}

	/**
	 * Keeps at least `seconds` of IQ (burst capture pre-roll; 0 = the `ringSeconds` setting only).
	 * Resizes the current ring in place, keeping its newest contiguous samples.
	 */
	setRingSeconds(seconds: number): void {
		this.ringSecondsMin = seconds
		if (!this.ring || this.ringRateHz === 0) return
		const capacity = Math.max(
			1,
			Math.round(
				Math.max(this.deps.settings().ringSeconds, seconds) * this.ringRateHz,
			),
		)
		if (capacity === this.ringCapacity) return
		const newest = this.ring.newestSample
		const next = new IqRing({
			bytesPerSample: this.bps,
			capacitySamples: capacity,
		})
		const keep = this.ring.read(
			Math.max(this.ring.oldestSample, newest - capacity),
			newest,
		)
		if (keep) next.write(keep.startSample, keep.bytes)
		this.ring = next
		this.ringCapacity = capacity
	}

	setMasks(masks: EngineMasks): void {
		this.masks = masks
		this.send({ kind: "masks", ...masks })
	}

	setSpectrumFeed(enabled: boolean): void {
		if (this.spectrumFeed === enabled) return
		this.spectrumFeed = enabled
		this.send({ kind: "spectrum-feed", enabled })
	}

	stats(): PipelineStats | null {
		return this.lastStats
	}

	config(): PipelineConfig | null {
		return this.cfg
	}

	/** Trust warnings, newest last (§ 4.7). */
	warnings(): EngineWarning[] {
		return this.warningList.map(w => ({ ...w }))
	}

	async exportState(): Promise<EngineState | null> {
		if (!this.host) return this.persisted ?? null
		return this.host.exportState()
	}

	/** The pipeline's artefact masks (§ 4.9) for identify (Task 35a); null without a pipeline or on a host error. */
	async artefactMasks(): Promise<ArtefactMasks | null> {
		const host = this.host
		if (!host?.artefactMasks) return null
		return host.artefactMasks().catch(() => null)
	}

	/** Worker utilisation since the pipeline started (§ 10.7 passive cost rule). */
	utilization(): number | null {
		return this.host?.utilization() ?? null
	}

	/** Applies new tuning (fftSize, integration, k) by recreating the pipeline. */
	async reconfigure(): Promise<void> {
		await this.restartPipeline(this.current.tuningTrust)
	}

	// === Internals: hosts and streams ===

	private createHost(sampleRateHz: number): PipelineHost {
		const tuning = this.deps.tuning?.() ?? DEFAULT_TUNING
		const cfg = buildPipelineConfig(
			this.sourceId,
			this.fmt,
			sampleRateHz,
			this.deps.settings(),
			tuning,
			this.persisted,
		)
		this.cfg = cfg
		const generation = ++this.generation
		const handlers: PipelineHostHandlers = {
			events: events => {
				if (generation === this.generation && !this.failed)
					this.onEvents(events)
			},
			buffer: buffer => {
				if (generation === this.generation) this.onBuffer(buffer)
			},
			fatal: err => {
				if (generation === this.generation) this.fail(err)
			},
			error: err => {
				if (generation !== this.generation || this.failed) return
				this.log.error({ err }, "Spectrum pipeline error")
				this.emit("error", err)
			},
		}
		if (this.deps.createHost) return this.deps.createHost(cfg, handlers)
		return createPipelineHost(this.deps.host ?? "thread", cfg, handlers, {
			...(this.deps.workerUrl ? { workerUrl: this.deps.workerUrl } : {}),
			logger: this.deps.logger,
		})
	}

	private fail(err: Error): void {
		if (this.failed || !this.running) return
		this.failed = true
		this.generation++
		this.lastStats = null
		this.current = {
			...this.current,
			startSample: null,
			tuningTrust: "unverified",
			settleMode: null,
		}
		this.log.error({ err }, "Spectrum pipeline unavailable")
		if (this.listenerCount("error") > 0) this.emit("error", err)
		this.emit("fatal", err)
		void this.stop().catch((error: unknown) =>
			this.log.warn({ err: error }, "Fatal pipeline cleanup failed"),
		)
	}

	private async restartPipeline(trust: TuningTrust): Promise<void> {
		if (this.failed || this.restarting || !this.host) return
		this.restarting = true
		this.flushBatch()
		const old = this.host
		try {
			this.persisted =
				(await old.exportState().catch(() => this.persisted)) ?? this.persisted
			await old.close()
			const caps = this.deps.sources.getCaps(this.sourceId)
			if (!this.running) return
			if (!isScannerIqFormat(caps)) {
				// The old host is closed and no new one can start: report it rather than run dead.
				const err = new WaveKitError(
					`Source ${this.sourceId} is no longer an IQ source the scanner can read`,
					"SCANNER_SOURCE_NOT_IQ",
				)
				this.fail(err)
				return
			}
			this.inflightBytes = 0
			this.pool.length = 0
			// The old host's pending epochs and stream starts never arrive.
			this.pendingMeta.clear()
			this.openingStreams.length = 0
			this.host = this.createHost(caps.sampleRate)
			if (this.masks) this.send({ kind: "masks", ...this.masks })
			if (this.spectrumFeed) this.send({ kind: "spectrum-feed", enabled: true })
			this.restarting = false
			this.dropStaleBranchMarks()
			this.beginStream(trust)
		} finally {
			this.restarting = false
		}
	}

	/** Restart from an event handler: a failure (e.g. the host cannot be created) becomes "error". */
	private restartInBackground(trust: TuningTrust): void {
		this.restartPipeline(trust).catch((err: unknown) => {
			const error =
				err instanceof Error
					? err
					: new WaveKitError(String(err), "SCANNER_PIPELINE_ERROR")
			this.fail(error)
		})
	}

	private initialTrust(): TuningTrust {
		const state = this.deps.tuner?.getState(this.sourceId)
		if (state && !(state.unknownFields ?? []).includes("frequency"))
			return "commanded"
		return "unverified"
	}

	private beginStream(trust: TuningTrust): void {
		this.flushBatch()
		const caps = this.deps.sources.getCaps(this.sourceId)
		const sampleRateHz = this.cfg?.sampleRateHz ?? caps?.sampleRate ?? 0
		this.stream += 1
		this.nextSample = 0
		this.remainder = new Uint8Array(0)
		this.skipBytes = 0
		// The old stream's pendingMeta stays until this stream's own epoch-started (onEvents).
		this.externalPending = null
		const ringSeconds = Math.max(
			this.deps.settings().ringSeconds,
			this.ringSecondsMin,
		)
		this.ringRateHz = sampleRateHz
		this.ringCapacity = Math.max(1, Math.round(ringSeconds * sampleRateHz))
		this.ring = new IqRing({
			bytesPerSample: this.bps,
			capacitySamples: this.ringCapacity,
		})
		const gainKey = gainKeyOf(this.deps.tuner?.getState(this.sourceId))
		this.lastEpoch += 1
		this.openingStreams.push({
			stream: this.stream,
			epoch: this.lastEpoch,
			startSample: null,
			centreHz: caps?.centerFreq ?? 0,
			sampleRateHz,
			gainKey,
			tuningTrust: trust,
			settleMode: null,
		})
		// Before new-stream: an inline pipeline answers it synchronously (R2).
		this.emit("stream", this.stream, "restart")
		this.send({
			kind: "new-stream",
			stream: this.stream,
			centreHz: caps?.centerFreq ?? 0,
			sampleRateHz,
			gainKey,
			tuningTrust: trust,
		})
	}

	private send(input: PipelineInput, transfer?: ArrayBuffer): void {
		if (!this.host) {
			if (transfer) this.onBuffer(transfer)
			return
		}
		this.host.send(input, transfer)
	}

	// === Internals: bytes, gaps and batches ===

	private readonly onData = (chunk: Buffer): void => {
		// A branch can deliver synchronously in the trigger's own tick, before its microtask.
		if (this.externalPending) this.flushExternal()
		if (!this.running || this.restarting) {
			this.branchBytes += chunk.length
			return
		}
		let pos = this.branchBytes
		let off = 0
		while (off < chunk.length) {
			const mark = this.branchQueue[0]
			if (mark && mark.atBranchByte <= pos) {
				this.branchQueue.shift()
				this.applyMark(mark)
				continue
			}
			const limit = mark
				? Math.min(chunk.length, off + (mark.atBranchByte - pos))
				: chunk.length
			this.ingest(chunk.subarray(off, limit))
			pos += limit - off
			off = limit
		}
		this.branchBytes = pos
		this.applyDueMarks()
	}

	/** Applies queued gaps and stream boundaries the delivered bytes have reached. */
	private applyDueMarks(): void {
		if (!this.running || this.restarting) return
		while (
			this.branchQueue[0] &&
			this.branchQueue[0].atBranchByte <= this.branchBytes
		) {
			this.applyMark(this.branchQueue.shift()!)
		}
	}

	private applyMark(mark: BranchMark): void {
		if (mark.kind === "gap") this.applyGap(mark.droppedBytes)
		else this.beginStream(mark.trust)
	}

	/** Bytes the fanout accepted into the branch so far (written minus dropped). */
	private acceptedBranchBytes(t: BranchTelemetry | undefined): number {
		return t ? t.totalBytesWritten - t.droppedBytesTotal : this.branchBytes
	}

	/**
	 * Starts a new stream at the branch byte the fanout has accepted so far:
	 * bytes still buffered in the branch finish the old stream. An open drop
	 * episode is split there, so each stream gets only its own dropped bytes.
	 */
	private queueStreamBoundary(trust: TuningTrust): void {
		const t = this.fanout?.getBranchTelemetry(this.branchId)
		const at = this.acceptedBranchBytes(t)
		if (this.bpMark && t) {
			const dropped = t.droppedBytesTotal - this.bpMark.droppedAt
			if (dropped > 0) {
				this.branchQueue.push({
					kind: "gap",
					atBranchByte: this.bpMark.atBranchByte,
					droppedBytes: dropped,
				})
			}
			this.bpMark = { atBranchByte: at, droppedAt: t.droppedBytesTotal }
		}
		this.branchQueue.push({ kind: "stream", atBranchByte: at, trust })
		this.streamStartByte = at
		this.applyDueMarks()
	}

	/**
	 * A stream started directly (pipeline restart) after the bytes up to
	 * `branchBytes` were discarded: marks at or before that point, and drops an
	 * open episode already counted, belong to the discarded segment.
	 */
	private dropStaleBranchMarks(): void {
		while (
			this.branchQueue[0] &&
			this.branchQueue[0].atBranchByte <= this.branchBytes
		) {
			this.branchQueue.shift()
		}
		const t = this.fanout?.getBranchTelemetry(this.branchId)
		if (this.bpMark && t) {
			this.bpMark = {
				atBranchByte: this.acceptedBranchBytes(t),
				droppedAt: t.droppedBytesTotal,
			}
		}
		this.streamStartByte = this.branchBytes
	}

	private ingest(input: Uint8Array): void {
		let bytes = input
		if (this.skipBytes > 0) {
			const n = Math.min(this.skipBytes, bytes.length)
			this.skipBytes -= n
			bytes = bytes.subarray(n)
		}
		if (this.remainder.length > 0) {
			const joined = new Uint8Array(this.remainder.length + bytes.length)
			joined.set(this.remainder, 0)
			joined.set(bytes, this.remainder.length)
			bytes = joined
			this.remainder = new Uint8Array(0)
		}
		const usable = bytes.length - (bytes.length % this.bps)
		if (usable < bytes.length)
			this.remainder = Uint8Array.from(bytes.subarray(usable))
		if (usable === 0) return
		const piece = bytes.subarray(0, usable)
		const start = this.nextSample
		this.ring?.write(start, piece)
		for (const listener of this.taps) listener(start, piece)
		this.appendBatch(start, piece)
		this.nextSample += usable / this.bps
	}

	/** `droppedBytes` were lost at the current position (fanout drop-on-congestion). */
	private applyGap(droppedBytes: number): void {
		const lost = droppedBytes + this.remainder.length
		this.remainder = new Uint8Array(0)
		const rem = lost % this.bps
		const samples = Math.ceil(lost / this.bps)
		this.skipBytes = rem === 0 ? 0 : this.bps - rem
		if (samples === 0) return
		this.markGap(samples)
	}

	private markGap(samples: number): void {
		this.flushBatch()
		const start = this.nextSample
		this.send({ kind: "gap", startSample: start, samples })
		this.ring?.markGap(start, samples)
		this.nextSample += samples
		this.gapSamplesTotal += samples
	}

	private appendBatch(start: number, piece: Uint8Array): void {
		let off = 0
		while (off < piece.length) {
			if (!this.batch) {
				const buf = this.takeBuffer()
				if (!buf) {
					// Worker is behind (> 4 MiB in flight): the worker gets a gap for
					// these samples; the ring and probe taps already have the bytes.
					this.flushBatch()
					const samples = (piece.length - off) / this.bps
					this.send({
						kind: "gap",
						startSample: start + off / this.bps,
						samples,
					})
					this.workerDroppedSamples += samples
					return
				}
				this.batch = { buf, used: 0, start: start + off / this.bps }
			}
			const space = this.batch.buf.byteLength - this.batch.used
			const n = Math.min(space, piece.length - off)
			new Uint8Array(this.batch.buf, this.batch.used, n).set(
				piece.subarray(off, off + n),
			)
			this.batch.used += n
			off += n
			if (this.batch.used === this.batch.buf.byteLength) this.flushBatch()
		}
		if (this.batch && !this.flushTimer) {
			this.flushTimer = setTimeout(() => {
				this.flushTimer = null
				this.flushBatch()
			}, BATCH_FLUSH_MS)
			this.flushTimer.unref()
		}
	}

	private takeBuffer(): ArrayBuffer | null {
		const pooled = this.pool.pop()
		if (pooled) return pooled
		if (this.inflightBytes + this.batchBytes > MAX_INFLIGHT_BYTES) return null
		return new ArrayBuffer(this.batchBytes)
	}

	private flushBatch(): void {
		if (this.flushTimer) {
			clearTimeout(this.flushTimer)
			this.flushTimer = null
		}
		const batch = this.batch
		this.batch = null
		if (!batch) return
		if (batch.used === 0) {
			this.pool.push(batch.buf)
			return
		}
		this.inflightBytes += batch.buf.byteLength
		this.send(
			{
				kind: "bytes",
				startSample: batch.start,
				bytes: new Uint8Array(batch.buf, 0, batch.used),
			},
			batch.buf,
		)
	}

	private onBuffer(buffer: ArrayBuffer): void {
		this.inflightBytes = Math.max(0, this.inflightBytes - buffer.byteLength)
		if (buffer.byteLength === this.batchBytes && this.pool.length < 32)
			this.pool.push(buffer)
	}

	private readonly onBackpressure = (branchId: string): void => {
		if (branchId !== this.branchId || !this.fanout) return
		const t = this.fanout.getBranchTelemetry(branchId)
		if (!t) return
		this.bpMark = {
			atBranchByte: t.totalBytesWritten - t.droppedBytesTotal,
			droppedAt: t.droppedBytesTotal,
		}
	}

	private readonly onDrain = (branchId: string): void => {
		if (branchId !== this.branchId || !this.fanout || !this.bpMark) return
		const t = this.fanout.getBranchTelemetry(branchId)
		const mark = this.bpMark
		this.bpMark = null
		if (!t) return
		const dropped = t.droppedBytesTotal - mark.droppedAt
		if (dropped <= 0) return
		this.branchQueue.push({
			kind: "gap",
			atBranchByte: mark.atBranchByte,
			droppedBytes: dropped,
		})
		this.applyDueMarks()
	}

	private readonly onBranchError = (err: Error): void => {
		this.log.warn({ err }, "Scanner branch error")
	}

	// === Internals: pipeline events ===

	private onEvents(events: PipelineEvent[]): void {
		for (const ev of events) {
			if (ev.kind === "epoch-started") {
				this.lastEpoch = Math.max(this.lastEpoch, ev.epoch)
				// An untracked retune (below) registers its meta under the epoch the pipeline started.
				let meta = this.pendingMeta.get(ev.epoch) ?? null
				this.pendingMeta.delete(ev.epoch)
				if (!meta && ev.settleMode === "none") {
					// A stream's own start: each new-stream is answered by exactly one, in order.
					meta = this.openingStreams.shift() ?? null
					// Epochs the older stream still had pending can no longer start.
					const stream = meta?.stream
					if (stream !== undefined) {
						for (const [epoch, m] of this.pendingMeta) {
							if (m.stream < stream) this.pendingMeta.delete(epoch)
						}
					}
				}
				// Late old-stream events keep the old stream's labels (thread host).
				this.current = {
					...(meta ?? this.current),
					stream: meta?.stream ?? this.current.stream,
					epoch: ev.epoch,
					startSample: ev.startSample,
					settleMode: ev.settleMode,
				}
				if (ev.settleMode === "marker") this.marker = true
			} else if (ev.kind === "untracked-retune") {
				// § 4.7: the pipeline already started an unverified epoch (Task 10b); record it, post nothing.
				this.lastEpoch = Math.max(this.lastEpoch, ev.epoch)
				const caps = this.deps.sources.getCaps(this.sourceId)
				this.pendingMeta.set(ev.epoch, {
					...this.current,
					epoch: ev.epoch,
					startSample: null,
					centreHz:
						this.centreOverride ?? caps?.centerFreq ?? this.current.centreHz,
					tuningTrust: "unverified",
					settleMode: null,
				})
				this.warn("untracked-retune", ev.deltaHz)
			} else if (ev.kind === "stats") {
				this.lastStats = ev.stats
				if (ev.stats.stuckTestMode) this.marker = false
			}
			this.emit("pipeline", ev, this.currentEpoch())
		}
	}

	// === Internals: epoch triggers (§ 4.6, § 4.7) ===

	private subscribe(): void {
		this.deps.sources.on("disconnected", this.onDisconnected)
		this.deps.sources.on("payload-started", this.onPayloadStarted)
		this.deps.sources.on("caps-changed", this.onCapsChanged)
		const tuner = this.deps.tuner
		if (tuner) {
			tuner.on("command-sent", this.onCommandSent)
			tuner.on("state-changed", this.onStateChanged)
			this.lastTunerKey = this.tunerKey(tuner.getState(this.sourceId))
		}
	}

	private unsubscribe(): void {
		this.deps.sources.off("disconnected", this.onDisconnected)
		this.deps.sources.off("payload-started", this.onPayloadStarted)
		this.deps.sources.off("caps-changed", this.onCapsChanged)
		this.deps.tuner?.off("command-sent", this.onCommandSent)
		this.deps.tuner?.off("state-changed", this.onStateChanged)
	}

	private readonly onDisconnected = (sourceId: string): void => {
		if (sourceId !== this.sourceId || !this.running) return
		this.awaitingPayload = true
		this.queueStreamBoundary("unverified")
	}

	private readonly onPayloadStarted = (sourceId: string): void => {
		if (sourceId !== this.sourceId || !this.running) return
		if (this.awaitingPayload) {
			this.awaitingPayload = false
			return
		}
		// No disconnect seen: a new stream only if bytes arrived since the last one started.
		const accepted = this.acceptedBranchBytes(
			this.fanout?.getBranchTelemetry(this.branchId),
		)
		if (accepted > this.streamStartByte) this.queueStreamBoundary("unverified")
	}

	private readonly onCommandSent = (
		sourceId: string,
		command: string,
		_value: number,
		origin?: TunerCommandOrigin,
	): void => {
		if (
			sourceId !== this.sourceId ||
			this.suppressed > 0 ||
			origin === "scanner"
		)
			return
		if (!EPOCH_COMMANDS.has(command)) return
		this.queueExternal("commanded")
	}

	private readonly onStateChanged = (
		sourceId: string,
		state: TunerState,
	): void => {
		if (sourceId !== this.sourceId) return
		const key = this.tunerKey(state)
		const previous = this.lastTunerKey
		this.lastTunerKey = key
		if (this.suppressed > 0 || previous === null || previous === key) return
		if (state.controlMode === "external") this.queueExternal("relay")
	}

	private readonly onCapsChanged = (
		sourceId: string,
		caps: SourceCaps,
	): void => {
		if (sourceId !== this.sourceId || !this.running) return
		if (caps.sampleRate !== this.cfg?.sampleRateHz) {
			if (this.suppressed === 0) this.queueExternal(this.externalTrust())
			return
		}
		if (this.suppressed > 0) return
		if (
			caps.centerFreq !== undefined &&
			caps.centerFreq !== this.current.centreHz
		) {
			this.queueExternal(this.externalTrust())
		}
	}

	/**
	 * A write that landed inside the scanner's suppression window (a REST write during a retune)
	 * posted no epoch: when the window closes, a caps centre other than the latest submitted one
	 * (or the current epoch's) gets an external epoch (Task 35 fix round, review finding 14).
	 */
	private checkSuppressedCentre(): void {
		if (!this.running || this.restarting) return
		const caps = this.deps.sources.getCaps(this.sourceId)
		if (caps?.centerFreq === undefined) return
		let expected = this.current.centreHz
		for (const meta of this.openingStreams) expected = meta.centreHz
		for (const meta of this.pendingMeta.values()) expected = meta.centreHz
		if (caps.centerFreq !== expected) this.queueExternal(this.externalTrust())
	}

	private externalTrust(): TuningTrust {
		const state = this.deps.tuner?.getState(this.sourceId)
		return state?.controlMode === "external" ? "relay" : "commanded"
	}

	private tunerKey(state: TunerState | undefined): string | null {
		return state
			? `${state.frequency}:${state.sampleRate}:${gainKeyOf(state)}:${state.ppm}`
			: null
	}

	private warn(code: EngineWarning["code"], deltaHz: number | null): void {
		this.warningList.push({ code, deltaHz, at: Date.now() })
		if (this.warningList.length > MAX_WARNINGS) this.warningList.shift()
		this.log.warn({ code, deltaHz }, "Spectrum engine trust warning")
		this.emit("warning", code, deltaHz)
	}

	/** § 4.7: a host-reported centre that disagrees with caps makes new data unverified. */
	private async checkHostCentre(reader: HostCentreReader): Promise<void> {
		if (!this.running) return
		const reported = await reader.read(this.sourceId).catch(() => null)
		if (reported === null || !this.running) return
		const caps = this.deps.sources.getCaps(this.sourceId)?.centerFreq
		if (caps === undefined) return
		const mismatch = Math.abs(reported - caps) > HOST_CENTRE_TOLERANCE_HZ
		if (!mismatch) {
			this.centreOverride = null
			return
		}
		if (this.centreOverride === reported) return
		this.centreOverride = reported
		this.warn("host-centre-mismatch", reported - caps)
		this.queueExternal("unverified")
	}

	/** Captures the command position now; posts at its microtask or at the next branch delivery, whichever comes first. */
	private queueExternal(trust: TuningTrust): void {
		if (!this.running) return
		if (this.externalPending) {
			if (
				trust === "unverified" ||
				(trust === "relay" && this.externalPending.trust !== "unverified")
			) {
				this.externalPending.trust = trust
			}
			return
		}
		const clock = this.sampleClock()
		this.externalPending = {
			trust,
			commandSample: clock.commandSample,
			bufferedSamples: clock.bufferedSamples,
		}
		queueMicrotask(() => this.flushExternal())
	}

	private flushExternal(): void {
		const pending = this.externalPending
		this.externalPending = null
		if (!pending || !this.running || this.restarting) return
		const caps = this.deps.sources.getCaps(this.sourceId)
		if (!caps) return
		if (caps.sampleRate !== this.cfg?.sampleRateHz) {
			this.restartInBackground(pending.trust)
			return
		}
		const fs = caps.sampleRate
		const s = this.deps.settings()
		const centreHz =
			this.centreOverride ?? caps.centerFreq ?? this.current.centreHz
		this.submitEpoch({
			epoch: this.allocateEpoch(),
			commandSample: pending.commandSample,
			bufferedSamples: pending.bufferedSamples,
			settleSamples: Math.round((s.sweep.settleMs.network * fs) / 1000),
			expectMarker: false,
			markerTimeoutSamples: 0,
			pllSettleSamples: 0,
			centreHz,
			sampleRateHz: fs,
			gainKey: gainKeyOf(this.deps.tuner?.getState(this.sourceId)),
			tuningTrust: pending.trust,
			centreChanged: centreHz !== this.current.centreHz,
		})
	}

	/** Diagnostics for status (§ 12.1). */
	accounting(): {
		stream: number
		liveEdge: number
		gapSamples: number
		workerDroppedSamples: number
	} {
		return {
			stream: this.stream,
			liveEdge: this.nextSample,
			gapSamples: this.gapSamplesTotal,
			workerDroppedSamples: this.workerDroppedSamples,
		}
	}
}

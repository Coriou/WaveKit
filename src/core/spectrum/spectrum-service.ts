/**
 * Core spectrum service: one SpectrumEngine per source, ref-counted by consumers (scanner jobs
 * `job:<id>` and display clients `ws:<clientId>`, kept in separate sets), spectrum frames for
 * waterfalls per profile (the default from scanner.ws plus bounded per-client profiles), and the
 * per-source occupancy history (Task 17a).
 *
 * Only scanner consumers produce `"stream"`/`"released"` events (R2): display demand never
 * reaches the scanner and never reconfigures an engine. The engine stays behind PipelineHost
 * (Task 32); a future third host may run the FFT inside wavekit-chan, which already reads the
 * full CU8 stream.
 */
import { EventEmitter } from "node:events"
import { performance } from "node:perf_hooks"
import {
	SPECTRUM_BINS_CAP_CHOICES,
	SPECTRUM_BINS_CAP_SETTINGS,
} from "@wavekit/api-types"
import type {
	SpectrumActiveProfile,
	SpectrumBinsCapView,
	SpectrumBinEncoding,
	SpectrumFrameEventData,
	SpectrumFrameTrack,
	SpectrumOccupancyResponse,
	SpectrumProfileAdjustment,
	SpectrumProfileEventData,
	SpectrumSourceStatus,
	SpectrumStatus,
	SpectrumSubscribeErrorCode,
} from "@wavekit/api-types"
import type { SourceConfig, SourceManager } from "../source-manager.js"
import type { SourceFanoutRouter } from "../source-fanout-router.js"
import type { TunerController } from "../tuner-controller.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import { WaveKitError } from "../../utils/errors.js"
import { spectrumMainSpanSink } from "./pipeline.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import { frameTrackScannerOf } from "./frame-tracks.js"
import type { SpectrumTrackIdentityLookup } from "./track-identity-contract.js"
import {
	OccupancyHistory,
	OccupancyStateSchema,
	type OccupancyState,
} from "./occupancy.js"
import type {
	BlockSummary,
	BlockTrack,
	EngineState,
	FreqRange,
	PipelineConfig,
	PipelineEvent,
	SpectrumSettings,
	TuningTrust,
} from "./types.js"
import type { PipelineHostMode } from "./pipeline-host.js"
import { mergeTrust } from "./retune-settle.js"
import {
	BACKFILL_LIMITS,
	PROFILE_BINS_CEILING,
	PROFILE_BINS_FLOOR,
	PROFILE_LIMITS,
	SpectrumSubscribeOptionsSchema,
} from "./subscribe-options.js"
import {
	admitProfile,
	applyAverage,
	averagingOf,
	makeProfile,
	normaliseProfile,
	profileKey,
	profileView,
	type SpectrumProfile,
} from "./spectrum-averaging.js"
import {
	appendSummary,
	buildBackfillFrames,
	normaliseBackfillMs,
	type SummaryStamp,
} from "./spectrum-backfill.js"
import {
	SpectrumEngine,
	USABLE_FRACTION,
	buildPipelineConfig,
	isScannerIqFormat,
	type EngineEpoch,
	type EngineStreamReason,
	type EngineTuning,
	type HostCentreReader,
	type SpectrumEngineDeps,
} from "./spectrum-engine.js"

export const BIN_ENCODING: SpectrumBinEncoding = "u8-halfdb-127.5"
export const WS_CONSUMER_PREFIX = "ws:"
export const wsConsumer = (clientId: string): string =>
	`${WS_CONSUMER_PREFIX}${clientId}`
export {
	BACKFILL_LIMITS,
	PROFILE_LIMITS,
	SpectrumSubscribeOptionsSchema,
} from "./subscribe-options.js"
export {
	nearestProfile,
	normaliseProfile,
	profileKey,
	type SpectrumProfile,
} from "./spectrum-averaging.js"
const MAX_SINCE_MS = 168 * 3_600_000
/** WG11 req 5.3: a failing or malformed identity lookup logs one fixed-text debug line per minute. */
export const TRACK_IDENTITY_LOG_INTERVAL_MS = 60_000
const TOP_N = 10

/** The default profile from ws.spectrumHz/spectrumBins, averaging off (settings are already bounded). */
export function defaultProfile(
	s: SpectrumSettings,
	/** WG8: the client bins bound; the served default never exceeds it. */
	maxBins: number = Number.POSITIVE_INFINITY,
): SpectrumProfile {
	const hz = s.ws.spectrumHz
	const bins = Math.min(s.ws.spectrumBins, maxBins)
	return { key: profileKey(hz, bins), hz, bins }
}

/** n = max(1, ceil(blockHz / hz)): one frame per n block summaries. */
export function summariesPerFrame(blockHz: number, hz: number): number {
	return Math.max(1, Math.ceil(blockHz / hz - 1e-9))
}

export function encodeBins(dbfs: ArrayLike<number>): string {
	const out = new Uint8Array(dbfs.length)
	for (let i = 0; i < dbfs.length; i++) {
		const v = Math.round((dbfs[i]! + 127.5) * 2)
		out[i] = Number.isFinite(v) ? Math.min(255, Math.max(0, v)) : 0
	}
	return Buffer.from(out.buffer, out.byteOffset, out.byteLength).toString(
		"base64",
	)
}

export function decodeBins(b64: string): number[] {
	return [...Buffer.from(b64, "base64")].map(v => v / 2 - 127.5)
}

/** Max over groups of `factor` bins so the result has ≤ maxBins entries (never upsamples). */
export function reduceMaxHold(
	bins: ArrayLike<number>,
	maxBins: number,
): { bins: Float32Array; factor: number } {
	const factor = Math.max(1, Math.ceil(bins.length / Math.max(1, maxBins)))
	const out = new Float32Array(Math.ceil(bins.length / factor))
	for (let i = 0; i < out.length; i++) {
		let m = -Infinity
		const end = Math.min(bins.length, (i + 1) * factor)
		for (let j = i * factor; j < end; j++) m = Math.max(m, bins[j]!)
		out[i] = m
	}
	return { bins: out, factor }
}

/**
 * Where engine state and occupancy histories are stored. The scanner's ScannerPersistence
 * (Tasks 16, 17a) implements it structurally; the spectrum layer never imports the scanner.
 */
export interface SpectrumPersistence {
	writeEngine(sourceId: string, s: EngineState): Promise<void>
	loadEngine(sourceId: string): Promise<EngineState | null>
	writeOccupancy(sourceId: string, s: OccupancyState): Promise<void>
	loadOccupancy(sourceId: string): Promise<OccupancyState | null>
}

// on/off come from EventEmitter: picking them from SourceManager/TunerController would return the
// polymorphic `this` (the class), which EventEmitter fakes cannot satisfy (PlanReviewB #10; Task 32 does the same).
export interface SpectrumServiceDeps {
	sources: Pick<SourceManager, "getCaps" | "getStream"> &
		Pick<EventEmitter, "on" | "off">
	routing: Pick<SourceFanoutRouter, "getFanout" | "releaseUnused">
	tuner:
		| (Pick<TunerController, "getState"> & Pick<EventEmitter, "on" | "off">)
		| null
	sourceConfigs: readonly SourceConfig[]
	settings: () => SpectrumSettings
	/** fftSize/integration/k of the lease holder's job (ScannerService.engineTuning). */
	tuning: (sourceId: string) => EngineTuning
	persistence: SpectrumPersistence
	logger: Logger
	now?: () => number
	engineHost?: PipelineHostMode
	hostCentre?: HostCentreReader
	/** Test seam: production omits it. */
	createHost?: SpectrumEngineDeps["createHost"]
	/** Called for every new engine instance before it starts (the probe pool's stream watch, Task 34). */
	engineCreated?: (sourceId: string, engine: SpectrumEngine) => void
	/** Opt-in worker stage profile forwarded to each engine. Absent: no profile. */
	profile?: { sampleEvery: number }
	/**
	 * WG8 req 5: the host bins cap, resolved once at startup (bin-cap.ts). Absent = the 2 048
	 * floor and no `limits.binsCap` on the status. Read once at construction.
	 */
	binsCap?: () => SpectrumBinsCapView
}

const BINS_CAP_FALLBACK: SpectrumBinsCapView = {
	setting: "auto",
	cap: PROFILE_BINS_FLOOR,
	source: "fallback",
}

/**
 * Evaluates the cap dep once and reads each field once into a snapshot; only an allowlisted,
 * self-consistent {setting, cap, source} is kept (extra fields are ignored). Any throw, missing
 * or unknown value, or contradiction ("fallback" with a cap other than the floor, "config" with
 * setting !== cap, "measured" with a fixed setting) answers the floor with source "fallback".
 */
function resolveBinsCap(dep: (() => SpectrumBinsCapView) | undefined): {
	view: SpectrumBinsCapView | null
	cap: number
} {
	if (!dep) return { view: null, cap: PROFILE_BINS_FLOOR }
	try {
		const raw: unknown = dep()
		if (typeof raw === "object" && raw !== null) {
			const r = raw as Record<string, unknown>
			const setting = r["setting"]
			const cap = r["cap"]
			const source = r["source"]
			const settingOk = (
				SPECTRUM_BINS_CAP_SETTINGS as readonly unknown[]
			).includes(setting)
			const capOk =
				typeof cap === "number" &&
				(SPECTRUM_BINS_CAP_CHOICES as readonly number[]).includes(cap)
			const consistent =
				(source === "fallback" && cap === PROFILE_BINS_FLOOR) ||
				(source === "config" && setting === cap) ||
				(source === "measured" && setting === "auto")
			if (settingOk && capOk && consistent) {
				const view: SpectrumBinsCapView = {
					setting: setting as SpectrumBinsCapView["setting"],
					cap,
					source,
				}
				return { view, cap }
			}
		}
	} catch {
		// fall through to the floor
	}
	return { view: { ...BINS_CAP_FALLBACK }, cap: PROFILE_BINS_FLOOR }
}

/** Max-hold of one profile on one source; `epoch` is the summary epoch its bins came from. */
export interface SpectrumHold {
	bins: Float32Array | null
	factor: number
	epoch: number
	/** Summaries since the last frame (survives a hold reset). */
	count: number
	/** Exponential average of completed frames. Null until the first; cleared on reset. */
	avg: Float32Array | null
	/** Summary stream the bins came from. A change clears `avg`. */
	stream?: number
	/** WG9 R3: the worst label of the summaries in `bins` (absent: none given). */
	trust?: TuningTrust
	/** WG9 R3: the worst label of the frames in `avg` (absent with `avg`). */
	avgTrust?: TuningTrust
}

/**
 * Max-holds `reduced` into `hold`. A different epoch (retune), stream or bin layout starts a
 * fresh hold and drops `avg`, so the frame label always matches its bins. Clearing `bins`
 * after a completed frame does not reset `avg`. The caller counts summaries; the count survives.
 */
export function accumulateHold(
	hold: SpectrumHold | undefined,
	reduced: { bins: Float32Array; factor: number },
	epoch: number,
	stream?: number,
	trust?: TuningTrust,
): SpectrumHold {
	const h: SpectrumHold = hold ?? {
		bins: null,
		factor: reduced.factor,
		epoch,
		count: 0,
		avg: null,
	}
	const streamChanged =
		stream !== undefined && h.stream !== undefined && h.stream !== stream
	const lengthMatches =
		(h.bins !== null && h.bins.length === reduced.bins.length) ||
		(h.bins === null &&
			(h.avg === null || h.avg.length === reduced.bins.length))
	const sameLayout =
		h.epoch === epoch && h.factor === reduced.factor && lengthMatches
	if (h.bins && sameLayout && !streamChanged) {
		for (let i = 0; i < h.bins.length; i++)
			h.bins[i] = Math.max(h.bins[i]!, reduced.bins[i]!)
		// WG9 R3: fail closed, the held frame is as trusted as its worst summary.
		if (trust !== undefined)
			h.trust = h.trust === undefined ? trust : mergeTrust(h.trust, trust)
	} else {
		if (!sameLayout || streamChanged) {
			h.avg = null
			delete h.avgTrust
		}
		h.bins = reduced.bins
		h.factor = reduced.factor
		h.epoch = epoch
		if (trust !== undefined) h.trust = trust
		else delete h.trust
	}
	if (stream !== undefined) h.stream = stream
	return h
}

/**
 * WG9 R3: one averaging step and its label. An average holding `unverified` frames restarts
 * at the first trusted frame, so a trusted frame never carries pre-settle bins; otherwise
 * the label is the worse of the average's and the frame's. A uniformly labelled epoch (the
 * scanner's, or any without an unverified window) never restarts: the bytes are unchanged.
 */
export function averageTrusted(
	avg: Float32Array | null,
	avgTrust: TuningTrust | undefined,
	frame: Float32Array,
	frameTrust: TuningTrust,
	n: number,
): { avg: Float32Array; trust: TuningTrust } {
	const seed =
		avg === null ||
		avg.length !== frame.length ||
		(avgTrust === "unverified" && frameTrust !== "unverified")
	return {
		avg: applyAverage(seed ? null : avg, frame, n),
		trust: seed ? frameTrust : mergeTrust(avgTrust ?? frameTrust, frameTrust),
	}
}

/** Diagnostics (status and logs only); a fresh copy. */
export interface SpectrumAllocation {
	/** U: distinct non-default pairs `${sourceId}:${key}` over every client's current ∪ next, sorted. */
	reserved: string[]
	/** Non-default pairs over `current` only (what frames are built for), sorted. */
	built: string[]
	/** Per source with an entry: sorted consumer ids. */
	consumers: Record<string, { jobs: string[]; displays: string[] }>
	/** Client states alive (a running or pending op, or demand). */
	clients: number
}

/**
 * A client's selection. `sourceId: null` is the default selection (the default profile on
 * every source in `sources`); otherwise one source with one profile. `sources` are the sources
 * the client receives frames for (fixed at commit; a removal deletes from it).
 */
interface Selection {
	sourceId: string | null
	profile: SpectrumProfile | null
	sources: Set<string>
	/** Per subscribe, not part of the shared profile. 0 = no backfill. */
	backfillMs: number
}

type ClientOp =
	| { kind: "subscribe"; options: unknown }
	| { kind: "unsubscribe" }

interface ClientState {
	current: Selection | null
	/** Admitted, being acquired (counted in U). */
	next: Selection | null
	nextAdjusted: SpectrumProfileAdjustment[]
	/** Sources holding wsConsumer(clientId), added the moment acquire resolves. */
	held: Set<string>
	running: Promise<void> | null
	/** Latest wins. */
	pending: ClientOp | null
	/** Bumped by every request, stop() and a removal of a source of `next`. */
	seq: number
	idle: (() => void)[]
}

interface Entry {
	failed?: boolean
	engine: SpectrumEngine
	jobs: Set<string>
	displays: Set<string>
	openedAt: number
	lastSummary: BlockSummary | null
	lastEpoch: EngineEpoch | null
	/** Recent block summaries for waterfall backfill. Lives and dies with the entry. */
	ring: SummaryStamp[]
	holds: Map<string, SpectrumHold>
}

interface RecipientGroup {
	profile: SpectrumProfile
	clients: string[]
}

const pairKey = (sourceId: string, key: string): string => `${sourceId}:${key}`
const errorMessage = (err: unknown): string =>
	err instanceof Error ? err.message : String(err)

export class SpectrumService extends EventEmitter {
	private readonly log: Logger
	private readonly now: () => number
	private readonly entries = new Map<string, Entry>()
	private readonly opening = new Map<string, Promise<SpectrumEngine>>()
	private readonly closing = new Map<string, Promise<void>>()
	private readonly histories = new Map<string, OccupancyHistory>()
	private readonly errors = new Map<string, string>()
	private readonly clients = new Map<string, ClientState>()
	/** M2: last default key seen by syncDefault(). */
	private defaultKey: string | null = null
	/** M1: permanently removed until "connected" again. */
	private readonly removedSources = new Set<string>()
	/** M1: bumped on each permanent removal. */
	private readonly sourceGen = new Map<string, number>()
	private stopping = false
	/** WG11 req 5.3: the scanner's identity of a frame track (wired by Main); null: no `scanner` field. */
	private trackIdentity: SpectrumTrackIdentityLookup | null = null
	private trackIdentityLoggedAt = Number.NEGATIVE_INFINITY

	/** WG8: resolved once; the engine budget and the client clamp read the same cap. */
	private readonly binsCap: {
		view: SpectrumBinsCapView | null
		cap: number
	}

	constructor(private readonly deps: SpectrumServiceDeps) {
		super()
		this.binsCap = resolveBinsCap(deps.binsCap)
		this.log = createComponentLogger(deps.logger, "SpectrumService")
		this.now = deps.now ?? Date.now
	}

	/**
	 * WG11 req 5.3: sets (or clears with null) the scanner identity port. Frames built after
	 * the call (live, snapshot, backfill, status) read it; a throwing or absent lookup, or a
	 * malformed answer, gives no `scanner` field.
	 */
	setTrackIdentityLookup(lookup: SpectrumTrackIdentityLookup | null): void {
		this.trackIdentity = lookup
	}

	/** Loads occupancy histories of every eligible source (engines start on demand). */
	async start(): Promise<void> {
		this.stopping = false
		for (const sourceId of this.eligibleSources()) {
			const history = new OccupancyHistory()
			const raw = await this.deps.persistence
				.loadOccupancy(sourceId)
				.catch(() => null)
			// Persisted data is untrusted: validate before import (S1-A carry).
			const parsed = raw === null ? null : OccupancyStateSchema.safeParse(raw)
			if (parsed && !parsed.success)
				this.log.warn({ sourceId }, "Ignoring an invalid occupancy history")
			else if (parsed && !history.importState(parsed.data))
				this.log.info(
					{ sourceId },
					"Occupancy history had another bucket size; starting fresh",
				)
			this.histories.set(sourceId, history)
		}
		this.deps.sources.on("source-removed", this.onSourceRemoved)
		this.deps.sources.on("connected", this.onSourceConnected)
	}

	async stop(): Promise<void> {
		this.stopping = true
		this.deps.sources.off("source-removed", this.onSourceRemoved)
		this.deps.sources.off("connected", this.onSourceConnected)
		const running: Promise<void>[] = []
		for (const state of this.clients.values()) {
			state.seq += 1
			state.pending = null
			if (state.running) running.push(state.running)
		}
		await Promise.allSettled(running)
		this.clients.clear()
		await Promise.allSettled([...this.opening.values()])
		await Promise.allSettled([...this.closing.values()])
		for (const [sourceId, entry] of [...this.entries]) {
			this.entries.delete(sourceId)
			await this.stopEngine(sourceId, entry, {
				reemitStop: entry.jobs.size > 0,
			})
		}
		await this.persistOccupancy()
	}

	/** Engine state of running engines and every occupancy history (maintenance, every 5 min). */
	async persist(): Promise<void> {
		for (const [sourceId, entry] of this.entries) {
			const state = await entry.engine.exportState().catch(() => null)
			if (state)
				await this.deps.persistence
					.writeEngine(sourceId, state)
					.catch(() => undefined)
		}
		await this.persistOccupancy()
	}

	/** IQ sources the scanner can read, except permanently removed ones. */
	eligibleSources(): string[] {
		return this.deps.sourceConfigs
			.filter(cfg => this.isEligible(cfg.id))
			.map(cfg => cfg.id)
	}

	sourceIds(): string[] {
		return [...this.entries.keys()]
	}

	engine(sourceId: string): SpectrumEngine | undefined {
		return this.entries.get(sourceId)?.engine
	}

	openedAt(sourceId: string): number | null {
		return this.entries.get(sourceId)?.openedAt ?? null
	}

	/** Adds a consumer (`job:<id>` or `ws:<clientId>`); opens the engine on first use. */
	async acquire(sourceId: string, consumer: string): Promise<SpectrumEngine> {
		for (;;) {
			// S1-B final review, finding 5: no engine opens (fanout branch, worker) once stop() began.
			if (this.stopping)
				throw new WaveKitError("Spectrum service stopped", "SPECTRUM_STOPPED")
			// Finding 3: a new engine never opens while the previous one of the source is closing.
			const closing = this.closing.get(sourceId)
			if (closing) {
				await closing.catch(() => undefined)
				continue
			}
			const entry = this.entries.get(sourceId)
			if (entry) {
				this.addConsumer(entry, consumer)
				return entry.engine
			}
			const inflight = this.opening.get(sourceId)
			if (!inflight) break
			await inflight
		}
		const opening = this.open(sourceId, consumer)
		this.opening.set(sourceId, opening)
		try {
			return await opening
		} finally {
			this.opening.delete(sourceId)
		}
	}

	/**
	 * Removes a consumer. A `job:` release that leaves the engine up emits `"released"`; the last
	 * consumer stops the engine, re-emitting `"stream"(…, "stop")` only when it was a job (R2).
	 */
	async release(sourceId: string, consumer: string): Promise<void> {
		const opening = this.opening.get(sourceId)
		if (opening) await opening.catch(() => undefined)
		const entry = this.entries.get(sourceId)
		if (!entry) return
		const wasJob = entry.jobs.delete(consumer)
		if (!wasJob && !entry.displays.delete(consumer)) return
		if (entry.jobs.size + entry.displays.size > 0) {
			if (wasJob) this.emit("released", sourceId, consumer)
			return
		}
		await this.closeEntry(sourceId, entry, wasJob)
	}

	/** WS `spectrum` subscribe: `undefined` = the default selection. Never rejects; answers through `"profile"`. */
	subscribe(clientId: string, options: unknown): Promise<void> {
		return this.request(clientId, { kind: "subscribe", options })
	}

	/** WS unsubscribe or disconnect: releases the client's demand. Never rejects. */
	unsubscribe(clientId: string): Promise<void> {
		return this.request(clientId, { kind: "unsubscribe" })
	}

	/**
	 * Re-creates the pipeline when the lease holder's tuning differs from the running config (jobs
	 * only; never display demand, R2). Compared on the resolved config, so the defaults come back once
	 * no holder remains (S1-B final review, finding 2).
	 */
	async refreshTuning(sourceId: string): Promise<void> {
		const engine = this.engine(sourceId)
		const cfg = engine?.config()
		if (!engine || !cfg) return
		const want = buildPipelineConfig(
			sourceId,
			engine.format,
			cfg.sampleRateHz,
			this.deps.settings(),
			this.deps.tuning(sourceId),
			undefined,
			this.binsCap.cap,
		)
		const differs =
			want.fftSize !== cfg.fftSize ||
			want.integrationMs !== cfg.integrationMs ||
			want.thresholdDb !== cfg.thresholdDb ||
			want.faTargetPerMhzMin !== cfg.faTargetPerMhzMin
		if (differs) await engine.reconfigure()
	}

	/** Scheduler seed (Task 19 `activitySeed`, via ScannerService): recent duty of a span (a hop's `covered`). */
	activitySeed(sourceId: string): (range: FreqRange) => number {
		return range =>
			this.histories.get(sourceId)?.seedScore(range, this.now()) ?? 0
	}

	occupancyQuery(
		sourceId: string,
		range: FreqRange,
		sinceMs: number,
	): SpectrumOccupancyResponse | null {
		const history = this.histories.get(sourceId)
		if (!history) return null
		const since = Math.min(Math.max(0, sinceMs), MAX_SINCE_MS)
		const now = this.now()
		// OccupancyHistory takes the window start as a time, not a duration.
		const from = now - since
		const q = history.query(range, from, now)
		return {
			sourceId,
			bucketHz: q.bucketHz,
			sinceMs: since,
			buckets: q.buckets,
			top: history.topActive(range, TOP_N, from, now),
		}
	}

	status(): SpectrumStatus {
		const s = this.deps.settings()
		const def = this.servedDefault(s)
		const profiles: SpectrumActiveProfile[] = []
		for (const [sourceId, entry] of this.entries) {
			const cfg = entry.engine.config()
			const summary = entry.lastSummary
			for (const [key, g] of this.recipients(sourceId, def)) {
				const factor = summary
					? Math.max(1, Math.ceil(summary.bins.length / g.profile.bins))
					: null
				const n = cfg
					? summariesPerFrame(1000 / cfg.integrationMs, g.profile.hz)
					: null
				profiles.push({
					sourceId,
					...profileView(g.profile),
					isDefault: key === def.key,
					clients: g.clients.length,
					binCount:
						summary && factor ? Math.ceil(summary.bins.length / factor) : null,
					binHz: summary && factor ? summary.binHz * factor : null,
					summariesPerFrame: n,
					effectiveHz: cfg && n ? 1000 / cfg.integrationMs / n : null,
				})
			}
		}
		const sources: SpectrumSourceStatus[] = this.deps.sourceConfigs.map(cfg =>
			this.sourceStatus(cfg, def),
		)
		let subscribers = 0
		for (const state of this.clients.values()) if (state.current) subscribers++
		return {
			defaultProfile: profileView(def),
			profiles,
			limits: {
				maxProfiles: s.ws.spectrumMaxProfiles,
				hz: { ...PROFILE_LIMITS.hz },
				bins: { ...PROFILE_LIMITS.bins, max: this.clientBinsBound(s) },
				...(this.binsCap.view ? { binsCap: { ...this.binsCap.view } } : {}),
				averaging: { ...PROFILE_LIMITS.averaging },
				backfill: { ...BACKFILL_LIMITS },
			},
			subscribers,
			sources,
		}
	}

	/** The default profile as served: ws.spectrumBins bounded by `clientBinsBound` (WG8). */
	private servedDefault(s: SpectrumSettings): SpectrumProfile {
		return defaultProfile(s, this.clientBinsBound(s))
	}

	/** Largest client `bins`: min(cap, ws.spectrumSummaryBins, ceiling), never below the 128 minimum. */
	private clientBinsBound(s: SpectrumSettings): number {
		return Math.max(
			PROFILE_LIMITS.bins.min,
			Math.min(
				this.binsCap.cap,
				s.ws.spectrumSummaryBins,
				PROFILE_BINS_CEILING,
			),
		)
	}

	allocation(): SpectrumAllocation {
		const defKey =
			this.defaultKey ?? this.servedDefault(this.deps.settings()).key
		const reserved = new Set<string>()
		const built = new Set<string>()
		for (const state of this.clients.values()) {
			for (const sel of [state.current, state.next]) {
				if (!sel?.sourceId || !sel.profile || sel.profile.key === defKey)
					continue
				const pair = pairKey(sel.sourceId, sel.profile.key)
				reserved.add(pair)
				if (sel === state.current) built.add(pair)
			}
		}
		const consumers: SpectrumAllocation["consumers"] = {}
		for (const [sourceId, entry] of this.entries)
			consumers[sourceId] = {
				jobs: [...entry.jobs].sort(),
				displays: [...entry.displays].sort(),
			}
		return {
			reserved: [...reserved].sort(),
			built: [...built].sort(),
			consumers,
			clients: this.clients.size,
		}
	}

	// === engines ===

	private isEligible(sourceId: string): boolean {
		const cfg = this.deps.sourceConfigs.find(c => c.id === sourceId)
		return (
			cfg !== undefined &&
			!this.removedSources.has(sourceId) &&
			isScannerIqFormat(this.deps.sources.getCaps(sourceId) ?? cfg.caps)
		)
	}

	private addConsumer(entry: Entry, consumer: string): void {
		if (consumer.startsWith(WS_CONSUMER_PREFIX)) entry.displays.add(consumer)
		else entry.jobs.add(consumer)
	}

	private async open(
		sourceId: string,
		consumer: string,
	): Promise<SpectrumEngine> {
		const persisted = await this.deps.persistence
			.loadEngine(sourceId)
			.catch(() => null)
		const engineDeps: SpectrumEngineDeps = {
			sourceId,
			sources: this.deps.sources,
			routing: this.deps.routing,
			tuner: this.deps.tuner,
			settings: this.deps.settings,
			binsCap: () => this.binsCap.cap,
			tuning: () => this.deps.tuning(sourceId),
			logger: this.deps.logger,
			host: this.deps.engineHost ?? "thread",
			...(persisted ? { persistedEngine: persisted } : {}),
			...(this.deps.hostCentre ? { hostCentre: this.deps.hostCentre } : {}),
			...(this.deps.createHost ? { createHost: this.deps.createHost } : {}),
			...(this.deps.profile ? { profile: this.deps.profile } : {}),
		}
		const engine = new SpectrumEngine(engineDeps)
		const entry: Entry = {
			engine,
			jobs: new Set(),
			displays: new Set(),
			openedAt: this.now(),
			lastSummary: null,
			lastEpoch: null,
			ring: [],
			holds: new Map(),
		}
		this.addConsumer(entry, consumer)
		engine.on("pipeline", (ev: PipelineEvent, epoch: EngineEpoch) =>
			this.onPipeline(sourceId, entry, ev, epoch),
		)
		engine.on("stream", (stream: number, reason: EngineStreamReason) => {
			// R2: "stop" is re-emitted by stopEngine (only for a job release).
			if (reason === "restart" && entry.jobs.size > 0)
				this.emit("stream", sourceId, stream, reason)
		})
		engine.on("error", (err: Error) => {
			this.errors.set(sourceId, err.message)
			this.log.warn({ err, sourceId }, "Spectrum engine error")
		})
		engine.on("fatal", (err: Error) => {
			if (this.entries.get(sourceId) !== entry) return
			this.errors.set(sourceId, err.message)
			entry.failed = true
			entry.lastSummary = null
			entry.lastEpoch = null
			entry.ring.length = 0
			entry.holds.clear()
			for (const state of this.clients.values()) {
				state.held.delete(sourceId)
				state.current?.sources.delete(sourceId)
				state.next?.sources.delete(sourceId)
			}
			// Remove before notifying jobs: releases cannot attach to this dead instance, and new
			// demand waits for its bounded host close before opening a fresh generation.
			void this.closeEntry(sourceId, entry, entry.jobs.size > 0).catch(
				(error: unknown) =>
					this.log.warn(
						{ err: error, sourceId },
						"Failed engine cleanup failed",
					),
			)
			this.emit("fatal", sourceId, err)
		})
		this.deps.engineCreated?.(sourceId, engine)
		try {
			await engine.start()
		} catch (err) {
			this.errors.set(sourceId, errorMessage(err))
			// WG10 req 4.2: before the source has caps (boot, ahead of `connected`) this is an expected state.
			const preConnect = this.deps.sources.getCaps(sourceId) === undefined
			this.log[preConnect ? "debug" : "warn"](
				{ err, sourceId },
				"Spectrum engine failed to start",
			)
			// Undo any partial setup (branch, listeners, host).
			void engine.stop().catch(() => undefined)
			throw err
		}
		engine.setSpectrumFeed(true)
		this.errors.delete(sourceId)
		this.entries.set(sourceId, entry)
		if (!this.histories.has(sourceId))
			this.histories.set(sourceId, new OccupancyHistory())
		return engine
	}

	/** Stops a consumer-less entry through `closing`, so an acquire of the source waits for it. */
	private async closeEntry(
		sourceId: string,
		entry: Entry,
		reemitStop: boolean,
	): Promise<void> {
		this.entries.delete(sourceId)
		const p = this.stopEngine(sourceId, entry, { reemitStop })
		this.closing.set(sourceId, p)
		try {
			await p
		} finally {
			if (this.closing.get(sourceId) === p) this.closing.delete(sourceId)
		}
	}

	private async stopEngine(
		sourceId: string,
		entry: Entry,
		opts: { reemitStop: boolean },
	): Promise<void> {
		let state: EngineState | null = null
		try {
			state = await entry.engine.stop()
		} catch (err) {
			this.log.warn({ err, sourceId }, "Stopping a spectrum engine failed")
		} finally {
			if (opts.reemitStop)
				this.emit("stream", sourceId, entry.engine.accounting().stream, "stop")
		}
		if (state)
			await this.deps.persistence
				.writeEngine(sourceId, state)
				.catch((err: unknown) =>
					this.log.warn({ err, sourceId }, "Engine state write failed"),
				)
		const history = this.histories.get(sourceId)
		if (history)
			await this.deps.persistence
				.writeOccupancy(sourceId, history.exportState())
				.catch((err: unknown) =>
					this.log.warn({ err, sourceId }, "Occupancy write failed"),
				)
	}

	private async persistOccupancy(): Promise<void> {
		for (const [sourceId, history] of this.histories) {
			await this.deps.persistence
				.writeOccupancy(sourceId, history.exportState())
				.catch((err: unknown) =>
					this.log.warn({ err, sourceId }, "Occupancy write failed"),
				)
		}
	}

	// === client requests (M4) ===

	private request(clientId: string, op: ClientOp): Promise<void> {
		if (this.stopping) return Promise.resolve()
		let state = this.clients.get(clientId)
		if (!state) {
			if (op.kind === "unsubscribe") return Promise.resolve()
			state = {
				current: null,
				next: null,
				nextAdjusted: [],
				held: new Set(),
				running: null,
				pending: null,
				seq: 0,
				idle: [],
			}
			this.clients.set(clientId, state)
		}
		state.seq += 1
		const idle = new Promise<void>(resolve => state.idle.push(resolve))
		// A newer request replaces a pending one: the superseded request gets no ack.
		if (state.running) state.pending = op
		else this.startOp(clientId, state, op)
		return idle
	}

	private startOp(clientId: string, state: ClientState, op: ClientOp): void {
		let done!: () => void
		state.running = new Promise<void>(resolve => (done = resolve))
		const work =
			op.kind === "subscribe"
				? this.subscribeOp(clientId, state, op.options)
				: this.unsubscribeOp(clientId, state)
		void work
			.catch((err: unknown) =>
				this.log.warn({ err, clientId }, "Spectrum subscription failed"),
			)
			.finally(() => {
				done()
				this.opDone(clientId, state)
			})
	}

	private opDone(clientId: string, state: ClientState): void {
		state.running = null
		const next = state.pending
		state.pending = null
		if (next && !this.stopping) {
			this.startOp(clientId, state, next)
			return
		}
		if (
			state.current === null &&
			state.held.size === 0 &&
			this.clients.get(clientId) === state
		)
			this.clients.delete(clientId)
		const idle = state.idle.splice(0)
		for (const resolve of idle) resolve()
	}

	private superseded(state: ClientState, seq: number): boolean {
		return state.seq !== seq || this.stopping
	}

	private async subscribeOp(
		clientId: string,
		state: ClientState,
		options: unknown,
	): Promise<void> {
		const seq = state.seq
		const def = this.syncDefault()
		let selection: Selection
		let adjusted: SpectrumProfileAdjustment[] = []
		if (options === undefined) {
			selection = {
				sourceId: null,
				profile: null,
				sources: new Set(),
				backfillMs: 0,
			}
		} else {
			const parsed = SpectrumSubscribeOptionsSchema.safeParse(options)
			if (!parsed.success) {
				this.reject(
					clientId,
					state,
					"SPECTRUM_OPTIONS_INVALID",
					parsed.error.issues.map(i => i.message).join("; "),
				)
				return
			}
			const { sourceId } = parsed.data
			if (!this.deps.sourceConfigs.some(c => c.id === sourceId)) {
				this.reject(
					clientId,
					state,
					"SPECTRUM_SOURCE_NOT_FOUND",
					`Unknown source ${sourceId}`,
				)
				return
			}
			if (this.removedSources.has(sourceId)) {
				this.reject(
					clientId,
					state,
					"SPECTRUM_SOURCE_REMOVED",
					`Source ${sourceId} was removed`,
				)
				return
			}
			if (!this.isEligible(sourceId)) {
				this.reject(
					clientId,
					state,
					"SPECTRUM_SOURCE_NOT_IQ",
					`Source ${sourceId} is not an IQ source`,
				)
				return
			}
			const normalised = normaliseProfile(
				parsed.data,
				def,
				this.clientBinsBound(this.deps.settings()),
			)
			adjusted = normalised.adjusted
			const backfill = normaliseBackfillMs(parsed.data.backfillMs)
			if (backfill.adjusted) adjusted.push("backfillMs")
			const bound = this.clientBinsBound(this.deps.settings())
			let profile = this.admit(
				clientId,
				sourceId,
				normalised.profile,
				def,
				adjusted,
			)
			// WG8: an admission fallback never serves more bins than the advertised bound.
			if (profile.bins > bound) {
				profile = makeProfile(profile.hz, bound, averagingOf(profile))
				if (!adjusted.includes("bins")) adjusted.push("bins")
			}
			selection = {
				sourceId,
				profile,
				sources: new Set([sourceId]),
				backfillMs: backfill.ms,
			}
		}
		state.next = selection
		state.nextAdjusted = adjusted
		const needed =
			selection.sourceId === null
				? this.eligibleSources()
				: [selection.sourceId]
		for (const sourceId of needed) {
			if (state.held.has(sourceId)) continue
			try {
				await this.acquireDisplay(sourceId, clientId, state)
			} catch (err) {
				if (this.superseded(state, seq)) return this.abort(clientId, state)
				if (selection.sourceId === null) {
					// Default selection: one failing source is logged once and skipped. A removal is no engine error.
					const removed =
						err instanceof WaveKitError &&
						err.code === "SPECTRUM_SOURCE_REMOVED"
					const message = errorMessage(err)
					if (!removed && this.errors.get(sourceId) !== message) {
						this.log.warn(
							{ err, sourceId },
							"Spectrum engine for subscribers failed to start",
						)
						this.errors.set(sourceId, message)
					}
					continue
				}
				const code: SpectrumSubscribeErrorCode =
					err instanceof WaveKitError && err.code === "SPECTRUM_SOURCE_REMOVED"
						? "SPECTRUM_SOURCE_REMOVED"
						: "SPECTRUM_ENGINE_ERROR"
				this.reject(clientId, state, code, errorMessage(err))
				return this.abort(clientId, state)
			}
			if (this.superseded(state, seq)) return this.abort(clientId, state)
		}
		// Commit (synchronous): ack, then backfill, then snapshots; live frames can only follow.
		const current = state.next
		if (!current) return this.abort(clientId, state)
		const committedDef = this.syncDefault()
		if (current.sourceId === null)
			current.sources = new Set(needed.filter(s => state.held.has(s)))
		state.current = current
		state.next = null
		const outcome =
			current.sourceId === null
				? "default"
				: state.nextAdjusted.length === 0
					? "exact"
					: "nearest"
		const described = this.describe(current, committedDef, {
			outcome,
			adjusted: state.nextAdjusted,
		})
		state.nextAdjusted = []
		const snapshots = this.snapshots(current, committedDef)
		const requested = current.sourceId !== null && current.backfillMs > 0
		const backfill = requested ? this.backfillFor(current, snapshots) : []
		const ack = requested
			? { ...described, backfillFrames: backfill.length }
			: described
		this.emit("profile", clientId, ack, snapshots, backfill)
		await this.releaseUnneeded(clientId, state)
	}

	private async unsubscribeOp(
		clientId: string,
		state: ClientState,
	): Promise<void> {
		state.current = null
		state.next = null
		state.nextAdjusted = []
		await this.releaseUnneeded(clientId, state)
	}

	/** Superseded or failed op: drops `next` and releases what `current` does not need. Emits nothing. */
	private async abort(clientId: string, state: ClientState): Promise<void> {
		state.next = null
		state.nextAdjusted = []
		await this.releaseUnneeded(clientId, state)
	}

	private async releaseUnneeded(
		clientId: string,
		state: ClientState,
	): Promise<void> {
		for (const sourceId of [...state.held]) {
			if (state.current?.sources.has(sourceId)) continue
			state.held.delete(sourceId)
			await this.release(sourceId, wsConsumer(clientId))
		}
	}

	private async acquireDisplay(
		sourceId: string,
		clientId: string,
		state: ClientState,
	): Promise<void> {
		const gen = this.sourceGen.get(sourceId) ?? 0
		if (this.stopping)
			throw new WaveKitError("Spectrum service stopped", "SPECTRUM_STOPPED")
		if (this.removedSources.has(sourceId)) throw this.removedError(sourceId)
		const engine = await this.acquire(sourceId, wsConsumer(clientId))
		if (this.entries.get(sourceId)?.engine !== engine || !engine.isRunning)
			throw new WaveKitError(
				"Spectrum engine became unavailable",
				"SPECTRUM_ENGINE_ERROR",
			)
		state.held.add(sourceId)
		if (
			(this.sourceGen.get(sourceId) ?? 0) !== gen ||
			this.removedSources.has(sourceId)
		) {
			// The removal may have found no entry yet (still opening): drop its display data now.
			const entry = this.entries.get(sourceId)
			if (entry) {
				entry.holds.clear()
				entry.lastSummary = null
				entry.lastEpoch = null
				entry.ring.length = 0
			}
			state.held.delete(sourceId)
			await this.release(sourceId, wsConsumer(clientId))
			throw this.removedError(sourceId)
		}
	}

	private removedError(sourceId: string): WaveKitError {
		return new WaveKitError(
			`Source ${sourceId} was removed`,
			"SPECTRUM_SOURCE_REMOVED",
		)
	}

	/** A rejected request keeps `current`; the ack describes it. */
	private reject(
		clientId: string,
		state: ClientState,
		code: SpectrumSubscribeErrorCode,
		message: string,
	): void {
		const ack = this.describe(state.current, this.syncDefault(), {
			outcome: "rejected",
			adjusted: [],
		})
		this.emit("profile", clientId, { ...ack, code, message }, [], [])
	}

	/**
	 * Admission (M3): P = (sourceId, key) is admitted iff the distinct non-default pairs over every
	 * OTHER client's current and next, plus P, stay within the cap. Otherwise P maps to the nearest
	 * of the default and the admissible pairs on its source (only while |O| ≤ cap).
	 */
	private admit(
		clientId: string,
		sourceId: string,
		profile: SpectrumProfile,
		def: SpectrumProfile,
		adjusted: SpectrumProfileAdjustment[],
	): SpectrumProfile {
		const others: { sourceId: string; profile: SpectrumProfile }[] = []
		for (const [id, state] of this.clients) {
			if (id === clientId) continue
			for (const sel of [state.current, state.next]) {
				if (!sel?.sourceId || !sel.profile) continue
				others.push({ sourceId: sel.sourceId, profile: sel.profile })
			}
		}
		return admitProfile(
			profile,
			sourceId,
			def,
			others,
			this.deps.settings().ws.spectrumMaxProfiles,
			adjusted,
		)
	}

	/**
	 * M2: on a default change, pairs keyed by the former default start counting. Only the first
	 * `cap − others` of them (by sourceId) keep their profile; clients on the rest move to the new
	 * default, with a notice for `current` (a remapped `next` reports in its commit ack).
	 */
	private syncDefault(): SpectrumProfile {
		const def = this.servedDefault(this.deps.settings())
		if (def.key === this.defaultKey) return def
		const prev = this.defaultKey
		this.defaultKey = def.key
		if (prev === null) return def
		const cap = this.deps.settings().ws.spectrumMaxProfiles
		const others = new Set<string>()
		const former = new Set<string>()
		for (const state of this.clients.values())
			for (const sel of [state.current, state.next]) {
				if (!sel?.sourceId || !sel.profile || sel.profile.key === def.key)
					continue
				const pair = pairKey(sel.sourceId, sel.profile.key)
				if (sel.profile.key === prev) former.add(pair)
				else others.add(pair)
			}
		const kept = new Set(
			[...former].sort().slice(0, Math.max(0, cap - others.size)),
		)
		const remap = (sel: Selection | null): sel is Selection =>
			sel !== null &&
			sel.sourceId !== null &&
			sel.profile?.key === prev &&
			!kept.has(pairKey(sel.sourceId, prev))
		for (const [clientId, state] of this.clients) {
			if (remap(state.next)) {
				state.next.profile = def
				if (!state.nextAdjusted.includes("profile-limit"))
					state.nextAdjusted.push("profile-limit")
			}
			if (remap(state.current)) {
				state.current.profile = def
				this.emit(
					"profile",
					clientId,
					this.describe(state.current, def, {
						outcome: "nearest",
						adjusted: ["profile-limit"],
					}),
					[],
					[],
				)
			}
		}
		return def
	}

	private describe(
		sel: Selection | null,
		def: SpectrumProfile,
		how: {
			outcome: SpectrumProfileEventData["outcome"]
			adjusted: SpectrumProfileAdjustment[]
		},
	): SpectrumProfileEventData {
		const profile = sel ? (sel.profile ?? def) : null
		return {
			selection: sel ? (sel.sourceId === null ? "default" : "source") : "none",
			sourceId: sel?.sourceId ?? null,
			profile: profile ? profileView(profile) : null,
			effectiveHz:
				sel?.sourceId && profile
					? this.effectiveHz(sel.sourceId, profile)
					: null,
			outcome: how.outcome,
			adjusted: [...how.adjusted],
		}
	}

	private effectiveHz(
		sourceId: string,
		profile: SpectrumProfile,
	): number | null {
		const cfg = this.entries.get(sourceId)?.engine.config()
		if (!cfg) return null
		const blockHz = 1000 / cfg.integrationMs
		return blockHz / summariesPerFrame(blockHz, profile.hz)
	}

	/** Current-state frames at commit: the latest summary, only when it is of the engine's current stream and epoch. */
	private snapshots(
		sel: Selection,
		def: SpectrumProfile,
	): SpectrumFrameEventData[] {
		const out: SpectrumFrameEventData[] = []
		const profile = sel.profile ?? def
		for (const sourceId of sel.sources) {
			const entry = this.entries.get(sourceId)
			const cfg = entry?.engine.config()
			const summary = entry?.lastSummary
			if (!entry || !cfg || !summary || !entry.lastEpoch) continue
			const cur = entry.engine.currentEpoch()
			if (summary.stream !== cur.stream || summary.epoch !== cur.epoch) continue
			out.push({
				...this.frame(
					sourceId,
					summary,
					entry.lastEpoch,
					profile,
					cfg,
					this.snapshotReduced(entry, profile, summary, cur),
				),
				snapshot: true,
			})
		}
		return out
	}

	// === permanent removal (M1) ===

	private readonly onSourceRemoved = (sourceId: string): void => {
		this.removedSources.add(sourceId)
		this.sourceGen.set(sourceId, (this.sourceGen.get(sourceId) ?? 0) + 1)
		const def = this.syncDefault()
		for (const [clientId, state] of [...this.clients]) {
			const notice = (sel: Selection | null): void => {
				this.emit(
					"profile",
					clientId,
					{
						...this.describe(sel, def, { outcome: "removed", adjusted: [] }),
						removedSourceId: sourceId,
						code: "SPECTRUM_SOURCE_REMOVED",
					} satisfies SpectrumProfileEventData,
					[],
					[],
				)
			}
			let affected = false
			const cur = state.current
			if (cur?.sourceId === sourceId) {
				state.current = null
				affected = true
			} else if (cur?.sourceId === null && cur.sources.has(sourceId)) {
				cur.sources.delete(sourceId)
				affected = true
			}
			if (state.next?.sourceId === sourceId && state.running) {
				// The in-flight op is superseded: this notice is all the client gets for it.
				state.seq += 1
				affected = true
			}
			if (affected) notice(state.current)
			state.held.delete(sourceId)
			if (!state.running && state.current === null && state.held.size === 0)
				this.clients.delete(clientId)
		}
		void this.dropDisplays(sourceId)
	}

	private readonly onSourceConnected = (sourceId: string): void => {
		this.removedSources.delete(sourceId)
	}

	/** Display demand on a removed source ends now; jobs keep the engine until Task 35 releases them. */
	private async dropDisplays(sourceId: string): Promise<void> {
		const entry = this.entries.get(sourceId)
		if (!entry) return
		entry.displays.clear()
		entry.holds.clear()
		entry.lastSummary = null
		entry.lastEpoch = null
		entry.ring.length = 0
		if (entry.jobs.size > 0) return
		await this.closeEntry(sourceId, entry, false).catch((err: unknown) =>
			this.log.warn({ err, sourceId }, "Stopping a removed source failed"),
		)
	}

	// === frames ===

	private onPipeline(
		sourceId: string,
		entry: Entry,
		ev: PipelineEvent,
		epoch: EngineEpoch,
	): void {
		if (entry.failed) return
		if (ev.kind === "block-summary") {
			const summary = ev.summary
			const atMs = this.now()
			entry.lastSummary = summary
			entry.lastEpoch = epoch
			// bins are not mutated after emission (fresh array per summary; the worker clones).
			appendSummary(
				entry.ring,
				{ summary, epoch, atMs },
				entry.engine.config()?.integrationMs ?? 50,
				atMs,
			)
			this.observe(sourceId, entry, summary, epoch)
			const span = spectrumMainSpanSink()
			if (!span) {
				this.frames(sourceId, entry, summary, epoch)
			} else {
				const t0 = performance.now()
				try {
					this.frames(sourceId, entry, summary, epoch)
				} finally {
					span("frame-build", performance.now() - t0)
				}
			}
		}
		this.emit("pipeline", sourceId, ev, epoch)
	}

	private observe(
		sourceId: string,
		entry: Entry,
		summary: BlockSummary,
		epoch: EngineEpoch,
	): void {
		const history = this.histories.get(sourceId)
		const cfg = entry.engine.config()
		if (
			!history ||
			!cfg ||
			summary.overload ||
			epoch.tuningTrust === "unverified"
		)
			return
		const half = (summary.sampleRateHz * USABLE_FRACTION) / 2
		history.observe(
			this.now(),
			{ startHz: summary.centreHz - half, endHz: summary.centreHz + half },
			summary.tracks,
			cfg.integrationMs,
		)
	}

	/** Recipients per profile key on a source: default clients under the default key, source clients under theirs. */
	private recipients(
		sourceId: string,
		def: SpectrumProfile,
	): Map<string, RecipientGroup> {
		const groups = new Map<string, RecipientGroup>()
		for (const [clientId, state] of this.clients) {
			const cur = state.current
			if (!cur?.sources.has(sourceId)) continue
			const profile = cur.profile ?? def
			const group = groups.get(profile.key)
			if (group) group.clients.push(clientId)
			else groups.set(profile.key, { profile, clients: [clientId] })
		}
		return groups
	}

	/** Backfill for a committed source selection. Empty when the current epoch has nothing buffered. */
	private backfillFor(
		sel: Selection,
		snapshots: readonly SpectrumFrameEventData[],
	): SpectrumFrameEventData[] {
		if (!sel.sourceId || !sel.profile || sel.backfillMs <= 0) return []
		const entry = this.entries.get(sel.sourceId)
		const cfg = entry?.engine.config()
		if (!entry || !cfg) return []
		const sourceId = sel.sourceId
		const cur = entry.engine.currentEpoch()
		const snapshotted = snapshots.some(s => s.sourceId === sel.sourceId)
		return buildBackfillFrames({
			ring: entry.ring,
			now: this.now(),
			backfillMs: sel.backfillMs,
			stream: cur.stream,
			epoch: cur.epoch,
			snapshot: snapshotted ? entry.lastSummary : null,
			profile: sel.profile,
			sourceId: sel.sourceId,
			integrationMs: cfg.integrationMs,
			sampleRateHz: cfg.sampleRateHz,
			fftSize: cfg.fftSize,
			tracks: tracks => this.frameTracks(sourceId, tracks),
		})
	}

	/**
	 * WG11 req 5.1-5.3: a frame's tracks. The fields the pipeline recorded with the block are
	 * already on them; with a lookup, a track with an id gets the scanner's identity for this
	 * source, read once per track per frame. The summary's tracks are never mutated (the ring
	 * and the other profile groups share them); without a lookup or an id they are returned
	 * as they are (the frozen frame).
	 */
	private frameTracks(
		sourceId: string,
		tracks: BlockTrack[],
	): SpectrumFrameTrack[] {
		const lookup = this.trackIdentity
		const internal = tracks.some(t => t.trackerId !== undefined)
		if (
			!internal &&
			(lookup === null || !tracks.some(t => t.trackId !== undefined))
		)
			return tracks
		return tracks.map(track => {
			// `trackerId` is host-internal (the chain's current tracker id): never on a frame.
			const { trackerId, ...t } = track
			if (lookup === null || t.trackId === undefined) return t
			let answer: unknown
			try {
				// The frame id is the chain id without `${sourceId}-` (pipeline frameAssociation); the
				// lookup gets the chain's current full tracker id on this frame's own source, never
				// another source's.
				answer = lookup(sourceId, `${sourceId}-${trackerId ?? t.trackId}`)
			} catch (err: unknown) {
				this.logTrackIdentity("Spectrum track identity lookup failed", err)
				return t
			}
			if (answer === null) return t
			const scanner = frameTrackScannerOf(answer)
			if (scanner === null) {
				this.logTrackIdentity(
					"Spectrum track identity lookup returned an invalid identity",
				)
				return t
			}
			return { ...t, scanner }
		})
	}

	private logTrackIdentity(msg: string, err?: unknown): void {
		const now = this.now()
		if (now - this.trackIdentityLoggedAt < TRACK_IDENTITY_LOG_INTERVAL_MS)
			return
		this.trackIdentityLoggedAt = now
		if (err === undefined) this.log.debug(msg)
		else this.log.debug({ error: safeErrorFields(err) }, msg)
	}

	/**
	 * Snapshot bins: an averaged profile's running average when it belongs to this epoch,
	 * otherwise the raw latest summary (the pre-averaging behaviour).
	 */
	private snapshotReduced(
		entry: Entry,
		profile: SpectrumProfile,
		summary: BlockSummary,
		cur: { stream: number; epoch: number },
	): { bins: Float32Array; factor: number; trust?: TuningTrust } {
		if (averagingOf(profile) > 1) {
			const hold = entry.holds.get(profile.key)
			if (
				hold?.avg &&
				hold.epoch === cur.epoch &&
				(hold.stream === undefined || hold.stream === cur.stream)
			)
				// WG9 R3: the average's own label, not the newest summary's.
				return {
					bins: hold.avg,
					factor: hold.factor,
					...(hold.avgTrust !== undefined ? { trust: hold.avgTrust } : {}),
				}
		}
		return reduceMaxHold(summary.bins, profile.bins)
	}

	/** M5: one frame per `summariesPerFrame` summaries of each profile; each profile is built once. */
	private frames(
		sourceId: string,
		entry: Entry,
		summary: BlockSummary,
		epoch: EngineEpoch,
	): void {
		const def = this.syncDefault()
		const groups = this.recipients(sourceId, def)
		for (const key of [...entry.holds.keys()])
			if (!groups.has(key)) entry.holds.delete(key)
		const cfg = entry.engine.config()
		if (groups.size === 0 || !cfg) return
		const blockHz = 1000 / cfg.integrationMs
		for (const [key, g] of groups) {
			const n = summariesPerFrame(blockHz, g.profile.hz)
			const hold = accumulateHold(
				entry.holds.get(key),
				reduceMaxHold(summary.bins, g.profile.bins),
				summary.epoch,
				summary.stream,
				epoch.tuningTrust,
			)
			entry.holds.set(key, hold)
			hold.count += 1
			const peak = hold.bins
			if (hold.count < n || peak === null) continue
			const averaging = averagingOf(g.profile)
			let bins: Float32Array = peak
			// WG9 R3: the worst label across the held (and averaged) summaries.
			let trust = hold.trust ?? epoch.tuningTrust
			if (averaging > 1) {
				const next = averageTrusted(
					hold.avg,
					hold.avgTrust,
					peak,
					trust,
					averaging,
				)
				hold.avg = next.avg
				hold.avgTrust = next.trust
				bins = next.avg
				trust = next.trust
			}
			this.emit(
				"frame",
				this.frame(sourceId, summary, epoch, g.profile, cfg, {
					bins,
					factor: hold.factor,
					trust,
				}),
				g.clients,
			)
			hold.bins = null
			hold.count = 0
		}
	}

	private frame(
		sourceId: string,
		summary: BlockSummary,
		epoch: EngineEpoch,
		profile: SpectrumProfile,
		cfg: PipelineConfig,
		reduced: { bins: Float32Array; factor: number; trust?: TuningTrust },
	): SpectrumFrameEventData {
		return {
			sourceId,
			profile: profile.key,
			epoch: summary.epoch,
			tuningTrust: reduced.trust ?? epoch.tuningTrust,
			centerHz: summary.centreHz,
			sampleRateHz: summary.sampleRateHz,
			binHz: summary.binHz * reduced.factor,
			nativeBinHz: cfg.sampleRateHz / cfg.fftSize,
			startHz: summary.startHz,
			binCount: reduced.bins.length,
			bins: encodeBins(reduced.bins),
			binEncoding: BIN_ENCODING,
			floorDbfs: summary.floorDbfs,
			thresholdDb: summary.thresholdDb,
			tracks: this.frameTracks(sourceId, summary.tracks),
			masks: summary.masks,
			at: new Date(this.now()).toISOString(),
		}
	}

	private sourceStatus(
		cfg: SourceConfig,
		def: SpectrumProfile,
	): SpectrumSourceStatus {
		const removed = this.removedSources.has(cfg.id)
		const iq = isScannerIqFormat(this.deps.sources.getCaps(cfg.id) ?? cfg.caps)
		const entry = this.entries.get(cfg.id)
		const engine = entry?.engine
		const pc = engine?.config() ?? null
		const stats = engine?.stats() ?? null
		const error = this.errors.get(cfg.id)
		const summary = entry?.lastSummary ?? null
		const reason = removed
			? ("source-removed" as const)
			: iq
				? undefined
				: ("source-not-iq" as const)
		return {
			sourceId: cfg.id,
			eligible: !removed && iq,
			...(reason ? { reason } : {}),
			engine: engine ? "running" : error ? "error" : "idle",
			consumers: entry ? entry.jobs.size + entry.displays.size : 0,
			rbwHz: pc ? pc.sampleRateHz / pc.fftSize : null,
			fftSize: pc?.fftSize ?? null,
			floorDbfs: stats?.floorDbfs ?? null,
			floorOccupied: summary?.floorOccupied ?? false,
			kByRange: (stats?.kByRange ?? []).map(k => ({
				startHz: k.range.startHz,
				endHz: k.range.endHz,
				k: k.k,
				faPerMhzMin: k.faPerMhzMin,
			})),
			settleMode: engine?.currentEpoch().settleMode ?? null,
			tuningTrust: engine?.currentEpoch().tuningTrust ?? null,
			warnings: (engine?.warnings() ?? []).map(w => ({
				code: w.code,
				deltaHz: w.deltaHz,
				at: new Date(w.at).toISOString(),
				...(w.suspected !== undefined ? { suspected: w.suspected } : {}),
				...(w.lastCommandAgeMs !== undefined
					? { lastCommandAgeMs: w.lastCommandAgeMs }
					: {}),
			})),
			summaryBinCount: summary?.bins.length ?? null,
			summaryBinHz: summary?.binHz ?? null,
			summaryHz: pc ? 1000 / pc.integrationMs : null,
			latestFrame:
				summary && entry?.lastEpoch && pc
					? this.frame(
							cfg.id,
							summary,
							entry.lastEpoch,
							def,
							pc,
							reduceMaxHold(summary.bins, def.bins),
						)
					: null,
			...(error ? { lastError: error } : {}),
		}
	}
}

/**
 * IQ capture service (WG11 req 6.1-6.9): implements `IqCapturePort` over one supervised
 * `wavekit-iqcap run` process per attached IQ source, the in-memory store and the capture
 * directory `<scanner storage>/iq-captures`.
 *
 * Off unless `scanner.iqCapture.enabled` and protected access mode: absent or disabled means no
 * process, no directory, no file and no filesystem call at all; legacy mode logs one info line.
 * Logs carry fixed text and counts only (never ids, paths, frequencies or tool output).
 *
 * Replay input (`openReplay`): the file is proven (lstat chain from the configured root, regular,
 * ours, mode 0600, size bound, whole samples), opened with O_NOFOLLOW, fstat-compared with the
 * proof (dev, ino, size), and that open descriptor is handed to `wavekit-iqcap replay` as its fd 3
 * with `--in /dev/fd/3`: the tool reads exactly the inode that was proven, whatever happens to
 * the name afterwards.
 */
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { randomUUID as nodeRandomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as fsp from "node:fs/promises"
import path from "node:path"
import { PassThrough, type Readable } from "node:stream"
import { childAccessEnvironment } from "../../access/runtime-hygiene.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import { WaveKitError } from "../../utils/errors.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import type { ProbeDecoderType } from "../scanner/probes/probe-pool.js"
import {
	IQ_CAPTURE_MAX_MS,
	IQ_CAPTURE_PREROLL_MAX_MS,
	IQ_CAPTURE_TOTAL_MAX_BYTES,
	type IqCaptureDiscardReason,
	type IqCapturePort,
	type IqCaptureRefusal,
	type IqCaptureRequest,
	type IqCaptureView,
} from "../scanner/iq-capture-contract.js"
import {
	ensureCaptureDir,
	captureDirIdentitySync,
	dirStillProvenSync,
	openVerifiedCaptureSync,
	processUid,
	unlinkProvenSync,
	type DirIdentity,
} from "./fs-guard.js"
import {
	IqToolProcess,
	realTimers,
	type IqToolCounters,
	type IqToolTimers,
	type SpawnFn,
} from "./process.js"
import { isCaptureId, type IqToolEvent } from "./protocol.js"
import {
	IqCaptureStore,
	type IqCaptureCounters,
	type IqCaptureEntry,
	viewOf,
} from "./store.js"
import { sweepCaptureDir, type SweepResult } from "./sweep.js"

/** `scanner.iqCapture` after parsing (src/config.ts). */
export interface IqCaptureConfig {
	enabled: boolean
	maxTotalMb: number
	maxCaptureMs: number
	preRollMs: number
	binaryPath: string
}

/** A replay decoder shape: the probe channel's passband and transition (PROBE_CHANNEL_REQUESTS). */
export interface IqReplayShape {
	bandwidthHz: number
	transitionHz: number
}
export type IqReplayDecoderType = Exclude<ProbeDecoderType, "rtl433">
export type IqReplayShapes = Readonly<
	Record<IqReplayDecoderType, IqReplayShape>
>

/** The spectrum engine surface the service uses (structural; `SpectrumEngine` satisfies it). */
export interface IqCaptureEngine {
	tap(listener: (startSample: number, bytes: Uint8Array) => void): () => void
	liveEdge(): number
}

export interface IqCaptureSourceAttach {
	sampleRateHz: number
	centerHz: number
	epoch: number
	engine: IqCaptureEngine
}

export interface IqCaptureServiceOptions {
	/** `scanner.iqCapture`; undefined (absent) or `enabled: false` keeps everything off. */
	config: IqCaptureConfig | undefined
	/** The scanner storage directory; captures live in `<storageRoot>/iq-captures`. */
	storageRoot: string
	/** True only in protected access mode. */
	protectedMode: boolean
	logger: Logger
	/**
	 * Replay shapes per decoder type; the capture bandwidth is their widest passband. May be given
	 * later through `setShapes` (the scanner owns them), but before `start`.
	 */
	shapes?: IqReplayShapes
	now?: () => number
	spawn?: SpawnFn
	randomUUID?: () => string
	timers?: IqToolTimers
	env?: NodeJS.ProcessEnv
	/** Test seam; defaults to process.getuid(). */
	uid?: number | null
}

export type IqCaptureServiceState =
	| "idle"
	| "off"
	| "not-protected"
	| "unavailable"
	| "on"
	| "stopped"

export interface IqCaptureServiceCounters extends IqCaptureCounters {
	tool: IqToolCounters
	toolRestarts: number
	toolGiveUps: number
	replayFailures: number
	/** The capture directory failed its re-proof (swapped, linked): capture went off. */
	dirRefusals: number
	sweep: SweepResult
}

export interface IqCaptureService extends IqCapturePort {
	/**
	 * Review M2: `capture`, the capture held by `holder` from the start (an identify job), so the
	 * replay queue never takes it over when it finishes; `claim(id, holder)` then returns true.
	 */
	captureFor(
		req: IqCaptureRequest,
		holder: string,
	): { captureId: string } | { refused: IqCaptureRefusal }
	start(): Promise<void>
	stop(): Promise<void>
	/** Ensures the directory and removes leftovers of an earlier run (idempotent; off → no-op). */
	sweep(): Promise<SweepResult>
	/** Sets the replay shapes (before `start`; ignored once started). */
	setShapes(shapes: IqReplayShapes): void
	attachSource(sourceId: string, source: IqCaptureSourceAttach): void
	detachSource(sourceId: string): void
	/**
	 * The source's engine epoch changed (retune, rate change, stream restart): open captures are
	 * dropped, the tool restarts with a fresh ring and sample count. Without `next.epoch` every
	 * request is refused `epoch-changed` until the source is flushed or attached with one.
	 */
	flush(
		sourceId: string,
		next?: { epoch?: number; centerHz?: number; sampleRateHz?: number },
	): void
	/** A capture finished and was proven; it is queued (returns the unsubscribe). */
	onFinished(listener: (view: IqCaptureView) => void): () => void
	/** The capture's view while it is ready, else null. */
	view(captureId: string): IqCaptureView | null
	/** Holder of a capture (null = queued / unheld); undefined when gone. */
	holderOf(captureId: string): string | null | undefined
	/**
	 * Discards a capture held by `holder` or by nobody (deferred while it replays); false when it
	 * is gone or held by someone else.
	 */
	discard(
		captureId: string,
		reason: IqCaptureDiscardReason,
		holder?: string,
	): boolean
	/** Applies the orphan TTL now (also runs on a timer armed for the earliest deadline). */
	expire(): number
	state(): IqCaptureServiceState
	counters(): IqCaptureServiceCounters
	/** Bytes held against the cap. */
	heldBytes(): number
}

const RESTART_BASE_MS = 1_000
const RESTART_MAX_MS = 30_000
const GIVE_UP_FAILURES = 5
const GIVE_UP_WINDOW_MS = 600_000
/** A capture without `captured`/`aborted` this long after its bound is dropped. */
const CAPTURE_GRACE_MS = 10_000
const REPLAY_TIMEOUT_MS = 30_000
/** Removed capture ids remembered for late tool events (2 open × a few minutes of captures). */
const FORGOTTEN_IDS_MAX = 64
/** Safety margin inside the tool's ring and below its current count (seconds). */
const RING_MARGIN_S = 0.25
/** The kernel pipe buffer the tool may not have read yet (bytes; Linux and macOS default). */
const PIPE_BUFFER_BYTES = 64 * 1024

interface SourceSlot {
	sourceId: string
	sampleRateHz: number
	centerHz: number
	epoch: number
	engine: IqCaptureEngine
	untap: () => void
	proc: IqToolProcess | null
	failures: number[]
	restartTimer: unknown
	givenUp: boolean
	ids: Set<string>
}

/** The capture bandwidth: the widest replay passband (computed, not hardcoded). */
export function captureBandwidthHz(shapes: IqReplayShapes): number {
	return Math.max(...Object.values(shapes).map(s => s.bandwidthHz))
}

export function createIqCaptureService(
	options: IqCaptureServiceOptions,
): IqCaptureService {
	return new Service(options)
}

class Service implements IqCaptureService {
	private readonly log: Logger
	private readonly now: () => number
	private readonly spawn: SpawnFn
	private readonly uuid: () => string
	private readonly timers: IqToolTimers
	private readonly uid: number | null
	private readonly cfg: IqCaptureConfig | undefined
	/** The configured root (resolved, may run through operator symlinks above it). */
	private readonly root: string
	/**
	 * Astra re-review 3 #1: the canonical root (realpath of the nearest existing ancestor plus the
	 * missing tail, created 0700), its anchor (that realpath) and the root's identity. Every guard
	 * check runs from the anchor, so a later swap of the root or a component below the anchor is
	 * refused; ancestors above the anchor are operator territory (macOS /tmp → /private/tmp).
	 */
	private canonical: string | null = null
	private anchor: string | null = null
	private rootId: DirIdentity | null = null
	private shapes: IqReplayShapes | null
	private bandwidthHz = 0
	private st: IqCaptureServiceState = "idle"
	private dir: string | null = null
	private store: IqCaptureStore | null = null
	private readonly slots = new Map<string, SourceSlot>()
	private readonly events = new EventEmitter()
	private readonly replays = new Map<string, Set<ChildProcess>>()
	private readonly captureTimers = new Map<string, unknown>()
	private expireTimer: unknown = null
	private expireAt: number | null = null
	/** Recently removed capture ids (bounded, oldest evicted): their late tool events are not hostile. */
	private readonly forgotten = new Set<string>()
	/**
	 * Review m2/m4: captures Node removed while the tool still writes them. Their bytes stay held and
	 * their concurrency slot taken until the tool's final event for them or its exit; then the files
	 * (`.cf32`, `.cf32.tmp`) are unlinked and the bytes released. At most one per open tool capture.
	 */
	/**
	 * Review MAJOR d: the process writing each open capture, independent of the source slot (a
	 * detach, flush or restart replaces the slot's process). Cleared at that process's final event
	 * for the id or its exit.
	 */
	private readonly writers = new Map<string, IqToolProcess>()
	/** Review BLOCKING: the proven directory's identity, re-checked before every file operation. */
	private dirId: DirIdentity | null = null
	/** Inode of each proven capture file (checked again before its unlink). */
	private readonly fileIno = new Map<string, number>()
	private dirRefusals = 0
	private warnedDir = false
	private readonly zombies = new Map<
		string,
		{ bytes: number; proc: IqToolProcess }
	>()
	private toolTotals: IqToolCounters = {
		droppedBytes: 0,
		gapCommands: 0,
		oversizeLines: 0,
		invalidLines: 0,
		unsentCommands: 0,
	}
	private toolRestarts = 0
	private toolGiveUps = 0
	private replayFailures = 0
	private sweepTotals: SweepResult = { removed: 0, left: 0, failed: 0 }
	private warnedGiveUp = false
	private starting: Promise<void> | null = null

	constructor(private readonly o: IqCaptureServiceOptions) {
		this.log = createComponentLogger(o.logger, "IqCapture")
		this.now = o.now ?? Date.now
		this.spawn = o.spawn ?? (nodeSpawn as SpawnFn)
		this.uuid = o.randomUUID ?? nodeRandomUUID
		this.timers = o.timers ?? realTimers
		this.uid = o.uid === undefined ? processUid() : o.uid
		this.cfg = o.config?.enabled === true ? o.config : undefined
		this.root = path.resolve(o.storageRoot)
		this.shapes = o.shapes ?? null
		this.events.setMaxListeners(0)
	}

	state(): IqCaptureServiceState {
		return this.st
	}

	setShapes(shapes: IqReplayShapes): void {
		if (this.st !== "idle" || this.starting) return
		this.shapes = shapes
	}

	start(): Promise<void> {
		this.starting ??= this.doStart()
		return this.starting
	}

	private async doStart(): Promise<void> {
		if (this.st !== "idle") return
		if (!this.cfg) {
			this.st = "off"
			return
		}
		if (!this.o.protectedMode) {
			this.st = "not-protected"
			this.log.info("IQ capture is not started in legacy access mode")
			return
		}
		await this.canonicalize(true)
		await this.sweep()
		if (this.st !== "idle") return
		if (!this.dir || !this.shapes) {
			if (!this.shapes)
				this.log.warn("IQ capture has no replay shapes; capture is off")
			this.st = "unavailable"
			return
		}
		this.bandwidthHz = captureBandwidthHz(this.shapes)
		this.store = new IqCaptureStore({
			capBytes: Math.min(
				IQ_CAPTURE_TOTAL_MAX_BYTES,
				this.cfg.maxTotalMb * 1024 * 1024,
			),
			maxCaptureMs: Math.min(IQ_CAPTURE_MAX_MS, this.cfg.maxCaptureMs),
			now: this.now,
			onRemove: (entry, reason) => this.onRemove(entry, reason),
			openInTool: () => this.openInTool(),
		})
		this.st = "on"
		for (const slot of this.slots.values()) this.spawnTool(slot)
		this.log.info("IQ capture started")
	}

	async sweep(): Promise<SweepResult> {
		const zero: SweepResult = { removed: 0, left: 0, failed: 0 }
		if (!this.cfg || !this.o.protectedMode) return zero
		// Never while running: a file being written or replayed is not a leftover.
		if (this.st === "stopped" || this.st === "unavailable" || this.st === "on")
			return zero
		if (!this.dir) {
			// Astra re-review 2 #5: before the scanner created its storage root there is nothing to
			// sweep; capture is not disabled (start creates the root and proves the directory).
			if (!(await this.canonicalize(false))) return zero
			const anchor = this.anchor
			const canonical = this.canonical
			if (!anchor || !canonical) return zero
			const ensured = await ensureCaptureDir(canonical, this.uid)
			if ("refused" in ensured) {
				this.log.warn(
					{ code: ensured.refused },
					"IQ capture directory refused; capture is off",
				)
				this.st = "unavailable"
				return zero
			}
			const identity = captureDirIdentitySync(anchor, ensured.dir)
			if (!identity) {
				this.dirRefused()
				this.st = "unavailable"
				return zero
			}
			this.dir = ensured.dir
			this.dirId = identity
		}
		const identity = this.dirId
		const sweepAnchor = this.anchor
		if (!identity || !sweepAnchor) return zero
		const result = await sweepCaptureDir(this.dir, {
			uid: this.uid,
			guard: { root: sweepAnchor, identity },
		})
		if (result.refused) {
			this.dirRefused()
			this.st = "unavailable"
		}
		this.sweepTotals = {
			removed: this.sweepTotals.removed + result.removed,
			left: this.sweepTotals.left + result.left,
			failed: this.sweepTotals.failed + result.failed,
		}
		if (result.removed + result.left + result.failed > 0)
			this.log.info(
				{ removed: result.removed, left: result.left, failed: result.failed },
				"IQ capture sweep",
			)
		return result
	}

	async stop(): Promise<void> {
		if (this.starting) await this.starting.catch(() => {})
		const wasOn = this.st === "on"
		this.st = "stopped"
		if (this.expireTimer !== null) this.timers.clearTimeout(this.expireTimer)
		this.expireTimer = null
		this.expireAt = null
		for (const t of this.captureTimers.values()) this.timers.clearTimeout(t)
		this.captureTimers.clear()
		const stops: Promise<void>[] = []
		for (const slot of this.slots.values()) {
			slot.untap()
			if (slot.restartTimer !== null)
				this.timers.clearTimeout(slot.restartTimer)
			slot.restartTimer = null
			if (slot.proc) {
				this.addToolCounters(slot.proc)
				stops.push(slot.proc.stop())
			}
			slot.proc = null
		}
		this.slots.clear()
		for (const children of this.replays.values())
			for (const child of children) killGroup(child, "SIGKILL")
		if (this.store) {
			for (const e of this.store.all()) {
				if (e.state === "capturing") this.store.fail(e.captureId)
				else this.store.discard(e.captureId, "shutdown")
			}
		}
		await Promise.allSettled(stops)
		await this.waitReplays()
		if (wasOn) this.log.info("IQ capture stopped")
	}

	private async waitReplays(): Promise<void> {
		const waits: Promise<void>[] = []
		for (const children of this.replays.values())
			for (const child of children)
				waits.push(
					new Promise<void>(resolve => {
						if (child.exitCode !== null || child.signalCode !== null) resolve()
						else child.once("close", () => resolve())
					}),
				)
		await Promise.allSettled(waits)
	}

	attachSource(sourceId: string, source: IqCaptureSourceAttach): void {
		if (!this.cfg || !this.o.protectedMode || this.st === "stopped") return
		if (
			!(Number.isFinite(source.sampleRateHz) && source.sampleRateHz > 0) ||
			!Number.isFinite(source.centerHz)
		)
			return
		this.detachSource(sourceId)
		const slot: SourceSlot = {
			sourceId,
			sampleRateHz: source.sampleRateHz,
			centerHz: source.centerHz,
			epoch: source.epoch,
			engine: source.engine,
			untap: () => {},
			proc: null,
			failures: [],
			restartTimer: null,
			givenUp: false,
			ids: new Set(),
		}
		slot.untap = source.engine.tap((start, bytes) => {
			try {
				slot.proc?.feed(start, bytes)
			} catch {
				// never break the engine's tap loop
			}
		})
		this.slots.set(sourceId, slot)
		if (this.st === "on") this.spawnTool(slot)
	}

	detachSource(sourceId: string): void {
		const slot = this.slots.get(sourceId)
		if (!slot) return
		this.slots.delete(sourceId)
		slot.untap()
		if (slot.restartTimer !== null) this.timers.clearTimeout(slot.restartTimer)
		slot.restartTimer = null
		this.dropOpen(slot)
		const proc = slot.proc
		slot.proc = null
		if (proc) {
			this.addToolCounters(proc)
			void proc.stop()
		}
	}

	flush(
		sourceId: string,
		next?: { epoch?: number; centerHz?: number; sampleRateHz?: number },
	): void {
		const slot = this.slots.get(sourceId)
		if (!slot) return
		slot.epoch =
			next?.epoch !== undefined && Number.isFinite(next.epoch)
				? next.epoch
				: Number.NaN
		if (next?.centerHz !== undefined && Number.isFinite(next.centerHz))
			slot.centerHz = next.centerHz
		if (
			next?.sampleRateHz !== undefined &&
			Number.isFinite(next.sampleRateHz) &&
			next.sampleRateHz > 0
		)
			slot.sampleRateHz = next.sampleRateHz
		this.dropOpen(slot)
		// The pipes cannot order a flush against bytes still queued: a fresh process is exact.
		const proc = slot.proc
		slot.proc = null
		if (proc) {
			this.addToolCounters(proc)
			proc.send({ type: "flush" })
			void proc.stop()
		}
		if (this.st === "on" && !slot.givenUp && slot.restartTimer === null)
			this.spawnTool(slot)
	}

	onFinished(listener: (view: IqCaptureView) => void): () => void {
		this.events.on("finished", listener)
		return () => this.events.off("finished", listener)
	}

	view(captureId: string): IqCaptureView | null {
		const e = this.store?.get(captureId)
		if (!e || e.state !== "ready" || e.pendingDiscard !== null) return null
		return viewOf(e)
	}

	holderOf(captureId: string): string | null | undefined {
		const e = this.store?.get(captureId)
		return e ? e.holder : undefined
	}

	discard(
		captureId: string,
		reason: IqCaptureDiscardReason,
		holder?: string,
	): boolean {
		const e = this.store?.get(captureId)
		if (!e || !this.store) return false
		if (e.holder !== null && e.holder !== holder) return false
		if (e.state === "capturing") {
			// Ended in the tool by onRemove (the capture stays counted until the tool's final event).
			this.store.fail(captureId)
			return true
		}
		return this.store.discard(captureId, reason)
	}

	expire(): number {
		const n = this.store?.expire() ?? 0
		this.armExpire()
		return n
	}

	heldBytes(): number {
		return this.store?.heldBytes() ?? 0
	}

	counters(): IqCaptureServiceCounters {
		const base: IqCaptureCounters = this.store?.counters() ?? {
			accepted: 0,
			refused: {
				disabled: 0,
				"not-protected": 0,
				unavailable: 0,
				"rate-limited": 0,
				busy: 0,
				full: 0,
				"epoch-changed": 0,
				invalid: 0,
			},
			discarded: {
				result: 0,
				"confirmed-live": 0,
				"orphan-ttl": 0,
				invalid: 0,
				shutdown: 0,
			},
			failed: 0,
			hostileEvents: 0,
		}
		const tool = { ...this.toolTotals }
		for (const slot of this.slots.values()) {
			if (!slot.proc) continue
			for (const k of Object.keys(tool) as (keyof IqToolCounters)[])
				tool[k] += slot.proc.counters[k]
		}
		return {
			...base,
			refused: { ...base.refused, ...this.offRefusals },
			tool,
			toolRestarts: this.toolRestarts,
			toolGiveUps: this.toolGiveUps,
			replayFailures: this.replayFailures,
			dirRefusals: this.dirRefusals,
			sweep: { ...this.sweepTotals },
		}
	}

	/** Refusals counted while the store does not exist (off / legacy / unavailable). */
	private readonly offRefusals: Partial<Record<IqCaptureRefusal, number>> = {}

	// === IqCapturePort ===

	near(
		sourceId: string,
		hz: number,
		toleranceHz: number,
		opts: { observationId: string | null; limit: number },
	): readonly IqCaptureView[] {
		try {
			return this.store?.near(sourceId, hz, toleranceHz, opts) ?? []
		} catch {
			return []
		}
	}

	capture(
		req: IqCaptureRequest,
		holder: string | null = null,
	): { captureId: string } | { refused: IqCaptureRefusal } {
		try {
			return this.doCapture(req, holder)
		} catch (err: unknown) {
			this.log.warn({ err: safeErrorFields(err) }, "IQ capture request failed")
			return this.refuse("invalid")
		}
	}

	captureFor(
		req: IqCaptureRequest,
		holder: string,
	): { captureId: string } | { refused: IqCaptureRefusal } {
		if (typeof holder !== "string" || holder.length === 0)
			return this.refuse("invalid")
		return this.capture(req, holder)
	}

	private refuse(reason: IqCaptureRefusal): { refused: IqCaptureRefusal } {
		if (this.store) return this.store.refuse(reason)
		this.offRefusals[reason] = (this.offRefusals[reason] ?? 0) + 1
		return { refused: reason }
	}

	private doCapture(
		req: IqCaptureRequest,
		holder: string | null,
	): { captureId: string } | { refused: IqCaptureRefusal } {
		if (!this.cfg) return this.refuse("disabled")
		if (!this.o.protectedMode) return this.refuse("not-protected")
		const store = this.store
		if (this.st !== "on" || !store) return this.refuse("unavailable")
		if (
			typeof req !== "object" ||
			req === null ||
			typeof req.sourceId !== "string" ||
			!Number.isFinite(req.rfHz) ||
			!Number.isSafeInteger(req.fromSample) ||
			!Number.isFinite(req.epoch) ||
			(req.reason !== "detection" && req.reason !== "identify") ||
			(req.observationId !== null && typeof req.observationId !== "string") ||
			(req.tuningTrust !== "commanded" &&
				req.tuningTrust !== "relay" &&
				req.tuningTrust !== "unverified")
		)
			return this.refuse("invalid")
		const slot = this.slots.get(req.sourceId)
		const proc = slot?.proc
		if (!slot || slot.givenUp || !proc?.ready) return this.refuse("unavailable")
		const fs_ = slot.sampleRateHz
		const offsetHz = req.rfHz - slot.centerHz
		if (Math.abs(offsetHz) > fs_ / 2 - this.bandwidthHz / 2)
			return this.refuse("invalid")
		const preRollSamples = Math.round(
			(Math.min(this.cfg.preRollMs, IQ_CAPTURE_PREROLL_MAX_MS) * fs_) / 1000,
		)
		const wanted = proc.toTool(req.fromSample - preRollSamples)
		if (wanted === null) return this.refuse("unavailable")
		const submitted = proc.submittedSamples()
		const margin = Math.ceil(RING_MARGIN_S * fs_)
		const ringSamples = Math.floor((IQ_CAPTURE_PREROLL_MAX_MS * fs_) / 1000)
		// After a gap the tool's ring restarts at the gap's end: nothing older is there.
		const lo = Math.max(
			0,
			proc.oldestSample(),
			submitted - ringSamples + margin,
		)
		const hi = Math.max(
			0,
			submitted -
				Math.ceil((proc.queuedBytes() + PIPE_BUFFER_BYTES) / 2) -
				margin,
		)
		const fromSample = Math.max(lo, Math.min(hi, wanted))
		const captureId = this.uuid()
		if (!isCaptureId(captureId)) return this.refuse("invalid")
		const admitted = store.admit(req, captureId, slot.epoch)
		if ("refused" in admitted) return admitted
		// Held before the tool can answer: the queue never sees it unheld.
		if (holder !== null) store.reserve(captureId, holder)
		const maxMs = Math.min(IQ_CAPTURE_MAX_MS, this.cfg.maxCaptureMs)
		slot.ids.add(captureId)
		const sent = proc.send({
			type: "capture",
			id: captureId,
			offsetHz,
			fromSample,
			maxMs,
		})
		if (!sent) {
			slot.ids.delete(captureId)
			store.fail(captureId)
			return this.refuse("unavailable")
		}
		this.writers.set(captureId, proc)
		this.captureTimers.set(
			captureId,
			this.timers.setTimeout(() => {
				this.captureTimers.delete(captureId)
				const e = this.store?.get(captureId)
				if (e?.state === "capturing") this.store?.fail(captureId)
			}, maxMs + CAPTURE_GRACE_MS),
		)
		return { captureId }
	}

	end(captureId: string): void {
		const e = this.store?.get(captureId)
		if (e?.state === "capturing") this.endCapture(e)
	}

	private endCapture(e: IqCaptureEntry): void {
		const slot = this.slots.get(e.sourceId)
		if (slot?.ids.has(e.captureId))
			slot.proc?.send({ type: "end", id: e.captureId })
	}

	claim(captureId: string, holder: string): boolean {
		if (typeof holder !== "string" || holder.length === 0) return false
		return this.store?.claim(captureId, holder) ?? false
	}

	settle(captureId: string, holder: string): void {
		const e = this.store?.get(captureId)
		// A reserved capture still being written: ended in the tool, dropped (onRemove).
		if (e?.state === "capturing" && e.holder === holder)
			this.store?.fail(captureId)
		else this.store?.settle(captureId, holder)
	}

	confirmLive(sourceId: string, observationId: string): number {
		const store = this.store
		if (!store) return 0
		// Still being written: the store marks it confirmed-live and drops it when the tool
		// finishes or aborts it; ending it now makes that prompt.
		const writing = store
			.all()
			.filter(
				e =>
					e.state === "capturing" &&
					e.pendingDiscard === null &&
					e.sourceId === sourceId &&
					e.observationId === observationId,
			)
		const n = store.confirmLive(sourceId, observationId)
		for (const e of writing) this.endCapture(e)
		return n
	}

	openReplay(
		captureId: string,
		decoderType: ProbeDecoderType,
	): Readable | null {
		try {
			return this.doOpenReplay(captureId, decoderType)
		} catch (err: unknown) {
			this.replayFailures++
			this.log.warn({ err: safeErrorFields(err) }, "IQ replay could not start")
			return null
		}
	}

	private doOpenReplay(
		captureId: string,
		decoderType: ProbeDecoderType,
	): Readable | null {
		const store = this.store
		const cfg = this.cfg
		if (!store || !cfg || this.st !== "on" || !this.dir) return null
		if (decoderType === "rtl433") return null
		const shapes = this.shapes
		const shape =
			shapes && Object.hasOwn(shapes, decoderType)
				? shapes[decoderType]
				: undefined
		if (!shape) return null
		const e = store.get(captureId)
		if (!e || e.state !== "ready" || e.pendingDiscard !== null) return null
		const file = path.join(this.dir, `${captureId}.cf32`)
		if (!this.dirOk()) return null
		const verified = this.openProven(captureId, file, e.bytes)
		if (!verified) {
			store.discard(captureId, "invalid")
			return null
		}
		if (!store.beginReplay(captureId)) {
			fs.closeSync(verified.fd)
			return null
		}
		let child: ChildProcess
		try {
			child = this.spawn(
				cfg.binaryPath,
				[
					"replay",
					"--in",
					"/dev/fd/3",
					"--bandwidth",
					String(shape.bandwidthHz),
					"--transition",
					String(shape.transitionHz),
				],
				{
					env: this.o.env ?? childAccessEnvironment(process.env),
					detached: process.platform !== "win32",
					stdio: ["ignore", "pipe", "pipe", verified.fd],
				},
			)
		} catch (err: unknown) {
			fs.closeSync(verified.fd)
			store.endReplay(captureId)
			throw err
		}
		// The child holds its own copy of the descriptor.
		fs.closeSync(verified.fd)
		let set = this.replays.get(captureId)
		if (!set) {
			set = new Set()
			this.replays.set(captureId, set)
		}
		set.add(child)
		const out = new PassThrough()
		out.on("error", () => {})
		const limit = verified.size
		let bytes = 0
		let failed = false
		const fail = () => {
			if (failed) return
			failed = true
			this.replayFailures++
			killGroup(child, "SIGKILL")
			out.destroy(new WaveKitError("IQ replay failed", "IQ_REPLAY_FAILED"))
		}
		const timer = this.timers.setTimeout(fail, REPLAY_TIMEOUT_MS)
		child.on("error", () => fail())
		child.stderr?.on("error", () => {})
		child.stderr?.resume()
		const stdout = child.stdout
		stdout?.on("error", () => fail())
		stdout?.on("data", (chunk: Buffer) => {
			if (failed) return
			bytes += chunk.length
			if (bytes > limit) {
				fail()
				return
			}
			if (!out.write(chunk)) {
				stdout.pause()
				out.once("drain", () => stdout.resume())
			}
		})
		out.on("close", () => {
			// The consumer went away: the replay has no reader any more.
			if (child.exitCode === null && child.signalCode === null)
				killGroup(child, "SIGKILL")
		})
		child.once("close", (code: number | null) => {
			this.timers.clearTimeout(timer)
			set.delete(child)
			if (set.size === 0) this.replays.delete(captureId)
			if (!failed) {
				if (code === 0 && bytes === limit) out.end()
				else fail()
			}
			store.endReplay(captureId)
		})
		return out
	}

	// === Tool supervision ===

	private spawnTool(slot: SourceSlot): void {
		const cfg = this.cfg
		if (!cfg || this.st !== "on" || !this.dir || slot.givenUp) return
		if (this.slots.get(slot.sourceId) !== slot) return
		const proc = new IqToolProcess({
			binaryPath: cfg.binaryPath,
			sampleRateHz: slot.sampleRateHz,
			ringMs: IQ_CAPTURE_PREROLL_MAX_MS,
			outDir: this.dir,
			maxMs: Math.min(IQ_CAPTURE_MAX_MS, cfg.maxCaptureMs),
			bandwidthHz: this.bandwidthHz,
			spawn: this.spawn,
			env: this.o.env ?? childAccessEnvironment(process.env),
			timers: this.timers,
		})
		slot.proc = proc
		proc.on("event", (ev: IqToolEvent) => {
			// Per process, whatever the slot holds now: the end of this process's own captures.
			if (ev.type !== "ready" && ev.id !== undefined) {
				const id = ev.id
				if (this.writers.get(id) === proc) this.writers.delete(id)
				const z = this.zombies.get(id)
				if (z && z.proc === proc) {
					// The tool's final event for a capture Node already removed: files and bytes go now.
					this.reap(id)
					return
				}
				if (slot.proc !== proc) {
					// A late file of a replaced process is never kept (review m2, MAJOR d).
					if (ev.type === "captured") this.unlinkFiles(id, false)
					return
				}
			}
			if (slot.proc !== proc) return
			this.onToolEvent(slot, ev)
		})
		// Review m1: a gap cannot be placed exactly inside an open capture: those captures are aborted.
		proc.on("gap", () => {
			if (slot.proc !== proc) return
			for (const id of [...slot.ids]) this.store?.fail(id)
		})
		// Whatever ended it, the tool writes nothing more: it is no writer any more, and its remaining
		// zombies are released. Registered first: the slot's exit handler then drops its open
		// captures as not being written.
		proc.once("exit", () => {
			for (const [id, w] of [...this.writers])
				if (w === proc) this.writers.delete(id)
			for (const [id, z] of [...this.zombies])
				if (z.proc === proc) this.reap(id)
		})
		proc.once("exit", (failed: boolean, code: string | null) => {
			if (slot.proc !== proc) return
			slot.proc = null
			this.addToolCounters(proc)
			this.dropOpen(slot)
			if (this.st !== "on" || this.slots.get(slot.sourceId) !== slot) return
			if (code === "ENOENT") {
				this.binaryMissing()
				return
			}
			if (!failed) return
			this.onToolFailure(slot)
		})
		proc.start()
	}

	private binaryMissing(): void {
		if (this.st !== "on") return
		this.log.warn("IQ capture tool not found; capture is off")
		this.turnOff()
	}

	/** Review BLOCKING: the directory is not the proven one any more: counted, capture off. */
	private dirRefused(): void {
		this.dirRefusals++
		if (!this.warnedDir) {
			this.warnedDir = true
			this.log.warn("IQ capture directory changed; capture is off")
		}
		if (this.st === "on") this.turnOff()
	}

	/**
	 * Resolves the canonical root once (see `canonical`). Without `create` a missing root is not
	 * created (false: nothing there yet). Fixed refusals only; nothing path-like is logged.
	 */
	private async canonicalize(create: boolean): Promise<boolean> {
		if (this.canonical) return true
		let existing = this.root
		const tail: string[] = []
		while (!(await pathExists(existing))) {
			const parent = path.dirname(existing)
			if (parent === existing) return false
			tail.unshift(path.basename(existing))
			existing = parent
		}
		if (tail.length > 0 && !create) return false
		let anchor: string
		try {
			anchor = await fsp.realpath(existing)
		} catch {
			return false
		}
		let cur = anchor
		for (const part of tail) {
			cur = path.join(cur, part)
			try {
				await fsp.mkdir(cur, { mode: 0o700 })
			} catch (err: unknown) {
				if ((err as NodeJS.ErrnoException).code !== "EEXIST") return false
			}
		}
		const rootId = captureDirIdentitySync(anchor, cur)
		if (!rootId) return false
		this.anchor = anchor
		this.canonical = cur
		this.rootId = rootId
		return true
	}

	/** The canonical root is still the proven one: chain from the anchor, no link, same dev/ino. */
	private rootOk(): boolean {
		const anchor = this.anchor
		const canonical = this.canonical
		const id = this.rootId
		return (
			anchor !== null &&
			canonical !== null &&
			id !== null &&
			dirStillProvenSync(anchor, canonical, id)
		)
	}

	private dirOk(): boolean {
		const dir = this.dir
		const id = this.dirId
		if (
			dir &&
			id &&
			this.rootOk() &&
			this.anchor &&
			dirStillProvenSync(this.anchor, dir, id)
		)
			return true
		this.dirRefused()
		return false
	}

	/** Opens a capture file after the directory proof, recording (or checking) its inode. */
	private openProven(
		captureId: string,
		file: string,
		bytes: number,
	): { fd: number; size: number } | null {
		const anchor = this.anchor
		if (!anchor) return null
		const v = openVerifiedCaptureSync(anchor, file, bytes, this.uid)
		if (!v) return null
		try {
			const ino = fs.fstatSync(v.fd).ino
			const known = this.fileIno.get(captureId)
			if (known !== undefined && known !== ino) {
				fs.closeSync(v.fd)
				return null
			}
			this.fileIno.set(captureId, ino)
			return v
		} catch {
			try {
				fs.closeSync(v.fd)
			} catch {
				// closed
			}
			return null
		}
	}

	private turnOff(): void {
		this.st = "unavailable"
		for (const slot of this.slots.values()) {
			if (slot.restartTimer !== null)
				this.timers.clearTimeout(slot.restartTimer)
			slot.restartTimer = null
			this.dropOpen(slot)
			const proc = slot.proc
			slot.proc = null
			if (proc) void proc.stop()
		}
	}

	private onToolFailure(slot: SourceSlot): void {
		const now = this.now()
		slot.failures = slot.failures.filter(t => now - t < GIVE_UP_WINDOW_MS)
		slot.failures.push(now)
		if (slot.failures.length >= GIVE_UP_FAILURES) {
			slot.givenUp = true
			this.toolGiveUps++
			if (!this.warnedGiveUp) {
				this.warnedGiveUp = true
				this.log.warn(
					{ failures: slot.failures.length },
					"IQ capture tool keeps failing; capture is off for that source",
				)
			}
			return
		}
		const delay = Math.min(
			RESTART_MAX_MS,
			RESTART_BASE_MS * 2 ** (slot.failures.length - 1),
		)
		slot.restartTimer = this.timers.setTimeout(() => {
			slot.restartTimer = null
			this.toolRestarts++
			this.spawnTool(slot)
		}, delay)
	}

	private onToolEvent(slot: SourceSlot, ev: IqToolEvent): void {
		const store = this.store
		if (!store) return
		if (ev.type === "ready") return
		if (ev.type === "error") {
			if (ev.id !== undefined && slot.ids.has(ev.id)) {
				const e = store.get(ev.id)
				if (e?.state === "capturing") {
					slot.ids.delete(ev.id)
					store.fail(ev.id)
				}
			}
			return
		}
		if (!slot.ids.has(ev.id)) {
			// A late answer for a capture Node already ended (timeout, flush, discard) is expected;
			// a late file is never kept (review m2).
			if (this.forgotten.has(ev.id)) {
				if (ev.type === "captured") this.unlinkFiles(ev.id, false)
				return
			}
			store.countHostile()
			return
		}
		const e = store.get(ev.id)
		if (!e || e.state !== "capturing") {
			store.countHostile()
			return
		}
		slot.ids.delete(ev.id)
		this.clearCaptureTimer(ev.id)
		if (ev.type === "aborted") {
			store.fail(ev.id)
			return
		}
		if (!store.captured(ev.id, ev.samples, ev.gapSamples)) return
		if (e.epoch !== slot.epoch) {
			store.discard(ev.id, "invalid")
			return
		}
		this.armExpire()
		this.proveFinished(ev.id, e.bytes)
	}

	private proveFinished(captureId: string, bytes: number): void {
		const dir = this.dir
		if (!dir) return
		const file = path.join(dir, `${captureId}.cf32`)
		void Promise.resolve().then(() => {
			const store = this.store
			if (!store || this.st !== "on") return
			if (!this.dirOk()) {
				store.discard(captureId, "invalid")
				return
			}
			const v = this.openProven(captureId, file, bytes)
			if (!v) {
				store.discard(captureId, "invalid")
				return
			}
			fs.closeSync(v.fd)
			const view = store.ready(captureId)
			if (!view) return
			for (const listener of this.events.listeners("finished")) {
				try {
					;(listener as (v: IqCaptureView) => void)(view)
				} catch (err: unknown) {
					this.log.warn(
						{ err: safeErrorFields(err) },
						"IQ capture listener failed",
					)
				}
			}
		})
	}

	private clearCaptureTimer(captureId: string): void {
		const t = this.captureTimers.get(captureId)
		if (t !== undefined) this.timers.clearTimeout(t)
		this.captureTimers.delete(captureId)
	}

	/** Drops every capture the slot's process is still writing. */
	private dropOpen(slot: SourceSlot): void {
		for (const id of slot.ids) {
			this.clearCaptureTimer(id)
			this.store?.fail(id)
		}
		slot.ids.clear()
	}

	private forget(captureId: string): void {
		this.forgotten.delete(captureId)
		this.forgotten.add(captureId)
		while (this.forgotten.size > FORGOTTEN_IDS_MAX) {
			const oldest = this.forgotten.values().next().value
			if (oldest === undefined) break
			this.forgotten.delete(oldest)
		}
	}

	private addToolCounters(proc: IqToolProcess): void {
		for (const k of Object.keys(this.toolTotals) as (keyof IqToolCounters)[])
			this.toolTotals[k] += proc.counters[k]
		// Counted once: zero the process's own counters.
		for (const k of Object.keys(proc.counters) as (keyof IqToolCounters)[])
			proc.counters[k] = 0
	}

	/**
	 * Property 11: one timer armed for the earliest orphan deadline, so a capture is discarded
	 * exactly IQ_CAPTURE_ORPHAN_TTL_MS after its finish (no polling slack). Re-armed whenever a
	 * capture finishes and after every expiry pass.
	 */
	private armExpire(): void {
		const store = this.store
		const at = this.st === "on" && store ? store.nextExpiryAt() : null
		if (at === this.expireAt && (at === null || this.expireTimer !== null))
			return
		if (this.expireTimer !== null) this.timers.clearTimeout(this.expireTimer)
		this.expireTimer = null
		this.expireAt = at
		if (at === null) return
		this.expireTimer = this.timers.setTimeout(
			() => {
				this.expireTimer = null
				this.expireAt = null
				if (this.st !== "on") return
				this.expire()
			},
			Math.max(0, at - this.now()),
		)
	}

	/** Captures Node removed that some process still writes (each holds a concurrency slot). */
	private openInTool(): number {
		return this.zombies.size
	}

	private onRemove(
		entry: IqCaptureEntry,
		_reason: IqCaptureDiscardReason | "failed",
	): void {
		for (const slot of this.slots.values()) slot.ids.delete(entry.captureId)
		const writer = this.writers.get(entry.captureId) ?? null
		this.writers.delete(entry.captureId)
		this.forget(entry.captureId)
		this.clearCaptureTimer(entry.captureId)
		if (!this.dir || !isCaptureId(entry.captureId)) {
			this.store?.released(entry.bytes)
			return
		}
		if (entry.state === "capturing" && writer) {
			// Review m2/m4: the tool still writes it. Ended now; files and bytes go at its final event.
			this.zombies.set(entry.captureId, { bytes: entry.bytes, proc: writer })
			this.writers.set(entry.captureId, writer)
			if (writer.ready) writer.send({ type: "end", id: entry.captureId })
			return
		}
		this.unlinkFiles(entry.captureId, true, entry.bytes)
	}

	private reap(captureId: string): void {
		const z = this.zombies.get(captureId)
		if (!z) return
		this.zombies.delete(captureId)
		this.unlinkFiles(captureId, true, z.bytes)
	}

	/**
	 * Unlinks `<id>.cf32` (and `.tmp`) after re-proving the directory and each file (review
	 * BLOCKING; synchronous, so nothing interleaves), then releases `bytes` against the cap. A
	 * failed proof unlinks nothing and turns capture off.
	 */
	private unlinkFiles(captureId: string, tmp: boolean, bytes = 0): void {
		const dir = this.dir
		const identity = this.dirId
		const ino = this.fileIno.get(captureId)
		this.fileIno.delete(captureId)
		const anchor = this.anchor
		if (dir && identity && anchor && isCaptureId(captureId)) {
			if (!this.rootOk()) {
				this.dirRefused()
				if (bytes > 0) this.store?.released(bytes)
				return
			}
			const names = [
				`${captureId}.cf32`,
				...(tmp ? [`${captureId}.cf32.tmp`] : []),
			]
			for (const name of names) {
				const r = unlinkProvenSync(
					anchor,
					dir,
					identity,
					name,
					this.uid,
					name.endsWith(".cf32") ? ino : undefined,
				)
				if (r === "refused") {
					this.dirRefused()
					break
				}
			}
		}
		if (bytes > 0) this.store?.released(bytes)
	}
}

/** lstat answers ENOENT: false; any other answer (even an error) counts as present (proven later). */
async function pathExists(p: string): Promise<boolean> {
	try {
		await fsp.lstat(p)
		return true
	} catch (err: unknown) {
		return (err as NodeJS.ErrnoException).code !== "ENOENT"
	}
}

function killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
	if (child.exitCode !== null || child.signalCode !== null) return
	const pid = child.pid
	if (pid === undefined || pid <= 1) {
		// No process group to signal (never spawned): ChildProcess.kill is a no-op then.
		child.kill(sig)
		return
	}
	try {
		if (process.platform !== "win32") process.kill(-pid, sig)
		else child.kill(sig)
	} catch {
		try {
			child.kill(sig)
		} catch {
			// gone
		}
	}
}

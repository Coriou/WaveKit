import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { createConnection } from "node:net"
import { join } from "node:path"
import { PassThrough, type Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ChannelizerConfig, SourceCaps } from "../../config.js"
import { branchHighWaterMark, type FanoutManager } from "../fanout-manager.js"
import type { SourceFanoutRouter } from "../source-fanout-router.js"
import type { SourceManager } from "../source-manager.js"
import { WaveKitError } from "../../utils/errors.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import { admitChannel } from "./admission.js"
import {
	ChannelizerProcess,
	type ChannelizerProcessLike,
	type ChannelizerProcessOptions,
} from "./channelizer-process.js"
import {
	ChannelizerRequestSchema,
	MAX_QUEUE_BYTES,
	type ChannelizerEvent,
	type ChannelizerRequest,
	type OpenedEvent,
	type RejectedEvent,
} from "./protocol.js"
import type {
	ChannelProvider,
	ChannelRequestResult,
	DecoderChannelRequest,
} from "./types.js"
import type {
	ChannelSettlementObserver,
	LocalCleanupClaim,
	ObservedAcquisitionHandle,
	ObservedTransaction,
	ProcessClaim,
	SendClaim,
} from "./settlement-observer.js"

/** Longest socket path we hand the process; macOS caps `sun_path` at ~104 bytes (Review Focus 2). */
export const MAX_SOCKET_PATH = 100
/** Crash-loop backoff (plan A14): this many unexpected exits after `ready` within the window hold respawns. */
export const CRASH_LIMIT = 5
export const CRASH_WINDOW_MS = 60_000
const OPEN_TIMEOUT_MS = 5000
const CLOSE_TIMEOUT_MS = 250
const BUSY_BACKOFF_MS = [25, 50, 100, 200, 400] as const
const MAX_OPEN_SENDS = BUSY_BACKOFF_MS.length + 1
const SAMPLE_BYTES = { cu8: 2, cf32: 8 } as const
const MAX_NAME = 48
/**
 * A socket-safe name of at most 48 characters, so `${name}-g${generation}` stays a valid 64-character channel id.
 * When the id had to be rewritten or cut, 8 hex of its sha1 keep distinct ids apart (`a/b` vs `a_b`).
 */
function sanitize(id: string): string {
	const safe = id.replace(/[^A-Za-z0-9._-]/g, "_")
	if (safe === id && id.length > 0 && id.length <= MAX_NAME) return id
	const hash = createHash("sha1").update(id).digest("hex").slice(0, 8)
	return `${safe.slice(0, MAX_NAME - 9)}-${hash}`
}

export interface ChannelizerManagerDeps {
	sourceManager: Pick<SourceManager, "getCaps" | "on" | "off">
	routing: Pick<SourceFanoutRouter, "getFanout" | "releaseUnused">
	config: ChannelizerConfig
	logger: Logger
	createProcess?: (
		o: ChannelizerProcessOptions,
		logger: Logger,
	) => ChannelizerProcessLike
	connect?: (socketPath: string, signal?: AbortSignal) => Promise<Readable>
	/** Injectable clock for the crash-loop window (tests). */
	now?: () => number
	/** How long a request waits for `opened`/`rejected` (default 5 s; tests). */
	openTimeoutMs?: number
	/** Optional per-source idle linger; absent or zero retires immediately. */
	idleStopMs?: number
	/** Monotonic acquisition clock; separate from the crash-window wall clock. */
	openNow?: () => number
	/** Internal composition opt-in; public configured providers remain unchanged. */
	settlementObserver?: ChannelSettlementObserver
}

/** `socket` is the process's Unix socket; `stream` is what the decoder gets (fed with end: false). */
interface OpenChannel {
	id: string
	socket: Readable
	stream: PassThrough
	settlement?: SendClaim
}
type OpenRequest = Extract<ChannelizerRequest, { type: "open" }>
type OpenReply = OpenedEvent | RejectedEvent
interface RequestContext {
	decoderId: string
	signal: AbortSignal | undefined
	deadline: number
	sends: number
	observed?: ObservedAcquisitionHandle
	transaction?: ObservedTransaction
}
interface OpenAttempt {
	/** Updated synchronously on wire events, before any promise continuation. */
	pending: boolean
	opened: boolean
	closed: boolean
	interrupt: (() => void) | undefined
	reply: (e: OpenReply) => boolean
	settlement?: SendClaim
}
interface Closing {
	pendingOpen: boolean
	promise: Promise<void>
	finish: () => void
}
interface SourceChannelizer {
	sourceId: string
	generation: number
	caps: { sampleRate: number; centerHz: number }
	process: ChannelizerProcessLike
	dir: string
	fanout: FanoutManager
	branchId: string
	channels: Map<string, OpenChannel>
	waiters: Map<string, OpenAttempt>
	closing: Map<string, Closing>
	retuning: Set<string>
	interruptions: Set<() => void>
	/** Requests between `open` and attaching (or failing); the process is not idle while any is in flight. */
	pending: number
	idleTimer?: ReturnType<typeof setTimeout>
	idleCause?: string
	gapAtByte: number | null
	droppedAtGap: number
	invalidated: boolean
	sawInputEof: boolean
	detachFanout: () => void
	settlement?: ProcessClaim
}

const message = (err: unknown) =>
	err instanceof Error ? err.message : String(err)
const unavailable = (detail: string): ChannelRequestResult => ({
	ok: false,
	reasonCode: "channelizer-unavailable",
	detail,
})
const invalid = (detail: string): ChannelRequestResult => ({
	ok: false,
	reasonCode: "channel-request-invalid",
	detail,
})
/** CU8 IQ, live or replayed: recording sources carry IQ like the rate model assumes (`recording → iq`). */
const isCu8Iq = (caps: SourceCaps): boolean =>
	(caps.kind === "iq" || caps.kind === "recording") && caps.format === "U8_IQ"

/**
 * Input branch mark: the configured `inputHighWaterMark` is a floor; the mark
 * also holds DEFAULT_BRANCH_BUFFER_MS of CU8 (2 bytes per sample) at the
 * input rate. The 262 144-byte default alone held 54.6 ms at 2.4 Msps
 * (4.8 MB/s), shorter than the scheduler stalls of a loaded host; 250 ms is
 * 1 200 000 bytes there and 512 000 at 1.024 Msps. A rate change restarts
 * the process and its branch, so the mark follows the rate.
 */
export function channelizerInputMark(
	configured: number,
	sampleRateHz: number,
): number {
	return Math.max(configured, branchHighWaterMark(sampleRateHz * 2))
}

function defaultConnect(path: string, signal?: AbortSignal): Promise<Readable> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path)
		// A late transport error can arrive between acquisition settlement and the manager attaching its handler.
		socket.on("error", () => {})
		const cancelled = () => {
			cleanup()
			socket.destroy()
			reject(
				new WaveKitError(
					"channel socket connection cancelled",
					"CHANNELIZER_UNAVAILABLE",
				),
			)
		}
		const failed = (err: Error) => {
			cleanup()
			socket.destroy()
			reject(err)
		}
		const connected = () => {
			cleanup()
			resolve(socket)
		}
		const cleanup = () => {
			signal?.removeEventListener("abort", cancelled)
			socket.off("error", failed)
			socket.off("connect", connected)
		}
		socket.once("error", failed)
		socket.once("connect", connected)
		signal?.addEventListener("abort", cancelled, { once: true })
		if (signal?.aborted) cancelled()
	})
}

/**
 * One `wavekit-chan` per source (addendum §4, §6; plan A2, A14): a raw-fanout consumer spawned lazily on the first
 * channel request and stopped when its last channel is released. Every spawn is a new generation; caps changes,
 * source loss and unexpected exits invalidate the generation's channels, and nothing respawns until the next request.
 */
export class ChannelizerManager
	extends EventEmitter
	implements ChannelProvider
{
	private readonly log: Logger
	private readonly active = new Map<string, SourceChannelizer>()
	private readonly generations = new Map<string, number>()
	private readonly queues = new Map<string, Promise<unknown>>()
	private readonly channelOwner = new Map<string, string>()
	/** Per source: times of unexpected exits after `ready`. */
	private readonly crashes = new Map<string, number[]>()
	/** Per source: bumped on every `disconnected`/`removed`, so a spawn that raced a loss is not used. */
	private readonly losses = new Map<string, number>()
	/** Process stops in flight; `destroy()` awaits them all (PF14). */
	private readonly stops = new Set<Promise<void>>()
	private readonly releases = new Map<string, Promise<void>>()
	private readonly destroyWaiters = new Set<() => void>()
	private readonly createProcess: NonNullable<
		ChannelizerManagerDeps["createProcess"]
	>
	private readonly connect: NonNullable<ChannelizerManagerDeps["connect"]>
	private readonly now: () => number
	private readonly openTimeoutMs: number
	private readonly openNow: () => number
	private readonly processClaims = new WeakMap<
		ChannelizerProcessLike,
		ProcessClaim
	>()
	private readonly directoryClaims = new WeakMap<
		ChannelizerProcessLike,
		LocalCleanupClaim
	>()
	private readonly listenerClaims: {
		readonly claim: LocalCleanupClaim
		readonly remove: () => void
	}[] = []
	private destroyed = false
	private readonly onCaps = (sourceId: string, caps: SourceCaps) => {
		const s = this.active.get(sourceId)
		if (s && this.capsDiffer(s, caps)) this.invalidate(sourceId, "caps-changed")
	}
	private readonly onGone = (sourceId: string) => {
		this.losses.set(sourceId, (this.losses.get(sourceId) ?? 0) + 1)
		this.invalidate(sourceId, "source-lost")
	}

	constructor(private readonly deps: ChannelizerManagerDeps) {
		super()
		this.log = createComponentLogger(deps.logger, "ChannelizerManager")
		this.createProcess =
			deps.createProcess ?? ((o, l) => new ChannelizerProcess(o, l))
		this.connect = deps.connect ?? defaultConnect
		this.now = deps.now ?? Date.now
		this.openTimeoutMs = deps.openTimeoutMs ?? OPEN_TIMEOUT_MS
		this.openNow = deps.openNow ?? (() => performance.now())
		deps.settlementObserver?.bindProvider(this)
		for (const [event, listener] of [
			["caps-changed", this.onCaps],
			["disconnected", this.onGone],
			["removed", this.onGone],
		] as const) {
			const remove = () => {
				deps.sourceManager.off(event, listener)
				if (
					!(deps.sourceManager instanceof EventEmitter) ||
					deps.sourceManager.listeners(event).includes(listener)
				)
					throw new WaveKitError(
						"channel settlement listener cleanup incomplete",
						"CHANNELIZER_UNAVAILABLE",
					)
			}
			const claim = deps.settlementObserver?.provider.ownListener(remove)
			if (deps.settlementObserver && !claim)
				throw new WaveKitError(
					"channel settlement capacity unavailable",
					"CHANNELIZER_UNAVAILABLE",
				)
			if (claim) this.listenerClaims.push({ claim, remove })
		}
		deps.sourceManager.on("caps-changed", this.onCaps)
		deps.sourceManager.on("disconnected", this.onGone)
		deps.sourceManager.on("removed", this.onGone)
	}

	/** Widened so it satisfies `ChannelProvider.off`, whose listener takes `never[]`. */
	override off(
		event: string | symbol,
		listener: (...args: never[]) => void,
	): this {
		return super.off(event, listener as (...args: unknown[]) => void)
	}

	currentGeneration(sourceId: string): number {
		return this.generations.get(sourceId) ?? 0
	}

	/** Unexpected exits after `ready` within the current CRASH_WINDOW_MS. */
	unexpectedExitCount(sourceId: string): number {
		return this.recentCrashes(sourceId).length
	}

	requestChannel(
		sourceId: string,
		decoderId: string,
		req: DecoderChannelRequest,
		inputCaps: SourceCaps | undefined,
		signal?: AbortSignal,
	): Promise<ChannelRequestResult> {
		const observed = this.deps.settlementObserver?.takeAcquisition(
			sourceId,
			decoderId,
			req,
		)
		// A queued cancellation settles the caller now; its eventual queue callback
		// remains a no-op. Running work settles through bounded ownership cleanup.
		return new Promise((resolve, reject) => {
			const cancelled = () => resolve(unavailable(this.cancellationDetail()))
			signal?.addEventListener("abort", cancelled, { once: true })
			if (signal?.aborted) cancelled()
			const run = () => {
				signal?.removeEventListener("abort", cancelled)
				if (signal?.aborted) return unavailable(this.cancellationDetail())
				const transaction = observed
					? this.deps.settlementObserver?.tryReserveObservedTransaction(
							observed,
						)
					: undefined
				if (observed && (!transaction || this.deps.createProcess))
					return unavailable("channel settlement capacity unavailable")
				const ctx: RequestContext = {
					decoderId,
					signal,
					deadline: this.openNow() + this.openTimeoutMs,
					sends: 0,
					...(observed ? { observed } : {}),
					...(transaction ? { transaction } : {}),
				}
				return this.request(sourceId, decoderId, req, inputCaps, ctx)
			}
			const next = (this.queues.get(sourceId) ?? Promise.resolve()).then(
				run,
				run,
			)
			this.queues.set(
				sourceId,
				next.catch(() => undefined),
			)
			void next.then(
				result => {
					if (observed)
						this.deps.settlementObserver?.finishAcquisition(observed)
					resolve(result)
				},
				err => {
					if (observed)
						this.deps.settlementObserver?.finishAcquisition(observed)
					reject(err)
				},
			)
		})
	}

	/** Keeps the existing stream; callers close and reopen on refusal or transport failure. */
	async retuneChannel(
		sourceId: string,
		channelId: string,
		centerHz: number,
	): Promise<"retuned" | "refused"> {
		const s = this.active.get(sourceId)
		const ch = s?.channels.get(channelId)
		if (
			!s ||
			!ch ||
			s.invalidated ||
			this.channelOwner.get(channelId) !== sourceId
		)
			throw new WaveKitError("unknown channel", "CHANNELIZER_REQUEST_INVALID")
		if (!Number.isFinite(centerHz))
			throw new WaveKitError(
				"invalid channel centre",
				"CHANNELIZER_REQUEST_INVALID",
			)
		if (s.retuning.has(channelId))
			throw new WaveKitError(
				"channel retune already pending",
				"CHANNELIZER_REQUEST_INVALID",
			)
		return new Promise((resolve, reject) => {
			let settled = false
			const fail = () =>
				finish(
					new WaveKitError(
						"channel retune transport unavailable",
						"CHANNELIZER_UNAVAILABLE",
					),
				)
			const onEvent = (e: ChannelizerEvent) => {
				if (e.generation !== s.generation) return
				if (
					(e.type === "retuned" || e.type === "refused") &&
					e.channelId === channelId
				) {
					const live =
						this.active.get(sourceId) === s &&
						!s.invalidated &&
						s.channels.get(channelId) === ch &&
						this.channelOwner.get(channelId) === sourceId &&
						!ch.stream.destroyed
					if (!live || (e.type === "retuned" && e.centerHz !== centerHz)) {
						fail()
						return
					}
					finish(e.type)
				} else if (e.type === "closed" && e.id === channelId) fail()
			}
			const finish = (result: "retuned" | "refused" | WaveKitError) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				s.process.off("event", onEvent)
				s.process.off("protocol-error", fail)
				ch.stream.off("close", fail)
				s.interruptions.delete(fail)
				s.retuning.delete(channelId)
				if (result instanceof WaveKitError) reject(result)
				else resolve(result)
			}
			const timer = setTimeout(fail, this.deps.openTimeoutMs ?? OPEN_TIMEOUT_MS)
			s.retuning.add(channelId)
			s.interruptions.add(fail)
			s.process.on("event", onEvent)
			s.process.on("protocol-error", fail)
			ch.stream.once("close", fail)
			try {
				s.process.send({ v: 1, type: "retune", channelId, centerHz })
			} catch {
				fail()
			}
		})
	}

	releaseChannel(channelId: string): Promise<void> {
		const held = this.releases.get(channelId)
		if (held) return held
		const sourceId = this.channelOwner.get(channelId)
		if (sourceId === undefined) return Promise.resolve()
		const s = this.active.get(sourceId)
		const ch = s?.channels.get(channelId)
		if (!s || !ch) return Promise.resolve()
		if (ch.settlement)
			this.deps.settlementObserver?.endGrant(ch.settlement, "released")
		this.channelOwner.delete(channelId)
		s.channels.delete(channelId)
		const settlement = this.closeOwned(s, channelId, false)
		ch.socket.destroy()
		ch.stream.destroy()
		this.releases.set(channelId, settlement)
		void settlement.then(() => {
			if (this.releases.get(channelId) === settlement)
				this.releases.delete(channelId)
		})
		this.stopIfIdle(s, "last-channel-released")
		return settlement
	}

	async destroy(): Promise<void> {
		this.destroyed = true
		this.deps.settlementObserver?.sealAdmission()
		for (const wake of [...this.destroyWaiters]) wake()
		if (this.deps.settlementObserver) {
			for (const { claim, remove } of this.listenerClaims) {
				try {
					remove()
					claim.settle({ ok: true })
				} catch {
					claim.settle({
						ok: false,
						state: "failed",
						detail: "channel settlement listener cleanup failed",
					})
				}
			}
		} else {
			this.deps.sourceManager.off("caps-changed", this.onCaps)
			this.deps.sourceManager.off("disconnected", this.onGone)
			this.deps.sourceManager.off("removed", this.onGone)
		}
		for (const sourceId of [...this.active.keys()])
			this.invalidate(sourceId, "destroy")
		// Initiate provider and transport cleanup before waiting for any native
		// close. In-flight startup/queue ownership settles independently.
		const localCleanup = this.deps.settlementObserver?.attemptLocalCleanup()
		if (localCleanup) {
			await Promise.allSettled([...this.queues.values(), localCleanup])
			while (this.stops.size > 0) await Promise.allSettled(this.stops)
		} else {
			await Promise.all(this.queues.values())
			while (this.stops.size > 0) await Promise.all(this.stops)
		}
	}

	private async request(
		sourceId: string,
		decoderId: string,
		req: DecoderChannelRequest,
		inputCaps: SourceCaps | undefined,
		ctx: RequestContext,
		retried = false,
	): Promise<ChannelRequestResult> {
		if (this.destroyed) return unavailable("channelizer manager destroyed")
		if (ctx.signal?.aborted) return unavailable(this.cancellationDetail())
		if (this.remaining(ctx) <= 0) return this.timeout()
		const caps = this.deps.sourceManager.getCaps(sourceId)
		if (!caps || !isCu8Iq(caps))
			return invalid(
				`source ${sourceId} is not CU8 IQ (${caps?.kind ?? "none"}/${caps?.format ?? "none"})`,
			)
		if (
			inputCaps &&
			(inputCaps.sampleRate !== caps.sampleRate ||
				inputCaps.centerFreq !== caps.centerFreq)
		)
			this.log.debug(
				{ sourceId, decoderId },
				"Request carried stale caps; using current source caps",
			)
		let s = this.active.get(sourceId)
		// An unknown capture centre is assumed to be the first request's centre (offset 0). A running process keeps
		// that assumption, so a second decoder cannot make the two invalidate each other in turn.
		const assumed =
			s && s.caps.sampleRate === caps.sampleRate
				? s.caps.centerHz
				: req.centerHz
		const centerHz = caps.centerFreq ?? assumed
		if (caps.centerFreq === undefined)
			this.log.info(
				{ sourceId, decoderId, centerHz },
				"Capture centre unknown; assuming the channel centre",
			)
		const verdict = admitChannel(
			req,
			{ sampleRateHz: caps.sampleRate, centerHz },
			this.deps.config.usableFraction,
		)
		if (!verdict.admitted)
			return {
				ok: false,
				reasonCode: verdict.reasonCode,
				detail: verdict.detail,
			}
		const queueBytes = this.queueBytes(req)
		if (typeof queueBytes === "string") return invalid(queueBytes)
		if (
			s &&
			(s.caps.sampleRate !== caps.sampleRate || s.caps.centerHz !== centerHz)
		) {
			this.invalidate(sourceId, "caps-changed")
			s = undefined
		}
		const generation = s?.generation ?? this.currentGeneration(sourceId) + 1
		const channelId = `${sanitize(decoderId)}-g${generation}`
		const closing = s?.closing.get(channelId)
		if (s && closing) {
			const protectIdle = (this.deps.idleStopMs ?? 0) > 0
			const idleCause = s.idleCause ?? "no-channels"
			if (protectIdle) {
				this.clearIdleTimer(s)
				s.pending++
			}
			try {
				const settled = await this.wait(s, ctx, done => {
					void closing.promise.then(() => done("closed"))
					return () => {}
				})
				if (settled === "cancelled")
					return unavailable(this.cancellationDetail())
				if (settled === null) return this.timeout()
				return await this.request(
					sourceId,
					decoderId,
					req,
					inputCaps,
					ctx,
					retried,
				)
			} finally {
				if (protectIdle) {
					s.pending--
					this.stopIfIdle(s, idleCause)
				}
			}
		}
		// The process rejects a duplicate id; refusing it here keeps the open channel's socket untouched.
		if (s?.channels.has(channelId))
			return invalid(`duplicate channel id ${channelId}`)
		const open: OpenRequest = {
			v: 1,
			type: "open",
			id: channelId,
			centerHz: req.centerHz,
			bandwidthHz: req.bandwidthHz,
			transitionHz: req.transitionHz,
			outputRateHz: req.outputRateHz,
			format: req.format,
			...(req.gain !== undefined ? { gain: req.gain } : {}),
			queueBytes,
		}
		const parsed = ChannelizerRequestSchema.safeParse(open)
		if (!parsed.success)
			return invalid(`open request invalid: ${parsed.error.message}`)
		const dir = join(
			this.deps.config.socketDir,
			`${sanitize(sourceId)}-g${generation}`,
		)
		const socketPath = join(dir, `${channelId}.sock`)
		const length = Buffer.byteLength(socketPath)
		if (length > MAX_SOCKET_PATH) {
			this.log.warn(
				{ sourceId, decoderId, socketPath, length },
				"Channel socket path too long",
			)
			return unavailable(
				`socket path too long (${length} > ${MAX_SOCKET_PATH}): ${socketPath}`,
			)
		}
		const superseded = (): Promise<ChannelRequestResult> => {
			if (ctx.signal?.aborted)
				return Promise.resolve(unavailable(this.cancellationDetail()))
			if (this.destroyed)
				return Promise.resolve(unavailable("channelizer manager destroyed"))
			if (this.remaining(ctx) <= 0) return Promise.resolve(this.timeout())
			if (ctx.sends >= MAX_OPEN_SENDS)
				return Promise.resolve(unavailable("channel open send limit reached"))
			return retried
				? Promise.resolve(unavailable("generation superseded twice"))
				: this.request(sourceId, decoderId, req, inputCaps, ctx, true)
		}
		if (!s) {
			const held = this.crashLoopHold(sourceId)
			if (held) return unavailable(held)
			const losses = this.losses.get(sourceId) ?? 0
			const spawned = await this.spawn(
				sourceId,
				{ sampleRate: caps.sampleRate, centerHz },
				generation,
				dir,
				ctx,
			)
			if ("error" in spawned) return unavailable(spawned.error)
			s = spawned
			if (this.destroyed) {
				this.retire(s, "destroy")
				return unavailable("channelizer manager destroyed")
			}
			// Caps changes and source loss during the spawn found no active process to invalidate.
			const now = this.deps.sourceManager.getCaps(sourceId)
			if (
				(this.losses.get(sourceId) ?? 0) !== losses ||
				!now ||
				this.capsDiffer(s, now)
			) {
				this.invalidate(sourceId, "changed-during-spawn")
				return superseded()
			}
		}
		if (
			ctx.transaction &&
			(!s.settlement ||
				!this.deps.settlementObserver?.shareProcess(
					ctx.transaction,
					s.settlement,
				))
		)
			return unavailable("channelizer settlement unavailable")
		if (
			ctx.transaction &&
			Buffer.byteLength(join(s.dir, `${channelId}.sock`)) > MAX_SOCKET_PATH
		) {
			this.stopIfIdle(s, "socket-path-unavailable")
			return unavailable("channel socket path unavailable")
		}
		return this.open(s, open, ctx, superseded)
	}

	private async open(
		s: SourceChannelizer,
		open: OpenRequest,
		ctx: RequestContext,
		superseded: () => Promise<ChannelRequestResult>,
	): Promise<ChannelRequestResult> {
		const channelId = open.id
		this.clearIdleTimer(s)
		s.pending++
		let ownedAttempt: OpenAttempt | undefined
		try {
			let event: OpenedEvent
			for (;;) {
				if (ctx.signal?.aborted) return unavailable(this.cancellationDetail())
				if (this.destroyed) return unavailable("channelizer manager destroyed")
				const caps = this.deps.sourceManager.getCaps(s.sourceId)
				if (!s.invalidated && (!caps || this.capsDiffer(s, caps)))
					this.invalidate(s.sourceId, "caps-changed")
				if (s.invalidated || this.active.get(s.sourceId) !== s)
					return await superseded()
				if (this.remaining(ctx) <= 0) return this.timeout()
				if (ctx.sends >= MAX_OPEN_SENDS)
					return unavailable("channel open send limit reached")
				const attempt: OpenAttempt = {
					pending: true,
					opened: false,
					closed: false,
					interrupt: undefined,
					reply: () => false,
				}
				ownedAttempt = attempt
				if (ctx.transaction) {
					const send =
						s.settlement &&
						this.deps.settlementObserver?.claimSend(
							ctx.transaction,
							s.settlement,
							channelId,
						)
					if (!send || !s.process.sendObserved)
						return unavailable("channel settlement capacity unavailable")
					attempt.settlement = send
				}
				const reply = await this.wait<OpenReply>(s, ctx, done => {
					attempt.reply = done
					s.waiters.set(channelId, attempt)
					ctx.sends++
					if (attempt.settlement)
						s.process.sendObserved?.(open, attempt.settlement)
					else s.process.send(open)
					return () => {
						if (!attempt.opened && s.waiters.get(channelId) === attempt)
							s.waiters.delete(channelId)
					}
				})
				if (reply === "superseded") return await superseded()
				if (reply === "cancelled" || reply === null) {
					await this.closeOwned(
						s,
						channelId,
						attempt.pending,
						this.remaining(ctx),
						reply === null ? "open-timeout" : "cancel-close-unconfirmed",
					)
					return reply === null
						? this.timeout()
						: unavailable(this.cancellationDetail())
				}
				if (s.invalidated) return await superseded()
				if (ctx.signal?.aborted || this.remaining(ctx) <= 0) {
					if (reply.type === "opened" && !attempt.closed)
						await this.closeOwned(
							s,
							channelId,
							false,
							this.remaining(ctx),
							ctx.signal?.aborted ? "cancel-close-unconfirmed" : "open-timeout",
						)
					return ctx.signal?.aborted
						? unavailable(this.cancellationDetail())
						: this.timeout()
				}
				if (reply.type === "rejected") {
					if (
						reply.reasonCode !== "channel-request-invalid" ||
						reply.detail !== "planner busy"
					)
						return {
							ok: false,
							reasonCode: reply.reasonCode,
							detail: reply.detail,
						}
					if (ctx.sends >= MAX_OPEN_SENDS)
						return unavailable("planner busy retry limit reached")
					const backoff = BUSY_BACKOFF_MS[ctx.sends - 1] ?? 400
					const waited = await this.wait(
						s,
						ctx,
						() => () => {},
						backoff,
						"elapsed",
					)
					if (waited === "cancelled")
						return unavailable(this.cancellationDetail())
					if (waited === "superseded") return await superseded()
					if (waited === null) return this.timeout()
					continue
				}
				event = reply
				break
			}
			if (ownedAttempt?.closed)
				return unavailable("channel closed during acquisition")
			if (ctx.signal?.aborted || this.remaining(ctx) <= 0) {
				await this.closeOwned(
					s,
					channelId,
					false,
					this.remaining(ctx),
					ctx.signal?.aborted ? "cancel-close-unconfirmed" : "open-timeout",
				)
				return ctx.signal?.aborted
					? unavailable(this.cancellationDetail())
					: this.timeout()
			}
			if (
				s.invalidated ||
				event.generation !== this.currentGeneration(s.sourceId)
			)
				return await superseded()
			const connected = await this.wait<
				{ socket: Readable } | { failed: true }
			>(s, ctx, done => {
				const connectorOwner = ownedAttempt?.settlement?.retainConnector()
				const connectCancel = new AbortController()
				if (ownedAttempt)
					ownedAttempt.interrupt = () => {
						done({ failed: true })
					}
				let accepted = false
				void Promise.resolve()
					.then(() => {
						if (
							ctx.signal?.aborted ||
							s.invalidated ||
							this.destroyed ||
							this.remaining(ctx) <= 0
						) {
							connectorOwner?.settle({ ok: true })
							return undefined
						}
						return this.connect(event.socket, connectCancel.signal)
					})
					.then(
						socket => {
							if (socket) {
								socket.once("close", () => connectorOwner?.settle({ ok: true }))
								accepted = true
								if (!done({ socket })) socket.destroy()
							}
						},
						() => {
							// A foreign connector may reject after creating a resource we cannot own.
							connectorOwner?.settle({
								ok: false,
								state: "unknown",
								detail: "channel connector cleanup unknown",
							})
							done({ failed: true })
						},
					)
				return () => {
					if (ownedAttempt) ownedAttempt.interrupt = undefined
					if (!accepted) connectCancel.abort()
				}
			})
			if (connected === "superseded") return await superseded()
			if (
				connected === "cancelled" ||
				connected === null ||
				"failed" in connected
			) {
				if (!ownedAttempt?.closed)
					await this.closeOwned(
						s,
						channelId,
						false,
						this.remaining(ctx),
						connected === null
							? "open-timeout"
							: connected === "cancelled"
								? "cancel-close-unconfirmed"
								: "connect-close-unconfirmed",
					)
				if (
					ownedAttempt?.closed &&
					connected !== "cancelled" &&
					connected !== null
				)
					return unavailable("channel closed during acquisition")
				return connected === "cancelled"
					? unavailable(this.cancellationDetail())
					: connected === null
						? this.timeout()
						: unavailable("channel socket connection failed")
			}
			const socket = connected.socket
			socket.on("error", (err: Error) => {
				this.log.debug({ err, channelId }, "Channel socket error")
				this.channelDied(s, channelId, socket, "socket-error")
			})
			if (
				ctx.signal?.aborted ||
				this.remaining(ctx) <= 0 ||
				s.invalidated ||
				ownedAttempt?.closed
			) {
				socket.destroy()
				if (ownedAttempt?.closed)
					return unavailable("channel closed during acquisition")
				if (s.invalidated) return await superseded()
				await this.closeOwned(
					s,
					channelId,
					false,
					this.remaining(ctx),
					ctx.signal?.aborted ? "cancel-close-unconfirmed" : "open-timeout",
				)
				return ctx.signal?.aborted
					? unavailable(this.cancellationDetail())
					: this.timeout()
			}
			const stream = new PassThrough()
			stream.on("error", (err: Error) =>
				this.log.debug({ err, channelId }, "Channel stream error"),
			)
			socket.pipe(stream, { end: false })
			s.channels.set(channelId, {
				id: channelId,
				socket,
				stream,
				...(ownedAttempt?.settlement
					? { settlement: ownedAttempt.settlement }
					: {}),
			})
			this.channelOwner.set(channelId, s.sourceId)
			if (ownedAttempt?.settlement && s.settlement)
				this.deps.settlementObserver?.recordGrant(ownedAttempt.settlement, {
					sourceId: s.sourceId,
					decoderId: ctx.decoderId,
					channelId,
					generation: event.generation,
					realised: {
						outputRateHz: event.outputRateHz,
						format: event.format,
						filterTaps: event.filterTaps,
						groupDelaySamples: event.groupDelaySamples,
					},
					process: s.settlement,
					send: ownedAttempt.settlement,
				})
			return {
				ok: true,
				stream,
				channelId,
				generation: event.generation,
				realised: {
					outputRateHz: event.outputRateHz,
					format: event.format,
					groupDelaySamples: event.groupDelaySamples,
				},
			}
		} finally {
			if (s.waiters.get(channelId) === ownedAttempt) s.waiters.delete(channelId)
			s.pending--
			this.stopIfIdle(s, "no-channels")
		}
	}

	private remaining(ctx: RequestContext): number {
		return Math.max(0, ctx.deadline - this.openNow())
	}

	private cancellationDetail(): string {
		return this.destroyed
			? "channelizer manager destroyed"
			: "channel request cancelled"
	}

	private timeout(): ChannelRequestResult {
		return unavailable(this.timeoutDetail())
	}

	private timeoutDetail(): string {
		return `channel request timed out after ${this.openTimeoutMs} ms`
	}

	/** All acquisition waits share one monotonic deadline and wake immediately on cancellation/retirement. */
	private wait<T>(
		s: SourceChannelizer | undefined,
		ctx: RequestContext,
		subscribe: (done: (value: T) => boolean) => () => void,
		delay = this.remaining(ctx),
		timeoutReply: T | null = null,
	): Promise<T | "cancelled" | "superseded" | null> {
		return new Promise(resolve => {
			let settled = false
			let cleanup = () => {}
			let timer: ReturnType<typeof setTimeout> | undefined
			const finish = (
				value: T | "cancelled" | "superseded" | null,
			): boolean => {
				if (settled) return false
				settled = true
				if (timer !== undefined) clearTimeout(timer)
				ctx.signal?.removeEventListener("abort", cancelled)
				this.destroyWaiters.delete(cancelled)
				s?.interruptions.delete(superseded)
				cleanup()
				resolve(value)
				return true
			}
			const cancelled = () => {
				finish("cancelled")
			}
			const superseded = () => {
				finish("superseded")
			}
			ctx.signal?.addEventListener("abort", cancelled, { once: true })
			this.destroyWaiters.add(cancelled)
			s?.interruptions.add(superseded)
			const remaining = this.remaining(ctx)
			if (ctx.signal?.aborted || this.destroyed) {
				finish("cancelled")
				return
			}
			if (s?.invalidated) {
				finish("superseded")
				return
			}
			if (remaining <= 0) {
				finish(null)
				return
			}
			timer = setTimeout(
				() => {
					finish(delay < remaining ? timeoutReply : null)
				},
				Math.min(delay, remaining),
			)
			cleanup = subscribe(finish)
			if (settled) cleanup() // synchronous fake/event delivery can settle inside subscribe
		})
	}

	/** A closed line is a FIFO terminal barrier. Unknown native close has no reply: bounded retirement is the fallback. */
	private closeOwned(
		s: SourceChannelizer,
		id: string,
		pendingOpen: boolean,
		budget = CLOSE_TIMEOUT_MS,
		cause = "close-unconfirmed",
	): Promise<void> {
		if (s.invalidated) return Promise.resolve()
		const held = s.closing.get(id)
		if (held) return held.promise
		let resolve = () => {}
		const promise = new Promise<void>(done => {
			resolve = done
		})
		let timer: ReturnType<typeof setTimeout> | undefined
		const closing: Closing = {
			pendingOpen,
			promise,
			finish: () => {
				if (s.closing.get(id) !== closing) return
				s.closing.delete(id)
				if (timer !== undefined) clearTimeout(timer)
				resolve()
			},
		}
		s.closing.set(id, closing) // before send or socket destruction
		s.process.send({ v: 1, type: "close", id })
		if (s.closing.get(id) === closing) {
			const retire = () => {
				if (this.active.get(s.sourceId) === s)
					this.invalidate(s.sourceId, cause)
				closing.finish()
			}
			if (budget <= 0) retire()
			else timer = setTimeout(retire, Math.min(CLOSE_TIMEOUT_MS, budget))
		}
		return promise
	}

	private async spawn(
		sourceId: string,
		caps: { sampleRate: number; centerHz: number },
		generation: number,
		dir: string,
		ctx: RequestContext,
	): Promise<SourceChannelizer | { error: string }> {
		const settlement =
			ctx.transaction &&
			this.deps.settlementObserver?.claimProcess(ctx.transaction, {
				sourceId,
				generation,
				sampleRateHz: caps.sampleRate,
				centerHz: caps.centerHz,
			})
		if (ctx.transaction && !settlement)
			return { error: "channel settlement capacity unavailable" }
		const directoryOwner = settlement?.retainLocal("directory")
		try {
			// A fresh, private directory per generation: stale sockets from an earlier run never linger.
			if (settlement) {
				mkdirSync(this.deps.config.socketDir, { recursive: true, mode: 0o700 })
				dir = mkdtempSync(`${dir}-`)
			} else {
				rmSync(dir, { recursive: true, force: true })
				mkdirSync(dir, { recursive: true, mode: 0o700 })
			}
		} catch (err: unknown) {
			settlement?.sealStartup()
			settlement?.recordStartSettled()
			directoryOwner?.settle({
				ok: false,
				state: "unknown",
				detail: "channel directory cleanup unknown",
			})
			// e.g. EACCES on the default /var/run/wavekit/chan outside the image: a suspension, never a crash.
			this.log.warn({ err, sourceId, dir }, "Cannot create channel socket dir")
			return { error: `socket dir ${dir}: ${message(err)}` }
		}
		this.generations.set(sourceId, generation)
		let proc: ChannelizerProcessLike
		try {
			proc = this.createProcess(
				{
					binaryPath: this.deps.config.binaryPath,
					generation,
					inputRateHz: caps.sampleRate,
					inputCenterHz: caps.centerHz,
					usableFraction: this.deps.config.usableFraction,
					blockSamples: this.deps.config.blockSamples,
					socketDir: dir,
					readyTimeoutMs: this.remaining(ctx),
					...(settlement && this.deps.settlementObserver
						? {
								settlement: {
									process: settlement,
									observer: this.deps.settlementObserver,
									deadline: ctx.deadline,
									now: this.openNow,
								},
							}
						: {}),
				},
				this.deps.logger,
			)
		} catch (err: unknown) {
			settlement?.sealStartup()
			settlement?.recordStartSettled()
			try {
				rmSync(dir, { recursive: true, force: true })
				directoryOwner?.settle({ ok: true })
			} catch {
				directoryOwner?.settle({
					ok: false,
					state: "failed",
					detail: "channel directory cleanup failed",
				})
			}
			return { error: message(err) }
		}
		if (settlement) this.processClaims.set(proc, settlement)
		if (directoryOwner) this.directoryClaims.set(proc, directoryOwner)
		let readyGeneration: number | undefined
		const onReady = (e: ChannelizerEvent) => {
			if (e.type === "ready") readyGeneration = e.generation
		}
		proc.on("event", onReady)
		try {
			const started = await this.wait<"ready" | { error: string }>(
				undefined,
				ctx,
				done => {
					void proc.start().then(
						() => done("ready"),
						(err: unknown) => done({ error: message(err) }),
					)
					return () => {}
				},
			)
			if (started !== "ready") {
				this.stopProcess(proc, dir)
				return {
					error:
						started === "cancelled"
							? this.cancellationDetail()
							: started === null || started === "superseded"
								? this.timeoutDetail()
								: started.error,
				}
			}
		} catch (err: unknown) {
			// Logged at warn: DecoderManager reports channelizer-unavailable at error once (Review Focus 4).
			this.log.warn({ err, sourceId, generation }, "wavekit-chan did not start")
			this.stopProcess(proc, dir)
			return { error: message(err) }
		} finally {
			proc.off("event", onReady)
		}
		if (readyGeneration !== generation) {
			this.log.warn(
				{ sourceId, generation, readyGeneration },
				"wavekit-chan reported another generation",
			)
			this.stopProcess(proc, dir)
			return {
				error: `wavekit-chan reported ready for generation ${String(readyGeneration)}, expected ${generation}`,
			}
		}
		const fanout = this.deps.routing.getFanout(sourceId)
		const branchId = `channelizer-${sourceId}`
		const onBackpressure = (id: string) => {
			if (id !== branchId || s.gapAtByte !== null) return
			const t = fanout.getBranchTelemetry(branchId)
			if (!t) return
			// A2: the seam is the first byte the branch did not deliver.
			s.gapAtByte = t.totalBytesWritten - t.droppedBytesTotal
			s.droppedAtGap = t.droppedBytesTotal
		}
		const onDrain = (id: string) => {
			if (id !== branchId || s.gapAtByte === null) return
			const t = fanout.getBranchTelemetry(branchId)
			const dropped = (t?.droppedBytesTotal ?? s.droppedAtGap) - s.droppedAtGap
			if (dropped > 0)
				proc.send({
					v: 1,
					type: "mark-gap",
					atInputByte: s.gapAtByte,
					droppedInputBytes: dropped,
				})
			s.gapAtByte = null
		}
		const s: SourceChannelizer = {
			sourceId,
			generation,
			caps,
			process: proc,
			dir,
			fanout,
			branchId,
			channels: new Map(),
			waiters: new Map(),
			closing: new Map(),
			interruptions: new Set(),
			retuning: new Set(),
			pending: 0,
			gapAtByte: null,
			droppedAtGap: 0,
			invalidated: false,
			sawInputEof: false,
			detachFanout: () => {
				fanout.off("backpressure", onBackpressure)
				fanout.off("drain", onDrain)
			},
			...(settlement ? { settlement } : {}),
		}
		const branch = fanout.addBranch({
			id: branchId,
			sourceId,
			highWaterMark: channelizerInputMark(
				this.deps.config.inputHighWaterMark,
				caps.sampleRate,
			),
		})
		void pipeline(branch, proc.input).catch((err: unknown) =>
			this.log.debug(
				{ err, sourceId, generation },
				"Channelizer input pipeline ended",
			),
		)
		fanout.on("backpressure", onBackpressure)
		fanout.on("drain", onDrain)
		proc.on("event", (e: ChannelizerEvent) => this.onEvent(s, e))
		proc.on("exit", (code: number | null, signal: string | null) =>
			this.onExit(s, code, signal),
		)
		this.active.set(sourceId, s)
		this.log.info({ sourceId, generation, dir }, "Channelizer started")
		return s
	}

	private onEvent(s: SourceChannelizer, e: ChannelizerEvent): void {
		// Capture exact native attempt BEFORE any close finish, resolver or consumer
		// callback can synchronously send another request with the same opaque id.
		const terminal =
			s.settlement &&
			e.generation === s.generation &&
			(e.type === "opened" || e.type === "rejected" || e.type === "closed")
				? this.deps.settlementObserver?.captureTerminal(
						s.settlement,
						e.id,
						e.type,
					)
				: undefined
		if (
			terminal &&
			(e.type === "opened" || e.type === "rejected" || e.type === "closed")
		)
			this.deps.settlementObserver?.recordTerminal(terminal, e.type)
		if (s.invalidated || this.active.get(s.sourceId) !== s) return
		if (e.generation !== s.generation) {
			this.log.warn(
				{ sourceId: s.sourceId, got: e.generation, want: s.generation },
				"Ignoring event from another generation",
			)
			return
		}
		switch (e.type) {
			case "opened":
			case "rejected":
				{
					const closing = s.closing.get(e.id)
					if (closing) {
						if (e.type === "rejected" && closing.pendingOpen) closing.finish()
						else if (e.type === "opened") closing.pendingOpen = false
						break // never connect/install a closing attempt
					}
					const attempt = s.waiters.get(e.id)
					if (attempt?.pending) {
						attempt.pending = false
						attempt.opened = e.type === "opened"
						attempt.reply(e)
					}
				}
				break
			case "discontinuity": {
				// Capture the exact process/send before log or public event reentry.
				// Public ID/generation alone cannot identify an observed attempt.
				const captured = s.settlement
					? this.deps.settlementObserver?.captureDiscontinuity(
							s.settlement,
							e.id,
							e.generation,
						)
					: undefined
				try {
					// Task 35 counts queue-overflow causes from this line.
					this.log.warn(
						{
							sourceId: s.sourceId,
							channelId: e.id,
							generation: e.generation,
							sampleIndex: e.sampleIndex,
							droppedSamples: e.droppedSamples,
							cause: e.cause,
						},
						"Channel discontinuity",
					)
					this.emit(
						"channel-discontinuity",
						e.id,
						e.generation,
						e.sampleIndex,
						e.droppedSamples,
						e.cause,
					)
				} finally {
					// The SAME owned listener normally publishes this. A prior public
					// listener may throw before it runs; only the captured send may finish.
					if (captured)
						this.deps.settlementObserver?.publishCapturedDiscontinuity(captured)
				}
				break
			}
			case "stats":
				// Task 35 parses this line.
				this.log.info(
					{
						sourceId: s.sourceId,
						generation: e.generation,
						inputSamples: e.inputSamples,
						channels: e.channels,
					},
					"channelizer stats",
				)
				break
			case "closed": {
				s.closing.get(e.id)?.finish()
				const attempt = s.waiters.get(e.id)
				if (attempt?.opened) {
					attempt.closed = true
					attempt.interrupt?.()
				}
				if (e.reason === "client-gone")
					this.channelDied(s, e.id, null, "client-gone")
				break
			}
			case "input-eof":
				s.sawInputEof = true
				this.log.info(
					{ sourceId: s.sourceId, discardedBytes: e.discardedBytes },
					"Channelizer input EOF",
				)
				break
			case "ready":
				break
		}
	}

	private onExit(
		s: SourceChannelizer,
		code: number | null,
		signal: string | null,
	): void {
		if (s.invalidated) return
		const { sourceId, generation } = s
		if (s.sawInputEof && code === 0) {
			// End of a recording: expected, not a crash (ChannelizerProcess reports exit on `close`, after input-eof).
			this.log.info(
				{ sourceId, generation },
				"wavekit-chan finished after input EOF",
			)
			this.invalidate(sourceId, "input-eof")
			return
		}
		const recent = this.recentCrashes(sourceId)
		recent.push(this.now())
		this.log.error(
			{ sourceId, generation, code, signal, recentExits: recent.length },
			"wavekit-chan exited unexpectedly",
		)
		this.invalidate(sourceId, "process-exit")
	}

	/**
	 * Property 10: `channel-invalidated` first and once (listeners detach synchronously), then the sockets and the
	 * decoder-facing streams are destroyed, pending requests are superseded, and the process is stopped. A throwing
	 * listener is logged, never rethrown into the foreign emitter (SourceManager, ChannelizerProcess) that called us,
	 * and never skips the cleanup.
	 */
	private invalidate(sourceId: string, cause: string): void {
		const s = this.active.get(sourceId)
		if (!s || s.invalidated) return
		s.invalidated = true
		this.active.delete(sourceId)
		const ids = [...s.channels.keys()]
		for (const ch of s.channels.values())
			if (ch.settlement)
				this.deps.settlementObserver?.endGrant(ch.settlement, cause)
		try {
			if (ids.length > 0)
				this.emit("channel-invalidated", sourceId, s.generation, ids, cause)
		} catch (err: unknown) {
			this.log.error(
				{ err, sourceId, generation: s.generation },
				"channel-invalidated listener threw",
			)
		}
		for (const ch of s.channels.values()) {
			ch.socket.destroy()
			ch.stream.destroy()
			this.channelOwner.delete(ch.id)
		}
		s.channels.clear()
		for (const wake of [...s.interruptions]) wake()
		this.retire(s, cause)
	}

	/**
	 * A channel that died on its own (the process reports its client gone, or our socket errors) invalidates only
	 * itself, so its decoder is detached and restarted instead of running on a dead stream. `socket` names the
	 * socket that failed: a late error from an earlier socket of a reopened id leaves the new channel alone.
	 */
	private channelDied(
		s: SourceChannelizer,
		channelId: string,
		socket: Readable | null,
		cause: "client-gone" | "socket-error",
	): void {
		const ch = s.channels.get(channelId)
		if (s.invalidated || !ch || (socket && ch.socket !== socket)) return
		if (ch.settlement)
			this.deps.settlementObserver?.endGrant(ch.settlement, cause)
		s.channels.delete(channelId)
		this.channelOwner.delete(channelId)
		this.log.warn(
			{ sourceId: s.sourceId, generation: s.generation, channelId, cause },
			"Channel died; invalidating it",
		)
		try {
			this.emit(
				"channel-invalidated",
				s.sourceId,
				s.generation,
				[channelId],
				cause,
			)
		} catch (err: unknown) {
			this.log.error(
				{ err, sourceId: s.sourceId, generation: s.generation },
				"channel-invalidated listener threw",
			)
		}
		// The process already closed a client-gone channel; a socket error may have left it open there.
		if (cause === "socket-error") void this.closeOwned(s, channelId, false)
		ch.socket.destroy()
		ch.stream.destroy()
		this.stopIfIdle(s, "last-channel-died")
	}

	private clearIdleTimer(s: SourceChannelizer): void {
		if (s.idleTimer === undefined) return
		clearTimeout(s.idleTimer)
		delete s.idleTimer
		delete s.idleCause
	}

	private stopIfIdle(s: SourceChannelizer, cause: string): void {
		if (!s.invalidated && s.channels.size === 0 && s.pending === 0) {
			const idleStopMs = this.deps.idleStopMs ?? 0
			if (
				idleStopMs > 0 &&
				(cause === "last-channel-released" ||
					cause === "last-channel-died" ||
					cause === "no-channels")
			) {
				if (s.idleTimer === undefined) {
					s.idleCause = cause
					s.idleTimer = setTimeout(() => {
						delete s.idleTimer
						delete s.idleCause
						this.stopIfIdle(s, "idle-timeout")
					}, idleStopMs)
					s.idleTimer.unref()
				}
				return
			}
			if (this.active.get(s.sourceId) === s) this.active.delete(s.sourceId)
			this.retire(s, cause)
		}
	}

	/** Synchronous on purpose (called from event listeners); `destroy()` awaits the tracked stop. */
	private retire(s: SourceChannelizer, cause: string): void {
		this.clearIdleTimer(s)
		s.invalidated = true
		for (const wake of [...s.interruptions]) wake()
		for (const closing of [...s.closing.values()]) closing.finish()
		s.detachFanout()
		s.fanout.removeBranch(s.branchId)
		this.deps.routing.releaseUnused(s.sourceId)
		this.stopProcess(s.process, s.dir)
		this.log.info(
			{ sourceId: s.sourceId, generation: s.generation, cause },
			"Channelizer torn down",
		)
	}

	private stopProcess(proc: ChannelizerProcessLike, dir: string): void {
		const settlement = this.processClaims.get(proc)
		settlement?.sealStartup()
		const nativeStop = proc
			.stop()
			.catch((err: unknown) =>
				this.log.warn({ err, dir }, "Channelizer stop failed"),
			)
		// These attempts have independent owners. A held child/server close
		// must not prevent the sibling transport/pathname attempt from starting.
		const localCleanup = proc
			.attemptSettlementCleanup?.()
			.catch((err: unknown) =>
				this.log.warn({ err }, "Channelizer local cleanup failed"),
			)
		const directoryCleanup = async () => {
			if (settlement) {
				if (!proc.waitSettlementNativeRetirement) {
					this.directoryClaims.get(proc)?.settle({
						ok: false,
						state: "unknown",
						detail: "channel native retirement proof unavailable",
					})
					return
				}
				await proc.waitSettlementNativeRetirement()
			} else await nativeStop
			// Unlike the proof endpoint, native code may still create files here.
			// Reclaim this directory only after its exact native dependency settles.
			try {
				rmSync(dir, { recursive: true, force: true })
				this.directoryClaims.get(proc)?.settle({ ok: true })
			} catch (err: unknown) {
				this.directoryClaims.get(proc)?.settle({
					ok: false,
					state: "failed",
					detail: "channel directory cleanup failed",
				})
				this.log.debug({ err, dir }, "Cannot remove channel socket dir")
			}
		}
		const stop = Promise.allSettled([
			nativeStop,
			localCleanup,
			directoryCleanup(),
		]).then(() => {
			this.stops.delete(stop)
		})
		this.stops.add(stop)
	}

	private capsDiffer(s: SourceChannelizer, caps: SourceCaps): boolean {
		return (
			!isCu8Iq(caps) ||
			s.caps.sampleRate !== caps.sampleRate ||
			(caps.centerFreq !== undefined && s.caps.centerHz !== caps.centerFreq)
		)
	}

	/** channelQueueMs of output samples, within the process's 1 sample..=MAX_QUEUE_BYTES; a detail string when not. */
	private queueBytes(req: DecoderChannelRequest): number | string {
		const { channelQueueMs } = this.deps.config
		const sampleBytes = SAMPLE_BYTES[req.format]
		const bytes =
			Math.ceil((channelQueueMs / 1000) * req.outputRateHz) * sampleBytes
		if (
			!Number.isSafeInteger(bytes) ||
			bytes < sampleBytes ||
			bytes > MAX_QUEUE_BYTES
		)
			return `queueBytes ${bytes} (${channelQueueMs} ms at ${req.outputRateHz} Hz ${req.format}) outside ${sampleBytes}..=${MAX_QUEUE_BYTES}`
		return bytes
	}

	private recentCrashes(sourceId: string): number[] {
		const now = this.now()
		const recent = (this.crashes.get(sourceId) ?? []).filter(
			t => now - t < CRASH_WINDOW_MS,
		)
		this.crashes.set(sourceId, recent)
		return recent
	}

	/** Null when a spawn is allowed; otherwise the channelizer-unavailable detail (crash-loop backoff, A14). */
	private crashLoopHold(sourceId: string): string | null {
		const recent = this.recentCrashes(sourceId)
		if (recent.length < CRASH_LIMIT) return null
		const until = new Date(
			(recent[0] ?? this.now()) + CRASH_WINDOW_MS,
		).toISOString()
		return `wavekit-chan exited unexpectedly ${recent.length} times in ${CRASH_WINDOW_MS / 1000} s; not respawning before ${until}`
	}
}

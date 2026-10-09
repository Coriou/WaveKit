import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { mkdirSync, rmSync } from "node:fs"
import { createConnection } from "node:net"
import { join } from "node:path"
import { PassThrough, type Readable } from "node:stream"
import { pipeline } from "node:stream/promises"
import type { ChannelizerConfig, SourceCaps } from "../../config.js"
import type { FanoutManager } from "../fanout-manager.js"
import type { SourceFanoutRouter } from "../source-fanout-router.js"
import type { SourceManager } from "../source-manager.js"
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

/** Longest socket path we hand the process; macOS caps `sun_path` at ~104 bytes (Review Focus 2). */
export const MAX_SOCKET_PATH = 100
/** Crash-loop backoff (plan A14): this many unexpected exits after `ready` within the window hold respawns. */
export const CRASH_LIMIT = 5
export const CRASH_WINDOW_MS = 60_000
const OPEN_TIMEOUT_MS = 5000
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
	connect?: (socketPath: string) => Promise<Readable>
	/** Injectable clock for the crash-loop window (tests). */
	now?: () => number
	/** How long a request waits for `opened`/`rejected` (default 5 s; tests). */
	openTimeoutMs?: number
}

/** `socket` is the process's Unix socket; `stream` is what the decoder gets (fed with end: false). */
interface OpenChannel {
	id: string
	socket: Readable
	stream: PassThrough
}
type OpenRequest = Extract<ChannelizerRequest, { type: "open" }>
type OpenReply = OpenedEvent | RejectedEvent | "superseded" | null
interface SourceChannelizer {
	sourceId: string
	generation: number
	caps: { sampleRate: number; centerHz: number }
	process: ChannelizerProcessLike
	dir: string
	fanout: FanoutManager
	branchId: string
	channels: Map<string, OpenChannel>
	waiters: Map<string, (e: OpenReply) => void>
	/** Requests between `open` and attaching (or failing); the process is not idle while any is in flight. */
	pending: number
	gapAtByte: number | null
	droppedAtGap: number
	invalidated: boolean
	sawInputEof: boolean
	detachFanout: () => void
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

function defaultConnect(path: string): Promise<Readable> {
	return new Promise((resolve, reject) => {
		const socket = createConnection(path)
		socket.once("error", reject)
		socket.once("connect", () => {
			socket.off("error", reject)
			resolve(socket)
		})
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
	private readonly createProcess: NonNullable<
		ChannelizerManagerDeps["createProcess"]
	>
	private readonly connect: NonNullable<ChannelizerManagerDeps["connect"]>
	private readonly now: () => number
	private readonly openTimeoutMs: number
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
	): Promise<ChannelRequestResult> {
		// Serialised per source: one spawn for concurrent requests, and generations never interleave.
		const run = () => this.request(sourceId, decoderId, req, inputCaps)
		const next = (this.queues.get(sourceId) ?? Promise.resolve()).then(run, run)
		this.queues.set(
			sourceId,
			next.catch(() => undefined),
		)
		return next
	}

	releaseChannel(channelId: string): Promise<void> {
		const sourceId = this.channelOwner.get(channelId)
		if (sourceId === undefined) return Promise.resolve()
		this.channelOwner.delete(channelId)
		const s = this.active.get(sourceId)
		const ch = s?.channels.get(channelId)
		if (!s || !ch) return Promise.resolve()
		s.channels.delete(channelId)
		s.process.send({ v: 1, type: "close", id: channelId })
		ch.socket.destroy()
		ch.stream.destroy()
		this.stopIfIdle(s, "last-channel-released")
		return Promise.resolve()
	}

	async destroy(): Promise<void> {
		this.destroyed = true
		this.deps.sourceManager.off("caps-changed", this.onCaps)
		this.deps.sourceManager.off("disconnected", this.onGone)
		this.deps.sourceManager.off("removed", this.onGone)
		for (const sourceId of [...this.active.keys()])
			this.invalidate(sourceId, "destroy")
		// In-flight requests settle (a pending one is superseded, then refused); a spawn that was mid-start retires itself.
		await Promise.all(this.queues.values())
		while (this.stops.size > 0) await Promise.all(this.stops)
	}

	private async request(
		sourceId: string,
		decoderId: string,
		req: DecoderChannelRequest,
		inputCaps: SourceCaps | undefined,
		retried = false,
	): Promise<ChannelRequestResult> {
		if (this.destroyed) return unavailable("channelizer manager destroyed")
		const caps = this.deps.sourceManager.getCaps(sourceId)
		if (!caps || caps.kind !== "iq" || caps.format !== "U8_IQ")
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
		const superseded = (): Promise<ChannelRequestResult> =>
			retried
				? Promise.resolve(unavailable("generation superseded twice"))
				: this.request(sourceId, decoderId, req, inputCaps, true)
		if (!s) {
			const held = this.crashLoopHold(sourceId)
			if (held) return unavailable(held)
			const losses = this.losses.get(sourceId) ?? 0
			const spawned = await this.spawn(
				sourceId,
				{ sampleRate: caps.sampleRate, centerHz },
				generation,
				dir,
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
		return this.open(s, open, superseded)
	}

	private async open(
		s: SourceChannelizer,
		open: OpenRequest,
		superseded: () => Promise<ChannelRequestResult>,
	): Promise<ChannelRequestResult> {
		const channelId = open.id
		s.pending++
		try {
			const reply = new Promise<OpenReply>(resolve => {
				const timer = setTimeout(() => resolve(null), this.openTimeoutMs)
				s.waiters.set(channelId, e => {
					clearTimeout(timer)
					resolve(e)
				})
			})
			s.process.send(open)
			const event = await reply
			s.waiters.delete(channelId)
			// Source invalidated while this request was pending: retry once against the new state, like a superseded generation.
			if (event === "superseded") return await superseded()
			if (event === null) {
				s.process.send({ v: 1, type: "close", id: channelId })
				return unavailable(`no opened/rejected within ${this.openTimeoutMs} ms`)
			}
			if (event.type === "rejected")
				return { ok: false, reasonCode: event.reasonCode, detail: event.detail }
			// Property 9: never attach a stream from a generation other than the current one.
			if (
				s.invalidated ||
				event.generation !== this.currentGeneration(s.sourceId)
			)
				return await superseded()
			let socket: Readable
			try {
				socket = await this.connect(event.socket)
			} catch (err: unknown) {
				if (s.invalidated) return await superseded()
				s.process.send({ v: 1, type: "close", id: channelId })
				return unavailable(`connect ${event.socket}: ${message(err)}`)
			}
			socket.on("error", (err: Error) =>
				this.log.debug({ err, channelId }, "Channel socket error"),
			)
			if (s.invalidated) {
				socket.destroy()
				return await superseded()
			}
			// end: false: the socket's EOF (process death) must never end the decoder's stdin; only detach/destroy does.
			// pipeline() cannot express that, so both streams carry their own error handler.
			const stream = new PassThrough()
			stream.on("error", (err: Error) =>
				this.log.debug({ err, channelId }, "Channel stream error"),
			)
			socket.pipe(stream, { end: false })
			s.channels.set(channelId, { id: channelId, socket, stream })
			this.channelOwner.set(channelId, s.sourceId)
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
			s.pending--
			this.stopIfIdle(s, "no-channels")
		}
	}

	private async spawn(
		sourceId: string,
		caps: { sampleRate: number; centerHz: number },
		generation: number,
		dir: string,
	): Promise<SourceChannelizer | { error: string }> {
		try {
			// A fresh, private directory per generation: stale sockets from an earlier run never linger.
			rmSync(dir, { recursive: true, force: true })
			mkdirSync(dir, { recursive: true, mode: 0o700 })
		} catch (err: unknown) {
			// e.g. EACCES on the default /var/run/wavekit/chan outside the image: a suspension, never a crash.
			this.log.warn({ err, sourceId, dir }, "Cannot create channel socket dir")
			return { error: `socket dir ${dir}: ${message(err)}` }
		}
		this.generations.set(sourceId, generation)
		const proc = this.createProcess(
			{
				binaryPath: this.deps.config.binaryPath,
				generation,
				inputRateHz: caps.sampleRate,
				inputCenterHz: caps.centerHz,
				usableFraction: this.deps.config.usableFraction,
				blockSamples: this.deps.config.blockSamples,
				socketDir: dir,
			},
			this.deps.logger,
		)
		let readyGeneration: number | undefined
		const onReady = (e: ChannelizerEvent) => {
			if (e.type === "ready") readyGeneration = e.generation
		}
		proc.on("event", onReady)
		try {
			await proc.start()
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
			pending: 0,
			gapAtByte: null,
			droppedAtGap: 0,
			invalidated: false,
			sawInputEof: false,
			detachFanout: () => {
				fanout.off("backpressure", onBackpressure)
				fanout.off("drain", onDrain)
			},
		}
		const branch = fanout.addBranch({
			id: branchId,
			sourceId,
			highWaterMark: this.deps.config.inputHighWaterMark,
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
				s.waiters.get(e.id)?.(e)
				break
			case "discontinuity":
				this.emit(
					"channel-discontinuity",
					e.id,
					e.generation,
					e.sampleIndex,
					e.droppedSamples,
					e.cause,
				)
				break
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
			case "closed":
				if (e.reason === "client-gone")
					this.log.info({ channelId: e.id }, "Channel client gone")
				break
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
		try {
			if (ids.length > 0)
				this.emit("channel-invalidated", sourceId, s.generation, ids)
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
		for (const w of s.waiters.values()) w("superseded")
		this.retire(s, cause)
	}

	private stopIfIdle(s: SourceChannelizer, cause: string): void {
		if (!s.invalidated && s.channels.size === 0 && s.pending === 0) {
			if (this.active.get(s.sourceId) === s) this.active.delete(s.sourceId)
			this.retire(s, cause)
		}
	}

	/** Synchronous on purpose (called from event listeners); `destroy()` awaits the tracked stop. */
	private retire(s: SourceChannelizer, cause: string): void {
		s.invalidated = true
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
		const stop = proc
			.stop()
			.catch((err: unknown) =>
				this.log.warn({ err, dir }, "Channelizer stop failed"),
			)
			.finally(() => {
				try {
					rmSync(dir, { recursive: true, force: true })
				} catch (err: unknown) {
					this.log.debug({ err, dir }, "Cannot remove channel socket dir")
				}
				this.stops.delete(stop)
			})
		this.stops.add(stop)
	}

	private capsDiffer(s: SourceChannelizer, caps: SourceCaps): boolean {
		return (
			caps.kind !== "iq" ||
			caps.format !== "U8_IQ" ||
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

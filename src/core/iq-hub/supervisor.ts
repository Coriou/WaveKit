/**
 * The Node side of hub intake: one Supervisor per hub-mode source owns one `wavekit-iqhub` process
 * and dials each SourceManager attempt through it (the rows S1-S19 of the RX-S3 design). The
 * socket SourceManager holds is a real `net.Socket` connected to the attempt's front sink over a
 * Unix socket; the front replays the rtl_tcp header, delivers the stream with counted gaps and
 * forwards the bytes Node writes upstream in order. The supervisor follows the hub's ordered event
 * stream only and never sends a request that depends on a state it has not seen.
 *
 * Errors the hub itself causes carry IQHUB_* codes (IQHUB_UNAVAILABLE, IQHUB_REJECTED,
 * IQHUB_EXITED, IQHUB_HUNG, IQHUB_FRONT_CLOSED): SourceManager keeps them out of the receiver's
 * connect-failure record and its endpoint fallback. A closed upstream attempt maps to the code a `net` connect would give.
 *
 * Exact command positions (`front-placed`) are surfaced to a hook only: SourceManager does not use
 * them yet, which is why hub intake is not selectable by the environment (intake-mode.ts).
 */
import * as net from "node:net"
import type { Socket } from "node:net"
import type { SourceConfig } from "../../config.js"
import { WaveKitError } from "../../utils/errors.js"
import type { Logger } from "../../utils/logger.js"
import { FrontAccounting } from "./front-accounting.js"
import type { HubExit, HubProcess, HubProcessFactory } from "./hub-process.js"
import { HungWatchdog } from "./hung-watchdog.js"
import type { HungWatchdogOptions } from "./hung-watchdog.js"
import { HUB_FRONT_TAG, hubEligibleHost, hubEligibleSource } from "./intake.js"
import type { SourceIntake } from "./intake.js"
import {
	HUB_REQUIRED_FEATURES,
	encodeHubRequest,
	hubCloseCode,
	hubHello,
	hubRcvBufBytes,
	parseHubEvent,
} from "./protocol.js"
import type {
	HubCloseReason,
	HubEvent,
	HubEventOf,
	HubFrontPlaced,
	HubRequest,
	HubSinkGap,
} from "./protocol.js"

/** Ring length in signal time: twice the front's maximum lag. */
export const HUB_RING_MS = 12_000
export const HUB_FRONT_MAX_LAG_MS = 6000
export const HUB_FRONT_RESUME_MS = 250
export const HUB_READY_TIMEOUT_MS = 5000
/** SourceManager's own connect deadline (5 s) fires first; the hub's bounds the orphan. */
export const HUB_CONNECT_TIMEOUT_MS = 5000 + 2000
export const HUB_KEEPALIVE_MS = 5000
export const HUB_HEADER_BYTES = 12
/** M6/S14: how long one side of a front's end waits for the other. */
export const HUB_END_WAIT_MS = 2000
/** S15: a closed Node socket whose attempt is still live after this is aborted. */
export const HUB_ABORT_AFTER_CLOSE_MS = 3000
export const HUB_SHUTDOWN_WAIT_MS = 2000
/** m3: a rate change waits this long for older fronted attempts to close. */
export const HUB_CONFIGURE_WAIT_MS = 2000
/** A paused Node socket delays its `end` at most this long in all, then it is destroyed. */
export const HUB_PAUSED_END_CAP_MS = 15_000

/** Error codes of failures the hub (not the receiver) caused. */
export const IQHUB_UNAVAILABLE = "IQHUB_UNAVAILABLE"
export const IQHUB_REJECTED = "IQHUB_REJECTED"
export const IQHUB_EXITED = "IQHUB_EXITED"
export const IQHUB_HUNG = "IQHUB_HUNG"
/**
 * The hub closed or refused a front itself (`sink-rejected`, `sink-closed` with reason `request`
 * or `reconfigured`). Deviation from spec row S8, which maps these to ECONNRESET: the receiver did
 * nothing wrong, so they carry an IQHUB_* code and stay out of connectFailure and endpoint fallback.
 */
export const IQHUB_FRONT_CLOSED = "IQHUB_FRONT_CLOSED"

const DESTROY_REASONS: ReadonlySet<string> = new Set([
	"reset",
	"error",
	"unreachable",
	"timeout",
])

/** The synthetic refusal a pending answer gets when its hub is gone. */
const GONE = "gone"

const SAFE_REASON = /^[a-z][a-z-]{0,31}$/

function safeReason(reason: string): string {
	return SAFE_REASON.test(reason) ? reason : "unknown"
}

/**
 * M1: after a main-thread stall the timers phase runs before the poll phase reads an event line
 * already waiting, so a deadline only acts once a `setImmediate` (the check phase, after poll) has
 * let that line in; the callback re-checks whether its event arrived.
 */
function afterPoll(fn: () => void): void {
	setImmediate(fn)
}

function hubError(message: string, code: string): WaveKitError {
	return new WaveKitError(message, code)
}

type EndDecision =
	| { kind: "end" }
	| { kind: "destroy"; code: string; message: string }

interface Dial {
	readonly socket: Socket
	readonly host: string
	readonly port: number
	readonly byteRate: number
	attempt: number | null
	sink: string | null
	connectSent: boolean
	sinkReady: boolean
	tcpConnected: boolean
	unixStarted: boolean
	started: boolean
	localPort: number | null
	headerHex: string | null
	stream: number | null
	attemptClosed: HubEventOf<"closed"> | null
	frontEnded: HubEventOf<"front-ended"> | null
	decision: EndDecision | null
	nodeEnded: boolean
	nodeClosed: boolean
	failed: boolean
	retried: boolean
	endTimer: ReturnType<typeof setTimeout> | null
	/** When the end wait first armed (the paused-socket cap counts from it). */
	endWaitStartedAt: number | null
	abortTimer: ReturnType<typeof setTimeout> | null
	readonly accounting: FrontAccounting
}

interface Hub {
	readonly generation: number
	proc: HubProcess | null
	/** Settles once the factory resolved or failed (never rejects). */
	spawned: Promise<void>
	ready: Promise<HubEventOf<"ready">>
	sinkSocket: string | null
	byteRate: number | null
	configuring: { byteRate: number; done: Promise<void> } | null
	readonly watchdog: HungWatchdog
	readyEvent: HubEventOf<"ready"> | null
	gone: boolean
	exited: boolean
	hung: boolean
	/** Woken when the process exited (onExit). */
	exitWaiters: (() => void)[]
	readonly answers: Map<number, (event: HubEvent) => void>
}

export interface SupervisorHooks {
	/** R3: a front's commands reached their exact Node position. */
	onFrontPlaced?: (socket: Socket, event: HubFrontPlaced) => void
	/** A front skipped whole frames (start or lag): counted loss. */
	onIntakeGap?: (socket: Socket, event: HubSinkGap) => void
	/** The Node socket of a dial closed (R3 resolves its pending placements null). */
	onDialClosed?: (socket: Socket) => void
}

export interface SupervisorOptions extends SupervisorHooks {
	sourceId: string
	logger: Logger
	factory: HubProcessFactory
	statsFile?: string | undefined
	readyTimeoutMs?: number
	endWaitMs?: number
	abortAfterCloseMs?: number
	shutdownWaitMs?: number
	configureWaitMs?: number
	pausedEndCapMs?: number
	/** Monotonic clock in ms (tests). */
	now?: () => number
	watchdog?: Omit<HungWatchdogOptions, "onHung">
}

/** One hub per source; one Dial per SourceManager attempt. */
export class Supervisor {
	private readonly log: Logger
	private readonly options: SupervisorOptions
	private hub: Hub | null = null
	private generation = 0
	private lastAttempt = 0
	private lastSeq = 0
	private disposed = false
	/** Hubs whose process has not exited yet (dispose waits for each). */
	private readonly live = new Set<Hub>()
	private readonly now: () => number
	private readonly dials = new Set<Dial>()
	private readonly byAttempt = new Map<number, Dial>()
	private readonly bySink = new Map<string, Dial>()
	private readonly bySocket = new WeakMap<Socket, Dial>()
	private readonly attemptClosedWaiters: (() => void)[] = []
	/** Lines that were not a valid event (never logged themselves). */
	invalidLines = 0

	constructor(options: SupervisorOptions) {
		this.options = options
		this.now = options.now ?? (() => performance.now())
		this.log = options.logger.child({
			component: "IqHubSupervisor",
			sourceId: options.sourceId,
		})
	}

	/** The hub's pid, or null while none runs (tests and diagnostics). */
	get pid(): number | null {
		return this.hub?.proc?.pid ?? null
	}

	/** The upstream TCP local port of a dialled socket, once the hub reported it. */
	localPortOf(socket: Socket): number | null {
		return this.bySocket.get(socket)?.localPort ?? null
	}

	/** The accounting of a dialled socket's front (tests, R3). */
	accountingOf(socket: Socket): FrontAccounting | null {
		return this.bySocket.get(socket)?.accounting ?? null
	}

	/** Dials an attempt: S1 (spawn), S3 (configure), S4 (connect and front). */
	dial(socket: Socket, config: SourceConfig, host: string, port: number): void {
		const dial: Dial = {
			socket,
			host,
			port,
			byteRate: config.caps.sampleRate * 2,
			attempt: null,
			sink: null,
			connectSent: false,
			sinkReady: false,
			tcpConnected: false,
			unixStarted: false,
			started: false,
			localPort: null,
			headerHex: null,
			stream: null,
			attemptClosed: null,
			frontEnded: null,
			decision: null,
			nodeEnded: false,
			nodeClosed: false,
			failed: false,
			retried: false,
			endTimer: null,
			endWaitStartedAt: null,
			abortTimer: null,
			accounting: new FrontAccounting(),
		}
		this.dials.add(dial)
		this.bySocket.set(socket, dial)
		socket.once("close", () => this.onNodeClose(dial))
		socket.on("end", () => this.onNodeEnd(dial))
		if (this.disposed) {
			this.fail(dial, IQHUB_UNAVAILABLE, "IQ hub intake is shut down")
			return
		}
		void this.start(dial).catch((err: unknown) => {
			const code =
				err instanceof WaveKitError && err.code.startsWith("IQHUB_")
					? err.code
					: IQHUB_UNAVAILABLE
			const message =
				err instanceof WaveKitError && err.code.startsWith("IQHUB_")
					? err.message
					: "IQ hub is unavailable"
			this.fail(dial, code, message)
		})
	}

	private cancelled(dial: Dial): boolean {
		return dial.nodeClosed || dial.socket.destroyed || dial.failed
	}

	private async start(dial: Dial): Promise<void> {
		const hub = this.ensureHub()
		const ready = await hub.ready
		if (this.cancelled(dial) || hub.gone) {
			if (hub.gone && !this.cancelled(dial)) this.failGone(dial, hub)
			return
		}
		await this.waitOlderFrontsBeforeConfigure(hub, dial)
		if (this.cancelled(dial)) return
		await this.ensureConfigured(hub, dial.byteRate)
		if (this.cancelled(dial)) return
		if (hub.gone) {
			this.failGone(dial, hub)
			return
		}
		this.sendConnect(hub, dial, ready)
	}

	// S1: spawn, wait for `ready`, check its features.
	private ensureHub(): Hub {
		if (this.hub && !this.hub.gone) return this.hub
		const generation = ++this.generation
		let resolveReady: (event: HubEventOf<"ready">) => void = () => {}
		let rejectReady: (err: Error) => void = () => {}
		const ready = new Promise<HubEventOf<"ready">>((resolve, reject) => {
			resolveReady = resolve
			rejectReady = reject
		})
		// Every dial awaits it; a rejection nobody awaits must not surface.
		ready.catch(() => {})
		const hub: Hub = {
			generation,
			proc: null,
			spawned: Promise.resolve(),
			ready,
			sinkSocket: null,
			byteRate: null,
			configuring: null,
			watchdog: new HungWatchdog({
				...this.options.watchdog,
				onHung: () => this.onHung(hub),
			}),
			readyEvent: null,
			gone: false,
			exited: false,
			hung: false,
			exitWaiters: [],
			answers: new Map(),
		}
		this.hub = hub
		this.live.add(hub)
		let settled = false
		const readyTimer = setTimeout(
			() =>
				afterPoll(() => {
					if (settled) return
					settled = true
					this.log.warn(
						{ timeoutMs: this.options.readyTimeoutMs ?? HUB_READY_TIMEOUT_MS },
						"IQ hub did not report ready in time",
					)
					rejectReady(
						hubError("IQ hub did not start in time", IQHUB_UNAVAILABLE),
					)
					hub.proc?.kill("SIGKILL")
					if (!hub.proc) this.markGone(hub)
				}),
			this.options.readyTimeoutMs ?? HUB_READY_TIMEOUT_MS,
		)
		readyTimer.unref()
		const onReady = (event: HubEventOf<"ready">) => {
			if (settled) return
			settled = true
			clearTimeout(readyTimer)
			const missing = HUB_REQUIRED_FEATURES.filter(
				feature => !event.features.includes(feature),
			)
			if (missing.length > 0) {
				this.log.error({ missing }, "IQ hub lacks required features")
				rejectReady(
					hubError("IQ hub lacks required features", IQHUB_UNAVAILABLE),
				)
				hub.proc?.kill("SIGKILL")
				return
			}
			hub.sinkSocket = event.sinkSocket
			hub.readyEvent = event
			resolveReady(event)
		}
		const failReady = (message: string) => {
			if (settled) return
			settled = true
			clearTimeout(readyTimer)
			rejectReady(hubError(message, IQHUB_UNAVAILABLE))
		}
		hub.spawned = this.options
			.factory(
				{
					sourceId: this.options.sourceId,
					ringMs: HUB_RING_MS,
					statsFile: this.options.statsFile,
				},
				{
					onLine: line => this.onLine(hub, line, onReady),
					onExit: exit => {
						failReady("IQ hub exited before it was ready")
						this.onExit(hub, exit)
					},
				},
			)
			.then(proc => {
				hub.proc = proc
				if (hub.exited) {
					void proc.removeSocketDir().catch(() => {})
					return
				}
				if (hub.gone || this.disposed) {
					proc.kill("SIGKILL")
					return
				}
				this.log.info({ pid: proc.pid }, "IQ hub started")
			})
			.catch((err: unknown) => {
				const code =
					err instanceof WaveKitError ? err.code : "IQHUB_SPAWN_FAILED"
				this.log.error({ code }, "IQ hub could not be started")
				failReady("IQ hub could not be started")
				this.live.delete(hub)
				this.markGone(hub)
			})
		return hub
	}

	private send(
		hub: Hub,
		request: HubRequest,
		answer?: (event: HubEvent) => void,
	): number {
		const seq = ++this.lastSeq
		if (answer) hub.answers.set(seq, answer)
		const sent = hub.proc?.send(encodeHubRequest(request, seq)) ?? false
		if (!sent) hub.answers.delete(seq)
		return sent ? seq : -1
	}

	// m3: a rate change closes every other front (F15); give older fronted attempts their grace.
	private async waitOlderFrontsBeforeConfigure(
		hub: Hub,
		dial: Dial,
	): Promise<void> {
		if (hub.byteRate === null || hub.byteRate === dial.byteRate) return
		const deadline =
			Date.now() + (this.options.configureWaitMs ?? HUB_CONFIGURE_WAIT_MS)
		while (
			[...this.dials].some(
				other =>
					other !== dial &&
					other.connectSent &&
					other.attemptClosed === null &&
					!hub.gone,
			) &&
			Date.now() < deadline &&
			!this.cancelled(dial)
		) {
			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, Math.max(1, deadline - Date.now()))
				timer.unref()
				this.attemptClosedWaiters.push(() => {
					clearTimeout(timer)
					resolve()
				})
			})
		}
	}

	// S3: configure the ring for the attempt's rate (the first dial, or a rate change).
	private async ensureConfigured(hub: Hub, byteRate: number): Promise<void> {
		while (hub.byteRate !== byteRate) {
			if (hub.gone) return
			if (hub.configuring && hub.configuring.byteRate === byteRate) {
				await hub.configuring.done
				continue
			}
			if (hub.configuring) {
				await hub.configuring.done.catch(() => {})
				continue
			}
			const done = new Promise<void>((resolve, reject) => {
				let answered = false
				const timer = setTimeout(
					() =>
						afterPoll(() => {
							if (answered) return
							answered = true
							reject(hubError("IQ hub did not answer configure", IQHUB_HUNG))
							this.onHung(hub)
						}),
					this.options.readyTimeoutMs ?? HUB_READY_TIMEOUT_MS,
				)
				timer.unref()
				const seq = this.send(
					hub,
					{
						type: "configure",
						byteRate,
						frameBytes: 2,
						levelFormat: null,
						progressMs: 100,
						linkGapMs: 200,
					},
					event => {
						if (answered) return
						answered = true
						clearTimeout(timer)
						if (event.type === "configured") {
							hub.byteRate = byteRate
							hub.watchdog.start()
							resolve()
						} else if (event.type === "rejected" && event.reason === GONE) {
							reject(this.goneError(hub))
						} else {
							this.log.warn(
								{
									reason:
										event.type === "rejected"
											? safeReason(event.reason)
											: "gone",
								},
								"IQ hub refused configure",
							)
							reject(hubError("IQ hub refused the source rate", IQHUB_REJECTED))
						}
					},
				)
				if (seq < 0) {
					answered = true
					clearTimeout(timer)
					reject(hubError("IQ hub control pipe is closed", IQHUB_EXITED))
				}
			})
			hub.configuring = { byteRate, done }
			try {
				await done
			} finally {
				if (hub.configuring?.done === done) hub.configuring = null
			}
		}
	}

	// S4: connect the attempt and declare its front.
	private sendConnect(hub: Hub, dial: Dial, ready: HubEventOf<"ready">): void {
		if (hub.gone) {
			this.failGone(dial, hub)
			return
		}
		const attempt = ++this.lastAttempt
		const sink = `front-${attempt}`
		if (dial.attempt !== null) this.byAttempt.delete(dial.attempt)
		if (dial.sink !== null) this.bySink.delete(dial.sink)
		dial.attempt = attempt
		dial.sink = sink
		dial.sinkReady = false
		this.byAttempt.set(attempt, dial)
		this.bySink.set(sink, dial)
		dial.connectSent = true
		const rcvBuf = ready.features.includes("rcvbuf")
			? { rcvBufBytes: hubRcvBufBytes(dial.byteRate) }
			: {}
		const connectSeq = this.send(
			hub,
			{
				type: "connect",
				attempt,
				host: dial.host,
				port: dial.port,
				timeoutMs: HUB_CONNECT_TIMEOUT_MS,
				headerBytes: HUB_HEADER_BYTES,
				keepAliveMs: HUB_KEEPALIVE_MS,
				...rcvBuf,
			},
			event => {
				if (event.type === "rejected")
					this.onConnectRejected(hub, dial, attempt, event)
			},
		)
		if (connectSeq < 0) {
			this.failGone(dial, hub)
			return
		}
		this.send(
			hub,
			{
				type: "sink-open",
				sink,
				kind: "front",
				attempt,
				maxLagMs: HUB_FRONT_MAX_LAG_MS,
				resumeMs: HUB_FRONT_RESUME_MS,
			},
			event => {
				if (dial.attempt !== attempt) return
				if (event.type === "rejected" && event.reason === GONE) {
					this.failGone(dial, hub)
				} else if (event.type === "sink-ready") {
					dial.sinkReady = true
					this.maybeStartUnix(hub, dial)
				} else if (event.type === "rejected") {
					this.log.warn(
						{ reason: safeReason(event.reason) },
						"IQ hub refused the front sink",
					)
					this.fail(dial, IQHUB_REJECTED, "IQ hub refused the front sink")
					this.abortNow(hub, attempt)
				}
			},
		)
	}

	// S17: a refused connect.
	private onConnectRejected(
		hub: Hub,
		dial: Dial,
		attempt: number,
		event: HubEventOf<"rejected">,
	): void {
		if (dial.attempt !== attempt || this.cancelled(dial)) return
		if (event.reason === GONE) {
			this.failGone(dial, hub)
			return
		}
		const ready = hub.readyEvent
		if (event.reason === "too-many-attempts" && !dial.retried && ready) {
			dial.retried = true
			for (const other of this.dials)
				if (
					other !== dial &&
					other.attempt !== null &&
					other.attemptClosed === null
				)
					this.abortNow(hub, other.attempt)
			// Synchronously, before the next line: the refused connect used no id, and its
			// sink-open (refused unknown-attempt) is ignored once the dial has a new attempt id.
			this.sendConnect(hub, dial, ready)
			return
		}
		this.log.warn(
			{ reason: safeReason(event.reason) },
			"IQ hub refused the connect",
		)
		this.fail(dial, IQHUB_REJECTED, "IQ hub refused the connect")
	}

	// S6 (and M9): connect the Unix socket once the front is declared and TCP is up.
	private maybeStartUnix(hub: Hub, dial: Dial): void {
		if (!dial.sinkReady || !dial.tcpConnected || dial.unixStarted) return
		if (dial.attempt === null || dial.sink === null) return
		if (this.cancelled(dial)) {
			this.abortNow(hub, dial.attempt)
			return
		}
		const path = hub.sinkSocket
		if (path === null) return
		dial.unixStarted = true
		dial.socket.connect({ path })
		dial.socket.write(hubHello(dial.sink))
	}

	private abortNow(hub: Hub, attempt: number): void {
		if (hub.gone) return
		this.send(hub, { type: "abort", attempt, mode: "now" }, () => {})
	}

	private onLine(
		hub: Hub,
		line: string,
		onReady: (event: HubEventOf<"ready">) => void,
	): void {
		hub.watchdog.noteEvent()
		const event = parseHubEvent(line)
		if (event === null) {
			this.invalidLines += 1
			if (this.invalidLines === 1 || this.invalidLines % 1000 === 0)
				this.log.warn(
					{ invalidLines: this.invalidLines },
					"IQ hub sent an invalid event line",
				)
			return
		}
		if (hub !== this.hub) return
		this.onEvent(hub, event, onReady)
		this.sweepClosedSockets()
	}

	private onEvent(
		hub: Hub,
		event: HubEvent,
		onReady: (event: HubEventOf<"ready">) => void,
	): void {
		switch (event.type) {
			case "ready":
				onReady(event)
				return
			case "rejected":
			case "configured":
			case "sink-ready": {
				const answer =
					event.seq !== undefined ? hub.answers.get(event.seq) : undefined
				if (event.seq !== undefined) hub.answers.delete(event.seq)
				answer?.(event)
				return
			}
			case "tcp-connected": {
				const dial = this.byAttempt.get(event.attempt)
				if (event.seq !== undefined) hub.answers.delete(event.seq)
				if (!dial) return
				dial.tcpConnected = true
				dial.localPort = event.localPort > 0 ? event.localPort : null
				this.maybeStartUnix(hub, dial)
				return
			}
			case "connected": {
				const dial = this.byAttempt.get(event.attempt)
				if (dial) dial.headerHex = event.headerHex
				return
			}
			case "adopted": {
				const dial = this.byAttempt.get(event.attempt)
				if (dial) dial.stream = event.stream
				return
			}
			case "closed":
				this.onAttemptClosed(hub, event)
				return
			case "sink-started": {
				const dial = this.bySink.get(event.sink)
				if (!dial) return
				dial.started = true
				dial.accounting.noteStarted(event.startSourcePos)
				return
			}
			case "sink-gap": {
				const dial = this.bySink.get(event.sink)
				if (!dial) return
				dial.accounting.noteGap(event)
				this.log.info(
					{
						cause: event.cause,
						atSinkByte: event.atSinkByte,
						atSourcePos: event.atSourcePos,
						droppedBytes: event.droppedBytes,
					},
					"IQ hub front skipped samples (counted loss)",
				)
				this.options.onIntakeGap?.(dial.socket, event)
				return
			}
			case "front-placed": {
				const dial = this.bySink.get(event.sink)
				if (dial) this.options.onFrontPlaced?.(dial.socket, event)
				return
			}
			case "front-ended":
				this.onFrontEnded(event)
				return
			case "sink-closed":
				this.onSinkClosed(hub, event)
				return
			case "sink-rejected": {
				const dial =
					event.sink !== undefined ? this.bySink.get(event.sink) : undefined
				if (!dial || dial.started) return
				// Fail first: the abort's `closed` must not name a receiver error for this dial.
				const attempt = dial.attempt
				this.fail(
					dial,
					IQHUB_FRONT_CLOSED,
					"IQ hub front refused the connection",
				)
				if (attempt !== null) this.abortNow(hub, attempt)
				return
			}
			default:
				return
		}
	}

	// S5 (connect phase), S13 (an adopted stream ended), F13's cause.
	private onAttemptClosed(hub: Hub, event: HubEventOf<"closed">): void {
		if (event.seq !== undefined) hub.answers.delete(event.seq)
		if (event.connectSeq !== undefined) hub.answers.delete(event.connectSeq)
		const dial = this.byAttempt.get(event.attempt)
		for (const wake of this.attemptClosedWaiters.splice(0)) wake()
		if (!dial) return
		dial.attemptClosed = event
		if (dial.abortTimer !== null) clearTimeout(dial.abortTimer)
		dial.abortTimer = null
		if (!dial.unixStarted) {
			const code = hubCloseCode(event.reason, event.errno)
			this.fail(dial, code, `connect ${code} ${dial.host}:${dial.port}`)
		}
		this.forgetIfDone(dial)
	}

	// S14: the front has its whole stream; its write side is shut (Node's `end` follows).
	private onFrontEnded(event: HubEventOf<"front-ended">): void {
		const dial = this.bySink.get(event.sink)
		if (!dial) return
		dial.frontEnded = event
		dial.accounting.noteEnded(event)
		this.decide(dial, this.decisionFor(event.reason, event.errno))
	}

	private decisionFor(
		reason: HubCloseReason | "front-closed",
		errno: number | undefined,
	): EndDecision {
		if (reason !== "front-closed" && DESTROY_REASONS.has(reason)) {
			const code = hubCloseCode(reason, errno)
			return { kind: "destroy", code, message: `read ${code}` }
		}
		return { kind: "end" }
	}

	// S8, F13, F15, F16.
	private onSinkClosed(hub: Hub, event: HubEventOf<"sink-closed">): void {
		const dial = this.bySink.get(event.sink)
		if (!dial) return
		if (event.reason === "peer") return
		if (event.reason === "attempt-closed") {
			const closed = dial.attemptClosed
			this.decide(
				dial,
				closed
					? this.decisionFor(closed.reason, closed.errno)
					: { kind: "end" },
			)
			return
		}
		// `request` or `reconfigured`: the hub's own close, no receiver failure (IQHUB_FRONT_CLOSED).
		// Decided before the abort, whose `closed` must not name a receiver error for this dial.
		const abort = !dial.started ? dial.attempt : null
		this.decide(dial, {
			kind: "destroy",
			code: IQHUB_FRONT_CLOSED,
			message: "IQ hub closed the front",
		})
		if (abort !== null) this.abortNow(hub, abort)
	}

	/** Records how the Node socket ends and applies it once Node has its `end` (S14, M6). */
	private decide(dial: Dial, decision: EndDecision): void {
		if (dial.decision === null) dial.decision = decision
		if (this.cancelled(dial)) return
		if (!dial.unixStarted) {
			this.apply(dial)
			return
		}
		if (dial.nodeEnded) {
			this.apply(dial)
			return
		}
		this.armEndTimer(dial)
	}

	private armEndTimer(dial: Dial): void {
		if (dial.endTimer !== null) clearTimeout(dial.endTimer)
		dial.endWaitStartedAt ??= this.now()
		dial.endTimer = setTimeout(() => {
			dial.endTimer = null
			if (this.cancelled(dial)) return
			// Data still waits behind a paused socket: its `end` comes after it (capped in all).
			const waited = this.now() - (dial.endWaitStartedAt ?? this.now())
			if (
				dial.decision !== null &&
				!dial.nodeEnded &&
				dial.socket.isPaused() &&
				waited < (this.options.pausedEndCapMs ?? HUB_PAUSED_END_CAP_MS)
			) {
				this.armEndTimer(dial)
				return
			}
			if (dial.decision === null)
				dial.decision = {
					kind: "destroy",
					code: "ECONNRESET",
					message: "IQ hub front ended without its stream's end",
				}
			this.apply(dial, true)
		}, this.options.endWaitMs ?? HUB_END_WAIT_MS)
		dial.endTimer.unref()
	}

	private apply(dial: Dial, viaDestroy = false): void {
		if (dial.endTimer !== null) clearTimeout(dial.endTimer)
		dial.endTimer = null
		const decision = dial.decision
		if (decision === null || this.cancelled(dial)) return
		if (decision.kind === "destroy" || !dial.unixStarted) {
			if (decision.kind === "end") {
				this.fail(dial, "ECONNRESET", "IQ hub closed the attempt")
				return
			}
			this.fail(dial, decision.code, decision.message)
			return
		}
		if (viaDestroy) dial.socket.destroy()
		else dial.socket.end()
	}

	// M6: Node saw the front's EOF; wait for the hub's account of it.
	private onNodeEnd(dial: Dial): void {
		dial.nodeEnded = true
		if (dial.decision !== null) {
			this.apply(dial)
			return
		}
		this.armEndTimer(dial)
	}

	// S15 and M9: SourceManager closed the socket.
	private onNodeClose(dial: Dial): void {
		if (dial.nodeClosed) return
		dial.nodeClosed = true
		if (dial.endTimer !== null) clearTimeout(dial.endTimer)
		dial.endTimer = null
		this.options.onDialClosed?.(dial.socket)
		const hub = this.hub
		if (
			hub &&
			!hub.gone &&
			dial.attempt !== null &&
			dial.attemptClosed === null
		) {
			if (!dial.unixStarted) {
				// The hub has no front connection to see close: abort the attempt at once.
				this.abortNow(hub, dial.attempt)
			} else {
				const attempt = dial.attempt
				dial.abortTimer = setTimeout(() => {
					dial.abortTimer = null
					if (dial.attemptClosed === null && hub === this.hub)
						this.abortNow(hub, attempt)
				}, this.options.abortAfterCloseMs ?? HUB_ABORT_AFTER_CLOSE_MS)
				dial.abortTimer.unref()
			}
		}
		this.forgetIfDone(dial)
	}

	private sweepClosedSockets(): void {
		for (const dial of this.dials)
			if (!dial.nodeClosed && dial.socket.destroyed && dial.socket.closed)
				this.onNodeClose(dial)
	}

	private forgetIfDone(dial: Dial): void {
		const hubGone = this.hub === null || this.hub.gone
		if (!dial.nodeClosed) return
		if (dial.connectSent && dial.attemptClosed === null && !hubGone) return
		if (dial.abortTimer !== null) clearTimeout(dial.abortTimer)
		dial.abortTimer = null
		this.dials.delete(dial)
		if (dial.attempt !== null && this.byAttempt.get(dial.attempt) === dial)
			this.byAttempt.delete(dial.attempt)
		if (dial.sink !== null && this.bySink.get(dial.sink) === dial)
			this.bySink.delete(dial.sink)
	}

	private fail(dial: Dial, code: string, message: string): void {
		if (dial.failed) return
		dial.failed = true
		if (dial.endTimer !== null) clearTimeout(dial.endTimer)
		dial.endTimer = null
		if (!dial.socket.destroyed) dial.socket.destroy(hubError(message, code))
	}

	private goneError(hub: Hub): WaveKitError {
		return hub.hung
			? hubError("IQ hub stopped answering", IQHUB_HUNG)
			: hubError("IQ hub exited", IQHUB_EXITED)
	}

	private failGone(dial: Dial, hub: Hub): void {
		const err = this.goneError(hub)
		this.fail(dial, err.code, err.message)
	}

	// M1 (S19): no event for 5 s: kill the own child by its handle; its exit takes S16.
	private onHung(hub: Hub): void {
		if (hub.gone || hub.hung) return
		hub.hung = true
		this.log.warn(
			{ pid: hub.proc?.pid ?? null },
			"IQ hub stopped answering; killing it",
		)
		if (hub.proc) hub.proc.kill("SIGKILL")
		else this.markGone(hub)
	}

	private markGone(hub: Hub): void {
		if (hub.gone) return
		hub.gone = true
		hub.watchdog.stop()
		if (this.hub === hub) this.hub = null
		const { code, message } = this.goneError(hub)
		for (const dial of [...this.dials]) {
			if (dial.nodeClosed) {
				this.forgetIfDone(dial)
				continue
			}
			if (!dial.connectSent) continue
			if (!dial.unixStarted) {
				this.fail(dial, code, message)
				continue
			}
			// The kernel EOFs the front: Node reads what it holds first, then ends (S16). An earlier
			// account of the stream (front-ended) stands.
			dial.decision ??= { kind: "destroy", code, message }
			if (dial.nodeEnded) this.apply(dial)
			else this.armEndTimer(dial)
		}
		const answers = [...hub.answers.values()]
		hub.answers.clear()
		for (const answer of answers)
			answer({ v: 1, type: "rejected", mono: 0, request: null, reason: GONE })
		for (const wake of this.attemptClosedWaiters.splice(0)) wake()
	}

	// S16: the hub exited (any code or signal).
	private onExit(hub: Hub, exit: HubExit): void {
		const expected = this.disposed
		const fields = {
			code: exit.code,
			signal: exit.signal,
			spawnError: exit.spawnError,
			hung: hub.hung,
			stderrTail: hub.proc?.stderrTail() ?? "",
		}
		if (expected) this.log.info(fields, "IQ hub exited")
		else this.log.warn(fields, "IQ hub exited")
		hub.exited = true
		this.live.delete(hub)
		if (hub.proc) void hub.proc.removeSocketDir().catch(() => {})
		this.markGone(hub)
		for (const waiter of hub.exitWaiters.splice(0)) waiter()
	}

	/**
	 * S18: shutdown, end the control pipe, wait for the exit (bounded), then SIGKILL; remove the
	 * socket dir. A child still starting (or not ready, or already given up) is killed by its handle
	 * once the factory resolved; this resolves only after every own child exited.
	 */
	async dispose(): Promise<void> {
		this.disposed = true
		for (const dial of this.dials)
			if (!dial.socket.destroyed) dial.socket.destroy()
		await Promise.all([...this.live].map(hub => this.stopHub(hub)))
	}

	private async stopHub(hub: Hub): Promise<void> {
		hub.watchdog.stop()
		await hub.spawned
		const proc = hub.proc
		if (!proc) return
		if (!hub.exited) {
			const exited = new Promise<void>(resolve => hub.exitWaiters.push(resolve))
			if (hub.gone || hub.readyEvent === null) {
				proc.kill("SIGKILL")
				await exited
			} else {
				proc.send(encodeHubRequest({ type: "shutdown" }))
				proc.endControl()
				let timer: ReturnType<typeof setTimeout> | null = null
				const timeout = new Promise<"timeout">(resolve => {
					timer = setTimeout(
						() => resolve("timeout"),
						this.options.shutdownWaitMs ?? HUB_SHUTDOWN_WAIT_MS,
					)
				})
				const result = await Promise.race([
					exited.then(() => "exited" as const),
					timeout,
				])
				if (timer !== null) clearTimeout(timer)
				if (result === "timeout") {
					proc.kill("SIGKILL")
					await exited
				}
			}
		}
		await proc.removeSocketDir().catch(() => {})
	}
}

export interface HubSourceIntakeOptions extends SupervisorHooks {
	logger: Logger
	factory: HubProcessFactory
	/** Per-supervisor overrides (tests). */
	supervisor?: Partial<
		Omit<
			SupervisorOptions,
			"sourceId" | "logger" | "factory" | keyof SupervisorHooks
		>
	>
}

/**
 * The hub SourceIntake: rtl_tcp U8 IQ sources with an IP-literal host go through a per-source
 * Supervisor; every other source, and a host name (M8), keeps today's socket path.
 */
export class HubSourceIntake implements SourceIntake {
	private readonly log: Logger
	private readonly options: HubSourceIntakeOptions
	private readonly supervisors = new Map<string, Supervisor>()
	private readonly plain = new WeakSet<Socket>()
	private readonly namedHostLogged = new Set<string>()
	private readonly disposing = new Set<Promise<void>>()

	constructor(options: HubSourceIntakeOptions) {
		this.options = options
		this.log = options.logger.child({ component: "IqHubIntake" })
	}

	/** The supervisor of a source (tests, R3). */
	supervisor(id: string): Supervisor | undefined {
		return this.supervisors.get(id)
	}

	create(
		id: string,
		config: SourceConfig,
		host: string,
		_port?: number,
	): Socket {
		if (!hubEligibleSource(config) || !hubEligibleHost(host)) {
			if (hubEligibleSource(config) && !this.namedHostLogged.has(id)) {
				this.namedHostLogged.add(id)
				this.log.info(
					{ sourceId: id },
					"Source host is a name; hub intake needs an IP address, so this source uses the socket path",
				)
			}
			const socket = new net.Socket()
			this.plain.add(socket)
			return socket
		}
		const socket = new net.Socket({ allowHalfOpen: true })
		Object.defineProperty(socket, HUB_FRONT_TAG, { value: id })
		return socket
	}

	connect(
		socket: Socket,
		id: string,
		config: SourceConfig,
		host: string,
		port: number,
	): void {
		if (this.plain.has(socket)) {
			socket.connect(port, host)
			return
		}
		let supervisor = this.supervisors.get(id)
		if (!supervisor) {
			supervisor = new Supervisor({
				...this.options.supervisor,
				sourceId: id,
				logger: this.options.logger,
				factory: this.options.factory,
				...(this.options.onFrontPlaced
					? { onFrontPlaced: this.options.onFrontPlaced }
					: {}),
				...(this.options.onIntakeGap
					? { onIntakeGap: this.options.onIntakeGap }
					: {}),
				...(this.options.onDialClosed
					? { onDialClosed: this.options.onDialClosed }
					: {}),
			})
			this.supervisors.set(id, supervisor)
		}
		supervisor.dial(socket, config, host, port)
	}

	localPortOf(socket: Socket): number | null {
		if (this.plain.has(socket)) return null
		for (const supervisor of this.supervisors.values()) {
			const port = supervisor.localPortOf(socket)
			if (port !== null) return port
		}
		return null
	}

	// m9: the map drops the supervisor at once, so a re-added id gets a new hub.
	dispose(id: string): void {
		const supervisor = this.supervisors.get(id)
		if (!supervisor) return
		this.supervisors.delete(id)
		this.track(supervisor.dispose())
	}

	async disposeAll(): Promise<void> {
		const all = [...this.supervisors.values()]
		this.supervisors.clear()
		for (const supervisor of all) this.track(supervisor.dispose())
		await Promise.all([...this.disposing])
	}

	private track(done: Promise<void>): void {
		const tracked = done.catch((err: unknown) => {
			this.log.warn(
				{ code: err instanceof WaveKitError ? err.code : "unknown" },
				"IQ hub shutdown failed",
			)
		})
		this.disposing.add(tracked)
		void tracked.finally(() => this.disposing.delete(tracked))
	}
}

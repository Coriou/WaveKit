import { getScan, ScanReadError } from "./api-client.js"
import {
	initialScan,
	resetScan,
	selectScan,
	scanProfile,
	scanFrame,
	scanRead,
	sameDemand,
	SCAN_PENDING_KEYS,
	type ScanDemand,
} from "./scan-state.js"
import type { SpectrumFrameEventData } from "@wavekit/api-types"
import type { ScanRead } from "./scanner-guards.js"
import { createCliProbeFetch } from "./access-transport.js"
import { createApiClient } from "./api-client.js"
import {
	discover as defaultDiscover,
	type ApiTarget,
	type FetchLike,
} from "./config.js"
import { initialState, reduce, type ReduceDeps } from "./reducers.js"
import { createStore, type Store } from "./store.js"
import {
	POLL_ENDPOINTS,
	RESYNC_ENDPOINTS,
	actionKey,
	type ActionResult,
	type AppState,
	type CommandOutcome,
	type Effects,
	type Endpoint,
	type FetchOutcome,
	type Inbound,
	type RestInbound,
	type RestValues,
	type WriteIntent,
	type WsEvent,
} from "./types.js"
import {
	BACKOFF_STEPS_MS,
	createWsClient,
	nodeWsFactory,
	type WsFactory,
} from "./ws-client.js"

export const FLUSH_MS = 200
export const POLL_MS = 5_000
export const REDISCOVER_AFTER_MS = 15_000
const MAX_BACKOFF_MS = BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1] ?? 15_000

export interface Timers {
	setTimeout(fn: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
	setInterval(fn: () => void, ms: number): unknown
	clearInterval(handle: unknown): void
}

/** Every timer is unref'd: none of them may keep the process alive after the UI exits. */
export const NODE_TIMERS: Timers = {
	setTimeout: (fn, ms) => {
		const h = setTimeout(fn, ms)
		h.unref()
		return h
	},
	clearTimeout: h => clearTimeout(h as NodeJS.Timeout),
	setInterval: (fn, ms) => {
		const h = setInterval(fn, ms)
		h.unref()
		return h
	},
	clearInterval: h => clearInterval(h as NodeJS.Timeout),
}

export interface RuntimeDeps {
	fetchFn: FetchLike
	/** Discovery never receives the authenticated REST transport. */
	probeFetchFn: FetchLike
	wsFactory: WsFactory
	now(): number
	random(): number
	timers: Timers
	summarize: ReduceDeps["summarize"]
	explicit: ApiTarget | null
	discover?: (
		fetchFn: FetchLike,
	) => Promise<{ target: ApiTarget | null; tried: string[] }>
}

export interface Runtime {
	readonly store: Store<AppState>
	start(): void
	stop(): void
	reconnect(): void
	setScanDemand(demand: ScanDemand | null): void
	send(intent: WriteIntent): void
	/** One flush: drain the inbound queue, reduce, commit once. Exposed for tests. */
	tick(): void
}

export type RuntimeHandle = Pick<Runtime, "store" | "reconnect" | "send"> &
	Partial<Pick<Runtime, "setScanDemand">>

export function nodeRuntimeDeps(
	explicit: ApiTarget | null,
	summarize: ReduceDeps["summarize"],
	transports?: Pick<RuntimeDeps, "fetchFn" | "wsFactory">,
): RuntimeDeps {
	return {
		fetchFn: transports?.fetchFn ?? ((url, init) => fetch(url, init)),
		probeFetchFn: createCliProbeFetch(),
		wsFactory: transports?.wsFactory ?? nodeWsFactory,
		now: () => Date.now(),
		random: () => Math.random(),
		timers: NODE_TIMERS,
		summarize,
		explicit,
	}
}

/** WS events that refresh periodic state; they carry nothing a user is waiting on (R83). */
export const BACKGROUND_EVENTS: ReadonlySet<WsEvent["type"]> = new Set([
	"fanout:snapshot",
	"metrics",
	"source:status",
	"resources:snapshot",
])

/**
 * True for inbound items that should reach the screen on the next 200 ms tick.
 * A queue holding only background items (BACKGROUND_EVENTS and routine REST
 * answers) commits on the next whole second instead; any urgent item carries
 * them along. A REST answer is urgent when the runtime marked it (final M2).
 */
export function isUrgent(item: Inbound): boolean {
	switch (item.kind) {
		case "rest":
			return item.urgent === true
		case "rest:cycle":
			return false
		case "ws":
			return !BACKGROUND_EVENTS.has(item.event.type)
		default:
			return true
	}
}

export function createRuntime(deps: RuntimeDeps): Runtime {
	const queue: Inbound[] = []
	let scan = initialScan()
	let scanDirty = false
	let scanDemand: ScanDemand | null = null
	let scanGeneration = 0
	let scanAdmission = 0
	let scanAbort: AbortController | null = null
	let scanReading = false
	let lastScanRead = -Infinity
	const scanReadAt = new Map<string, number>()
	let pendingFrame: { frame: SpectrumFrameEventData; at: number } | null = null
	const pendingKeys = new Set<string>()
	function resetScanSession(): void {
		scanGeneration++
		scanAbort?.abort()
		scanReading = false
		lastScanRead = -Infinity
		scanReadAt.clear()
		pendingFrame = null
		pendingKeys.clear()
		const removed = scan.phase === "removed"
		scan = resetScan(scan)
		if (removed) scan = { ...scan, phase: "removed", error: "source removed" }
		scanDirty = true
	}
	const push = (item: Inbound): void => {
		if (item.kind === "ws:open" || item.kind === "ws:close") resetScanSession()
		if (item.kind === "ws:invalid" && item.scan) {
			if (scanDemand) {
				scan = {
					...scan,
					invalidFrames: Math.min(
						Number.MAX_SAFE_INTEGER,
						scan.invalidFrames + 1,
					),
				}
				scanDirty = true
			}
			return
		}
		if (item.kind === "ws") {
			const ev = item.event
			if (ev.type === "spectrum:frame") {
				if (
					scanDemand &&
					ev.frame.sourceId === scanDemand.sourceId &&
					scan.profile?.sourceId === scanDemand.sourceId &&
					ev.frame.profile === scan.profile.profile?.key
				)
					pendingFrame = { frame: ev.frame, at: item.at }
				return
			}
			if (ev.type === "spectrum:profile") {
				if (scan.phase === "removed") return
				scanAdmission++
				pendingFrame = null
				scan = scanProfile(scan, ev.profile)
				scanDirty = true
				return
			}
			if (ev.type === "scanner:status") {
				scan = scanRead(scan, "status", ev.status, null, item.at)
				scanDirty = true
				if (scan.phase === "error") pendingFrame = null
				return
			}
			if (ev.type === "scanner:invalidate") {
				if (pendingKeys.size < SCAN_PENDING_KEYS) pendingKeys.add(ev.key)
				return
			}
			if (
				"sourceId" in ev &&
				ev.sourceId === scanDemand?.sourceId &&
				(ev.type === "source:disconnected" || ev.type === "source:removed")
			) {
				pendingFrame = null
				scan = { ...scan, rows: [], phase: "waiting" }
				scanDirty = true
				if (ev.type === "source:removed") {
					scan = {
						...scan,
						profile: null,
						phase: "removed",
						error: "source removed",
					}
					scanGeneration++
					scanAbort?.abort()
					scanReading = false
					ws.setScanSource(null)
				}
			}
			if (
				ev.type === "source:status" &&
				ev.source.id === scanDemand?.sourceId &&
				ev.source.activity &&
				ev.source.activity.state !== "streaming"
			) {
				pendingFrame = null
				scan = { ...scan, rows: [] }
				scanDirty = true
			}
		}
		queue.push(item)
	}
	const store = createStore(initialState(deps.now()))
	const reduceDeps: ReduceDeps = { summarize: deps.summarize }
	const discoverFn = deps.discover ?? ((f: FetchLike) => defaultDiscover(f))
	let target: ApiTarget | null = deps.explicit
	let stopped = true
	let flushTimer: unknown = null
	let pollTimer: unknown = null
	let rediscoverTimer: unknown = null
	let discovering = false
	let unreachableSince: number | null = null
	/** Bumped by stop(): async work started before it finishes silently. */
	let epoch = 0
	/** Correlates each action:result with its action:sent (R47 M6). */
	let sendSeq = 0
	let cycleRunning = false
	/** Endpoints of the cycle requested while one was in flight (M1). */
	let queuedCycle: Endpoint[] | null = null
	/** Per-endpoint request sequence: issued, and the newest applied (M2). */
	const issued = new Map<Endpoint, number>()
	const applied = new Map<Endpoint, number>()
	/**
	 * The runtime's own POLL+RESYNC request (start, reconnect, discovery) and how each of
	 * its endpoints fared. The ws:open that follows asks for the same set (effects.resync);
	 * an endpoint still pending or applied OK (2xx and accepted by its guard) within
	 * POLL_MS is covered and not fetched again; any other outcome (5xx, invalid body,
	 * network error, timeout: core restarting) is. A covered endpoint still pending
	 * when the ws:open arrives is fetched again if its GET then fails (R55: one set of
	 * GETs per reconnect, never a lost resync).
	 */
	let resyncAt: number | null = null
	const resyncState = new Map<Endpoint, "pending" | "ok" | "failed">()
	/** Endpoints a ws:open skipped while their resync GET was still pending. */
	const awaitingResync = new Set<Endpoint>()
	/**
	 * R98: resync-only endpoints whose last applied answer failed. Nothing polls them,
	 * so a poll cycle that gets an OK answer retries them, at most once per POLL_MS.
	 */
	const resyncFailed = new Set<Endpoint>()
	let resyncRetryAt: number | null = null
	/** Endpoints whose last applied answer was OK (2xx and accepted by its guard). */
	const lastOk = new Set<Endpoint>()
	/** Endpoints with an applied answer since the last start, reconnect, discovery or ws:open. */
	const answeredOnce = new Set<Endpoint>()

	function clearResync(): void {
		resyncAt = null
		resyncState.clear()
	}

	function requestResync(): void {
		answeredOnce.clear()
		resyncAt = deps.now()
		resyncState.clear()
		for (const e of [...POLL_ENDPOINTS, ...RESYNC_ENDPOINTS])
			resyncState.set(e, "pending")
		requestCycle([...POLL_ENDPOINTS, ...RESYNC_ENDPOINTS])
	}

	const api = createApiClient({
		base: () => target?.base ?? null,
		fetchFn: deps.fetchFn,
		now: deps.now,
	})
	const ws = createWsClient({
		url: () => target?.ws ?? null,
		factory: deps.wsFactory,
		emit: push,
		now: deps.now,
		random: deps.random,
		setTimeout: deps.timers.setTimeout,
		clearTimeout: deps.timers.clearTimeout,
	})

	function eligibleScanSource(id: string): boolean {
		return (
			store
				.get()
				.sources.value?.some(
					s =>
						s.id === id &&
						s.caps.kind !== "audio_pcm" &&
						["U8_IQ", "S16_IQ", "FLOAT32LE"].includes(s.caps.format),
				) === true
		)
	}

	async function readScanCycle(): Promise<void> {
		if (
			stopped ||
			!scanDemand ||
			scan.phase === "removed" ||
			!target ||
			scanReading ||
			deps.now() - lastScanRead < POLL_MS
		)
			return
		if (
			store.get().conn.ws.state === "closed" &&
			store.get().conn.ws.reason?.includes("access")
		)
			return
		const demand = scanDemand
		const generation = scanGeneration
		const admission = scanAdmission
		const base = target.base
		const controller = new AbortController()
		scanAbort = controller
		scanReading = true
		lastScanRead = deps.now()
		pendingKeys.clear()
		const signal = controller.signal
		const timeout = deps.timers.setTimeout(() => controller.abort(), 2000)
		const query = `sourceId=${encodeURIComponent(demand.sourceId)}&limit=50${demand.cursor ? `&cursor=${encodeURIComponent(demand.cursor)}` : ""}`
		const reads: [ScanRead, string][] = [
			["status", "/api/scanner"],
			["spectrum", "/api/spectrum"],
			["jobs", "/api/scanner/jobs"],
			["discoveries", `/api/scanner/discoveries?${query}`],
		]
		if (demand.detail) {
			const url = `/api/scanner/${demand.detail.kind === "job" ? "jobs" : "discoveries"}/${encodeURIComponent(demand.detail.id)}`
			reads.push([demand.detail.kind, url])
			if (demand.detail.kind === "discovery")
				reads.push(["observations", `${url}/observations?limit=50`])
		}
		await Promise.allSettled(
			reads
				.filter(
					([_key, path]) =>
						deps.now() - (scanReadAt.get(path) ?? -Infinity) >= POLL_MS,
				)
				.map(async ([key, path]) => {
					scanReadAt.set(path, deps.now())
					if (scanReadAt.size > 64)
						scanReadAt.delete(scanReadAt.keys().next().value ?? "")
					try {
						const value = await getScan(deps.fetchFn, base, key, path, signal)
						if (generation !== scanGeneration || stopped) return
						// A REST snapshot issued before this admission cannot revoke it.
						if (
							(key === "status" || key === "spectrum") &&
							admission !== scanAdmission
						)
							return
						if (
							(key === "job" || key === "discovery") &&
							(!value || !("id" in value) || value.id !== demand.detail?.id)
						)
							throw new ScanReadError(
								"invalid",
								"Scan detail identity mismatch",
							)
						scan = scanRead(scan, key, value, null, deps.now())
					} catch (error) {
						if (generation !== scanGeneration || stopped) return
						scan = scanRead(
							scan,
							key,
							null,
							error instanceof ScanReadError
								? error.message
								: "Scan read unavailable",
							deps.now(),
						)
					}
					scanDirty = true
					if (scan.phase === "error" || scan.phase === "removed")
						pendingFrame = null
				}),
		)
		deps.timers.clearTimeout(timeout)
		if (generation === scanGeneration) {
			scanReading = false
			scanAbort = null
		}
	}

	function restInbound<E extends Endpoint>(
		endpoint: E,
		outcome: FetchOutcome<RestValues[E]>,
		at: number,
		urgent: boolean,
	): Inbound {
		// TS cannot correlate E across the mapped union; the shape is correct by construction.
		return {
			kind: "rest",
			endpoint,
			outcome,
			at,
			...(urgent ? { urgent: true } : {}),
		} as RestInbound
	}

	/**
	 * Resolves true when the server answered at all; a network error or a timeout is no
	 * answer (M3). `afterWrite`: a poll an action:result asked for (final M2).
	 */
	async function fetchOne(
		endpoint: Endpoint,
		afterWrite = false,
	): Promise<boolean> {
		const run = epoch
		const seq = (issued.get(endpoint) ?? 0) + 1
		issued.set(endpoint, seq)
		const outcome = await api.get(endpoint)
		// Work started before stop() ends silently: nothing reaches the next session.
		if (run !== epoch) return false
		const answered =
			outcome.ok ||
			(outcome.error.kind !== "network" && outcome.error.kind !== "timeout")
		if (resyncState.get(endpoint) === "pending")
			resyncState.set(endpoint, outcome.ok ? "ok" : "failed")
		// A ws:open counted on this GET; it failed, so that resync is done now (I3).
		if (awaitingResync.delete(endpoint) && !outcome.ok) void fetchOne(endpoint)
		// M2: a response older than one already applied is dropped, never applied over it.
		if (seq > (applied.get(endpoint) ?? 0)) {
			applied.set(endpoint, seq)
			// Final M2: the first answer since start/reconnect, or one a write waits on, is urgent.
			const urgent = afterWrite || !answeredOnce.has(endpoint)
			answeredOnce.add(endpoint)
			if (outcome.ok) lastOk.add(endpoint)
			else lastOk.delete(endpoint)
			if (RESYNC_ENDPOINTS.includes(endpoint)) {
				if (outcome.ok) resyncFailed.delete(endpoint)
				else resyncFailed.add(endpoint)
			}
			push(restInbound(endpoint, outcome, deps.now(), urgent))
		}
		return answered
	}

	function schedulePoll(): void {
		if (stopped) return
		if (pollTimer !== null) deps.timers.clearTimeout(pollTimer)
		pollTimer = deps.timers.setTimeout(() => {
			pollTimer = null
			requestCycle(POLL_ENDPOINTS)
		}, POLL_MS)
	}

	/** Cycles never overlap (spec §10.2): one requested mid-cycle runs when it ends (M1). */
	function requestCycle(endpoints: readonly Endpoint[]): void {
		if (stopped) return
		if (cycleRunning) {
			queuedCycle = [...new Set([...(queuedCycle ?? []), ...endpoints])]
			return
		}
		if (pollTimer !== null) deps.timers.clearTimeout(pollTimer)
		pollTimer = null
		void pollCycle(endpoints)
	}

	async function pollCycle(endpoints: readonly Endpoint[]): Promise<void> {
		const run = epoch
		cycleRunning = true
		const results = await Promise.allSettled(endpoints.map(e => fetchOne(e)))
		if (run !== epoch) return
		cycleRunning = false
		const at = deps.now()
		push({ kind: "rest:cycle", at, nextAt: at + POLL_MS })
		const answered = results.some(r => r.status === "fulfilled" && r.value)
		// R98: REST is back; resync endpoints that failed while it hung get one more GET.
		if (
			resyncFailed.size > 0 &&
			endpoints.some(e => lastOk.has(e)) &&
			(resyncRetryAt === null || at - resyncRetryAt >= POLL_MS)
		) {
			resyncRetryAt = at
			for (const e of [...resyncFailed])
				if (!endpoints.includes(e)) void fetchOne(e)
		}
		if (answered) {
			unreachableSince = null
			clearRediscover()
		} else {
			unreachableSince ??= at
			// Nothing answered: a ws:open after this must resync everything itself.
			clearResync()
		}
		maybeRediscover(at)
		const next = queuedCycle
		queuedCycle = null
		if (next !== null) requestCycle(next)
		else schedulePoll()
	}

	function clearRediscover(): void {
		if (rediscoverTimer !== null) deps.timers.clearTimeout(rediscoverTimer)
		rediscoverTimer = null
	}

	/** Starts a discovery chain unless one is running or pending: there is only ever one. */
	function maybeRediscover(at: number): void {
		if (
			deps.explicit !== null ||
			discovering ||
			rediscoverTimer !== null ||
			unreachableSince === null
		)
			return
		if (at - unreachableSince < REDISCOVER_AFTER_MS) return
		void runDiscovery()
	}

	async function runDiscovery(): Promise<void> {
		if (stopped || discovering) return
		// A run supersedes the pending retry, so the chain never forks.
		clearRediscover()
		discovering = true
		const run = epoch
		push({
			kind: "target",
			at: deps.now(),
			base: target?.base ?? null,
			ws: target?.ws ?? null,
			discovery: { mode: "probing", tried: [] },
		})
		const found = await discoverFn(deps.probeFetchFn)
		if (run !== epoch) return
		discovering = false
		const at = deps.now()
		if (found.target) {
			const same =
				target !== null &&
				target.base === found.target.base &&
				target.ws === found.target.ws
			target = found.target
			unreachableSince = null
			push({
				kind: "target",
				at,
				base: target.base,
				ws: target.ws,
				discovery: { mode: "found", tried: found.tried },
			})
			// The socket may already be back on this target by itself; reconnecting it
			// would record a false gap and wipe the rate and fanout histories.
			if (!same || !ws.connected()) {
				ws.reconnectNow()
				requestResync()
			} else {
				// No ws:open follows on an open socket: nothing to dedupe against.
				requestCycle([...POLL_ENDPOINTS, ...RESYNC_ENDPOINTS])
			}
			return
		}
		push({
			kind: "target",
			at,
			base: target?.base ?? null,
			ws: target?.ws ?? null,
			discovery: { mode: "failed", tried: found.tried },
		})
		if (target === null) {
			// Nothing to poll yet, so discovery stands in for the poll cycle.
			for (const endpoint of POLL_ENDPOINTS) {
				push(
					restInbound(
						endpoint,
						{
							ok: false,
							error: { kind: "network", message: "no API answered", at },
						},
						at,
						false,
					),
				)
			}
			push({ kind: "rest:cycle", at, nextAt: at + MAX_BACKOFF_MS })
		} else if (unreachableSince === null) {
			// A poll of the current target answered while this ran: nothing to chase.
			return
		}
		rediscoverTimer = deps.timers.setTimeout(() => {
			rediscoverTimer = null
			void runDiscovery()
		}, MAX_BACKOFF_MS)
	}

	/**
	 * What to fetch after a commit: every effect poll (writes and events), plus the
	 * resync a ws:open asks for minus what the runtime's own resync covers. A ws:open
	 * consumes the runtime's resync record.
	 */
	function effectFetches(effects: Effects, now: number): Endpoint[] {
		const out = new Set<Endpoint>(effects.polls)
		const resync = effects.resync ?? []
		if (resync.length === 0) return [...out]
		const fresh = resyncAt !== null && now - resyncAt <= POLL_MS
		for (const e of resync) {
			const st = resyncState.get(e)
			if (fresh && st === "pending") awaitingResync.add(e)
			else if (!(fresh && st === "ok")) out.add(e)
		}
		clearResync()
		return [...out]
	}

	function tick(): void {
		void readScanCycle()
		if (pendingFrame) {
			scan = scanFrame(scan, pendingFrame.frame, pendingFrame.at)
			pendingFrame = null
			scanDirty = true
		}
		const current = store.get()
		const now = deps.now()
		// Background items (periodic snapshots, heartbeats, REST answers) wait for the
		// next whole second, when ages change anyway; anything a user waits on
		// commits on the next 200 ms tick (D3, spec §15).
		if (
			Math.floor(now / 1000) === Math.floor(current.now / 1000) &&
			!queue.some(isUrgent) &&
			!scanDirty
		)
			return
		const batch = queue.splice(0, queue.length)
		// A ws:open (the runtime's own or the ws client's auto-reconnect) starts a
		// resync: each endpoint's next answer is a first answer again (final M2).
		if (batch.some(i => i.kind === "ws:open")) answeredOnce.clear()
		let next = reduce(current, batch, now, reduceDeps)
		if (scanDirty) {
			next = { ...next, scan }
			scanDirty = false
		}
		const fx = next.effects
		if (fx.polls.length > 0 || (fx.resync?.length ?? 0) > 0) {
			next = { ...next, effects: { polls: [] } }
			// A poll asked for alongside a write's result is one the user waits on.
			const afterWrite = batch.some(i => i.kind === "action:result")
			for (const endpoint of effectFetches(fx, now))
				void fetchOne(endpoint, afterWrite && fx.polls.includes(endpoint))
		}
		store.set(next)
	}

	const stamp = (label: string, result: ActionResult): CommandOutcome => ({
		label,
		result,
		at: deps.now(),
	})

	async function execute(intent: WriteIntent): Promise<CommandOutcome[]> {
		switch (intent.kind) {
			case "decoder":
				if (
					store
						.get()
						.decoders.value?.some(
							d =>
								d.id === intent.decoderId &&
								(d.owner === "scanner" || d.ephemeral),
						)
				)
					return [
						stamp(intent.op, {
							ok: false,
							outcome: "failed",
							status: 409,
							code: "DECODER_OWNED_BY_SCANNER",
							message: "scanner probe is read-only",
						}),
					]
				return [
					stamp(intent.op, await api.decoder(intent.decoderId, intent.op)),
				]
			case "audio":
				return [stamp(intent.op, await api.audio(intent.op))]
			case "preset":
				return [
					stamp(`preset ${intent.name}`, await api.patchAudio(intent.patch)),
				]
			case "tuner": {
				const out: CommandOutcome[] = []
				// Stop at the first command that is not confirmed ok: after a failure or
				// an unknown outcome (R23) the device state is not what the next one assumes.
				let halted = false
				for (const cmd of intent.commands) {
					if (halted) {
						out.push({ label: cmd.label, result: null, at: null })
						continue
					}
					const r = await api.tuner(intent.sourceId, cmd)
					out.push(stamp(cmd.label, r))
					if (r.outcome !== "ok") halted = true
				}
				return out
			}
		}
	}

	return {
		store,
		tick,
		start: () => {
			if (!stopped) return
			stopped = false
			flushTimer = deps.timers.setInterval(tick, FLUSH_MS)
			if (target) {
				push({
					kind: "target",
					at: deps.now(),
					base: target.base,
					ws: target.ws,
					discovery: { mode: "explicit", tried: [] },
				})
				ws.start()
				requestResync()
			} else {
				void runDiscovery()
			}
		},
		stop: () => {
			stopped = true
			epoch++
			resetScanSession()
			scanDemand = null
			scan = initialScan()
			// Queued inbound belongs to the stopped session.
			queue.length = 0
			clearResync()
			awaitingResync.clear()
			resyncFailed.clear()
			lastOk.clear()
			resyncRetryAt = null
			discovering = false
			cycleRunning = false
			queuedCycle = null
			if (pollTimer !== null) deps.timers.clearTimeout(pollTimer)
			clearRediscover()
			if (flushTimer !== null) deps.timers.clearInterval(flushTimer)
			pollTimer = null
			flushTimer = null
			ws.stop()
		},
		reconnect: () => {
			if (stopped) return
			if (target === null) {
				void runDiscovery()
				return
			}
			if (
				scan.phase === "removed" &&
				scanDemand &&
				eligibleScanSource(scanDemand.sourceId)
			)
				scan = selectScan(scan, scanDemand.sourceId)
			resetScanSession()
			if (scanDemand && eligibleScanSource(scanDemand.sourceId))
				ws.setScanSource(scanDemand.sourceId)
			ws.reconnectNow()
			requestResync()
		},
		setScanDemand: demand => {
			if (sameDemand(scanDemand, demand)) return
			const sourceChanged = scanDemand?.sourceId !== demand?.sourceId
			const retryChanged = (scanDemand?.retry ?? 0) !== (demand?.retry ?? 0)
			const queryChanged = scanDemand?.cursor !== demand?.cursor
			const detailChanged =
				scanDemand?.detail?.id !== demand?.detail?.id ||
				scanDemand?.detail?.kind !== demand?.detail?.kind
			scanDemand = demand
			scanGeneration++
			scanAbort?.abort()
			scanReading = false
			lastScanRead = -Infinity
			pendingKeys.clear()
			if (sourceChanged || retryChanged) {
				scanReadAt.clear()
				pendingFrame = null
				scan = selectScan(scan, demand?.sourceId ?? null)
				ws.setScanSource(
					demand && (!retryChanged || eligibleScanSource(demand.sourceId))
						? demand.sourceId
						: null,
				)
			} else
				scan = {
					...scan,
					lanes: {
						...scan.lanes,
						...(queryChanged
							? { discoveries: { value: null, at: null, error: null } }
							: {}),
						...(detailChanged
							? {
									job: { value: null, at: null, error: null },
									discovery: { value: null, at: null, error: null },
									observations: { value: null, at: null, error: null },
								}
							: {}),
					},
				}
			scanDirty = true
		},
		send: intent => {
			const key = actionKey(intent)
			const id = ++sendSeq
			const run = epoch
			push({ kind: "action:sent", at: deps.now(), id, key, intent })
			void execute(intent).then(outcomes => {
				// A write answered after stop() belongs to no session (R55 minor 4).
				if (run !== epoch) return
				push({ kind: "action:result", at: deps.now(), id, key, outcomes })
			})
		},
	}
}

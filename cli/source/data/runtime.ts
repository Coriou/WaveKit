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
	send(intent: WriteIntent): void
	/** One flush: drain the inbound queue, reduce, commit once. Exposed for tests. */
	tick(): void
}

export type RuntimeHandle = Pick<Runtime, "store" | "reconnect" | "send">

export function nodeRuntimeDeps(
	explicit: ApiTarget | null,
	summarize: ReduceDeps["summarize"],
): RuntimeDeps {
	return {
		fetchFn: (url, init) => fetch(url, init),
		wsFactory: nodeWsFactory,
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
 * A queue holding only background items (BACKGROUND_EVENTS and REST answers)
 * commits on the next whole second instead; any urgent item carries them along.
 */
export function isUrgent(item: Inbound): boolean {
	switch (item.kind) {
		case "rest":
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
	const push = (item: Inbound): void => {
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

	function clearResync(): void {
		resyncAt = null
		resyncState.clear()
	}

	function requestResync(): void {
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

	function restInbound<E extends Endpoint>(
		endpoint: E,
		outcome: FetchOutcome<RestValues[E]>,
		at: number,
	): Inbound {
		// TS cannot correlate E across the mapped union; the shape is correct by construction.
		return { kind: "rest", endpoint, outcome, at } as RestInbound
	}

	/** Resolves true when the server answered at all; a network error or a timeout is no answer (M3). */
	async function fetchOne(endpoint: Endpoint): Promise<boolean> {
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
			push(restInbound(endpoint, outcome, deps.now()))
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
		const results = await Promise.allSettled(endpoints.map(fetchOne))
		if (run !== epoch) return
		cycleRunning = false
		const at = deps.now()
		push({ kind: "rest:cycle", at, nextAt: at + POLL_MS })
		const answered = results.some(r => r.status === "fulfilled" && r.value)
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
		const found = await discoverFn(deps.fetchFn)
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
		const current = store.get()
		const now = deps.now()
		// Background items (periodic snapshots, heartbeats, REST answers) wait for the
		// next whole second, when ages change anyway; anything a user waits on
		// commits on the next 200 ms tick (D3, spec §15).
		if (
			Math.floor(now / 1000) === Math.floor(current.now / 1000) &&
			!queue.some(isUrgent)
		)
			return
		const batch = queue.splice(0, queue.length)
		let next = reduce(current, batch, now, reduceDeps)
		const fx = next.effects
		if (fx.polls.length > 0 || (fx.resync?.length ?? 0) > 0) {
			next = { ...next, effects: { polls: [] } }
			for (const endpoint of effectFetches(fx, now)) void fetchOne(endpoint)
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
			// Queued inbound belongs to the stopped session.
			queue.length = 0
			clearResync()
			awaitingResync.clear()
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
			ws.reconnectNow()
			requestResync()
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

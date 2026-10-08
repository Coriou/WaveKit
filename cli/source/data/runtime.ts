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
	type Endpoint,
	type FetchOutcome,
	type Inbound,
	type RestInbound,
	type RestValues,
	type WriteIntent,
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
		const outcome = await api.get(endpoint)
		push(restInbound(endpoint, outcome, deps.now()))
		return (
			outcome.ok ||
			(outcome.error.kind !== "network" && outcome.error.kind !== "timeout")
		)
	}

	function schedulePoll(): void {
		if (stopped) return
		if (pollTimer !== null) deps.timers.clearTimeout(pollTimer)
		pollTimer = deps.timers.setTimeout(() => {
			pollTimer = null
			void pollCycle(POLL_ENDPOINTS)
		}, POLL_MS)
	}

	async function pollCycle(endpoints: readonly Endpoint[]): Promise<void> {
		const run = epoch
		const results = await Promise.allSettled(endpoints.map(fetchOne))
		if (run !== epoch) return
		const at = deps.now()
		push({ kind: "rest:cycle", at, nextAt: at + POLL_MS })
		const answered = results.some(r => r.status === "fulfilled" && r.value)
		if (answered) {
			unreachableSince = null
			clearRediscover()
		} else unreachableSince ??= at
		maybeRediscover(at)
		schedulePoll()
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
			if (!same || !ws.connected()) ws.reconnectNow()
			void pollCycle([...POLL_ENDPOINTS, ...RESYNC_ENDPOINTS])
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

	function tick(): void {
		const current = store.get()
		const now = deps.now()
		if (
			queue.length === 0 &&
			Math.floor(now / 1000) === Math.floor(current.now / 1000)
		)
			return
		const batch = queue.splice(0, queue.length)
		let next = reduce(current, batch, now, reduceDeps)
		const polls = next.effects.polls
		if (polls.length > 0) {
			next = { ...next, effects: { polls: [] } }
			for (const endpoint of polls) void fetchOne(endpoint)
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
				void pollCycle([...POLL_ENDPOINTS, ...RESYNC_ENDPOINTS])
			} else {
				void runDiscovery()
			}
		},
		stop: () => {
			stopped = true
			epoch++
			discovering = false
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
			void pollCycle([...POLL_ENDPOINTS, ...RESYNC_ENDPOINTS])
		},
		send: intent => {
			const key = actionKey(intent)
			push({ kind: "action:sent", at: deps.now(), key, intent })
			void execute(intent).then(outcomes => {
				push({ kind: "action:result", at: deps.now(), key, outcomes })
			})
		},
	}
}

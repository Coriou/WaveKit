/**
 * Activity store lifecycle for the process entry: the open runs off the startup path and a
 * failed open is retried with a bounded backoff instead of leaving Activity off for the
 * session. Each attempt is one `startActivityRuntime` call; this module owns the schedule,
 * the state reported by `GET /api/activity/status`, and the stand-ins (publisher,
 * transmission sink, query service) used while the store is not open.
 */
import type { ActivityPublisher } from "../../decoders/manager.js"
import { createComponentLogger } from "../../utils/logger.js"
import { ActivityQueryError } from "./query/errors.js"
import {
	inertActivityService,
	startActivityRuntime,
	type ActivityFailureCode,
	type ActivityRuntime,
	type StartActivityRuntimeOptions,
} from "./runtime.js"
import type {
	ActivityLifecycleStatus,
	ActivityQueryService,
	ActivityStoreStats,
	AnalogTransmissionPayload,
} from "./storage/contract.js"

/**
 * Delays after the 1st, 2nd and 3rd failed attempt, then ACTIVITY_RETRY_STEADY_MS between
 * the rest. A transient fault (a slow cold disk, a lock still held by an exiting process)
 * gets three tries in the first 80 s (5 + 15 + 60); a persistent one costs one open
 * attempt every 5 minutes, 288 a day, each bounded by the open budget.
 */
export const ACTIVITY_RETRY_DELAYS_MS: readonly number[] = [
	5_000, 15_000, 60_000,
]
export const ACTIVITY_RETRY_STEADY_MS = 300_000

/** The fixed text of a 503 while the store is not open (codes carry the detail). */
export const ACTIVITY_NOT_OPEN_MESSAGE = "Activity store is not open"

export interface ActivityLifecycleTimers {
	setTimeout(run: () => void, ms: number): unknown
	clearTimeout(handle: unknown): void
}

export interface ActivityLifecycleOptions extends StartActivityRuntimeOptions {
	retryDelaysMs?: readonly number[]
	retrySteadyMs?: number
	timers?: ActivityLifecycleTimers
	now?: () => number
	/** Test seam: one open attempt. Production uses startActivityRuntime. */
	attempt?: (options: StartActivityRuntimeOptions) => Promise<ActivityRuntime>
}

export interface ActivityLifecycle extends ActivityRuntime {
	lifecycle(): ActivityLifecycleStatus
	/** The view the API server mounts: always enabled when Activity is configured on. */
	readonly api: ActivityRuntime
	/** Settles after the attempt running now (or the next state change when none runs). */
	settled(): Promise<void>
}

const defaultTimers: ActivityLifecycleTimers = {
	setTimeout(run, ms) {
		const handle = setTimeout(run, ms)
		handle.unref()
		return handle
	},
	clearTimeout(handle) {
		clearTimeout(handle as ReturnType<typeof setTimeout>)
	},
}

function closedStats(): never {
	throw new ActivityQueryError(
		ACTIVITY_NOT_OPEN_MESSAGE,
		"ACTIVITY_UNAVAILABLE",
		503,
	)
}

/** Store counters while the store is not open: zero, writer stopped. */
function idleStats(): ActivityStoreStats {
	return {
		admitted: 0,
		committed: 0,
		duplicates: 0,
		dropped: {
			"rate-limited": 0,
			"queue-full": 0,
			"store-paused": 0,
			"write-failed": 0,
			closed: 0,
		},
		excludedTelemetry: 0,
		coalescedPositions: 0,
		queueDepth: 0,
		queueBytes: 0,
		dbBytes: 0,
		walBytes: 0,
		rows: 0,
		oldestReceivedAt: null,
		pruneWatermark: "0",
		paused: false,
		writer: "stopped",
	}
}

/**
 * Starts the first open at once and returns without waiting for it. While the store is not
 * open, decoder receptions and analog transmissions are counted in `droppedWhileClosed`,
 * not buffered: a buffer for a store that may stay closed for minutes needs a cap anyway,
 * and the count is exact (a JS number counts exactly to 2^53).
 */
export function startActivityLifecycle(
	options: ActivityLifecycleOptions,
): ActivityLifecycle {
	const log = createComponentLogger(options.logger, "Activity")
	const timers = options.timers ?? defaultTimers
	const now = options.now ?? Date.now
	const delays = options.retryDelaysMs ?? ACTIVITY_RETRY_DELAYS_MS
	const steady = options.retrySteadyMs ?? ACTIVITY_RETRY_STEADY_MS
	const attemptOnce = options.attempt ?? startActivityRuntime
	const enabled = options.enabled
	const discloseErrors = options.discloseErrors !== false

	let state: ActivityLifecycleStatus["state"] = "opening"
	let reason: ActivityFailureCode | null = null
	let attempts = 0
	let nextAttemptAt: number | null = null
	let dropped = 0
	let current: ActivityRuntime | null = null
	let timer: unknown = null
	let inFlight: Promise<void> | null = null
	let closed = false
	let closing: Promise<void> | null = null
	let hub: { close(): void } | undefined
	let waiters: (() => void)[] = []

	const wake = (): void => {
		const run = waiters
		waiters = []
		for (const resolve of run) resolve()
	}

	const countingPublisher: ActivityPublisher = () => {
		dropped += 1
	}
	const setPublisher = (publish: ActivityPublisher | null): void => {
		// A store going away (or a failed attempt's close) puts the counter back.
		options.setPublisher(publish ?? (closed ? null : countingPublisher))
	}

	const schedule = (code: ActivityFailureCode): void => {
		const delay = delays[attempts - 1] ?? steady
		nextAttemptAt = now() + delay
		state = "retrying"
		try {
			log.warn(
				{ code, attempt: attempts, retryInMs: delay },
				"Activity store did not open; retrying",
			)
		} catch {
			// A failing logger must not stop the retries.
		}
		timer = timers.setTimeout(() => {
			timer = null
			run()
		}, delay)
	}

	const settle = async (runtime: ActivityRuntime): Promise<void> => {
		if (closed) {
			await runtime.close()
			return
		}
		if (runtime.status === "ready") {
			current = runtime
			state = "available"
			reason = null
			nextAttemptAt = null
			if (attempts > 1)
				try {
					log.info({ attempts }, "Activity store open after a retry")
				} catch {
					// Logging is not required for the store to run.
				}
			return
		}
		const failure = runtime.unavailable
		const code = failure?.reason ?? "ACTIVITY_UNAVAILABLE"
		reason = code
		// A failed attempt holds no store; its close only resets the publisher.
		await runtime.close()
		if (closed) return
		if (failure?.retryable === false) {
			state = "unavailable"
			nextAttemptAt = null
			try {
				log.error(
					discloseErrors && failure.message
						? { code, err: failure.message }
						: { code },
					"Activity is unavailable; WaveKit continues without it",
				)
			} catch {
				// A failing logger must not take the process down.
			}
			return
		}
		schedule(code)
	}

	const run = (): void => {
		if (closed || inFlight !== null || current !== null) return
		attempts += 1
		state = "opening"
		nextAttemptAt = null
		inFlight = attemptOnce({ ...options, setPublisher, logFailure: false })
			.then(settle, async (error: unknown) => {
				// startActivityRuntime never rejects; a test double or a bug might.
				void error
				if (closed) return
				reason = "ACTIVITY_UNAVAILABLE"
				schedule("ACTIVITY_UNAVAILABLE")
			})
			.catch(() => undefined)
			.finally(() => {
				inFlight = null
				wake()
			})
	}

	const notOpen = (): ActivityQueryError =>
		new ActivityQueryError(
			ACTIVITY_NOT_OPEN_MESSAGE,
			"ACTIVITY_UNAVAILABLE",
			503,
			reason ?? undefined,
		)
	const service = (): ActivityQueryService => {
		if (current !== null) return current.service
		throw notOpen()
	}
	const gated: ActivityQueryService = {
		search: async input => service().search(input),
		detail: async eventId => service().detail(eventId),
		facets: async input => service().facets(input),
		trails: async input => service().trails(input),
		bandMap: async input => service().bandMap(input),
		timeline: async input => service().timeline(input),
		replay: (input, sink) => service().replay(input, sink),
		close: async () => {},
	}

	const lifecycle = (): ActivityLifecycleStatus => ({
		state,
		reason: state === "available" ? null : reason,
		attempts,
		nextAttemptAt:
			state === "retrying" && nextAttemptAt !== null
				? new Date(nextAttemptAt).toISOString()
				: null,
		droppedWhileClosed: dropped,
	})

	const close = (): Promise<void> => {
		closing ??= (async () => {
			closed = true
			if (timer !== null) {
				timers.clearTimeout(timer)
				timer = null
			}
			try {
				hub?.close()
			} catch {
				// Shutdown must not throw.
			}
			// An attempt still opening closes its store in settle().
			await inFlight
			const open = current
			current = null
			if (open !== null) await open.close()
			try {
				options.setPublisher(null)
			} catch {
				// Shutdown must not throw.
			}
			wake()
		})()
		return closing
	}

	const transmissionSink = ():
		| ((payload: AnalogTransmissionPayload) => void)
		| null => {
		if (closed || !enabled) return null
		return payload => {
			const sink = current?.transmissionSink() ?? null
			if (sink === null) {
				if (!closed) dropped += 1
				return
			}
			sink(payload)
		}
	}

	const bindSubscriptions = (next: { close(): void }): void => {
		hub = next
		if (!closed) return
		try {
			next.close()
		} catch {
			// Shutdown must not throw.
		}
	}

	if (!enabled) {
		const disabled: ActivityRuntime = {
			status: "disabled",
			service: inertActivityService(),
			discloseErrors,
			stats: closedStats,
			bindSubscriptions,
			transmissionSink: () => null,
			close,
		}
		return {
			...disabled,
			get status() {
				return "disabled" as const
			},
			lifecycle,
			api: disabled,
			settled: () => Promise.resolve(),
		}
	}

	const api: ActivityRuntime = {
		status: "ready",
		service: gated,
		discloseErrors,
		stats: () => {
			if (current === null) return { ...idleStats(), lifecycle: lifecycle() }
			return { ...current.stats(), lifecycle: lifecycle() }
		},
		bindSubscriptions,
		transmissionSink,
		close,
	}

	setPublisher(null)
	run()

	return {
		get status() {
			return current !== null ? ("ready" as const) : ("unavailable" as const)
		},
		service: gated,
		discloseErrors,
		stats: () => {
			if (current === null) return closedStats()
			return current.stats()
		},
		bindSubscriptions,
		transmissionSink,
		close,
		lifecycle,
		api,
		settled: () =>
			inFlight === null && timer === null
				? Promise.resolve()
				: new Promise<void>(resolve => {
						waiters.push(resolve)
					}),
	}
}

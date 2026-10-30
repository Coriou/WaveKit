/**
 * Activity lifecycle: the open runs in the background, failed opens are retried on the
 * bounded schedule, and the API view reports the state. One attempt is a test double
 * (no store, no worker) on a fake clock and fake timers, so every path is deterministic.
 */
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	ACTIVITY_NOT_OPEN_MESSAGE,
	ACTIVITY_RETRY_DELAYS_MS,
	ACTIVITY_RETRY_STEADY_MS,
	startActivityLifecycle,
} from "../../../../src/core/activity/lifecycle.js"
import type { ActivityLifecycleOptions } from "../../../../src/core/activity/lifecycle.js"
import { ActivityQueryError } from "../../../../src/core/activity/query/errors.js"
import {
	inertActivityService,
	type ActivityFailureCode,
	type ActivityRuntime,
} from "../../../../src/core/activity/runtime.js"
import type { ActivityPublisher } from "../../../../src/decoders/manager.js"
import type {
	ActivityStoreStats,
	AnalogTransmissionPayload,
} from "../../../../src/core/activity/storage/contract.js"

const T0 = Date.parse("2026-10-30T12:00:00.000Z")

interface Clock {
	now: number
	timers: { at: number; run: () => void; id: number }[]
	nextId: number
}

function fakeTimers(
	clock: Clock,
): NonNullable<ActivityLifecycleOptions["timers"]> {
	return {
		setTimeout(run, ms) {
			const id = clock.nextId++
			clock.timers.push({ at: clock.now + ms, run, id })
			return id
		},
		clearTimeout(handle) {
			clock.timers = clock.timers.filter(t => t.id !== handle)
		},
	}
}

/** Runs due timers up to `clock.now + ms`, then lets settled promises run. */
async function advance(clock: Clock, ms: number): Promise<void> {
	const end = clock.now + ms
	for (;;) {
		clock.timers.sort((a, b) => a.at - b.at)
		const next = clock.timers[0]
		if (next === undefined || next.at > end) break
		clock.timers.shift()
		clock.now = next.at
		next.run()
		await flush()
	}
	clock.now = end
	await flush()
}

async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve()
}

function stats(): ActivityStoreStats {
	return {
		admitted: 3,
		committed: 2,
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
		dbBytes: 4096,
		walBytes: 0,
		rows: 2,
		oldestReceivedAt: null,
		pruneWatermark: "0",
		paused: false,
		writer: "running",
	}
}

interface Opened {
	runtime: ActivityRuntime
	closed: number
	admitted: AnalogTransmissionPayload[]
}

function ready(
	setPublisher: (p: ActivityPublisher | null) => void,
	opened: Opened[],
): ActivityRuntime {
	const record: Opened = {
		runtime: undefined as unknown as ActivityRuntime,
		closed: 0,
		admitted: [],
	}
	setPublisher(() => {})
	const runtime: ActivityRuntime = {
		status: "ready",
		service: {
			...inertActivityService(),
			search: async () => ({
				items: [],
				nextPageToken: null,
				replayCursor: "c",
				snapshot: { lowBarrier: "0", highBarrier: "0" },
			}),
		} as unknown as ActivityRuntime["service"],
		discloseErrors: true,
		stats,
		bindSubscriptions() {},
		transmissionSink: () => payload => {
			record.admitted.push(payload)
		},
		async close() {
			record.closed += 1
			setPublisher(null)
		},
	}
	record.runtime = runtime
	opened.push(record)
	return runtime
}

function failed(
	reason: ActivityFailureCode,
	retryable: boolean,
	setPublisher: (p: ActivityPublisher | null) => void,
): ActivityRuntime {
	return {
		status: "unavailable",
		service: inertActivityService(),
		unavailable: {
			reason,
			message: "secret /private/path detail",
			discloseErrors: false,
			retryable,
		},
		discloseErrors: false,
		stats: () => {
			throw new Error("closed")
		},
		bindSubscriptions() {},
		transmissionSink: () => null,
		async close() {
			setPublisher(null)
		},
	}
}

type Outcome =
	| { kind: "ready" }
	| { kind: "fail"; reason: ActivityFailureCode; retryable: boolean }

/** A lifecycle whose attempts follow `outcomes` (the last repeats); attempts can be held open. */
function harness(outcomes: Outcome[], opts: { hold?: boolean } = {}) {
	const clock: Clock = { now: T0, timers: [], nextId: 1 }
	const opened: Opened[] = []
	const publishers: (ActivityPublisher | null)[] = []
	const warns: Record<string, unknown>[] = []
	const errors: Record<string, unknown>[] = []
	const held: (() => void)[] = []
	let calls = 0
	let inFlight = 0
	let maxInFlight = 0
	const log = pino(
		{ level: "info" },
		{
			write(line: string) {
				const entry = JSON.parse(line) as Record<string, unknown>
				if (entry["level"] === 40) warns.push(entry)
				if (entry["level"] === 50) errors.push(entry)
			},
		},
	)
	const life = startActivityLifecycle({
		enabled: true,
		stateDir: "/unused",
		logger: log,
		discloseErrors: false,
		setPublisher: p => {
			publishers.push(p)
		},
		now: () => clock.now,
		timers: fakeTimers(clock),
		attempt: async options => {
			const outcome = outcomes[Math.min(calls, outcomes.length - 1)]!
			calls += 1
			inFlight += 1
			maxInFlight = Math.max(maxInFlight, inFlight)
			if (opts.hold === true)
				await new Promise<void>(resolve => {
					held.push(resolve)
				})
			inFlight -= 1
			return outcome.kind === "ready"
				? ready(options.setPublisher, opened)
				: failed(outcome.reason, outcome.retryable, options.setPublisher)
		},
	})
	return {
		life,
		clock,
		opened,
		publishers,
		warns,
		errors,
		held,
		calls: () => calls,
		maxInFlight: () => maxInFlight,
	}
}

const timeout: Outcome = {
	kind: "fail",
	reason: "ACTIVITY_OPEN_TIMEOUT",
	retryable: true,
}

describe("activity lifecycle", () => {
	it("starts opening without blocking, then reports available", async () => {
		const h = harness([{ kind: "ready" }], { hold: true })
		expect(h.life.lifecycle()).toEqual({
			state: "opening",
			reason: null,
			attempts: 1,
			nextAttemptAt: null,
			droppedWhileClosed: 0,
		})
		expect(h.life.status).toBe("unavailable")
		h.held.shift()!()
		await h.life.settled()
		expect(h.life.lifecycle().state).toBe("available")
		expect(h.life.status).toBe("ready")
		expect(h.life.api.stats().lifecycle).toEqual({
			state: "available",
			reason: null,
			attempts: 1,
			nextAttemptAt: null,
			droppedWhileClosed: 0,
		})
		expect(h.life.api.stats().rows).toBe(2)
		await h.life.close()
		expect(h.opened[0]!.closed).toBe(1)
	})

	it("retries a timed-out open and opens on the retry", async () => {
		const h = harness([timeout, { kind: "ready" }])
		await h.life.settled()
		expect(h.life.lifecycle()).toEqual({
			state: "retrying",
			reason: "ACTIVITY_OPEN_TIMEOUT",
			attempts: 1,
			nextAttemptAt: new Date(T0 + 5_000).toISOString(),
			droppedWhileClosed: 0,
		})
		// One warn per failed attempt, with the code only.
		expect(h.warns).toHaveLength(1)
		expect(h.warns[0]).toMatchObject({
			code: "ACTIVITY_OPEN_TIMEOUT",
			attempt: 1,
			retryInMs: 5_000,
		})
		expect(JSON.stringify(h.warns)).not.toContain("secret")
		await advance(h.clock, 4_999)
		expect(h.calls()).toBe(1)
		await advance(h.clock, 1)
		expect(h.calls()).toBe(2)
		expect(h.life.lifecycle()).toMatchObject({
			state: "available",
			reason: null,
			attempts: 2,
		})
		await h.life.close()
	})

	it("keeps a persistent failure bounded: 5 s, 15 s, 60 s, then every 5 minutes", async () => {
		const h = harness([
			{ kind: "fail", reason: "ACTIVITY_STORE_LOCKED", retryable: true },
		])
		await h.life.settled()
		const gaps: number[] = []
		let last = h.clock.now
		for (let attempt = 2; attempt <= 7; attempt++) {
			const next = Date.parse(h.life.lifecycle().nextAttemptAt!)
			gaps.push(next - last)
			await advance(h.clock, next - h.clock.now)
			expect(h.calls()).toBe(attempt)
			last = next
		}
		expect(gaps).toEqual([
			...ACTIVITY_RETRY_DELAYS_MS,
			ACTIVITY_RETRY_STEADY_MS,
			ACTIVITY_RETRY_STEADY_MS,
			ACTIVITY_RETRY_STEADY_MS,
		])
		// At most one pending timer and one warn per failed attempt.
		expect(h.clock.timers).toHaveLength(1)
		expect(h.warns).toHaveLength(7)
		// A day at the steady cadence: 288 attempts, never more.
		const before = h.calls()
		await advance(h.clock, 24 * 60 * 60 * 1000)
		expect(h.calls() - before).toBe(288)
		await h.life.close()
		expect(h.clock.timers).toHaveLength(0)
	})

	it("does not retry a failure another attempt cannot fix", async () => {
		const h = harness([
			{ kind: "fail", reason: "ACTIVITY_SCHEMA_MISMATCH", retryable: false },
		])
		await h.life.settled()
		expect(h.life.lifecycle()).toEqual({
			state: "unavailable",
			reason: "ACTIVITY_SCHEMA_MISMATCH",
			attempts: 1,
			nextAttemptAt: null,
			droppedWhileClosed: 0,
		})
		expect(h.clock.timers).toHaveLength(0)
		await advance(h.clock, 60 * 60 * 1000)
		expect(h.calls()).toBe(1)
		expect(h.errors).toHaveLength(1)
		// Protected mode: the code, never the message.
		expect(h.errors[0]).toMatchObject({ code: "ACTIVITY_SCHEMA_MISMATCH" })
		expect(JSON.stringify(h.errors)).not.toContain("secret")
		await h.life.close()
	})

	it("close while waiting for a retry cancels it", async () => {
		const h = harness([timeout])
		await h.life.settled()
		expect(h.clock.timers).toHaveLength(1)
		await h.life.close()
		expect(h.clock.timers).toHaveLength(0)
		await advance(h.clock, 10 * 60 * 1000)
		expect(h.calls()).toBe(1)
		expect(h.publishers.at(-1)).toBeNull()
	})

	it("close during an attempt closes the store it opens", async () => {
		const h = harness([{ kind: "ready" }], { hold: true })
		const closing = h.life.close()
		h.held.shift()!()
		await closing
		expect(h.opened).toHaveLength(1)
		expect(h.opened[0]!.closed).toBe(1)
		expect(h.life.status).toBe("unavailable")
		expect(h.publishers.at(-1)).toBeNull()
		await h.life.close()
		expect(h.opened[0]!.closed).toBe(1)
	})

	it("never runs two attempts at once and never opens twice", async () => {
		const h = harness([timeout, { kind: "ready" }], { hold: true })
		h.held.shift()!()
		await h.life.settled()
		await advance(h.clock, 5_000)
		expect(h.life.lifecycle().state).toBe("opening")
		// Time passes while the retry is held: no second attempt starts.
		await advance(h.clock, ACTIVITY_RETRY_STEADY_MS * 3)
		expect(h.calls()).toBe(2)
		h.held.shift()!()
		await h.life.settled()
		await advance(h.clock, ACTIVITY_RETRY_STEADY_MS * 3)
		expect(h.calls()).toBe(2)
		expect(h.maxInFlight()).toBe(1)
		expect(h.opened).toHaveLength(1)
		await h.life.close()
	})

	it("counts receptions and transmissions dropped while the store is not open", async () => {
		const h = harness([timeout, { kind: "ready" }])
		await h.life.settled()
		const counting = h.publishers.at(-1)
		expect(counting).toBeTypeOf("function")
		counting!("dec", "pocsag", { type: "page" } as never)
		counting!("dec", "pocsag", { type: "page" } as never)
		const sink = h.life.transmissionSink()
		expect(sink).not.toBeNull()
		sink!({} as AnalogTransmissionPayload)
		expect(h.life.lifecycle().droppedWhileClosed).toBe(3)
		await advance(h.clock, 5_000)
		// Open: the same sink now reaches the store.
		sink!({ transmissionId: "t" } as AnalogTransmissionPayload)
		expect(h.opened[0]!.admitted).toHaveLength(1)
		expect(h.life.lifecycle().droppedWhileClosed).toBe(3)
		await h.life.close()
		expect(h.life.transmissionSink()).toBeNull()
	})

	it("answers queries with a 503 carrying the code until the store opens", async () => {
		const h = harness([timeout, { kind: "ready" }])
		await h.life.settled()
		const service = h.life.api.service
		const error = await service
			.search({ query: {} } as never)
			.catch((e: unknown) => e)
		expect(error).toBeInstanceOf(ActivityQueryError)
		expect(error).toMatchObject({
			statusCode: 503,
			code: "ACTIVITY_UNAVAILABLE",
			reason: "ACTIVITY_OPEN_TIMEOUT",
			message: ACTIVITY_NOT_OPEN_MESSAGE,
		})
		expect(() =>
			service.replay({ query: {} } as never, { send: () => true }),
		).toThrow(ActivityQueryError)
		// The status view never throws: idle counters plus the lifecycle.
		expect(h.life.api.status).toBe("ready")
		expect(h.life.api.stats()).toMatchObject({
			rows: 0,
			writer: "stopped",
			lifecycle: { state: "retrying", reason: "ACTIVITY_OPEN_TIMEOUT" },
		})
		// The runtime's own stats (storage report) still throw while closed.
		expect(() => h.life.stats()).toThrow()
		await advance(h.clock, 5_000)
		await expect(service.search({ query: {} } as never)).resolves.toMatchObject(
			{ items: [] },
		)
		await h.life.close()
	})

	it("disabled constructs nothing and stays disabled", async () => {
		let attempts = 0
		const life = startActivityLifecycle({
			enabled: false,
			stateDir: "/unused",
			logger: pino({ level: "silent" }),
			setPublisher: () => {
				throw new Error("disabled must not publish")
			},
			attempt: async () => {
				attempts += 1
				throw new Error("disabled must not open")
			},
		})
		expect(life.status).toBe("disabled")
		expect(life.api.status).toBe("disabled")
		expect(life.transmissionSink()).toBeNull()
		await life.close()
		expect(attempts).toBe(0)
	})
})

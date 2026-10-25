import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { QueryAdmission } from "../../../../../src/core/activity/query/admission.js"
import {
	ActivityQueryBusyError,
	ActivityQueryClosedError,
} from "../../../../../src/core/activity/query/errors.js"

type Outcome =
	| { state: "pending" }
	| { state: "granted"; release: () => void }
	| { state: "refused"; error: unknown }

interface Tracked {
	client: string
	outcome: Outcome
}

/** Starts an acquire and records how it settles. */
function track(admission: QueryAdmission, client: string): Tracked {
	const tracked: Tracked = { client, outcome: { state: "pending" } }
	admission.acquire(client).then(
		release => {
			tracked.outcome = { state: "granted", release }
		},
		(error: unknown) => {
			tracked.outcome = { state: "refused", error }
		},
	)
	return tracked
}

const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve))

function grantOrder(all: Tracked[], grants: string[]): void {
	for (const item of all) {
		if (item.outcome.state === "granted" && !grants.includes(item.client)) {
			grants.push(item.client)
		}
	}
}

function releaseGranted(item: Tracked): void {
	if (item.outcome.state !== "granted") throw new Error("not granted")
	item.outcome.release()
}

describe("QueryAdmission queueing", () => {
	it("queues a burst from one client and grants it in arrival order", async () => {
		const admission = new QueryAdmission(1, 8, 4)
		const burst = [0, 1, 2].map(() => track(admission, "web"))
		await flush()
		expect(burst.map(item => item.outcome.state)).toEqual([
			"granted",
			"pending",
			"pending",
		])
		releaseGranted(burst[0]!)
		await flush()
		expect(burst.map(item => item.outcome.state)).toEqual([
			"granted",
			"granted",
			"pending",
		])
		releaseGranted(burst[1]!)
		await flush()
		expect(burst[2]!.outcome.state).toBe("granted")
		releaseGranted(burst[2]!)
		expect(admission.snapshot()).toEqual({
			executing: 0,
			queued: 0,
			inFlight: {},
			queuedByClient: {},
		})
	})

	it("refuses a client past its in-flight cap while others still queue", async () => {
		const admission = new QueryAdmission(1, 8, 2)
		const own = [track(admission, "a"), track(admission, "a")]
		const third = track(admission, "a")
		const other = track(admission, "b")
		await flush()
		expect(third.outcome.state).toBe("refused")
		if (third.outcome.state === "refused") {
			expect(third.outcome.error).toBeInstanceOf(ActivityQueryBusyError)
		}
		expect(own.map(item => item.outcome.state)).toEqual(["granted", "pending"])
		expect(other.outcome.state).toBe("pending")
		expect(admission.snapshot().inFlight).toEqual({ a: 2, b: 1 })
	})

	it("refuses only when the shared queue is full", async () => {
		const admission = new QueryAdmission(1, 2, 4)
		const running = track(admission, "a")
		const queued = [track(admission, "b"), track(admission, "c")]
		const overflow = track(admission, "d")
		await flush()
		expect(running.outcome.state).toBe("granted")
		expect(queued.map(item => item.outcome.state)).toEqual([
			"pending",
			"pending",
		])
		expect(overflow.outcome.state).toBe("refused")
		if (overflow.outcome.state === "refused") {
			expect(overflow.outcome.error).toBeInstanceOf(ActivityQueryBusyError)
		}
	})

	it("serves queued clients round robin so one burst cannot starve another", async () => {
		const admission = new QueryAdmission(1, 8, 4)
		const all = [
			track(admission, "a"),
			track(admission, "a"),
			track(admission, "a"),
			track(admission, "a"),
			track(admission, "b"),
		]
		const served: number[] = []
		await flush()
		for (let step = 0; step < all.length; step += 1) {
			const index = all.findIndex(
				(item, position) =>
					item.outcome.state === "granted" && !served.includes(position),
			)
			if (index < 0) break
			served.push(index)
			releaseGranted(all[index]!)
			await flush()
		}
		// Request 0 ran at once; b's only request is served right after a's next one.
		expect(served).toEqual([0, 1, 4, 2, 3])
	})

	it("rejects queued requests on close and refuses later ones", async () => {
		const admission = new QueryAdmission(1, 8, 4)
		const running = track(admission, "a")
		const queued = [track(admission, "a"), track(admission, "b")]
		await flush()
		admission.close()
		await flush()
		for (const item of queued) {
			expect(item.outcome.state).toBe("refused")
			if (item.outcome.state === "refused") {
				expect(item.outcome.error).toBeInstanceOf(ActivityQueryClosedError)
			}
		}
		const late = track(admission, "c")
		await flush()
		expect(late.outcome.state).toBe("refused")
		releaseGranted(running)
		expect(admission.snapshot()).toEqual({
			executing: 0,
			queued: 0,
			inFlight: {},
			queuedByClient: {},
		})
	})

	it("counts a repeated release once", async () => {
		const admission = new QueryAdmission(1, 8, 4)
		const first = track(admission, "a")
		const second = track(admission, "b")
		await flush()
		releaseGranted(first)
		releaseGranted(first)
		releaseGranted(first)
		await flush()
		expect(second.outcome.state).toBe("granted")
		expect(admission.snapshot()).toMatchObject({
			executing: 1,
			queued: 0,
			inFlight: { b: 1 },
		})
		releaseGranted(second)
		expect(admission.snapshot().executing).toBe(0)
	})

	it("grants every queued slot when more than one reader may execute", async () => {
		const admission = new QueryAdmission(2, 8, 4)
		const all = [
			track(admission, "a"),
			track(admission, "b"),
			track(admission, "c"),
		]
		const grants: string[] = []
		await flush()
		grantOrder(all, grants)
		expect(grants).toEqual(["a", "b"])
		releaseGranted(all[0]!)
		await flush()
		grantOrder(all, grants)
		expect(grants).toEqual(["a", "b", "c"])
	})
})

type Step =
	| { kind: "acquire"; client: number }
	| { kind: "release"; pick: number }
	| { kind: "release-again"; pick: number }
	| { kind: "close" }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
	{
		weight: 6,
		arbitrary: fc.record({
			kind: fc.constant("acquire" as const),
			client: fc.nat(3),
		}),
	},
	{
		weight: 4,
		arbitrary: fc.record({
			kind: fc.constant("release" as const),
			pick: fc.nat(20),
		}),
	},
	{
		weight: 1,
		arbitrary: fc.record({
			kind: fc.constant("release-again" as const),
			pick: fc.nat(20),
		}),
	},
	{ weight: 1, arbitrary: fc.record({ kind: fc.constant("close" as const) }) },
)

describe("QueryAdmission invariants", () => {
	// Feature: activity-recording-catalog, Property 5: Bounded failure
	// Validates: Requirements 2.3, 7.2
	it("keeps executing, queued and per-client counts bounded and consistent", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 3 }),
				fc.integer({ min: 0, max: 8 }),
				fc.integer({ min: 1, max: 4 }),
				fc.array(stepArb, { maxLength: 60 }),
				async (maxExecuting, maxQueued, maxPerClient, steps) => {
					const admission = new QueryAdmission(
						maxExecuting,
						maxQueued,
						maxPerClient,
					)
					const all: Tracked[] = []
					const released = new Set<Tracked>()
					const grantOrderByClient = new Map<string, Tracked[]>()
					for (const step of steps) {
						if (step.kind === "acquire") {
							const item = track(admission, `c${step.client}`)
							all.push(item)
							const list = grantOrderByClient.get(item.client) ?? []
							list.push(item)
							grantOrderByClient.set(item.client, list)
						} else if (step.kind === "close") {
							admission.close()
						} else {
							const live = all.filter(
								item =>
									item.outcome.state === "granted" &&
									(step.kind === "release-again" || !released.has(item)),
							)
							const item = live[step.pick % Math.max(1, live.length)]
							if (item?.outcome.state === "granted") {
								item.outcome.release()
								released.add(item)
							}
						}
						await flush()

						const snap = admission.snapshot()
						const executing = all.filter(
							item => item.outcome.state === "granted" && !released.has(item),
						)
						const pending = all.filter(item => item.outcome.state === "pending")
						expect(snap.executing).toBe(executing.length)
						expect(snap.executing).toBeLessThanOrEqual(maxExecuting)
						expect(snap.queued).toBe(pending.length)
						expect(snap.queued).toBeLessThanOrEqual(maxQueued)
						const expected: Record<string, number> = {}
						for (const item of [...executing, ...pending]) {
							expected[item.client] = (expected[item.client] ?? 0) + 1
						}
						expect(snap.inFlight).toEqual(expected)
						for (const count of Object.values(snap.inFlight)) {
							expect(count).toBeGreaterThan(0)
							expect(count).toBeLessThanOrEqual(maxPerClient)
						}
						const queuedSum = Object.values(snap.queuedByClient).reduce(
							(sum, count) => sum + count,
							0,
						)
						expect(queuedSum).toBe(snap.queued)
						// Work-conserving: nothing waits while a reader slot is free.
						if (snap.queued > 0) expect(snap.executing).toBe(maxExecuting)
						// A client's requests are granted in arrival order.
						for (const list of grantOrderByClient.values()) {
							const states = list
								.filter(item => item.outcome.state !== "refused")
								.map(item => item.outcome.state)
							const firstPending = states.indexOf("pending")
							if (firstPending >= 0) {
								expect(
									states.slice(firstPending).every(s => s === "pending"),
								).toBe(true)
							}
						}
					}
				},
			),
			{ numRuns: 150 },
		)
	})
})

/**
 * WG19 reader deadline semantics, on fake timers (no wall clock): the deadline covers one
 * admitted read, never its wait in the admission queue, and an expired timer gives a reply
 * that is already due one more loop turn before the read is declared late.
 */
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { raceDeadline } from "../../../../../src/core/activity/query/deadline.js"
import {
	ActivityQueryTimeoutError,
	ActivityReaderFailedError,
} from "../../../../../src/core/activity/query/errors.js"
import { withActivityClient } from "../../../../../src/core/activity/query/service.js"
import type { ReaderHostEvent } from "../../../../../src/core/activity/query/reader-host.js"
import { createFixture, openQueryService } from "./fixture.js"

/** A reply that lands `ms` after it is armed, on the (fake) timer queue. */
function replyAfter<T>(ms: number, value: T): Promise<T> {
	return new Promise(resolve => {
		setTimeout(() => {
			resolve(value)
		}, ms)
	})
}

describe("raceDeadline", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("resolves a reply before the deadline and leaves no timer behind", async () => {
		const onExpire = vi.fn()
		const raced = raceDeadline(replyAfter(249, "ok"), 250, onExpire)
		await vi.advanceTimersByTimeAsync(249)
		await expect(raced).resolves.toBe("ok")
		expect(onExpire).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("keeps a reply that is due in the same turn as the deadline (blocked main thread)", async () => {
		const onExpire = vi.fn()
		let answer: (value: string) => void = () => {}
		const reply = new Promise<string>(resolve => {
			answer = resolve
		})
		// The deadline timer is armed before the reply's, so it runs first in the same turn:
		// without the grace turn this times out.
		const raced = raceDeadline(reply, 250, onExpire)
		setTimeout(() => {
			answer("ok")
		}, 250)
		await vi.advanceTimersByTimeAsync(250)
		await expect(raced).resolves.toBe("ok")
		expect(onExpire).not.toHaveBeenCalled()
		expect(vi.getTimerCount()).toBe(0)
	})

	it("times out a reply one millisecond past the deadline and expires once", async () => {
		const onExpire = vi.fn()
		const raced = raceDeadline(replyAfter(251, "late"), 250, onExpire)
		const caught = raced.catch((error: unknown) => error)
		await vi.advanceTimersByTimeAsync(251)
		expect(await caught).toBeInstanceOf(ActivityQueryTimeoutError)
		expect(onExpire).toHaveBeenCalledTimes(1)
	})

	it("times out a read that never answers", async () => {
		const onExpire = vi.fn()
		const raced = raceDeadline(new Promise<never>(() => {}), 250, onExpire)
		const caught = raced.catch((error: unknown) => error)
		await vi.advanceTimersByTimeAsync(250)
		// Still inside the grace turn: the immediate has not run yet.
		expect(onExpire).not.toHaveBeenCalled()
		await vi.advanceTimersByTimeAsync(1)
		expect(await caught).toBeInstanceOf(ActivityQueryTimeoutError)
		expect(onExpire).toHaveBeenCalledTimes(1)
	})

	it("passes a reader error through and wraps a non-Error rejection", async () => {
		const failure = new ActivityReaderFailedError("boom")
		await expect(
			raceDeadline(Promise.reject(failure), 250, () => {}),
		).rejects.toBe(failure)
		await expect(
			raceDeadline(Promise.reject(new Error("x")), 250, () => {}),
		).rejects.toThrow("x")
		await expect(
			raceDeadline(Promise.reject("text"), 250, () => {}),
		).rejects.toBeInstanceOf(ActivityReaderFailedError)
		expect(vi.getTimerCount()).toBe(0)
	})

	it("settles exactly once: on time when the reply is due by the deadline, timed out after", async () => {
		// Feature: wg19-le, Property 1: deadline outcome by reply time
		// Validates: Requirements B.2
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 2_000 }),
				fc.integer({ min: 0, max: 4_000 }),
				async (deadlineMs, replyMs) => {
					const onExpire = vi.fn()
					const raced = raceDeadline(
						replyAfter(replyMs, "ok"),
						deadlineMs,
						onExpire,
					)
					const outcome = raced.then(
						() => "ok",
						(error: unknown) => error,
					)
					await vi.advanceTimersByTimeAsync(Math.max(replyMs, deadlineMs) + 1)
					const result = await outcome
					if (replyMs <= deadlineMs) {
						expect(result).toBe("ok")
						expect(onExpire).not.toHaveBeenCalled()
					} else {
						expect(result).toBeInstanceOf(ActivityQueryTimeoutError)
						expect(onExpire).toHaveBeenCalledTimes(1)
					}
					vi.clearAllTimers()
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("activity query deadline against the admission queue", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("does not count queue wait: four 200 ms reads behind one another meet a 250 ms deadline", async () => {
		const fixture = await createFixture()
		fixture.insert({ eventId: "kept" })
		const events: ReaderHostEvent[] = []
		// Fake setTimeout only: the inline reader's import and SQLite run for real, and real
		// immediates let them finish between fake-clock steps.
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const service = openQueryService(fixture, {
			readerDelayMs: 200,
			limits: { deadlineMs: 250 },
			onReaderEvent: event => {
				events.push(event)
			},
		})
		try {
			const outcomes = [0, 1, 2, 3].map(() =>
				withActivityClient("burst", () => service.search({ query: {} })).then(
					page => page.items.length,
					(error: unknown) => error,
				),
			)
			// Four serial turns of 200 ms: the last one waits 600 ms in the queue first.
			for (let step = 0; step < 100; step += 1) {
				await vi.advanceTimersByTimeAsync(10)
				await new Promise(resolve => {
					setImmediate(resolve)
				})
			}
			expect(await Promise.all(outcomes)).toEqual([1, 1, 1, 1])
			expect(events.filter(event => event.type === "terminate")).toEqual([])
		} finally {
			vi.useRealTimers()
			await service.close()
			await fixture.close()
		}
	})

	it("still times out a read whose own execution passes the deadline", async () => {
		const fixture = await createFixture()
		fixture.insert({ eventId: "kept" })
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
		const service = openQueryService(fixture, {
			readerDelayMs: 251,
			limits: { deadlineMs: 250 },
		})
		try {
			const outcome = withActivityClient("one", () =>
				service.search({ query: {} }),
			).then(
				() => "ok",
				(error: unknown) => error,
			)
			for (let step = 0; step < 40; step += 1) {
				await vi.advanceTimersByTimeAsync(10)
				await new Promise(resolve => {
					setImmediate(resolve)
				})
			}
			expect(await outcome).toBeInstanceOf(ActivityQueryTimeoutError)
		} finally {
			vi.useRealTimers()
			await service.close()
			await fixture.close()
		}
	})
})

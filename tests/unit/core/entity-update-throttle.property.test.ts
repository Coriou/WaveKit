/**
 * Throttle timeline invariants (WG2 req 9). Assertions stay outside `emit`:
 * the throttle catches exceptions from that callback.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import * as fc from "fast-check"
import { EntityUpdateThrottle } from "../../../src/core/entity-update-throttle.js"

interface Offer {
	seq: number
	identity: string
	at: number
	cleared: boolean
	clearAt: number
}

interface Emission {
	key: string
	seq: number
	identity: string
	at: number
}

describe("throttle timeline", () => {
	afterEach(() => {
		vi.useRealTimers()
	})

	it("spaces same-identity updates, emits identity changes at once, and delivers the latest", () => {
		// Feature: web-gaps-2, Property 13: Throttle
		// Validates: Requirements 9.1, 9.2, 9.3
		fc.assert(
			fc.property(
				fc.integer({ min: 1, max: 20 }),
				fc.array(
					fc.record({
						dt: fc.integer({ min: 0, max: 25 }),
						key: fc.integer({ min: 0, max: 3 }),
						flip: fc.boolean(),
						action: fc.constantFrom(
							"offer",
							"offer",
							"offer",
							"offer",
							"clear",
							"stop",
						),
					}),
					{ minLength: 1, maxLength: 24 },
				),
				(windowMs, ops) => {
					vi.useFakeTimers()
					vi.setSystemTime(0)
					const emissions: Emission[] = []
					const throttle = new EntityUpdateThrottle<{
						seq: number
						identity: string
					}>({
						windowMs,
						identity: state => state.identity,
						emit: (key, state) => {
							emissions.push({
								key,
								seq: state.seq,
								identity: state.identity,
								at: Date.now(),
							})
						},
					})
					const latest = new Map<string, Offer>()
					const openIdentity = new Map<string, string>()
					const lastEmitAt = new Map<string, number>()
					const identityOf = new Map<string, string>()
					const seqOf = new Map<string, number>()
					let stopped = false
					let seen = 0

					const take = () => {
						const fresh = emissions.slice(seen)
						seen = emissions.length
						for (const emission of fresh) {
							const offer = latest.get(emission.key)
							expect(offer).toBeDefined()
							if (!offer) continue
							expect(emission.seq).toBe(offer.seq)
							expect(emission.identity).toBe(offer.identity)
							expect(emission.at).toBeLessThanOrEqual(offer.at + windowMs)
							if (offer.cleared) {
								expect(emission.at).toBeLessThanOrEqual(offer.clearAt)
							}
							const open = openIdentity.get(emission.key)
							if (open === emission.identity) {
								const prev = lastEmitAt.get(emission.key)
								expect(prev).toBeDefined()
								expect(emission.at - prev!).toBeGreaterThanOrEqual(windowMs)
							} else if (open !== undefined) {
								expect(emission.at).toBe(offer.at)
							}
							openIdentity.set(emission.key, emission.identity)
							lastEmitAt.set(emission.key, emission.at)
						}
						expect(throttle.pending()).toBeLessThanOrEqual(throttle.size())
					}

					try {
						for (const op of ops) {
							if (op.dt > 0) vi.advanceTimersByTime(op.dt)
							take()
							const key = String(op.key)
							if (stopped || op.action === "stop") {
								const before = emissions.length
								if (op.action === "stop") throttle.stop()
								else if (op.action === "clear") throttle.clear(key)
								else throttle.offer(key, { seq: 0, identity: "a" })
								stopped = true
								expect(emissions).toHaveLength(before)
								expect(throttle.size()).toBe(0)
								expect(throttle.pending()).toBe(0)
								continue
							}
							if (op.action === "clear") {
								throttle.clear(key)
								const current = latest.get(key)
								if (current) {
									current.cleared = true
									current.clearAt = Date.now()
								}
								openIdentity.delete(key)
								lastEmitAt.delete(key)
								take()
								continue
							}
							const seq = (seqOf.get(key) ?? 0) + 1
							seqOf.set(key, seq)
							const previous = identityOf.get(key) ?? "a"
							const identity = op.flip
								? previous === "a"
									? "b"
									: "a"
								: previous
							identityOf.set(key, identity)
							const at = Date.now()
							latest.set(key, {
								seq,
								identity,
								at,
								cleared: false,
								clearAt: 0,
							})
							throttle.offer(key, { seq, identity })
							take()
						}
						if (!stopped) vi.advanceTimersByTime(windowMs)
						take()
						if (stopped) {
							const before = emissions.length
							vi.advanceTimersByTime(windowMs)
							expect(emissions).toHaveLength(before)
							return
						}
						for (const [key, offer] of latest) {
							const hits = emissions.filter(
								emission => emission.key === key && emission.seq === offer.seq,
							)
							if (offer.cleared) {
								expect(
									hits.every(emission => emission.at <= offer.clearAt),
								).toBe(true)
								continue
							}
							expect(hits).toHaveLength(1)
							expect(hits[0]!.at).toBeLessThanOrEqual(offer.at + windowMs)
							const stale = emissions.filter(
								emission =>
									emission.key === key &&
									emission.seq < offer.seq &&
									emission.at > offer.at,
							)
							expect(stale).toHaveLength(0)
						}
					} finally {
						throttle.stop()
						vi.useRealTimers()
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

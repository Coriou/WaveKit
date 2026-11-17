import fc from "fast-check"
import { expect, it, vi } from "vitest"
import { DecoderObservability } from "../../../src/decoders/decoder-observability.js"

/** The previous counter: prune on every call, history built on every count. */
class Reference {
	private readonly buckets = new Map<number, number>()
	constructor(private readonly clock: () => number) {}
	count(): void {
		const minute = Math.floor(this.clock() / 60_000)
		this.history()
		this.buckets.set(minute, (this.buckets.get(minute) ?? 0) + 1)
	}
	history(): number[] {
		const minute = Math.floor(this.clock() / 60_000)
		for (const key of this.buckets.keys())
			if (key < minute - 14 || key > minute) this.buckets.delete(key)
		return Array.from(
			{ length: 15 },
			(_, i) => this.buckets.get(minute - 14 + i) ?? 0,
		)
	}
}

it("counts and reports the same history as pruning on every call, for any clock", () => {
	fc.assert(
		fc.property(
			fc.array(
				fc.record({
					// Steps forward and back, within and across minutes and the 15-minute window.
					stepMs: fc.integer({ min: -20 * 60_000, max: 20 * 60_000 }),
					read: fc.boolean(),
				}),
				{ maxLength: 80 },
			),
			ops => {
				let now = 1_700_000_000_000
				const clock = () => now
				const counter = new DecoderObservability(clock)
				const reference = new Reference(clock)
				for (const op of ops) {
					now += op.stepMs
					if (op.read)
						expect(counter.getRateHistory()).toEqual(reference.history())
					else {
						expect(counter.countOutput().getTime()).toBe(now)
						reference.count()
					}
				}
				expect(counter.getRateHistory()).toEqual(reference.history())
			},
		),
		{ numRuns: 200 },
	)
})

it("a count builds no history array", () => {
	const counter = new DecoderObservability(() => 0)
	const history = vi.spyOn(counter, "getRateHistory")
	for (let i = 0; i < 10; i++) counter.countOutput()
	expect(history).not.toHaveBeenCalled()
	expect(counter.getRateHistory().at(-1)).toBe(10)
})

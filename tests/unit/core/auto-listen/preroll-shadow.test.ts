import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { PreRollShadow } from "../../../../src/core/auto-listen/preroll-shadow.js"
import type {
	EvidencePcmFormat,
	PreRollTag,
} from "../../../../src/core/evidence-squelch/contract.js"
import { PreRoll } from "../../../../src/core/evidence-squelch/pre-roll.js"
import { WaveKitError } from "../../../../src/utils/errors.js"

type Op =
	| { kind: "process"; bytes: number; tag: PreRollTag }
	| { kind: "latch" | "abandon" | "clear" }

const tagArb = fc.constantFrom<PreRollTag>("pending", "pass", "guard", "drop")

/** Phases of one tag (to fill and overflow the FIFO) mixed with latch, abandon and clear. */
const opsArb = fc
	.array(
		fc.oneof(
			{
				weight: 8,
				arbitrary: fc
					.tuple(
						tagArb,
						fc.array(fc.integer({ min: 0, max: 900 }), {
							minLength: 1,
							maxLength: 6,
						}),
					)
					.map(([tag, sizes]) =>
						sizes.map((bytes): Op => ({ kind: "process", bytes, tag })),
					),
			},
			{
				weight: 2,
				arbitrary: fc
					.constantFrom("latch" as const, "abandon" as const, "clear" as const)
					.map((kind): Op[] => [{ kind }]),
			},
		),
		{ maxLength: 40 },
	)
	.map(groups => groups.flat())

const configArb = fc.record({
	rate: fc.constantFrom(100, 400, 1_000, 25_000),
	format: fc.constantFrom<EvidencePcmFormat>("s16le", "f32le"),
})

interface Step {
	/** Per output byte: the real pre-roll wrote a non-zero (queued or own) byte. */
	real: boolean[]
	/** Per output byte: the shadow says it plays. */
	shadow: boolean[]
	realDelay: number
	inSync: boolean
}

/** Drives the real pre-roll with a non-zero byte ramp and the shadow with the same calls. */
function drive(
	pre: PreRoll,
	shadow: PreRollShadow,
	op: Op,
	counter: { n: number },
	inject = false,
): Step {
	const real: boolean[] = []
	const plays: boolean[] = []
	if (op.kind === "process") {
		const chunk = Buffer.alloc(op.bytes)
		for (let i = 0; i < op.bytes; i++) chunk[i] = 1 + ((counter.n + i) % 255)
		counter.n += op.bytes
		pre.process(chunk, 0, chunk.length, op.tag)
		const runs = shadow.process(op.bytes, op.tag)
		for (const b of chunk) real.push(b !== 0)
		for (let r = 0; r < runs; r++)
			for (let k = 0; k < shadow.runBytes(r); k++)
				plays.push(shadow.runPlays(r))
	} else {
		pre[op.kind]()
		shadow[op.kind]()
	}
	const inSync = shadow.sync(inject ? pre.delaySamples + 1 : pre.delaySamples)
	return { real, shadow: plays, realDelay: pre.delaySamples, inSync }
}

describe("PreRollShadow", () => {
	it("validates options like the pre-roll", () => {
		expect(() => new PreRollShadow({ rate: 0, format: "s16le" })).toThrow(
			WaveKitError,
		)
		expect(
			() =>
				new PreRollShadow({ rate: 8_000, format: "u8" as EvidencePcmFormat }),
		).toThrow(WaveKitError)
		const s = new PreRollShadow({ rate: 8_000, format: "s16le" })
		expect(s.capacitySamples).toBe(
			new PreRoll({ rate: 8_000, format: "s16le" }).capacitySamples,
		)
	})

	it("plays latched pre-roll audio delayed and mutes abandoned audio", () => {
		const s = new PreRollShadow({ rate: 1_000, format: "s16le" })
		expect(s.process(200, "pending")).toBe(1)
		expect(s.runPlays(0)).toBe(false)
		expect(s.delaySamples).toBe(100)
		s.latch()
		expect(s.process(100, "pass")).toBe(1)
		expect(s.runPlays(0)).toBe(true)
		expect(s.delaySamples).toBe(100)
		// Stage 1 closes: the queue drains (plays), the new samples are dropped.
		s.process(400, "drop")
		expect(s.runCountOut).toBe(2)
		expect([s.runPlays(0), s.runBytes(0)]).toEqual([true, 200])
		expect([s.runPlays(1), s.runBytes(1)]).toEqual([false, 200])
		expect(s.delaySamples).toBe(0)
		s.process(50, "pending")
		s.abandon()
		s.process(50, "drop")
		expect(s.runPlays(0)).toBe(false)
	})

	it("treats unknown tags as drop and malformed sizes as empty", () => {
		const s = new PreRollShadow({ rate: 1_000, format: "s16le" })
		s.process(10, "bogus" as PreRollTag)
		expect(s.runPlays(0)).toBe(false)
		expect(s.process(Number.NaN, "pass")).toBe(0)
		expect(s.process(-4, "pass")).toBe(0)
		expect(s.runBytes(5)).toBe(0)
		expect(s.runPlays(-1)).toBe(false)
	})

	it("fails closed on a mismatch until the pre-roll is empty", () => {
		const s = new PreRollShadow({ rate: 1_000, format: "s16le" })
		s.process(20, "pending")
		expect(s.sync(3)).toBe(false)
		expect(s.failed).toBe(true)
		expect(s.mismatches).toBe(1)
		s.latch()
		s.process(20, "pass")
		expect(s.runPlays(0)).toBe(false)
		expect(s.sync(10)).toBe(false)
		expect(s.sync(0)).toBe(false)
		expect(s.failed).toBe(false)
		expect(s.delaySamples).toBe(0)
		s.process(20, "pass")
		expect(s.runPlays(0)).toBe(true)
		expect(s.sync(0)).toBe(true)
	})

	// Feature: auto-listen-route, Property 9: Pre-roll shadow equivalence
	// Validates: Requirements 3.6
	it("plays exactly the pre-roll's non-zero output bytes, with equal delays", () => {
		fc.assert(
			fc.property(configArb, opsArb, (config, ops) => {
				const pre = new PreRoll(config)
				const shadow = new PreRollShadow(config)
				const counter = { n: 0 }
				for (const op of ops) {
					const step = drive(pre, shadow, op, counter)
					expect(step.shadow).toEqual(step.real)
					expect(step.inSync).toBe(true)
					expect(shadow.delaySamples).toBe(pre.delaySamples)
				}
				expect(shadow.mismatches).toBe(0)
			}),
			{ numRuns: 200 },
		)
	})

	// Feature: auto-listen-route, Property 15: Shadow from any start
	// Validates: Requirements 3.6, 3.7
	it("qualifies exactly from any connect instant and resyncs after a mismatch", () => {
		fc.assert(
			fc.property(
				configArb,
				opsArb,
				fc.nat(),
				fc.nat(),
				(config, ops, connectSeed, faultSeed) => {
					const width = config.format === "s16le" ? 2 : 4
					const connect = ops.length === 0 ? 0 : connectSeed % ops.length
					const fault = ops.length === 0 ? -1 : faultSeed % ops.length
					// Continuous tracking: a listener connecting at `connect` reads the same
					// shadow; it must equal the pre-roll for every later byte.
					const pre = new PreRoll(config)
					const shadow = new PreRollShadow(config)
					const counter = { n: 0 }
					ops.forEach((op, i) => {
						const step = drive(pre, shadow, op, counter)
						if (i >= connect) expect(step.shadow).toEqual(step.real)
					})
					// Injected mismatch at `fault`: silent until the first zero delay, exact after it
					// (bytes of a sample in flight at the resync stay muted: fail closed).
					const pre2 = new PreRoll(config)
					const shadow2 = new PreRollShadow(config)
					const c2 = { n: 0 }
					let state: "ok" | "failed" | "resynced" = "ok"
					let bytePos = 0
					let exactFrom = 0
					ops.forEach((op, i) => {
						const step = drive(pre2, shadow2, op, c2, i === fault)
						const expected = step.real.map((r, k) =>
							state === "failed"
								? false
								: state === "resynced" && bytePos + k < exactFrom
									? false
									: r,
						)
						expect(step.shadow).toEqual(expected)
						bytePos += step.real.length
						if (i === fault) {
							expect(step.inSync).toBe(false)
							state = shadow2.failed ? "failed" : "resynced"
							if (state === "resynced")
								exactFrom = Math.ceil(bytePos / width) * width
						} else if (state === "failed" && !shadow2.failed) {
							expect(step.realDelay).toBe(0)
							state = "resynced"
							exactFrom = Math.ceil(bytePos / width) * width
						}
					})
				},
			),
			{ numRuns: 200 },
		)
	})
})

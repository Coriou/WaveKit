import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	addBlocks,
	at,
	BLOCK,
	emptyScript,
	runScript,
} from "./analog-transmission-carrier-harness.js"
import type {
	BlockScript,
	Delivery,
} from "./analog-transmission-carrier-harness.js"

type Kind = "closed" | "noise" | "live"

/** Offline oracle of requirement 3.8: spans, merge groups, published rows, fed blocks. */
function oracle(script: BlockScript) {
	const spans: Array<[number, number]> = []
	const fed: number[] = []
	let run = 0
	let runStart = 0
	let inSpan = false
	let uncarried = 0
	let spanStart = 0
	let lastEnd = 0
	for (let k = 0; k < script.open.length; k++) {
		const live = (script.open[k] ?? false) && (script.carried[k] ?? false)
		if (live) {
			if (run === 0) runStart = k
			run += 1
			uncarried = 0
			if (inSpan) {
				fed.push(k)
				lastEnd = k + 1
			} else if (run >= 10) {
				inSpan = true
				spanStart = runStart
				lastEnd = k + 1
				for (let i = runStart; i <= k; i++) fed.push(i)
			}
		} else {
			run = 0
			if (inSpan) {
				uncarried += 1
				if (!(script.open[k] ?? false) || uncarried >= 25) {
					inSpan = false
					spans.push([spanStart, lastEnd])
				}
			}
		}
	}
	if (inSpan) spans.push([spanStart, lastEnd])
	const rows: Array<{ start: number; end: number }> = []
	let group: { start: number; end: number; audio: number } | null = null
	const flush = (): void => {
		if (group !== null && group.audio >= 50)
			rows.push({ start: group.start, end: group.end })
	}
	for (const [s, e] of spans) {
		if (group !== null && s - group.end <= 150) {
			group.end = e
			group.audio += e - s
			continue
		}
		flush()
		group = { start: s, end: e, audio: e - s }
	}
	flush()
	return { rows, fed }
}

const segment = fc.record({
	kind: fc.constantFrom<Kind>("closed", "noise", "live", "live"),
	blocks: fc.integer({ min: 1, max: 260 }),
})

function build(segments: Array<{ kind: Kind; blocks: number }>): BlockScript {
	const s = emptyScript()
	let base = 0
	const indexAudio = (offset: number) => (i: number) => offset + i
	for (const { kind, blocks } of segments) {
		addBlocks(s, blocks, kind !== "closed", kind === "live", indexAudio(base))
		base += blocks * BLOCK
	}
	addBlocks(s, 200, false, false, indexAudio(base))
	return s
}

describe("WG10 req 3.8 carrier path properties", () => {
	it("spans bound transmissions in every delivery order", () => {
		// Feature: web-gaps-10, Property 13: Spans bound transmissions
		// Validates: Requirements 3.8.2, 3.8.3, 3.8.4, 3.8.5, 3.8.6
		fc.assert(
			fc.property(
				fc.array(segment, { minLength: 1, maxLength: 14 }),
				fc.constantFrom<Delivery>("block", "batched", "split"),
				fc.integer({ min: 1, max: 1_000_000 }),
				(segments, delivery, seed) => {
					const script = build(segments)
					const expected = oracle(script).rows
					const { rows } = runScript(script, { delivery, seed })
					expect(rows.map(r => r.durationMs)).toEqual(
						expected.map(r => (r.end - r.start) * 10),
					)
					// Batched blocks: the run anchor can only be as early as the first sight of the
					// run, at most one batch (100 ms) late; durations stay exact.
					const slack = delivery === "batched" ? 100 : 0
					rows.forEach((row, i) => {
						const want = Date.parse(at(expected[i]?.start ?? 0))
						const diff = Date.parse(row.startedAt) - want
						expect(diff).toBeGreaterThanOrEqual(0)
						expect(diff).toBeLessThanOrEqual(slack)
					})
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)

	it("the detector hears exactly the samples of fed blocks, in order", () => {
		// Feature: web-gaps-10, Property 14: Tone hears only carrier
		// Validates: Requirements 3.8.7
		fc.assert(
			fc.property(
				fc.array(segment, { minLength: 1, maxLength: 14 }),
				fc.constantFrom<Delivery>("block", "batched", "split"),
				fc.integer({ min: 1, max: 1_000_000 }),
				(segments, delivery, seed) => {
					const script = build(segments)
					const { fed } = oracle(script)
					const { pushed } = runScript(script, {
						delivery,
						seed,
						format: "f32le",
						recordPushes: true,
					})
					const want: number[] = []
					for (const k of fed)
						for (let i = 0; i < BLOCK; i++) want.push(k * BLOCK + i)
					expect(pushed).toEqual(want)
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)
})

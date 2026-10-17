import { describe, expect, it } from "vitest"
import {
	createStepWalk,
	pieceParams,
	startOf,
	WALK_CHUNK_ROWS,
	WALK_MAX_SEQ,
	walkStart,
	type StepCursor,
	type StepPiece,
} from "../../../../../src/core/activity/query/walk.js"
import { TRAILS_CHUNK_ROWS } from "../../../../../src/core/activity/query/trails.js"
import { FIXTURE_CLOCK_ANCHOR_MS } from "../storage/helpers.js"
import { createAggStore } from "./aggregates-store.js"

const NOW = FIXTURE_CLOCK_ANCHOR_MS

describe("produced-index step walk", () => {
	it("trails keeps its chunk export, shared with the walk", () => {
		expect(TRAILS_CHUNK_ROWS).toBe(WALK_CHUNK_ROWS)
		expect(WALK_CHUNK_ROWS).toBe(4_096)
	})

	it("cursor helpers", () => {
		expect(walkStart(5)).toEqual({ ms: 5, seq: WALK_MAX_SEQ })
		const tie: StepPiece = { kind: "tie", ms: 3, below: 9, low: 4 }
		const range: StepPiece = { kind: "range", lo: 1, hi: 2 }
		expect(startOf(tie)).toEqual({ ms: 3, seq: 9 })
		expect(startOf(range)).toEqual({ ms: 2, seq: WALK_MAX_SEQ })
		expect(pieceParams(tie)).toEqual([3, 9, 4])
		expect(pieceParams(range)).toEqual([1, 2])
	})

	it("walks ties and ranges newest first, each row exactly once, examined exact", () => {
		const store = createAggStore()
		try {
			const seqs: [number, number][] = []
			// A run of 7 at NOW, singles below, a run of 3 at NOW - 10.
			for (let i = 0; i < 7; i += 1)
				seqs.push([NOW, store.insert({ producedAtMs: NOW })])
			for (let i = 1; i <= 5; i += 1)
				seqs.push([NOW - i, store.insert({ producedAtMs: NOW - i })])
			for (let i = 0; i < 3; i += 1)
				seqs.push([NOW - 10, store.insert({ producedAtMs: NOW - 10 })])
			store.insert({ producedAtMs: NOW - 100 }) // outside the window
			const fromMs = NOW - 50
			const walk = createStepWalk(store.sql, { fromMs, chunk: 3 })
			const rowsOf = store.sql.prepare(
				"SELECT produced_at_ms AS ms, seq FROM activity WHERE produced_at_ms = ? AND seq < ? AND seq >= ? ORDER BY seq DESC",
			)
			const rangeOf = store.sql.prepare(
				"SELECT produced_at_ms AS ms, seq FROM activity WHERE produced_at_ms BETWEEN ? AND ? ORDER BY produced_at_ms DESC, seq DESC",
			)
			const seen: [number, number][] = []
			let examined = 0
			let cursor: StepCursor | null = walkStart(NOW)
			let steps = 0
			while (cursor !== null) {
				const plan = walk.planStep(cursor)
				let stepRows = 0
				for (const piece of plan.pieces) {
					const found = (piece.kind === "tie" ? rowsOf : rangeOf).all(
						...pieceParams(piece),
					)
					stepRows += found.length
					expect(walk.countPiece(piece)).toBe(found.length)
					for (const r of found) seen.push([Number(r["ms"]), Number(r["seq"])])
				}
				expect(stepRows).toBeLessThanOrEqual(3)
				if (plan.examined !== null) expect(plan.examined).toBe(stepRows)
				else expect(plan.next).toBeNull()
				examined += stepRows
				cursor = plan.next
				steps += 1
			}
			const expected = [...seqs].sort((a, b) =>
				a[0] !== b[0] ? b[0] - a[0] : b[1] - a[1],
			)
			expect(seen).toEqual(expected)
			expect(examined).toBe(15)
			expect(steps).toBe(7)
		} finally {
			store.close()
		}
	})

	it("a per-call chunk overrides the default; an empty window ends at once", () => {
		const store = createAggStore()
		try {
			for (let i = 0; i < 5; i += 1) store.insert({ producedAtMs: NOW - i })
			const walk = createStepWalk(store.sql, { fromMs: NOW - 10, chunk: 4_096 })
			const one = walk.planStep(walkStart(NOW), 1)
			expect(one.examined).toBe(1)
			expect(one.next?.ms).toBe(NOW)
			const two = walk.planStep({ ms: NOW, seq: one.next?.seq ?? 0 }, 2)
			expect(two.examined).toBe(2)
			expect(two.next?.ms).toBe(NOW - 2)
			const empty = createStepWalk(store.sql, { fromMs: NOW + 1, chunk: 4 })
			expect(empty.planStep(walkStart(NOW + 1))).toEqual({
				pieces: [],
				next: null,
				examined: 0,
			})
			const partial = walk.planStep(walkStart(NOW + 1))
			expect(partial.examined).toBeNull()
			expect(partial.next).toBeNull()
			expect(partial.pieces.map(p => walk.countPiece(p))).toEqual([5])
		} finally {
			store.close()
		}
	})
})

import { describe, expect, it } from "vitest"

import { plotSourceId } from "../../src/plot/plot-source.ts"

interface Row {
	id: string
	connected: boolean
	paused?: boolean
}

/** One render: the source the plot shows given the rows and what it showed before. */
const shown = (rows: readonly Row[], before: string | null) =>
	plotSourceId(rows, id => rows.find(r => r.id === id)?.paused === true, before)

/** Replays row snapshots through renders, carrying the shown source as Plot does. */
function replay(steps: readonly (readonly Row[])[]): (string | null)[] {
	let current: string | null = null
	return steps.map(rows => (current = shown(rows, current)))
}

const live = (id: string): Row => ({ id, connected: true })
const paused = (id: string): Row => ({ id, connected: false, paused: true })
const down = (id: string): Row => ({ id, connected: false })

describe("the source the plot shows", () => {
	it("starts on the first connected source, else the first paused, else none", () => {
		expect(shown([down("a"), live("b")], null)).toBe("b")
		expect(shown([down("a"), paused("b")], null)).toBe("b")
		expect(shown([down("a"), down("b")], null)).toBeNull()
		expect(shown([], null)).toBeNull()
	})

	it("stays on A when A is paused while B is connected, and through the resume", () => {
		expect(
			replay([
				[live("a"), live("b")],
				[paused("a"), live("b")],
				[paused("a"), live("b")],
				[live("a"), live("b")],
			]),
		).toEqual(["a", "a", "a", "a"])
	})

	it("stays on a paused source that is not the first", () => {
		expect(
			replay([
				[down("a"), live("b")],
				[live("a"), paused("b")],
				[live("a"), live("b")],
			]),
		).toEqual(["b", "b", "b"])
	})

	it("falls back once the paused source is removed", () => {
		expect(
			replay([
				[live("a"), live("b")],
				[paused("a"), live("b")],
				[live("b")],
				[live("a"), live("b")],
			]),
		).toEqual(["a", "a", "b", "b"])
	})

	it("falls back to none when the only source, paused, is removed", () => {
		expect(replay([[live("a")], [paused("a")], []])).toEqual(["a", "a", null])
	})

	it("falls back when the shown source drops without a pause", () => {
		expect(
			replay([
				[live("a"), live("b")],
				[down("a"), live("b")],
			]),
		).toEqual(["a", "b"])
	})
})

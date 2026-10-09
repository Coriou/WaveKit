import { describe, expect, it } from "vitest"
import { applyUiAction } from "../../../cli/source/ui/ui-reducer.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"

const ctx = { rowIds: ["a", "b", "c"], pageSize: 2 }

describe("applyUiAction", () => {
	it("moves and clamps the selection", () => {
		let ui = applyUiAction(
			initialUi("decoders"),
			{ type: "move", delta: 1 },
			ctx,
			0,
		)
		expect(ui.selected.decoders).toBe("a")
		ui = applyUiAction(ui, { type: "page", delta: 1 }, ctx, 0)
		expect(ui.selected.decoders).toBe("c")
		ui = applyUiAction(ui, { type: "move", delta: 1 }, ctx, 0)
		expect(ui.selected.decoders).toBe("c")
	})
	it("auto-pauses the Messages feed on movement and resumes on G", () => {
		const m = { rowIds: ["42", "41", "40"], pageSize: 5 }
		let ui = applyUiAction(
			initialUi("messages"),
			{ type: "move", delta: -1 },
			m,
			0,
		)
		expect(ui.messages).toMatchObject({ following: false, pausedAtSeq: 42 })
		expect(ui.selected.messages).toBe("42")
		ui = applyUiAction(ui, { type: "newest" }, m, 0)
		expect(ui.messages).toMatchObject({ following: true, pausedAtSeq: null })
		expect(ui.selected.messages).toBeNull()
	})
	it("opens an Overview decoder in the Decoders view (spec §7)", () => {
		let ui = applyUiAction(
			initialUi("overview"),
			{ type: "move", delta: 1 },
			ctx,
			0,
		)
		ui = applyUiAction(ui, { type: "move", delta: 1 }, ctx, 0)
		ui = applyUiAction(ui, { type: "open" }, ctx, 0)
		expect(ui.view).toBe("decoders")
		expect(ui.selected.decoders).toBe("b")
		expect(ui.detail.decoders.open).toBe(true)
		expect(ui.detail.overview.open).toBe(false)
	})
	it("walks the Esc chain: detail → selection → filter", () => {
		let ui = initialUi("messages")
		ui = { ...ui, messages: { ...ui.messages, filterText: "readsb" } }
		ui = applyUiAction(ui, { type: "open" }, { rowIds: ["7"], pageSize: 5 }, 0)
		expect(ui.detail.messages.open).toBe(true)
		ui = applyUiAction(ui, { type: "escape" }, ctx, 0)
		expect(ui.detail.messages.open).toBe(false)
		ui = applyUiAction(ui, { type: "escape" }, ctx, 0)
		expect(ui.selected.messages).toBeNull()
		ui = applyUiAction(ui, { type: "escape" }, ctx, 0)
		expect(ui.messages.filterText).toBe("")
	})
	it("edits a filter draft and applies or cancels it", () => {
		let ui = applyUiAction(
			initialUi("messages"),
			{ type: "filter-open" },
			ctx,
			0,
		)
		for (const t of ["r", "e", "a", "d", "s", "b", "x"])
			ui = applyUiAction(ui, { type: "filter-type", text: t }, ctx, 0)
		ui = applyUiAction(ui, { type: "filter-backspace" }, ctx, 0)
		expect(ui.messages.draft).toBe("readsb")
		ui = applyUiAction(ui, { type: "filter-apply" }, ctx, 0)
		expect(ui.messages).toMatchObject({ draft: null, filterText: "readsb" })
		ui = applyUiAction(
			applyUiAction(ui, { type: "filter-open" }, ctx, 0),
			{ type: "filter-cancel" },
			ctx,
			0,
		)
		expect(ui.messages).toMatchObject({ draft: null, filterText: "readsb" })
	})
	it("wraps view steps, cycles presets and stores notices", () => {
		expect(
			applyUiAction(
				initialUi("overview"),
				{ type: "view-step", delta: -1 },
				ctx,
				0,
			).view,
		).toBe("system")
		expect(
			applyUiAction(initialUi("messages"), { type: "preset-cycle" }, ctx, 0)
				.messages.preset,
		).toBe("aircraft")
		expect(
			applyUiAction(
				initialUi("receiver"),
				{ type: "notice", text: "x" },
				ctx,
				9,
			).notice,
		).toEqual({ text: "x", at: 9 })
	})

	describe("fix round 1", () => {
		const m = { rowIds: ["42", "41", "40"], pageSize: 5 }
		const openDetail = () => {
			const paused = applyUiAction(
				initialUi("messages"),
				{ type: "move", delta: 1 },
				m,
				0,
			)
			return applyUiAction(paused, { type: "open" }, m, 0)
		}
		it("G from the Messages detail closes the detail with the selection", () => {
			const ui = applyUiAction(openDetail(), { type: "newest" }, m, 0)
			expect(ui.selected.messages).toBeNull()
			expect(ui.detail.messages.open).toBe(false)
			expect(ui.messages.following).toBe(true)
		})
		it("applying a filter from the Messages detail closes the detail", () => {
			let ui = applyUiAction(openDetail(), { type: "filter-open" }, m, 0)
			ui = applyUiAction(ui, { type: "filter-apply" }, m, 0)
			expect(ui.selected.messages).toBeNull()
			expect(ui.detail.messages.open).toBe(false)
		})
		it("Enter on Messages while following pauses so the opened row stays put", () => {
			const ui = applyUiAction(initialUi("messages"), { type: "open" }, m, 0)
			expect(ui.messages).toMatchObject({ following: false, pausedAtSeq: 42 })
			expect(ui.selected.messages).toBe("42")
			expect(ui.detail.messages.open).toBe(true)
		})
		it("movement on an empty list does not pause the feed", () => {
			const empty = { rowIds: [], pageSize: 5 }
			for (const a of [
				{ type: "move", delta: -1 },
				{ type: "page", delta: 1 },
				{ type: "top" },
			] as const) {
				const ui = applyUiAction(initialUi("messages"), a, empty, 0)
				expect(ui.messages.following).toBe(true)
			}
		})
	})
})

describe("R73: detail scroll and empty pause (T40 fix round 1 M3/M4)", () => {
	const open = (view: "messages" | "decoders") => {
		const ui = initialUi(view)
		return {
			...ui,
			selected: { ...ui.selected, [view]: "b" },
			detail: { ...ui.detail, [view]: { open: true, scroll: 0 } },
		}
	}
	it("M3: detail scroll stops at detailMaxScroll, so PgUp answers at once", () => {
		const c = { ...ctx, detailMaxScroll: 7 }
		let ui = open("messages")
		for (let i = 0; i < 5; i++)
			ui = applyUiAction(ui, { type: "detail-scroll", delta: 1 }, c, 0)
		expect(ui.detail.messages.scroll).toBe(7)
		ui = applyUiAction(ui, { type: "detail-scroll", delta: -1 }, c, 0)
		expect(ui.detail.messages.scroll).toBe(2)
	})
	it("M3: moving the selection with the detail open scrolls it back to the top", () => {
		const c = { ...ctx, detailMaxScroll: 20 }
		let ui = applyUiAction(
			open("decoders"),
			{ type: "detail-scroll", delta: 1 },
			c,
			0,
		)
		expect(ui.detail.decoders.scroll).toBe(5)
		ui = applyUiAction(ui, { type: "move", delta: 1 }, c, 0)
		expect(ui.selected.decoders).toBe("c")
		expect(ui.detail.decoders).toEqual({ open: true, scroll: 0 })
	})
	it("M4: p on an empty Messages list freezes at the ring's newest seq and records when", () => {
		const ui = applyUiAction(
			initialUi("messages"),
			{ type: "pause-toggle" },
			{ rowIds: [], pageSize: 5, newestSeq: 41 },
			1234,
		)
		expect(ui.messages).toMatchObject({
			following: false,
			pausedAtSeq: 41,
			pausedAt: 1234,
		})
	})
})

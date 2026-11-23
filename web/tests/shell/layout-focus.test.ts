// The focus hand-off (LY rules §1.2): the focus inside a slot the reader cannot see (a status item yielded under an
// open panel, docked in a yielded host, held or waiting) goes to the open panel's trigger. The layout names the
// unseen status slots; the shell finds the focus inside one of them, or inside any element whose state is not seen.
import { describe, expect, it } from "vitest"

import {
	computeLayout,
	DEFAULT_SIZES,
	unseenStatusSlots,
	type Layout,
	type LayoutInput,
	type StatusItem,
} from "../../src/shell/layout/compute.ts"
import { focusInUnseen, type SlotNode } from "../../src/shell/layout/slot.ts"

/** A minimal element tree: each node's attributes and its parent (closest() as the DOM's). */
function node(
	attrs: Record<string, string>,
	parent: SlotNode | null,
): SlotNode {
	const self: SlotNode = {
		parentElement: parent,
		getAttribute: name => attrs[name] ?? null,
		closest: sel => {
			const want = sel.split(",").map(p => /\[([a-z-]+)\]/.exec(p)?.[1] ?? "")
			for (let n: SlotNode | null = self; n; n = n.parentElement)
				if (want.some(a => n?.getAttribute(a) !== null)) return n
			return null
		},
	}
	return self
}

const RECEIPT: StatusItem = {
	id: "receipt",
	kind: "receipt",
	forms: { full: { w: 220, h: 44 } },
}

const phone = (o: Partial<LayoutInput> = {}): Layout =>
	computeLayout({
		viewport: { w: 390, h: 844 },
		tuner: { w: 358, h: 56 },
		receiver: { w: 300, h: 56 },
		listen: { w: 302, h: 64 },
		dock: DEFAULT_SIZES.dock,
		find: { w: 48, h: 48 },
		player: null,
		card: null,
		status: [RECEIPT],
		drawer: null,
		panels: [],
		...o,
	})

describe("the focus hand-off out of an unseen slot", () => {
	it("390x844: the Tuner panel opening (by keyboard, focus on Undo) names the receipt unseen; Undo hands off", () => {
		const closed = phone()
		expect(unseenStatusSlots(closed)).toEqual([])
		const open = phone({ openPanel: "tuner" })
		expect(unseenStatusSlots(open)).toEqual(["status:receipt"])
		// Undo inside the receipt's slot; the DOM still says shown (this commit's attributes may not be there yet)
		const root = node({}, null)
		const region = node({ "data-wk-notice-region": "" }, root)
		const toast = node(
			{ "data-wk-slot": "status:receipt", "data-wk-state": "shown" },
			region,
		)
		const undo = node({ "data-control": "undo" }, toast)
		expect(focusInUnseen(undo, unseenStatusSlots(closed))).toBe(false)
		expect(focusInUnseen(undo, unseenStatusSlots(open))).toBe(true)
	})

	it("a docked toast in a yielded host is unseen; the focus inside it hands off", () => {
		const L = phone({ openPanel: "tuner" })
		const docked: Layout = {
			...L,
			status: {
				...L.status,
				items: [],
				docked: ["receipt"],
				dockHost: "yielded",
			},
			yielded: [],
		}
		expect(unseenStatusSlots(docked)).toEqual(["status:receipt"])
		const drawer = node({ "data-wk-slot": "drawer" }, null)
		const toast = node({ "data-wk-slot": "status:receipt" }, drawer)
		const button = node({}, toast)
		expect(focusInUnseen(button, unseenStatusSlots(docked))).toBe(true)
		expect(
			focusInUnseen(
				button,
				unseenStatusSlots({
					...docked,
					status: { ...docked.status, dockHost: "shown" },
				}),
			),
		).toBe(false)
	})

	it("any enclosing element whose data-wk-state is not seen hands off; shown and docked do not", () => {
		for (const [state, out] of [
			["shown", false],
			["docked", false],
			["yielded", true],
			["held", true],
			["waiting", true],
		] as const) {
			const guest = node(
				{ "data-wk-slot": "status:connection", "data-wk-state": state },
				null,
			)
			expect(focusInUnseen(node({}, guest), []), state).toBe(out)
		}
		expect(focusInUnseen(null, ["status:receipt"])).toBe(false)
		expect(focusInUnseen(node({}, null), ["status:receipt"])).toBe(false)
	})
})

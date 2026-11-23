import { readFileSync } from "node:fs"
import { afterEach, describe, expect, it } from "vitest"
import type { RecordingInventoryItem } from "@wavekit/api-types"

import { savedNames } from "../../src/features/naming.ts"
import {
	channelLinkLabel,
	rowMenuCloseTiming,
	rowMenuKey,
} from "../../src/features/recordings/RecordingsDrawer.tsx"
import { listKeyAction } from "../../src/features/recordings/keys.ts"

const item = (
	patch: Partial<RecordingInventoryItem>,
): RecordingInventoryItem => ({
	id: "scan:d1~a.wav",
	kind: "scanner-analog",
	decoderId: null,
	discoveryId: "d1",
	startedAtLocal: null,
	modifiedAt: "2026-11-16T10:00:00.000Z",
	bytes: 1000,
	durationMs: 4000,
	callType: null,
	talkgroup: null,
	source: null,
	frequencyHz: 145_599_792,
	...patch,
})

afterEach(() => savedNames.set([]))

describe("Recordings row actions", () => {
	it.each<[string, Partial<RecordingInventoryItem>, string | null]>([
		["a scanner recording: its channel", {}, "History of 145.6000"],
		[
			"a call without a frequency: its talkgroup",
			{ kind: "dsd-fme-call", frequencyHz: null, talkgroup: "2081" },
			"History of TG 2081",
		],
		// the transmission itself is the Details door, never a channel link
		[
			"only its transmission known",
			{ frequencyHz: null, activityEventId: "evt_1" },
			null,
		],
		["nothing to link", { frequencyHz: null }, null],
	])("one channel link: %s", (_case, patch, label) => {
		expect(channelLinkLabel(item(patch))).toBe(label)
	})

	it("names the channel link by the saved name", () => {
		savedNames.set([{ frequencyHz: 145_600_000, name: "Club net" }])
		expect(channelLinkLabel(item({}))).toBe("History of Club net")
	})

	it("is Play, Keep, Details, ⋯ and one channel link, through the one channel seam", () => {
		const src = readFileSync(
			new URL(
				"../../src/features/recordings/RecordingsDrawer.tsx",
				import.meta.url,
			),
			"utf8",
		)
		const block = src.slice(
			src.indexOf("function RowActions("),
			src.indexOf("function RowMenu("),
		)
		const order = [
			"Play",
			"Keep",
			"Details",
			'aria-label="More actions"',
			"{link}",
		].map(s => block.indexOf(s))
		expect(order.every(i => i > 0)).toBe(true)
		expect([...order].sort((a, b) => a - b)).toEqual(order)
		// Download, Tune, Open in Scanner and Delete live in the ⋯ menu; Open in Scanner only with a discovery id
		expect(block).toMatch(/owner !== null && \(/)
		expect(block).toContain("Open in Scanner")
		expect(block).not.toContain("Evidence")
		// History is the channel's list only: nothing is opened over it
		expect(src).toMatch(/showChannel\(\s*services\.activity,\s*r\.frequencyHz,/)
		expect(src).not.toContain("showEvent(")
		expect(src).not.toContain("showFrequency(")
		expect(src).not.toContain("Show in")
	})
})

describe("the ⋯ menu", () => {
	it.each<[string, number, ReturnType<typeof rowMenuKey>]>([
		["ArrowDown", 0, { type: "focus", index: 1 }],
		["ArrowDown", 3, { type: "focus", index: 0 }],
		["ArrowUp", 0, { type: "focus", index: 3 }],
		["ArrowDown", -1, { type: "focus", index: 0 }],
		["ArrowUp", -1, { type: "focus", index: 3 }],
		["Home", 2, { type: "focus", index: 0 }],
		["End", 0, { type: "focus", index: 3 }],
		["Escape", 1, { type: "close", refocus: true }],
		// Tab moves focus on and the menu closes as focus leaves it
		["Tab", 1, { type: "close", refocus: false }],
		["s", 1, null],
	])("%s from row %d", (key, at, action) => {
		expect(rowMenuKey(key, at, 4)).toEqual(action)
	})

	it("keeps its keys from the list's shortcuts", () => {
		const src = readFileSync(
			new URL(
				"../../src/features/recordings/RecordingsDrawer.tsx",
				import.meta.url,
			),
			"utf8",
		)
		const menu = src.slice(src.indexOf("function RowMenu("))
		// the menu stops every key it receives, and the list ignores any key from inside a menu
		expect(menu).toMatch(/onKeyDown=\{e => \{\s*e\.stopPropagation\(\)/)
		expect(src).toMatch(
			/target\.closest\("\[role=menu\]"\) !== null\) return[\s\S]*?listKeyAction\(/,
		)
		// what those keys would do on the list, were they let through
		const ctx = {
			cursor: true,
			open: true,
			loaded: false,
			readOnly: false,
			deletable: true,
		}
		const key = (k: string) => ({
			key: k,
			metaKey: false,
			ctrlKey: false,
			altKey: false,
			inField: false,
			inControl: false,
		})
		expect(listKeyAction(key("ArrowDown"), ctx)).not.toBeNull()
	})

	it("closes after a download link's click has run, any other row at once", () => {
		expect(rowMenuCloseTiming({ tagName: "A" })).toBe("after")
		expect(rowMenuCloseTiming({ tagName: "BUTTON" })).toBe("now")
	})
})

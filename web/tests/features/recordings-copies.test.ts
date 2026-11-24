/**
 * Copies (ghosts: the same audio heard again on another frequency) in the Recordings drawer and the
 * Transmission view: the list asks for copies=false until Show copies, a copy's row carries a "copy"
 * chip opening its original, an original's view lists "Also heard on … (copy)" and a copy's view
 * links "Copy of …". Made-up keys and frequencies.
 */
import { readFileSync } from "node:fs"
import { createElement, type ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import type { RecordingInventoryItem } from "@wavekit/api-types"

import { CopyChip } from "../../src/features/recordings/RecordingsDrawer.tsx"
import {
	copiesToggleLabel,
	isCopy,
	recordingsQuery,
} from "../../src/features/recordings/model.ts"
import {
	recordingsUi,
	setShowCopies,
} from "../../src/features/recordings/ui-store.ts"
import {
	clearTransmissionCache,
	loadTransmission,
	servedCopyOf,
} from "../../src/features/transmission/load.ts"
import { transmissionNav } from "../../src/features/transmission/nav.ts"
import { Copies } from "../../src/features/transmission/TransmissionView.tsx"
import {
	alsoHeardText,
	copyOfText,
	moreCopiesText,
} from "../../src/features/transmission/words.ts"
import { json, scripted } from "../data/fake-fetch.ts"

const ROOT = "scan:d_ROOT~analog-00000000-0000-4000-8000-000000000001.wav"
const GHOST = "scan:d_GHOST~analog-00000000-0000-4000-8000-000000000002.wav"
const GHOST_HZ = 151_113_700
const ROOT_HZ = 151_025_000

const item = (
	over: Partial<RecordingInventoryItem> = {},
): RecordingInventoryItem => ({
	id: ROOT,
	key: ROOT,
	kind: "scanner-analog",
	decoderId: null,
	discoveryId: "d_ROOT",
	startedAtLocal: null,
	modifiedAt: "2026-11-23T17:30:40.000Z",
	bytes: 128_000,
	durationMs: 8000,
	callType: null,
	talkgroup: null,
	source: null,
	frequencyHz: ROOT_HZ,
	kept: false,
	startedAt: "2026-11-23T17:30:21.000Z",
	copyOf: null,
	...over,
})

const ghost = item({
	id: GHOST,
	key: GHOST,
	discoveryId: "d_GHOST",
	frequencyHz: GHOST_HZ,
	copyOf: { key: ROOT, evidence: ["intermod", "off-raster"] },
})

afterEach(() => {
	transmissionNav.set(null)
	setShowCopies(false)
	clearTransmissionCache()
})

describe("Recordings: copies hidden by default, Show copies, the copy chip", () => {
	it("asks the core for the list without copies until Show copies is on", () => {
		expect(recordingsUi.get().showCopies).toBe(false)
		const hidden = recordingsQuery({ ...recordingsUi.get() })
		expect(hidden).toEqual({ copies: false })
		setShowCopies(true)
		expect(recordingsQuery({ ...recordingsUi.get() })).toEqual({})
		// the drawer's opening query and every later one carry the toggle
		const src = readFileSync(
			new URL(
				"../../src/features/recordings/RecordingsDrawer.tsx",
				import.meta.url,
			),
			"utf8",
		)
		expect(src).toContain("recordingsQuery(recordingsUi.get())")
		expect(src).toContain(
			"recordingsQuery({ tokens, text, filter, showCopies })",
		)
	})

	it("words the quiet toggle from the core's copiesTotal", () => {
		expect(copiesToggleLabel(3, false)).toBe("Show copies (3)")
		expect(copiesToggleLabel(1_204, false)).toBe("Show copies (1,204)")
		expect(copiesToggleLabel(0, false)).toBeNull()
		expect(copiesToggleLabel(undefined, false)).toBeNull()
		expect(copiesToggleLabel(null, false)).toBeNull()
		expect(copiesToggleLabel(0, true)).toBe("Hide copies")
	})

	it("a copy's row shows a copy chip that opens its original; an original shows none", () => {
		expect(isCopy(ghost)).toBe(true)
		expect(isCopy(item())).toBe(false)
		expect(isCopy(item({ copyOf: null }))).toBe(false)
		const html = renderToStaticMarkup(createElement(CopyChip, { item: ghost }))
		expect(html).toContain('class="wk-chip wkr-copy"')
		expect(html).toContain(">copy</button>")
		expect(
			renderToStaticMarkup(createElement(CopyChip, { item: item() })),
		).toBe("")
		// its click opens the original's Transmission view in Recordings
		const chip = CopyChip({ item: ghost }) as ReactElement<{
			onClick: () => void
		}>
		chip.props.onClick()
		expect(transmissionNav.get()).toMatchObject({
			ref: { recording: ROOT },
			origin: { host: "recordings", label: "Recordings" },
		})
	})
})

describe("Transmission view: Copy of / Also heard on", () => {
	it("words each link with the exact frequency (a ghost sits off its raster)", () => {
		expect(alsoHeardText(GHOST_HZ)).toBe("Also heard on 151.1137 MHz (copy)")
		expect(alsoHeardText(null)).toBe("Also heard on another frequency (copy)")
		expect(copyOfText(ROOT_HZ)).toBe("Copy of 151.025 MHz")
		expect(copyOfText(null)).toBe("Copy of the original recording")
		expect(moreCopiesText(11, 8)).toBe("and 3 more copies")
		expect(moreCopiesText(9, 8)).toBe("and 1 more copy")
		expect(moreCopiesText(8, 8)).toBeNull()
	})

	it("an original lists its copies (and how many more past the listed ones); a copy links its original", () => {
		const copies = Array.from({ length: 8 }, (_, i) => ({
			recordingKey: `${GHOST}#${i}`,
			hz: GHOST_HZ + i * 1_000,
		}))
		const original = renderToStaticMarkup(
			createElement(Copies, {
				copy: { of: null, copies, copiesTotal: 10 },
				onPicked: () => undefined,
			}),
		)
		expect(original).toContain('aria-label="Copies"')
		expect(original).toContain("Also heard on 151.1137 MHz (copy)")
		expect(original.match(/Also heard on/g)).toHaveLength(8)
		expect(original).toContain("and 2 more copies")
		expect(original).not.toContain("Copy of")
		const copy = renderToStaticMarkup(
			createElement(Copies, {
				copy: {
					of: { recordingKey: ROOT, hz: ROOT_HZ },
					copies: [],
					copiesTotal: 0,
				},
				onPicked: () => undefined,
			}),
		)
		expect(copy).toContain("Copy of 151.025 MHz")
		expect(copy).not.toContain("Also heard on")
		// the link replaces the view's transmission with the original, Back unchanged
		transmissionNav.set({
			ref: { recording: GHOST },
			origin: { host: "recordings", label: "Recordings" },
			summary: null,
		})
		let picked = 0
		const section = Copies({
			copy: {
				of: { recordingKey: ROOT, hz: ROOT_HZ },
				copies: [],
				copiesTotal: 0,
			},
			onPicked: () => picked++,
		}) as ReactElement<{ children: unknown[] }>
		const line = section.props.children[0] as ReactElement<{
			children: ReactElement<{ onClick: () => void }>
		}>
		line.props.children.props.onClick()
		expect(picked).toBe(1)
		expect(transmissionNav.get()).toMatchObject({
			ref: { recording: ROOT },
			origin: { host: "recordings", label: "Recordings" },
		})
	})
})

/** A core answering the recordings page and the transmission route's copy (others 404). */
function core(
	listed: RecordingInventoryItem[],
	served: Record<string, unknown>,
) {
	return scripted(call => {
		const path = decodeURIComponent(new URL(call.url, "http://core").pathname)
		if (path === "/api/recordings")
			return json(200, {
				items: listed,
				nextCursor: null,
				scannedFiles: listed.length,
				truncated: false,
				scannedAt: "2026-11-23T18:00:00.000Z",
			})
		const body = served[path]
		if (body !== undefined) return json(200, body)
		return json(404, { error: { code: "NOT_FOUND", message: "gone" } })
	})
}

describe("loadTransmission: the copy links", () => {
	it("an original reads its copies from the core's transmission route", async () => {
		const { api } = core([item()], {
			[`/api/transmissions/rec:${ROOT}`]: {
				copy: {
					of: null,
					copies: [
						{
							ref: `rec:${GHOST}`,
							hz: GHOST_HZ,
							recordingKey: GHOST,
							evidence: ["intermod"],
						},
					],
					copiesTotal: 3,
				},
			},
		})
		const t = await loadTransmission(
			{ recording: ROOT },
			{ api, optionalMs: 50 },
		)
		expect(t.copy).toEqual({
			of: null,
			copies: [{ recordingKey: GHOST, hz: GHOST_HZ }],
			copiesTotal: 3,
		})
	})

	it("a copy links its original, with the frequency the core serves, else the original's own", async () => {
		const served = core([ghost, item()], {
			[`/api/transmissions/rec:${GHOST}`]: {
				copy: {
					of: { ref: `rec:${ROOT}`, hz: ROOT_HZ },
					copies: [],
					copiesTotal: 0,
				},
			},
		})
		const t = await loadTransmission(
			{ recording: GHOST },
			{ api: served.api, optionalMs: 50 },
		)
		expect(t.copy).toEqual({
			of: { recordingKey: ROOT, hz: ROOT_HZ },
			copies: [],
			copiesTotal: 0,
		})
		clearTransmissionCache()
		// the route fails: the original's frequency from its own item
		const failing = core([ghost, item()], {})
		const u = await loadTransmission(
			{ recording: GHOST },
			{ api: failing.api, optionalMs: 50 },
		)
		expect(u.copy?.of).toEqual({ recordingKey: ROOT, hz: ROOT_HZ })
	})

	it("an older core (no copyOf at all) is never asked; neither link: null", async () => {
		const old = item()
		delete old.copyOf
		const { api, calls } = core([old], {})
		const t = await loadTransmission(
			{ recording: ROOT },
			{ api, optionalMs: 50 },
		)
		expect(t.copy ?? null).toBeNull()
		expect(calls.some(c => c.url.includes("/api/transmissions/"))).toBe(false)
		clearTransmissionCache()
		const none = core([item()], {
			[`/api/transmissions/rec:${ROOT}`]: { copy: null },
		})
		const n = await loadTransmission(
			{ recording: ROOT },
			{ api: none.api, optionalMs: 50 },
		)
		expect(n.copy ?? null).toBeNull()
	})

	it("reads the served copy field by field, at most 8 listed", () => {
		expect(servedCopyOf(null)).toBeNull()
		expect(servedCopyOf({ copy: "x" })).toBeNull()
		const many = servedCopyOf({
			copy: {
				of: { hz: "x" },
				copies: [
					...Array.from({ length: 12 }, (_, i) => ({
						recordingKey: `k${i}`,
						hz: i,
					})),
				],
				copiesTotal: 12,
			},
		})
		expect(many?.of).toEqual({ hz: null })
		expect(many?.copies).toHaveLength(8)
		expect(many?.copiesTotal).toBe(12)
		expect(
			servedCopyOf({
				copy: {
					of: null,
					copies: [{ recordingKey: 3 }, null],
					copiesTotal: -1,
				},
			}),
		).toEqual({ of: null, copies: [], copiesTotal: 0 })
	})
})

/**
 * Copies (ghosts: the same audio heard again on another frequency) in the Recordings drawer and the
 * Transmission view: the list shows copies by default (copies=false only under Hide copies, and only to
 * a core that showed it knows the key), a copy's row carries a "copy" chip opening its original, an original's view lists "Also heard on … (copy)" and a copy's view
 * links "Copy of …". Made-up keys and frequencies.
 */
import { readFileSync } from "node:fs"
import { createElement, type ReactElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { RecordingInventoryItem } from "@wavekit/api-types"

import { CopyChip } from "../../src/features/recordings/RecordingsDrawer.tsx"
import {
	copiesToggleLabel,
	headerCount,
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
import {
	RecordingsStore,
	recordingsParams,
} from "../../src/data/recordings-store.ts"

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
	setShowCopies(true)
	clearTransmissionCache()
})

/** An answer as a core answers: `counts` with `copiesTotal` (this core) or without (an older core). */
function listing(items: unknown[], copiesTotal?: number) {
	return {
		items,
		nextCursor: null,
		scannedFiles: items.length,
		truncated: false,
		scannedAt: "2026-11-23T18:00:00.000Z",
		matched: items.length,
		counts: {
			total: items.length,
			kept: 0,
			bytes: 0,
			byKind: { "scanner-analog": items.length },
			...(copiesTotal === undefined ? {} : { copiesTotal }),
		},
	}
}

describe("Recordings: copies shown by default with their chip, Hide copies, the copy chip", () => {
	it("sends copies=false on the wire only under Hide copies, and only to a core that knows the key", () => {
		const hidden = recordingsQuery({
			tokens: [],
			text: "",
			filter: "all",
			showCopies: false,
		})
		expect(recordingsParams(hidden, 50, null)).toMatchObject({
			copies: "false",
		})
		expect(recordingsParams(hidden, 50, null, false)).not.toHaveProperty(
			"copies",
		)
		expect(
			recordingsParams(
				recordingsQuery({
					tokens: [],
					text: "",
					filter: "all",
					showCopies: true,
				}),
				50,
				null,
			),
		).not.toHaveProperty("copies")
	})

	it("lists copies by default; Hide copies asks the core for the list without them", () => {
		expect(recordingsUi.get().showCopies).toBe(true)
		expect(recordingsQuery({ ...recordingsUi.get() })).toEqual({})
		setShowCopies(false)
		expect(recordingsQuery({ ...recordingsUi.get() })).toEqual({
			copies: false,
		})
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

	it("an older core (no copiesTotal, no copyOf) is never sent copies=false: no error, the list shows", async () => {
		const old = item()
		delete old.copyOf
		const { api, calls } = scripted(() => json(200, listing([old])))
		const store = new RecordingsStore(api)
		await store.show({ copies: false })
		await store.show({ copies: false })
		expect(calls.length).toBeGreaterThan(0)
		expect(calls.every(c => !c.url.includes("copies"))).toBe(true)
		expect(store.get()).toMatchObject({ status: "ready", error: null })
		expect(store.get().items.map(i => i.id)).toEqual([ROOT])
		store.dispose()
	})

	it("a core that showed copiesTotal is sent copies=false (read again once it showed it)", async () => {
		const { api, calls } = scripted(call =>
			json(
				200,
				listing(
					call.url.includes("copies=false") ? [item()] : [item(), ghost],
					1,
				),
			),
		)
		const store = new RecordingsStore(api)
		await store.show({ copies: false })
		await vi.waitFor(() =>
			expect(calls.some(c => c.url.includes("copies=false"))).toBe(true),
		)
		await vi.waitFor(() =>
			expect(store.get().items.map(i => i.id)).toEqual([ROOT]),
		)
		expect(calls[0]?.url).not.toContain("copies")
		store.dispose()
	})

	it("the header count with copies hidden is `matched` (the rows shown), with them shown `counts`", () => {
		const meta = {
			counts: { total: 12, kept: 4, copiesTotal: 3 },
			matched: 9,
			truncated: false,
		}
		expect(headerCount(meta, "all", false, true)).toBe("9")
		expect(headerCount(meta, "all", false, false)).toBe("12")
		expect(headerCount({ ...meta, matched: 3 }, "kept", false, true)).toBe("3")
		expect(headerCount(meta, "kept", false, false)).toBe("4")
		// No copies to hide, or an older core without copiesTotal: counts as before.
		const none = { ...meta, counts: { total: 12, kept: 4, copiesTotal: 0 } }
		expect(headerCount(none, "all", false, true)).toBe("12")
		expect(
			headerCount(
				{ ...meta, counts: { total: 12, kept: 4 } },
				"all",
				false,
				true,
			),
		).toBe("12")
		expect(headerCount({ ...meta, truncated: true }, "all", false, true)).toBe(
			"9+",
		)
	})

	it("words the quiet toggle from the core's copiesTotal", () => {
		expect(copiesToggleLabel(3, true)).toBe("Hide copies (3)")
		expect(copiesToggleLabel(3, false)).toBe("Show copies (3)")
		expect(copiesToggleLabel(1_204, false)).toBe("Show copies (1,204)")
		expect(copiesToggleLabel(0, false)).toBeNull()
		expect(copiesToggleLabel(0, true)).toBeNull()
		// an older core without the count: nothing to toggle (it is never sent copies=false)
		expect(copiesToggleLabel(undefined, true)).toBeNull()
		expect(copiesToggleLabel(null, false)).toBeNull()
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

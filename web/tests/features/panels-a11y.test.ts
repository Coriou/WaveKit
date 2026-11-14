import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import type { RecordingInventoryItem } from "@wavekit/api-types"

import { ServicesContext } from "../../src/app/context.ts"
import { createServices, type AppServices } from "../../src/app/services.ts"
import { listKeyAction } from "../../src/features/recordings/keys.ts"
import { RecordingsDrawer } from "../../src/features/recordings/RecordingsDrawer.tsx"
import { indexAt, prefixOffsets, virtualWindow } from "../../src/ui/virtual.ts"
import { OffsetTree } from "../../src/ui/virtual-rows.ts"

let services: AppServices | null = null
afterEach(() => {
	services?.dispose()
	services = null
})

const rec = (n: number): RecordingInventoryItem => ({
	id: `dsd:0~20261017_10000${n}_0000${n}_DMR.wav`,
	kind: "dsd-fme-call",
	decoderId: "dsd-fme",
	discoveryId: null,
	startedAtLocal: n < 2 ? "2026-10-17T10:00:00" : "2026-10-16T10:00:00",
	modifiedAt: `2026-10-17T08:00:0${9 - n}.000Z`,
	bytes: 16_000,
	durationMs: 1000,
	callType: "group",
	talkgroup: String(2080 + n),
	source: null,
	frequencyHz: null,
	kept: false,
})

async function rendered(): Promise<string> {
	const items = [rec(0), rec(1), rec(2)]
	const made = createServices({
		fetch: async url =>
			String(url).startsWith("/api/recordings")
				? new Response(
						JSON.stringify({
							items,
							nextCursor: null,
							scannedFiles: 3,
							truncated: false,
							scannedAt: "2026-10-17T08:01:00.000Z",
							matched: 3,
							counts: {
								total: 3,
								kept: 0,
								bytes: 48_000,
								byKind: {
									"dsd-fme-call": 3,
									"scanner-dv": 0,
									"scanner-analog": 0,
								},
							},
						}),
						{ status: 200 },
					)
				: new Response("{}", { status: 404 }),
		createSocket: () => ({
			readyState: 0,
			onopen: null,
			onclose: null,
			onerror: null,
			onmessage: null,
			send: () => undefined,
			close: () => undefined,
		}),
	})
	services = made
	await made.data.recordings.show({})
	return renderToStaticMarkup(
		createElement(
			ServicesContext.Provider,
			{ value: made },
			createElement(RecordingsDrawer, { onClose: () => undefined }),
		),
	)
}

describe("Recordings list: keyboard and screen reader", () => {
	it("is one list whose cursor row is the only tab stop, every row placed in the whole set", async () => {
		const html = await rendered()
		const list = /<div[^>]*role="list"[^>]*aria-label="Recordings"[^>]*>/.exec(
			html,
		)?.[0]
		expect(list).toBeDefined()
		// the rows carry the tab stop (roving), not the list
		expect(list).not.toMatch(/tabindex/)
		const rows = [...html.matchAll(/<article[^>]*role="listitem"[^>]*>/g)].map(
			m => m[0],
		)
		expect(rows).toHaveLength(3)
		expect(rows.filter(r => r.includes('tabindex="0"'))).toHaveLength(1)
		expect(rows[0]).toContain('tabindex="0"')
		expect(rows.slice(1).every(r => r.includes('tabindex="-1"'))).toBe(true)
		rows.forEach((r, i) => {
			expect(r).toContain('aria-setsize="3"')
			expect(r).toContain(`aria-posinset="${i + 1}"`)
		})
	})

	it("day labels are presentation inside the list, never list children of their own", async () => {
		const html = await rendered()
		const body = html.slice(html.indexOf('role="list"'))
		expect(body).not.toMatch(/<h3/)
		const labels = [...body.matchAll(/<div[^>]*wkr-day-label[^>]*>/g)].map(
			m => m[0],
		)
		expect(labels.length).toBe(2)
		expect(labels.every(l => l.includes('role="presentation"'))).toBe(true)
	})

	it("Space and Enter on a control inside a row are the control's", () => {
		const ctx = {
			cursor: true,
			open: false,
			loaded: false,
			readOnly: false,
			deletable: true,
		}
		expect(listKeyAction({ key: " ", inControl: true }, ctx)).toBeNull()
		expect(listKeyAction({ key: "Enter", inControl: true }, ctx)).toBeNull()
		expect(listKeyAction({ key: "ArrowDown", inControl: true }, ctx)).toEqual({
			type: "move",
			by: 1,
		})
		expect(listKeyAction({ key: "s", inControl: true }, ctx)).toEqual({
			type: "keep",
		})
	})
})

describe("virtual list offsets", () => {
	// Feature: panels, Property 2: the offset tree answers as the full prefix sums do, after any updates
	it("matches prefix sums, the index at a height and the window, through updates", () => {
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 300 }), { maxLength: 80 }),
				fc.array(
					fc.tuple(fc.nat({ max: 79 }), fc.integer({ min: 0, max: 300 })),
					{ maxLength: 20 },
				),
				fc.integer({ min: 0, max: 30_000 }),
				fc.integer({ min: 1, max: 2000 }),
				(start, updates, scrollTop, viewport) => {
					const heights = [...start]
					const tree = new OffsetTree(heights)
					for (const [i, h] of updates) {
						if (i >= heights.length) continue
						heights[i] = h
						tree.set(i, h)
					}
					const offsets = prefixOffsets(heights)
					for (let i = 0; i <= heights.length; i++)
						expect(tree.top(i)).toBe(offsets[i])
					expect(tree.indexAt(scrollTop)).toBe(indexAt(offsets, scrollTop))
					expect(tree.window(scrollTop, viewport)).toEqual(
						virtualWindow(offsets, scrollTop, viewport),
					)
				},
			),
			{ numRuns: 200 },
		)
	})
})

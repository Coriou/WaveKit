import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"
import type { DecoderInfo } from "@wavekit/api-types"

import { ServicesContext } from "../../src/app/context.ts"
import { createServices, type AppServices } from "../../src/app/services.ts"
import { BandDecoders } from "../../src/features/tuned/BandDecoders.tsx"
import type { SummaryItem } from "../../src/features/tuned/band-table.ts"
import { DecoderVerdictsFeed } from "../../src/features/tuned/verdicts.ts"

const HZ = 1_090_000_000

const decoder = (over: Partial<DecoderInfo> & { id: string }): DecoderInfo => ({
	type: over.id,
	running: true,
	health: "running",
	uptime: 10,
	stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
	restartCount: 0,
	suspended: false,
	targetFrequenciesHz: [HZ],
	...over,
})

const item = (over: Partial<SummaryItem> & { id: string }): SummaryItem => ({
	name: "ADS-B",
	protocol: "readsb",
	verdict: { code: "decoding", text: "ADS-B decoding", actions: [] },
	lastOutputAt: null,
	eventsOut: 0,
	coversHz: true,
	...over,
})

let services: AppServices | null = null
afterEach(() => {
	services?.dispose()
	services = null
})

function render(items: readonly SummaryItem[], decoders: DecoderInfo[]) {
	// no core: every read fails, nothing is fetched while rendering
	services = createServices({
		fetch: async () => {
			throw new TypeError("offline")
		},
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
	const feed = new DecoderVerdictsFeed(services.data)
	const html = renderToStaticMarkup(
		createElement(
			ServicesContext.Provider,
			{ value: services },
			createElement(BandDecoders, {
				hz: HZ,
				decoders,
				items,
				feed,
				now: Date.parse("2026-10-17T12:00:00Z"),
				readOnly: false,
			}),
		),
	)
	feed.dispose()
	return html
}

/** The `headers` of the first element whose markup includes `marker`, as header texts. */
function headersOf(doc: string, marker: string): string[] {
	const at = doc.indexOf(marker)
	expect(at).toBeGreaterThan(-1)
	const open = doc.lastIndexOf("<t", at)
	const tag = doc.slice(open, doc.indexOf(">", open))
	const ids = /headers="([^"]+)"/.exec(tag)?.[1]?.split(" ") ?? []
	return ids.map(id => {
		const start = doc.indexOf(`id="${id}"`)
		expect(start, id).toBeGreaterThan(-1)
		const from = doc.indexOf(">", start) + 1
		const text = doc.slice(from, doc.indexOf("</t", from))
		return text
			.replace(/<[^>]+>/g, " ")
			.replace(/\s+/g, " ")
			.trim()
	})
}

describe("On this band table semantics", () => {
	it("names the detail and action headers for each decoder's cells and keeps table roles", () => {
		const html = render(
			[
				item({
					id: "readsb",
					verdict: {
						code: "failed",
						text: "ADS-B failed: restarting on its own",
						actions: [],
					},
				}),
				item({
					id: "pager",
					name: "Pager",
					protocol: "multimon-ng",
					verdict: {
						code: "stopped",
						text: "Pager stopped",
						actions: ["start"],
					},
				}),
			],
			[
				decoder({ id: "readsb", health: "restarting", running: false }),
				decoder({ id: "pager", type: "multimon-ng", running: false }),
			],
		)
		expect(html).toContain('role="table"')
		expect(html).toContain('role="rowgroup"')
		expect(html).toContain('role="columnheader"')
		expect(html).toContain('role="rowheader"')
		expect(html).toContain('role="cell"')
		// visually hidden headers for the detail line and the action
		expect(html).toMatch(/class="wk-sr"[^>]*>Detail</)
		expect(html).toMatch(/class="wk-sr"[^>]*>Action</)
		expect(headersOf(html, "Restarting on its own")).toEqual([
			"ADS-B readsb",
			"Detail",
		])
		expect(headersOf(html, "Stopped<")).toEqual(["Pager multimon-ng", "Detail"])
		expect(headersOf(html, 'aria-label="Start: Pager"')).toEqual([
			"Pager multimon-ng",
			"Action",
		])
		expect(headersOf(html, ">Failed<")).toEqual(["ADS-B readsb", "State"])
		expect(headersOf(html, ">Never<")).toEqual(["ADS-B readsb", "Last decode"])
	})

	it("renders nothing when no decoder's band holds the frequency", () => {
		expect(
			render(
				[item({ id: "readsb", coversHz: false })],
				[decoder({ id: "readsb" })],
			),
		).toBe("")
	})
})

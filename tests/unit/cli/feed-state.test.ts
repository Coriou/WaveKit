import { beforeAll, describe, expect, it } from "vitest"
import { initialState } from "../../../cli/source/data/reducers.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { fitGroups } from "../../../cli/source/ui/fit.js"
import { formatMessage } from "../../../cli/source/ui/messages/index.js"
import { lineText } from "../../../cli/source/ui/text.js"
import { glyphs } from "../../../cli/source/ui/theme.js"
import {
	emptyFeedGroups,
	noDataText,
} from "../../../cli/source/view-models/feed-state.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})
const deps = { summarize: formatMessage }
type S = ReturnType<typeof scenarioState>
const reason = (s: S, w = 199) =>
	lineText(fitGroups(emptyFeedGroups(s), w, { sep: ` ${glyphs().sep} ` }))

describe("M3: an empty feed names the first broken link", () => {
	it("API down before the feed ever opened", () => {
		expect(reason(scenarioState("api-down", deps))).toBe(
			"no feed · API unreachable",
		)
	})
	it("ws closed while REST answers", () => {
		const s = scenarioState("rest-only", deps)
		expect(reason(s)).toBe(
			`no feed · ws closed ${s.conn.ws.code} · polling REST`,
		)
	})
	it("connecting on a cold start", () => {
		expect(reason(initialState(Date.parse("2026-10-08T18:07:52Z")))).toBe(
			"no feed · connecting to /ws",
		)
	})
	it("iq disconnected, never the band plan", () => {
		const text = reason(scenarioState("iq-disconnected", deps))
		expect(text).toMatch(/^no decodes · iq disconnected( \d+[smhd].*)?$/)
		expect(text).not.toContain("in window")
	})
	it("iq without samples", () => {
		expect(reason(scenarioState("iq-stale", deps))).toMatch(
			/^no decodes · iq no samples \d+s$/,
		)
	})
	it("a known window with no decoder in it", () => {
		const s = scenarioState("idle", deps)
		const out = {
			...s,
			decoders: {
				...s.decoders,
				// Tuned types always read "in" (R40), so only non-tuned decoders here.
				value: s.decoders
					.value!.filter(d => !["dsd-fme", "multimon-ng"].includes(d.id))
					.map(d => ({ ...d, targetFrequenciesHz: [100_000_000] })),
			},
		}
		const text = reason(out)
		expect(text).toMatch(
			/^no decodes · 0 of \d+ decoders in window · rx 445\.971 MHz$/,
		)
	})
	it("a healthy chain says for how long, then the window and rx", () => {
		const text = reason(scenarioState("idle", deps))
		expect(text).toMatch(
			/^no decodes for .+? · \d+ of \d+ in window · rx 445\.971 MHz · since \d\d:\d\d$/,
		)
		for (const name of [
			"api-down",
			"rest-only",
			"iq-disconnected",
			"iq-stale",
			"idle",
		] as const)
			expect(findBanned(reason(scenarioState(name, deps)))).toEqual([])
	})
	it("narrow widths keep the first clause", () => {
		expect(reason(scenarioState("idle", deps), 30)).toMatch(/^no decodes for /)
	})
})

describe("M4: section copy when data is missing", () => {
	it("REST failing while the WS is live says so", () => {
		expect(noDataText(scenarioState("ws-only", deps), "/api/sources")).toBe(
			"no data · REST failing (timeout 2s) · ws live",
		)
	})
	it("API down", () => {
		expect(noDataText(scenarioState("api-down", deps), "/api/sources")).toBe(
			"no data · API unreachable",
		)
	})
	it("cold start", () => {
		expect(noDataText(initialState(0), "/api/sources")).toBe(
			"fetching /api/sources",
		)
	})
})

import { describe, expect, it } from "vitest"
import {
	guardSource,
	parseServerMessage,
} from "../../../cli/source/data/guards.js"
import { reduce } from "../../../cli/source/data/reducers.js"
import type {
	AppState,
	Inbound,
	SourceRow,
} from "../../../cli/source/data/types.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { formatMessage } from "../../../cli/source/ui/messages/index.js"
import { stripLine } from "../../../cli/source/ui/strip.js"
import { lineText } from "../../../cli/source/ui/text.js"
import { setGlyphMode } from "../../../cli/source/ui/theme.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"
import { stripInput } from "../../../cli/source/view-models/chrome.js"
import { emptyFeedGroups } from "../../../cli/source/view-models/feed-state.js"
import { receiverSummary } from "../../../cli/source/view-models/overview.js"
import { receiverLines } from "../../../cli/source/view-models/receiver.js"

const deps = { summarize: formatMessage }
const live = scenarioState("live", deps)
const src0 = live.sources.value![0]!
const FLAT = {
	levelDbfs: -46.04,
	thresholdDbfs: -40,
	since: "2026-10-08T18:07:00.000Z",
}
const withSource = (over: Partial<SourceRow>): AppState => ({
	...live,
	sources: { ...live.sources, value: [{ ...src0, ...over }] },
})
const flat = withSource({ signalFlat: FLAT, signalLevelDbfs: -46.04 })
const raw = (over: Record<string, unknown>) => ({
	id: "pi-iq",
	connected: true,
	consumers: 1,
	bytesReceived: 1,
	dataRate: 1,
	reconnectAttempts: 0,
	available: true,
	caps: {
		kind: "iq",
		sampleRate: 2_048_000,
		format: "U8_IQ",
		exclusive: false,
	},
	assignments: [],
	...over,
})

describe("A11 guards", () => {
	it("keeps signalFlat whole or not at all, and a numeric level", () => {
		expect(
			guardSource(raw({ signalFlat: FLAT, signalLevelDbfs: -23.4 })),
		).toMatchObject({ signalFlat: FLAT, signalLevelDbfs: -23.4 })
		for (const bad of [
			{ levelDbfs: -46, thresholdDbfs: -40 },
			{ ...FLAT, levelDbfs: "low" },
			{ ...FLAT, thresholdDbfs: Number.NaN },
			"flat",
		]) {
			const s = guardSource(raw({ signalFlat: bad, signalLevelDbfs: "x" }))
			expect(s?.id).toBe("pi-iq")
			expect(s && "signalFlat" in s).toBe(false)
			expect(s && "signalLevelDbfs" in s).toBe(false)
		}
	})
	it("parses source:removed", () => {
		expect(
			parseServerMessage({
				type: "source:removed",
				channel: "sources",
				data: { sourceId: "pi-iq", removedAt: "2026-10-08T18:08:00.000Z" },
			}),
		).toEqual({ type: "source:removed", sourceId: "pi-iq" })
		expect(
			parseServerMessage({
				type: "source:removed",
				channel: "sources",
				data: { removedAt: "x" },
			}),
		).toBeUndefined()
	})
})

describe("A11 source:removed", () => {
	const removed = (at: number): Inbound => ({
		kind: "ws",
		at,
		event: { type: "source:removed", sourceId: "pi-iq" },
	})
	it("drops the row, its tuner and its metrics; a later status brings it back", () => {
		const at = live.now + 1
		const s = reduce(live, [removed(at)], at)
		expect(s.sources.value).toEqual([])
		expect(s.tuner.value?.some(t => t.sourceId === "pi-iq")).toBe(false)
		expect(s.metrics["pi-iq"]).toBeUndefined()
		const text = receiverLines(s, initialUi("receiver"), 199, 40, true).map(
			lineText,
		)
		expect(text.find(l => l.startsWith("SOURCE"))).toMatch(
			/no sources configured$/,
		)
		const back = reduce(
			s,
			[
				{
					kind: "ws",
					at: at + 1,
					event: { type: "source:status", source: src0 },
				},
			],
			at + 1,
		)
		expect(back.sources.value?.map(x => x.id)).toEqual(["pi-iq"])
	})
	it("an unknown id changes nothing", () => {
		const at = live.now + 1
		const s = reduce(
			live,
			[
				{
					kind: "ws",
					at,
					event: { type: "source:removed", sourceId: "nope" },
				},
			],
			at,
		)
		expect(s.sources.value).toEqual(live.sources.value)
	})
})

describe("A11 rendering", () => {
	it("Receiver: an attention line and the level as a plain fact", () => {
		const text = receiverLines(flat, initialUi("receiver"), 199, 40, true).map(
			lineText,
		)
		const line = text.find(l => l.includes("signal flat"))
		expect(line).toMatch(
			/! signal flat · −46\.0 dBFS below −40 dBFS · since \d\d:\d\d:\d\d · check gain$/,
		)
		expect(text.find(l => l.startsWith("rate"))).toContain("level −46.0 dBFS")
		// IQ keeps saying streaming: bytes are arriving.
		expect(text.find(l => l.startsWith("SOURCE"))).toContain("streaming")
		expect(findBanned(text.join("\n"))).toEqual([])
	})
	it("Receiver: the level alone, without the warning", () => {
		const text = receiverLines(
			withSource({ signalLevelDbfs: -23.44 }),
			initialUi("receiver"),
			199,
			40,
			true,
		).map(lineText)
		expect(text.find(l => l.startsWith("rate"))).toContain("level −23.4 dBFS")
		expect(text.join("\n")).not.toContain("signal flat")
	})
	it("strip: streaming stays, flat is said beside it, never a bare glyph", () => {
		const input = stripInput(flat)
		expect(lineText(stripLine(input, 200))).toContain(
			"iq ● streaming · signal flat −46 dBFS",
		)
		const narrow = lineText(stripLine(input, 60))
		expect(narrow).toMatch(/iq (! flat|● streaming · flat)/)
		setGlyphMode("ascii")
		try {
			expect(lineText(stripLine(stripInput(flat), 200))).toContain(
				"signal flat -46 dBFS",
			)
		} finally {
			setGlyphMode("utf8")
		}
	})
	it("Overview RECEIVER: a terse attention fact", () => {
		const lines = receiverSummary(flat, 199)
		expect(lines.map(lineText).join("\n")).toContain("signal flat −46 dBFS")
		const span = lines.flat().find(x => x.text.includes("signal flat"))
		expect(span?.role).toBe("attention")
	})
	it("empty feed: signal flat is the first broken link", () => {
		const text = emptyFeedGroups(flat)
			.map(g => g.variants[0]?.map(x => x.text).join("") ?? "")
			.join(" · ")
		expect(text).toBe("no decodes · signal flat −46 dBFS · check gain")
	})
})

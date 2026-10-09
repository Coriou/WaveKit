import { describe, expect, it } from "vitest"
import { laneOk } from "../../../cli/source/data/freshness.js"
import type { AppState, DecoderRow } from "../../../cli/source/data/types.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { formatMessage } from "../../../cli/source/ui/messages/index.js"
import { lineText } from "../../../cli/source/ui/text.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"
import { stripInput } from "../../../cli/source/view-models/chrome.js"
import { decodersModel } from "../../../cli/source/view-models/decoders.js"
import {
	emptyFeedGroups,
	noDataText,
} from "../../../cli/source/view-models/feed-state.js"
import {
	overviewModel,
	receiverSummary,
} from "../../../cli/source/view-models/overview.js"
import { receiverLines } from "../../../cli/source/view-models/receiver.js"

const deps = { summarize: formatMessage }
type S = AppState
const live = scenarioState("live", deps)
const groupsText = (s: S) =>
	emptyFeedGroups(s)
		.map(g => g.variants[0]?.map(x => x.text).join("") ?? "")
		.join(" · ")
const receiver = (s: S) =>
	receiverLines(s, initialUi("receiver"), 199, 40, true).map(lineText)
const withTuner = (s: S, value: S["tuner"]["value"]): S => ({
	...s,
	tuner: { ...s.tuner, value },
})

describe("views MUST 3: an answered empty lane says what came back", () => {
	it("TUNER: no tuner control for this source, never fetching", () => {
		for (const value of [
			[],
			[{ ...live.tuner.value![0]!, sourceId: "other" }],
		]) {
			const line = receiver(withTuner(live, value)).find(l =>
				l.startsWith("TUNER"),
			)
			expect(line).toMatch(/^TUNER +— · no tuner control for this source$/)
		}
	})
	it("SOURCE and the Overview receiver: no sources configured", () => {
		const s = { ...live, sources: { ...live.sources, value: [] } }
		expect(receiver(s).find(l => l.startsWith("SOURCE"))).toMatch(
			/^SOURCE +no sources configured$/,
		)
		expect(lineText(receiverSummary(s, 119)[0] ?? [])).toMatch(
			/^RECEIVER +no sources configured$/,
		)
	})
	it("a lane that never answered keeps the no-data copy", () => {
		const line = receiver(withTuner(live, undefined)).find(l =>
			l.startsWith("TUNER"),
		)
		expect(line).toMatch(/^TUNER +fetching \/api\/tuner$/)
	})
})

describe("views minors", () => {
	it("noDataText reads only its own endpoint", () => {
		const s: S = {
			...live,
			conn: {
				...live.conn,
				rest: {
					...live.conn.rest,
					failing: ["decoders"],
					firstFailAt: live.now - 5000,
				},
			},
		}
		expect(noDataText(s, "/api/tuner")).toBe("fetching /api/tuner")
		expect(noDataText(s, "/api/decoders")).toMatch(
			/^no data · GET \/api\/decoders failing/,
		)
	})
	it("a closed ws reads ws closed, even before REST ever answered", () => {
		const s: S = {
			...live,
			conn: {
				...live.conn,
				ws: { ...live.conn.ws, state: "closed", code: 1006 },
				rest: { ...live.conn.rest, lastOkAt: null, failing: [] },
			},
		}
		expect(groupsText(s)).toBe("no feed · ws closed 1006")
	})
	it("names the in-window decoders when all of them are faulted", () => {
		const rows = live.decoders.value!.map(
			(d): DecoderRow =>
				d.id === "dsd-fme" || d.id === "multimon-ng"
					? { ...d, running: false, health: "faulted" }
					: d,
		)
		const s = { ...live, decoders: laneOk(rows, live.now - 1000, "rest") }
		const text = groupsText(s)
		expect(text).toMatch(/^no decodes · dsd-fme, multimon-ng faulted/)
		expect(findBanned(text)).toEqual([])
	})
	it("one form: N of M in window", () => {
		const rows = live.decoders.value!.map(
			(d): DecoderRow =>
				d.id === "dsd-fme" || d.id === "multimon-ng"
					? { ...d, bandAssessment: { verdict: "out-of-band" } }
					: d,
		)
		const s = { ...live, decoders: laneOk(rows, live.now - 1000, "rest") }
		expect(groupsText(s)).toMatch(/^no decodes · 0 of 9 in window/)
	})
	it("the strip and the Overview read rx from the same source", () => {
		const s = withTuner(live, [
			{ ...live.tuner.value![0]!, sourceId: "other", frequency: 100_000_000 },
		])
		const centre = live.sources.value![0]!.caps.centerFreq
		expect(stripInput(s).rx?.centreHz).toBe(centre)
		expect(stripInput(s).rx?.control).toBeNull()
	})
	it("the Overview marks the declared rate under rateMismatch", () => {
		const src = live.sources.value![0]!
		const s = {
			...live,
			sources: {
				...live.sources,
				value: [
					{
						...src,
						rateMismatch: {
							declaredSampleRateHz: 2_048_000,
							measuredSampleRateHz: 1_024_000,
							deviation: -0.5,
							since: "2026-10-08T18:07:00.000Z",
						},
					},
				],
			},
		}
		const text = receiverSummary(s, 199).map(lineText).join("\n")
		expect(text).toContain("2.048 MS/s declared · rate mismatch")
		const span = receiverSummary(s, 199)
			.flat()
			.find(x => x.text.includes("rate mismatch"))
		expect(span?.role).toBe("attention")
	})
	it("DECODERS without data puts the reason beside the title, no column header", () => {
		const s = scenarioState("api-down", deps)
		const ov = overviewModel(s, initialUi("overview"), 119, 30, true)
			.left.map(lineText)
			.join("\n")
		expect(ov).toMatch(/^ *DECODERS +no data · API unreachable$/m)
		expect(ov).not.toMatch(/DECODERS +process/)
		const dv = decodersModel(s, initialUi("decoders"), 119, 30, true).list.map(
			lineText,
		)
		expect(dv).toHaveLength(1)
		expect(dv[0]).toMatch(/^ *DECODERS +no data · API unreachable$/)
	})
})

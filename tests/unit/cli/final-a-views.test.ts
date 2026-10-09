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

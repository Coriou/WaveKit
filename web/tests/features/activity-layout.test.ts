import { afterEach, describe, expect, it } from "vitest"
import type { ActivitySummary } from "@wavekit/api-types"
import {
	activityLayout,
	setActivityLayout,
} from "../../src/features/activity/layout.ts"
import {
	estimateCardHeight,
	estimateHeight,
	listEntries,
} from "../../src/features/activity/rows.ts"

const item = (over: Partial<ActivitySummary> = {}): ActivitySummary => ({
	eventId: "e1",
	commitSeq: "1",
	kind: "decoder-reception",
	producedAt: "2026-10-17T12:00:00Z",
	receivedAt: "2026-10-17T12:00:00Z",
	decoderId: "d",
	sourceId: "s",
	protocol: "pocsag",
	category: "paging",
	frequencyHz: 160_450_000,
	entityKey: null,
	title: "Capcode 1234567",
	fields: [],
	...over,
})

describe("Activity layout", () => {
	afterEach(() => setActivityLayout("list"))

	it("switches between rows and cards", () => {
		setActivityLayout("cards")
		expect(activityLayout.get().layout).toBe("cards")
		setActivityLayout("list")
		expect(activityLayout.get().layout).toBe("list")
	})

	it("guesses a card taller than its row, and taller again with readings", () => {
		const [group, row] = listEntries(
			[item()],
			Date.parse("2026-10-17T12:00:30Z"),
		)
		expect(group && estimateCardHeight(group)).toBe(28)
		const bare = row ? estimateCardHeight(row) : 0
		expect(bare).toBeGreaterThan(row ? estimateHeight(row) : 0)
		const [, withFields] = listEntries(
			[
				item({
					fields: [
						{ key: "a", label: "A", value: 1 },
						{ key: "b", label: "B", value: 2 },
						{ key: "c", label: "C", value: 3 },
						{ key: "d", label: "D", value: 4 },
					],
				}),
			],
			Date.parse("2026-10-17T12:00:30Z"),
		)
		expect(withFields ? estimateCardHeight(withFields) : 0).toBeGreaterThan(
			bare,
		)
	})
})

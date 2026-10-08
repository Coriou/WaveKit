import { beforeAll, describe, expect, it } from "vitest"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { formatMessage } from "../../../cli/source/ui/messages/index.js"
import { cellWidth, lineText } from "../../../cli/source/ui/text.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"
import {
	emptyFeedLine,
	overviewModel,
	receiverSummary,
} from "../../../cli/source/view-models/overview.js"

beforeAll(() => {
	process.env["TZ"] = "UTC"
})
const deps = { summarize: formatMessage }

describe("overview view-model", () => {
	it("renders the receiver rows by width", () => {
		const s = scenarioState("live", deps)
		const [a, b] = receiverSummary(s, 119).map(lineText)
		expect(a).toBe(
			"RECEIVER  pi-iq · rtl_tcp 192.0.2.23:5555   ● streaming · sample age 4 ms   4.1 MB/s · 2.048 MS/s   relay 1 client",
		)
		expect(b).toBe(
			"window    444.947–446.995 MHz · centre 445.9707   external control · 192.0.2.1   last command 6m 32s ago",
		)
		const [c, d] = receiverSummary(s, 59).map(lineText)
		expect(c?.startsWith("RECEIVER  pi-iq   ● streaming")).toBe(true)
		expect(c).toContain("4.1 MB/s")
		expect(c).not.toContain("relay")
		expect(c).not.toContain("rtl_tcp")
		expect(d).toBe("window    444.947–446.995 MHz   external control")
	})
	it("fits every size and keeps ≥ 3 message rows", () => {
		const s = scenarioState("live", deps)
		for (const [w, h, roomy] of [
			[59, 13, false],
			[59, 17, false],
			[79, 21, false],
			[119, 35, true],
			[199, 45, true],
		] as const) {
			const m = overviewModel(s, initialUi("overview"), w, h, roomy)
			expect(m.left.length).toBeLessThanOrEqual(h)
			expect(m.right.length).toBeLessThanOrEqual(h)
			for (const l of [...m.left, ...m.right])
				expect(cellWidth(lineText(l))).toBeLessThanOrEqual(w)
			const msgRows = (m.layout === "columns" ? m.right : m.left).filter(l =>
				/\d\d:\d\d/.test(lineText(l)),
			).length
			expect(msgRows).toBeGreaterThanOrEqual(3)
			for (const l of [...m.left, ...m.right])
				expect(findBanned(lineText(l))).toEqual([])
		}
	})
	it("shows cached data with a gap row and ticking decode ages when the API is down", () => {
		const s = scenarioState("api-down-cached", deps)
		const text = overviewModel(s, initialUi("overview"), 79, 20, false)
			.left.map(lineText)
			.join("\n")
		expect(text).toContain("MESSAGES  feed stopped")
		expect(text).toMatch(/── gap since \d\d:\d\d:\d\d · 2m 3\ds ──/)
		expect(text).toMatch(/dsd-fme .* ago/)
	})
	it("explains a cold start with the API down", () => {
		const text = overviewModel(
			scenarioState("api-down", deps),
			initialUi("overview"),
			79,
			20,
			false,
		)
			.left.map(lineText)
			.join("\n")
		expect(text).toContain("no data · API unreachable")
	})
})

describe("overview truth details", () => {
	it("the empty feed line never prints rx 0.000 MHz (R44)", () => {
		const s = scenarioState("idle", deps)
		const zero = {
			...s,
			tuner: {
				...s.tuner,
				value: s.tuner.value!.map(t => ({ ...t, frequency: 0 })),
			},
		}
		const text = lineText(emptyFeedLine(zero))
		expect(text).toMatch(/^no decodes since /)
		expect(text).not.toContain("0.000 MHz")
		expect(lineText(emptyFeedLine(s))).toContain("rx 445.971 MHz")
	})
	it("sanitises server strings in the receiver row", () => {
		const s = scenarioState("live", deps)
		const hostile = {
			...s,
			sources: {
				...s.sources,
				value: s.sources.value!.map(x => ({
					...x,
					id: "pi\u001b[2J\u202Eiq",
					type: "rtl\u0007tcp",
				})),
			},
		}
		const [a] = receiverSummary(hostile, 119).map(lineText)
		expect(a).toContain("RECEIVER  piiq · rtltcp")
		expect(a).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u202E]/)
	})
})

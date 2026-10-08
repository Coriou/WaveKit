import { beforeAll, describe, expect, it } from "vitest"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { findBanned } from "../../../cli/source/ui/copy-rules.js"
import { formatMessage } from "../../../cli/source/ui/messages/index.js"
import { cellWidth, lineText } from "../../../cli/source/ui/text.js"
import { initialUi } from "../../../cli/source/ui/ui-state.js"
import {
	emptyFeedLine,
	feedHeader,
	overviewModel,
	receiverSummary,
} from "../../../cli/source/view-models/overview.js"
import { initialState } from "../../../cli/source/data/reducers.js"
import { formatClock } from "../../../cli/source/ui/format.js"

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

describe("decoder table kinds and dimming (B4 API)", () => {
	it("uses the narrow column set below 79 columns", () => {
		const s = scenarioState("live", deps)
		const narrow = overviewModel(
			s,
			initialUi("overview"),
			59,
			19,
			false,
		).left.map(lineText)
		const header = narrow.find(l => l.includes("DECODERS")) ?? ""
		// The narrow set keeps drop and window at 60 columns (§6.1 60×20 mockup).
		expect(header).toMatch(/DECODERS +process +decodes +drop +window$/)
		expect(header).not.toContain("lifetime")
		expect(header).not.toContain("nominal")
		const wide = overviewModel(
			s,
			initialUi("overview"),
			119,
			35,
			true,
		).left.map(lineText)
		expect(wide.find(l => l.includes("DECODERS"))).toContain("lifetime")
	})
	it("dims every decoder row when the decoders lane is old (§6.1 API down)", () => {
		const m = overviewModel(
			scenarioState("api-down-cached", deps),
			initialUi("overview"),
			79,
			22,
			false,
		)
		const rows = m.left.filter(
			l => /^ ?[●!×○?] /.test(lineText(l)) || lineText(l).includes("dsd-fme"),
		)
		expect(rows.length).toBeGreaterThan(0)
		for (const l of rows)
			for (const sp of l) if (sp.text.trim() !== "") expect(sp.role).toBe("old")
		const live = overviewModel(
			scenarioState("live", deps),
			initialUi("overview"),
			79,
			22,
			false,
		)
		const liveRow = live.left.find(l => lineText(l).includes("dsd-fme")) ?? []
		expect(liveRow.some(sp => sp.role !== "old" && sp.text.trim() !== "")).toBe(
			true,
		)
	})
})

describe("A6 fix 1: feed truth", () => {
	const feedText = (st: ReturnType<typeof scenarioState>, w = 79, h = 22) =>
		overviewModel(st, initialUi("overview"), w, h, false)
			.left.map(lineText)
			.join("\n")
	it("C1: a full ring that turns over within 60 s shows N+", () => {
		const s = scenarioState("live", deps)
		const ring = {
			...s.messages.ring,
			capacity: s.messages.ring.entries.length,
			entries: s.messages.ring.entries.map(e => ({
				...e,
				receivedAt: s.now - 1000,
			})),
		}
		const full = { ...s, messages: { version: s.messages.version + 1, ring } }
		expect(lineText(feedHeader(full))).toContain("7+ in 60s")
	})
	it("I2: feed stopped is anchored on the open gap, not the last retry", () => {
		const s = scenarioState("api-down-cached", deps)
		const gap = s.messages.ring.gaps.find(g => g.to === null)
		expect(gap).toBeDefined()
		const header = lineText(feedHeader(s))
		expect(header).toContain(`feed stopped ${formatClock(gap!.from)}`)
		const retried = {
			...s,
			conn: { ...s.conn, ws: { ...s.conn.ws, since: s.now - 500 } },
		}
		expect(lineText(feedHeader(retried))).toBe(header)
	})
	it("I1: a cold start with the API down shows §9 copy, never 0 counts or no decodes since", () => {
		const text = feedText(scenarioState("api-down", deps))
		expect(text).toContain("MESSAGES  ? in 60s · ? total")
		expect(text).not.toMatch(/\b0 in 60s|0 total|no decodes since/)
		expect(
			text.split("\n").filter(l => l.includes("no data · API unreachable"))
				.length,
		).toBeGreaterThanOrEqual(2)
	})
	it("I1: a cold start before any answer says so without counts", () => {
		const cold = initialState(Date.parse("2026-10-08T18:07:52Z"))
		const text = feedText(cold)
		expect(text).toContain("MESSAGES  ? in 60s · ? total")
		expect(text).toContain("connecting to /ws")
		expect(text).not.toMatch(/no decodes since|0 total/)
	})
	it("the empty state line still shows while the feed is live and empty", () => {
		expect(feedText(scenarioState("idle", deps))).toMatch(/no decodes since/)
	})
})

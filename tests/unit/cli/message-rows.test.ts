import { describe, expect, it } from "vitest"
import type { MessageEntry } from "../../../cli/source/data/types.js"
import { scenarioState } from "../../../cli/source/test/fixtures.js"
import { formatMessage } from "../../../cli/source/ui/messages/index.js"
import { lineText, lineWidth } from "../../../cli/source/ui/text.js"
import {
	feedCounts,
	feedLines,
	gapLine,
	interleave,
	messageLayout,
	messageRow,
	newestFirst,
	summaryLine,
} from "../../../cli/source/view-models/message-rows.js"

// Row times are local; expectations are built from the same instants with
// local getters so the file passes in any timezone (no TZ mutation).
const pad2 = (n: number): string => String(n).padStart(2, "0")
const hhmm = (ms: number): string => {
	const d = new Date(ms)
	return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}
const hhmmss = (ms: number): string =>
	`${hhmm(ms)}:${pad2(new Date(ms).getSeconds())}`

describe("message rows", () => {
	const s = scenarioState("live", { summarize: formatMessage })
	const entries = newestFirst(s.messages.ring)
	const at = (i: number): MessageEntry => {
		const e = entries[i]
		if (!e) throw new Error(`no entry ${i}`)
		return e
	}

	it("orders newest first and counts the last minute", () => {
		expect(entries[0]?.decoderId).toBe("dsd-fme")
		expect(feedCounts(s.messages.ring, s.now)).toEqual({
			in60s: 3,
			total: 7,
			cached: 7,
		})
	})

	it("renders time, decoder, type and a fitted summary", () => {
		const layout = messageLayout(119)
		const row = lineText(messageRow(at(0), layout, false, false))
		expect(
			row.startsWith(
				`${hhmmss(at(0).receivedAt)}  dsd-fme       DMR     TG 2350  SRC 2341234`,
			),
		).toBe(true)
		const narrow = messageLayout(59)
		expect(narrow.map(c => c.id)).toEqual(["time", "decoder", "summary"])
		expect(lineText(messageRow(at(0), narrow, false, false))).toMatch(
			new RegExp(`^${hhmm(at(0).receivedAt)} +dsd-fme +TG 2350`),
		)
		for (const e of entries)
			expect(
				lineWidth(messageRow(e, narrow, false, false)),
			).toBeLessThanOrEqual(59)
	})

	it("matches the §6.1 80×24 and 60×20 message rows", () => {
		const row = (i: number, w: number): string =>
			lineText(messageRow(at(i), messageLayout(w), false, false)).trimEnd()
		expect(row(0, 79)).toBe(
			`${hhmmss(at(0).receivedAt)}  dsd-fme       DMR     TG 2350  SRC 2341234  8.4 s  encrypted  …`,
		)
		expect(row(1, 79)).toBe(
			`${hhmmss(at(1).receivedAt)}  multimon-ng   POCSAG  1234567  fn 3  FIRE ALARM ACTIVATION - 12 LONG…`,
		)
		expect(row(0, 59)).toBe(
			`${hhmm(at(0).receivedAt)}  dsd-fme      TG 2350  SRC 2341234  8.4 s  …`,
		)
		expect(row(1, 59)).toBe(
			`${hhmm(at(1).receivedAt)}  multimon-ng  1234567  fn 3  FIRE ALARM ACTIVATION -…`,
		)
	})

	it("cuts free text at the row end and marks dropped segments", () => {
		const pager = entries.find(e => e.formatted.text?.startsWith("FIRE"))
		if (!pager) throw new Error("no pager entry")
		const line = lineText(summaryLine(pager.formatted, 40))
		expect(line.startsWith("1234567  fn 3  FIRE ALARM")).toBe(true)
		expect(line.endsWith("…")).toBe(true)
		expect(lineText(summaryLine(at(0).formatted, 30)).endsWith("…")).toBe(true)
	})

	it("renders open and closed gaps", () => {
		const now = Date.parse("2026-10-08T18:10:11Z")
		const from = Date.parse("2026-10-08T18:07:40Z")
		expect(lineText(gapLine({ afterSeq: 1, from, to: null }, now, 80))).toBe(
			`── gap since ${hhmmss(from)} · 2m 31s ──`,
		)
		const a = Date.parse("2026-10-08T18:08:37Z")
		const b = Date.parse("2026-10-08T18:10:41Z")
		expect(lineText(gapLine({ afterSeq: 1, from: a, to: b }, now, 80))).toBe(
			`── gap ${hhmmss(a)}–${hhmmss(b)} · 2m 04s · not replayed ──`,
		)
	})

	it("interleaves gaps by afterSeq and keeps the selection in view", () => {
		const rows = interleave(entries, [{ afterSeq: at(3).seq, from: 1, to: 2 }])
		expect(rows[3]?.kind).toBe("gap")
		const out = feedLines(rows, 79, 3, at(6).seq, s.now, false)
		expect(out.shownSeqs).toContain(at(6).seq)
		expect(out.lines).toHaveLength(3)
	})

	it("sanitises server-sent decoder ids (review focus 4)", () => {
		const e: MessageEntry = { ...at(0), decoderId: "x\x1b[2J\u202Ey" }
		const line = lineText(messageRow(e, messageLayout(119), false, false))
		expect(/[\u0000-\u001f\u007f-\u009f\u202E]/.test(line)).toBe(false)
	})
})

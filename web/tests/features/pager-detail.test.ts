import { expect, it } from "vitest"
import type { ActivityRecord, ActivitySummary } from "@wavekit/api-types"
import {
	pagerDetailItem,
	sanitisePagerMessage,
} from "../../src/features/activity/pager-detail.ts"
import { rowView } from "../../src/features/activity/rows.ts"
import { messageView } from "../../src/features/messages/card.ts"

function fixture(message: string, presented: string) {
	const item: ActivitySummary = {
		eventId: "synthetic",
		commitSeq: "1",
		kind: "decoder-reception",
		producedAt: "2026-10-01T00:00:00Z",
		receivedAt: "2026-10-01T00:00:00Z",
		decoderId: "synthetic",
		sourceId: null,
		protocol: "pocsag",
		category: "paging",
		frequencyHz: null,
		entityKey: null,
		title: "Synthetic page…",
		fields: [{ key: "message", label: "Message", value: presented }],
	}
	const record: ActivityRecord = {
		version: 1,
		eventId: item.eventId,
		commitSeq: item.commitSeq,
		producedAt: item.producedAt,
		receivedAt: item.receivedAt,
		kind: "decoder-reception",
		payload: {
			version: 1,
			eventId: item.eventId,
			producedAt: item.producedAt,
			receivedAt: item.receivedAt,
			decoderId: "synthetic",
			outputType: "message",
			protocol: item.protocol,
			category: item.category,
			title: item.title,
			entityKey: null,
			fields: item.fields,
			provenance: { sourceId: null, frequency: null },
			decodedData: { message },
		},
	}
	return { item, record }
}
it.each([126, 127, 500])(
	"expands clipped pager detail at %i bytes while leaving the list and title clipped",
	length => {
		const message = "S".repeat(length)
		const presented = length > 126 ? `${message.slice(0, 123)}…` : message
		const { item, record } = fixture(message, presented)
		const detail = pagerDetailItem(item, record)
		expect(messageView(detail, record).text).toBe(message)
		expect(rowView(item).message).toBe(presented)
		expect(detail.title).toBe(item.title)
		expect(record.payload.decodedData).toEqual({ message })
	},
)
it("strips every multimon control marker from the expanded body", () => {
	const names =
		"NUL SOH STX ETX EOT ENQ ACK BEL BS HT LF VT FF CR SO SI DLE DC1 DC2 DC3 DC4 NAK SYN ETB CAN EM SUB ESC FS GS RS US DEL".split(
			" ",
		)
	const message = `Synthetic${names.map(n => `<${n}>`).join("")} body<EOT>`
	const { item, record } = fixture(message, "Synthetic…")
	expect(rowView(pagerDetailItem(item, record)).message).toBe("Synthetic body")
	expect(pagerDetailItem(item, null)).toBe(item)
})
it.each([
	["pocsag", "123456789", "123456789"],
	["flex", "Synthetic FLEX body", "Synthetic FLEX body"],
	[
		"pocsag",
		" \u0000Synthetic<NUL>\u0085 body<ETX>\u009f<EOT> ",
		"Synthetic body",
	],
])(
	"shows a sanitised %s fallback body without a presented message: %s",
	(protocol, message, expected) => {
		const { item, record } = fixture(message, "")
		item.protocol = protocol
		item.fields = []
		record.payload.protocol = protocol
		record.payload.fields = []
		for (const summary of [item, pagerDetailItem(item, record)]) {
			const view = messageView(summary, record)
			expect(view.text).toBe(expected)
			expect(view.toneOnly).toBe(false)
			expect(view.mono).toBe(expected === "123456789")
			expect(view.fields.some(f => f.key === "message")).toBe(false)
			expect(view.raw).toEqual({ message })
		}
	},
)
it.each([0, 1])(
	"does not restore a marker-only page as a Message field for function %i",
	fn => {
		const message = "<NUL><EOT>\u0000\u0004"
		const { item, record } = fixture(message, "")
		item.fields = []
		record.payload.fields = []
		const raw = {
			protocol: "POCSAG1200",
			address: 123,
			function: fn,
			messageType: "alpha",
			message,
		}
		record.payload.decodedData = raw
		for (const summary of [item, pagerDetailItem(item, record)]) {
			const view = messageView(summary, record)
			expect(view.text).toBeNull()
			expect(view.fields.some(f => f.key === "message")).toBe(false)
			expect(view.raw).toEqual(raw)
		}
	},
)
it.each(["Synthetic body", "Synthetic…"])(
	"does not restore inner markers through the card grid with presented body %s",
	presented => {
		const message = "Synthetic<NUL>\u0000 body<EOT>"
		const { item, record } = fixture(message, presented)
		const detail = pagerDetailItem(item, record)
		const detailRecord = {
			...record,
			payload: { ...record.payload, fields: detail.fields },
		}
		for (const view of [
			messageView(item, record),
			messageView(detail, detailRecord),
		]) {
			expect(view.fields.some(f => f.key === "message")).toBe(false)
			expect(view.raw).toEqual({ message })
		}
		expect(messageView(detail, detailRecord).text).toBe("Synthetic body")
	},
)
it("treats a tone only as a notice without a tone-only reception body", () => {
	const { item } = fixture("", "")
	item.fields = [{ key: "label", label: "Label", value: "tone only" }]
	const view = messageView(item)
	expect(view.notice).toBe(true)
	expect(view.toneOnly).toBe(false)
})

it.each([
	"<CR><LF>",
	"<HT>",
	"<VT>",
	"<FF>",
	"<RS>",
	"<US>",
	"\r\n",
	"\t",
	"\v",
	"\f",
	"\u001e",
	"\u001f",
])(
	"preserves words separated by %j in expanded and fallback bodies",
	separator => {
		const message = `  UNIT 5${separator}RESPOND  NOW<NUL>\u0000\u0085 `
		const { item, record } = fixture(message, "UNIT 5…")
		expect(sanitisePagerMessage(message)).toBe("UNIT 5 RESPOND NOW")
		expect(messageView(pagerDetailItem(item, record), record).text).toBe(
			"UNIT 5 RESPOND NOW",
		)
		item.fields = []
		record.payload.fields = []
		expect(messageView(item, record).text).toBe("UNIT 5 RESPOND NOW")
	},
)
it("strips non-whitespace markers and controls without inserting spaces", () => {
	expect(sanitisePagerMessage("Syn<NUL>\u0000\u0085thetic")).toBe("Synthetic")
})
it("keeps tone only labels outside paging as ordinary receptions", () => {
	const { item } = fixture("", "")
	item.category = "other"
	item.fields = [{ key: "label", label: "Label", value: "tone only" }]
	expect(rowView(item).notice).toBe(false)
	expect(messageView(item).notice).toBe(false)
})
it("uses the tone only fallback title for a compact paging notice", () => {
	const { item } = fixture("", "")
	item.title = null
	item.fields = [{ key: "label", label: "Label", value: "tone only" }]
	expect(rowView(item)).toMatchObject({
		title: "tone only",
		icon: null,
		message: null,
		readings: null,
		notice: true,
	})
})

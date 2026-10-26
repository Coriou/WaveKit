import { describe, expect, it } from "vitest"
import { presentTextual } from "../../../../../src/core/activity/presentation/pager.js"
import { LONG_TEXT_BYTES } from "../../../../../src/core/activity/presentation/budget.js"

const names =
	"NUL SOH STX ETX EOT ENQ ACK BEL BS HT LF VT FF CR SO SI DLE DC1 DC2 DC3 DC4 NAK SYN ETB CAN EM SUB ESC FS GS RS US DEL".split(
		" ",
	)
const page = (message: string, fn = 1) => ({
	protocol: "POCSAG1200",
	capcode: 123,
	function: fn,
	message,
})

describe("pager presentation", () => {
	it.each(names)(
		"removes inner and trailing <%s> without changing the payload",
		name => {
			const raw = page(`Synthetic<${name}> text<${name}>`)
			const view = presentTextual("message", raw)
			expect(view?.title).toContain("Synthetic text")
			expect(view?.fields?.find(f => f.key === "message")?.value).toBe(
				"Synthetic text",
			)
			expect(raw.message).toBe(`Synthetic<${name}> text<${name}>`)
		},
	)
	it.each(["", "  ", names.map(n => `<${n}>`).join("")])(
		"labels empty function-zero pages as network beacons",
		message => {
			const view = presentTextual("message", page(message, 0))
			expect(view?.title).toContain("network beacon")
			expect(view?.fields).toContainEqual({
				key: "label",
				label: "Label",
				value: "network beacon",
			})
		},
	)
	it("keeps ordinary tone pages and nonempty function-zero messages", () => {
		expect(presentTextual("message", page("", 1))?.title).not.toContain(
			"network beacon",
		)
		expect(
			presentTextual("message", page("Synthetic", 0))?.title,
		).not.toContain("network beacon")
	})
	it.each([LONG_TEXT_BYTES, LONG_TEXT_BYTES + 1])(
		"preserves the presentation byte budget at %i bytes",
		length => {
			const value = presentTextual(
				"message",
				page("S".repeat(length)),
			)?.fields?.find(f => f.key === "message")?.value
			expect(typeof value).toBe("string")
			expect(Buffer.byteLength(String(value))).toBeLessThanOrEqual(
				LONG_TEXT_BYTES,
			)
			expect(String(value).endsWith("…")).toBe(length > LONG_TEXT_BYTES)
		},
	)
})

import { describe, expect, it } from "vitest"
import { findBanned, stripQuoted } from "../../../cli/source/ui/copy-rules.js"

describe("findBanned", () => {
	it("flags verdicts, filler and blame words", () => {
		expect(findBanned("receiver OK")).toContain("OK")
		expect(findBanned("Loading decoders")).toContain("Loading")
		expect(findBanned("decoder is slow")).toContain("slow")
		expect(findBanned("No messages yet")).toContain("No … yet")
		expect(findBanned("Status: up")).toContain("Status:")
		expect(findBanned("Connected")).toContain("Connected")
		expect(findBanned("all done!")).toContain("sentence !")
		expect(findBanned("rocket 🚀")).toContain("emoji")
		expect(findBanned("❤️")).toContain("emoji")
		expect(findBanned("ok ☀️ now")).toContain("emoji")
	})
	it("accepts the spec's own copy", () => {
		const ok = [
			" api ● 2s  iq ● streaming · 4.1 MB/s  drops !34% now",
			" ! API unreachable · ECONNREFUSED · retry in 4s",
			" ● readsb  up 51s  none for 51s  !38%  out",
			" sent · frequency ok 18:07:52 · gain ok",
			" ▶ restart readsb · up 51s · pid 1531   y restart  n cancel",
			" squawk !7700 emergency",
			" iq ● connected · no samples",
		]
		for (const line of ok) expect(findBanned(line)).toEqual([])
	})
	it("ignores server text inside double quotes", () => {
		expect(stripQuoted('CORE reports "healthy"')).toBe('CORE reports ""')
		expect(findBanned('CORE reports "healthy"')).toEqual([])
	})
})

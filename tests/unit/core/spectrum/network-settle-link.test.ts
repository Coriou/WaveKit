import { describe, expect, it } from "vitest"
import { settleLinkOf } from "../../../../src/core/spectrum/network-settle.js"

describe("settleLinkOf", () => {
	it("calls loopback hosts local and every other host the network", () => {
		expect(settleLinkOf({ host: "127.0.0.1" })).toBe("local")
		expect(settleLinkOf({ host: "localhost" })).toBe("local")
		expect(settleLinkOf({ host: "::1" })).toBe("local")
		expect(settleLinkOf({})).toBe("local")
		expect(settleLinkOf({ host: "receiver.example" })).toBe("network")
		expect(settleLinkOf(undefined)).toBe("network")
	})
})

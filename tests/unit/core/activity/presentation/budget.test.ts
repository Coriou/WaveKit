import { describe, expect, it } from "vitest"
import {
	ROW_GROWTH_COALESCED_BYTES,
	ROW_GROWTH_MAX_BYTES,
	truncateUtf8,
} from "../../../../../src/core/activity/presentation/budget.js"
import { presentDecoderOutput } from "../../../../../src/core/activity/presentation/registry.js"
import { decoderOutput, presentationGrowth } from "./measure.js"

describe("UTF-8 truncation", () => {
	it("keeps a character that ends on the byte boundary", () => {
		expect(truncateUtf8("ééé", 4)).toBe("éé")
		expect(truncateUtf8("ééé", 4)).not.toContain("\uFFFD")
		expect(truncateUtf8("éé", 3)).toBe("é")
		expect(truncateUtf8("é", 1)).toBe("")
		expect(truncateUtf8("a😀b", 5)).toBe("a😀")
		expect(truncateUtf8("😀", 3)).toBe("")
		expect(truncateUtf8("abcd", 2)).toBe("ab")
	})
})

describe("built-row growth bounds", () => {
	it("keeps a long APRS position title inside the coalesced bound", () => {
		const output = decoderOutput("aprs", {
			source: "N0CALL",
			dataType: "Position with timestamp and messaging",
			lat: 51,
			lon: 4,
		})
		const view = presentDecoderOutput(output, "measure")
		expect(view).toMatchObject({
			category: "aprs",
			protocol: "aprs",
			entityKey: "callsign:N0CALL",
			position: { lat: 51, lon: 4 },
		})
		expect(view?.fields).toBeUndefined()
		expect(view?.title?.startsWith("N0CALL")).toBe(true)
		expect(presentationGrowth(output).growth).toBeLessThanOrEqual(
			ROW_GROWTH_COALESCED_BYTES,
		)
	})

	it("rounds a high-precision aircraft position instead of exceeding 160 bytes", () => {
		const lat = 51.12345678912345
		const lon = -0.12345678912345
		const output = decoderOutput("aircraft", { icao: "abc123", lat, lon })
		const view = presentDecoderOutput(output, "measure")
		expect(view?.fields).toBeUndefined()
		expect(view?.entityKey).toBe("icao:ABC123")
		expect(view?.position).toBeDefined()
		expect(Math.abs((view?.position?.lat ?? 0) - lat)).toBeLessThan(1e-3)
		expect(Math.abs((view?.position?.lon ?? 0) - lon)).toBeLessThan(1e-3)
		expect(view?.position).not.toHaveProperty("altM")
		expect(presentationGrowth(output).growth).toBeLessThanOrEqual(
			ROW_GROWTH_COALESCED_BYTES,
		)
	})

	it("keeps a multibyte page and a wide callsign inside 1,100 bytes", () => {
		const page = decoderOutput("message", {
			protocol: "POCSAG1200",
			address: "7",
			function: 0,
			messageType: "alpha",
			message: "界".repeat(100),
		})
		const pageView = presentDecoderOutput(page, "measure")
		expect(pageView?.category).toBe("paging")
		expect(pageView?.protocol).toBe("pocsag")
		expect(pageView?.entityKey).toBe("capcode:7")
		expect(presentationGrowth(page).growth).toBeLessThanOrEqual(
			ROW_GROWTH_MAX_BYTES,
		)
		const aircraft = decoderOutput("aircraft", {
			icao: "ABCDEF",
			callsign: "界".repeat(40),
			squawk: "7000",
			altitude: 35000,
			gs: 400,
			track: 180,
			baro_rate: -500,
			lat: 51.5,
			lon: -0.1,
		})
		const view = presentDecoderOutput(aircraft, "measure")
		expect(view?.entityKey).toBe("icao:ABCDEF")
		expect(view?.fields?.length).toBeGreaterThan(0)
		expect(presentationGrowth(aircraft).growth).toBeLessThanOrEqual(
			ROW_GROWTH_MAX_BYTES,
		)
	})

	it("drops hostile numeric fields that would pass 1,100 bytes", () => {
		const huge = -1.7976931348623157e308
		const output = decoderOutput("aircraft", {
			icao: "ABCDEF",
			squawk: "7000",
			altitude: huge,
			gs: huge,
			track: huge,
			baro_rate: huge,
			lat: 51,
			lon: 4,
		})
		const view = presentDecoderOutput(output, "measure")
		expect(view?.entityKey).toBe("icao:ABCDEF")
		expect(presentationGrowth(output).growth).toBeLessThanOrEqual(
			ROW_GROWTH_MAX_BYTES,
		)
	})
})

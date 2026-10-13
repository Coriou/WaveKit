import { describe, expect, it } from "vitest"
import pino from "pino"
import { presentAircraft } from "../../../../../src/core/activity/presentation/aircraft.js"
import {
	ROW_GROWTH_COALESCED_BYTES,
	ROW_GROWTH_MAX_BYTES,
	truncateUtf8,
} from "../../../../../src/core/activity/presentation/budget.js"
import { presentDecoderOutput } from "../../../../../src/core/activity/presentation/registry.js"
import { createDecodeEnvelope } from "../../../../../src/core/activity/envelope.js"
import { createActivityIngress } from "../../../../../src/core/activity/ingress.js"
import type {
	DecodeEnvelope,
	DecodeEnvelopeContext,
} from "../../../../../src/core/activity/types.js"
import type { DecoderOutput } from "../../../../../src/decoders/types.js"
import { decoderOutput, presentationGrowth, rowBytes } from "./measure.js"

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

	it("keeps a precise APRS fix near the original coordinates", () => {
		const lat = 51.4567891234
		const lon = 4.4567891234
		const output = decoderOutput("aprs", {
			source: "N0CALL",
			dataType: "Position with timestamp and messaging",
			lat,
			lon,
		})
		const view = presentDecoderOutput(output, "measure")
		expect(view).toMatchObject({
			entityKey: "callsign:N0CALL",
			position: { lat: expect.closeTo(lat, 4), lon: expect.closeTo(lon, 4) },
		})
		expect(view?.fields).toBeUndefined()
		expect(view?.title?.startsWith("N0CALL")).toBe(true)
		expect(view?.position?.lat).not.toBe(52)
		expect(view?.position?.lon).not.toBe(5)
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

	it("fits a near-cap aircraft against the short id ingress stores", () => {
		const receivedAt = new Date("2026-10-13T00:00:00.000Z")
		const decoderId = "d"
		const short: DecodeEnvelopeContext = {
			eventId: "e",
			receivedAt,
			decoderId,
			provenance: { sourceId: null, frequency: null },
		}
		const fat: DecodeEnvelopeContext = {
			eventId: "evt-budget",
			receivedAt,
			decoderId,
			decoderType: "budget",
			provenance: { sourceId: null, frequency: null },
		}
		const sample = (pad: number): DecoderOutput =>
			decoderOutput(
				"aircraft",
				{
					icao: "ABCDEF",
					callsign: "界".repeat(80),
					squawk: "7".repeat(64),
					altitude: 35000,
					gs: 400,
					track: 180,
					baro_rate: -500,
					lat: 51.12345678912345,
					lon: -0.12345678912345,
					p0: "x".repeat(32_768),
					p1: "x".repeat(32_768),
					p2: "x".repeat(32_768),
					p3: "y".repeat(pad),
				},
				decoderId,
			)
		const unfittedBytes = (
			output: DecoderOutput,
			context: DecodeEnvelopeContext,
		) => {
			try {
				const view = presentAircraft(output.data)
				if (!view) return undefined
				return Buffer.byteLength(
					JSON.stringify(createDecodeEnvelope(output, context, view)),
					"utf8",
				)
			} catch {
				return undefined
			}
		}
		let lo = 0
		let hi = 32_768
		let best = -1
		while (lo <= hi) {
			const mid = (lo + hi) >> 1
			if (unfittedBytes(sample(mid), short) !== undefined) {
				best = mid
				lo = mid + 1
			} else hi = mid - 1
		}
		expect(best).toBeGreaterThan(0)
		let chosen: DecoderOutput | undefined
		for (let pad = best; pad >= Math.max(0, best - 400); pad--) {
			const output = sample(pad)
			if (
				unfittedBytes(output, short) !== undefined &&
				unfittedBytes(output, fat) === undefined
			) {
				chosen = output
				break
			}
		}
		expect(chosen).toBeDefined()
		const output = chosen!
		const plain = createDecodeEnvelope(output, short)
		const unfitted = presentAircraft(output.data)
		expect(unfitted).toBeDefined()
		expect(
			rowBytes(createDecodeEnvelope(output, short, unfitted!)) -
				rowBytes(plain),
		).toBeGreaterThan(ROW_GROWTH_MAX_BYTES)
		const fitted = presentDecoderOutput(output, "ignored")
		expect(fitted?.entityKey).toBe("icao:ABCDEF")
		expect(
			rowBytes(createDecodeEnvelope(output, short, fitted!)) - rowBytes(plain),
		).toBeLessThanOrEqual(ROW_GROWTH_MAX_BYTES)
		const published: DecodeEnvelope[] = []
		const ingress = createActivityIngress({
			sink: envelope => {
				published.push(envelope)
			},
			logger: pino({ level: "silent" }),
			now: () => receivedAt,
			randomUUID: () => "e",
		})
		ingress.publish(decoderId, undefined, output)
		expect(published).toHaveLength(1)
		expect(published[0]).toMatchObject({
			eventId: "e",
			protocol: "adsb",
			entityKey: "icao:ABCDEF",
		})
		expect(published[0]).not.toHaveProperty("decoderType")
		expect(rowBytes(published[0]!) - rowBytes(plain)).toBeLessThanOrEqual(
			ROW_GROWTH_MAX_BYTES,
		)
		expect(ingress.counters()).toEqual({
			published: 1,
			buildFailures: 0,
			sinkFailures: 0,
			presentationFailures: 0,
		})
	})
})

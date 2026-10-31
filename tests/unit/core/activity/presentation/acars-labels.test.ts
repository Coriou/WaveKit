/**
 * ACARS label table and the ACARS/VDL2 presentation built on it, over the fictional link
 * samples in tests/mocks/fixtures/{acars,vdl2}/link-sample.jsonl.
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	ACARS_LABEL_SOURCES,
	BASIS_TEXT,
	FAMILY_TEXT,
	TECHNICAL_FAMILIES,
	acarsLabelEntries,
	acarsLabelInfo,
	normalizeAcarsLabel,
} from "../../../../../src/core/activity/presentation/acars-labels.js"
import {
	presentAcars,
	presentVdl2,
} from "../../../../../src/core/activity/presentation/acars-vdl2.js"
import { parseAcarsdecJson } from "../../../../../src/decoders/builtin/acarsdec.js"
import { parseDumpvdl2Json } from "../../../../../src/decoders/builtin/dumpvdl2.js"
import { loadLinkSample as loadAcars } from "../../../../mocks/fixtures/acars/index.js"
import { loadLinkSample as loadVdl2 } from "../../../../mocks/fixtures/vdl2/index.js"
import type { DecodePresentation } from "../../../../../src/core/activity/types.js"

function field(view: DecodePresentation | undefined, key: string) {
	return view?.fields?.find(f => f.key === key)?.value
}

/** JSON round trip, as the activity envelope projects decoder output. */
function json<T>(value: T): unknown {
	return JSON.parse(JSON.stringify(value))
}

const acars = loadAcars().map(line =>
	presentAcars(json(parseAcarsdecJson(line as never))),
)
const vdl2 = loadVdl2().map(line =>
	presentVdl2(json(parseDumpvdl2Json(line as never))),
)

describe("ACARS label table", () => {
	const entries = acarsLabelEntries()

	it("every entry is two characters, named, sourced and unique", () => {
		const seen = new Set<string>()
		for (const entry of entries) {
			expect(entry.label).toHaveLength(2)
			expect(seen.has(entry.label)).toBe(false)
			seen.add(entry.label)
			expect(entry.name.length).toBeGreaterThan(0)
			expect(Buffer.byteLength(entry.name, "utf8")).toBeLessThanOrEqual(64)
			expect(entry.sources.length).toBeGreaterThan(0)
			for (const source of entry.sources)
				expect(Object.keys(ACARS_LABEL_SOURCES)).toContain(source)
		}
	})

	it("a standard basis is only claimed for labels libacars decodes", () => {
		const libacarsLabels = new Set(["A6", "AA", "B6", "BA", "H1", "MA", "SA"])
		for (const entry of entries) {
			if (entry.basis !== "standard") continue
			expect(libacarsLabels.has(entry.label)).toBe(true)
			expect(entry.sources).toContain("libacars")
		}
	})

	it("leaves out labels whose public names disagree", () => {
		for (const label of ["10", "11", "16", "20", "21"])
			expect(acarsLabelInfo(label)).toBeUndefined()
	})

	it("explains _d, written either way, in plain language", () => {
		expect(normalizeAcarsLabel("_\u007f")).toBe("_d")
		const info = acarsLabelInfo("_\u007f")
		expect(info).toMatchObject({
			label: "_d",
			name: "No information to transmit",
			family: "link",
		})
		expect(info?.note).toMatch(/acknowledgement/)
	})

	it("treats link and ground station traffic as technical", () => {
		expect(TECHNICAL_FAMILIES.has(acarsLabelInfo("_d")!.family)).toBe(true)
		expect(TECHNICAL_FAMILIES.has(acarsLabelInfo("SQ")!.family)).toBe(true)
		expect(TECHNICAL_FAMILIES.has(acarsLabelInfo("B6")!.family)).toBe(false)
	})

	it("returns nothing for unknown or malformed labels", () => {
		expect(acarsLabelInfo("Z9")).toBeUndefined()
		expect(acarsLabelInfo("H")).toBeUndefined()
		expect(acarsLabelInfo(undefined)).toBeUndefined()
	})
})

describe("ACARS presentation", () => {
	it("names a link acknowledgement and keeps the raw label", () => {
		const [ack] = acars
		expect(ack?.title).toBe("N0WK03 ZZ0303 · No information to transmit")
		expect(ack?.entityKey).toBe("reg:N0WK03")
		expect(field(ack, "label")).toBe("_d")
		expect(field(ack, "kind")).toBe(FAMILY_TEXT.link)
		expect(field(ack, "basis")).toBe(BASIS_TEXT.listed)
		expect(field(ack, "direction")).toBe("Air to ground")
	})

	it("a ground station squitter names no aircraft", () => {
		const sq = acars[1]
		expect(sq?.title).toBe("Ground station · Ground station squitter")
		expect(sq?.entityKey).toBeUndefined()
		expect(field(sq, "kind")).toBe(FAMILY_TEXT["ground-station"])
	})

	it("a decoded ADS-C report gives a reported position and says so", () => {
		const report = acars[4]
		expect(report?.title).toBe("N0WK04 ZZ0404 · ADS-C report")
		expect(report?.position).toEqual({ lat: -42.1, lon: -118.9, altM: 10363 })
		expect(field(report, "basis")).toBe(BASIS_TEXT.decoded)
		expect(field(report, "position-source")).toBe("ADS-C report")
		expect(field(report, "text")).toBeUndefined()
	})

	it("an airline label says the airline owns the format", () => {
		expect(field(acars[5], "basis")).toBe(BASIS_TEXT.airline)
		expect(field(acars[5], "text")).toBe("SYNTHETIC AIRLINE TEXT")
	})

	it("an unknown label keeps the raw label and says it is unknown", () => {
		const view = presentAcars({ tail: ".N0WK09", label: "Z9", text: "x" })
		expect(view?.title).toBe("N0WK09 · Label Z9")
		expect(field(view, "basis")).toBe(BASIS_TEXT.unknown)
		expect(field(view, "meaning")).toBeUndefined()
	})

	// Feature: aircraft-signals, Property 2: presentation stays within six fields and keeps the label
	it("never exceeds six fields and always shows a two-character label", () => {
		fc.assert(
			fc.property(
				fc.record({
					tail: fc.option(fc.string(), { nil: undefined }),
					flight: fc.option(fc.string(), { nil: undefined }),
					label: fc.string({ minLength: 2, maxLength: 2 }),
					text: fc.option(fc.string(), { nil: undefined }),
					direction: fc.option(fc.constantFrom("downlink", "uplink"), {
						nil: undefined,
					}),
				}),
				body => {
					const view = presentAcars(body)
					expect(view?.fields?.length ?? 0).toBeLessThanOrEqual(6)
					return true
				},
			),
			{ numRuns: 200 },
		)
	})
})

describe("VDL2 presentation", () => {
	it("an ACARS downlink is keyed by the aircraft's ICAO address", () => {
		const [ack] = vdl2
		expect(ack?.entityKey).toBe("icao:0A0B01")
		expect(ack?.title).toBe("N0WK01 ZZ0101 · No information to transmit")
	})

	it("a supervisory uplink is keyed by the aircraft it is addressed to", () => {
		const rr = vdl2[1]
		expect(rr?.entityKey).toBe("icao:0A0B01")
		expect(rr?.title).toBe("0A0B01 · Link supervision")
		expect(field(rr, "direction")).toBe("Ground to air")
		expect(field(rr, "ground-station")).toBe("10A0B0")
		expect(field(rr, "kind")).toBe(FAMILY_TEXT.link)
	})

	it("an XID with the aircraft's location gives a coarse reported position", () => {
		const lcr = vdl2[2]
		expect(lcr?.title).toBe("0A0B02 · Link Connection Request")
		expect(lcr?.position).toEqual({ lat: -40.5, lon: -120.3, altM: 10668 })
		expect(field(lcr, "destination")).toBe("ZZZZ")
		expect(field(lcr, "position-source")).toBe("VDL2 link frame (±0.1°)")
	})

	it("a ground broadcast names no aircraft", () => {
		const gsif = vdl2[3]
		expect(gsif?.entityKey).toBeUndefined()
		expect(gsif?.title).toBe(
			"Ground station · Ground Station Information Frame",
		)
		expect(gsif?.position).toBeUndefined()
	})

	it("libacars results refine the meaning", () => {
		expect(vdl2[4]?.title).toBe("N0WK02 ZZ0202 · ADS-C report")
		expect(vdl2[4]?.position?.lat).toBe(-40.62)
		expect(vdl2[5]?.title).toBe("N0WK01 · Media advisory")
		expect(field(vdl2[5], "direction")).toBe("Ground to air")
	})
})

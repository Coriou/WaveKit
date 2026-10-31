/**
 * Aircraft link fields kept from dumpvdl2 and acarsdec: AVLC address types and direction,
 * XID parameters and libacars trees. Every identifier and position here is fictional; the
 * JSON shapes follow dumpvdl2 (avlc.c, xid.c, tlv.c), libacars (acars.c, arinc.c, adsc.c)
 * and acarsdec (output.c) at the revisions pinned in the Dockerfile.
 */
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	LIBACARS_PAYLOAD_MAX_BYTES,
	acarsDirectionFromBlockId,
	parseAcarsdecJson,
} from "../../../src/decoders/builtin/acarsdec.js"
import {
	parseDumpvdl2Json,
	readVdl2AddressType,
	readVdl2Xid,
} from "../../../src/decoders/builtin/dumpvdl2.js"

const AIRCRAFT = "ABC123"
const GROUND = "10A0B0"

function frame(avlc: Record<string, unknown>) {
	return { vdl2: { t: { sec: 1_700_000_000 }, freq: 136_000_000, avlc } }
}

const adscTree = {
	arinc622: {
		msg_type: "adsc_msg",
		crc_ok: true,
		gs_addr: "XXXYYYY",
		air_addr: ".N0WK01",
		adsc: {
			tags: [
				{
					basic_report: {
						lat: 12.5,
						lon: -30.25,
						alt: 35000,
						ts_sec: 1234.5,
						pos_accuracy_nm: 0.05,
						nav_redundancy: true,
						tcas_avail: true,
					},
				},
			],
			err: false,
		},
	},
}

describe("VDL2 address types and direction", () => {
	it("reads dumpvdl2's address type strings without regard to case", () => {
		expect(readVdl2AddressType("Aircraft")).toBe("aircraft")
		expect(readVdl2AddressType("Ground station")).toBe("ground")
		expect(readVdl2AddressType("ground")).toBe("ground")
		expect(readVdl2AddressType("All stations")).toBe("all")
		expect(readVdl2AddressType("reserved")).toBe("reserved")
		expect(readVdl2AddressType("Satellite")).toBeUndefined()
		expect(readVdl2AddressType(3)).toBeUndefined()
	})

	it("a downlink names the aircraft by its source address", () => {
		const msg = parseDumpvdl2Json(
			frame({
				src: { addr: AIRCRAFT, type: "Aircraft", status: "Airborne" },
				dst: { addr: GROUND, type: "Ground station" },
				frame_type: "I",
			}) as never,
		)
		expect(msg?.icao).toBe(AIRCRAFT)
		expect(msg?.direction).toBe("downlink")
		expect(msg?.groundAddress).toBe(GROUND)
		expect(msg?.airborne).toBe(true)
		expect(msg?.srcType).toBe("aircraft")
		expect(msg?.dstType).toBe("ground")
	})

	it("an uplink names the aircraft by its destination, never by the ground station", () => {
		const msg = parseDumpvdl2Json(
			frame({
				src: { addr: GROUND, type: "Ground station" },
				dst: { addr: AIRCRAFT, type: "Aircraft" },
				frame_type: "S",
			}) as never,
		)
		expect(msg?.icao).toBe(AIRCRAFT)
		expect(msg?.fromaddr).toBe(GROUND)
		expect(msg?.direction).toBe("uplink")
		expect(msg?.groundAddress).toBe(GROUND)
		expect(msg?.airborne).toBeUndefined()
	})

	it("a ground broadcast to all stations names no aircraft", () => {
		const msg = parseDumpvdl2Json(
			frame({
				src: { addr: GROUND, type: "Ground station" },
				dst: { addr: "FFFFFF", type: "All stations" },
				frame_type: "U",
			}) as never,
		)
		expect(msg?.icao).toBeUndefined()
		expect(msg?.direction).toBe("uplink")
	})

	it("without printed types the frame names no aircraft and no direction", () => {
		const msg = parseDumpvdl2Json(
			frame({ src: { addr: AIRCRAFT }, dst: { addr: GROUND } }) as never,
		)
		expect(msg?.icao).toBeUndefined()
		expect(msg?.direction).toBeUndefined()
		expect(msg?.fromaddr).toBe(AIRCRAFT)
	})

	it("a direction needs both ends known: every pair of address types", () => {
		const types = [
			"Aircraft",
			"Ground station",
			"All stations",
			"reserved",
			"Satellite",
			undefined,
		] as const
		const expected = (src: string | undefined, dst: string | undefined) => {
			if (src === "Aircraft" && dst === "Ground station") return "downlink"
			if (src !== "Ground station") return undefined
			return dst === "Aircraft" || dst === "All stations" ? "uplink" : undefined
		}
		for (const src of types)
			for (const dst of types) {
				const msg = parseDumpvdl2Json(
					frame({
						src: { addr: AIRCRAFT, ...(src ? { type: src } : {}) },
						dst: { addr: GROUND, ...(dst ? { type: dst } : {}) },
						frame_type: "S",
					}) as never,
				)
				expect({ src, dst, direction: msg?.direction }).toEqual({
					src,
					dst,
					direction: expected(src, dst),
				})
			}
	})

	it("an aircraft frame to a reserved or missing other end has no direction", () => {
		for (const dst of [{ type: "reserved" }, {}, { type: "All stations" }]) {
			const msg = parseDumpvdl2Json(
				frame({
					src: { addr: AIRCRAFT, type: "Aircraft" },
					dst: { addr: GROUND, ...dst },
					frame_type: "I",
				}) as never,
			)
			expect(msg?.icao).toBe(AIRCRAFT)
			expect(msg?.direction).toBeUndefined()
		}
		const noDst = parseDumpvdl2Json(
			frame({ src: { addr: GROUND, type: "Ground station" } }) as never,
		)
		expect(noDst?.direction).toBeUndefined()
	})

	it("embedded ACARS takes the frame's direction over its block id", () => {
		const msg = parseDumpvdl2Json(
			frame({
				src: { addr: GROUND, type: "Ground station" },
				dst: { addr: AIRCRAFT, type: "Aircraft" },
				frame_type: "I",
				acars: { reg: ".N0WK01", label: "_d", blk_id: "1", msg_text: "" },
			}) as never,
		)
		expect(msg?.acars?.direction).toBe("uplink")
	})

	// Feature: aircraft-signals, Property 1: the ICAO address is always an aircraft end
	it("never reports a ground station or broadcast address as the aircraft", () => {
		const types = fc.constantFrom(
			"Aircraft",
			"Ground station",
			"All stations",
			"reserved",
			undefined,
		)
		const addr = fc.stringMatching(/^[0-9A-F]{6}$/)
		fc.assert(
			fc.property(addr, types, addr, types, (sa, st, da, dt) => {
				const msg = parseDumpvdl2Json(
					frame({
						src: { addr: sa, type: st },
						dst: { addr: da, type: dt },
					}) as never,
				)
				if (msg?.icao === undefined) return true
				return (
					(msg.icao === sa && st === "Aircraft") ||
					(msg.icao === da && dt === "Aircraft")
				)
			}),
			{ numRuns: 200 },
		)
	})
})

describe("VDL2 XID parameters", () => {
	it("keeps the aircraft location, destination and ground station location", () => {
		const xid = readVdl2Xid({
			err: false,
			type: "XID_CMD_LCR",
			type_descr: "Link Connection Request",
			pub_params: [{ name: "param_set_id", value: "8885:1993" }],
			vdl_params: [
				{
					name: "ac_location",
					value: { loc: { lat: 12.3, lon: -45.6 }, alt: 35000 },
				},
				{ name: "dst_airport", value: "ZZZZ" },
				{ name: "gs_location", value: { lat: -10.1, lon: 20.2 } },
				{ name: "airport_coverage", value: "ZZZY ZZZX" },
			],
		})
		expect(xid).toEqual({
			type: "XID_CMD_LCR",
			typeDescr: "Link Connection Request",
			acLocation: { lat: 12.3, lon: -45.6, altFt: 35000 },
			dstAirport: "ZZZZ",
			gsLocation: { lat: -10.1, lon: 20.2 },
			airportCoverage: "ZZZY ZZZX",
		})
	})

	it("skips malformed, out of range and null-island locations", () => {
		const xid = readVdl2Xid({
			type: "GSIF",
			vdl_params: [
				{
					name: "ac_location",
					value: { loc: { lat: 120, lon: 0.5 }, alt: 1000 },
				},
				{ name: "gs_location", value: { lat: 0, lon: 0 } },
				{ name: "dst_airport", value: "" },
				{ name: "ac_location", value: "nowhere" },
			],
		})
		expect(xid).toEqual({ type: "GSIF" })
	})

	it("returns nothing for an XID that is not an object", () => {
		expect(readVdl2Xid("XID")).toBeUndefined()
		expect(readVdl2Xid({ vdl_params: "x" })).toBeUndefined()
	})

	it("parseDumpvdl2Json carries the XID beside the frame", () => {
		const msg = parseDumpvdl2Json(
			frame({
				src: { addr: AIRCRAFT, type: "Aircraft", status: "On ground" },
				dst: { addr: GROUND, type: "Ground station" },
				frame_type: "U",
				xid: {
					type: "XID_CMD_LE",
					type_descr: "Link Establishment",
					vdl_params: [{ name: "dst_airport", value: "ZZZZ" }],
				},
			}) as never,
		)
		expect(msg?.msgType).toBe("Link Establishment")
		expect(msg?.xid?.dstAirport).toBe("ZZZZ")
		expect(msg?.airborne).toBe(false)
	})
})

describe("libacars trees", () => {
	it("dumpvdl2 keeps the ARINC 622 tree beside the ACARS text", () => {
		const msg = parseDumpvdl2Json(
			frame({
				src: { addr: AIRCRAFT, type: "Aircraft" },
				dst: { addr: GROUND, type: "Ground station" },
				frame_type: "I",
				acars: {
					reg: ".N0WK01",
					label: "B6",
					blk_id: "2",
					msg_text: "/XXXYYYY.ADS.N0WK01...",
					...adscTree,
				},
			}) as never,
		)
		expect(msg?.acars?.libacars).toEqual(adscTree)
		expect(msg?.acars?.libacarsDropped).toBeUndefined()
	})

	it("acarsdec keeps its libacars object, sublabel and MFI", () => {
		const msg = parseAcarsdecJson({
			label: "H1",
			block_id: "3",
			tail: ".N0WK01",
			text: "- #M1BPOS",
			sublabel: "M1",
			mfi: "BP",
			libacars: adscTree,
		} as never)
		expect(msg?.direction).toBe("downlink")
		expect(msg?.sublabel).toBe("M1")
		expect(msg?.mfi).toBe("BP")
		expect(msg?.libacars).toEqual(adscTree)
	})

	it("drops a libacars tree that is too large or not plain JSON, and says so", () => {
		const big = { arinc622: { pad: "x".repeat(LIBACARS_PAYLOAD_MAX_BYTES) } }
		const large = parseAcarsdecJson({ label: "B6", libacars: big } as never)
		expect(large?.libacars).toBeUndefined()
		expect(large?.libacarsDropped).toBe(true)
		const odd = parseAcarsdecJson({ label: "B6", libacars: "tree" } as never)
		expect(odd?.libacars).toBeUndefined()
		expect(odd?.libacarsDropped).toBe(true)
	})

	it("a message without libacars output has neither field", () => {
		const msg = parseAcarsdecJson({ label: "_d", block_id: "A" } as never)
		expect(msg?.libacars).toBeUndefined()
		expect(msg?.libacarsDropped).toBeUndefined()
		expect(msg?.direction).toBe("uplink")
	})
})

describe("ACARS direction from the block id", () => {
	it("digits are downlinks, letters uplinks, anything else unknown", () => {
		expect(acarsDirectionFromBlockId("0")).toBe("downlink")
		expect(acarsDirectionFromBlockId("9")).toBe("downlink")
		expect(acarsDirectionFromBlockId("A")).toBe("uplink")
		expect(acarsDirectionFromBlockId("z")).toBe("uplink")
		expect(acarsDirectionFromBlockId("")).toBeUndefined()
		expect(acarsDirectionFromBlockId("*")).toBeUndefined()
		expect(acarsDirectionFromBlockId("12")).toBeUndefined()
		expect(acarsDirectionFromBlockId(undefined)).toBeUndefined()
	})
})

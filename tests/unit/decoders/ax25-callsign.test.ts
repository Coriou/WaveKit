import fc from "fast-check"
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	isAx25CallsignText,
	isAx25PathEntryText,
} from "../../../src/decoders/ax25-callsign.js"
import {
	parseAx25Address,
	parseAx25Frame,
} from "../../../src/decoders/builtin/direwolf.js"
import {
	MultimonDecoder,
	afsk1200AddressesValid,
} from "../../../src/decoders/builtin/multimon-ng.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"

const CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789".split("")
const callArb = fc
	.array(fc.constantFrom(...CHARS), { minLength: 1, maxLength: 6 })
	.map(a => a.join(""))
const ssidArb = fc.integer({ min: 0, max: 15 })
const addressText = (call: string, ssid: number) =>
	ssid === 0 ? call : `${call}-${ssid}`

/** 7-byte AX.25 address: shifted characters, space padded, SSID byte. */
function address(call: string, ssid: number, last = false): Buffer {
	const b = Buffer.alloc(7)
	for (let i = 0; i < 6; i++) b[i] = (call.charCodeAt(i) || 0x20) << 1
	b[6] = 0x60 | ((ssid & 0x0f) << 1) | (last ? 1 : 0)
	return b
}
const frame = (src: Buffer, dest = address("APRS", 0)) =>
	Buffer.concat([dest, src, Buffer.from([0x03, 0xf0]), Buffer.from(">ok")])

class TestMultimon extends MultimonDecoder {
	parse(line: string): DecoderOutput | null {
		return this.parseOutput(line)
	}
}
const multimon = () =>
	new TestMultimon(
		{
			id: "mm",
			type: "multimon-ng",
			enabled: true,
			options: { modes: ["AFSK1200"] },
		},
		pino({ level: "silent" }),
	)

describe("AX.25 callsign text", () => {
	it("accepts 1-6 A-Z/0-9 with SSID 0-15", () => {
		for (const t of ["A", "N0CALL", "DL1ABC-9", "K1A-15", "AB1-0"])
			expect(isAx25CallsignText(t)).toBe(true)
	})

	it("rejects bad characters, SSID 16, too long, empty and lowercase", () => {
		for (const t of [
			"",
			"-1",
			"N0CALL7",
			"N0C@LL",
			"N0CA L",
			"n0call",
			"N0CALL-16",
			"N0CALL-01",
			"N0CALL-",
			"#$%&-3",
		])
			expect(isAx25CallsignText(t)).toBe(false)
	})

	it("accepts a repeated-mark digipeater only as a trailing *", () => {
		expect(isAx25PathEntryText("WIDE2-1*")).toBe(true)
		expect(isAx25PathEntryText("*WIDE2")).toBe(false)
	})

	// Feature: ax25-callsign-validation, Property 1: text validation accepts exactly CALL[-SSID] over A-Z0-9, 1-6 chars, SSID 0-15
	// Validates: AX.25 address rule for packet decoders
	it("agrees with a reference rule on arbitrary text", () => {
		const reference = (t: string) => {
			const [call, ssid, ...rest] = t.split("-")
			if (rest.length > 0 || call === undefined) return false
			if (!/^[A-Z0-9]{1,6}$/.test(call)) return false
			if (ssid === undefined) return true
			return String(Number(ssid)) === ssid && Number(ssid) <= 15
		}
		const text = fc.oneof(
			fc.string({ maxLength: 10 }),
			fc
				.tuple(callArb, fc.integer({ min: -2, max: 20 }))
				.map(([c, s]) => `${c}-${s}`),
			callArb,
		)
		fc.assert(
			fc.property(text, t => {
				expect(isAx25CallsignText(t)).toBe(reference(t))
			}),
			{ numRuns: 200 },
		)
	})
})

describe("multimon-ng AFSK1200 addresses", () => {
	it("passes good frames and counts nothing", () => {
		const d = multimon()
		const out = d.parse(
			"AFSK1200: fm DL1ABC-9 to APRS via WIDE1-1,WIDE2-1* UI  pid=F0",
		)
		expect(out).toMatchObject({
			data: { protocol: "AFSK1200", from: "DL1ABC-9", to: "APRS" },
		})
		expect(d.getRejectedPackets()).toBe(0)
	})

	it("drops and counts bad addresses without emitting", () => {
		const d = multimon()
		const bad = [
			"AFSK1200: fm }{|~@[-5 to APRS",
			"AFSK1200: fm N0CALL-16 to APRS",
			"AFSK1200: fm TOOLONG1 to APRS",
			"AFSK1200: fm N0CALL to ap&rs",
			"AFSK1200: fm N0CALL to APRS via WIDE1-1,W!DE UI",
		]
		for (const line of bad) expect(d.parse(line)).toBeNull()
		expect(d.getRejectedPackets()).toBe(bad.length)
	})

	// Feature: ax25-callsign-validation, Property 2: a valid AFSK1200 address set always passes, one corrupted character always fails
	// Validates: AX.25 address rule for packet decoders
	it("keeps valid lines and rejects a corrupted address", () => {
		const bad = fc.constantFrom(..."!#$%&()+/:;<=>?@[]^_{|}~ abc".split(""))
		fc.assert(
			fc.property(
				callArb,
				ssidArb,
				callArb,
				bad,
				fc.nat(5),
				(c1, s1, c2, ch, at) => {
					const from = addressText(c1, s1)
					const to = c2
					expect(afsk1200AddressesValid(from, to, undefined)).toBe(true)
					const i = Math.min(at, c1.length - 1)
					const broken = c1.slice(0, i) + ch + c1.slice(i + 1)
					expect(afsk1200AddressesValid(broken, to, undefined)).toBe(false)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("direwolf AX.25 address bytes", () => {
	it("parses a good frame", () => {
		const aprs = parseAx25Frame(frame(address("N0CALL", 7, true)))
		expect(aprs?.source).toBe("N0CALL-7")
	})

	it("rejects non-callsign characters, embedded spaces and a set extension bit", () => {
		expect(parseAx25Address(address("N0#ALL", 1))).toBeNull()
		expect(parseAx25Address(address("n0call", 1))).toBeNull()
		const gap = address("AB", 0)
		gap[3] = 0x43 << 1 // "AB C"
		expect(parseAx25Address(gap)).toBeNull()
		const ext = address("N0CALL", 0)
		ext[2] = ext[2]! | 1
		expect(parseAx25Address(ext)).toBeNull()
		expect(parseAx25Address(address("", 0))).toBeNull()
	})

	it("drops a frame whose source or digipeater is not a callsign", () => {
		expect(parseAx25Frame(frame(address("N0@ALL", 3, true)))).toBeNull()
		const digiFrame = Buffer.concat([
			address("APRS", 0),
			address("N0CALL", 0),
			address("W!DE", 1, true),
			Buffer.from([0x03, 0xf0]),
			Buffer.from(">x"),
		])
		expect(parseAx25Frame(digiFrame)).toBeNull()
	})

	// Feature: ax25-callsign-validation, Property 3: every valid source address round-trips through the AX.25 byte parser
	// Validates: AX.25 address rule for packet decoders
	it("round-trips every valid address", () => {
		fc.assert(
			fc.property(callArb, ssidArb, (call, ssid) => {
				expect(parseAx25Address(address(call, ssid))).toBe(
					addressText(call, ssid),
				)
			}),
			{ numRuns: 100 },
		)
	})
})

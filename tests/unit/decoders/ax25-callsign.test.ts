import { readFileSync } from "node:fs"
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
	AX25_TAIL_MAX_CHARS,
	MultimonDecoder,
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

describe("multimon-ng AX.25 headers", () => {
	it("passes every header line the real multimon-ng printed", () => {
		// Synthetic frames decoded by multimon-ng; see fixtures/aprs/README.md.
		const lines = readFileSync(
			new URL(
				"../../mocks/fixtures/aprs/multimon-ax25-headers.txt",
				import.meta.url,
			),
			"utf8",
		)
			.split("\n")
			.filter(l => l.startsWith("AFSK1200: "))
		expect(lines.length).toBeGreaterThan(100)
		const d = multimon()
		for (const line of lines) {
			expect(d.parse(line)).toMatchObject({
				data: { protocol: "AFSK1200", from: "N0CALL-3", to: "APRS-0" },
			})
			expect(d.parse(line.replace("AFSK1200", "FSK9600"))).toMatchObject({
				data: { protocol: "FSK9600", from: "N0CALL-3" },
			})
		}
		expect(d.getRejectedPackets()).toBe(0)
	})

	it("accepts a tail at the length bound and refuses one past it", () => {
		const d = multimon()
		const at = `UI ${"x".repeat(AX25_TAIL_MAX_CHARS - 3)}`
		expect(d.parse(`AFSK1200: fm N0CALL to APRS ${at}`)).not.toBeNull()
		expect(d.parse(`AFSK1200: fm N0CALL to APRS ${at}x`)).toBeNull()
	})

	it("passes the hdlc display variants in both modes and counts nothing", () => {
		const d = multimon()
		const good: [string, Record<string, unknown>][] = [
			[
				"AFSK1200: fm DL1ABC-9 to APRS via WIDE1-1,WIDE2-1* UI  pid=F0",
				{ from: "DL1ABC-9", to: "APRS", via: "WIDE1-1,WIDE2-1*" },
			],
			["AFSK1200: fm N0CALL to APRS UI^ pid=F0", { to: "APRS" }],
			["AFSK1200: fm N0CALL to APRS UI! pid=F0", { to: "APRS" }],
			["AFSK1200: fm N0CALL to APRS UI+ pid=F0", { to: "APRS" }],
			["AFSK1200: fm N0CALL to APRS UI- pid=F0", { to: "APRS" }],
			["AFSK1200: fm N0CALL to APRS UI  pid=F0", { to: "APRS" }],
			[
				"AFSK1200: fm N0CALL-0 to APRS-0 unknown U (0x6f)^ pid=F0",
				{ to: "APRS-0" },
			],
			["AFSK1200: fm N0CALL to APRS unknown S (0xd)0v pid=3E", { to: "APRS" }],
			["AFSK1200: fm N0CALL-0 to APRS-0 I05^ pid=F0", { from: "N0CALL-0" }],
			["AFSK1200: fm N0CALL to K1ABC RR3v", { to: "K1ABC" }],
			["AFSK1200: fm N0CALL to K1ABC SABM^", { to: "K1ABC" }],
			["AFSK1200: fm N0CALL to APRS", { to: "APRS" }],
			[
				"FSK9600: fm N0CALL-1 to APRS via WIDE2-2 UI^ pid=F0",
				{ protocol: "FSK9600", from: "N0CALL-1", via: "WIDE2-2" },
			],
		]
		for (const [line, data] of good)
			expect(d.parse(line)).toMatchObject({ type: "decode", data })
		expect(d.getRejectedPackets()).toBe(0)
	})

	it("drops and counts malformed headers and bad addresses in both modes", () => {
		const d = multimon()
		const bad = [
			"AFSK1200: fm }{|~@[-5 to APRS",
			"AFSK1200: fm N0CALL-16 to APRS",
			"AFSK1200: fm TOOLONG1 to APRS",
			"AFSK1200: fm N0CALL to ap&rs",
			"AFSK1200: fm N0CALL to APRS via WIDE1-1,W!DE UI",
			// truncated destination and a stray token in place of the frame type
			"AFSK1200: fm N0CALL to AP RS via BAD! UI pid=F0",
			// a second space-separated digipeater list
			"AFSK1200: fm N0CALL to APRS via WIDE1-1 BAD! UI pid=F0",
			// a tail that does not start with a frame-type word
			"AFSK1200: fm N0CALL to APRS pid=F0",
			"AFSK1200: fm N0CALL to APRS UIX pid=F0",
			"AFSK1200: fm N0CALL to APRS uI pid=F0",
			// two spaces before the tail, a non-printable or an oversized tail
			"AFSK1200: fm N0CALL to APRS  UI pid=F0",
			"AFSK1200: fm N0CALL to APRS UI\u0007 pid=F0",
			`AFSK1200: fm N0CALL to APRS UI ${"x".repeat(62)}`,
			"AFSK1200: garbage",
			"FSK9600: fm N0@ALL to APRS via W!DE UI pid=F0",
			"FSK9600: fm N0CALL to APRS via W!DE UI pid=F0",
			"FSK9600: 1A2B3C",
		]
		for (const line of bad) expect(d.parse(line)).toBeNull()
		expect(d.getRejectedPackets()).toBe(bad.length)
	})

	// Feature: ax25-callsign-validation, Property 2: a well-formed AX.25 header passes in both modes; one corrupted address or one stray token fails
	// Validates: AX.25 address rule for packet decoders
	it("keeps well-formed headers and rejects a corrupted address or stray token", () => {
		const badChar = fc.constantFrom(..."!#$%&()+/:;<=>?@[]_{|}~abc".split(""))
		// Tails as the real binary prints them (fixtures/aprs/multimon-ax25-headers.txt).
		const frame = fc.constantFrom(
			"",
			" UI^ pid=F0",
			" UI+ pid=F0",
			" UI- pid=F0",
			" UI  pid=F0",
			" UI! pid=F0",
			" I21- pid=F0",
			" I00v pid=F0",
			" RR3  pid=3E",
			" RNR0! pid=3E",
			" SABM- pid=3E",
			" DISC! pid=3E",
			" unknown U (0x6f)v pid=3E",
			" unknown S (0xd)0  pid=3E",
		)
		fc.assert(
			fc.property(
				fc.constantFrom("AFSK1200", "FSK9600"),
				fc.array(fc.tuple(callArb, ssidArb), { minLength: 2, maxLength: 4 }),
				frame,
				badChar,
				fc.nat(),
				fc.nat(5),
				fc.boolean(),
				(mode, calls, tail, ch, which, at, stray) => {
					const addrs = calls.map(([c, s]) => addressText(c, s))
					const line = (a: string[]) =>
						`${mode}: fm ${a[0]} to ${a[1]}${a.length > 2 ? ` via ${a.slice(2).join(",")}` : ""}${tail}`
					const d = multimon()
					expect(d.parse(line(addrs))).not.toBeNull()
					const k = which % addrs.length
					const [call] = calls[k]!
					const i = Math.min(at, call.length - 1)
					const broken = [...addrs]
					broken[k] = stray
						? `${addrs[k]} ${ch}`
						: call.slice(0, i) + ch + call.slice(i + 1)
					expect(d.parse(line(broken))).toBeNull()
					expect(d.getRejectedPackets()).toBe(1)
				},
			),
			{ numRuns: 200 },
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

import { describe, expect, it } from "vitest"
import type { DecoderOutput } from "@wavekit/api-types"
import {
	detailJson,
	formatMessage,
} from "../../../cli/source/ui/messages/index.js"
import { setGlyphMode } from "../../../cli/source/ui/theme.js"

const out = (type: string, decoder: string, data: unknown): DecoderOutput => ({
	type,
	decoder,
	timestamp: "2026-10-08T18:07:41.000Z",
	data,
})
const segs = (m: ReturnType<typeof formatMessage>) =>
	m.segments.map(s => s.text)
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

describe("formatMessage", () => {
	it("formats DMR call ends like the spec row", () => {
		const m = formatMessage(
			out("call_end", "dsd-fme", {
				protocol: "dmr",
				talkgroup: 2350,
				source: 2341234,
				slot: 1,
				duration: 8400,
				dmr: { cc: 1 },
				quality: { crcErrs: 4, fecErrs: 3 },
				flags: { encrypted: true },
			}),
			"dsd-fme",
		)
		expect(m.protocol).toBe("DMR")
		expect(m.category).toBe("voice")
		expect(segs(m)).toEqual([
			"TG 2350",
			"SRC 2341234",
			"slot 1",
			"CC 1",
			"8.4 s",
			"quality 65%",
			"7 err",
			"encrypted",
		])
	})
	it("formats pager messages with free text", () => {
		const m = formatMessage(
			out("pocsag", "multimon-ng", {
				protocol: "POCSAG1200",
				address: 1234567,
				function: 3,
				messageType: "Alpha",
				message: "FIRE ALARM ACTIVATION",
			}),
			"multimon-ng",
		)
		expect(m.protocol).toBe("POCSAG")
		expect(segs(m)).toEqual(["1234567", "fn 3"])
		expect(m.text).toBe("FIRE ALARM ACTIVATION")
		const n = formatMessage(
			out("pocsag", "multimon-ng", {
				address: 7654321,
				function: 0,
				messageType: "Numeric",
				message: "0207 555 0101",
			}),
			"multimon-ng",
		)
		expect(segs(n)).toEqual(["7654321", "fn 0", "numeric"])
		const flex = formatMessage(
			out("flex", "multimon-ng", {
				protocol: "FLEX",
				capcode: "1-2345678",
				messageType: "ALN",
				message: "TEST PAGE 03:58",
			}),
			"multimon-ng",
		)
		expect(flex.protocol).toBe("FLEX")
		expect(segs(flex)).toEqual(["1-2345678", "ALN"])
	})
	it("formats aircraft with emergency squawks and enrichment from the aircraft map", () => {
		const m = formatMessage(
			out("aircraft", "readsb", {
				hex: "4ca9d2",
				flight: "RYR4KT ",
				alt_baro: 37000,
				baro_rate: -1216,
				gs: 451.2,
				track: 134.1,
				lat: 51.4712,
				lon: -0.4521,
				squawk: "7700",
				rssi: -12.3,
				seen: 0.4,
				messages: 1204,
			}),
			"readsb",
			icao =>
				icao === "4CA9D2"
					? {
							icao,
							seen: 0,
							messages: 0,
							firstSeen: 0,
							lastUpdated: 0,
							identification: { registration: "EI-DCL", typeCode: "B738" },
						}
					: undefined,
		)
		expect(m.protocol).toBe("ADS-B")
		expect(m.emergency).toBe(true)
		expect(segs(m)).toEqual([
			"4CA9D2",
			"EI-DCL",
			"RYR4KT",
			"B738",
			"FL370 ↓",
			"451 kt",
			"51.47,-0.45",
			"SE",
			"!7700",
		])
		expect(m.fields.find(f => f.label === "messages")?.value).toBe("1 204")
	})
	it("formats AIS, rtl_433, Meshtastic and ACARS", () => {
		expect(
			segs(
				formatMessage(
					out("ais", "ais-catcher", {
						mmsi: 235012345,
						shipname: "SEA PRINCESS",
						shiptype_text: "passenger",
						lat: 51.5,
						lon: -0.12,
						speed: 12.1,
					}),
					"ais-catcher",
				),
			),
		).toEqual([
			"235012345",
			"SEA PRINCESS",
			"passenger",
			"51.50,-0.12",
			"12.1 kn",
		])
		expect(
			segs(
				formatMessage(
					out("data", "rtl433", {
						model: "Acurite-Tower",
						id: 1234,
						temperature_C: 21.25,
						humidity: 40,
						battery_ok: 0,
					}),
					"rtl433",
				),
			),
		).toEqual(["Acurite-Tower", "#1234", "21.3°C", "40%", "battery low"])
		const mesh = formatMessage(
			out("meshtastic", "lora-meshtastic", {
				from: 0x11223344,
				to: 0xffffffff,
				id: 1,
				channel: 0,
				hopLimit: 2,
				hopStart: 3,
				wantAck: false,
				portnum: 1,
				payloadB64: Buffer.from("hello").toString("base64"),
				payloadLen: 5,
				rxRssi: -90,
				rxSnr: 7.25,
				rxTime: "t",
				frequency: 869525000,
				bw: 250,
				sf: 11,
				cr: 5,
			}),
			"lora-meshtastic",
		)
		expect(segs(mesh)).toEqual([
			"!11223344→BCAST",
			"TEXT",
			"-90 dBm",
			"SNR 7.3",
			"1/3 hops",
		])
		expect(mesh.text).toBe("hello")
		const acars = formatMessage(
			out("acars", "acarsdec", {
				tail: ".EI-DCL",
				flight: "RYR4KT",
				label: "H1",
				text: "REQUEST WX",
				freq: 131.55,
			}),
			"acarsdec",
		)
		expect(acars.protocol).toBe("ACARS")
		expect(segs(acars)).toEqual([".EI-DCL", "RYR4KT", "H1", "131.550 MHz"])
	})
	it("bounds and sanitises hostile payloads (review focus 4)", () => {
		const huge = "A".repeat(100_000) + "\x1b[2J\r\n🚀"
		const m = formatMessage(
			out("pocsag", "multimon-ng", { address: 1, message: huge }),
			"multimon-ng",
		)
		expect(m.text?.length).toBeLessThanOrEqual(2000)
		expect(CONTROL.test(m.text ?? "")).toBe(false)
		expect(m.searchText.length).toBeLessThanOrEqual(4000)
		let deep: unknown = "x"
		for (let i = 0; i < 2000; i++) deep = { a: deep }
		const g = formatMessage(out("weird", "x", deep), "x")
		expect(CONTROL.test(g.text ?? "")).toBe(false)
		const lines = detailJson({ s: huge, deep })
		expect(lines.length).toBeLessThanOrEqual(201)
		for (const l of lines) expect(CONTROL.test(l)).toBe(false)
	})
	it("ports the remaining decoded-message.tsx call knowledge", () => {
		expect(
			formatMessage(
				out("call_end", "dsd-fme", { protocol: "p25p1", talkgroup: 1 }),
				"dsd-fme",
			).protocol,
		).toBe("P25 P1")
		expect(
			formatMessage(
				out("call_end", "dsd-fme", { protocol: "nxdn48", talkgroup: 1 }),
				"dsd-fme",
			).protocol,
		).toBe("NXDN48")
		const dstar = formatMessage(
			out("call_start", "dsd-fme", {
				protocol: "dstar",
				dstar: { my: "EI2ABC  ", ur: "CQCQCQ  " },
			}),
			"dsd-fme",
		)
		expect(segs(dstar)).toEqual(["MY EI2ABC", "UR CQCQCQ", "call start"])
		const legacy = formatMessage(
			out("decode", "dsd-fme", {
				talkgroup: 9,
				source: 3120001,
				slot: 2,
				duration: 1200,
			}),
			"dsd-fme",
		)
		expect(legacy.category).toBe("voice")
		expect(segs(legacy)).toEqual(["TG 9", "SRC 3120001", "slot 2", "1.2 s"])
	})
	it("treats an empty emergency field as no emergency", () => {
		const a = (emergency: string) =>
			formatMessage(
				out("aircraft", "readsb", { hex: "abc123", squawk: "1000", emergency }),
				"readsb",
			).emergency
		expect(a("")).toBe(false)
		expect(a("none")).toBe(false)
		expect(a("general")).toBe(true)
	})
	it("ends a cut detail with the glyph-mode ellipsis", () => {
		setGlyphMode("ascii")
		try {
			expect(detailJson("x".repeat(40), 200, 10).at(-1)).toBe("...")
		} finally {
			setGlyphMode("utf8")
		}
	})
	it("falls back to compact JSON for unknown shapes", () => {
		const m = formatMessage(out("sync", "dsd-fme", { mode: "DMR" }), "dsd-fme")
		expect(segs(m)).toEqual(["sync DMR"])
		expect(formatMessage(out("x", "y", { k: 1 }), "y").text).toBe('{"k":1}')
	})
})

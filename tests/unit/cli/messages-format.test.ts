import { describe, expect, it } from "vitest"
import type { DecoderOutput } from "@wavekit/api-types"
import {
	detailJson,
	formatMessage,
} from "../../../cli/source/ui/messages/index.js"
import { setGlyphMode } from "../../../cli/source/ui/theme.js"
import type { MessageEntry } from "../../../cli/source/data/types.js"
import { lineText } from "../../../cli/source/ui/text.js"
import { summaryLine } from "../../../cli/source/view-models/message-rows.js"
import { messageDetail } from "../../../cli/source/view-models/messages.js"

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

// Payloads below copy the shapes emitted by src/decoders/builtin/* (R6: src/ is
// the wire authority). They are built here, not taken from mock scenarios.
const T = "2026-10-08T18:07:41.000Z"

describe("real wire shapes, one per decoder (B3 fix 1)", () => {
	it("readsb: SBS AircraftData", () => {
		const m = formatMessage(
			out("aircraft", "readsb", {
				icao: "4CA9D2",
				callsign: "RYR4KT",
				altitude: 37000,
				groundSpeed: 451,
				track: 134,
				lat: 51.4712,
				lon: -0.4521,
				verticalRate: -1216,
				squawk: "7700",
				onGround: false,
				lastSeen: T,
				messageCount: 12,
			}),
			"readsb",
		)
		expect(m.protocol).toBe("ADS-B")
		expect(segs(m)).toEqual([
			"4CA9D2",
			"RYR4KT",
			"FL370 ↓",
			"451 kt",
			"51.47,-0.45",
			"SE",
			"!7700",
		])
		expect(m.emergency).toBe(true)
	})
	it("ais-catcher: type ship with ShipData", () => {
		const m = formatMessage(
			out("ship", "ais-catcher", {
				mmsi: "235012345",
				name: "SEA PRINCESS",
				callsign: "MXYZ7",
				imo: 9241061,
				shipType: 60,
				lat: 51.5,
				lon: -0.12,
				cog: 90.4,
				sog: 12.1,
				heading: 91,
				navStatus: 0,
				destination: "ROTTERDAM",
				eta: "2026-10-09T06:00:00.000Z",
				draught: 7.2,
				lastSeen: T,
				messageType: 5,
			}),
			"ais-catcher",
		)
		expect(m.protocol).toBe("AIS")
		expect(m.category).toBe("data")
		expect(segs(m)).toEqual([
			"235012345",
			"SEA PRINCESS",
			"passenger",
			"51.50,-0.12",
			"12.1 kn",
			"MXYZ7",
			"dest ROTTERDAM",
		])
		const f = Object.fromEntries(m.fields.map(x => [x.label, x.value]))
		expect(f).toMatchObject({
			callsign: "MXYZ7",
			type: "passenger (60)",
			status: "under way using engine",
			destination: "ROTTERDAM",
		})
		expect(
			segs(
				formatMessage(
					out("ship", "ais-catcher", {
						mmsi: "244660123",
						name: "EEMS SPIRIT",
						shipType: 71,
						sog: 8.4,
					}),
					"ais-catcher",
				),
			),
		).toEqual(["244660123", "EEMS SPIRIT", "cargo", "8.4 kn"])
	})
	it("acarsdec: ACARSMessage with frequency in Hz", () => {
		const m = formatMessage(
			out("acars", "acarsdec", {
				timestamp: T,
				frequency: 131_550_000,
				channel: 0,
				level: -18.2,
				error: 0,
				mode: "2",
				label: "H1",
				blockId: "5",
				ack: "!",
				tail: ".EI-DCL",
				flight: "FR4KT",
				msgno: "M01A",
				text: "REQUEST WX",
			}),
			"acarsdec",
		)
		expect(m.protocol).toBe("ACARS")
		expect(segs(m)).toEqual([".EI-DCL", "FR4KT", "H1", "131.550 MHz"])
		expect(m.text).toBe("REQUEST WX")
	})
	it("dumpvdl2: VDL2Message with embedded ACARS and frequency in Hz", () => {
		const m = formatMessage(
			out("vdl2", "dumpvdl2", {
				timestamp: T,
				frequency: 136_975_000,
				station: "EGLL",
				icao: "4CA9D2",
				msgType: "ACARS",
				acars: {
					timestamp: T,
					frequency: 136_975_000,
					channel: 0,
					level: -30,
					error: 0,
					mode: "2",
					label: "H1",
					tail: ".EI-DCL",
					flight: "FR4KT",
					text: "POS N51",
				},
				level: -30.1,
				noiseFloor: -45,
			}),
			"dumpvdl2",
		)
		expect(m.protocol).toBe("VDL2")
		expect(segs(m)).toEqual([".EI-DCL", "FR4KT", "H1", "136.975 MHz"])
		expect(m.text).toBe("POS N51")
		const bare = formatMessage(
			out("vdl2", "dumpvdl2", {
				timestamp: T,
				frequency: 136_650_000,
				icao: "3C6444",
				msgType: "XID",
			}),
			"dumpvdl2",
		)
		expect(segs(bare)).toEqual(["3C6444", "XID", "136.650 MHz"])
		const raw = formatMessage(
			out("vdl2", "dumpvdl2", { vdl2: { freq: 136_725_000 } }),
			"dumpvdl2",
		)
		expect(segs(raw)).toEqual(["136.725 MHz"])
	})
	it("direwolf: APRSData position, message and weather", () => {
		const pos = formatMessage(
			out("aprs", "direwolf", {
				timestamp: T,
				source: "N0CALL-9",
				destination: "APRS",
				path: ["WIDE1-1", "WIDE2-1"],
				dataType: "Position with messaging",
				lat: 51.5,
				lon: -0.12,
				altitude: 120,
				course: 90,
				speed: 35,
				symbol: "/>",
				comment: "on the road",
			}),
			"direwolf",
		)
		expect(pos.protocol).toBe("APRS")
		expect(pos.category).toBe("data")
		expect(segs(pos)).toEqual([
			"N0CALL-9",
			"position+msg",
			"51.50,-0.12",
			"35 mph",
		])
		expect(pos.text).toBe("on the road")
		const msg = formatMessage(
			out("aprs", "direwolf", {
				timestamp: T,
				source: "N0CALL",
				destination: "APRS",
				path: [],
				dataType: "Message",
				message: { addressee: "BLN1", text: "NET TONIGHT", messageNo: "7" },
			}),
			"direwolf",
		)
		expect(segs(msg)).toEqual(["N0CALL", "to BLN1", "message"])
		expect(msg.text).toBe("NET TONIGHT")
		const wx = formatMessage(
			out("aprs", "direwolf", {
				timestamp: T,
				source: "WX1",
				destination: "APRS",
				path: [],
				dataType: "Positionless weather",
				weather: { temperature: 68, humidity: 40, windSpeed: 5 },
			}),
			"direwolf",
		)
		expect(segs(wx)).toEqual(["WX1", "weather", "20.0°C", "40%", "wind 5 mph"])
	})
	it("rtl433: type signal with raw rtl_433 JSON", () => {
		const m = formatMessage(
			out("signal", "rtl433", {
				time: "2026-10-08 18:07:41",
				model: "Acurite-Tower",
				id: 1234,
				channel: "A",
				battery_ok: 1,
				temperature_C: 21.25,
				humidity: 40,
				mic: "CHECKSUM",
			}),
			"rtl433",
		)
		expect(m.protocol).toBe("ISM") // M14: a protocol tag, not a frequency
		expect(segs(m)).toEqual(["Acurite-Tower", "#1234", "ch A", "21.3°C", "40%"])
	})
	it("lora-meshtastic: rxRssi/rxSnr of 0 mean unavailable, not 0 dBm", () => {
		const m = formatMessage(
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
				rxRssi: 0,
				rxSnr: 0,
				rxTime: T,
				frequency: 869_525_000,
				bw: 250,
				sf: 11,
				cr: 5,
			}),
			"lora-meshtastic",
		)
		expect(segs(m)).toEqual(["!11223344→BCAST", "TEXT", "1/3 hops"])
		expect(m.text).toBe("hello")
	})
	it("multimon-ng: POCSAG and FLEX arrive as type message", () => {
		const p = formatMessage(
			out("message", "multimon-ng", {
				protocol: "POCSAG1200",
				address: 1234567,
				function: 3,
				messageType: "alpha",
				message: "FIRE ALARM",
			}),
			"multimon-ng",
		)
		expect(p.protocol).toBe("POCSAG")
		expect(p.category).toBe("pager")
		expect(segs(p)).toEqual(["1234567", "fn 3"])
		expect(p.text).toBe("FIRE ALARM")
		const f = formatMessage(
			out("message", "multimon-ng", {
				protocol: "FLEX",
				mode: "1600/2/K/A",
				frequency: "929.6125",
				capcode: "001234567",
				messageType: "ALN",
				message: "TEST PAGE",
			}),
			"multimon-ng",
		)
		expect(f.protocol).toBe("FLEX")
		expect(f.category).toBe("pager")
		expect(segs(f)).toEqual(["001234567", "ALN"])
		expect(f.searchText).toContain("001234567")
	})
	it("multimon-ng: decode (DTMF, AFSK1200, FSK9600) and EAS show data.protocol", () => {
		const dtmf = formatMessage(
			out("decode", "multimon-ng", { protocol: "DTMF", digits: "123#" }),
			"multimon-ng",
		)
		expect(dtmf.protocol).toBe("DTMF")
		expect(segs(dtmf)).toEqual(["123#"])
		const afsk = formatMessage(
			out("decode", "multimon-ng", {
				protocol: "AFSK1200",
				from: "N0CALL",
				to: "APRS",
				via: "WIDE1-1",
			}),
			"multimon-ng",
		)
		expect(afsk.protocol).toBe("AFSK1200")
		expect(segs(afsk)).toEqual(["N0CALL→APRS", "via WIDE1-1"])
		const fsk = formatMessage(
			out("decode", "multimon-ng", { protocol: "FSK9600", rawData: "1A2B3C" }),
			"multimon-ng",
		)
		expect(fsk.protocol).toBe("FSK9600")
		expect(fsk.text).toBe("1A2B3C")
		const eas = formatMessage(
			out("message", "multimon-ng", {
				protocol: "EAS",
				rawMessage: "ZCZC-WXR-TOR-012345+0030",
			}),
			"multimon-ng",
		)
		expect(eas.protocol).toBe("EAS")
		expect(eas.text).toBe("ZCZC-WXR-TOR-012345+0030")
	})
	it("dsd-fme: call_start with YSF callsign, sync and error", () => {
		const ysf = formatMessage(
			out("call_start", "dsd-fme", {
				protocol: "ysf",
				talkgroup: 0,
				source: 0,
				ysf: { mode: "V/D mode 2", callsign: "EI2ABC" },
			}),
			"dsd-fme",
		)
		expect(ysf.protocol).toBe("YSF")
		expect(segs(ysf)).toEqual(["CS EI2ABC", "call start"])
		const dmr = formatMessage(
			out("call_start", "dsd-fme", {
				protocol: "dmr",
				talkgroup: 2350,
				source: 2341234,
				slot: 1,
				dmr: { cc: 1 },
			}),
			"dsd-fme",
		)
		expect(segs(dmr)).toEqual([
			"TG 2350",
			"SRC 2341234",
			"slot 1",
			"CC 1",
			"call start",
		])
		expect(
			segs(
				formatMessage(
					out("sync", "dsd-fme", { mode: "DMR", protocol: "dmr" }),
					"dsd-fme",
				),
			),
		).toEqual(["sync DMR"])
		expect(
			formatMessage(
				out("error", "dsd-fme", { message: "CRC error" }),
				"dsd-fme",
			).text,
		).toBe("CRC error")
	})
})

describe("R32 formatter hygiene", () => {
	const BAD =
		/[\u0000-\u001f\u007f-\u009f\u061C\u200E\u200F\u2028-\u202E\u2066-\u2069]/
	const everyText = (m: ReturnType<typeof formatMessage>): string[] => [
		m.protocol,
		m.searchText,
		m.text ?? "",
		...m.segments.map(s => s.text),
		...m.fields.flatMap(f => [f.label, f.value]),
	]
	it("never leaves a lone high surrogate at a cut", () => {
		const m = formatMessage(
			out("message", "multimon-ng", {
				protocol: "POCSAG1200",
				address: 1,
				message: "a".repeat(1999) + "𠀀𠀀",
			}),
			"multimon-ng",
		)
		const text = m.text ?? ""
		expect(text.length).toBeLessThanOrEqual(2000)
		const last = text.charCodeAt(text.length - 1)
		expect(last >= 0xd800 && last <= 0xdbff).toBe(false)
	})
	it("swaps → and ° for ASCII in ASCII glyph mode", () => {
		setGlyphMode("ascii")
		try {
			const mesh = formatMessage(
				out("meshtastic", "lora-meshtastic", {
					from: 1,
					to: 0xffffffff,
					portnum: 3,
					payloadB64: "",
					payloadLen: 0,
					hopLimit: 3,
					hopStart: 3,
					rxRssi: -90,
					rxSnr: 5,
				}),
				"lora-meshtastic",
			)
			expect(segs(mesh)[0]).toBe("!00000001->BCAST")
			const wx = formatMessage(
				out("signal", "rtl433", { model: "M", temperature_C: 21.25 }),
				"rtl433",
			)
			expect(segs(wx)).toContain("21.3C")
			const ac = formatMessage(
				out("aircraft", "readsb", { icao: "ABC123", track: 134 }),
				"readsb",
			)
			expect(ac.fields.find(f => f.label === "track")?.value).toBe("134 SE")
			for (const m of [mesh, wx, ac])
				for (const t of everyText(m)) expect(t).not.toMatch(/[→°]/)
		} finally {
			setGlyphMode("utf8")
		}
	})
	it("sanitises segments, fields and protocol against C1 and bidi input", () => {
		const evil = "\u202Eev\x9b2Jil\u2066\x1b]0;t\x07"
		const ms = [
			formatMessage(
				out("aircraft", "readsb", {
					icao: `4CA${evil}`,
					callsign: evil,
					squawk: "7700",
					altitude: 1000,
				}),
				"readsb",
			),
			formatMessage(out(`x${evil}`, "x", { k: evil }), "x"),
			formatMessage(
				out("ship", "ais-catcher", {
					mmsi: evil,
					name: evil,
					destination: evil,
					callsign: evil,
				}),
				"ais-catcher",
			),
			formatMessage(
				out("aprs", "direwolf", {
					source: evil,
					dataType: evil,
					comment: evil,
					path: [],
				}),
				"direwolf",
			),
		]
		for (const m of ms)
			for (const t of everyText(m)) expect(BAD.test(t)).toBe(false)
	})
	it("never renders [object Object] for object-valued fields", () => {
		const ms = [
			formatMessage(
				out("ship", "ais-catcher", {
					mmsi: { a: 1 },
					name: "X",
					shipType: { b: 2 },
				}),
				"ais-catcher",
			),
			formatMessage(
				out("signal", "rtl433", {
					model: "M",
					id: { c: 3 },
					channel: { d: 4 },
				}),
				"rtl433",
			),
			formatMessage(
				out("message", "multimon-ng", {
					protocol: "POCSAG1200",
					address: { e: 5 },
					function: [1],
					message: "m",
				}),
				"multimon-ng",
			),
		]
		for (const m of ms)
			for (const t of everyText(m)) expect(t).not.toContain("[object")
	})
	it("routes to voice only for call-shaped objects", () => {
		expect(
			formatMessage(out("x", "y", { source: 5, value: 1 }), "y").category,
		).toBe("other")
		expect(formatMessage(out("x", "y", { talkgroup: 9 }), "y").category).toBe(
			"voice",
		)
		expect(
			formatMessage(out("x", "y", { source: 3120001, slot: 2 }), "y").category,
		).toBe("voice")
	})
})

describe("R62 operator enrichment", () => {
	it("adds the operator, when known, as the last and lowest-priority segment", () => {
		const m = formatMessage(
			out("aircraft", "readsb", {
				icao: "4CA9D2",
				callsign: "RYR4KT",
				altitude: 37000,
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
							identification: {
								registration: "EI-DCL",
								typeCode: "B738",
								operator: "Ryanair",
							},
						}
					: undefined,
		)
		expect(segs(m)).toEqual([
			"4CA9D2",
			"EI-DCL",
			"RYR4KT",
			"B738",
			"FL370",
			"Ryanair",
		])
		expect(m.segments.at(-1)?.priority).toBeGreaterThan(
			Math.max(...m.segments.slice(0, -1).map(x => x.priority)),
		)
		expect(m.fields.find(f => f.label === "operator")?.value).toBe("Ryanair")
	})
})

describe("R76 multi-line bodies", () => {
	const acars = formatMessage(
		out("acars", "acarsdec", {
			frequency: 131_550_000,
			label: "H1",
			tail: ".EI-DCL",
			text: "END\r\nPOS N51\x1b[2J",
		}),
		"acarsdec",
	)
	it("keeps the line break in the text and sanitises each line", () => {
		expect(acars.text).toBe("END\nPOS N51")
		expect(acars.searchText).toContain("end pos n51")
	})
	it("reads 'END POS' on a single-line row", () => {
		expect(lineText(summaryLine(acars, 80))).toContain(
			"H1  131.550 MHz  END POS N51",
		)
	})
	it("keeps the break in the detail body, wrapping per line", () => {
		const entry: MessageEntry = {
			seq: 1,
			decoderId: "acarsdec",
			type: "acars",
			receivedAt: 0,
			output: out("acars", "acarsdec", {}),
			formatted: acars,
		}
		const rows = messageDetail(entry, 60, 30, 0).map(lineText)
		const i = rows.findIndex(r => r.startsWith("text"))
		expect(rows[i]?.trimEnd()).toBe("text      END")
		expect(rows[i + 1]?.trimEnd()).toBe("          POS N51")
	})
})

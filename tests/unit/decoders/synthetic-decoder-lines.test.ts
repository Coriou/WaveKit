/**
 * The adapters' parsers on the output dsd-fme and multimon-ng printed for the
 * synthetic transmissions of scripts/fixtures (recorded in
 * tests/mocks/fixtures/synthetic/; made-up identities). The same checks run
 * against the live binaries through the whole chain in
 * tests/integration/synthetic-frames.test.ts; these keep the parsers covered
 * where the binaries are not installed.
 */
import { readFileSync } from "node:fs"
import pino from "pino"
import { afterAll, describe, expect, it, vi } from "vitest"
import { DsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
import { MultimonDecoder } from "../../../src/decoders/builtin/multimon-ng.js"
import { presentDecoderOutput } from "../../../src/core/activity/presentation/registry.js"
import {
	DSTAR_LINE_MS,
	checkDpmr,
	checkDstar,
	checkDstarOvers,
	checkDstarSpec,
	checkFlex,
	checkNxdn,
	checkNxdnAB,
	checkP25,
	checkP25Rekey,
	checkYsf,
	checkYsfOvers,
	dsdInterpreter,
	multimonInterpreter,
	replay,
} from "../../helpers/synthetic-decodes.js"
import type { Replay } from "../../helpers/synthetic-decodes.js"

const silent = pino({ level: "silent" })

/** A recorded output, comment lines dropped. */
function recorded(name: string): string[] {
	return readFileSync(
		new URL(`../../mocks/fixtures/synthetic/${name}.txt`, import.meta.url),
		"latin1",
	)
		.split("\n")
		.filter(line => !line.startsWith("#"))
}

const dsd = (mode: string) =>
	new DsdFmeDecoder(
		{ id: "dsd-fme", type: "dsd-fme", enabled: true, options: { mode } },
		silent,
	)

const CASES: {
	name: string
	fixture: string
	mode: string
	check: (r: Replay) => void
	lineMs?: number
}[] = [
	{
		name: "D-STAR header and checked slow data",
		fixture: "dsd-fme-dstar",
		mode: "auto",
		check: checkDstar,
		lineMs: DSTAR_LINE_MS,
	},
	{
		name: "D-STAR back to back, the second slow-data header failed",
		fixture: "dsd-fme-dstar-overs",
		mode: "auto",
		check: checkDstarOvers,
		lineMs: DSTAR_LINE_MS,
	},
	{
		name: "D-STAR spec-shaped slow data",
		fixture: "dsd-fme-dstar-spec",
		mode: "auto",
		check: checkDstarSpec,
		lineMs: DSTAR_LINE_MS,
	},
	{
		name: "YSF back to back, the second header's CSD1 failed",
		fixture: "dsd-fme-ysf-overs",
		mode: "auto",
		check: checkYsfOvers,
	},
	{
		name: "P25 HDU/LDU1/LDU2/TDU keyed up twice",
		fixture: "dsd-fme-p25-rekey",
		mode: "auto",
		check: checkP25Rekey,
	},
	{
		name: "NXDN48 A then B with TX_REL",
		fixture: "dsd-fme-nxdn48-ab-rel",
		mode: "nxdn48",
		check: checkNxdnAB(true),
	},
	{
		name: "NXDN48 A then B without a release",
		fixture: "dsd-fme-nxdn48-ab",
		mode: "nxdn48",
		check: checkNxdnAB(false),
	},
	{
		name: "YSF CSD1 / V/D2 callsigns",
		fixture: "dsd-fme-ysf",
		mode: "auto",
		check: checkYsf,
	},
	{
		name: "P25 phase 1 LCW talkgroup and source",
		fixture: "dsd-fme-p25",
		mode: "auto",
		check: checkP25,
	},
	{
		name: "NXDN48 RAN and VCALL IDs",
		fixture: "dsd-fme-nxdn48",
		mode: "nxdn48",
		check: checkNxdn("nxdn48"),
	},
	{
		name: "NXDN96 RAN and VCALL IDs",
		fixture: "dsd-fme-nxdn96",
		mode: "nxdn",
		check: checkNxdn("nxdn96"),
	},
	{
		name: "dPMR protocol without unchecked IDs",
		fixture: "dsd-fme-dpmr",
		mode: "dpmr",
		check: checkDpmr,
	},
]

describe("adapter parsers on the synthetic transmissions' decoder output", () => {
	afterAll(() => {
		vi.useRealTimers()
	})

	for (const c of CASES)
		it(`dsd-fme: ${c.name}`, () => {
			c.check(
				replay(recorded(c.fixture), dsd(c.mode), dsdInterpreter(), c.lineMs),
			)
		})

	it("multimon-ng: FLEX alphanumeric page (pipe format with timestamp)", () => {
		const decoder = new MultimonDecoder(
			{
				id: "pager",
				type: "multimon-ng",
				enabled: true,
				options: { modes: ["FLEX"] },
			},
			silent,
		)
		checkFlex(replay(recorded("multimon-flex"), decoder, multimonInterpreter()))
	})

	// The core image's dsd-fme (ed1d1d6) on the same YSF transmission. The
	// call timer fires every 500 ms: at every phase against the lines, one
	// call, its start never carrying an unchecked callsign.
	for (const lead of [0, 1, 2, 3, 4])
		it(`dsd-fme image: YSF with ${lead} lines before the first frame`, () => {
			const lines = [
				...Array(lead).fill("Audio In Device: /dev/stdin"),
				...recorded("dsd-fme-ysf-image"),
			]
			checkYsf(replay(lines, dsd("auto"), dsdInterpreter()))
		})

	describe("trust edges of the checked formats", () => {
		const run = (mode: string, lines: string[], lineMs?: number) =>
			replay(lines, dsd(mode), dsdInterpreter(), lineMs)
		const ends = (r: Replay) =>
			r.outputs
				.filter(o => o.type === "call_end")
				.map(o => o.data as Record<string, unknown>)
		const ysf = (frame: string, tail = "") =>
			`00:00:01 Sync: +YSF  V/D2 Group/CQ -Simplex ${frame}${tail}`

		it("YSF: a terminator ends the call even when its DCH failed", () => {
			const r = run("ysf", [
				ysf(
					"HC FN: 1/7",
					" DST: ALL        SRC: N0CALL     U/L:            D/L:",
				),
				ysf("CC FN: 1/7", " DST: ALL"),
				ysf("CC FN: 2/7", " SRC: N0CALL"),
				ysf("CC FN: 3/7", " U/L:"),
				ysf("TC FN: 1/7", " DST: ALL        SRC: N0CALL     DCH (CRC ERR)"),
			])
			expect(ends(r)).toEqual([
				expect.objectContaining({
					ysf: { callsign: "N0CALL" },
					flags: expect.objectContaining({ timeout: false }),
				}),
			])
		})

		it("YSF: a terminator alone (tuned in at the end) is not a call", () => {
			const r = run("ysf", [
				ysf("TC FN: 1/7", " DST: ALL        SRC: N0CALL     DCH (CRC ERR)"),
				ysf(
					"TC FN: 1/7",
					" DST: ALL        SRC: N0CALL     U/L:            D/L:",
				),
			])
			expect(r.outputs.filter(o => o.type.startsWith("call"))).toEqual([])
		})

		it("YSF: the next over's header right after a terminator names its station", () => {
			const r = run("ysf", [
				ysf(
					"HC FN: 1/7",
					" DST: ALL        SRC: AA1AAA     U/L:            D/L:",
				),
				ysf("CC FN: 1/7", " DST: ALL"),
				ysf("CC FN: 2/7", " SRC: AA1AAA"),
				ysf("CC FN: 3/7", " U/L:"),
				ysf(
					"TC FN: 1/7",
					" DST: ALL        SRC: AA1AAA     U/L:            D/L:",
				),
				ysf(
					"HC FN: 1/7",
					" DST: ALL        SRC: BB2BBB     U/L:            D/L:",
				),
				ysf("CC FN: 1/7", " DST: ALL"),
				ysf("CC FN: 2/7", " SRC: BB2BBB"),
				ysf("CC FN: 3/7", " U/L:"),
				ysf(
					"TC FN: 1/7",
					" DST: ALL        SRC: BB2BBB     U/L:            D/L:",
				),
			])
			expect(starts(r).map(o => (o.data as { ysf?: unknown }).ysf)).toEqual([
				{ callsign: "AA1AAA" },
				{ callsign: "BB2BBB" },
			])
		})

		it("NXDN: tuned in mid-call with one failed SACCH, the VCALL names the same call", () => {
			const voice = (pf: string, tail = "") =>
				`00:00:01 Sync: NXDN48  RDCH Voice  RAN 05 PF ${pf}${tail}`
			const r = run(
				"nxdn48",
				[
					voice("2/4"),
					voice("3/4"),
					voice("4/4"),
					voice("1/4"),
					voice("X/4"),
					voice("3/4"),
					voice("4/4"),
					voice("1/4"),
					voice("2/4"),
					voice("3/4"),
					voice("4/4", " VCALL"),
					" Group Call - Half Duplex 4800bps/EHR (00) - Src=1234 - Dst/TG=5678 ",
				],
				80,
			)
			expect(ends(r).map(e => [e["talkgroup"], e["source"]])).toEqual([
				[5678, 1234],
			])
		})

		it("P25: another system's TDU does not end the call", () => {
			const r = run("p25", [
				"00:00:01 Sync: +P25p1 NAC/CC: 2A5;  LDU1",
				" Group Voice Channel User - Group 4321 Source 1234567",
				"00:00:01 Sync: +P25p1 NAC/CC: 1B3;  TDU",
				"00:00:01 Sync: +P25p1 NAC/CC: 2A5;  LDU2",
				"00:00:01 Sync: +P25p1 NAC/CC: 2A5;  LDU1",
				" Group Voice Channel User - Group 4321 Source 1234567",
				"00:00:01 Sync: +P25p1 NAC/CC: 2A5;  TDU",
			])
			expect(ends(r)).toEqual([
				expect.objectContaining({
					talkgroup: 4321,
					flags: expect.objectContaining({ timeout: false }),
				}),
			])
			expect(starts(r)).toHaveLength(1)
		})
		const header = (sync: string, my: string, tail = "") =>
			`00:00:01 Sync: +DSTAR ${sync}  RPT 2: DIRECT   RPT 1: DIRECT   DST: CQCQCQ   SRC: ${my.padEnd(8)}TEST${tail}`
		const starts = (r: Replay) => r.outputs.filter(o => o.type === "call_start")

		it("D-STAR: a radio header whose slow-data copy failed is not a callsign", () => {
			const r = run("auto", [
				header("HEADER", "N0CALL", " SLOW DATA - HEADER FORMAT (CRC ERR)"),
				header("HEADER", "N0CALL", " INTERRUPTED"),
			])
			expect(r.links.filter(l => l.verified)).toEqual([])
			expect(starts(r)).toEqual([])
		})

		it("D-STAR: the next station's checked header starts its own call", () => {
			const r = run("auto", [
				header("VOICE ", "AA1AAA"),
				header("VOICE ", "AA1AAA"),
				header("VOICE ", "AA1AAA"),
				header("VOICE ", "AA1AAA"),
				header("VOICE ", "AA1AAA"),
				header("VOICE ", "AA1AAA"),
				header("VOICE ", "BB2BBB"),
				header("VOICE ", "BB2BBB"),
				header("VOICE ", "BB2BBB"),
				header("VOICE ", "BB2BBB"),
				header("VOICE ", "BB2BBB"),
				header("VOICE ", "BB2BBB"),
			])
			expect(
				starts(r).map(o => (o.data as { dstar: { my: string } }).dstar.my),
			).toEqual(["AA1AAA", "BB2BBB"])
		})

		it("NXDN: IDs after a channel grant are not this channel's call", () => {
			const r = run("nxdn48", [
				"00:00:01 Sync: NXDN48  RCCH Data          PF 1/1 VCALL_ASSGN",
				" Group Call - Half Duplex 4800bps/EHR (00) - Src=111 - Dst/TG=222 ",
				"00:00:01 Sync: NXDN48  RDCH Data  RAN 05 PF 1/4 DISC",
				" Group Call - Half Duplex 4800bps/EHR (00) - Src=0 - Dst/TG=0 ",
			])
			expect(r.links.some(l => l.tg !== undefined)).toBe(false)
			expect(starts(r)).toEqual([])
		})

		it("NXDN: a RAN counts only after two clean frames printed it", () => {
			const voice = (pf: string, ran = "05") =>
				`00:00:01 Sync: NXDN48  RDCH Voice  RAN ${ran} PF ${pf}`
			const r = run("nxdn48", [
				voice("1/4"),
				voice("X/4"),
				voice("3/4"),
				voice("4/4", "06"),
				voice("1/4", "06"),
			])
			expect(r.links.map(l => [l.ran, l.verified])).toEqual([
				[5, false],
				[5, false],
				[5, false],
				[6, false],
				[6, true],
			])
		})

		it("P25: unit to unit names a target unit, not a talkgroup", () => {
			const r = run("p25", [
				"00:00:01 Sync: +P25p1 NAC/CC: 2A5;  LDU1",
				" Unit to Unit Voice Channel User - Target 7 Source 9",
				"00:00:01 Sync: +P25p1 NAC/CC: 2A5;  LDU2",
				"00:00:01 Sync: +P25p1 NAC/CC: 2A5;  LDU1",
				" Unit to Unit Voice Channel User - Target 7 Source 9",
				"00:00:01 Sync: +P25p1 NAC/CC: 2A5;  TDU",
			])
			expect(r.links.filter(l => l.src !== undefined)).toEqual([
				expect.objectContaining({ src: "9", verified: true }),
				expect.objectContaining({ src: "9", verified: true }),
			])
			expect(r.links.some(l => l.tg !== undefined)).toBe(false)
			const end = r.outputs.find(o => o.type === "call_end")
			expect(end?.data).toMatchObject({
				talkgroup: 0,
				source: 9,
				p25: { unitTarget: 7 },
				flags: { timeout: false },
			})
			const row = presentDecoderOutput(end!, "dsd-fme")
			expect(row?.title).toBe("P25P1 to unit 7 from 9")
			// No talkgroup key: a unit target is not a talkgroup.
			expect(row?.entityKey ?? null).toBeNull()
		})

		it("NXDN: a VCALL on a control channel frame is ignored", () => {
			const r = run("nxdn48", [
				"00:00:01 Sync: NXDN48  RCCH Data          PF 1/1 VCALL",
				" Group Call - Half Duplex 4800bps/EHR (00) - Src=111 - Dst/TG=222 ",
			])
			expect(r.links.some(l => l.tg !== undefined)).toBe(false)
			expect(starts(r)).toEqual([])
		})

		it("NXDN: a call heard by RAN alone takes VCALL IDs only near its start", () => {
			const voice = (pf: string) =>
				`00:00:01 Sync: NXDN48  RDCH Voice  RAN 05 PF ${pf}`
			const lines = [voice("1/4"), voice("2/4"), voice("3/4"), voice("4/4")]
			const vcall = [
				"00:00:01 Sync: NXDN48  RDCH Voice  RAN 05 PF 4/4 VCALL",
				" Group Call - Half Duplex 4800bps/EHR (00) - Src=1234 - Dst/TG=5678 ",
			]
			// Soon after the RAN-only start: the same call.
			const near = run("nxdn48", [...lines, ...vcall])
			expect(near.outputs.filter(o => o.type === "call_end")).toHaveLength(1)
			// Well after it (another station keying up): a call of its own.
			const far = run("nxdn48", [...lines, ...lines, ...lines, ...vcall])
			expect(
				far.outputs
					.filter(o => o.type === "call_end")
					.map(o => (o.data as { source: number }).source),
			).toEqual([0, 1234])
		})

		it("dPMR: one ID print does not start a call", () => {
			const r = run("dpmr", [
				"00:00:01 Sync: +dPMR  dPMR Frame Sync 2",
				" TG=0001234 Src=0005678 Channel Code=05",
			])
			expect(starts(r)).toEqual([])
		})

		it("P25: link control on a line with a FEC error is not checked", () => {
			const r = run("p25", [
				"00:00:01 Sync: +P25p1 NAC/CC: 2A5;  LDU1",
				" Group Voice Channel User - Group 4321 Source 1234567 FEC ERR",
			])
			expect(r.links.filter(l => l.tg !== undefined)).toEqual([
				expect.objectContaining({ tg: "4321", verified: false }),
			])
		})

		it("YSF: a FICH that failed starts no call; a terminator ends it", () => {
			const r = run("ysf", [
				"00:00:01 Sync: +YSF  FN: 10/10 FICH (FEC ERR) DCH (CRC ERR)",
				"00:00:01 Sync: +YSF  V/D2 Group/CQ -Simplex CC FN: 2/7 SRC: N0CALL    ",
				"00:00:01 Sync: +YSF  V/D2 Group/CQ -Simplex CC FN: 3/7 U/L:           ",
				"00:00:01 Sync: +YSF  V/D2 Group/CQ -Simplex CC FN: 4/7 D/L:           ",
				"00:00:01 Sync: +YSF  V/D2 Group/CQ -Simplex TC FN: 1/7 DST: ALL        SRC: N0CALL     ",
			])
			expect(starts(r)).toHaveLength(1)
			const end = r.outputs.find(o => o.type === "call_end")
			// Ended by the terminator, well before the 4 s line timeout.
			expect(end?.data).toMatchObject({
				protocol: "ysf",
				ysf: { callsign: "N0CALL" },
			})
			expect(
				Date.parse((end?.data as { endedAt: string }).endedAt) -
					Date.parse((end?.data as { startedAt: string }).startedAt),
			).toBeLessThan(1000)
		})
	})

	it("multimon-ng: FLEX numeric without timestamps and a group page", () => {
		const decoder = new MultimonDecoder(
			{
				id: "pager",
				type: "multimon-ng",
				enabled: true,
				options: { modes: ["FLEX"] },
			},
			silent,
		)
		const r = replay(
			[
				"FLEX|1600/2/A|05.012|[001234567]|NUM 12345",
				"FLEX: 2026-01-02 03:04:05 1600/2/A 05.012 [001234568] TON ",
				"FLEX|2026-01-02 03:04:05|1600/2/K/A|05.012|002029568 001234569 001234570|ALN|GROUP TEXT",
			],
			decoder,
			multimonInterpreter(),
		)
		expect(r.outputs.map(o => o.data)).toEqual([
			expect.objectContaining({
				capcode: "001234567",
				messageType: "NUM",
				message: "12345",
			}),
			expect.objectContaining({
				capcode: "001234568",
				messageType: "TON",
				message: "",
			}),
			expect.objectContaining({
				capcode: "002029568",
				groupCapcodes: ["001234569", "001234570"],
				fragment: "K",
				message: "GROUP TEXT",
			}),
		])
	})
})

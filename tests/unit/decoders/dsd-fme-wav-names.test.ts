import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import {
	type DsdFmeWavCall,
	dsdFmeCallWavPattern,
} from "../../../src/decoders/builtin/dsd-fme-wav-names.js"
import { createDecoder } from "./dsd-fme-call-first-helpers.js"

interface FixtureName {
	protocol: string
	label: string
	name: string
	call?: Omit<DsdFmeWavCall, "protocol">
}

/** Names derived from the pinned dsd-fme source (label in the fixture); ids synthetic. */
const FIXTURE = JSON.parse(
	fs.readFileSync("tests/mocks/fixtures/dsd-fme/wav-names.json", "utf8"),
) as { label: string; names: FixtureName[]; unlinked: FixtureName[] }

const START = new Date(2026, 0, 9, 10, 53, 27)
const pad = (n: number) => String(n).padStart(2, "0")
function stampOf(d: Date): string {
	return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}
const STAMP = stampOf(START)

function callOf(fields: DsdFmeWavCall, startMs = START.getTime()) {
	return {
		callId: "c",
		...fields,
		startTime: new Date(startMs),
		startWallMs: startMs,
		lastUpdate: new Date(startMs),
		quality: { crcErrs: 0, fecErrs: 0 },
		flags: {},
	}
}

type Search = {
	searchForWavFile(
		call: unknown,
		end: Date,
		dir: string,
	): Promise<string | undefined>
}

interface StringCall {
	kind: "dstar" | "ysf"
	my: string
	ur: string
}
interface NumericCall {
	kind: "dmr" | "p25p1" | "nxdn48"
	tg: number
	src: number
	sys: number
}
type CallArb = StringCall | NumericCall

let root = ""
beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "wk-dsd-names-"))
})
afterEach(() => {
	fs.rmSync(root, { recursive: true, force: true })
})

async function search(
	fields: DsdFmeWavCall,
	files: readonly string[],
	startMs = START.getTime(),
): Promise<string | undefined> {
	for (const f of files) fs.writeFileSync(path.join(root, f), "")
	const d = createDecoder({ perCallRecordingDir: root })
	const found = await (d as unknown as Search).searchForWavFile(
		callOf(fields, startMs),
		new Date(startMs + 2000),
		root,
	)
	return found === undefined ? undefined : path.basename(found)
}

describe("dsd-fme per-call WAV names", () => {
	it("the fixture is labelled with its source", () => {
		expect(FIXTURE.label).toMatch(/^source-derived dsd-fme ed1d1d6/)
		for (const n of [...FIXTURE.names, ...FIXTURE.unlinked])
			expect(n.label).toBe("source-derived")
	})

	for (const n of FIXTURE.names)
		it(`links a ${n.protocol} call to its own name`, async () => {
			const fields = { protocol: n.protocol, ...n.call } as DsdFmeWavCall
			expect(dsdFmeCallWavPattern(fields)?.exec(n.name)?.[1]).toBe(
				"20260109_105327",
			)
			const name = n.name.replace("20260109_105327", STAMP)
			expect(await search(fields, [name])).toBe(name)
		})

	it("a dPMR or ProVoice call, carrying no identity, links nothing", async () => {
		for (const protocol of ["dpmr", "provoice", null]) {
			const fields = { protocol, talkgroup: 0, source: 0 }
			expect(dsdFmeCallWavPattern(fields)).toBeNull()
		}
		const dpmr = FIXTURE.unlinked[0]?.name.replace("20260109_105327", STAMP)
		expect(dpmr).toBeDefined()
		expect(
			await search({ protocol: "dpmr", talkgroup: 0, source: 0 }, [dpmr ?? ""]),
		).toBeUndefined()
	})

	it("a call without the fields that name its file gets no pattern", () => {
		const none: DsdFmeWavCall[] = [
			{ protocol: "dstar", talkgroup: 0, source: 0 },
			{ protocol: "dstar", talkgroup: 0, source: 0, dstar: { my: "  " } },
			{
				protocol: "dstar",
				talkgroup: 0,
				source: 0,
				dstar: { my: "N0CALL/P1" },
			},
			{ protocol: "ysf", talkgroup: 0, source: 0 },
			{
				protocol: "ysf",
				talkgroup: 0,
				source: 0,
				ysf: { callsign: "TOOLONGCALL1" },
			},
			{ protocol: "p25p1", talkgroup: null, source: 1234 },
			{ protocol: "p25p1", talkgroup: 56, source: null },
			{ protocol: "p25p1", talkgroup: 56, source: 1, p25: { nac: "XYZ" } },
			{ protocol: "nxdn48", talkgroup: 5, source: -1 },
			{ protocol: "dmr", talkgroup: 1.5, source: 1 },
		]
		for (const c of none) expect(dsdFmeCallWavPattern(c)).toBeNull()
		// A P25 unit to unit call is named by its target unit.
		expect(
			dsdFmeCallWavPattern({
				protocol: "p25p1",
				talkgroup: 0,
				source: 1234,
				p25: { unitTarget: 77 },
			})?.test("20260109_105327_00001_P25_2A5_PRIVATE_TGT_77_SRC_1234.wav"),
		).toBe(true)
	})

	it("two calls in the window, one file: only the call it names links", async () => {
		const file = `${STAMP}_04321_DSTAR__TGT_CQCQCQ___SRC_N0CALL__TEST.wav`
		const named = { protocol: "dstar", talkgroup: 0, source: 0 }
		expect(
			await search({ ...named, dstar: { my: "N0CALL", ur: "CQCQCQ" } }, [file]),
		).toBe(file)
		expect(
			await search({ ...named, dstar: { my: "N0CALM", ur: "CQCQCQ" } }, [file]),
		).toBeUndefined()
		// A prefix callsign is not the same station.
		expect(
			await search({ ...named, dstar: { my: "N0CAL", ur: "CQCQCQ" } }, [file]),
		).toBeUndefined()
		// Another UR is another call.
		expect(
			await search({ ...named, dstar: { my: "N0CALL", ur: "REF001CL" } }, [
				file,
			]),
		).toBeUndefined()
		// Ambiguous (no MY): neither call claims it.
		expect(await search(named, [file])).toBeUndefined()

		const p25 = `${STAMP}_04321_P25_2A5_GROUP_TGT_56_SRC_1234.wav`
		expect(
			await search(
				{ protocol: "p25p1", talkgroup: 56, source: 1235, p25: { nac: "2A5" } },
				[p25],
			),
		).toBeUndefined()
		expect(
			await search(
				{ protocol: "p25p1", talkgroup: 56, source: 1234, p25: { nac: "2A6" } },
				[p25],
			),
		).toBeUndefined()
		// The same ids under another protocol's sysid are another call.
		expect(
			await search({ protocol: "nxdn48", talkgroup: 56, source: 1234 }, [p25]),
		).toBeUndefined()
	})

	it("keeps the window and picks the stamp closest to the call's start", async () => {
		const at = (ms: number) => stampOf(new Date(START.getTime() + ms))
		const name = (ms: number, r: string) =>
			`${at(ms)}_${r}_YSF__TGT_ALL________SRC_N0CALL____.wav`
		const fields: DsdFmeWavCall = {
			protocol: "ysf",
			talkgroup: 0,
			source: 0,
			ysf: { callsign: "N0CALL" },
		}
		expect(
			await search(fields, [
				name(-3000, "00001"),
				name(1000, "00002"),
				name(9000, "00003"),
			]),
		).toBe(name(1000, "00002"))
		fs.rmSync(root, { recursive: true, force: true })
		fs.mkdirSync(root)
		// Outside start - 5 s .. end + 5 s: no link.
		expect(
			await search(fields, [name(-6000, "00004"), name(8000, "00005")]),
		).toBeUndefined()
	})

	it("malformed and foreign names never link", () => {
		const fields: DsdFmeWavCall = {
			protocol: "dstar",
			talkgroup: 0,
			source: 0,
			dstar: { my: "N0CALL", ur: "CQCQCQ" },
		}
		const p = dsdFmeCallWavPattern(fields)
		const bad = [
			"TEMP_20260109_105327_1A2B.wav",
			"20260109_105327_04321_DSTAR__TGT_CQCQCQ___SRC_N0CALL__TEST.wav.part",
			"x20260109_105327_04321_DSTAR__TGT_CQCQCQ___SRC_N0CALL__TEST.wav",
			"20260109_105327_04321_DSTAR__TGT_CQCQCQ___SRC_N0CALL__TESTX.wav",
			"20260109_105327_04321_DSTAR__TGT_CQCQCQ___SRC_N0CALL__TE/T.wav",
			"20260109_105327_04321_DSTAR_TGT_CQCQCQ___SRC_N0CALL__TEST.wav",
			"20260109_105327_04321_YSF__TGT_CQCQCQ___SRC_N0CALL__TEST.wav",
			"20260109_105327_DSTAR__TGT_CQCQCQ___SRC_N0CALL__TEST.wav",
			"2026019_105327_04321_DSTAR__TGT_CQCQCQ___SRC_N0CALL__TEST.wav",
			"20260109_105327_04321_DSTAR__TGT_CQCQCQ___SRC_N0CALL__TEST.WAV",
			"",
		]
		for (const b of bad) expect(p?.test(b)).toBe(false)
		// Regex characters in a field are matched literally.
		const dot = dsdFmeCallWavPattern({
			...fields,
			dstar: { my: "N0.ALL", ur: "CQ*" },
		})
		expect(
			dot?.test(
				"20260109_105327_04321_DSTAR__TGT_CQ*______SRC_N0.ALL__TEST.wav",
			),
		).toBe(true)
		expect(
			dot?.test(
				"20260109_105327_04321_DSTAR__TGT_CQ*______SRC_N0CALL__TEST.wav",
			),
		).toBe(false)
	})

	// Feature: dsd-fme recordings, Property 1: a file links only to a call whose own fields it names
	it("a file links only to a call whose own fields it names", () => {
		const callsign = fc
			.array(fc.constantFrom(..."ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-"), {
				minLength: 1,
				maxLength: 8,
			})
			.map(cs => cs.join(""))
		const id = fc.integer({ min: 1, max: 16_777_215 })
		const call: fc.Arbitrary<CallArb> = fc.oneof(
			fc.record({
				kind: fc.constant("dstar" as const),
				my: callsign,
				ur: callsign,
			}),
			fc.record({
				kind: fc.constant("ysf" as const),
				my: callsign,
				ur: callsign,
			}),
			fc.record({
				kind: fc.constantFrom(
					"dmr" as const,
					"p25p1" as const,
					"nxdn48" as const,
				),
				tg: id,
				src: id,
				sys: fc.integer({ min: 0, max: 15 }),
			}),
		)
		const toFields = (c: CallArb): DsdFmeWavCall => {
			switch (c.kind) {
				case "dstar":
					return {
						protocol: "dstar",
						talkgroup: 0,
						source: 0,
						dstar: { my: c.my, ur: c.ur },
					}
				case "ysf":
					return {
						protocol: "ysf",
						talkgroup: 0,
						source: 0,
						ysf: { callsign: c.my },
					}
				case "dmr":
					return {
						protocol: "dmr",
						talkgroup: c.tg,
						source: c.src,
						dmr: { cc: c.sys },
					}
				case "p25p1":
					return {
						protocol: "p25p1",
						talkgroup: c.tg,
						source: c.src,
						p25: { nac: c.sys.toString(16) },
					}
				case "nxdn48":
					return {
						protocol: "nxdn48",
						talkgroup: c.tg,
						source: c.src,
						nxdn: { ran: c.sys },
					}
			}
		}
		/** dsd-fme's name for a call (dsd_file.c, dsd_events.c), gi GROUP. */
		const nameOf = (c: CallArb): string => {
			const u = (s: string, w: number) => s.padEnd(w, "_")
			const head = "20260109_105327_04321_"
			switch (c.kind) {
				case "dstar":
					return `${head}DSTAR__TGT_${u(c.ur, 8)}_SRC_${u(c.my, 8)}____.wav`
				case "ysf":
					return `${head}YSF__TGT_ALL________SRC_${u(c.my, 10)}.wav`
				case "dmr":
					return `${head}DMR_CC_${c.sys}_GROUP_TGT_${c.tg}_SRC_${c.src}.wav`
				case "p25p1":
					return `${head}P25_${c.sys.toString(16).toUpperCase().padStart(3, "0")}_GROUP_TGT_${c.tg}_SRC_${c.src}.wav`
				case "nxdn48":
					return `${head}NXDN_RAN_${c.sys}_GROUP_TGT_${c.tg}_SRC_${c.src}.wav`
			}
		}
		const same = (a: CallArb, b: CallArb): boolean => {
			if (a.kind !== b.kind) return false
			if (
				(a.kind === "dstar" || a.kind === "ysf") &&
				(b.kind === "dstar" || b.kind === "ysf")
			)
				return a.my === b.my && (a.kind === "ysf" || a.ur === b.ur)
			if (
				a.kind === "dstar" ||
				a.kind === "ysf" ||
				b.kind === "dstar" ||
				b.kind === "ysf"
			)
				return false
			return a.tg === b.tg && a.src === b.src && a.sys === b.sys
		}
		fc.assert(
			fc.property(call, call, (fileCall, other) => {
				const name = nameOf(fileCall)
				expect(dsdFmeCallWavPattern(toFields(fileCall))?.test(name)).toBe(true)
				expect(dsdFmeCallWavPattern(toFields(other))?.test(name) ?? false).toBe(
					same(fileCall, other),
				)
			}),
			{ numRuns: 300 },
		)
	})
})

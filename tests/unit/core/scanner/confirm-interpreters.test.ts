import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { DsdFmeLinkLine } from "../../../../src/decoders/builtin/dsd-fme-link.js"
import {
	createInterpreterState,
	DoubleMatch,
} from "../../../../src/core/scanner/probes/confirm/double-match.js"
import type { DecoderOutputLike } from "../../../../src/core/scanner/probes/confirm/double-match.js"
import { interpretDirewolf } from "../../../../src/core/scanner/probes/confirm/direwolf.js"
import {
	interpretDsdFme,
	toDsdFmeScannerEvent,
} from "../../../../src/core/scanner/probes/confirm/dsd-fme.js"
import type { DsdFmeScannerEvent } from "../../../../src/core/scanner/probes/confirm/dsd-fme.js"
import { interpretMultimon } from "../../../../src/core/scanner/probes/confirm/multimon.js"
import { interpretRtl433 } from "../../../../src/core/scanner/probes/confirm/rtl433.js"

const T0 = Date.UTC(2026, 9, 9, 12)
const link = (p: Partial<DsdFmeLinkLine>): DsdFmeScannerEvent => ({
	kind: "link",
	line: { protocol: "dmr", verified: true, crcErr: false, at: T0, ...p },
})
const out = (type: string, data: unknown, at = T0): DecoderOutputLike => ({
	type,
	data,
	timestamp: new Date(at),
})
const pocsag = (
	address: number,
	message: string,
	fn = 3,
	messageType = "alpha",
) =>
	out("message", {
		protocol: "POCSAG1200",
		address,
		function: fn,
		messageType,
		message,
	})

describe("DoubleMatch", () => {
	it("accepts a value exactly once, on its second CRC-clean occurrence", () => {
		const m = new DoubleMatch()
		expect(m.accept("dmr:id", "1", true)).toBe(false)
		expect(m.accept("dmr:id", "1", false)).toBe(false)
		expect(m.accept("dmr:id", "2", true)).toBe(false)
		expect(m.accept("dmr:id", "1", true)).toBe(true)
		expect(m.accept("dmr:id", "1", true)).toBe(false)
		expect(m.isAccepted("dmr:id", "1")).toBe(true)
		expect(m.isAccepted("dmr:id", "2")).toBe(false)
		m.markAccepted("dmr:id", "2")
		expect(m.accept("dmr:id", "2", true)).toBe(false)
	})
})

describe("interpretDsdFme", () => {
	it("confirms DMR on the second clean line with the same colour code and accumulates TG/SRC/slot", () => {
		const s = createInterpreterState({
			epoch: 7,
			origin: "probe",
			probeId: "scn-a-dmr-1",
			decoderId: "scn-a-dmr-1",
		})
		expect(
			interpretDsdFme(link({ cc: 1, tg: "9", src: "2001", slot: 1 }), s),
		).toEqual([])
		expect(
			interpretDsdFme(
				link({ cc: 1, tg: "9", src: "2001", slot: 1, crcErr: true }),
				s,
			),
		).toEqual([])
		const confirm = interpretDsdFme(
			link({ cc: 1, tg: "9", src: "2001", slot: 1, at: T0 + 360 }),
			s,
		)
		expect(confirm).toEqual([
			{
				protocol: "dmr",
				identity: { kind: "dmr-cc", value: "1" },
				metadata: { talkgroups: ["9"], sources: ["2001"], slots: [1] },
				crcClean: true,
				at: T0 + 360,
				epoch: 7,
				origin: "probe",
				probeId: "scn-a-dmr-1",
				decoderId: "scn-a-dmr-1",
			},
		])
		// later clean repeats are evidence again; CRC-error repeats are not
		expect(
			interpretDsdFme(
				link({
					cc: 1,
					tg: "9",
					src: "2001",
					slot: 1,
					crcErr: true,
					at: T0 + 500,
				}),
				s,
			),
		).toEqual([])
		const repeat = interpretDsdFme(
			link({ cc: 1, tg: "9", src: "2001", slot: 1, at: T0 + 720 }),
			s,
		)
		expect(repeat).toEqual(confirm.map(e => ({ ...e, at: T0 + 720 })))
	})

	it("emits evidence for every later clean line of an accepted value, listing only accepted values", () => {
		const s = createInterpreterState({ epoch: 3, origin: "ambient" })
		interpretDsdFme(link({ cc: 2, tg: "9" }), s)
		expect(interpretDsdFme(link({ cc: 2, tg: "9" }), s)).toHaveLength(1)
		// tg 77 is new (one sighting), cc 2 is accepted: evidence with the identity, without tg 77
		expect(
			interpretDsdFme(link({ cc: 2, tg: "77", at: T0 + 1_000 }), s),
		).toEqual([
			{
				protocol: "dmr",
				identity: { kind: "dmr-cc", value: "2" },
				metadata: {},
				crcClean: true,
				at: T0 + 1_000,
				epoch: 3,
				origin: "ambient",
			},
		])
		expect(
			interpretDsdFme(link({ cc: 2, tg: "9", at: T0 + 2_000 }), s)[0],
		).toMatchObject({
			identity: { value: "2" },
			metadata: { talkgroups: ["9"] },
			at: T0 + 2_000,
		})
		expect(interpretDsdFme(link({ cc: 2, tg: "9", crcErr: true }), s)).toEqual(
			[],
		)
	})

	it("never accepts encryption from CRC-error lines and needs two clean ones", () => {
		const s = createInterpreterState({ epoch: 1, origin: "probe" })
		for (let i = 0; i < 5; i++)
			expect(
				interpretDsdFme(link({ encrypted: true, crcErr: true }), s),
			).toEqual([])
		expect(interpretDsdFme(link({ encrypted: true }), s)).toEqual([])
		const second = interpretDsdFme(link({ encrypted: true }), s)
		expect(second).toHaveLength(1)
		expect(second[0]?.encrypted).toBe(true)
		expect(second[0]?.identity).toBeUndefined()
	})

	it("maps NXDN to the probe's mode, P25 NAC and D-STAR callsigns", () => {
		const nxdn = createInterpreterState({
			epoch: 1,
			origin: "probe",
			nxdn: "nxdn48",
		})
		interpretDsdFme(link({ protocol: "nxdn", ran: 12 }), nxdn)
		expect(
			interpretDsdFme(link({ protocol: "nxdn", ran: 12 }), nxdn)[0],
		).toMatchObject({
			protocol: "nxdn48",
			identity: { kind: "nxdn-ran", value: "12" },
		})
		const p25 = createInterpreterState({ epoch: 1, origin: "ambient" })
		interpretDsdFme(link({ protocol: "p25", nac: "293" }), p25)
		expect(
			interpretDsdFme(link({ protocol: "p25", nac: "293" }), p25)[0],
		).toMatchObject({
			protocol: "p25p1",
			identity: { kind: "p25-nac", value: "293" },
			origin: "ambient",
		})
		const dstar = createInterpreterState({ epoch: 1, origin: "probe" })
		interpretDsdFme(link({ protocol: "dstar", callsign: "dl1abc " }), dstar)
		expect(
			interpretDsdFme(
				link({ protocol: "dstar", callsign: "DL1ABC" }),
				dstar,
			)[0],
		).toMatchObject({
			protocol: "dstar",
			identity: { kind: "dstar-call", value: "DL1ABC" },
			metadata: { callsigns: ["DL1ABC"] },
		})
	})

	it("adds the call id from call events only after an identity is accepted", () => {
		const s = createInterpreterState({ epoch: 2, origin: "probe" })
		const start = toDsdFmeScannerEvent(
			out("call_start", {
				callId: "c-1",
				startedAt: new Date(T0).toISOString(),
				encrypted: false,
				protocol: "dmr",
				talkgroup: 9,
				source: 2001,
				slot: 1,
			}),
		)
		expect(start).not.toBeNull()
		expect(interpretDsdFme(start as DsdFmeScannerEvent, s)).toEqual([])
		interpretDsdFme(link({ cc: 3, tg: "9" }), s)
		interpretDsdFme(link({ cc: 3, tg: "9" }), s)
		const end = toDsdFmeScannerEvent(
			out(
				"call_end",
				{
					callId: "c-1",
					protocol: "dmr",
					talkgroup: 9,
					source: 2001,
					duration: 4000,
					flags: {
						encrypted: false,
						timeout: false,
						badSignal: false,
						falsePositiveSuppressed: false,
					},
				},
				T0 + 4_000,
			),
		)
		expect(interpretDsdFme(end as DsdFmeScannerEvent, s)).toEqual([
			{
				protocol: "dmr",
				identity: { kind: "dmr-cc", value: "3" },
				metadata: { talkgroups: ["9"] },
				crcClean: true,
				callId: "c-1",
				at: T0 + 4_000,
				epoch: 2,
				origin: "probe",
			},
		])
		const update = toDsdFmeScannerEvent(
			out("call_end", {
				callId: "c-1",
				protocol: "dmr",
				talkgroup: 9,
				source: 2001,
				flags: { wavFileUpdate: true },
			}),
		)
		expect(interpretDsdFme(update as DsdFmeScannerEvent, s)).toEqual([])
		const suppressed = toDsdFmeScannerEvent(
			out("call_end", {
				callId: "c-2",
				protocol: "dmr",
				talkgroup: 0,
				source: 0,
				flags: { falsePositiveSuppressed: true },
			}),
		)
		expect(interpretDsdFme(suppressed as DsdFmeScannerEvent, s)).toEqual([])
	})

	it("unverified sync or CC-less LC cannot revive an earlier identity through a call DTO", () => {
		for (const weak of [
			link({ cc: 3, verified: false }),
			link({ tg: "9", src: "2001", voiceLc: true }),
		]) {
			const s = createInterpreterState({ epoch: 2, origin: "probe" })
			interpretDsdFme(link({ cc: 3, tg: "9", src: "2001" }), s)
			interpretDsdFme(link({ cc: 3, tg: "9", src: "2001" }), s)
			expect(s.accepted.get("dmr:id")).toBe("3")
			expect(
				interpretDsdFme(weak, s).every(e => e.identity === undefined),
			).toBe(true)
			const call = toDsdFmeScannerEvent(
				out("call_start", {
					callId: "synthetic",
					protocol: "dmr",
					talkgroup: 9,
					source: 2001,
				}),
			)!
			expect(interpretDsdFme(call, s)).toEqual([])
		}
	})

	it("ignores non-call outputs and malformed call payloads", () => {
		expect(toDsdFmeScannerEvent(out("sync", { protocol: "dmr" }))).toBeNull()
		expect(toDsdFmeScannerEvent(out("call_start", { talkgroup: 9 }))).toBeNull()
	})

	// Feature: signal-discovery-scanner, Property 10: Double-match acceptance
	// Validates: spec H2, § 6.4, § 6.6
	it("accepts an identity or encryption iff it appears on two CRC-clean lines, for any interleaving", () => {
		const lineArb = fc.record({
			cc: fc.option(fc.integer({ min: 1, max: 4 }), { nil: undefined }),
			crcErr: fc.boolean(),
			encrypted: fc.boolean(),
		})
		fc.assert(
			fc.property(fc.array(lineArb, { maxLength: 40 }), lines => {
				const s = createInterpreterState({ epoch: 5, origin: "probe" })
				const firstAt = new Map<string, number>()
				const identityAt = new Map<number, string | undefined>()
				let encryptedAt: number[] = []
				lines.forEach((l, i) => {
					const ev = interpretDsdFme(
						link({
							crcErr: l.crcErr,
							encrypted: l.encrypted,
							at: T0 + i,
							...(l.cc !== undefined ? { cc: l.cc } : {}),
						}),
						s,
					)
					expect(ev.length).toBeLessThanOrEqual(1)
					if (l.crcErr) expect(ev).toEqual([])
					for (const e of ev) {
						expect(e.crcClean).toBe(true)
						expect(e.epoch).toBe(5)
						const value = e.identity?.value
						identityAt.set(i, value)
						if (value !== undefined && !firstAt.has(value))
							firstAt.set(value, i)
						if (e.encrypted === true) encryptedAt = [...encryptedAt, i]
					}
				})
				for (const cc of ["1", "2", "3", "4"]) {
					const clean = lines.flatMap((l, i) =>
						!l.crcErr && l.cc !== undefined && String(l.cc) === cc ? [i] : [],
					)
					// first emitted at the acceptance index (second clean line) ...
					if (clean.length >= 2) expect(firstAt.get(cc)).toBe(clean[1])
					else expect(firstAt.has(cc)).toBe(false)
					// ... and every later clean line with that value is evidence carrying it
					for (const i of clean.slice(1)) expect(identityAt.get(i)).toBe(cc)
				}
				const cleanEnc = lines.flatMap((l, i) =>
					!l.crcErr && l.encrypted ? [i] : [],
				)
				expect(encryptedAt).toEqual(cleanEnc.slice(1))
			}),
			{ numRuns: 100 },
		)
	})
})

describe("interpretMultimon", () => {
	it("confirms on one plausible payload or two equal capcodes, never on garbage alone", () => {
		const s = createInterpreterState({
			epoch: 1,
			origin: "ambient",
			decoderId: "pager",
		})
		expect(interpretMultimon(pocsag(1234567, "CALL OFFICE 0800"), s)).toEqual([
			{
				protocol: "pocsag",
				identity: { kind: "pocsag-capcode", value: "1234567" },
				metadata: { capcodes: ["1234567"] },
				crcClean: true,
				at: T0,
				epoch: 1,
				origin: "ambient",
				decoderId: "pager",
			},
		])
		// an accepted capcode is evidence again on every later decode, even with a garbled payload
		expect(
			interpretMultimon(pocsag(1234567, "CALL OFFICE 0800", 3, "alpha"), s),
		).toHaveLength(1)
		expect(interpretMultimon(pocsag(1234567, "<NUL><ETX>"), s)).toHaveLength(1)
		expect(
			interpretMultimon(pocsag(7654321, "<NUL><ETX>x<SOH><DEL>"), s),
		).toEqual([])
		expect(interpretMultimon(pocsag(7654321, "Q<ETB>"), s)).toHaveLength(1)
		expect(interpretMultimon(pocsag(1111111, "VALID TEXT", 6), s)).toEqual([])
		expect(interpretMultimon(pocsag(2222222, "", 0, "tone only"), s)).toEqual(
			[],
		)
		expect(interpretMultimon(pocsag(3333333, "OK"), s)).toEqual([])
		expect(
			interpretMultimon(
				out("message", {
					protocol: "FLEX",
					mode: "1600/2/A",
					frequency: "0.000",
					capcode: "001234567",
					messageType: "ALN",
					message: "Unit 4 respond<CR><LF>",
				}),
				s,
			)[0],
		).toMatchObject({
			protocol: "flex",
			identity: { kind: "pocsag-capcode", value: "001234567" },
		})
		expect(
			interpretMultimon(out("decode", { protocol: "DTMF", digits: "12" }), s),
		).toEqual([])
	})

	// Feature: signal-discovery-scanner, Property 10: Double-match acceptance
	// Validates: spec § 6.4, § 6.6
	it("accepts a capcode iff two decodes share it or one payload is plausible, first emitting at the earliest such decode and on every decode after", () => {
		const decodeArb = fc.record({
			cap: fc.constantFrom(1234567, 7654321, 1111111),
			plausible: fc.boolean(),
			fn: fc.integer({ min: 0, max: 3 }),
			good: fc.constantFrom(
				"CALL OFFICE NOW",
				"TEST 1234",
				"Ambulance to bay 3",
			),
			bad: fc.constantFrom(
				"<NUL><ETX><SOH>a<DEL>",
				"",
				"ab",
				"<STX><ETB><SYN><CAN>z",
			),
		})
		fc.assert(
			fc.property(fc.array(decodeArb, { maxLength: 30 }), decodes => {
				const s = createInterpreterState({ epoch: 1, origin: "probe" })
				const emitted = new Map<string, number[]>()
				decodes.forEach((d, i) => {
					const ev = interpretMultimon(
						pocsag(d.cap, d.plausible ? d.good : d.bad, d.fn),
						s,
					)
					expect(ev.length).toBeLessThanOrEqual(1)
					for (const e of ev) {
						const v = e.identity?.value ?? ""
						expect(v).toBe(String(d.cap))
						emitted.set(v, [...(emitted.get(v) ?? []), i])
					}
				})
				for (const cap of [1234567, 7654321, 1111111]) {
					const idx = decodes.flatMap((d, i) => (d.cap === cap ? [i] : []))
					const firstPlausible = decodes.findIndex(
						d => d.cap === cap && d.plausible,
					)
					const candidates = [
						firstPlausible >= 0 ? firstPlausible : Infinity,
						idx[1] ?? Infinity,
					]
					const expected = Math.min(...candidates)
					// first emitted at the acceptance index, then on every later decode of the capcode
					if (expected === Infinity)
						expect(emitted.has(String(cap))).toBe(false)
					else
						expect(emitted.get(String(cap))).toEqual(
							idx.filter(i => i >= expected),
						)
				}
			}),
			{ numRuns: 100 },
		)
	})
})

describe("interpretDirewolf and interpretRtl433", () => {
	it("accepts each APRS source callsign on its first frame and reports every later frame", () => {
		const s = createInterpreterState({ epoch: 1, origin: "ambient" })
		const frame = out("aprs", {
			source: "dl1abc-9",
			destination: "APRS",
			path: [],
			dataType: "!",
		})
		const evidence = [
			{
				protocol: "aprs",
				identity: { kind: "aprs-call", value: "DL1ABC-9" },
				metadata: { callsigns: ["DL1ABC-9"] },
				crcClean: true,
				at: T0,
				epoch: 1,
				origin: "ambient",
			},
		]
		expect(interpretDirewolf(frame, s)).toEqual(evidence)
		expect(interpretDirewolf(frame, s)).toEqual(evidence)
		expect(interpretDirewolf(out("aprs", { destination: "APRS" }), s)).toEqual(
			[],
		)
	})

	it("accepts an ISM device on its second checksummed decode, then reports every checksummed decode", () => {
		const s = createInterpreterState({ epoch: 1, origin: "probe" })
		const dev = (mic?: string) =>
			out("signal", {
				time: "2026-10-09 12:00:00",
				model: "Acurite-Tower",
				id: 1234,
				...(mic !== undefined ? { mic } : {}),
			})
		expect(interpretRtl433(dev(), s)).toEqual([])
		expect(interpretRtl433(dev(), s)).toEqual([])
		expect(interpretRtl433(dev("CHECKSUM"), s)).toEqual([])
		const evidence = [
			{
				protocol: "ism",
				identity: { kind: "ism-model", value: "Acurite-Tower:1234" },
				metadata: { ismModels: ["Acurite-Tower"] },
				crcClean: true,
				at: T0,
				epoch: 1,
				origin: "probe",
			},
		]
		expect(interpretRtl433(dev("CHECKSUM"), s)).toEqual(evidence)
		expect(interpretRtl433(dev(), s)).toEqual([])
		expect(interpretRtl433(dev("CRC"), s)).toEqual(evidence)
	})
})

/**
 * dsd-fme call-first for YSF, NXDN and dPMR (two clean frames start the call,
 * back-dated to the over's first sync, IDs attach later, no encryption field:
 * the adapter does not read their encryption), plus back-dating after an
 * on-grid DMR identity change, the back-dating bound, and DMR noise syncs
 * that start a call whose encryption is never known.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	BACKDATE_MAX_CHAIN_WINDOWS,
	SYNC_CHAIN_MS,
} from "../../../src/decoders/builtin/dsd-fme.js"
import {
	at,
	createDecoder,
	LC,
	MS,
	replay,
	T0,
	type Line,
} from "./dsd-fme-call-first-helpers.js"

const YSF = (frame: string) =>
	`03:04:05 Sync: +YSF  V/D2 Group/CQ -Simplex ${frame}`
const YSF_BAD = "03:04:05 Sync: +YSF  FN: 10/10 FICH (CRC ERR) DCH (CRC ERR) "
const NXDN = (pf: string, tail = "") =>
	`03:04:05 Sync: NXDN48  RDCH Voice  RAN 05 PF ${pf}${tail}`
const NXDN_IDS =
	" Group Call - Half Duplex 4800bps/EHR (00) - Src=1234 - Dst/TG=5678 "
const DPMR_SYNC = "03:04:05 Sync: +dPMR  dPMR Frame Sync 2"
const DPMR_IDS = " TG=0001234 Src=0005678 Channel Code=05"

describe("dsd-fme call-first: YSF, NXDN, dPMR", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	describe("YSF", () => {
		it("two clean frames start the call, back-dated, the callsign printed before attaches, no encryption field", () => {
			const { starts, ends, voice } = replay(
				[
					[0, YSF_BAD],
					[100, YSF("HC FN: 1/7 DST: ALL        SRC: N0CALL     ")],
					[200, YSF("CC FN: 2/7 U/L:           ")],
					[300, YSF("CC FN: 3/7 D/L:           ")],
					[400, YSF("CC FN: 4/7 D/L:           ")],
				],
				8000,
			)
			expect(starts).toHaveLength(1)
			expect(at(starts[0]!.startedAt)).toBe(0)
			expect(ends).toHaveLength(1)
			expect(ends[0]!.ysf?.callsign).toBe("N0CALL")
			expect(starts[0]).not.toHaveProperty("encryptionKnown")
			expect(voice.every(v => !("encryptionKnown" in v))).toBe(true)
		})

		it("one clean frame among failed ones starts nothing", () => {
			const { starts } = replay(
				[
					[0, YSF("CC FN: 2/7 U/L:           ")],
					[100, YSF_BAD],
					[200, YSF_BAD],
				],
				8000,
			)
			expect(starts).toHaveLength(0)
		})

		it("a header frame after an over starts the next one on its second clean frame, back-dated to the header", () => {
			const { ends } = replay(
				[
					[0, YSF("HC FN: 1/7 DST: ALL        SRC: N0CALL     ")],
					[100, YSF("CC FN: 2/7 U/L:           ")],
					[200, YSF("CC FN: 3/7 U/L:           ")],
					[300, YSF("CC FN: 4/7 U/L:           ")],
					[400, YSF("CC FN: 5/7 U/L:           ")],
					[500, YSF("CC FN: 6/7 U/L:           ")],
					[600, YSF("CC FN: 7/7 U/L:           ")],
					// The timer has announced the first call; the next over's header follows at once.
					[700, YSF("HC FN: 1/7 DST: ALL        SRC: F0ABC      ")],
					[800, YSF("CC FN: 2/7 U/L:           ")],
					[900, YSF("CC FN: 3/7 U/L:           ")],
				],
				8000,
			)
			expect(ends).toHaveLength(2)
			expect(at(ends[1]!.startedAt)).toBe(700)
			expect(ends[1]!.ysf?.callsign).toBe("F0ABC")
		})
	})

	describe("NXDN", () => {
		it("two clean voice frames start the call, back-dated; the VCALL IDs attach later; no encryption field", () => {
			const decoder = createDecoder({ mode: "nxdn48" })
			const lines: Line[] = [
				[0, NXDN("1/4")],
				[80, NXDN("2/4")],
				[160, NXDN("3/4")],
				[240, NXDN("4/4", " VCALL")],
				[240, NXDN_IDS],
				[320, NXDN("1/4")],
			]
			const { starts, ends, voice } = replay(lines, 8000, decoder)
			expect(starts).toHaveLength(1)
			expect(at(starts[0]!.startedAt)).toBe(0)
			expect(ends).toHaveLength(1)
			expect(ends[0]).toMatchObject({ talkgroup: 5678, source: 1234 })
			expect(starts[0]).not.toHaveProperty("encryptionKnown")
			expect(voice.every(v => !("encryptionKnown" in v))).toBe(true)
		})

		it("one clean voice frame starts nothing", () => {
			const decoder = createDecoder({ mode: "nxdn48" })
			expect(replay([[0, NXDN("1/4")]], 8000, decoder).starts).toHaveLength(0)
		})
	})

	describe("dPMR", () => {
		it("two clean frames (agreeing ID prints) start the call, back-dated, IDs kept out, no encryption field", () => {
			const decoder = createDecoder({ mode: "dpmr" })
			const lines: Line[] = []
			for (let t = 0; t <= 400; t += 80)
				lines.push([t, DPMR_SYNC], [t, DPMR_IDS])
			const { starts, ends, voice } = replay(lines, 8000, decoder)
			expect(starts).toHaveLength(1)
			expect(at(starts[0]!.startedAt)).toBe(0)
			expect(ends).toHaveLength(1)
			expect(ends[0]).toMatchObject({ talkgroup: 0, source: 0 })
			expect(starts[0]).not.toHaveProperty("encryptionKnown")
			expect(voice.every(v => !("encryptionKnown" in v))).toBe(true)
		})

		it("one clean frame starts nothing", () => {
			const decoder = createDecoder({ mode: "dpmr" })
			const { starts } = replay(
				[
					[0, DPMR_SYNC],
					[0, DPMR_IDS],
				],
				8000,
				decoder,
			)
			expect(starts).toHaveLength(0)
		})
	})
})

describe("dsd-fme call-first: DMR back-dating", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("an on-grid identity change ends the old call at its last own line and back-dates the new one to the next sync", () => {
		const lines: Line[] = []
		for (let i = 0; i < 10; i++) {
			const t = 1000 + i * 360
			lines.push([t, MS("VC*")], [t + 40, LC(1, i < 5 ? 9 : 10)])
		}
		const { ends } = replay(lines, 12_000)
		expect(ends.map(e => e.talkgroup)).toEqual([9, 10])
		// TG 9's last LC at 1000 + 4 x 360 + 40 = 2480; the next sync at 2800.
		expect(at(ends[0]!.endedAt!)).toBe(2480)
		expect(at(ends[1]!.startedAt)).toBe(2800)
	})

	it("states the back-dating bound", () => {
		expect(BACKDATE_MAX_CHAIN_WINDOWS).toBe(4)
		expect(SYNC_CHAIN_MS.dmr! * BACKDATE_MAX_CHAIN_WINDOWS).toBe(3040)
	})

	it("back-dates at most 4 chain windows (3 040 ms for DMR) before the starting line: at the bound and 1 ms past", () => {
		// An errored chain from 0 (steps of 360 ms), then two clean syncs (the
		// call starts on the second) and a third (enough syncs to announce it).
		const run = (last: number) => {
			const lines: Line[] = []
			for (let t = 0; t <= 2520; t += 360) lines.push([t, MS("VC* (FEC ERR)")])
			lines.push(
				[last - 360, MS("VC*")],
				[last, MS("VC*")],
				[last + 360, MS("VC*")],
			)
			return replay(lines, 12_000).starts
		}
		const atBound = run(3040)
		expect(atBound).toHaveLength(1)
		expect(at(atBound[0]!.startedAt)).toBe(0)
		const past = run(3041)
		expect(past).toHaveLength(1)
		expect(at(past[0]!.startedAt)).toBe(1)
	})

	it("repeated noise syncs of one colour code 700 ms apart start a call whose encryption is never known (muted)", () => {
		const { starts, ends, voice } = replay(
			[
				[0, MS("VC*")],
				[700, MS("VC*")],
				[1400, MS("VC*")],
				[2100, MS("VC*")],
			],
			10_000,
		)
		expect(starts).toHaveLength(1)
		expect(ends).toHaveLength(1)
		expect(voice.length).toBeGreaterThan(0)
		expect(voice.every(v => v.encryptionKnown === false)).toBe(true)
		expect(ends[0]!.encryptionKnown).toBe(false)
	})
})

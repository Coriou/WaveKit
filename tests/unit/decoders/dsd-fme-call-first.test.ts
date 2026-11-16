/**
 * dsd-fme call-first lifecycle: a call starts on its over's second clean
 * voice frame, back-dated to the first sync; identities attach when they
 * arrive; each DMR repeater slot runs its own call; idle bursts keep no call
 * alive; a re-key after REKEY_GAP_MS is a new call; and a call that started
 * before its encryption was known says so (`encryptionKnown: false`).
 */

import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import pino from "pino"
import {
	DMR_SUPERFRAME_MS,
	DsdFmeDecoder,
	REKEY_GAP_MS,
	SYNC_CHAIN_MS,
	type DsdFmeVoiceCallState,
} from "../../../src/decoders/builtin/dsd-fme.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })
const T0 = Date.parse("2026-01-02T03:04:05.000Z")

type Internals = {
	handleOutputLine(line: string): void
	checkCallTimeoutAsync(): void
}

interface CallData {
	callId: string
	startedAt: string
	endedAt?: string
	talkgroup: number | null
	source: number | null
	slot?: number
	encrypted?: boolean
	encryptionKnown?: boolean
	wavFile?: string
	flags?: { timeout?: boolean; encrypted?: boolean; wavFileUpdate?: boolean }
}

type Line = [atMs: number, text: string]

function createDecoder(options: Record<string, unknown> = {}): DsdFmeDecoder {
	return new DsdFmeDecoder(
		{
			id: "dsd-fme",
			type: "dsd-fme",
			enabled: true,
			options: { mode: "auto", ...options },
		},
		logger,
	)
}

/** Replays timed lines (10 ms steps), running the 500 ms call timer as time passes. */
function replay(lines: Line[], untilMs: number, decoder = createDecoder()) {
	const outputs: DecoderOutput[] = []
	const voice: DsdFmeVoiceCallState[] = []
	decoder.on("output", (o: DecoderOutput) => outputs.push(o))
	decoder.on("voice-call", (v: DsdFmeVoiceCallState) => voice.push(v))
	const internals = decoder as unknown as Internals
	const sorted = [...lines].sort((a, b) => a[0] - b[0])
	let index = 0
	for (let now = 0; now <= untilMs; now += 10) {
		while (index < sorted.length && sorted[index]![0] <= now) {
			vi.setSystemTime(T0 + sorted[index]![0])
			internals.handleOutputLine(sorted[index]![1])
			index++
		}
		vi.setSystemTime(T0 + now)
		if (now % 500 === 0) internals.checkCallTimeoutAsync()
	}
	const of = (type: string) =>
		outputs
			.filter(o => o.type === type)
			.map(o => o.data as CallData)
			.filter(d => !d.flags?.wavFileUpdate)
	return { starts: of("call_start"), ends: of("call_end"), voice, outputs }
}

const at = (iso: string) => Date.parse(iso) - T0

const MS = (burst: string, cc = "01") =>
	`03:04:05 Sync: +DMR MS/DM MODE/MONO | Color Code=${cc} | ${burst} `
const BS = (slot: 1 | 2, burst: string) =>
	`03:04:05 Sync: +DMR ${slot === 1 ? " [slot1]  slot2 " : "  slot1  [slot2]"} | Color Code=01 | ${burst} `
const LC = (slot: number, tg = 9, src = 100, extra = "") =>
	` SLOT ${slot} TGT=${tg} SRC=${src} Group Call ${extra}`

/** Voice syncs of one slot, one per 360 ms superframe, from `from` (inclusive) to `to` (exclusive). */
const superframes = (
	from: number,
	to: number,
	line: () => string,
	step = DMR_SUPERFRAME_MS,
): Line[] => {
	const out: Line[] = []
	for (let t = from; t < to; t += step) out.push([t, line()])
	return out
}

describe("dsd-fme call-first lifecycle", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("states its bounds", () => {
		// 2 x 360 + 40; one fast re-key gap.
		expect(SYNC_CHAIN_MS.dmr).toBe(2 * 360 + 40)
		expect(SYNC_CHAIN_MS.p25p1).toBe(2 * 180 + 40)
		expect(SYNC_CHAIN_MS.dstar).toBe(2 * 420 + 40)
		expect(REKEY_GAP_MS).toBe(200)
	})

	it("a single noise sync, or a clean one and an errored one, starts nothing", () => {
		expect(replay([[0, MS("VC*")]], 6000).starts).toHaveLength(0)
		const errored = replay(
			[
				[0, MS("VC*")],
				[360, MS("VC* (FEC ERR)")],
			],
			6000,
		)
		expect(errored.starts).toHaveLength(0)
		expect(errored.ends).toHaveLength(0)
	})

	it("starts on the second clean voice sync, back-dated to the first, encryption not known", () => {
		const { starts, ends, voice } = replay(
			[
				[1000, MS("VC*")],
				[1360, MS("VC*")],
				[1720, MS("VC*")],
			],
			8000,
		)
		expect(starts).toHaveLength(1)
		expect(at(starts[0]!.startedAt)).toBe(1000)
		expect(starts[0]).toMatchObject({
			talkgroup: null,
			source: null,
			encrypted: false,
			encryptionKnown: false,
		})
		expect(voice[0]).toMatchObject({
			active: true,
			encrypted: false,
			encryptionKnown: false,
		})
		// No terminator: the timeout ends it at its last voice sync.
		expect(ends).toHaveLength(1)
		expect(at(ends[0]!.endedAt!)).toBe(1720)
		expect(ends[0]!.flags?.timeout).toBe(true)
		expect(ends[0]!.encryptionKnown).toBe(false)
	})

	it("two syncs of another colour code, or further apart than the chain, start nothing", () => {
		expect(
			replay(
				[
					[0, MS("VC*", "01")],
					[360, MS("VC*", "05")],
				],
				6000,
			).starts,
		).toHaveLength(0)
		// A third sync one superframe on announces a chain of three (hasEvidence).
		const window = SYNC_CHAIN_MS.dmr!
		expect(
			replay(
				[
					[0, MS("VC*")],
					[window + 1, MS("VC*")],
					[window + 1 + DMR_SUPERFRAME_MS, MS("VC*")],
				],
				6000,
			).starts,
		).toHaveLength(0)
		// At the chain bound they pair.
		expect(
			replay(
				[
					[0, MS("VC*")],
					[window, MS("VC*")],
					[window + DMR_SUPERFRAME_MS, MS("VC*")],
				],
				6000,
			).starts,
		).toHaveLength(1)
	})

	it("keeps the 250 ms weak-metadata suppression: a pair 100 ms apart and nothing else is no call", () => {
		const { starts, ends, voice } = replay(
			[
				[0, MS("VC*")],
				[100, MS("VC*")],
			],
			6000,
		)
		expect(starts).toHaveLength(0)
		expect(ends).toHaveLength(0)
		expect(voice).toHaveLength(0)
	})

	it("attaches the IDs of the first link control and learns the call is clear", () => {
		// Three syncs announce the unnamed call (timer at 1000); the LC at 1100
		// counts once the sync at 1440 closes its burst clean.
		const { starts, ends, voice } = replay(
			[
				[0, MS("VC*")],
				[360, MS("VC*")],
				[720, MS("VC*")],
				[1080, MS("VC*")],
				[1100, LC(1)],
				[1440, MS("VC*")],
				[1800, MS("TLC")],
				[1800, LC(1)],
			],
			6000,
		)
		expect(starts).toHaveLength(1)
		expect(ends).toHaveLength(1)
		expect(ends[0]).toMatchObject({
			talkgroup: 9,
			source: 100,
			encryptionKnown: true,
		})
		expect(at(ends[0]!.startedAt)).toBe(0)
		expect(at(ends[0]!.endedAt!)).toBe(1800)
		expect(ends[0]!.flags?.timeout).toBe(false)
		// call_start (unknown), the update (known clear, with its IDs), call_end.
		expect(
			voice.map(v => [v.active, v.encrypted, v.encryptionKnown, v.talkgroup]),
		).toEqual([
			[true, false, false, null],
			[true, false, true, 9],
			[false, false, true, 9],
		])
		expect(new Set(voice.map(v => v.callId)).size).toBe(1)
	})

	it("an encrypted link control makes the unknown call known encrypted", () => {
		const { ends, voice } = replay(
			[
				[0, MS("VC*")],
				[360, MS("VC*")],
				[600, LC(1, 9, 100, "Encrypted ")],
				[720, MS("VC*")],
			],
			6000,
		)
		expect(voice[1]).toMatchObject({ encrypted: true, encryptionKnown: true })
		expect(ends[0]!.flags?.encrypted).toBe(true)
	})

	it("a call started on its IDs is back-dated to its first sync and known from the start", () => {
		const { starts, voice } = replay(
			[
				[0, MS("VC*")],
				[300, LC(1)],
				[360, MS("VC*")],
			],
			6000,
		)
		expect(at(starts[0]!.startedAt)).toBe(0)
		expect(starts[0]!.encryptionKnown).toBeUndefined()
		expect(voice.every(v => v.encryptionKnown === undefined)).toBe(true)
	})

	it("does not start a phantom call from the terminator LC of a call ended before its IDs", () => {
		const { starts, ends } = replay(
			[
				[0, MS("VC*")],
				[360, MS("VC*")],
				[700, MS("TLC")],
				[700, LC(1)],
			],
			6000,
		)
		expect(starts).toHaveLength(1)
		expect(ends).toHaveLength(1)
	})

	it("two busy repeater slots give two concurrent calls, each with its own IDs, and no split", () => {
		const lines: Line[] = [
			...superframes(0, 3000, () => BS(1, "VC*")),
			...superframes(240, 3000, () => LC(1, 9, 100), 720),
			[3000, BS(1, "TLC")],
			[3000, LC(1, 9, 100)],
			...superframes(1030, 4030, () => BS(2, "VC*")),
			...superframes(1270, 4030, () => LC(2, 7, 200), 720),
			[4030, BS(2, "TLC")],
			[4030, LC(2, 7, 200)],
		]
		const { starts, ends } = replay(lines, 9000)
		expect(starts).toHaveLength(2)
		expect(ends).toHaveLength(2)
		const bySlot = new Map(ends.map(e => [e.slot, e]))
		expect(bySlot.get(1)).toMatchObject({ talkgroup: 9, source: 100 })
		expect(bySlot.get(2)).toMatchObject({ talkgroup: 7, source: 200 })
		expect(at(bySlot.get(1)!.startedAt)).toBe(0)
		expect(at(bySlot.get(1)!.endedAt!)).toBe(3000)
		expect(at(bySlot.get(2)!.startedAt)).toBe(1030)
		expect(at(bySlot.get(2)!.endedAt!)).toBe(4030)
		for (const e of ends) expect(e.flags?.timeout).toBe(false)
	})

	it("hang-time idle bursts do not keep a call whose terminator was lost alive", () => {
		const lines: Line[] = [
			...superframes(0, 1100, () => BS(1, "VC*")),
			[240, LC(1)],
			[960, LC(1)],
			// 6 s of idle bursts on both slots (the repeater's hang time).
			...superframes(1110, 7110, () => BS(1, "IDLE"), 60),
			...superframes(1140, 7140, () => BS(2, "IDLE"), 60),
		]
		const { ends } = replay(lines, 12_000)
		expect(ends).toHaveLength(1)
		expect(at(ends[0]!.endedAt!)).toBe(1080)
		expect(ends[0]!.flags?.timeout).toBe(true)
	})

	describe("a re-key without a terminator", () => {
		/**
		 * An over with IDs: voice syncs at 0 and 360, its last line (LC) at 400,
		 * then the next over's first sync at `rekeyAt` and a second on its grid.
		 */
		const rekey = (rekeyAt: number, burst = "VC*"): Line[] => [
			[0, MS("VC*")],
			[360, MS("VC*")],
			[400, LC(1)],
			[rekeyAt, MS(burst)],
			[rekeyAt + 360, MS("VC*")],
			[rekeyAt + 400, LC(1)],
			[rekeyAt + 700, MS("TLC")],
			[rekeyAt + 700, LC(1)],
		]

		it("a voice LC header is the same call 199 ms after the last voice sync, a new one at 200 ms (an LC print is not voice)", () => {
			// 159 / 160 ms after the LC print at 400: only voice syncs count.
			const near = replay(rekey(360 + REKEY_GAP_MS - 1, "VLC"), 6000)
			expect(near.ends).toHaveLength(1)
			const far = replay(rekey(360 + REKEY_GAP_MS, "VLC"), 6000)
			expect(far.ends).toHaveLength(2)
			// The first ends at its last line, the second starts at its first sync.
			expect(at(far.ends[0]!.endedAt!)).toBe(400)
			expect(far.ends[0]!.flags?.timeout).toBe(true)
			expect(at(far.ends[1]!.startedAt)).toBe(560)
			expect(far.ends[1]).toMatchObject({ talkgroup: 9, source: 100 })
		})

		it("an off-grid voice sync with the same IDs and no header is the same over", () => {
			// Adapted (was: 600, 240 ms after the last sync and 120 ms off the
			// grid, confirmed by the next sync, split). Line arrival is clumped
			// (DSD_FME_LINE_CLUMP_MS), so a sync's arrival off a grid is no sign
			// of a re-key: one call (a missed split, never a split over).
			const { ends } = replay(rekey(600), 6000)
			expect(ends).toHaveLength(1)
			expect(at(ends[0]!.startedAt)).toBe(0)
			expect(at(ends[0]!.endedAt!)).toBe(1300)
			// A direct-mode data burst whose slot type failed is the next
			// over's header: 240 ms after the last voice sync it splits.
			const header = replay(
				rekey(600)
					.map(
						([t, text]): Line =>
							t === 600
								? [
										t,
										"03:04:05 Sync: +DMR MS/DM MODE/MONO | Color Code=13 | CACH/Burst FEC ERR",
									]
								: [t, text],
					)
					.concat([[640, MS("VC*")]]),
				6000,
			)
			expect(header.ends).toHaveLength(2)
			expect(at(header.ends[0]!.endedAt!)).toBe(400)
			expect(header.ends[0]!.flags?.timeout).toBe(true)
			expect(at(header.ends[1]!.startedAt)).toBe(600)
			expect(header.ends[1]).toMatchObject({ talkgroup: 9, source: 100 })
		})

		it("keeps a faded over whole when its voice resumes, on or off a superframe grid", () => {
			// 2 s hole; the next sync 6 superframes on, 30 ms late.
			const resumed = 360 + 6 * DMR_SUPERFRAME_MS + 30
			const { ends } = replay(
				[
					[0, MS("VC*")],
					[360, MS("VC*")],
					[400, LC(1)],
					[resumed, MS("VC*")],
					[resumed + 300, MS("TLC")],
				],
				8000,
			)
			expect(ends).toHaveLength(1)
			// Adapted (was: 91 ms off after the long gap split at once). Any
			// offset of the resumed syncs is one call: no grid on clumped arrival.
			const late = (offset: number) =>
				replay(
					[
						[0, MS("VC*")],
						[360, MS("VC*")],
						[400, LC(1)],
						[resumed - 30 + offset, MS("VC*")],
						[resumed - 30 + offset + 360, MS("VC*")],
						[resumed - 30 + offset + 700, MS("TLC")],
					],
					8000,
				).ends
			for (const offset of [31, 90, 91, 180])
				expect(late(offset)).toHaveLength(1)
		})

		it("a voice LC header after the gap is a new over even on the grid", () => {
			const { ends } = replay(
				[
					[0, MS("VC*")],
					[360, MS("VC*")],
					[400, LC(1)],
					[720, MS("VLC")],
					[720, LC(1)],
					[1080, MS("VC*")],
					[1400, MS("TLC")],
				],
				6000,
			)
			expect(ends).toHaveLength(2)
			expect(at(ends[1]!.startedAt)).toBe(720)
		})
	})

	it("P25: starts on HDU and LDU1, back-dated, the LCW attaches the IDs and says clear", () => {
		const sync = (duid: string) => `03:04:05 Sync: +P25p1 NAC/CC: 2A5;  ${duid}`
		const { starts, ends } = replay(
			[
				[0, sync("HDU")],
				[180, sync("LDU1")],
				[185, " Group Voice Channel User - Group 4321 Source 1234567"],
				[360, sync("LDU2")],
				[540, sync("LDU1")],
				[900, sync("TDU")],
			],
			6000,
		)
		expect(starts).toHaveLength(1)
		expect(ends).toHaveLength(1)
		expect(ends[0]).toMatchObject({ talkgroup: 4321, source: 1234567 })
		expect(at(ends[0]!.startedAt)).toBe(0)
		expect(ends[0]!.encryptionKnown).toBe(true)
	})

	it("D-STAR: two voice syncs start a call before any callsign", () => {
		const { starts, ends } = replay(
			[
				[0, "03:04:05 Sync: +DSTAR VOICE "],
				[420, "03:04:05 Sync: +DSTAR VOICE "],
				[840, "03:04:05 Sync: +DSTAR VOICE "],
			],
			8000,
		)
		expect(starts).toHaveLength(1)
		expect(at(ends[0]!.startedAt)).toBe(0)
		expect(at(ends[0]!.endedAt!)).toBe(840)
		// D-STAR has no encryption the adapter reads: known (legacy).
		expect(ends[0]!.encryptionKnown).toBeUndefined()
	})

	it("YSF: a call is back-dated to its over's first sync", () => {
		const { starts } = replay(
			[
				[
					0,
					"03:04:05 Sync: +YSF  FN: 10/10 FICH (CRC ERR) DCH (CRC ERR) DCH (CRC ERR) ",
				],
				[
					100,
					"03:04:05 Sync: +YSF  V/D2 Group/CQ -Simplex HC FN: 1/7 DST: ALL        SRC: N0CALL     U/L:            D/L:            ",
				],
				[
					200,
					"03:04:05 Sync: +YSF  V/D2 Group/CQ -Simplex CC FN: 1/7 DST: ALL        ",
				],
			],
			6000,
		)
		expect(starts).toHaveLength(1)
		expect(at(starts[0]!.startedAt)).toBe(0)
	})
})

describe("dsd-fme: a call whose encryption was never known", () => {
	it("is never linked to a recording; a known one is", () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "wk-call-first-"))
		try {
			const start = new Date(2026, 0, 9, 10, 53, 27)
			fs.writeFileSync(
				path.join(
					root,
					"20260109_105327_123_DMR_CC_1_GROUP_TGT_100_SRC_200.wav",
				),
				"",
			)
			const end = (known: boolean | undefined) => {
				const d = createDecoder({
					enablePerCallRecording: true,
					perCallRecordingDir: root,
				}) as unknown as {
					callState: unknown
					endCall(
						now: Date,
						timeout: boolean,
					): { data: { wavFile?: string; encryptionKnown?: boolean } } | null
				}
				d.callState = {
					callId: "c",
					protocol: "dmr",
					talkgroup: 100,
					source: 200,
					startTime: start,
					lastUpdate: start,
					dmr: { cc: 1 },
					quality: { crcErrs: 0, fecErrs: 0 },
					flags: {},
					...(known === undefined ? {} : { encryptionKnown: known }),
				}
				return d.endCall(new Date(start.getTime() + 5000), false)?.data
			}
			expect(end(false)?.wavFile).toBeUndefined()
			expect(end(false)?.encryptionKnown).toBe(false)
			expect(end(true)?.wavFile).toContain(root)
			expect(end(undefined)?.wavFile).toContain(root)
		} finally {
			fs.rmSync(root, { recursive: true })
		}
	})
})

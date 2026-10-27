/**
 * dsd-fme link-control lines for the scanner (spec § 6.4) and the CRC-ERR
 * identity/encryption fix: garbage lines on key-up (run8) must not start a
 * call, set its talkgroup, or mark a clear call encrypted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import pino from "pino"
import {
	DsdFmeDecoder,
	dsdFmeUdpChannels,
} from "../../../src/decoders/builtin/dsd-fme.js"
import type { DsdFmeLinkLine } from "../../../src/decoders/builtin/dsd-fme-link.js"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })
const T0 = Date.parse("2026-10-09T20:12:54.000Z")

type Internals = {
	handleOutputLine(line: string): void
	checkCallTimeoutAsync(): void
	buildPipelineCommand(): string
	schedulePrune(delayMs: number): void
}

function createDecoder(options: Record<string, unknown> = {}): DsdFmeDecoder {
	const config: DecoderConfig = {
		id: "dsd-fme",
		type: "dsd-fme",
		enabled: true,
		options: { mode: "auto", ...options },
	}
	return new DsdFmeDecoder(config, logger)
}

function replay(
	decoder: DsdFmeDecoder,
	lines: Array<{ atMs: number; text: string }>,
	untilMs: number,
) {
	const outputs: DecoderOutput[] = []
	const links: DsdFmeLinkLine[] = []
	decoder.on("output", (output: DecoderOutput) => outputs.push(output))
	decoder.on("link", (line: DsdFmeLinkLine) => links.push(line))
	const internals = decoder as unknown as Internals
	let index = 0
	for (let now = 0; now <= untilMs; now += 10) {
		while (index < lines.length && lines[index]!.atMs <= now) {
			vi.setSystemTime(T0 + lines[index]!.atMs)
			internals.handleOutputLine(lines[index]!.text)
			index++
		}
		vi.setSystemTime(T0 + now)
		if (now % 500 === 0) internals.checkCallTimeoutAsync()
	}
	return { outputs, links }
}

const starts = (outputs: DecoderOutput[]) =>
	outputs
		.filter(o => o.type === "call_start")
		.map(
			o =>
				o.data as {
					talkgroup: number | null
					source: number | null
					encrypted?: boolean
					flags?: { wavFileUpdate?: boolean }
				},
		)
		.filter(d => !d.flags?.wavFileUpdate)
const ends = (outputs: DecoderOutput[]) =>
	outputs
		.filter(o => o.type === "call_end")
		// call_end carries encryption only under data.flags (dsd-fme.ts endCall); call_start also has a top-level copy
		.map(
			o =>
				o.data as {
					talkgroup: number | null
					flags?: { encrypted?: boolean; wavFileUpdate?: boolean }
				},
		)
		.filter(d => !d.flags?.wavFileUpdate)

const SYNC = (cc: string, burst: string) =>
	`20:12:54 Sync: +DMR MS/DM MODE/MONO | Color Code=${cc} | ${burst} `
const CLEAN = " SLOT 1 TGT=9 SRC=2060945 Group Call "

/** run8 key-up garbage, then the clean call; `headerAtMs` is when the clean header arrives. */
function keyUp(headerAtMs: number) {
	const lines = [
		{ atMs: 0, text: SYNC("XX", "MBCC (FEC ERR)") },
		{ atMs: 30, text: SYNC("05", "VLC") },
		{
			atMs: 60,
			text: "SLOT 1 TGT=11 SRC=10101393 Group Encrypted Call   (CRC ERR) ",
		},
		{ atMs: headerAtMs, text: SYNC("01", "VLC") },
		{ atMs: headerAtMs, text: CLEAN },
	]
	for (let t = headerAtMs + 360; t < headerAtMs + 3000; t += 360) {
		lines.push({ atMs: t, text: SYNC("01", "VC*") }, { atMs: t, text: CLEAN })
	}
	lines.push(
		{ atMs: headerAtMs + 3100, text: SYNC("01", "TLC") },
		{ atMs: headerAtMs + 3100, text: CLEAN },
	)
	return lines
}

describe("CRC-ERR lines never set call identity or encryption", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it.each([130, 400])(
		"run8 key-up garbage with the clean header at %i ms yields one clear call TG 9",
		headerAtMs => {
			const { outputs } = replay(
				createDecoder(),
				keyUp(headerAtMs),
				headerAtMs + 4000,
			)
			const s = starts(outputs)
			expect(s).toHaveLength(1)
			expect(s[0]).toMatchObject({ talkgroup: 9, source: 2060945 })
			expect(s[0]?.encrypted ?? false).toBe(false)
			expect(ends(outputs).every(e => e.flags?.encrypted !== true)).toBe(true)
		},
	)

	it("a timeout tick between the CRC-ERR line and the clean header does not publish the garbage call", () => {
		// Shifted by 200 ms so the 500 ms tick lands after the garbage call's start delay but before the header at 600 ms
		const lines = keyUp(400).map(l => ({ ...l, atMs: l.atMs + 200 }))
		const { outputs } = replay(createDecoder(), lines, 4600)
		const s = starts(outputs)
		expect(s).toHaveLength(1)
		expect(s[0]).toMatchObject({ talkgroup: 9, source: 2060945 })
		expect(s[0]?.encrypted ?? false).toBe(false)
	})

	it("a corrupted encrypted line inside a clear call neither marks it encrypted nor splits it", () => {
		const lines = keyUp(130)
		lines.push(
			{
				atMs: 1500,
				text: "SLOT 1 TGT=9 SRC=2060945 Group Encrypted Call   (CRC ERR) ",
			},
			{
				atMs: 1600,
				text: "SLOT 1 TGT=4711 SRC=99 Group Encrypted Call   (CRC ERR) ",
			},
		)
		lines.sort((a, b) => a.atMs - b.atMs)
		const { outputs } = replay(createDecoder(), lines, 5000)
		expect(starts(outputs)).toHaveLength(1)
		const e = ends(outputs)
		expect(e).toHaveLength(1)
		expect(e[0]?.flags?.encrypted ?? false).toBe(false)
	})

	it("a clean encrypted line still marks the call encrypted", () => {
		const lines = keyUp(130)
		lines.push({
			atMs: 1500,
			text: " SLOT 1 TGT=9 SRC=2060945 Group Encrypted Call ",
		})
		lines.sort((a, b) => a.atMs - b.atMs)
		const { outputs } = replay(createDecoder(), lines, 5000)
		expect(ends(outputs)[0]?.flags?.encrypted).toBe(true)
	})
})

describe("link events (spec § 6.4)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("defers DMR headers until burst completion and flags CRC errors", () => {
		const { links } = replay(createDecoder(), keyUp(130).slice(0, 5), 200)
		expect(links.map(({ at: _at, ...rest }) => rest)).toEqual([
			{ protocol: "dmr", crcErr: false, fecErrs: 1, verified: false },
			{ protocol: "dmr", cc: 5, crcErr: false, verified: false },
			{
				protocol: "dmr",
				tg: "11",
				src: "10101393",
				slot: 1,
				crcErr: true,
				verified: false,
				encrypted: true,
			},
		])
		expect(links.every(l => l.at >= T0 && l.at <= T0 + 200)).toBe(true)
		expect(links.some(l => l.voiceLc)).toBe(false)
		const closed = replay(
			createDecoder(),
			[...keyUp(130).slice(0, 5), { atMs: 193.7, text: SYNC("01", "IDLE") }],
			200,
		)
		expect(
			closed.links.filter(l => l.voiceLc).map(({ at: _at, ...rest }) => rest),
		).toEqual([
			{
				protocol: "dmr",
				// The MS header is still pending, so checked LC has no CC yet.
				tg: "9",
				src: "2060945",
				slot: 1,
				crcErr: false,
				verified: true,
				voiceLc: true,
			},
		])
	})

	it("publishes call metadata while voice LC verification awaits the next sync", () => {
		const { outputs, links } = replay(
			createDecoder(),
			[
				{ atMs: 3.7, text: SYNC("05", "VLC") },
				{ atMs: 31.3, text: " SLOT 1 TGT=9 SRC=123 Group Encrypted" },
				{ atMs: 61.9, text: " Key: 0000000000000000 0000000000000000" },
			],
			510,
		)
		expect(links).toEqual([])
		expect(starts(outputs)).toMatchObject([
			{ talkgroup: 9, source: 123, encrypted: true },
		])
		expect(ends(outputs)).toEqual([])
	})

	it("normalises zero-padded DMR voice event ids", () => {
		const { links } = replay(
			createDecoder(),
			[
				{ atMs: 0, text: SYNC("01", "VLC") },
				{ atMs: 10, text: "DMR Voice TGT: 00009001; SRC: 00001133; slot2" },
			],
			50,
		)
		expect(links[0]).toMatchObject({
			protocol: "dmr",
			tg: "9001",
			src: "1133",
			slot: 2,
			crcErr: false,
		})
	})

	it("emits P25 NAC/TG/SRC, NXDN RAN and D-STAR callsign lines", () => {
		const { links } = replay(
			createDecoder(),
			[
				{ atMs: 0, text: "Sync: +P25p1 " },
				{ atMs: 10, text: " nac: [ 1B] src: [   1234] tg: [  56] " },
				{ atMs: 20, text: "Sync: +NXDN96 " },
				{ atMs: 30, text: " VOICE RAN=50 TGT=7 SRC=8 " },
				{ atMs: 40, text: "Sync: +DSTAR " },
				{ atMs: 50, text: " MY: DL1ABC UR: CQCQCQ RPT1: DB0XYZ B " },
			],
			100,
		)
		expect(links.map(({ at: _at, ...rest }) => rest)).toEqual([
			{
				protocol: "p25",
				nac: "1B",
				tg: "56",
				src: "1234",
				crcErr: false,
				verified: false,
			},
			{
				protocol: "nxdn",
				ran: 50,
				tg: "7",
				src: "8",
				crcErr: false,
				verified: false,
			},
			{ protocol: "dstar", callsign: "DL1ABC", crcErr: false, verified: false },
		])
	})
})

describe("modes and recording retention", () => {
	it("nxdn48 runs -fi, dpmr runs -fm, nxdn stays -fn; all are mono voice", () => {
		const args = (mode: string) =>
			(createDecoder({ mode }) as unknown as Internals).buildPipelineCommand()
		expect(args("nxdn48")).toMatch(/(^|\s)-fi(\s|$)/)
		expect(args("dpmr")).toMatch(/(^|\s)-fm(\s|$)/)
		expect(args("nxdn")).toMatch(/(^|\s)-fn(\s|$)/)
		expect(dsdFmeUdpChannels("nxdn48")).toBe(1)
		expect(dsdFmeUdpChannels("dpmr")).toBe(1)
	})

	describe("perCallRecordingPrune", () => {
		let dir: string
		const expired = "20261009_133838_10001_DMR_CC_1_GROUP_TGT_9_SRC_1.wav"
		beforeEach(() => {
			dir = fs.mkdtempSync(path.join(os.tmpdir(), "wavekit-dsd-prune-"))
			const file = path.join(dir, expired)
			fs.writeFileSync(file, Buffer.alloc(1024))
			const old = (Date.now() - 10 * 3_600_000) / 1000
			fs.utimesSync(file, old, old)
		})
		afterEach(() => {
			fs.rmSync(dir, { recursive: true, force: true })
		})
		const options = (extra: Record<string, unknown>) => ({
			enablePerCallRecording: true,
			perCallRecordingDir: dir,
			perCallRecordingMaxAgeHours: 1,
			...extra,
		})

		it("prunes by default", async () => {
			;(createDecoder(options({})) as unknown as Internals).schedulePrune(0)
			await vi.waitFor(() =>
				expect(fs.existsSync(path.join(dir, expired))).toBe(false),
			)
		})

		it("keeps every file when disabled (scanner probe recordings)", async () => {
			;(
				createDecoder(
					options({ perCallRecordingPrune: false }),
				) as unknown as Internals
			).schedulePrune(0)
			await new Promise(resolve => setTimeout(resolve, 100))
			expect(fs.existsSync(path.join(dir, expired))).toBe(true)
		})
	})
})

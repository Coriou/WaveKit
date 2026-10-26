/**
 * dsd-fme call segmentation, output counters and pipeline.
 *
 * Over the air (2026-10-09) two ~10 s PTT presses produced three calls, every
 * call_end had timeout: true, and stats.eventsOut / lastOutputAt never moved.
 */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import pino from "pino"
import {
	DsdFmeDecoder,
	type DsdFmeVoiceCallState,
} from "../../../src/decoders/builtin/dsd-fme.js"
import { MultimonDecoder } from "../../../src/decoders/builtin/multimon-ng.js"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })
const T0 = Date.parse("2026-10-09T12:13:33.000Z")

const FIXTURE = readFileSync(
	fileURLToPath(
		new URL("../../mocks/fixtures/dsd-fme/dmr-ms-two-ptt.txt", import.meta.url),
	),
	"utf8",
)
	.split("\n")
	.filter(line => line && !line.startsWith("#"))
	.map(line => {
		const tab = line.indexOf("\t")
		return { atMs: Number(line.slice(0, tab)), text: line.slice(tab + 1) }
	})

type Internals = {
	handleOutputLine(line: string): void
	checkCallTimeoutAsync(): void
	buildPipelineCommand(): string
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

/** Replays timed lines, running the 500 ms timeout checker as time passes. */
function replay(
	decoder: DsdFmeDecoder,
	lines: Array<{ atMs: number; text: string }>,
	untilMs: number,
): DecoderOutput[] {
	const outputs: DecoderOutput[] = []
	decoder.on("output", (output: DecoderOutput) => outputs.push(output))
	const internals = decoder as unknown as Internals
	let index = 0
	for (let now = 0; now <= untilMs; now += 100) {
		while (index < lines.length && lines[index]!.atMs <= now) {
			vi.setSystemTime(T0 + lines[index]!.atMs)
			internals.handleOutputLine(lines[index]!.text)
			index++
		}
		vi.setSystemTime(T0 + now)
		if (now % 500 === 0) internals.checkCallTimeoutAsync()
	}
	return outputs
}

function calls(outputs: DecoderOutput[], type: "call_start" | "call_end") {
	return outputs.filter(
		output =>
			output.type === type &&
			!(output.data as { flags?: { wavFileUpdate?: boolean } }).flags
				?.wavFileUpdate,
	)
}

describe("dsd-fme call segmentation", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("does not split an active call on a short no-sync gap", () => {
		const decoder = createDecoder()
		const outputs = replay(
			decoder,
			[
				{ atMs: 3.7, text: "Sync: +DMR MS/DM MODE/MONO | Color Code=05 | VC*" },
				{ atMs: 31.3, text: " SLOT 1 TGT=9 SRC=123 Group Call " },
				{ atMs: 433.7, text: "Sync: no sync" },
				{
					atMs: 697.1,
					text: "Sync: +DMR MS/DM MODE/MONO | Color Code=05 | VC1",
				},
				{ atMs: 731.3, text: " SLOT 1 TGT=9 SRC=123 Group Call " },
				{
					atMs: 1093.7,
					text: "Sync: +DMR MS/DM MODE/MONO | Color Code=05 | TLC",
				},
			],
			4000,
		)
		expect(calls(outputs, "call_start")).toHaveLength(1)
		expect(calls(outputs, "call_end")).toHaveLength(1)
		expect(
			(calls(outputs, "call_end")[0]!.data as { duration: number }).duration,
		).toBeGreaterThan(600)
	})

	it("reports one call per PTT press, ended by the DMR terminator (TLC)", () => {
		const decoder = createDecoder()
		const outputs = replay(decoder, FIXTURE, 30_000)
		const starts = calls(outputs, "call_start")
		const ends = calls(outputs, "call_end")
		expect(starts).toHaveLength(2)
		expect(ends).toHaveLength(2)
		for (const end of ends) {
			const data = end.data as {
				talkgroup: number
				source: number
				slot: number
				flags: { timeout: boolean }
			}
			expect(data.flags.timeout).toBe(false)
			expect(data).toMatchObject({ talkgroup: 9, source: 2060945, slot: 1 })
		}
		const durations = ends.map(
			end => (end.data as { duration: number }).duration,
		)
		expect(durations[0]).toBeCloseTo(10_100, -2)
		expect(durations[1]).toBeCloseTo(8300, -2)
	})

	it("does not start a phantom call from the terminator's trailing link control", () => {
		const decoder = createDecoder()
		const firstPtt = FIXTURE.filter(line => line.atMs <= 10_100)
		const outputs = replay(decoder, firstPtt, 20_000)
		expect(calls(outputs, "call_start")).toHaveLength(1)
		expect(calls(outputs, "call_end")).toHaveLength(1)
		expect(
			(decoder as unknown as { pendingCall: unknown }).pendingCall,
		).toBeNull()
	})

	it("falls back to a timeout when the terminator is missed, without inflating the duration", () => {
		const decoder = createDecoder()
		const withoutTerminator = FIXTURE.filter(
			line => line.atMs < 10_000 && !line.text.includes("| TLC"),
		)
		const outputs = replay(decoder, withoutTerminator, 20_000)
		const ends = calls(outputs, "call_end")
		expect(ends).toHaveLength(1)
		const data = ends[0]!.data as {
			duration: number
			flags: { timeout: boolean }
		}
		expect(data.flags.timeout).toBe(true)
		// Last activity was the embedded LC at ~9.7 s, not the detection time.
		expect(data.duration).toBeLessThan(10_000)
		expect(data.duration).toBeGreaterThan(9_000)
		// The end is reported once the fallback timeout passes, not 2 s after.
		expect(ends[0]!.timestamp.getTime() - T0).toBeGreaterThan(9_700 + 3_000)
	})

	it("starts a new call when the same radio re-keys 1 s after its terminator", () => {
		const decoder = createDecoder()
		const ptt = (atMs: number) => [
			{
				atMs,
				text: "12:13:33 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VLC ",
			},
			{ atMs, text: " SLOT 1 TGT=9 SRC=2060945 Group Call " },
		]
		const lines = [
			...ptt(0),
			{
				atMs: 2000,
				text: "12:13:35 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | TLC ",
			},
			// The terminator's link control failed FEC, so no trailer line
			// consumes the suppression window before the radio re-keys.
			...ptt(3000),
			{
				atMs: 5000,
				text: "12:13:38 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | TLC ",
			},
			{ atMs: 5000, text: " SLOT 1 TGT=9 SRC=2060945 Group Call " },
		]
		const outputs = replay(decoder, lines, 8000)
		expect(calls(outputs, "call_start")).toHaveLength(2)
		expect(calls(outputs, "call_end")).toHaveLength(2)
	})

	it("ignores the other slot's terminator in BS (repeater) mode", () => {
		const decoder = createDecoder()
		const lines = [
			{
				atMs: 0,
				text: "12:13:33 Sync: +DMR  [slot1]  slot2  | Color Code=01 | VLC ",
			},
			{ atMs: 0, text: " SLOT 1 TGT=9 SRC=100 Group Call " },
			{
				atMs: 1000,
				text: "12:13:34 Sync: +DMR   slot1  [slot2] | Color Code=01 | TLC ",
			},
			{
				atMs: 2000,
				text: "12:13:35 Sync: +DMR  [slot1]  slot2  | Color Code=01 | TLC ",
			},
		]
		const outputs = replay(decoder, lines, 1500)
		expect(calls(outputs, "call_end")).toHaveLength(0)
		const ended = replay(decoder, lines.slice(3), 2500)
		expect(calls(ended, "call_end")).toHaveLength(1)
		expect(
			(calls(ended, "call_end")[0]!.data as { flags: { timeout: boolean } })
				.flags.timeout,
		).toBe(false)
	})

	it("honours a configured callTimeoutMs", () => {
		const decoder = createDecoder({ callTimeoutMs: 1500 })
		const outputs = replay(decoder, FIXTURE, 30_000)
		// The 2.5 s sync hole in PTT 1 now splits it.
		expect(calls(outputs, "call_start")).toHaveLength(3)
	})

	it("keeps processing the line that revealed a timeout", () => {
		const decoder = createDecoder()
		const outputs: DecoderOutput[] = []
		decoder.on("output", (output: DecoderOutput) => outputs.push(output))
		const internals = decoder as unknown as Internals
		internals.handleOutputLine(
			"Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VLC ",
		)
		internals.handleOutputLine(" SLOT 1 TGT=9 SRC=100 Group Call ")
		vi.setSystemTime(T0 + 200)
		internals.checkCallTimeoutAsync()
		// 10 s of silence, then a different call: one line ends the old call
		// and starts the new one.
		vi.setSystemTime(T0 + 10_200)
		internals.handleOutputLine(" SLOT 1 TGT=9 SRC=200 Group Call ")
		expect(calls(outputs, "call_end")).toHaveLength(1)
		expect(
			(decoder as unknown as { pendingCall: { state: { source: number } } })
				.pendingCall.state.source,
		).toBe(200)
	})
})

describe("dsd-fme output counters", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("counts timer-driven call events in stats.eventsOut and lastOutputAt", () => {
		const decoder = createDecoder()
		replay(decoder, FIXTURE, 30_000)
		const status = decoder.getStatus()
		expect(status.stats.eventsOut).toBe(4)
		expect(status.lastOutputAt).toBeInstanceOf(Date)
	})
})

describe("dsd-fme pipeline", () => {
	it("uses a channel-matched decimation filter", () => {
		const pipeline = (
			createDecoder({ inputSampleRate: 2_048_000 }) as unknown as Internals
		).buildPipelineCommand()
		expect(pipeline).toContain(
			"csdr convert -i char -o float | csdr firdecimate 43 0.003052 --cutoff 0.1968 | csdr fmdemod",
		)
		expect(pipeline).not.toContain("0.05")
	})

	// Over the air (run 8/9, 2026-10-09): DMR MS bursts are 30 ms on, 30 ms
	// off, and between bursts the discriminator sits on the receiver's DC
	// spike (-offsetHz). csdr dcblock (tau ~10 ms) turned each burst's step
	// into a transient of ~2.4x the 4FSK decision half-spacing over its
	// first 10 ms: ~20 % of decoded voice muted. dsd-fme tracks levels itself.
	it("feeds dsd-fme the discriminator without a DC blocker", () => {
		const pipeline = (
			createDecoder({
				inputSampleRate: 2_048_000,
				offsetHz: 6000,
			}) as unknown as Internals
		).buildPipelineCommand()
		expect(pipeline).toContain(
			"csdr shift -0.0029296875 | csdr firdecimate 43 0.003052 --cutoff 0.1968 | csdr fmdemod | csdr gain 2 | csdr limit | csdr convert -i float -o s16 | sox -t raw -r 47627.90697674418 -e signed -b 16 -c 1 - -t wav -r 48000 - | dsd-fme -i /dev/stdin -fa",
		)
		expect(pipeline).not.toContain("dcblock")
	})

	it("matches the chain the real-binary regression script checks", () => {
		// scripts/dsd-fme-voice-ab.mjs feeds a recorded discriminator output
		// through BACK_CHAIN + the sox WAV wrapper into dsd-fme; it must test
		// exactly what the decoder runs after `csdr fmdemod`.
		const script = readFileSync(
			fileURLToPath(
				new URL("../../../scripts/dsd-fme-voice-ab.mjs", import.meta.url),
			),
			"utf8",
		)
		const backChain = /export const BACK_CHAIN = "([^"]+)"/.exec(script)?.[1]
		expect(backChain).toBeDefined()
		expect(script).toContain("export const DEMOD_RATE = 2048000 / 43")
		const pipeline = (
			createDecoder({ inputSampleRate: 2_048_000 }) as unknown as Internals
		).buildPipelineCommand()
		expect(pipeline).toContain(
			`csdr fmdemod | ${backChain} | csdr convert -i float -o s16 | sox -t raw -r ${2_048_000 / 43} -e signed -b 16 -c 1 - -t wav -r 48000 - | dsd-fme`,
		)
	})

	it("shifts an off-centre channel to DC when offsetHz is set", () => {
		const pipeline = (
			createDecoder({
				inputSampleRate: 2_048_000,
				offsetHz: 6000,
			}) as unknown as Internals
		).buildPipelineCommand()
		expect(pipeline).toContain(
			"csdr convert -i char -o float | csdr shift -0.0029296875 | csdr firdecimate 43 ",
		)
	})

	it("ignores a non-numeric offsetHz", () => {
		const pipeline = (
			createDecoder({ offsetHz: "6k" }) as unknown as Internals
		).buildPipelineCommand()
		expect(pipeline).not.toContain("csdr shift")
	})

	it("rejects an offset outside the capture", () => {
		const decoder = createDecoder({
			inputSampleRate: 2_048_000,
			offsetHz: 1_100_000,
		}) as unknown as Internals
		expect(() => decoder.buildPipelineCommand()).toThrow(/offsetHz/)
	})
})

describe("audio-demod decoders accept offsetHz", () => {
	it("adds the shift ahead of the explicit-transition firdecimate", () => {
		const decoder = new MultimonDecoder(
			{
				id: "pocsag",
				type: "multimon-ng",
				enabled: true,
				options: { inputSampleRate: 2_400_000, offsetHz: -12_500 },
			},
			logger,
		) as unknown as Internals
		const pipeline = decoder.buildPipelineCommand()
		expect(pipeline).toContain(
			"csdr convert -i char -o float | csdr shift 0.0052083333 | csdr agc -f complex -p slow -r 0.7 | csdr firdecimate 50 0.012 | csdr fmdemod",
		)
	})
})

describe("dsd-fme voice-call metadata", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	function replayVoice(
		lines: Array<{ atMs: number; text: string }>,
		untilMs: number,
		options: Record<string, unknown> = {},
	) {
		const decoder = createDecoder(options)
		const voice: DsdFmeVoiceCallState[] = []
		decoder.on("voice-call", (state: DsdFmeVoiceCallState) => {
			voice.push({ ...state })
		})
		const outputs = replay(decoder, lines, untilMs)
		return { outputs, voice }
	}

	it("publishes P25 nac, algorithm and key on the call_start voice state", () => {
		const { outputs, voice } = replayVoice(
			[
				{ atMs: 0, text: "Sync: +P25p1" },
				{ atMs: 0, text: "nac: [ 1b] src: [ 1234] tg: [ 56]" },
				{ atMs: 50, text: "ALG ID: 0x84" },
				{ atMs: 50, text: "KEY ID: 0xAB" },
			],
			500,
		)
		const start = outputs.find(output => output.type === "call_start")
		expect(start).toBeDefined()
		expect(start?.data).not.toHaveProperty("colourCode")
		expect(start?.data).not.toHaveProperty("algorithmId")
		expect(voice).toHaveLength(1)
		expect(voice[0]).toMatchObject({
			protocol: "p25p1",
			talkgroup: 56,
			source: 1234,
			encrypted: true,
			active: true,
			nac: "1B",
			algorithmId: "84",
			keyId: "AB",
			errors: { crc: 0, fec: 0 },
		})
		expect(voice[0]).not.toHaveProperty("colourCode")
		expect(voice[0]).not.toHaveProperty("ran")
	})

	it("omits a clear P25 algorithm and still publishes the key id", () => {
		const { voice } = replayVoice(
			[
				{ atMs: 0, text: "Sync: +P25p1" },
				{ atMs: 0, text: "src: [ 9] tg: [ 8]" },
				{ atMs: 50, text: "ALG ID: 0x80" },
				{ atMs: 50, text: "KEY ID: 0x0AB" },
			],
			500,
		)
		expect(voice[0]).toMatchObject({
			encrypted: false,
			keyId: "0AB",
			errors: { crc: 0, fec: 0 },
		})
		expect(voice[0]).not.toHaveProperty("algorithmId")
		expect(voice[0]).not.toHaveProperty("nac")
	})

	it("publishes a DMR colour code and the error counters, including zero and out of range", () => {
		const withErrors = replayVoice(
			[
				{
					atMs: 0,
					text: "Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VLC ",
				},
				{ atMs: 0, text: " SLOT 1 TGT=9 SRC=100 Group Call Color Code=7" },
				{ atMs: 200, text: "CRC ERR" },
				{ atMs: 200, text: "FEC ERR" },
			],
			500,
		)
		expect(withErrors.voice[0]).toMatchObject({
			protocol: "dmr",
			colourCode: 7,
			encrypted: false,
			errors: { crc: 1, fec: 1 },
		})
		expect(withErrors.voice[0]).not.toHaveProperty("nac")
		expect(withErrors.voice[0]).not.toHaveProperty("algorithmId")
		expect(withErrors.voice[0]).not.toHaveProperty("ran")

		const zero = replayVoice(
			[
				{ atMs: 0, text: "Sync: +DMR" },
				{ atMs: 0, text: " SLOT 1 TGT=1 SRC=2 Group Call Color Code=0" },
			],
			500,
		)
		expect(zero.voice[0]?.colourCode).toBe(0)
		expect(zero.voice[0]?.errors).toEqual({ crc: 0, fec: 0 })

		const wide = replayVoice(
			[
				{ atMs: 0, text: "Sync: +DMR" },
				{ atMs: 0, text: " SLOT 1 TGT=1 SRC=2 Group Call Color Code=99" },
			],
			500,
		)
		expect(wide.voice[0]?.colourCode).toBe(99)

		const absent = replayVoice(
			[
				{ atMs: 0, text: "Sync: +DMR" },
				{ atMs: 0, text: " SLOT 1 TGT=1 SRC=2 Group Call " },
			],
			500,
		)
		expect(absent.voice[0]).not.toHaveProperty("colourCode")
		expect(absent.voice[0]?.errors).toEqual({ crc: 0, fec: 0 })
	})

	it("publishes an NXDN RAN, including 0 and 99", () => {
		const ran = (value: number) =>
			replayVoice(
				[
					{ atMs: 0, text: "Sync: +NXDN96" },
					{ atMs: 0, text: `VOICE RAN=${value} TGT=7 SRC=8` },
				],
				500,
			).voice[0]
		expect(ran(12)).toMatchObject({
			protocol: "nxdn96",
			talkgroup: 7,
			source: 8,
			ran: 12,
			errors: { crc: 0, fec: 0 },
		})
		expect(ran(0)?.ran).toBe(0)
		expect(ran(99)?.ran).toBe(99)
		expect(ran(12)).not.toHaveProperty("colourCode")
	})

	it("keeps colour code and errors on a call_end and on a later encryption update", () => {
		const ended = replayVoice(
			[
				{ atMs: 0, text: "Sync: +DMR" },
				{ atMs: 0, text: " SLOT 1 TGT=9 SRC=100 Group Call Color Code=3" },
				{ atMs: 600, text: "FEC ERR" },
				{
					atMs: 1000,
					text: "Sync: +DMR MS/DM MODE/MONO | Color Code=01 | TLC",
				},
			],
			1000,
		)
		expect(ended.voice.map(state => state.active)).toEqual([true, false])
		expect(ended.voice[0]?.errors).toEqual({ crc: 0, fec: 0 })
		expect(ended.voice[1]).toMatchObject({
			active: false,
			colourCode: 3,
			errors: { crc: 0, fec: 1 },
		})

		const encrypted = replayVoice(
			[
				{ atMs: 0, text: "Sync: +DMR" },
				{ atMs: 0, text: " SLOT 1 TGT=4 SRC=5 Group Call Color Code=2" },
				{ atMs: 600, text: "ALG ID: 21" },
			],
			600,
		)
		expect(encrypted.voice.map(state => state.encrypted)).toEqual([false, true])
		expect(encrypted.voice[1]).toMatchObject({
			colourCode: 2,
			errors: { crc: 0, fec: 0 },
		})
		expect(encrypted.voice[1]).not.toHaveProperty("algorithmId")

		const p25 = replayVoice(
			[
				{ atMs: 0, text: "Sync: +P25p1" },
				{ atMs: 0, text: "nac: [ abcde] src: [ 10] tg: [ 20]" },
				{ atMs: 700, text: "ALG ID: 0x84" },
			],
			700,
		)
		expect(p25.voice[0]).toMatchObject({ encrypted: false, nac: "ABCDE" })
		expect(p25.voice[0]).not.toHaveProperty("algorithmId")
		expect(p25.voice[1]).toMatchObject({
			encrypted: true,
			nac: "ABCDE",
			algorithmId: "84",
			errors: { crc: 0, fec: 0 },
		})
	})
})

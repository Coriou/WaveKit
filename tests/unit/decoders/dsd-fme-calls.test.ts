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
import { DsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
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

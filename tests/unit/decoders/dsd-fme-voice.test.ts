/**
 * dsd-fme voice output: -o udp / -V / per-call WAV args, call ids and the
 * "voice-call" events the digital voice stream is built on, encryption flags
 * and per-call recording retention.
 */

import {
	mkdtempSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs"
import { readdirSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as fc from "fast-check"
import pino from "pino"
import {
	DsdFmeDecoder,
	dsdFmeUdpChannels,
	dsdFmeVoiceSlotArg,
	type DsdFmeVoiceCallState,
} from "../../../src/decoders/builtin/dsd-fme.js"
import { pruneCallRecordings } from "../../../src/decoders/builtin/call-recordings.js"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })
const T0 = Date.parse("2026-10-09T12:13:33.000Z")

type Internals = {
	handleOutputLine(line: string): void
	checkCallTimeoutAsync(): void
	getDecoderArgs(): string[]
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

function args(options: Record<string, unknown>): string[] {
	return (createDecoder(options) as unknown as Internals).getDecoderArgs()
}

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

function replay(
	decoder: DsdFmeDecoder,
	lines: Array<{ atMs: number; text: string }>,
	untilMs: number,
): { outputs: DecoderOutput[]; voice: DsdFmeVoiceCallState[] } {
	const outputs: DecoderOutput[] = []
	const voice: DsdFmeVoiceCallState[] = []
	decoder.on("output", (output: DecoderOutput) => outputs.push(output))
	decoder.on("voice-call", (state: DsdFmeVoiceCallState) => voice.push(state))
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
	return { outputs, voice }
}

describe("dsd-fme voice output arguments", () => {
	it("streams voice with -o udp:<host>:<port>", () => {
		const out = args({ output: "udp", udpHost: "127.0.0.1", udpPort: 40123 })
		expect(out).toContain("udp:127.0.0.1:40123")
		expect(out[out.indexOf("udp:127.0.0.1:40123") - 1]).toBe("-o")
		expect(out).not.toContain("null")
	})

	it("falls back to -o null (never PulseAudio) when udp has no port", () => {
		const out = args({ output: "udp" })
		expect(out[out.indexOf("-o") + 1]).toBe("null")
	})

	it("keeps -o null by default and adds no -V unless voiceSlot is set", () => {
		const out = args({})
		expect(out[out.indexOf("-o") + 1]).toBe("null")
		expect(out).not.toContain("-V")
	})

	it.each([
		[1, "1"],
		[2, "2"],
		["both", "3"],
		["1", "1"],
	] as const)("maps voiceSlot %s to -V %s", (slot, expected) => {
		const out = args({ voiceSlot: slot })
		expect(out[out.indexOf("-V") + 1]).toBe(expected)
		expect(dsdFmeVoiceSlotArg(slot === "1" ? 1 : slot)).toBe(expected)
	})

	it("resolves a relative recording dir once, so cd + -7 cannot nest it", () => {
		const decoder = createDecoder({
			enablePerCallRecording: true,
			perCallRecordingDir: "./decoded_calls",
		}) as unknown as Internals
		const absolute = path.resolve("./decoded_calls")
		const out = decoder.getDecoderArgs()
		expect(out[out.indexOf("-7") + 1]).toBe(absolute)
		const pipeline = decoder.buildPipelineCommand()
		expect(pipeline).toContain(`cd ${absolute} &&`)
		expect(pipeline).not.toContain("./decoded_calls")
	})

	it("drops extraArgs that would change the mode or the audio format", () => {
		const out = args({
			output: "udp",
			udpHost: "127.0.0.1",
			udpPort: 40000,
			extraArgs: [
				"-fy",
				"-o",
				"pulse",
				"-oudp:1.2.3.4:5",
				"-y",
				"-l",
				"-u",
				"4",
			],
		})
		expect(out.filter(a => a.startsWith("-f"))).toEqual(["-fa"])
		expect(out.filter(a => a === "-o")).toHaveLength(1)
		expect(out).not.toContain("pulse")
		expect(out).not.toContain("-y")
		expect(out.slice(-3)).toEqual(["-l", "-u", "4"])
	})

	it("ignores an invalid voiceSlot", () => {
		expect(args({ voiceSlot: 3 })).not.toContain("-V")
	})

	it("records per-call WAVs with -7 <dir> -P, never the single-file -w", () => {
		const out = args({
			output: "udp",
			udpHost: "127.0.0.1",
			udpPort: 40000,
			enablePerCallRecording: true,
			perCallRecordingDir: "/data/calls",
		})
		const at = out.indexOf("-7")
		expect(out.slice(at, at + 3)).toEqual(["-7", "/data/calls", "-P"])
		expect(out).not.toContain("-w")
		expect(out).toContain("udp:127.0.0.1:40000")
	})

	it('maps the legacy output "wav" to per-call files in wavDir with no live audio', () => {
		const out = args({ output: "wav", wavDir: "/data/wav" })
		const at = out.indexOf("-7")
		expect(out.slice(at, at + 3)).toEqual(["-7", "/data/wav", "-P"])
		expect(out[out.indexOf("-o") + 1]).toBe("null")
		expect(out).not.toContain("-w")
		expect(
			(
				createDecoder({
					output: "wav",
					wavDir: "/data/wav",
				}) as unknown as Internals
			).buildPipelineCommand(),
		).toContain("mkdir -p /data/wav")
	})

	it("sends stereo datagrams in auto and DMR modes, mono otherwise", () => {
		expect(dsdFmeUdpChannels("auto")).toBe(2)
		expect(dsdFmeUdpChannels("dmr")).toBe(2)
		for (const mode of ["p25", "ysf", "dstar", "nxdn", "provoice"] as const) {
			expect(dsdFmeUdpChannels(mode)).toBe(1)
		}
	})
})

describe("dsd-fme call ids and voice-call events", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("pairs call_start and call_end with one callId and a voice-call event each", () => {
		const { outputs, voice } = replay(createDecoder(), FIXTURE, 30_000)
		const starts = outputs.filter(o => o.type === "call_start")
		const ends = outputs.filter(o => o.type === "call_end")
		expect(starts).toHaveLength(2)
		const ids = starts.map(o => (o.data as { callId: string }).callId)
		expect(new Set(ids).size).toBe(2)
		expect(ends.map(o => (o.data as { callId: string }).callId)).toEqual(ids)

		expect(voice.map(v => [v.callId, v.active])).toEqual([
			[ids[0], true],
			[ids[0], false],
			[ids[1], true],
			[ids[1], false],
		])
		expect(voice[0]).toMatchObject({
			protocol: "dmr",
			talkgroup: 9,
			source: 2060945,
			slot: 1,
			encrypted: false,
		})
	})

	it("reports duration == endedAt - startedAt, also for a timeout end", () => {
		// The 2026-10-09 run5 "short duration" was a timeout end: duration runs
		// to the call's last line, the event is published callTimeoutMs later.
		const withoutTerminator = FIXTURE.filter(
			line => line.atMs < 10_000 && !line.text.includes("| TLC"),
		)
		const { outputs } = replay(createDecoder(), withoutTerminator, 20_000)
		const end = outputs.find(o => o.type === "call_end")!
		const data = end.data as {
			duration: number
			startedAt: string
			endedAt: string
			flags: { timeout: boolean }
		}
		expect(data.flags.timeout).toBe(true)
		expect(Date.parse(data.endedAt) - Date.parse(data.startedAt)).toBe(
			data.duration,
		)
		expect(end.timestamp.getTime() - Date.parse(data.endedAt)).toBeGreaterThan(
			4000,
		)
	})

	it("flags a DMR call encrypted from its link control (call_start and voice-call)", () => {
		const lines = [
			{
				atMs: 0,
				text: "12:13:33 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VLC ",
			},
			{ atMs: 0, text: " SLOT 1 TGT=9 SRC=100 Group Call Encrypted " },
			{
				atMs: 2000,
				text: "12:13:35 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | TLC ",
			},
		]
		const { outputs, voice } = replay(createDecoder(), lines, 3000)
		const start = outputs.find(o => o.type === "call_start")!
		expect((start.data as { encrypted: boolean }).encrypted).toBe(true)
		const end = outputs.find(o => o.type === "call_end")!
		expect(
			(end.data as { flags: { encrypted: boolean } }).flags.encrypted,
		).toBe(true)
		expect(voice.every(v => v.encrypted)).toBe(true)
	})

	it("publishes a voice-call update when a running call turns out encrypted (SVC privacy bit)", () => {
		const lines = [
			{
				atMs: 0,
				text: "12:13:33 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VLC ",
			},
			{ atMs: 0, text: " SLOT 1 TGT=9 SRC=100 Group Call " },
			{
				atMs: 1000,
				text: " SLOT 1 TGT=9 SRC=100 Group Call FLCO=0x00 FID=0x00 SVC=0x40 ",
			},
		]
		const { voice } = replay(createDecoder(), lines, 1500)
		expect(voice.map(v => [v.active, v.encrypted])).toEqual([
			[true, false],
			[true, true],
		])
		expect(voice[0]!.callId).toBe(voice[1]!.callId)
	})

	it("flags a DMR call encrypted from the PI header ALG ID, printed without 0x", () => {
		const lines = [
			{
				atMs: 0,
				text: "12:13:33 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VLC ",
			},
			{ atMs: 0, text: " SLOT 1 TGT=9 SRC=100 Group Call " },
			{
				atMs: 1000,
				text: " Slot 1 DMR PI H- ALG ID: 21; KEY ID: 01; MI(32): 12345678;",
			},
		]
		const { voice } = replay(createDecoder(), lines, 1500)
		expect(voice.map(v => v.encrypted)).toEqual([false, true])
	})

	it("does not take an encrypted data PDU for an encrypted voice call", () => {
		const lines = [
			{
				atMs: 0,
				text: "12:13:33 Sync: +DMR MS/DM MODE/MONO | Color Code=01 | VLC ",
			},
			{ atMs: 0, text: " SLOT 1 TGT=9 SRC=100 Group Call " },
			{ atMs: 500, text: " Slot 1 - Encrypted PDU;" },
		]
		const { voice } = replay(createDecoder(), lines, 1500)
		expect(voice.map(v => v.encrypted)).toEqual([false])
	})

	it("treats P25 ALG ID 0x80 as clear and other algorithms as encrypted", () => {
		const clear = replay(
			createDecoder({ mode: "p25" }),
			[
				{ atMs: 0, text: "Sync: +P25p1 LDU1 src: [ 100] tg: [ 200]" },
				{ atMs: 200, text: "Sync: +P25p1 ALG ID: 0x80 KEY ID: 0x0000 MI: 0" },
			],
			1000,
		)
		expect(clear.voice[0]?.encrypted).toBe(false)
		expect(clear.voice).toHaveLength(1)

		vi.setSystemTime(T0)
		const enc = replay(
			createDecoder({ mode: "p25" }),
			[
				{ atMs: 0, text: "Sync: +P25p1 LDU1 src: [ 100] tg: [ 200]" },
				{ atMs: 50, text: "Sync: +P25p1 ALG ID: 0x84 KEY ID: 0x0001" },
			],
			1000,
		)
		expect(enc.voice[0]?.encrypted).toBe(true)
	})
})

describe("per-call recording retention", () => {
	let dir: string
	beforeEach(() => {
		dir = mkdtempSync(path.join(tmpdir(), "wavekit-calls-"))
	})
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true })
	})

	/** A dsd-fme per-call file name (dsd_file.c close_and_rename_wav_file). */
	function call(tag: number): string {
		return `20261009_133838_${String(10000 + tag)}_DMR_CC_1_GROUP_TGT_9_SRC_${tag}.wav`
	}

	function wav(name: string, bytes: number, ageMs: number, now: number): void {
		const file = path.join(dir, name)
		writeFileSync(file, Buffer.alloc(bytes))
		const t = (now - ageMs) / 1000
		utimesSync(file, t, t)
	}

	it("deletes expired files, then the oldest until the size limit fits", async () => {
		const now = Date.now()
		const mb = 1024 * 1024
		wav(call(1), mb, 10 * 3_600_000, now) // expired
		wav(call(2), mb, 3 * 60_000, now)
		wav(call(3), mb, 2 * 60_000, now)
		wav(call(4), mb, 60_000, now)
		writeFileSync(path.join(dir, "notes.txt"), "keep")
		const result = await pruneCallRecordings(
			[dir, path.join(dir, "WAV")],
			{ maxTotalMb: 2, maxAgeHours: 1 },
			now,
		)
		expect(result.deleted.map(f => path.basename(f)).sort()).toEqual([
			call(1),
			call(2),
		])
		expect(readdirSync(dir).sort()).toEqual([call(3), call(4), "notes.txt"])
		expect(result.keptBytes).toBe(2 * mb)
	})

	it("never touches WAV files dsd-fme did not name, however old or large", async () => {
		const now = Date.now()
		const mb = 1024 * 1024
		const foreign = [
			"a.wav",
			"recording.WAV",
			"20261009_133838_DMR.wav",
			"TEMP_notes.wav",
		]
		for (const name of foreign) wav(name, 2 * mb, 30 * 24 * 3_600_000, now)
		wav(call(1), mb, 30 * 24 * 3_600_000, now)
		wav("TEMP_20261009_133838_1A2B.wav", mb, 30 * 24 * 3_600_000, now)
		const result = await pruneCallRecordings(
			[dir],
			{ maxTotalMb: 1, maxAgeHours: 1 },
			now,
		)
		expect(result.deleted.map(f => path.basename(f)).sort()).toEqual([
			call(1),
			"TEMP_20261009_133838_1A2B.wav",
		])
		expect(readdirSync(dir).sort()).toEqual([...foreign].sort())
	})

	it("never deletes a recording dsd-fme may still be writing", async () => {
		const now = Date.now()
		wav(call(1), 3 * 1024 * 1024, 1000, now)
		const result = await pruneCallRecordings(
			[dir],
			{ maxTotalMb: 1, maxAgeHours: 1 },
			now,
		)
		expect(result.deleted).toEqual([])
		expect(statSync(path.join(dir, call(1))).size).toBe(3 * 1024 * 1024)
	})

	// Feature: digital-voice, Property 3: retention keeps the newest files within the limit
	// Validates: ROADMAP 5b explicit retention setting, prune oldest
	it("keeps a newest-first suffix of finished files that fits the size limit", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(fc.integer({ min: 1, max: 64 }), {
					minLength: 1,
					maxLength: 12,
				}),
				fc.integer({ min: 16, max: 256 }),
				async (sizesKb, limitKb) => {
					rmSync(dir, { recursive: true, force: true })
					dir = mkdtempSync(path.join(tmpdir(), "wavekit-calls-"))
					const now = Date.now()
					sizesKb.forEach((kb, i) =>
						wav(call(i), kb * 1024, (sizesKb.length - i) * 60_000, now),
					)
					const result = await pruneCallRecordings(
						[dir],
						{ maxTotalMb: limitKb / 1024, maxAgeHours: 24 },
						now,
					)
					const kept = readdirSync(dir)
						.map(name => Number(/_SRC_(\d+)\.wav$/.exec(name)![1]))
						.sort((a, b) => a - b)
					const total = kept.reduce((sum, i) => sum + sizesKb[i]! * 1024, 0)
					expect(total).toBeLessThanOrEqual(limitKb * 1024)
					expect(result.keptBytes).toBe(total)
					// Kept files are the newest ones (a suffix by age).
					if (kept.length > 0) {
						expect(kept).toEqual(
							Array.from(
								{ length: kept.length },
								(_, k) => sizesKb.length - kept.length + k,
							),
						)
					}
				},
			),
			{ numRuns: 100 },
		)
	}, 30_000) // 100 runs of real file I/O: slow on a loaded machine
})

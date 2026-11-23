/**
 * dsd-fme: elapsed time runs on the monotonic clock. A wall-clock step
 * mid-call (backward or forward) changes neither when a call is announced,
 * replaced or timed out; only the reported timestamps follow the wall.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import {
	DsdFmeDecoder,
	type DsdFmeClock,
} from "../../../src/decoders/builtin/dsd-fme.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import { LC, MS, type Line } from "./dsd-fme-call-first-helpers.js"
import { settleWavLookups } from "./dsd-fme-wav-settle.js"

type Internals = {
	handleOutputLine(line: string): void
	checkCallTimeoutAsync(): void
}

const T0 = Date.parse("2026-01-02T03:04:05.000Z")

/** A key-up: header + its LC, then voice syncs every 360 ms. */
function keyUp(fromMs: number, tg: number, src: number, syncs: number): Line[] {
	const lines: Line[] = [
		[fromMs, MS("VLC")],
		[fromMs, LC(1, tg, src)],
	]
	for (let i = 1; i <= syncs; i++) lines.push([fromMs + i * 360, MS("VC*")])
	return lines
}

// Over A, then over B re-keys with other IDs (a replacement), then silence:
// B ends on the call timeout.
const LINES: Line[] = [...keyUp(0, 9001, 91, 3), ...keyUp(1500, 9002, 92, 3)]

interface Seen {
	monoMs: number
	type: string
	talkgroup: number | null
	timestampMs: number
	startedAtMs: number | null
	endedAtMs: number | null
	wallAtEmit: number
	wavFile: string | undefined
}

/** Replays LINES on mono time; `stepAt(mono)` is the wall offset at that time. */
function run(
	stepAt: (monoMs: number) => number,
	options: Record<string, unknown> = {},
): Seen[] {
	return replayLines(stepAt, options).seen
}

/** run, with the adapter (to wait for its WAV lookups, whose updates fill `wavFile`). */
function replayLines(
	stepAt: (monoMs: number) => number,
	options: Record<string, unknown> = {},
): { seen: Seen[]; decoder: DsdFmeDecoder } {
	let mono = 0
	const clock: DsdFmeClock = {
		mono: () => mono,
		wall: () => T0 + mono + stepAt(mono),
	}
	const decoder = new DsdFmeDecoder(
		{
			id: "dsd-fme",
			type: "dsd-fme",
			enabled: true,
			options: { mode: "auto", ...options },
		},
		pino({ level: "silent" }),
		clock,
	)
	const seen: Seen[] = []
	decoder.on("output", (o: DecoderOutput) => {
		if (o.type !== "call_start" && o.type !== "call_end") return
		const data = o.data as {
			talkgroup: number | null
			startedAt?: string
			endedAt?: string
			flags?: { wavFileUpdate?: boolean }
			wavFile?: string
		}
		// A late file notice fills its call's end (the end itself never carries it).
		if (data.flags?.wavFileUpdate) {
			const end = seen.findLast(
				e => e.type === "call_end" && e.talkgroup === data.talkgroup,
			)
			if (end) end.wavFile = data.wavFile
			return
		}
		seen.push({
			monoMs: mono,
			type: o.type,
			talkgroup: data.talkgroup,
			timestampMs: o.timestamp.getTime(),
			startedAtMs: data.startedAt ? Date.parse(data.startedAt) : null,
			endedAtMs: data.endedAt ? Date.parse(data.endedAt) : null,
			wallAtEmit: clock.wall(),
			wavFile: data.wavFile,
		})
	})
	const internals = decoder as unknown as Internals
	let index = 0
	for (mono = 0; mono <= 9000; mono += 10) {
		while (index < LINES.length && LINES[index]![0] <= mono) {
			internals.handleOutputLine(LINES[index]![1])
			index++
		}
		if (mono % 500 === 0) internals.checkCallTimeoutAsync()
	}
	return { seen, decoder }
}

describe("dsd-fme monotonic clock", () => {
	const steady = run(() => 0)
	// The wall steps back one hour inside over A, then forward two hours
	// inside over B (mono advances steadily throughout).
	const stepOf = (monoMs: number) =>
		monoMs < 700 ? 0 : monoMs < 1900 ? -3_600_000 : 3_600_000
	const stepped = run(stepOf)

	it("announces, replaces and times out at the same monotonic times as with no step", () => {
		const shape = (s: Seen[]) =>
			s.map(({ monoMs, type, talkgroup }) => ({ monoMs, type, talkgroup }))
		expect(shape(steady).map(e => `${e.type}:${e.talkgroup}`)).toEqual([
			"call_start:9001",
			"call_end:9001",
			"call_start:9002",
			"call_end:9002",
		])
		expect(shape(stepped)).toEqual(shape(steady))
		// B ended on the timeout, at least the call timeout after its last line.
		expect(steady[3]!.monoMs - (1500 + 3 * 360)).toBeGreaterThanOrEqual(4000)
	})

	it("reports timestamps in wall time: each event's instant shifted by the wall offset at its emission", () => {
		for (const [i, event] of stepped.entries()) {
			const base = steady[i]!
			const offset = stepOf(event.monoMs)
			expect(event.timestampMs).toBe(event.wallAtEmit)
			expect(event.timestampMs).toBe(base.timestampMs + offset)
		}
		// startedAt is the wall time when the call was created, the same on its
		// call_start and call_end; endedAt is it plus the monotonic duration.
		for (const tg of [9001, 9002]) {
			const of = (s: Seen[], type: string) =>
				s.find(e => e.talkgroup === tg && e.type === type)!
			const start = of(stepped, "call_start")
			const end = of(stepped, "call_end")
			expect(end.startedAtMs).toBe(start.startedAtMs)
			const base = of(steady, "call_end")
			// A is created before the first step, B inside the backward one.
			const created = tg === 9001 ? 0 : -3_600_000
			expect(end.startedAtMs).toBe(base.startedAtMs! + created)
			expect(end.endedAtMs! - end.startedAtMs!).toBe(
				base.endedAtMs! - base.startedAtMs!,
			)
		}
	})

	it("a recording named by the call's start wall time still matches after a wall step of more than 5 s mid-call", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "wk-dsd-clock-"))
		try {
			const t = new Date(T0)
			const pad = (n: number) => String(n).padStart(2, "0")
			const name = `${t.getFullYear()}${pad(t.getMonth() + 1)}${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}_123_DMR_CC_1_GROUP_TGT_9001_SRC_91.wav`
			fs.writeFileSync(path.join(root, name), "")
			// This pins the file-name match only: admission (DMR recordings are off for now) is
			// pinned in dsd-fme-dmr-publication-sites.test.ts.
			vi.spyOn(
				DsdFmeDecoder.prototype as unknown as {
					recordingLinkable(): boolean
				},
				"recordingLinkable",
			).mockReturnValue(true)
			const options = {
				enablePerCallRecording: true,
				perCallRecordingDir: root,
			}
			const steadyRun = replayLines(() => 0, options)
			await settleWavLookups(steadyRun.decoder)
			const steadyEnd = steadyRun.seen.find(
				e => e.type === "call_end" && e.talkgroup === 9001,
			)
			expect(steadyEnd?.wavFile).toContain(name)
			// Over A's wall steps back 6 s, then forward 6 s, before its end.
			const step = (m: number) => (m < 300 ? 0 : m < 900 ? -6000 : 6000)
			const steppedRun = replayLines(step, options)
			await settleWavLookups(steppedRun.decoder)
			const steppedEnd = steppedRun.seen.find(
				e => e.type === "call_end" && e.talkgroup === 9001,
			)
			expect(steppedEnd?.wavFile).toContain(name)
		} finally {
			vi.restoreAllMocks()
			fs.rmSync(root, { recursive: true })
		}
	})
})

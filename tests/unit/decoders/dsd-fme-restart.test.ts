/**
 * dsd-fme: a crash restart calls start() again without stop(). Every call
 * still open ends then, once, through call_end flagged restart, and the old
 * call timer is cleared instead of orphaned.
 */
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type * as ChildProcess from "node:child_process"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import pino from "pino"
import {
	DsdFmeDecoder,
	type DsdFmeVoiceCallState,
} from "../../../src/decoders/builtin/dsd-fme.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import {
	TX_ID,
	TransmissionRegistry,
} from "../../../src/core/transmissions/index.js"
import {
	createDecoder,
	DATE_CLOCK,
	LC,
	T0,
} from "./dsd-fme-call-first-helpers.js"

vi.mock("node:child_process", async importOriginal => {
	const actual = await importOriginal<typeof ChildProcess>()
	return {
		...actual,
		spawn: vi.fn(() => {
			const proc = new EventEmitter() as EventEmitter & Record<string, unknown>
			proc["stdin"] = new PassThrough()
			proc["stdout"] = new PassThrough()
			proc["stderr"] = new PassThrough()
			proc["pid"] = 4242
			proc["kill"] = () => true
			proc["killed"] = false
			proc["exitCode"] = null
			proc["signalCode"] = null
			queueMicrotask(() => proc.emit("spawn"))
			return proc
		}),
	}
})

type Internals = {
	handleOutputLine(line: string): void
	process: unknown
	callTimeoutTimer: unknown
}

const BS = (burst: string) =>
	`00:00:01 Sync: +DMR  [SLOT1]  slot2  | Color Code=01 | ${burst} `

describe("dsd-fme crash restart", () => {
	beforeEach(() => {
		vi.useFakeTimers()
		vi.setSystemTime(T0)
	})
	afterEach(() => {
		vi.useRealTimers()
	})

	it("ends an open call exactly once with the restart flag, leaves no stray timer, and starts again", async () => {
		const decoder = createDecoder()
		const internals = decoder as unknown as Internals
		const outputs: DecoderOutput[] = []
		const voice: DsdFmeVoiceCallState[] = []
		decoder.on("output", (o: DecoderOutput) => outputs.push(o))
		decoder.on("voice-call", (v: DsdFmeVoiceCallState) => voice.push(v))
		// The base class logs the child's exit; its exit wiring is not under test.
		decoder.on("error", () => undefined)

		await decoder.start()
		const firstTimer = internals.callTimeoutTimer
		expect(firstTimer).not.toBeNull()
		const clear = vi.spyOn(globalThis, "clearInterval")
		const line = (atMs: number, text: string) => {
			vi.setSystemTime(T0 + atMs)
			internals.handleOutputLine(text)
		}
		line(0, BS("VLC"))
		line(0, LC(1, 9001, 91))
		line(60, BS("VC1"))
		vi.advanceTimersByTime(500)
		const ends = () =>
			outputs.filter(
				o =>
					o.type === "call_end" &&
					(o.data as { flags?: { wavFileUpdate?: boolean } }).flags
						?.wavFileUpdate !== true,
			)
		expect(outputs.filter(o => o.type === "call_start")).toHaveLength(1)
		expect(ends()).toHaveLength(0)

		// The child crashed: the manager starts again without stop().
		internals.process = null
		await decoder.start()
		expect(ends()).toHaveLength(1)
		expect(ends()[0]!.data).toMatchObject({
			talkgroup: 9001,
			flags: { restart: true },
		})
		expect(voice.at(-1)).toMatchObject({ active: false, endReason: "restart" })
		// The old call timer was cleared (not orphaned) and a new one runs.
		// (The base class's counter flush timer is not the adapter's.)
		expect(clear).toHaveBeenCalledWith(firstTimer)
		expect(internals.callTimeoutTimer).not.toBeNull()
		expect(internals.callTimeoutTimer).not.toBe(firstTimer)

		// Nothing more ends later, and the next start works: a new call.
		vi.advanceTimersByTime(10_000)
		expect(ends()).toHaveLength(1)
		line(20_000, BS("VLC"))
		line(20_000, LC(1, 9002, 92))
		line(20_060, BS("VC1"))
		vi.setSystemTime(T0 + 20_600)
		vi.advanceTimersByTime(500)
		const starts = outputs.filter(o => o.type === "call_start")
		expect(starts).toHaveLength(2)
		expect(starts[1]!.data).toMatchObject({ talkgroup: 9002 })
		expect(starts[1]!.data).not.toHaveProperty("flags.restart")

		internals.process = null
		await decoder.stop()
		expect(internals.callTimeoutTimer).toBeNull()
	})

	it("a call holding its call_end for a clean trailer is not proven clear by a crash restart", async () => {
		const decoder = createDecoder()
		const internals = decoder as unknown as Internals
		const outputs: DecoderOutput[] = []
		decoder.on("output", (o: DecoderOutput) => outputs.push(o))
		decoder.on("error", () => undefined)
		await decoder.start()
		const line = (atMs: number, text: string) => {
			vi.setSystemTime(T0 + atMs)
			internals.handleOutputLine(text)
		}
		// A call started on its frames, its LC dropped by a sync loss, then
		// its terminator and a clean trailer, and the child dies before the
		// lane's next sync closes that burst.
		let t = 0
		for (let s = 0; s < 2; s++)
			for (let n = 1; n <= 6; n++, t += 60) line(t, BS(`VC${n}`))
		line(t, LC(1, 9001, 91))
		line(t + 1, "00:00:01 Sync:  DMR  [SLOT1]  slot2  | Frame Sync Err: 7")
		line(
			t + 100,
			"00:00:01 Sync: +DMR  [slot1]  slot2  | Color Code=01 | TLC  ",
		)
		line(t + 100, LC(1, 9001, 91))
		internals.process = null
		await decoder.start()
		const ends = outputs.filter(o => o.type === "call_end")
		expect(ends).toHaveLength(1)
		expect(ends[0]!.data).toMatchObject({
			talkgroup: 9001,
			encryptionKnown: false,
			flags: { restart: true },
		})
		internals.process = null
		await decoder.stop()
	})
	it("a crash restart through start() closes the old run's transmission and the next call claims a fresh id; the old run's claims are refused", async () => {
		const registry = new TransmissionRegistry({ now: () => Date.now() })
		const decoder = new DsdFmeDecoder(
			{
				id: "dsd-fme",
				type: "dsd-fme",
				enabled: true,
				options: { mode: "auto" },
			},
			pino({ level: "silent" }),
			DATE_CLOCK,
			{ transmissions: registry },
		)
		const internals = decoder as unknown as Internals
		const outputs: DecoderOutput[] = []
		decoder.on("output", (o: DecoderOutput) => outputs.push(o))
		decoder.on("error", () => undefined)
		const line = (atMs: number, text: string) => {
			vi.setSystemTime(T0 + atMs)
			internals.handleOutputLine(text)
		}
		const txOf = (o: DecoderOutput | undefined) =>
			(o?.data as { txId?: string } | undefined)?.txId
		// The decoder's first run before any start() is dsd-fme#0; this start() begins dsd-fme#1.
		await decoder.start()
		line(0, BS("VLC"))
		line(0, LC(1, 9001, 91))
		line(60, BS("VC1"))
		vi.advanceTimersByTime(500)
		const first = txOf(outputs.find(o => o.type === "call_start"))
		expect(first).toMatch(TX_ID)
		expect(registry.get(first!)!.state).toBe("open")

		// The child crashed: start() again without stop() (dsd-fme#2).
		internals.process = null
		await decoder.start()
		const old = registry.get(first!)!
		expect(old.state).toBe("closed")
		expect(old.close).toBe("decoder-restart")
		expect(old.complete).toBe(false)
		const restartEnd = outputs.find(o => o.type === "call_end")
		expect(txOf(restartEnd)).toBe(first)

		// A late claim of the crashed run is refused and counted.
		const refusedBefore = registry.stats().retiredRun
		expect(
			registry.claim({
				origin: "dv-call",
				kind: "voice-digital",
				sourceId: null,
				dvKey: "dv:dsd-fme",
				lane: 1,
				run: "dsd-fme#1",
				atMs: Date.now(),
				alias: "call:dsd-fme:late",
			}),
		).toBeNull()
		expect(registry.stats().retiredRun).toBe(refusedBefore + 1)

		// The next call of the new run claims its own id.
		line(20_000, BS("VLC"))
		line(20_000, LC(1, 9002, 92))
		line(20_060, BS("VC1"))
		vi.setSystemTime(T0 + 20_600)
		vi.advanceTimersByTime(500)
		const starts = outputs.filter(o => o.type === "call_start")
		expect(starts).toHaveLength(2)
		const second = txOf(starts[1])
		expect(second).toMatch(TX_ID)
		expect(second).not.toBe(first)
		expect(registry.get(second!)!.state).toBe("open")

		internals.process = null
		await decoder.stop()
	})
})

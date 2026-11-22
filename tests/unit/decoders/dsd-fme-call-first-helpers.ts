/**
 * Shared replay helpers for the dsd-fme call-first suites: timed lines fed
 * to a decoder with a fake clock, the 500 ms call timer run as time passes.
 */
import pino from "pino"
import { vi } from "vitest"
import {
	DsdFmeDecoder,
	type DsdFmeClock,
	type DsdFmeVoiceCallState,
} from "../../../src/decoders/builtin/dsd-fme.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })
export const T0 = Date.parse("2026-01-02T03:04:05.000Z")

type Internals = {
	handleOutputLine(line: string): void
	checkCallTimeoutAsync(): void
}

export interface CallData {
	callId: string
	protocol?: string
	startedAt: string
	endedAt?: string
	talkgroup: number | null
	source: number | null
	slot?: number
	encrypted?: boolean
	encryptionKnown?: boolean
	ysf?: { callsign?: string }
	nxdn?: { ran?: number }
	flags?: { timeout?: boolean; encrypted?: boolean; wavFileUpdate?: boolean }
}

export type Line = [atMs: number, text: string]

/**
 * A clock whose monotonic and wall readings are both Date.now(), so a fake
 * Date (vi.setSystemTime) drives the adapter's elapsed time as before.
 */
export const DATE_CLOCK: DsdFmeClock = {
	mono: () => Date.now(),
	wall: () => Date.now(),
}

export function createDecoder(
	options: Record<string, unknown> = {},
): DsdFmeDecoder {
	return new DsdFmeDecoder(
		{
			id: "dsd-fme",
			type: "dsd-fme",
			enabled: true,
			options: { mode: "auto", ...options },
		},
		logger,
		DATE_CLOCK,
	)
}

/** Replays timed lines (10 ms steps), running the 500 ms call timer as time passes. */
export function replay(
	lines: Line[],
	untilMs: number,
	decoder = createDecoder(),
) {
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

export const at = (iso: string) => Date.parse(iso) - T0

export const MS = (burst: string, cc = "01") =>
	`03:04:05 Sync: +DMR MS/DM MODE/MONO | Color Code=${cc} | ${burst} `
export const LC = (slot: number, tg = 9, src = 100, extra = "") =>
	` SLOT ${slot} TGT=${tg} SRC=${src} Group Call ${extra}`

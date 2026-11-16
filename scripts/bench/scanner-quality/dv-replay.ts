/**
 * The dsd-fme adapter on timed decoder lines: feeds each line at its time on
 * a fake clock (Date and `new Date()` only; the adapter's call timer runs
 * every 500 ms as its own setInterval would) and returns the calls it
 * reported. The capture harness replays the lines live dsd-fme printed (their
 * arrival times); the truth scorecard replays recorded line timings
 * (tests/mocks/fixtures/synthetic/dv-latency-*.json). Either way the adapter's
 * call lifecycle is the production code's.
 */
import pino from "pino"
import { DsdFmeDecoder } from "../../../src/decoders/builtin/dsd-fme.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import type { DvCall, DvLine, DvOver } from "./dv-metrics.js"

/** The adapter's call timer period (dsd-fme.ts CALL_TIMEOUT_CHECK_INTERVAL_MS). */
export const DV_TIMER_MS = 500
/**
 * Idle after the last line: the 4 s call timeout plus one timer period, so
 * every call has ended (4 000 + 500 = 4 500 ms; 5 000 ms leaves a period over).
 */
export const DV_IDLE_MS = 5_000
/** The fake clock's origin (plan time 0). */
export const DV_T0 = Date.UTC(2026, 0, 2, 3, 4, 5)

/** The adapter mode each protocol is decoded in (its catalogue default). */
export const DV_MODES: Readonly<Record<string, string>> = {
	dmr: "auto",
	dstar: "auto",
	ysf: "auto",
	p25: "auto",
	nxdn48: "nxdn48",
	dpmr: "dpmr",
}

/** Runs `fn` with `Date.now()` and `new Date()` reading `clock.now`. */
function withFakeDate<T>(clock: { now: number }, fn: () => T): T {
	const RealDate = Date
	class FakeDate extends RealDate {
		constructor(...args: unknown[]) {
			if (args.length === 0) super(clock.now)
			else super(...(args as [string | number | Date]))
		}
		static override now(): number {
			return clock.now
		}
	}
	globalThis.Date = FakeDate as DateConstructor
	try {
		return fn()
	} finally {
		globalThis.Date = RealDate
	}
}

interface Internals {
	handleOutputLine(line: string): void
	checkCallTimeoutAsync(): void
}

type CallData = {
	callId?: string
	startedAt?: string
	endedAt?: string
	slot?: number | null
	talkgroup?: number | null
	source?: number | null
	wavFile?: string
	flags?: { timeout?: boolean; wavFileUpdate?: boolean }
}

/** Replays `lines` (sorted by atMs) through a fresh adapter in `mode`; its calls in start order. */
export function replayDvLines(
	lines: readonly DvLine[],
	mode: string,
	options: Record<string, unknown> = {},
): DvCall[] {
	const decoder = new DsdFmeDecoder(
		{
			id: "dsd-fme",
			type: "dsd-fme",
			enabled: true,
			options: { mode, ...options },
		},
		pino({ level: "silent" }),
	)
	const outputs: DecoderOutput[] = []
	decoder.on("output", (out: DecoderOutput) => outputs.push(out))
	const internals = decoder as unknown as Internals
	const clock = { now: DV_T0 }
	withFakeDate(clock, () => {
		let tick = DV_T0 + DV_TIMER_MS
		const advance = (to: number) => {
			for (; tick <= to; tick += DV_TIMER_MS) {
				clock.now = tick
				internals.checkCallTimeoutAsync()
			}
			clock.now = Math.max(clock.now, to)
		}
		let last = 0
		for (const line of lines) {
			last = Math.max(last, line.atMs)
			advance(DV_T0 + last)
			internals.handleOutputLine(line.text)
		}
		advance(DV_T0 + last + DV_IDLE_MS)
	})
	const byId = new Map<string, DvCall>()
	const order: string[] = []
	for (const out of outputs) {
		if (out.type !== "call_start" && out.type !== "call_end") continue
		const d = out.data as CallData
		if (d.flags?.wavFileUpdate) continue
		const id = d.callId ?? `${order.length}`
		const startedAtMs =
			d.startedAt === undefined
				? out.timestamp.getTime() - DV_T0
				: Date.parse(d.startedAt) - DV_T0
		if (!byId.has(id)) order.push(id)
		byId.set(id, {
			startedAtMs,
			endedAtMs:
				d.endedAt === undefined ? startedAtMs : Date.parse(d.endedAt) - DV_T0,
			slot: d.slot ?? null,
			talkgroup: d.talkgroup ?? null,
			source: d.source ?? null,
			wavFile: d.wavFile !== undefined,
			timeout: d.flags?.timeout ?? false,
		})
	}
	return order
		.map(id => byId.get(id)!)
		.sort((a, b) => a.startedAtMs - b.startedAtMs)
}

/** ANSI colour codes off, as the adapter's parser strips them. */
const plain = (line: string): string => line.replace(/\x1b\[[0-9;]*m/g, "")

/**
 * Whether a dsd-fme line prints a checked field of `over` (the margin
 * harness's per-protocol rule, dsd-fme-margin.test.ts, plus the over's slot
 * and identities where the line names them).
 */
export function checkedLine(line: string, over: DvOver): boolean {
	const text = plain(line)
	switch (over.protocol) {
		case "dmr": {
			const m = /SLOT (\d) TGT=(\d+) SRC=(\d+) (?!.*ERR)/.exec(text)
			if (m === null) return false
			if (over.slot !== null && Number(m[1]) !== over.slot) return false
			const tg = over.ids?.["talkgroup"]
			return tg === undefined || Number(m[2]) === tg
		}
		case "ysf":
			return /Sync: [+-]YSF .*\b(HC|CC|TC) FN: \d\/\d/.test(text)
		case "p25":
			return /Group Voice Channel User - Group \d+ Source \d+/.test(text)
		case "nxdn48":
			return /NXDN48 .*Voice .*RAN 05 PF [1-4]\/4/.test(text)
		case "dpmr":
			return / Channel Code=05/.test(text)
		case "dstar": {
			const my = over.ids?.["my"]
			return (
				/DSTAR VOICE .*SRC: /.test(text) &&
				(typeof my !== "string" || text.includes(`SRC: ${my}`))
			)
		}
		default:
			return false
	}
}

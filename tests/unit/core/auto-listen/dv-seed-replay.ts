/**
 * Replays the RECORDED dv-latency seeds (tests/mocks/fixtures/synthetic/dv-latency-*.json: dsd-fme's
 * lines with their arrival times) through the production dsd-fme adapter on a fake clock, its
 * 500 ms call timer at a chosen phase, and finds for each over the voice-call snapshots the
 * auto-listen router hears: the over's first voice sync line, its own call and the snapshot that
 * admits pending voice (active, not encrypted, encryption known).
 */
import { readFileSync } from "node:fs"
import type { VoiceTapCall } from "../../../../src/core/auto-listen/contract.js"
import { DsdFmeDecoder } from "../../../../src/decoders/builtin/dsd-fme.js"
import { createLogger } from "../../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
/** The fake clock's origin for the adapter (seed time 0). */
const T0 = Date.UTC(2026, 0, 2, 3, 4, 5)
/** The adapter's call timer period (CALL_TIMEOUT_CHECK_INTERVAL_MS, src/decoders/builtin/dsd-fme.ts). */
export const ADAPTER_TIMER_MS = 500
/** Idle after the last line: the adapter's 4 s call timeout plus a timer period, and more. */
const IDLE_MS = 5_000

/** Every recorded DMR scene (noise-sync has no over). */
export const DMR_SCENES = [
	"dmr-direct-gaps-other",
	"dmr-direct-gaps-same",
	"dmr-direct-late-entry",
	"dmr-direct-lengths",
	"dmr-direct-no-terminator",
	"dmr-direct-rekey-no-tlc",
	"dmr-repeater-gaps-other",
	"dmr-repeater-gaps-same",
	"dmr-repeater-hang-no-tlc",
	"dmr-repeater-late-entry",
	"dmr-repeater-lengths",
	"dmr-repeater-two-slots",
] as const

export interface Seed {
	overs: Array<{ index: number; slot: number; startMs: number; endMs: number }>
	lines: Array<{ atMs: number; text: string }>
}

export function loadSeed(scene: string): Seed {
	return JSON.parse(
		readFileSync(
			new URL(
				`../../../mocks/fixtures/synthetic/dv-latency-${scene}.json`,
				import.meta.url,
			),
			"utf8",
		),
	) as Seed
}

/** A call snapshot as the router gets it, `encryptionKnown` included when the adapter sets it. */
export type SeedCall = VoiceTapCall & { encryptionKnown?: boolean }

export interface CallEvent {
	atMs: number
	call: SeedCall
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

/**
 * The seed's lines through the production adapter, its call timer firing at `phaseMs` + k × 500
 * (as its setInterval would); every `voice-call` event with its seed time.
 */
export function replayCalls(seed: Seed, phaseMs: number): CallEvent[] {
	const decoder = new DsdFmeDecoder(
		{ id: "dmr", type: "dsd-fme", enabled: true, options: { mode: "auto" } },
		logger,
	)
	const internals = decoder as unknown as {
		handleOutputLine(line: string): void
		checkCallTimeoutAsync(): void
	}
	const clock = { now: T0 }
	const events: CallEvent[] = []
	decoder.on(
		"voice-call",
		(state: VoiceTapCall & { encryptionKnown?: unknown }) => {
			events.push({
				atMs: clock.now - T0,
				call: {
					callId: state.callId,
					active: state.active,
					encrypted: state.encrypted,
					protocol: state.protocol,
					slot: state.slot,
					...(typeof state.encryptionKnown === "boolean"
						? { encryptionKnown: state.encryptionKnown }
						: {}),
				},
			})
		},
	)
	withFakeDate(clock, () => {
		let tick = T0 + phaseMs
		const advance = (to: number): void => {
			for (; tick <= to; tick += ADAPTER_TIMER_MS) {
				clock.now = tick
				internals.checkCallTimeoutAsync()
			}
			clock.now = Math.max(clock.now, to)
		}
		let last = 0
		for (const line of seed.lines) {
			last = Math.max(last, line.atMs)
			advance(T0 + last)
			internals.handleOutputLine(line.text)
		}
		advance(T0 + last + IDLE_MS)
	})
	return events
}

/** A DMR voice sync line: `VC*`, `VC1*` .. `VC6` at the end of a `Sync:` line. */
const VOICE_SYNC = /\|\s*VC\d?\*?\s*$/
const SLOT_TAG = /\[slot\d\]/i

/** The over's first voice sync line on its slot (a direct line has no slot tag), or undefined. */
export function firstVoiceLine(
	seed: Seed,
	over: Seed["overs"][number],
): { atMs: number; text: string } | undefined {
	const tag = `[slot${over.slot}]`
	return seed.lines.find(
		l =>
			l.atMs >= over.startMs &&
			l.atMs <= over.endMs &&
			VOICE_SYNC.test(l.text) &&
			(!SLOT_TAG.test(l.text) || l.text.toLowerCase().includes(tag)),
	)
}

/** The snapshot admits pending voice: active, not encrypted, encryption known. */
export function admits(call: SeedCall): boolean {
	return call.active && !call.encrypted && call.encryptionKnown !== false
}

/** A call of the same slot was already active at the first voice: no pending head. */
export interface MergedOver {
	kind: "merged"
	voiceLineMs: number
}

export interface OwnCallOver {
	kind: "own"
	voiceLineMs: number
	/** The over's own call snapshots, in order (start to end). */
	events: CallEvent[]
	/** The first snapshot that admits pending voice; null: never (ends unresolved). */
	admitMs: number | null
	endMs: number | null
}

export type OverCall = MergedOver | OwnCallOver

const sameSlot = (call: SeedCall, slot: number): boolean =>
	call.slot === slot || call.slot === null

/** The over's call as the router hears it, from the adapter's events at one timer phase. */
export function overCall(
	seed: Seed,
	over: Seed["overs"][number],
	calls: readonly CallEvent[],
): OverCall {
	const line = firstVoiceLine(seed, over)
	if (line === undefined) throw new Error(`no voice line in over ${over.index}`)
	const at = line.atMs
	const open = new Map<string, boolean>()
	for (const e of calls) {
		if (e.atMs >= at) break
		if (sameSlot(e.call, over.slot)) open.set(e.call.callId, e.call.active)
	}
	if ([...open.values()].some(Boolean))
		return { kind: "merged", voiceLineMs: at }
	const first = calls.find(
		e =>
			e.atMs >= at &&
			e.call.active &&
			sameSlot(e.call, over.slot) &&
			!open.has(e.call.callId),
	)
	if (first === undefined) throw new Error(`no call for over ${over.index}`)
	const events = calls.filter(e => e.call.callId === first.call.callId)
	const admit = events.find(e => admits(e.call))
	const end = events.find(e => !e.call.active)
	return {
		kind: "own",
		voiceLineMs: at,
		events,
		admitMs: admit?.atMs ?? null,
		endMs: end?.atMs ?? null,
	}
}

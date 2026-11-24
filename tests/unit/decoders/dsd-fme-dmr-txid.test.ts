/**
 * dsd-fme DMR calls and their transmission ids, over the in-repo DMR corpus (recorded excerpts,
 * fixtures, synthetic captures and modelled scripts; no private capture): a call claims one txId
 * when its call_start is made, every output and voice-call state of the call carries it, calls
 * never share one, a pending call that never publishes mints none, and with a registry the
 * decoder publishes exactly the same events in the same order at the same times, txId aside.
 */
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	DsdFmeDecoder,
	type DsdFmeVoiceCallState,
} from "../../../src/decoders/builtin/dsd-fme.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import {
	TX_ID,
	TransmissionRegistry,
} from "../../../src/core/transmissions/index.js"
import { DATE_CLOCK, T0, type Line } from "./dsd-fme-call-first-helpers.js"
import { corpus } from "./dsd-fme-dmr-corpus.js"

const logger = pino({ level: "silent" })

type Published =
	| { kind: "output"; at: number; output: DecoderOutput }
	| { kind: "voice"; at: number; voice: DsdFmeVoiceCallState }

interface Internals {
	handleOutputLine(line: string): void
	checkCallTimeoutAsync(): void
	endOpenCallsForRestart(now: Date): void
}

function decoderWith(registry: TransmissionRegistry | null): DsdFmeDecoder {
	return new DsdFmeDecoder(
		{
			id: "dsd-fme",
			type: "dsd-fme",
			enabled: true,
			options: { mode: "auto" },
		},
		logger,
		DATE_CLOCK,
		registry === null ? {} : { transmissions: registry },
	)
}

/** Replays timed lines (10 ms steps, the 500 ms call timer), recording every publication in order. */
function replayAll(
	lines: readonly Line[],
	registry: TransmissionRegistry | null,
	before?: (d: DsdFmeDecoder) => void,
): Published[] {
	const decoder = decoderWith(registry)
	before?.(decoder)
	const out: Published[] = []
	decoder.on("output", (o: DecoderOutput) =>
		out.push({ kind: "output", at: Date.now(), output: o }),
	)
	decoder.on("voice-call", (v: DsdFmeVoiceCallState) =>
		out.push({ kind: "voice", at: Date.now(), voice: v }),
	)
	const internals = decoder as unknown as Internals
	const sorted = [...lines].sort((a, b) => a[0] - b[0])
	const untilMs = sorted.reduce((m, [t]) => Math.max(m, t), 0) + 6_000
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
	return out
}

interface CallFields {
	callId?: string
	txId?: string
	flags?: { wavFileUpdate?: boolean }
}

function callOf(p: Published): CallFields | null {
	if (p.kind === "voice") return p.voice
	const t = p.output.type
	return t === "call_start" || t === "call_end"
		? (p.output.data as CallFields)
		: null
}

/** The publication as JSON with its txId removed (the only field a registry may add). */
function withoutTx(p: Published): string {
	const strip = (v: object): object => {
		const { txId: _drop, ...rest } = v as { txId?: string }
		return rest
	}
	return JSON.stringify(
		p.kind === "voice"
			? { ...p, voice: strip(p.voice) }
			: {
					...p,
					output: {
						...p.output,
						data:
							typeof p.output.data === "object" && p.output.data !== null
								? strip(p.output.data)
								: p.output.data,
					},
				},
	)
}

describe("dsd-fme DMR transmission ids over the corpus", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(T0)
	})
	afterEach(() => vi.useRealTimers())

	const scripts = corpus()

	it("covers the recorded, fixture, synthetic and modelled DMR scripts", () => {
		expect(scripts.length).toBeGreaterThanOrEqual(20)
		const names = scripts.map(s => s.name)
		for (const name of [
			"rep-bogus-id.txt",
			"rep-false-lc-flco.txt",
			"rep-two-slot.txt",
		])
			expect(names).toContain(name)
	})

	for (const script of scripts)
		it(`${script.name}: one txId per call, nothing else changes`, () => {
			const plain = replayAll(script.lines, null)
			const registry = new TransmissionRegistry({ now: () => Date.now() })
			const withTx = replayAll(script.lines, registry)
			// Same publications, same order, same times: only txId is added.
			expect(withTx.map(withoutTx)).toEqual(plain.map(withoutTx))
			for (const p of plain) expect(callOf(p)?.txId).toBeUndefined()

			const txOfCall = new Map<string, string>()
			const callOfTx = new Map<string, string>()
			let started = 0
			for (const p of withTx) {
				const call = callOf(p)
				if (call === null || call.callId === undefined) continue
				if (p.kind === "output" && p.output.type === "call_start") started++
				// Every output and voice-call state of a published call carries its id.
				expect(call.txId).toMatch(TX_ID)
				const known = txOfCall.get(call.callId)
				if (known === undefined) txOfCall.set(call.callId, call.txId!)
				else expect(call.txId).toBe(known)
				const owner = callOfTx.get(call.txId!)
				if (owner === undefined) callOfTx.set(call.txId!, call.callId)
				else expect(owner).toBe(call.callId)
			}
			// One id per published call (distinct across calls and slots), none for a pending
			// call that never published.
			expect(txOfCall.size).toBe(started)
			const s = registry.stats()
			expect(s.open + s.closed + s.bareClosed).toBe(started)
			for (const [callId, txId] of txOfCall) {
				const v = registry.get(txId)!
				expect(v.kind).toBe("voice-digital")
				expect(v.origin).toBe("dv-call")
				expect(v.aliases.call).toEqual([`call:dsd-fme:${callId}`])
				// Every published call ended: its transmission is closed.
				expect(v.state).toBe("closed")
				expect(v.identity?.protocol).toBe("dmr")
			}
		})

	it("rep-two-slot: simultaneous calls of both slots hold distinct ids", () => {
		const script = scripts.find(s => s.name === "rep-two-slot.txt")!
		const registry = new TransmissionRegistry({ now: () => Date.now() })
		const out = replayAll(script.lines, registry)
		const bySlot = new Map<number, Set<string>>()
		for (const p of out) {
			if (p.kind !== "output" || p.output.type !== "call_start") continue
			const d = p.output.data as { slot?: number; txId?: string }
			const set = bySlot.get(d.slot ?? 0) ?? new Set<string>()
			set.add(d.txId!)
			bySlot.set(d.slot ?? 0, set)
		}
		expect(bySlot.size).toBeGreaterThanOrEqual(2)
		const all = [...bySlot.values()].flatMap(s => [...s])
		expect(new Set(all).size).toBe(all.length)
	})

	it("a retired run's claims are refused: calls publish unchanged, without an id", () => {
		const script = scripts.find(s => s.name === "rep-train.txt")!
		const plain = replayAll(script.lines, null)
		const registry = new TransmissionRegistry({ now: () => Date.now() })
		// The decoder's first run (before any start()) is retired before it claims.
		const out = replayAll(script.lines, registry, d =>
			registry.retireRun((d as unknown as { txRun(): string }).txRun(), T0),
		)
		expect(out.map(withoutTx)).toEqual(plain.map(withoutTx))
		const starts = out.filter(
			p => p.kind === "output" && p.output.type === "call_start",
		).length
		expect(starts).toBeGreaterThan(0)
		for (const p of out) expect(callOf(p)?.txId).toBeUndefined()
		expect(registry.stats().retiredRun).toBe(starts)
		expect(registry.stats().open).toBe(0)
	})

	it("a decoder restart closes the open call's transmission decoder-restart", () => {
		const script = scripts.find(s => s.name === "rep-train.txt")!
		const registry = new TransmissionRegistry({ now: () => Date.now() })
		const decoder = decoderWith(registry)
		const outputs: DecoderOutput[] = []
		decoder.on("output", (o: DecoderOutput) => outputs.push(o))
		const internals = decoder as unknown as Internals
		const sorted = [...script.lines].sort((a, b) => a[0] - b[0])
		// Feed until the first call_start went out, then restart.
		let i = 0
		for (let now = 0; now <= 60_000; now += 10) {
			while (i < sorted.length && sorted[i]![0] <= now) {
				vi.setSystemTime(T0 + sorted[i]![0])
				internals.handleOutputLine(sorted[i]![1])
				i++
			}
			vi.setSystemTime(T0 + now)
			if (now % 500 === 0) internals.checkCallTimeoutAsync()
			if (outputs.some(o => o.type === "call_start")) break
		}
		const start = outputs.find(o => o.type === "call_start")!
		const txId = (start.data as { txId: string }).txId
		expect(registry.get(txId)!.state).toBe("open")
		internals.endOpenCallsForRestart(new Date())
		const end = outputs.find(o => o.type === "call_end")!
		expect((end.data as { txId?: string }).txId).toBe(txId)
		const v = registry.get(txId)!
		expect(v.close).toBe("decoder-restart")
		expect(v.complete).toBe(false)
	})
})

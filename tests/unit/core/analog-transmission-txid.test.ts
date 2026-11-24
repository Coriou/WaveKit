/**
 * The live demodulator's transmission ids: a published transmission claims one when announced
 * (a suppressed one never), a tone split claims a fresh one after the held part ended, a
 * max-duration continuation keeps the id and adds its own `evt:` alias, the live CTCSS tone or
 * DCS code is noted on the entry, and the Activity payload carries the id.
 */
import type { AnalogTransmissionDcs } from "@wavekit/api-types"
import { describe, expect, it } from "vitest"
import type { ToneDetectorPort } from "../../../src/core/analog-transmission.js"
import { toActivityPayload } from "../../../src/core/analog-transmission.js"
import {
	TX_ID,
	TX_MAX_MS,
	TransmissionRegistry,
} from "../../../src/core/transmissions/index.js"
import { hygieneHarness } from "./analog-transmission-hygiene-fakes.js"

/** Marker byte per chunk: 1 → CTCSS 88.5, 2 → CTCSS 100.0, 3 → DCS 023, 0 → nothing. */
function markerDetector(): ToneDetectorPort {
	let votes = new Map<number, number>()
	let dcs: AnalogTransmissionDcs | null = null
	return {
		push(pcm: Buffer) {
			const marker = pcm[0] ?? 0
			if (marker === 1 || marker === 2)
				votes.set(marker, (votes.get(marker) ?? 0) + 1)
			if (marker === 3) dcs = { code: "023", polarity: "normal" }
		},
		result() {
			let best: number | null = null
			for (const [m, n] of votes)
				if (best === null || n > (votes.get(best) ?? 0)) best = m
			const ctcssHz = best === 1 ? 88.5 : best === 2 ? 100 : null
			return { ctcssHz, dtmf: null, dcs }
		},
		reset() {
			votes = new Map()
			dcs = null
		},
	}
}

const FMT = { rate: 8_000, format: "s16le" as const }
const CHANNEL_HZ = 446_000_000

function txHarness(
	registry: TransmissionRegistry | null,
	maxDurationMs?: number,
) {
	const h = hygieneHarness(undefined, {
		createToneDetector: markerDetector,
		...(maxDurationMs !== undefined ? { maxDurationMs } : {}),
		...(registry !== null ? { transmissions: registry } : {}),
	})
	/** Squelch open for `ms` (250 ms chunks of marker audio, carrier on every block), then closed. */
	const talk = (marker: number, ms: number, close = true): void => {
		h.source.gate(true)
		for (let t = 0; t < ms; t += 250) {
			h.source.carrier! += 25
			h.source.emit("pcm", Buffer.alloc(4_000, marker), FMT)
			h.advance(250)
			h.source.level()
		}
		if (close) h.source.gate(false)
	}
	return { ...h, talk }
}

describe("live demodulator transmission ids", () => {
	it("a tone split is a new transmission id; the held part ended first with its tone", () => {
		const registry = new TransmissionRegistry()
		const h = txHarness(registry)
		h.talk(1, 2_000)
		h.advance(300)
		h.talk(2, 3_000)
		h.advance(5_000)
		h.tracker.stop()
		expect(h.rows).toHaveLength(2)
		const [a, b] = h.rows.map(r => r.txId)
		expect(a).toMatch(TX_ID)
		expect(b).toMatch(TX_ID)
		expect(a).not.toBe(b)
		const held = registry.get(a!)!
		expect(held.close).toBe("ended")
		expect(held.complete).toBe(true)
		expect(held.liveTone).toEqual({ ctcssHz: 88.5, dcs: null })
		expect(held.aliases.evt).toEqual(["evt:tx-1"])
		const next = registry.get(b!)!
		expect(next.liveTone).toEqual({ ctcssHz: 100, dcs: null })
		expect(next.aliases.evt).toEqual(["evt:tx-2"])
		// the split shares the held part's group, never its id
		expect(next.groupId).toBe(held.groupId)
		// every event of a part carries that part's id (open and closed)
		expect(h.events.map(e => [e.transmissionId, e.state, e.txId])).toEqual([
			["tx-1", "open", a],
			["tx-1", "closed", a],
			["tx-2", "open", b],
			["tx-2", "closed", b],
		])
	})

	it("an unannounced held part claims at its close and a tone split still claims fresh, split from it", () => {
		const registry = new TransmissionRegistry()
		const h = txHarness(registry)
		// A scanner observation on the channel keeps its entry open past the held part's end.
		const scanner = registry.claim({
			origin: "scanner-observation",
			kind: "voice-analog",
			sourceId: "rtl0",
			hz: CHANNEL_HZ,
			halfWidthHz: 6_250,
			atMs: h.now(),
			alias: "obs:o_01JTESTOBSERVATION",
		})!
		h.talk(1, 2_000)
		h.advance(300)
		// The resumed segment's first two chunks: the held part is announced at the resume.
		h.talk(2, 500, false)
		// Before the chunk that confirms the new tone (the split comes before any announcement
		// there), force the held part back to unannounced with no claim.
		const internal = h.tracker as unknown as {
			transmission: {
				announced: boolean
				tx: { claimant: number } | null
			} | null
		}
		const open = internal.transmission!
		registry.end(open.tx!.claimant, h.now(), "ended")
		open.tx = null
		open.announced = false
		h.talk(2, 3_000)
		h.advance(5_000)
		h.tracker.stop()
		expect(h.rows).toHaveLength(2)
		const [a, b] = h.rows.map(r => r.txId)
		expect(a).toMatch(TX_ID)
		expect(b).toMatch(TX_ID)
		// The held part joined the observation's entry; the split never does.
		expect(a).toBe(scanner.txId)
		expect(b).not.toBe(a)
		expect(registry.get(b!)!.groupId).toBe(registry.get(a!)!.groupId)
		registry.end(scanner.claimant, h.now(), "ended")
	})

	it("a max-duration continuation keeps the id and adds its own event alias", () => {
		const registry = new TransmissionRegistry()
		const h = txHarness(registry, 2_000)
		h.talk(1, 5_000)
		h.advance(5_000)
		h.tracker.stop()
		expect(h.rows.length).toBeGreaterThanOrEqual(3)
		expect(h.rows.slice(0, -1).map(r => r.closeReason)).toEqual(
			h.rows.slice(0, -1).map(() => "max-duration"),
		)
		const ids = new Set(h.rows.map(r => r.txId))
		expect(ids.size).toBe(1)
		const txId = h.rows[0]!.txId!
		const v = registry.get(txId)!
		expect(v.aliases.evt).toEqual(h.rows.map(r => `evt:${r.transmissionId}`))
		expect(v.close).toBe("ended")
		// the continuation part that heard the tone keeps it noted
		expect(v.liveTone?.ctcssHz).toBe(88.5)
		expect(registry.stats().claimants).toBe(0)
	})

	it("a continuation that does not open ends the carried claim", () => {
		const registry = new TransmissionRegistry()
		const h = txHarness(registry, 2_000)
		h.talk(1, 1_750, false)
		// the squelch reads closed at the max-duration close: no continuation opens
		h.source.open = false
		h.advance(250)
		h.source.level()
		expect(h.tracker.current()).toBeNull()
		expect(h.rows.at(-1)?.closeReason).toBe("max-duration")
		const v = registry.get(h.rows.at(-1)!.txId!)!
		expect(v.state).toBe("closed")
		expect(v.close).toBe("max-duration")
		expect(registry.stats().claimants).toBe(0)
		h.tracker.stop()
	})

	it("a continuation of a transmission the registry closed at TX_MAX_MS claims fresh, continuing the old id", () => {
		const registry = new TransmissionRegistry()
		const h = txHarness(registry, 2_000)
		// The first part is open and announced; the sweep then passes the registry's own bound.
		h.talk(1, 1_500, false)
		const first = h.tracker.current()?.txId
		expect(first).toMatch(TX_ID)
		registry.sweep(h.now() + TX_MAX_MS)
		const old = registry.get(first!)!
		expect(old.state).toBe("closed")
		expect(old.close).toBe("max-duration")
		// The tracker's own max-duration close (2 s) opens a continuation on the carried claim.
		h.talk(1, 2_000)
		h.advance(5_000)
		h.tracker.stop()
		expect(h.rows.length).toBeGreaterThanOrEqual(2)
		expect(h.rows[0]!.txId).toBe(first)
		const next = h.rows[1]!.txId
		expect(next).toMatch(TX_ID)
		expect(next).not.toBe(first)
		// the closed entry is frozen: the continuation's alias went to the fresh one
		expect(registry.get(first!)!.aliases.evt).toEqual([
			`evt:${h.rows[0]!.transmissionId}`,
		])
		const fresh = registry.get(next!)!
		expect(fresh.aliases.evt).toContain(`evt:${h.rows[1]!.transmissionId}`)
		expect(fresh.groupId).toBe(old.groupId)
		expect(registry.stats().claimants).toBe(0)
	})

	it("a DCS code is noted on the entry as the heard live tone", () => {
		const registry = new TransmissionRegistry()
		const h = txHarness(registry)
		// DCS needs more audio than CTCSS (DCS_MIN_AUDIO_SECONDS)
		h.talk(3, 4_000)
		h.advance(5_000)
		h.tracker.stop()
		const v = registry.get(h.rows[0]!.txId!)!
		expect(v.liveTone).toEqual({
			ctcssHz: null,
			dcs: { code: "023", polarity: "normal" },
		})
		expect(v.tone.dcs).toBe("023")
		expect(v.tone.dcsChecked).toBe(true)
	})

	it("an untoned over is noted measured with no tone", () => {
		const registry = new TransmissionRegistry()
		const h = txHarness(registry)
		h.talk(0, 2_000)
		h.advance(5_000)
		h.tracker.stop()
		const v = registry.get(h.rows[0]!.txId!)!
		expect(v.liveTone).toEqual({ ctcssHz: null, dcs: null })
		expect(v.tone.state).toBe("none")
	})

	it("a suppressed transmission claims nothing", () => {
		const registry = new TransmissionRegistry()
		const h = txHarness(registry)
		h.talk(0, 250)
		h.advance(5_000)
		h.tracker.stop()
		expect(h.rows).toEqual([])
		expect(registry.stats()).toMatchObject({
			open: 0,
			bareClosed: 0,
			closed: 0,
		})
	})

	it("a scanner track on the same channel joins it; one 12.5 kHz away never does", () => {
		const registry = new TransmissionRegistry()
		const h = txHarness(registry)
		h.talk(1, 1_000, false)
		const open = h.tracker.current()
		expect(open?.txId).toMatch(TX_ID)
		const claim = (hz: number, alias: `obs:${string}`) =>
			registry.claim({
				origin: "scanner-observation",
				kind: "voice-analog",
				sourceId: "rtl0",
				hz,
				halfWidthHz: 6_000,
				atMs: h.now(),
				alias,
			})
		expect(claim(CHANNEL_HZ + 1_000, "obs:near")?.txId).toBe(open!.txId)
		const far = claim(CHANNEL_HZ + 12_500, "obs:far")
		expect(far).not.toBeNull()
		expect(far!.txId).not.toBe(open!.txId)
		h.source.gate(false)
		h.tracker.stop()
	})

	it("without a registry no event or row carries a txId", () => {
		const h = txHarness(null)
		h.talk(1, 2_000)
		h.advance(5_000)
		h.tracker.stop()
		expect(h.rows).toHaveLength(1)
		for (const e of h.events) expect(e).not.toHaveProperty("txId")
		for (const r of h.rows) expect(r).not.toHaveProperty("txId")
	})

	it("the Activity payload copies the event's txId", () => {
		const registry = new TransmissionRegistry()
		const h = txHarness(registry)
		h.talk(1, 2_000)
		h.advance(5_000)
		h.tracker.stop()
		const closed = h.events.find(e => e.state === "closed")!
		expect(toActivityPayload(closed).txId).toBe(closed.txId)
	})
})

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import { recordingChangeOf } from "../../../../src/core/activity/recording-links.js"
import {
	RecordingFactsSchema,
	recordingFactsBytes,
} from "../../../../src/core/scanner/store/recording-facts.js"
import {
	TX_OPEN_MAX,
	TX_OPEN_PER_SOURCE,
	TX_ROLLOVER_HOLD_MS,
	TransmissionRegistry,
	type TxAlias,
	type TxView,
} from "../../../../src/core/transmissions/index.js"

const CHANNELS = [100e6, 100.00625e6, 100.0125e6, 200e6] as const
const HALF = 6_250
const SOURCE = "src-a"

type Op =
	| { op: "trackOpen"; ch: number }
	| { op: "trackClose"; i: number; reason: "ended" | "hop" | "max-duration" }
	| { op: "trackRollover"; i: number }
	| { op: "liveOpen"; ch: number }
	| { op: "liveClose" }
	| { op: "liveContinuation" }
	| { op: "liveToneSplit" }
	| { op: "liveTone"; hz: number }
	| { op: "fileBegin"; i: number }
	| { op: "filePart" }
	| { op: "fileKeep" }
	| { op: "dvPromote"; lane: 0 | 1 | 2 }
	| { op: "dvEnd"; lane: 0 | 1 | 2 }
	| { op: "dvRestart" }
	| { op: "retune" }
	| { op: "sourceLost" }
	| { op: "advance"; ms: number }
	| { op: "refusal"; i: number }

const opArb: fc.Arbitrary<Op> = fc.oneof(
	fc.record({ op: fc.constant("trackOpen" as const), ch: fc.nat(3) }),
	fc.record({
		op: fc.constant("trackClose" as const),
		i: fc.nat(7),
		reason: fc.constantFrom(
			"ended" as const,
			"hop" as const,
			"max-duration" as const,
		),
	}),
	fc.record({ op: fc.constant("trackRollover" as const), i: fc.nat(7) }),
	fc.record({ op: fc.constant("liveOpen" as const), ch: fc.nat(3) }),
	fc.constant({ op: "liveClose" as const }),
	fc.constant({ op: "liveContinuation" as const }),
	fc.constant({ op: "liveToneSplit" as const }),
	fc.record({
		op: fc.constant("liveTone" as const),
		hz: fc.constantFrom(67, 88.5, 100, 254.1),
	}),
	fc.record({ op: fc.constant("fileBegin" as const), i: fc.nat(7) }),
	fc.constant({ op: "filePart" as const }),
	fc.constant({ op: "fileKeep" as const }),
	fc.record({
		op: fc.constant("dvPromote" as const),
		lane: fc.constantFrom(0 as const, 1 as const, 2 as const),
	}),
	fc.record({
		op: fc.constant("dvEnd" as const),
		lane: fc.constantFrom(0 as const, 1 as const, 2 as const),
	}),
	fc.constant({ op: "dvRestart" as const }),
	fc.constant({ op: "retune" as const }),
	fc.constant({ op: "sourceLost" as const }),
	fc.record({ op: fc.constant("advance" as const), ms: fc.nat(20_000) }),
	fc.record({ op: fc.constant("refusal" as const), i: fc.nat(7) }),
)

interface Active {
	txId: string
	claimant: number
	hz: number | null
	alias: TxAlias
}

/** Everything but what may still grow after close (the alias index and what it derives). */
function frozen(v: TxView): string {
	return JSON.stringify({ ...v, aliases: null, noAudioReason: null })
}

function failIf(cond: boolean, msg: string): void {
	if (cond) throw new Error(msg)
}

function run(ops: readonly Op[]): void {
	let t = 1_000
	const r = new TransmissionRegistry({ now: () => t })
	let seq = 0
	let epoch = 1
	let run = 1
	const tracks: (Active & { ch: number })[] = []
	let live: (Active & { ch: number }) | null = null
	const lanes = new Map<number, Active>()
	let file: { channel: number; txIds: string[]; part: number } | null = null
	const known = new Set<string>()
	const closed = new Set<string>()
	const snapshots = new Map<string, string>()

	const fresh = (id: string): void => {
		failIf(closed.has(id), `a closed id was given out: ${id}`)
		failIf(r.get(id)?.state !== "open", "a claim gave an id that is not open")
		known.add(id)
	}
	const claimTrack = (ch: number, continues?: string): Active | null => {
		const alias: TxAlias = `obs:o_${++seq}`
		const res = r.claim({
			origin: "scanner-observation",
			kind: "voice-analog",
			sourceId: SOURCE,
			hz: CHANNELS[ch]!,
			halfWidthHz: HALF,
			epoch,
			stream: 0,
			...(continues !== undefined ? { continues } : {}),
			atMs: t,
			alias,
		})
		if (res === null) return null
		fresh(res.txId)
		const a = { ...res, hz: CHANNELS[ch]!, alias, ch }
		tracks.push(a)
		// a track joining during the file's channel adds its transmission to the file
		if (file !== null && file.channel === ch && !file.txIds.includes(res.txId))
			if (file.txIds.length < 8) file.txIds.push(res.txId)
		return a
	}

	for (const o of ops) {
		t += 1
		switch (o.op) {
			case "trackOpen":
				claimTrack(o.ch)
				break
			case "trackClose": {
				const a = tracks[o.i % Math.max(1, tracks.length)]
				if (!a) break
				tracks.splice(tracks.indexOf(a), 1)
				r.end(a.claimant, t, o.reason)
				break
			}
			case "trackRollover": {
				const a = tracks[o.i % Math.max(1, tracks.length)]
				if (!a) break
				tracks.splice(tracks.indexOf(a), 1)
				const wasOpen = r.get(a.txId)?.state === "open"
				r.end(a.claimant, t, "max-duration")
				const next = claimTrack(a.ch, a.txId)
				// (iii) a rollover chain keeps its id
				if (wasOpen && next !== null)
					failIf(next.txId !== a.txId, "a rollover changed the id")
				break
			}
			case "liveOpen": {
				if (live !== null) break
				const alias: TxAlias = `evt:e_${++seq}`
				const res = r.claim({
					origin: "live-demod",
					kind: "voice-analog",
					sourceId: SOURCE,
					hz: CHANNELS[o.ch]!,
					halfWidthHz: HALF,
					atMs: t,
					alias,
				})
				if (res !== null) {
					fresh(res.txId)
					live = { ...res, hz: CHANNELS[o.ch]!, alias, ch: o.ch }
				}
				break
			}
			case "liveClose":
				if (live !== null) r.end(live.claimant, t)
				live = null
				break
			case "liveContinuation":
				// the next part copies the id (alias only): an artefact of a closed id is allowed
				if (live !== null) r.attach(live.txId, `evt:e_${++seq}`)
				break
			case "liveToneSplit": {
				if (live === null) break
				const held: Active & { ch: number } = live
				r.end(held.claimant, t)
				const alias: TxAlias = `evt:e_${++seq}`
				const res = r.claim({
					origin: "live-demod",
					kind: "voice-analog",
					sourceId: SOURCE,
					hz: held.hz!,
					halfWidthHz: HALF,
					splitFrom: held.txId,
					atMs: t,
					alias,
				})
				live = null
				if (res !== null) {
					fresh(res.txId)
					failIf(res.txId === held.txId, "a tone split kept the id")
					live = { ...res, hz: held.hz, alias, ch: held.ch }
				}
				break
			}
			case "liveTone":
				if (live !== null)
					r.noteLiveTone(live.claimant, { ctcssHz: o.hz, dcs: null })
				break
			case "fileBegin": {
				if (file !== null) break
				const a = tracks[o.i % Math.max(1, tracks.length)]
				if (!a) break
				const start = r.openTxOf(a.alias)
				const txIds = start === null ? [] : [start]
				for (const other of tracks)
					if (other.ch === a.ch) {
						const tx = r.openTxOf(other.alias)
						if (tx !== null && !txIds.includes(tx) && txIds.length < 8)
							txIds.push(tx)
					}
				// (i) a file's start id was open at its first sample
				for (const id of txIds)
					failIf(r.openTxOf(id) === null, "a file started on a closed id")
				file = { channel: a.ch, txIds, part: 0 }
				break
			}
			case "filePart":
			case "fileKeep": {
				if (file === null) break
				const key = `scan:d_1~f${++seq}.wav`
				for (const id of file.txIds) r.attach(id, `rec:${key}`)
				// (ii) derived artefacts equal their parent: facts and the recording-change payload
				const bytes = recordingFactsBytes({
					operationId: "00000000-0000-4000-8000-000000000000",
					discoveryId: "d_1",
					observationId: "o_1",
					targetHz: CHANNELS[file.channel]!,
					startedAt: new Date(t).toISOString(),
					durationMs: 1000,
					keptAt: t,
					cut: "completed",
					keptBy: undefined,
					speechHeard: null,
					cutActive: null,
					admission: null,
					txIds: file.txIds,
				})
				failIf(bytes === null, "facts did not serialize")
				const facts = RecordingFactsSchema.parse(JSON.parse(bytes!.toString()))
				failIf(facts.txId !== file.txIds[0], "facts txId differs")
				failIf(
					JSON.stringify(facts.moreTxIds ?? []) !==
						JSON.stringify(file.txIds.slice(1)),
					"facts moreTxIds differ",
				)
				const [txId, ...more] = file.txIds
				const change = recordingChangeOf({
					recordingId: key.slice("scan:".length),
					discoveryId: "d_1",
					observationId: "o_1",
					sourceId: SOURCE,
					frequencyHz: CHANNELS[file.channel]!,
					observationStartedAt: new Date(t).toISOString(),
					durationMs: 1000,
					at: t,
					...(txId !== undefined ? { txId } : {}),
					...(more.length > 0 ? { moreTxIds: more } : {}),
				})
				failIf(change?.txId !== txId, "recording-change txId differs")
				if (o.op === "fileKeep") file = null
				else file.part++
				break
			}
			case "dvPromote": {
				const alias: TxAlias = `call:c_${++seq}`
				const res = r.claim({
					origin: "dv-call",
					kind: "voice-digital",
					sourceId: SOURCE,
					dvKey: "dv:dsd",
					lane: o.lane,
					run: `dsd#${run}`,
					atMs: t,
					alias,
				})
				const prev = lanes.get(o.lane)
				if (res !== null) {
					failIf(known.has(res.txId), "a DV promotion reused an id")
					fresh(res.txId)
					if (prev !== undefined)
						failIf(r.get(prev.txId)?.state === "open", "a lane holds two ids")
					lanes.set(o.lane, { ...res, hz: null, alias })
				}
				break
			}
			case "dvEnd": {
				const a = lanes.get(o.lane)
				if (a !== undefined) r.end(a.claimant, t)
				lanes.delete(o.lane)
				break
			}
			case "dvRestart":
				r.retireRun(`dsd#${run}`, t)
				run++
				lanes.clear()
				break
			case "retune":
				epoch++
				r.closeSource(SOURCE, "retune", t, { epochNot: epoch })
				for (const a of tracks.splice(0)) r.end(a.claimant, t, "retune")
				break
			case "sourceLost":
				r.closeSource(SOURCE, "source-lost", t)
				for (const a of tracks.splice(0)) r.end(a.claimant, t, "source-lost")
				if (live !== null) r.end(live.claimant, t)
				live = null
				lanes.clear()
				break
			case "advance":
				t += o.ms
				r.sweep(t)
				break
			case "refusal": {
				const a = tracks[o.i % Math.max(1, tracks.length)]
				if (a) r.noteRefusal(a.alias, "refused:slots")
				break
			}
		}
		// (iv) two claimants active at once on channels ≥ 6.25 kHz apart never share an id
		const active: Active[] = [...tracks, ...(live ? [live] : [])]
		for (let i = 0; i < active.length; i++)
			for (let j = i + 1; j < active.length; j++) {
				const a = active[i]!
				const b = active[j]!
				if (a.txId !== b.txId || a.hz === null || b.hz === null) continue
				failIf(Math.abs(a.hz - b.hz) >= HALF, "two channels apart share an id")
			}
		// (v) closed entries never change; (vi) bounds hold
		for (const id of known) {
			const v = r.get(id)
			if (v === null) {
				closed.add(id)
				continue
			}
			if (v.state !== "closed") continue
			closed.add(id)
			const snap = frozen(v)
			const before = snapshots.get(id)
			if (before === undefined) snapshots.set(id, snap)
			else failIf(before !== snap, "a closed entry changed")
		}
		const s = r.stats()
		failIf(s.open > TX_OPEN_MAX, "total open cap exceeded")
		failIf(r.openOn(SOURCE) > TX_OPEN_PER_SOURCE, "per-source cap exceeded")
	}
}

describe("transmission identity properties", () => {
	// Feature: transmission-identity, Property 1: every artefact inside a transmission carries its id, none a closed one
	// Validates: Requirements P1.1, P1.5
	it("ids are claimed once, copied forward, never closed ones, never shared across channels", () => {
		fc.assert(
			fc.property(fc.array(opArb, { maxLength: 150 }), ops => {
				run(ops)
			}),
			{ numRuns: 200 },
		)
	})

	// Feature: transmission-identity, Property 2: a toned recorder session carries its tone
	// Validates: Requirements P1.2
	it("a toned recording or live close reads its tone; two different heard tones read the recorder's", () => {
		const tone = fc.constantFrom(67, 88.5, 100, 151.4, 254.1)
		fc.assert(
			fc.property(
				fc.option(tone, { nil: null }),
				fc.option(tone, { nil: null }),
				(recHz, liveHz) => {
					const r = new TransmissionRegistry()
					const res = r.claim({
						origin: "live-demod",
						kind: "voice-analog",
						sourceId: SOURCE,
						hz: CHANNELS[0],
						halfWidthHz: HALF,
						atMs: 0,
						alias: "evt:e",
					})!
					if (liveHz !== null)
						r.noteLiveTone(res.claimant, { ctcssHz: liveHz, dcs: null })
					r.end(res.claimant, TX_ROLLOVER_HOLD_MS)
					r.attach(res.txId, "rec:scan:d~f.wav")
					const v = r.get(res.txId, {
						recorderTones: [
							recHz === null ? undefined : { kind: "ctcss", hz: recHz },
						],
					})!
					if (recHz !== null) {
						expect(v.tone.ctcssHz).toBe(recHz)
						expect(v.tone.source).toBe("recorder")
						expect(v.tone.ambiguous).toBe(liveHz !== null && liveHz !== recHz)
					} else if (liveHz !== null) {
						expect(v.tone.ctcssHz).toBe(liveHz)
						expect(v.tone.source).toBe("live-demod")
					} else expect(v.tone.state).toBe("not-measured")
				},
			),
			{ numRuns: 200 },
		)
	})
})

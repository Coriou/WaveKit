import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type {
	ActivityChange,
	ActivityQuery,
} from "../../../../src/decoders/enablement/activity-contract.js"
import {
	ACTIVITY_DECODE_HOT_MS,
	ACTIVITY_DECODE_WARM_MS,
	ACTIVITY_HISTORY_REFRESH_MS,
	ACTIVITY_HOT_HOLD_MS,
	ACTIVITY_LIVE_TTL_MS,
	ACTIVITY_MAX_CANDIDATES,
	ACTIVITY_MAX_INTERESTS,
	ACTIVITY_MAX_NOTES,
	ACTIVITY_MAX_SEGMENTS,
	ACTIVITY_MAX_SOURCES,
	ACTIVITY_MAX_TRACKS,
	ACTIVITY_NOTIFY_MAX_DELAY_MS,
	ACTIVITY_STALE_MS,
	ACTIVITY_WARM_HOLD_MS,
	associateCandidate,
	createChannelActivityRanker,
	replayTrialWeight,
	type ActivityBlock,
	type ActivityHistoryProvider,
} from "../../../../src/core/scanner/channel-activity.js"

const RASTER = 12_500
const CENTRE = 466_000_000
const RASTER_HZ = Array.from(
	{ length: 33 },
	(_, i) => CENTRE - 200_000 + i * RASTER,
)

/** A fake monotonic clock with fake timers that only fire when the test advances them. */
function fakeClock(start = 1_000) {
	let now = start
	let seq = 0
	const pending = new Map<number, { at: number; fn: () => void }>()
	return {
		now: () => now,
		timers: {
			setTimeout: (fn: () => void, ms: number): unknown => {
				const id = ++seq
				pending.set(id, { at: now + ms, fn })
				return id
			},
			clearTimeout: (h: unknown): void => {
				pending.delete(h as number)
			},
		},
		pending: () => pending.size,
		advance(ms: number): void {
			const end = now + ms
			for (;;) {
				let next: [number, { at: number; fn: () => void }] | undefined
				for (const e of pending)
					if (e[1].at <= end && (!next || e[1].at < next[1].at)) next = e
				if (!next) break
				pending.delete(next[0])
				now = Math.max(now, next[1].at)
				next[1].fn()
			}
			now = end
		},
	}
}

function setup(history?: ActivityHistoryProvider) {
	const clock = fakeClock()
	const ranker = createChannelActivityRanker({
		monoNow: clock.now,
		timers: clock.timers,
		...(history ? { history } : {}),
	})
	const changes: ActivityChange[] = []
	ranker.port.subscribe(c => changes.push(c))
	return { clock, ranker, changes }
}

const block = (
	hzs: readonly number[],
	over: Partial<ActivityBlock> = {},
): ActivityBlock => ({
	epoch: 1,
	centreHz: CENTRE,
	sampleRateHz: 1_024_000,
	overload: false,
	tracks: hzs.map((hz, i) => ({
		startHz: hz - 3_000,
		endHz: hz + 3_000,
		flags: { iqImage: false, spur: false },
		trackId: `t${i}-${hz}`,
		gate: "passed" as const,
	})),
	...over,
})

const query = (over: Partial<ActivityQuery> = {}): ActivityQuery => ({
	epoch: { sourceId: "rtl", engineId: "e1", epoch: 1 },
	decoderId: "multimon-ng",
	decoderType: "multimon-ng",
	protocols: ["pocsag", "flex"],
	centreHz: CENTRE,
	candidatesHz: RASTER_HZ,
	channelWidthHz: RASTER,
	...over,
})

const one = (
	r: ReturnType<typeof setup>["ranker"],
	q: ActivityQuery,
	now: number,
) => r.port.snapshot([q], now)[0]!

describe("channel activity ranker", () => {
	it("a far raster channel with activity ranks hot ahead of the near idle ones (two-channel scenario)", () => {
		const { clock, ranker } = setup()
		const far = RASTER_HZ[32]!
		ranker.ingestEpoch("rtl", "e1", 1)
		ranker.ingestBlock("rtl", "e1", block([far]))
		const snap = one(ranker, query(), clock.now())
		expect(snap.status).toBe("ready")
		const farCh = snap.channels.find(c => c.hz === far)!
		const near = snap.channels.find(c => c.hz === CENTRE)!
		expect(farCh).toMatchObject({ state: "hot", live: true })
		expect(farCh.reasons).toContain("live-energy")
		expect(near).toMatchObject({ state: "cold", score: 0, live: false })
		const ranked = [...snap.channels].sort((a, b) => b.score - a.score)
		expect(ranked[0]!.hz).toBe(far)
		// it stays hot after its burst ends, ahead of the near idle channels
		ranker.ingestBlock("rtl", "e1", block([]))
		clock.advance(30_000)
		ranker.ingestBlock("rtl", "e1", block([]))
		const later = one(ranker, query(), clock.now())
		const f = later.channels.find(c => c.hz === far)!
		expect(f).toMatchObject({ state: "hot", live: false })
		expect(f.score).toBeGreaterThan(
			later.channels.find(c => c.hz === CENTRE)!.score,
		)
	})

	it("echoes every query exactly: epoch, order and one channel per candidate (property)", () => {
		// Feature: activity-ranked-channels, Property 1: snapshot echo
		// Validates: Requirements activity 1.1, 1.2
		fc.assert(
			fc.property(
				fc.shuffledSubarray(RASTER_HZ, { minLength: 0 }),
				fc.subarray(RASTER_HZ),
				fc.integer({ min: 0, max: 3 }),
				fc.boolean(),
				(candidates, active, epoch, sameEngine) => {
					const { clock, ranker } = setup()
					ranker.ingestEpoch("rtl", "e1", 1)
					ranker.ingestBlock("rtl", "e1", block(active))
					const q = query({
						candidatesHz: candidates,
						epoch: {
							sourceId: "rtl",
							engineId: sameEngine ? "e1" : "e2",
							epoch,
						},
					})
					const [snap] = ranker.port.snapshot([q], clock.now())
					expect(snap!.query).toBe(q)
					expect(snap!.channels.map(c => c.hz)).toEqual(candidates)
					const ready = sameEngine && epoch === 1
					expect(snap!.status).toBe(ready ? "ready" : "retuning")
					for (const c of snap!.channels) {
						expect(Number.isFinite(c.score) && c.score >= 0).toBe(true)
						// only eligible candidates are ever named, live only on active ones
						if (c.live) expect(active).toContain(c.hz)
					}
					if (ready)
						for (const hz of active)
							if (candidates.includes(hz))
								expect(snap!.channels.find(c => c.hz === hz)!.live).toBe(true)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("a malformed query answers unavailable with one cold channel per candidate", () => {
		const { clock, ranker } = setup()
		ranker.ingestEpoch("rtl", "e1", 1)
		ranker.ingestBlock("rtl", "e1", block([CENTRE]))
		for (const bad of [
			query({ candidatesHz: [CENTRE, CENTRE] }),
			query({ candidatesHz: [CENTRE + 0.5] }),
			query({ channelWidthHz: 0 }),
			query({
				candidatesHz: Array.from(
					{ length: ACTIVITY_MAX_CANDIDATES + 1 },
					(_, i) => CENTRE + i,
				),
			}),
		]) {
			const s = one(ranker, bad, clock.now())
			expect(s.status).toBe("unavailable")
			expect(s.query).toBe(bad)
			expect(s.channels.map(c => c.hz)).toEqual(bad.candidatesHz)
			expect(s.channels.every(c => c.state === "cold" && c.score === 0)).toBe(
				true,
			)
		}
		// exactly at the candidate bound is accepted
		const at = query({
			candidatesHz: Array.from(
				{ length: ACTIVITY_MAX_CANDIDATES },
				(_, i) => CENTRE + i * RASTER,
			),
		})
		expect(one(ranker, at, clock.now()).status).toBe("ready")
	})

	it("live first: a live channel outranks every channel that is not, whatever its history", () => {
		// Feature: activity-ranked-channels, Property 2: live-first precedence
		// Validates: Requirements activity 1.4
		fc.assert(
			fc.property(
				fc.integer({ min: 0, max: 32 }),
				fc.subarray(RASTER_HZ, { minLength: 1 }),
				(liveIdx, history) => {
					const { clock, ranker } = setup()
					ranker.ingestEpoch("rtl", "e1", 1)
					for (const hz of history) {
						ranker.noteDecode("rtl", hz, "pocsag")
						ranker.noteReplayTrial("rtl", hz, "pocsag", "success")
						ranker.ingestBlock("rtl", "e1", block([hz]))
						ranker.ingestTrack("rtl", "e1", {
							trackId: `h${hz}`,
							epoch: 1,
							centreHz: hz,
							gate: "passed",
							flags: { iqImage: false, spur: false },
						})
					}
					const liveHz = RASTER_HZ[liveIdx]!
					ranker.ingestBlock("rtl", "e1", block([liveHz]))
					const s = one(ranker, query(), clock.now())
					const live = s.channels.find(c => c.hz === liveHz)!
					expect(live.live).toBe(true)
					for (const c of s.channels)
						if (!c.live) expect(live.score).toBeGreaterThan(c.score)
				},
			),
			{ numRuns: 100 },
		)
	})

	it("decays hot → warm → cold with a finite next evaluation at each deadline", () => {
		const { clock, ranker } = setup()
		const hz = RASTER_HZ[5]!
		ranker.ingestEpoch("rtl", "e1", 1)
		ranker.ingestBlock("rtl", "e1", block([hz]))
		const t0 = clock.now()
		ranker.ingestBlock("rtl", "e1", block([]))
		const s0 = one(ranker, query(), t0)
		expect(s0.channels[5]).toMatchObject({
			state: "hot",
			live: false,
			lastEnergyMonoMs: t0,
		})
		// the earliest deadline is the stale deadline while frames flow
		expect(s0.nextEvaluationMonoMs).toBe(t0 + ACTIVITY_STALE_MS)
		const keepFrames = (ms: number) => {
			for (let t = 0; t < ms; t += 5_000) {
				clock.advance(Math.min(5_000, ms - t))
				ranker.ingestBlock("rtl", "e1", block([]))
			}
		}
		keepFrames(ACTIVITY_HOT_HOLD_MS - 1)
		expect(one(ranker, query(), clock.now()).channels[5]!.state).toBe("hot")
		keepFrames(1)
		const warm = one(ranker, query(), clock.now())
		expect(warm.channels[5]!.state).toBe("warm")
		expect(Number.isFinite(warm.nextEvaluationMonoMs)).toBe(true)
		keepFrames(ACTIVITY_WARM_HOLD_MS - ACTIVITY_HOT_HOLD_MS - 1)
		expect(one(ranker, query(), clock.now()).channels[5]!.state).toBe("warm")
		keepFrames(1)
		const cold = one(ranker, query(), clock.now())
		expect(cold.channels[5]).toMatchObject({ state: "cold", score: 0 })
	})

	it("success memory expires: a decode is hot for 15 min, warm until 6 h, then forgotten", () => {
		const { clock, ranker } = setup()
		const hz = RASTER_HZ[7]!
		ranker.ingestEpoch("rtl", "e1", 1)
		ranker.ingestBlock("rtl", "e1", block([]))
		ranker.noteDecode("rtl", hz, "pocsag")
		const t0 = clock.now()
		const at = (dt: number) => {
			const s = one(ranker, query(), t0 + dt)
			return s
		}
		// frames keep flowing: pretend the last frame is recent by ingesting at each probe time
		const probe = (dt: number) => {
			clock.advance(t0 + dt - clock.now())
			ranker.ingestBlock("rtl", "e1", block([]))
			return at(dt).channels[7]!
		}
		expect(probe(0)).toMatchObject({ state: "hot", reasons: ["decoded"] })
		expect(at(0).nextEvaluationMonoMs).toBe(t0 + ACTIVITY_STALE_MS)
		expect(probe(ACTIVITY_DECODE_HOT_MS - 1).state).toBe("hot")
		expect(probe(ACTIVITY_DECODE_HOT_MS).state).toBe("warm")
		expect(probe(ACTIVITY_DECODE_WARM_MS - 1).state).toBe("warm")
		expect(probe(ACTIVITY_DECODE_WARM_MS)).toMatchObject({
			state: "cold",
			score: 0,
			reasons: [],
		})
		// a decode of another decoder's protocol never counts
		ranker.noteDecode("rtl", hz, "dmr")
		expect(probe(ACTIVITY_DECODE_WARM_MS + 1).state).toBe("cold")
	})

	it("next evaluation is the nearest decay deadline when it comes before the stale deadline", () => {
		const { clock, ranker } = setup()
		ranker.ingestEpoch("rtl", "e1", 1)
		ranker.ingestBlock("rtl", "e1", block([RASTER_HZ[3]!]))
		const t0 = clock.now()
		clock.advance(ACTIVITY_HOT_HOLD_MS - 2_000)
		ranker.ingestBlock("rtl", "e1", block([]))
		const s = one(ranker, query(), clock.now())
		expect(s.nextEvaluationMonoMs).toBe(t0 + ACTIVITY_HOT_HOLD_MS)
	})

	it("stale at exactly 10 s without a frame, ready just before", () => {
		const { clock, ranker } = setup()
		ranker.ingestEpoch("rtl", "e1", 1)
		ranker.ingestBlock("rtl", "e1", block([CENTRE]))
		const t0 = clock.now()
		expect(one(ranker, query(), t0 + ACTIVITY_STALE_MS - 1).status).toBe(
			"ready",
		)
		const stale = one(ranker, query(), t0 + ACTIVITY_STALE_MS)
		expect(stale.status).toBe("stale")
		expect(stale.channels.every(c => !c.live && c.state === "cold")).toBe(true)
		expect(stale.lastFrameMonoMs).toBe(t0)
	})

	it("a retune invalidates live evidence; a stop makes the source unavailable", () => {
		const { clock, ranker, changes } = setup()
		const hz = RASTER_HZ[9]!
		ranker.ingestEpoch("rtl", "e1", 1)
		ranker.ingestBlock("rtl", "e1", block([hz]))
		expect(ranker.epochOf("rtl")).toEqual({
			sourceId: "rtl",
			engineId: "e1",
			epoch: 1,
		})
		ranker.ingestEpoch("rtl", "e1", 2)
		const e2 = query({ epoch: { sourceId: "rtl", engineId: "e1", epoch: 2 } })
		expect(one(ranker, query(), clock.now()).status).toBe("retuning")
		expect(one(ranker, e2, clock.now()).status).toBe("retuning")
		ranker.ingestBlock("rtl", "e1", block([], { epoch: 2 }))
		const after = one(ranker, e2, clock.now())
		expect(after.status).toBe("ready")
		expect(after.channels[9]).toMatchObject({ live: false, state: "cold" })
		// a late block of the old epoch never moves the epoch back
		ranker.ingestBlock("rtl", "e1", block([hz], { epoch: 1 }))
		expect(ranker.epochOf("rtl")!.epoch).toBe(2)
		// a new engine is a new epoch too
		ranker.ingestBlock("rtl", "e2", block([], { epoch: 1 }))
		expect(ranker.epochOf("rtl")).toEqual({
			sourceId: "rtl",
			engineId: "e2",
			epoch: 1,
		})
		clock.advance(ACTIVITY_NOTIFY_MAX_DELAY_MS)
		const before = changes.length
		ranker.stop("rtl")
		expect(ranker.epochOf("rtl")).toBeNull()
		expect(
			one(
				ranker,
				query({ epoch: { sourceId: "rtl", engineId: "e2", epoch: 1 } }),
				clock.now(),
			).status,
		).toBe("unavailable")
		clock.advance(ACTIVITY_NOTIFY_MAX_DELAY_MS)
		expect(changes.length).toBe(before + 1)
		expect(changes.at(-1)!.epoch).toEqual({
			sourceId: "rtl",
			engineId: "e2",
			epoch: 1,
		})
	})

	it("ambiguity gives no credit: an item between two candidates within half the raster credits neither", () => {
		expect(associateCandidate([100, 200], 150, 100)).toBe(-1)
		expect(associateCandidate([100, 200], 149, 100)).toBe(0)
		expect(associateCandidate([100, 200], 151, 100)).toBe(1)
		expect(associateCandidate([100, 300], 149, 100)).toBe(0)
		expect(associateCandidate([100, 300], 150, 100)).toBe(0)
		expect(associateCandidate([100, 300], 151, 100)).toBe(-1)
		expect(associateCandidate([100, 300], 250, 100)).toBe(1)
		expect(associateCandidate([], 250, 100)).toBe(-1)
		const { clock, ranker } = setup()
		ranker.ingestEpoch("rtl", "e1", 1)
		// candidates 6.25 kHz apart at a 12.5 kHz raster: every item is in reach of two
		const dense = [CENTRE, CENTRE + 6_250]
		ranker.ingestBlock("rtl", "e1", block([CENTRE + 1_000]))
		const s = one(ranker, query({ candidatesHz: dense }), clock.now())
		expect(s.channels.every(c => !c.live && c.score === 0)).toBe(true)
	})

	it("association is the nearest candidate (property)", () => {
		// Feature: activity-ranked-channels, Property 3: deterministic association
		// Validates: Requirements activity 1.6
		fc.assert(
			fc.property(
				fc.uniqueArray(fc.integer({ min: 0, max: 1_000_000 }), {
					minLength: 1,
					maxLength: 40,
				}),
				fc.integer({ min: -10_000, max: 1_010_000 }),
				fc.integer({ min: 2, max: 50_000 }),
				(cands, hz, raster) => {
					const sorted = [...cands].sort((a, b) => a - b)
					const got = associateCandidate(sorted, hz, raster)
					const within = sorted.filter(c => Math.abs(c - hz) <= raster / 2)
					if (within.length !== 1) expect(got).toBe(-1)
					else expect(sorted[got]).toBe(within[0])
				},
			),
			{ numRuns: 200 },
		)
	})

	it("occupancy is coarse support only: it adds score, never a state", () => {
		const hz = RASTER_HZ[4]!
		const { clock, ranker } = setup(() => ({
			decodes: [],
			successes: [],
			occupancy: [{ hz, duty: 0.9 }],
		}))
		ranker.ingestEpoch("rtl", "e1", 1)
		ranker.ingestBlock("rtl", "e1", block([]))
		const c = one(ranker, query(), clock.now()).channels[4]!
		expect(c.state).toBe("cold")
		expect(c.reasons).toEqual(["occupancy"])
		expect(c.score).toBeCloseTo(0.45)
	})

	it("history is pulled at most every 2 s, from ingest only, never from snapshot", () => {
		let calls = 0
		const { clock, ranker } = setup(() => {
			calls++
			return { decodes: [], successes: [], occupancy: [] }
		})
		ranker.ingestEpoch("rtl", "e1", 1)
		for (let i = 0; i < 40; i++) {
			ranker.ingestBlock("rtl", "e1", block([]))
			ranker.port.snapshot([query()], clock.now())
			clock.advance(50)
		}
		// 40 blocks over 2 000 ms: the first pull, then one at exactly 2 000 ms
		expect(calls).toBe(1)
		ranker.ingestBlock("rtl", "e1", block([]))
		expect(calls).toBe(2)
		expect(ACTIVITY_HISTORY_REFRESH_MS).toBe(2_000)
		ranker.port.snapshot([query()], clock.now() + 60_000)
		expect(calls).toBe(2)
	})

	it("only complete failed replays are negative; cancelled, skipped or incomplete ones count for nothing", () => {
		expect(replayTrialWeight("decoded", false)).toBe("success")
		expect(replayTrialWeight("heard", true)).toBe("success")
		for (const o of ["no-sync", "crc-errors", "timeout"]) {
			expect(replayTrialWeight(o, true)).toBe("failure")
			expect(replayTrialWeight(o, false)).toBe("none")
		}
		for (const o of [
			"cancelled",
			"skipped-budget",
			"unsupported",
			"not-needed",
		])
			expect(replayTrialWeight(o, true)).toBe("none")
		const { clock, ranker } = setup()
		const hz = RASTER_HZ[2]!
		ranker.ingestEpoch("rtl", "e1", 1)
		ranker.ingestBlock("rtl", "e1", block([]))
		ranker.noteReplayTrial(
			"rtl",
			hz,
			"pocsag",
			replayTrialWeight("cancelled", false),
		)
		expect(one(ranker, query(), clock.now()).channels[2]!.reasons).toEqual([])
		ranker.noteReplayTrial("rtl", hz, "pocsag", "success")
		ranker.noteReplayTrial("rtl", RASTER_HZ[3]!, "pocsag", "failure")
		const s = one(ranker, query(), clock.now())
		expect(s.channels[2]).toMatchObject({
			state: "hot",
			reasons: ["trial-success"],
		})
		expect(s.channels[3]).toMatchObject({
			state: "cold",
			score: 0,
			reasons: ["trial-backoff"],
		})
	})

	it("coalesces notices: the first at once, later ones at most 250 ms late, never trailing", () => {
		const { clock, ranker, changes } = setup()
		ranker.ingestEpoch("rtl", "e1", 1)
		ranker.ingestBlock("rtl", "e1", block([]))
		ranker.port.snapshot([query()], clock.now())
		clock.advance(0)
		const base = changes.length
		expect(base).toBe(1) // the epoch start (health)
		clock.advance(1_000)
		// a live edge long after the last notice: noticed at once
		ranker.ingestBlock("rtl", "e1", block([RASTER_HZ[1]!]))
		clock.advance(0)
		expect(changes.length).toBe(base + 1)
		const t = clock.now()
		// a burst of edges every 10 ms: never pushed back by later marks
		const times: number[] = []
		ranker.port.subscribe(() => times.push(clock.now()))
		for (let i = 0; i < 100; i++) {
			ranker.ingestBlock("rtl", "e1", block(i % 2 ? [RASTER_HZ[i % 33]!] : []))
			clock.advance(10)
		}
		expect(times.length).toBeGreaterThan(0)
		expect(times[0]! - t).toBeLessThanOrEqual(ACTIVITY_NOTIFY_MAX_DELAY_MS)
		for (let i = 1; i < times.length; i++)
			expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(
				ACTIVITY_NOTIFY_MAX_DELAY_MS,
			)
		// 1 000 ms of edges: at most 1000 / 250 notices
		expect(times.length).toBeLessThanOrEqual(
			1_000 / ACTIVITY_NOTIFY_MAX_DELAY_MS,
		)
		const revisions = changes.slice(base).map(c => c.revision)
		expect([...revisions].sort((a, b) => a - b)).toEqual(revisions)
	})

	it("notifies at a decay deadline without any new input", () => {
		const { clock, ranker, changes } = setup()
		ranker.ingestEpoch("rtl", "e1", 1)
		ranker.ingestBlock("rtl", "e1", block([RASTER_HZ[6]!]))
		ranker.port.snapshot([query()], clock.now())
		// frames keep coming (no edge, energy elsewhere none) up to the hot deadline
		const n0 = changes.length
		ranker.ingestBlock("rtl", "e1", block([]))
		clock.advance(ACTIVITY_NOTIFY_MAX_DELAY_MS)
		const afterEdge = changes.length
		expect(afterEdge).toBe(n0 + 1) // live edge: live → not live
		for (let t = 0; t < ACTIVITY_HOT_HOLD_MS; t += 5_000) {
			clock.advance(5_000)
			// a constant unrelated live segment: no edge after the first block
			ranker.ingestBlock("rtl", "e1", { ...block([]), tracks: [] })
		}
		expect(changes.length).toBeGreaterThan(afterEdge)
	})

	it("keeps every state map bounded (at the cap and one past it)", () => {
		const { clock, ranker } = setup()
		ranker.ingestEpoch("rtl", "e1", 1)
		const many = Array.from(
			{ length: ACTIVITY_MAX_SEGMENTS + 1 },
			(_, i) => CENTRE + i * 20_000,
		)
		ranker.ingestBlock("rtl", "e1", block(many.slice(0, ACTIVITY_MAX_SEGMENTS)))
		expect(ranker.sizes().segments).toBe(ACTIVITY_MAX_SEGMENTS)
		ranker.ingestBlock("rtl", "e1", block(many))
		expect(ranker.sizes().segments).toBe(ACTIVITY_MAX_SEGMENTS)
		for (let i = 0; i <= ACTIVITY_MAX_TRACKS; i++)
			ranker.ingestTrack("rtl", "e1", {
				trackId: `k${i}`,
				epoch: 1,
				centreHz: CENTRE + i,
				gate: "passed",
				flags: { iqImage: false, spur: false },
			})
		expect(ranker.sizes().tracks).toBe(ACTIVITY_MAX_TRACKS)
		for (let i = 0; i <= ACTIVITY_MAX_NOTES; i++)
			ranker.noteDecode("rtl", CENTRE + i, "pocsag")
		expect(ranker.sizes().notes).toBe(ACTIVITY_MAX_NOTES)
		for (let i = 0; i <= ACTIVITY_MAX_INTERESTS; i++)
			ranker.port.snapshot([query({ decoderId: `d${i}` })], clock.now())
		expect(ranker.sizes().interests).toBe(ACTIVITY_MAX_INTERESTS)
		for (let i = 1; i < ACTIVITY_MAX_SOURCES; i++)
			ranker.ingestEpoch(`s${i}`, "e", 1)
		expect(ranker.sizes().sources).toBe(ACTIVITY_MAX_SOURCES)
		ranker.ingestEpoch("one-too-many", "e", 1)
		expect(ranker.sizes().sources).toBe(ACTIVITY_MAX_SOURCES)
		expect(ranker.epochOf("one-too-many")).toBeNull()
		ranker.dispose()
		expect(clock.pending()).toBe(0)
	})

	it("ingest per block stays O(tracks): bench", () => {
		const { ranker } = setup()
		ranker.ingestEpoch("rtl", "e1", 1)
		const blocks = [block(RASTER_HZ.slice(0, 8)), block(RASTER_HZ.slice(4, 12))]
		const n = 20_000
		const t0 = performance.now()
		for (let i = 0; i < n; i++) ranker.ingestBlock("rtl", "e1", blocks[i % 2]!)
		const perBlockUs = ((performance.now() - t0) / n) * 1000
		// 8 tracks per block; a generous bound for a shared CI host (20 blocks/s per source).
		expect(perBlockUs).toBeLessThan(200)
		process.stdout.write(
			`channel-activity ingest: ${perBlockUs.toFixed(2)} µs/block (8 tracks)\n`,
		)
	})
})

describe("review regressions", () => {
	it("overloaded blocks clear live evidence and never keep a source fresh (6 h of overload)", () => {
		const { clock, ranker } = setup()
		const a = RASTER_HZ[10]!
		ranker.ingestEpoch("rtl", "e1", 1)
		ranker.ingestBlock("rtl", "e1", block([a]))
		expect(one(ranker, query(), clock.now()).channels[10]!.live).toBe(true)
		for (let t = 0; t < 6 * 3_600_000; t += 60_000) {
			clock.advance(60_000)
			ranker.ingestBlock("rtl", "e1", block([a], { overload: true }))
		}
		const s = one(ranker, query(), clock.now())
		expect(s.status).toBe("stale")
		expect(s.channels[10]).toMatchObject({ live: false, state: "cold" })
		// the first overloaded block already clears live while still fresh
		const g = setup()
		g.ranker.ingestEpoch("rtl", "e1", 1)
		g.ranker.ingestBlock("rtl", "e1", block([a]))
		g.ranker.ingestBlock("rtl", "e1", block([a], { overload: true }))
		const fresh = one(g.ranker, query(), g.clock.now())
		expect(fresh.status).toBe("ready")
		expect(fresh.channels[10]!.live).toBe(false)
		expect(fresh.channels[10]!.state).toBe("hot")
	})

	it("live expires 1 000 ms after the last accepted block, ready or not", () => {
		const { clock, ranker } = setup()
		const a = RASTER_HZ[11]!
		ranker.ingestEpoch("rtl", "e1", 1)
		ranker.ingestBlock("rtl", "e1", block([a]))
		const t0 = clock.now()
		const live0 = one(ranker, query(), t0 + ACTIVITY_LIVE_TTL_MS - 1)
		expect(live0.channels[11]!.live).toBe(true)
		expect(live0.nextEvaluationMonoMs).toBe(t0 + ACTIVITY_LIVE_TTL_MS)
		expect(
			one(ranker, query(), t0 + ACTIVITY_LIVE_TTL_MS).channels[11]!.live,
		).toBe(false)
	})
})

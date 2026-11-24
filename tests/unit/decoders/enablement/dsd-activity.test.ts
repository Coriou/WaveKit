import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DSD_ANALOG_TRY_FAILURES,
	DSD_DECAY_LIVE_MS,
	DSD_DECAY_QUIET_MS,
	DSD_DIGITAL_HOLD_MS,
	DSD_DIGITAL_MEMORY_MS,
	DSD_LISTEN_WARMUP_MS,
	DSD_MAX_DEMOTIONS,
	DSD_MAX_RETRY_GROUPS,
	DSD_MAX_TIERS,
	DSD_QUIET_VICTIM_MS,
	DSD_RECLAIM_BUDGET,
	DSD_RECLAIM_RESERVE,
	DSD_RECLAIM_WINDOW_MS,
	DSD_TIER_RASTER_HZ,
	DSD_RETRY_TRIAL_GAP_MS,
	DSD_TRIAL_GAP_MS,
	DSD_TRY_MEMORY_MS,
	DSD_VICTIM_STOP_KILL_MS,
	DsdChannelTiers,
	dsdGroupKey,
	dsdNoSyncCooldownAfter,
	dsdNoSyncCooldownMs,
	dsdSyncProtectionUntil,
	dsdTierKey,
	dsdTrialLane,
	isDsdActivitySync,
} from "../../../../src/decoders/enablement/dsd-activity.js"
import {
	resolveActivityPolicy,
	selectChannels,
} from "../../../../src/decoders/enablement/activity-plan.js"

const policy = resolveActivityPolicy(undefined, 3, "x64", 8)

describe("dsd-fme no-sync dwell cooldown", () => {
	it("uses the larger of the move window and one dwell per move, including a zero move budget", () => {
		expect(dsdNoSyncCooldownMs(policy)).toBe(120_000)
		expect(dsdNoSyncCooldownMs({ ...policy, maxMovesPerMinute: 2 })).toBe(
			60_000,
		)
		expect(dsdNoSyncCooldownMs({ ...policy, maxMovesPerMinute: 0 })).toBe(
			60_000,
		)
		expect(dsdNoSyncCooldownMs({ ...policy, dwellMs: 70_000 })).toBe(420_000)
	})

	it.each([119_999, 120_000, 120_001])(
		"a first failure cools down strictly until its bound: %i ms",
		age => {
			const tiers = new DsdChannelTiers()
			tiers.noteFailure("slot", 137.3, policy)
			const [entry] = tiers.snapshot(137.3 + age, policy).tiers
			expect(entry).toMatchObject({ tier: "nosync", failures: 1 })
			expect(137.3 + age < entry!.untilMonoMs).toBe(age < 120_000)
		},
	)

	it.each([119_999, 120_000, 120_001])(
		"clean sync expires at/past its bound: %i",
		age => {
			expect(dsdSyncProtectionUntil(137.3, 137.3 + age, policy)).toBe(
				age < 120_000 ? 120_137.3 : null,
			)
		},
	)

	it.each([null, NaN, Infinity, 1000])(
		"missing/invalid/future clean sync is unprotected: %s",
		last => {
			expect(dsdSyncProtectionUntil(last, 100, policy)).toBeNull()
		},
	)

	it("accepts only checked CRC/FEC-clean sync evidence", () => {
		for (const protocol of ["dmr", "p25", "nxdn", "ysf", "dpmr", "dstar"])
			expect(
				isDsdActivitySync({ protocol, at: 7, crcErr: false, verified: true }),
			).toBe(true)
		for (const line of [
			{ protocol: "dmr", at: 7, crcErr: true, verified: true },
			{ protocol: "dmr", at: 7, crcErr: false, verified: true, fecErrs: 1 },
			{ protocol: "dmr", at: 7, crcErr: false, verified: true, fecErrs: -1 },
			{ protocol: "dmr", at: 7, crcErr: false },
			{ protocol: "dmr", at: 7, crcErr: false, verified: false },
			null,
			{},
			{ protocol: "pocsag", at: 7, crcErr: false },
			{ protocol: "dmr", at: NaN, crcErr: false },
		])
			expect(isDsdActivitySync(line)).toBe(false)
	})

	it("demotes live no-sync incumbents through the move budget and protects synced runs", () => {
		const activity = new Map(
			[10, 20].map(hz => [
				hz,
				{
					hz,
					score: hz === 10 ? 0 : 102,
					state: hz === 10 ? ("cold" as const) : ("hot" as const),
					live: hz !== 10,
					reasons: [],
					lastEnergyMonoMs: null,
					stateSinceMonoMs: 0,
				},
			]),
		)
		const args = {
			order: [20, 10],
			ranked: true,
			activity,
			count: 1,
			demotedHz: new Set([10]),
			incumbents: [{ key: "old", hz: 10, dwellSinceMonoMs: 137.3 }],
			nowMonoMs: 20_137.3,
			dwellMs: 20_000,
			movesLeft: 1,
			moveWindowFreesMonoMs: 60_137.3,
		}
		expect(
			selectChannels({ ...args, nowMonoMs: args.nowMonoMs - 1 }).moves,
		).toBe(0)
		expect(
			selectChannels({ ...args, nowMonoMs: args.nowMonoMs + 1 }).moves,
		).toBe(1)
		expect(selectChannels(args).chosen).toEqual([
			{ hz: 20, movedFrom: { key: "old", hz: 10 } },
		])
		expect(selectChannels({ ...args, movesLeft: 0 }).chosen).toEqual([
			{ hz: 10 },
		])
		expect(
			selectChannels({
				...args,
				incumbents: [{ ...args.incumbents[0]!, syncSeen: true }],
			}).chosen,
		).toEqual([{ hz: 10 }])
		expect(
			selectChannels({ ...args, order: [10], incumbents: [] }).chosen,
		).toEqual([])
	})
})

const key = (hz: number) => dsdTierKey("voice", "rtl", hz)!

describe("dsd-fme channel tiers (transition table)", () => {
	it("states the bounds", () => {
		expect(
			[1, 2, 3, 4, 5, 6, 50].map(n => dsdNoSyncCooldownAfter(n, policy)),
		).toEqual([
			120_000, 240_000, 480_000, 960_000, 1_920_000, 1_920_000, 1_920_000,
		])
		expect(dsdNoSyncCooldownAfter(DSD_ANALOG_TRY_FAILURES, policy)).toBe(
			1_920_000,
		)
		expect(dsdNoSyncCooldownAfter(0, policy)).toBe(120_000)
		expect(dsdNoSyncCooldownAfter(NaN, policy)).toBe(120_000)
		expect(DSD_DIGITAL_HOLD_MS).toBe(1_800_000)
		expect(DSD_DIGITAL_MEMORY_MS).toBe(21_600_000)
		expect(DSD_DECAY_QUIET_MS).toBe(3_600_000)
		expect(DSD_DECAY_LIVE_MS).toBe(600_000)
		expect(DSD_LISTEN_WARMUP_MS).toBe(2_000)
		expect(DSD_RECLAIM_BUDGET).toBe(2)
		expect(DSD_RECLAIM_WINDOW_MS).toBe(1_800_000)
		expect(DSD_RECLAIM_RESERVE).toBe(2)
		expect(DSD_QUIET_VICTIM_MS).toBe(60_000)
		expect(DSD_TRIAL_GAP_MS).toBe(300_000)
		expect(DSD_TRY_MEMORY_MS).toBe(21_600_000)
		expect(DSD_VICTIM_STOP_KILL_MS).toBe(1_000)
		expect(DSD_MAX_TIERS).toBe(256)
	})

	it("keys tiers by the candidate's own 6.25 kHz raster and only for a finite, positive frequency", () => {
		expect(DSD_TIER_RASTER_HZ).toBe(3_125)
		expect(key(446_006_250)).toBe(key(446_007_000))
		expect(key(446_006_250)).not.toBe(key(446_018_750))
		// A raster offset by 3 125 Hz from the 12.5 kHz grid (base + n × 6 250):
		// each channel keeps its own key, distinct from both grid neighbours.
		const grid = 446_000_000
		const offset = grid + 3_125
		expect(key(offset)).not.toBe(key(grid))
		expect(key(offset)).not.toBe(key(grid + 6_250))
		expect(key(offset + 6_250)).not.toBe(key(grid + 12_500))
		// At most 1 562.5 Hz off, ties upward.
		expect(key(offset + 1_562)).toBe(key(offset))
		expect(key(offset - 1_562)).toBe(key(offset))
		expect(key(offset + 1_562.5)).toBe(key(offset + 3_125))
		expect(key(offset - 1_562.5)).toBe(key(offset))
		for (const hz of [NaN, Infinity, -1, 0])
			expect(dsdTierKey("voice", "rtl", hz)).toBeNull()
	})

	it("each failure of a channel never synced needs a re-try to escalate; a sync resets", () => {
		const tiers = new DsdChannelTiers()
		const k = key(446_006_250)
		let now = 1_000
		for (const n of [1, 2, 3, 4, 5, 6]) {
			tiers.noteFailure(k, now, policy)
			const [e] = tiers.snapshot(now, policy).tiers
			expect(e).toMatchObject({ tier: "nosync", failures: n, notedMonoMs: now })
			expect(e!.untilMonoMs - now).toBe(dsdNoSyncCooldownAfter(n, policy))
			now = e!.untilMonoMs + 1
		}
		expect(tiers.noteSync(k, now)).toBe(true)
		expect(tiers.noteSync(k, now + 1)).toBe(false)
		expect(tiers.snapshot(now + 1, policy).tiers[0]).toMatchObject({
			tier: "digital",
			failures: 0,
			lastSyncMonoMs: now + 1,
			decayed: false,
			quietMs: 0,
			reclaims: 0,
		})
	})

	it("a failed run that goes on renews its cooldown from now, failures unchanged", () => {
		const tiers = new DsdChannelTiers()
		const k = key(446_006_250)
		tiers.noteFailure(k, 0, policy)
		tiers.renewFailure(k, 1_000_000, policy)
		const snap = tiers.snapshot(1_000_000, policy)
		expect(snap.tiers[0]).toMatchObject({
			failures: 1,
			untilMonoMs: 1_000_000 + 120_000,
			notedMonoMs: 1_000_000,
		})
		// Never shortens a cooldown; no entry, a remembered undecayed entry or a
		// bad clock: no-op.
		tiers.renewFailure(k, 1_000_001 - 120_000, policy)
		expect(tiers.snapshot(1_000_000, policy).tiers[0]!.untilMonoMs).toBe(
			1_120_000,
		)
		tiers.renewFailure(key(446_018_750), 5, policy)
		tiers.noteSync(key(446_106_250), 0)
		tiers.renewFailure(key(446_106_250), 5, policy)
		tiers.renewFailure(k, NaN, policy)
		expect(tiers.snapshot(1_000_000, policy).tiers.map(t => t.tier)).toEqual([
			"nosync",
			"digital",
		])
	})

	it.each([0, 1, DSD_DIGITAL_HOLD_MS, 2 * DSD_DIGITAL_HOLD_MS])(
		"a failure of a remembered channel that has not decayed leaves it unchanged (%i ms after the sync)",
		at => {
			const tiers = new DsdChannelTiers()
			const k = key(446_106_250)
			tiers.noteSync(k, 0)
			tiers.noteFailure(k, at, policy)
			tiers.noteFailure(k, at + policy.dwellMs, policy)
			expect(
				tiers.snapshot(at + policy.dwellMs, policy).tiers[0],
			).toMatchObject({
				tier: "digital",
				lastSyncMonoMs: 0,
				failures: 0,
				decayed: false,
			})
			expect(tiers.held(k, at + policy.dwellMs)).toBe(
				at + policy.dwellMs < DSD_DIGITAL_HOLD_MS,
			)
		},
	)

	it.each([-1, 0])(
		"decays at 60 min of listened quiet (%i ms), keeps the last sync, and failures then escalate",
		d => {
			const tiers = new DsdChannelTiers()
			const k = key(446_106_250)
			tiers.noteSync(k, 0)
			// Listened in two stretches with a 1 h gap nobody listened in.
			expect(tiers.account(k, 0, DSD_DECAY_QUIET_MS / 2, false)).toBe(false)
			const later = 2 * DSD_DECAY_QUIET_MS
			const decays = tiers.account(
				k,
				later,
				later + DSD_DECAY_QUIET_MS / 2 + d,
				false,
			)
			expect(decays).toBe(d === 0)
			const now = later + DSD_DECAY_QUIET_MS / 2 + d
			expect(tiers.snapshot(now, policy).tiers[0]).toMatchObject({
				tier: "digital",
				lastSyncMonoMs: 0,
				decayed: d === 0,
				quietMs: DSD_DECAY_QUIET_MS + d,
			})
			expect(tiers.held(k, 1)).toBe(d !== 0)
			tiers.noteFailure(k, now, policy)
			expect(tiers.snapshot(now, policy).tiers[0]!.failures).toBe(
				d === 0 ? 1 : 0,
			)
		},
	)

	it.each([-1, 0])(
		"decays at 10 min of energized listening (%i ms); time before the sync or counted twice is not counted",
		d => {
			const tiers = new DsdChannelTiers()
			const k = key(446_106_250)
			tiers.noteSync(k, 1_000)
			// Before the sync: nothing. A VFO and a slot over one stretch: once.
			tiers.account(k, 0, 1_000, true)
			tiers.account(k, 1_000, 1_000 + DSD_DECAY_LIVE_MS / 2, true)
			tiers.account(k, 1_000, 1_000 + DSD_DECAY_LIVE_MS / 2, true)
			tiers.account(
				k,
				1_000 + DSD_DECAY_LIVE_MS / 2,
				1_000 + DSD_DECAY_LIVE_MS + d,
				true,
			)
			expect(
				tiers.snapshot(1_000 + DSD_DECAY_LIVE_MS + d, policy).tiers[0],
			).toMatchObject({
				decayed: d === 0,
				quietMs: DSD_DECAY_LIVE_MS + d,
				quietLiveMs: DSD_DECAY_LIVE_MS + d,
			})
		},
	)

	it.each([-1, 0, 1])(
		"remembers a sync strictly within 6 h (%i ms); failures stay 6 h after the last try",
		d => {
			const tiers = new DsdChannelTiers()
			const k = key(446_106_250)
			tiers.noteSync(k, 0)
			tiers.account(k, 0, DSD_DECAY_QUIET_MS, false)
			tiers.noteFailure(k, DSD_DECAY_QUIET_MS, policy)
			const at = DSD_DIGITAL_MEMORY_MS + d
			const [e] = tiers.snapshot(at, policy).tiers
			expect(e!.tier).toBe(d < 0 ? "digital" : "nosync")
			expect(e!.lastSyncMonoMs).toBe(d < 0 ? 0 : undefined)
			expect(e!.failures).toBe(1)
			// The entry goes 6 h after its last try.
			expect(
				tiers.snapshot(DSD_DECAY_QUIET_MS + DSD_TRY_MEMORY_MS + d, policy)
					.tiers,
			).toHaveLength(d < 0 ? 1 : 0)
		},
	)

	it.each([-1, 0, 1])(
		"failures are kept strictly 6 h after the last try (%i ms), then reset",
		d => {
			const tiers = new DsdChannelTiers()
			const k = key(446_006_250)
			tiers.noteFailure(k, 0, policy)
			const at = DSD_TRY_MEMORY_MS + d
			expect(tiers.snapshot(at, policy).tiers).toHaveLength(d < 0 ? 1 : 0)
			tiers.noteFailure(k, at, policy)
			expect(tiers.snapshot(at, policy).tiers[0]!.failures).toBe(d < 0 ? 2 : 1)
		},
	)

	it.each([-1, 0, 1])(
		"group gates: fresh trial and burst strictly within 300 s, retry within 600 s, analog strictly within 1 920 s (%i ms)",
		d => {
			expect(DSD_RETRY_TRIAL_GAP_MS).toBe(600_000)
			const tiers = new DsdChannelTiers()
			const g = dsdGroupKey("voice", "rtl")
			tiers.noteTrial(g, "trial:fresh", 0)
			tiers.noteTrial(g, "burst:fresh", 0)
			tiers.noteTrial(g, "trial:retry", 0)
			tiers.noteTrial(g, "burst:retry", 0)
			const gates = (at: number) =>
				tiers
					.snapshot(at, policy)
					.trials.map(t => t.gate)
					.sort()
			// Each lane keeps its own time: the fresh gates go at 300 s, the
			// retry gates stay until 600 s.
			expect(gates(DSD_TRIAL_GAP_MS + d)).toEqual(
				d < 0
					? ["burst:fresh", "burst:retry", "trial:fresh", "trial:retry"]
					: ["burst:retry", "trial:retry"],
			)
			expect(gates(DSD_RETRY_TRIAL_GAP_MS + d)).toEqual(
				d < 0 ? ["burst:retry", "trial:retry"] : [],
			)
			expect(dsdTrialLane(0, null)).toBe("fresh")
			expect(dsdTrialLane(1, null)).toBe("retry")
			expect(dsdTrialLane(0, 5)).toBe("retry")
			const t2 = new DsdChannelTiers()
			t2.noteAnalogRetry(g, 0)
			expect(t2.snapshot(1_920_000 + d, policy).analogRetries).toHaveLength(
				d < 0 ? 1 : 0,
			)
		},
	)

	it("reclaims count in a 30 min window and a sync resets them", () => {
		const tiers = new DsdChannelTiers()
		const k = key(446_106_250)
		tiers.noteReclaim(k, 0)
		expect(tiers.snapshot(0, policy).tiers).toEqual([])
		tiers.noteSync(k, 0)
		tiers.noteReclaim(k, 10)
		tiers.noteReclaim(k, 20)
		expect(tiers.snapshot(20, policy).tiers[0]).toMatchObject({
			reclaims: 2,
			reclaimWindowMonoMs: 10,
		})
		tiers.noteReclaim(k, 10 + DSD_RECLAIM_WINDOW_MS - 1)
		expect(tiers.snapshot(30, policy).tiers[0]!.reclaims).toBe(3)
		tiers.noteReclaim(k, 10 + DSD_RECLAIM_WINDOW_MS)
		expect(tiers.snapshot(30, policy).tiers[0]).toMatchObject({
			reclaims: 1,
			reclaimWindowMonoMs: 10 + DSD_RECLAIM_WINDOW_MS,
		})
		tiers.noteSync(k, 2 * DSD_RECLAIM_WINDOW_MS)
		expect(
			tiers.snapshot(2 * DSD_RECLAIM_WINDOW_MS, policy).tiers[0],
		).toMatchObject({ reclaims: 0 })
	})

	it("keeps exactly 256 tiers and 256 group gates; drops past the bound", () => {
		const tiers = new DsdChannelTiers()
		for (let i = 0; i < DSD_MAX_TIERS; i++) {
			tiers.noteFailure(key(400_000_000 + i * 6_250), i, policy)
			tiers.noteAnalogRetry(dsdGroupKey(`d${i}`, "rtl"), i)
		}
		let snap = tiers.snapshot(300, policy)
		expect(snap.tiers).toHaveLength(256)
		expect(snap.analogRetries).toHaveLength(DSD_MAX_RETRY_GROUPS)
		tiers.noteFailure(key(500_000_000), 300, policy)
		tiers.noteAnalogRetry(dsdGroupKey("extra", "rtl"), 300)
		snap = tiers.snapshot(300, policy)
		expect(snap.tiers).toHaveLength(256)
		expect(snap.analogRetries).toHaveLength(256)
		expect(snap.tiers.some(e => e.key === key(400_000_000))).toBe(false)
		expect(
			snap.analogRetries.some(e => e.groupKey === dsdGroupKey("d0", "rtl")),
		).toBe(false)
		expect(DSD_MAX_DEMOTIONS).toBe(256)
	})

	it("past the bound sweeps forgotten entries before evicting a live one", () => {
		const tiers = new DsdChannelTiers()
		const hz = (i: number) => 400_000_000 + i * 6_250
		// One failure at t = 0 (forgotten 6 h later), then 255 synced entries.
		tiers.noteFailure(key(hz(0)), 0, policy)
		for (let i = 1; i < DSD_MAX_TIERS; i++) tiers.noteSync(key(hz(i)), 1e6)
		const forget = DSD_TRY_MEMORY_MS
		tiers.noteFailure(key(hz(500)), forget, policy)
		const snap = tiers.snapshot(forget, policy).tiers
		expect(snap).toHaveLength(DSD_MAX_TIERS)
		expect(snap.some(t => t.key === key(hz(0)))).toBe(false)
		for (let i = 1; i < DSD_MAX_TIERS; i++)
			expect(snap.some(t => t.key === key(hz(i)))).toBe(true)
	})

	it("eviction: entries without a sync go first, oldest try first, then the oldest sync", () => {
		const hz = (i: number) => 400_000_000 + i * 6_250
		// 255 synced entries + one failed entry tried at 0: the failed one goes.
		const a = new DsdChannelTiers()
		a.noteFailure(key(hz(0)), 0, policy)
		for (let i = 1; i < DSD_MAX_TIERS; i++) a.noteSync(key(hz(i)), i)
		a.noteSync(key(hz(900)), 300)
		let snap = a.snapshot(300, policy).tiers
		expect(snap).toHaveLength(DSD_MAX_TIERS)
		expect(snap.some(t => t.key === key(hz(0)))).toBe(false)
		// Two failed entries: the one tried longer ago goes, whatever was written last.
		const b = new DsdChannelTiers()
		b.noteFailure(key(hz(0)), 50, policy)
		b.noteFailure(key(hz(1)), 10, policy)
		for (let i = 2; i < DSD_MAX_TIERS; i++) b.noteSync(key(hz(i)), i)
		b.noteSync(key(hz(900)), 300)
		snap = b.snapshot(300, policy).tiers
		expect(snap.some(t => t.key === key(hz(1)))).toBe(false)
		expect(snap.some(t => t.key === key(hz(0)))).toBe(true)
		// Only synced entries: the oldest sync goes, the new one survives.
		const c = new DsdChannelTiers()
		for (let i = 0; i < DSD_MAX_TIERS; i++) c.noteSync(key(hz(i)), 1_000 - i)
		c.noteSync(key(hz(900)), 2_000)
		snap = c.snapshot(2_000, policy).tiers
		expect(snap.some(t => t.key === key(hz(DSD_MAX_TIERS - 1)))).toBe(false)
		expect(snap.some(t => t.key === key(hz(900)))).toBe(true)
	})

	it("drops every entry of a source removed for good", () => {
		const tiers = new DsdChannelTiers()
		tiers.noteSync(dsdTierKey("voice", "a", 446_106_250)!, 0)
		tiers.noteFailure(dsdTierKey("voice", "a", 446_006_250)!, 0, policy)
		tiers.noteAnalogRetry(dsdGroupKey("voice", "a"), 0)
		tiers.noteTrial(dsdGroupKey("voice", "a"), "trial:fresh", 0)
		tiers.noteSync(dsdTierKey("voice", "b", 446_106_250)!, 0)
		tiers.dropSource("a")
		const snap = tiers.snapshot(1, policy)
		expect(snap.tiers.map(t => t.key)).toEqual([
			dsdTierKey("voice", "b", 446_106_250),
		])
		expect(snap.trials).toEqual([])
		expect(snap.analogRetries).toEqual([])
	})

	it("ignores non-finite clocks", () => {
		const tiers = new DsdChannelTiers()
		expect(tiers.noteSync(key(446_106_250), NaN)).toBe(false)
		tiers.noteFailure(key(446_006_250), Infinity, policy)
		tiers.noteAnalogRetry(dsdGroupKey("voice", "rtl"), NaN)
		tiers.noteReclaim(key(446_106_250), NaN)
		expect(tiers.account(key(446_106_250), 0, NaN, true)).toBe(false)
		expect(tiers.snapshot(0, policy)).toEqual({
			tiers: [],
			analogRetries: [],
			trials: [],
		})
	})

	it("never evicts the entry just written; at most 256 kept", () => {
		// Feature: dsd-digital-tiers, Property 1: the bound holds and the newest write survives
		// Validates: Requirements 3.22
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						ch: fc.integer({ min: 0, max: 400 }),
						sync: fc.boolean(),
					}),
					{ minLength: 1, maxLength: 700 },
				),
				ops => {
					const tiers = new DsdChannelTiers()
					let now = 0
					for (const op of ops) {
						now += 1
						const k = key(400_000_000 + op.ch * 6_250)
						if (op.sync) tiers.noteSync(k, now)
						else tiers.noteFailure(k, now, policy)
						const after = tiers.snapshot(now, policy).tiers
						expect(after.length).toBeLessThanOrEqual(DSD_MAX_TIERS)
						expect(after.some(t => t.key === k)).toBe(true)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

/** Random operations on one channel: sync, listened stretch, failure, reclaim. */
const opArb = fc.oneof(
	fc.record({
		op: fc.constant("sync" as const),
		dt: fc.integer({ min: 0, max: 600_000 }),
	}),
	fc.record({
		op: fc.constant("listen" as const),
		dt: fc.integer({ min: 0, max: 900_000 }),
		len: fc.integer({ min: 0, max: 900_000 }),
		live: fc.boolean(),
	}),
	fc.record({
		op: fc.constant("fail" as const),
		dt: fc.integer({ min: 0, max: 600_000 }),
	}),
	fc.record({
		op: fc.constant("reclaim" as const),
		dt: fc.integer({ min: 0, max: 600_000 }),
	}),
)

describe("dsd-fme listened-time decay (properties)", () => {
	it("P1: no decay before 60 min of listened quiet or 10 min of energized listened quiet", () => {
		// Feature: dsd-digital-tiers, Property 1: decay only past the listened bounds
		// Validates: Requirements 3.3
		fc.assert(
			fc.property(fc.array(opArb, { maxLength: 60 }), ops => {
				const tiers = new DsdChannelTiers()
				const k = key(446_106_250)
				let now = 0
				tiers.noteSync(k, now)
				let quiet = 0
				let live = 0
				for (const o of ops) {
					now += o.dt
					if (o.op === "sync") {
						tiers.noteSync(k, now)
						quiet = 0
						live = 0
					} else if (o.op === "listen") {
						tiers.account(k, now, now + o.len, o.live)
						now += o.len
						quiet += o.len
						if (o.live) live += o.len
					} else if (o.op === "fail") tiers.noteFailure(k, now, policy)
					else tiers.noteReclaim(k, now)
					const e = tiers.snapshot(now, policy).tiers[0]
					if (now >= DSD_DIGITAL_MEMORY_MS || !e || e.tier !== "digital") return
					expect(e.decayed).toBe(
						quiet >= DSD_DECAY_QUIET_MS || live >= DSD_DECAY_LIVE_MS,
					)
					expect(e.quietMs).toBe(quiet)
				}
			}),
			{ numRuns: 200 },
		)
	})

	it("P2: the last sync is only ever cleared 6 h after it; P3: failures never grow while remembered and not decayed", () => {
		// Feature: dsd-digital-tiers, Property 2: lastSync survives every event but its 6 h memory
		// Validates: Requirements 3.4
		// Feature: dsd-digital-tiers, Property 3: no failures while remembered-undecayed
		// Validates: Requirements 3.5
		fc.assert(
			fc.property(fc.array(opArb, { maxLength: 60 }), ops => {
				const tiers = new DsdChannelTiers()
				const k = key(446_106_250)
				let now = 0
				let last = 0
				tiers.noteSync(k, now)
				for (const o of ops) {
					now += o.dt
					const before = tiers.snapshot(now, policy).tiers[0]
					if (o.op === "sync") {
						tiers.noteSync(k, now)
						last = now
					} else if (o.op === "listen") {
						tiers.account(k, now, now + o.len, o.live)
						now += o.len
					} else if (o.op === "fail") tiers.noteFailure(k, now, policy)
					else tiers.noteReclaim(k, now)
					const e = tiers.snapshot(now, policy).tiers[0]
					if (now - last < DSD_DIGITAL_MEMORY_MS)
						expect(e?.lastSyncMonoMs).toBe(last)
					else expect(e?.lastSyncMonoMs).toBeUndefined()
					if (
						o.op === "fail" &&
						before?.tier === "digital" &&
						before.decayed === false &&
						now - last < DSD_DIGITAL_MEMORY_MS
					)
						expect(e!.failures).toBe(before.failures)
				}
			}),
			{ numRuns: 200 },
		)
	})

	it("P4: counted quiet never exceeds the listened wall time; a sync resets it", () => {
		// Feature: dsd-digital-tiers, Property 4: Σ Δ <= listened wall time
		// Validates: Requirements 3.3
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						from: fc.integer({ min: 0, max: 7_200_000 }),
						len: fc.integer({ min: 0, max: 600_000 }),
						live: fc.boolean(),
					}),
					{ maxLength: 40 },
				),
				fc.integer({ min: 0, max: 7_200_000 }),
				(stretches, syncAt) => {
					const tiers = new DsdChannelTiers()
					const k = key(446_106_250)
					tiers.noteSync(k, 0)
					// Overlapping stretches (a VFO and a slot) in time order.
					const sorted = [...stretches].sort((a, b) => a.from - b.from)
					let synced = false
					let union = 0
					let reach = 0
					for (const s of sorted) {
						if (!synced && s.from >= syncAt) {
							tiers.noteSync(k, syncAt)
							synced = true
							union = 0
							reach = syncAt
						}
						const end = s.from + s.len
						union += Math.max(0, end - Math.max(s.from, reach))
						reach = Math.max(reach, end)
						tiers.account(k, s.from, end, s.live)
						const e = tiers.snapshot(end, policy).tiers[0]!
						expect(e.quietMs).toBeLessThanOrEqual(union)
						expect(e.quietLiveMs).toBeLessThanOrEqual(e.quietMs!)
					}
				},
			),
			{ numRuns: 200 },
		)
	})

	it("P5: at most 2 live reclaims per 30 min without a sync", () => {
		// Feature: dsd-digital-tiers, Property 5: reclaim budget
		// Validates: Requirements 3.6
		fc.assert(
			fc.property(
				fc.array(fc.integer({ min: 0, max: 900_000 }), { maxLength: 40 }),
				gaps => {
					const tiers = new DsdChannelTiers()
					const k = key(446_106_250)
					tiers.noteSync(k, 0)
					let now = 0
					const entries: number[] = []
					for (const gap of gaps) {
						now += gap
						const e = tiers.snapshot(now, policy).tiers[0]!
						const ok =
							e.reclaimWindowMonoMs === undefined ||
							now - e.reclaimWindowMonoMs >= DSD_RECLAIM_WINDOW_MS ||
							e.reclaims! < DSD_RECLAIM_BUDGET
						if (ok) {
							tiers.noteReclaim(k, now)
							entries.push(now)
						}
					}
					for (const t of entries)
						expect(
							entries.filter(x => x >= t && x < t + DSD_RECLAIM_WINDOW_MS)
								.length,
						).toBeLessThanOrEqual(2 * DSD_RECLAIM_BUDGET)
					// Within one window from its start: at most the budget.
					const first = entries[0]
					if (first !== undefined)
						expect(
							entries.filter(x => x < first + DSD_RECLAIM_WINDOW_MS).length,
						).toBeLessThanOrEqual(DSD_RECLAIM_BUDGET)
				},
			),
			{ numRuns: 200 },
		)
	})
})

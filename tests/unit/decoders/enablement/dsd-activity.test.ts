import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	DSD_ANALOG_TRY_FAILURES,
	DSD_DIGITAL_DECAY_FAILURES,
	DSD_DIGITAL_HOLD_MS,
	DSD_DIGITAL_MEMORY_MS,
	DSD_MAX_DEMOTIONS,
	DSD_MAX_RETRY_GROUPS,
	DSD_MAX_TIERS,
	DSD_NOSYNC_FORGET_MS,
	DSD_TIER_RASTER_HZ,
	DSD_TRY_MEMORY_MS,
	DsdChannelTiers,
	dsdGroupKey,
	dsdNoSyncCooldownAfter,
	dsdNoSyncCooldownMs,
	dsdSyncProtectionUntil,
	dsdTierKey,
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
	it("escalates the no-sync cooldown 120, 240, 480, 960, 1 920 s and caps it", () => {
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
		expect(DSD_NOSYNC_FORGET_MS).toBe(900_000)
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

	it("each failure needs a re-try to escalate; a sync resets to digital", () => {
		const tiers = new DsdChannelTiers()
		const k = key(446_006_250)
		let now = 1_000
		for (const n of [1, 2, 3, 4, 5, 6]) {
			tiers.noteFailure(k, now, policy)
			const [e] = tiers.snapshot(now, policy).tiers
			expect(e).toMatchObject({ failures: n, notedMonoMs: now })
			expect(e!.untilMonoMs - now).toBe(dsdNoSyncCooldownAfter(n, policy))
			now = e!.untilMonoMs + 1
		}
		expect(tiers.noteSync(k, now)).toBe(true)
		expect(tiers.noteSync(k, now + 1)).toBe(false)
		expect(tiers.snapshot(now + 1, policy).tiers[0]).toMatchObject({
			tier: "digital",
			failures: 0,
			lastSyncMonoMs: now + 1,
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
		})
		expect(snap.tries).toEqual([{ key: k, atMonoMs: 1_000_000 }])
		// Never shortens a cooldown; no entry, a digital entry or a bad clock: no-op.
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

	it("a failure on a held digital channel leaves it unchanged (quiet between bursts)", () => {
		const tiers = new DsdChannelTiers()
		const k = key(446_106_250)
		tiers.noteSync(k, 0)
		tiers.noteFailure(k, 60_000, policy)
		tiers.noteFailure(k, DSD_DIGITAL_HOLD_MS - 1, policy)
		expect(
			tiers.snapshot(DSD_DIGITAL_HOLD_MS - 1, policy).tiers[0],
		).toMatchObject({ tier: "digital", lastSyncMonoMs: 0, failures: 0 })
	})

	it.each([0, 1])(
		"past the 30 min hold (+%i ms) failures count; the second turns digital into nosync",
		d => {
			expect(DSD_DIGITAL_DECAY_FAILURES).toBe(2)
			const tiers = new DsdChannelTiers()
			const k = key(446_106_250)
			tiers.noteSync(k, 0)
			const first = DSD_DIGITAL_HOLD_MS + d
			tiers.noteFailure(k, first, policy)
			expect(tiers.snapshot(first, policy).tiers[0]).toMatchObject({
				tier: "digital",
				failures: 1,
				lastSyncMonoMs: 0,
				notedMonoMs: first,
			})
			// The earliest second failed run: one 20 s dwell later.
			const second = first + policy.dwellMs
			tiers.noteFailure(k, second, policy)
			const [e] = tiers.snapshot(second, policy).tiers
			expect(e).toMatchObject({ tier: "nosync", failures: 2 })
			// cooldown(2) = 240 s; at the earliest 1 800 000 + 20 000 ms after the sync.
			expect(e!.untilMonoMs - second).toBe(240_000)
			expect(second).toBe(1_820_000 + d)
			expect(tiers.held(k, second)).toBe(false)
			// It then escalates as any nosync entry.
			tiers.noteFailure(k, e!.untilMonoMs, policy)
			expect(tiers.snapshot(e!.untilMonoMs, policy).tiers[0]).toMatchObject({
				failures: 3,
			})
		},
	)

	it("a sync past the hold resets the decay count", () => {
		const tiers = new DsdChannelTiers()
		const k = key(446_106_250)
		tiers.noteSync(k, 0)
		tiers.noteFailure(k, DSD_DIGITAL_HOLD_MS, policy)
		tiers.noteSync(k, DSD_DIGITAL_HOLD_MS + 1)
		// The next failure lies within the renewed hold: unchanged.
		tiers.noteFailure(k, DSD_DIGITAL_HOLD_MS + 2, policy)
		expect(
			tiers.snapshot(DSD_DIGITAL_HOLD_MS + 2, policy).tiers[0],
		).toMatchObject({ tier: "digital", failures: 0 })
		// Past the renewed hold one failure keeps it digital (count 1, not 2).
		const later = 2 * DSD_DIGITAL_HOLD_MS + 1
		tiers.noteFailure(k, later, policy)
		expect(tiers.snapshot(later, policy).tiers[0]).toMatchObject({
			tier: "digital",
			failures: 1,
		})
	})

	it.each([-1, 0, 1])(
		"holds a digital channel strictly within 30 min and remembers it strictly within 6 h (%i ms)",
		d => {
			const tiers = new DsdChannelTiers()
			const k = key(446_106_250)
			tiers.noteSync(k, 0)
			expect(tiers.held(k, DSD_DIGITAL_HOLD_MS + d)).toBe(d < 0)
			expect(
				tiers.snapshot(DSD_DIGITAL_MEMORY_MS + d, policy).tiers,
			).toHaveLength(d < 0 ? 1 : 0)
		},
	)

	it.each([-1, 0, 1])(
		"forgets a no-sync entry strictly at until + 15 min (%i ms), failures reset",
		d => {
			const tiers = new DsdChannelTiers()
			const k = key(446_006_250)
			tiers.noteFailure(k, 0, policy)
			const at = 120_000 + DSD_NOSYNC_FORGET_MS + d
			expect(tiers.snapshot(at, policy).tiers).toHaveLength(d < 0 ? 1 : 0)
			tiers.noteFailure(k, at, policy)
			expect(tiers.snapshot(at, policy).tiers[0]!.failures).toBe(d < 0 ? 2 : 1)
		},
	)

	it.each([-1, 0, 1])(
		"keeps try times strictly within 6 h (%i ms) and the group try strictly within 1 920 s",
		d => {
			const tiers = new DsdChannelTiers()
			tiers.noteFailure(key(446_006_250), 0, policy)
			tiers.noteAnalogRetry(dsdGroupKey("voice", "rtl"), 0)
			expect(tiers.snapshot(DSD_TRY_MEMORY_MS + d, policy).tries).toHaveLength(
				d < 0 ? 1 : 0,
			)
			const t2 = new DsdChannelTiers()
			t2.noteAnalogRetry(dsdGroupKey("voice", "rtl"), 0)
			expect(t2.snapshot(1_920_000 + d, policy).analogRetries).toHaveLength(
				d < 0 ? 1 : 0,
			)
		},
	)

	it("keeps exactly 256 tiers, 256 try times and 256 group tries; drops past the bound", () => {
		const tiers = new DsdChannelTiers()
		for (let i = 0; i < DSD_MAX_TIERS; i++) {
			tiers.noteFailure(key(400_000_000 + i * 6_250), i, policy)
			tiers.noteAnalogRetry(dsdGroupKey(`d${i}`, "rtl"), i)
		}
		let snap = tiers.snapshot(300, policy)
		expect(snap.tiers).toHaveLength(256)
		expect(snap.tries).toHaveLength(256)
		expect(snap.analogRetries).toHaveLength(DSD_MAX_RETRY_GROUPS)
		tiers.noteFailure(key(500_000_000), 300, policy)
		tiers.noteAnalogRetry(dsdGroupKey("extra", "rtl"), 300)
		snap = tiers.snapshot(300, policy)
		expect(snap.tiers).toHaveLength(256)
		expect(snap.tries).toHaveLength(256)
		expect(snap.analogRetries).toHaveLength(256)
		expect(snap.tiers.some(e => e.key === key(400_000_000))).toBe(false)
		expect(snap.tries.some(e => e.key === key(400_000_000))).toBe(false)
		expect(
			snap.analogRetries.some(e => e.groupKey === dsdGroupKey("d0", "rtl")),
		).toBe(false)
		expect(DSD_MAX_DEMOTIONS).toBe(256)
	})

	it("a renewed failure keeps try times at 256 when it re-adds a trimmed try", () => {
		const tiers = new DsdChannelTiers()
		const hz = (i: number) => 400_000_000 + i * 6_250
		const x = key(hz(0))
		// X fails 5 times (cooldown(5) = 1,920 s): its nosync entry lives until
		// 4 ms + 1,920 s + 15 min = 2,820,004 ms (last failure at 4 ms).
		for (let t = 0; t < 5; t++) tiers.noteFailure(x, t, policy)
		// y1 fails at 10 ms and is forgotten at 10 ms + cooldown(1) 120 s +
		// 15 min = 1,020,010 ms, swept by the snapshot at 1,100,000 ms (its
		// try time stays 6 h).
		tiers.noteFailure(key(hz(1)), 10, policy)
		expect(tiers.snapshot(1_100_000, policy).tiers).toHaveLength(1)
		// y2..y256 fail: 257 try keys trim X, the oldest; entries are X plus
		// 255 = 256, so X's entry lives.
		for (let i = 2; i <= DSD_MAX_TIERS; i++)
			tiers.noteFailure(key(hz(i)), 1_100_000 + i, policy)
		let snap = tiers.snapshot(1_200_000, policy)
		expect(snap.tries).toHaveLength(DSD_MAX_TIERS)
		expect(snap.tries.some(e => e.key === x)).toBe(false)
		expect(snap.tiers.some(e => e.key === x && e.tier === "nosync")).toBe(true)
		// The still-running failed run of X renews: its try is re-added and
		// the oldest other try goes, 256 kept, X's newest.
		tiers.renewFailure(x, 1_200_000, policy)
		snap = tiers.snapshot(1_200_000, policy)
		expect(snap.tries).toHaveLength(DSD_MAX_TIERS)
		expect(snap.tries.at(-1)).toEqual({ key: x, atMonoMs: 1_200_000 })
		expect(snap.tries.some(e => e.key === key(hz(1)))).toBe(false)
	})

	it("past the bound sweeps forgotten entries before evicting a live one", () => {
		const tiers = new DsdChannelTiers()
		const hz = (i: number) => 400_000_000 + i * 6_250
		// One nosync at t = 0 (forgotten at cooldown(1) + 15 min = 1,020 s),
		// then 255 digital entries written at t = 1,000,000 (6 h memory).
		tiers.noteFailure(key(hz(0)), 0, policy)
		const forget = dsdNoSyncCooldownAfter(1, policy) + DSD_NOSYNC_FORGET_MS
		for (let i = 1; i < DSD_MAX_TIERS; i++) tiers.noteSync(key(hz(i)), 1e6)
		// 257th write at the forget time: the forgotten entry goes, no live one.
		tiers.noteFailure(key(hz(500)), forget, policy)
		const snap = tiers.snapshot(forget, policy).tiers
		expect(snap).toHaveLength(DSD_MAX_TIERS)
		expect(snap.some(t => t.key === key(hz(0)))).toBe(false)
		for (let i = 1; i < DSD_MAX_TIERS; i++)
			expect(snap.some(t => t.key === key(hz(i)))).toBe(true)
		expect(snap.some(t => t.key === key(hz(500)))).toBe(true)
	})

	it("a new nosync never evicts itself: the oldest other nosync goes, else the oldest digital", () => {
		const hz = (i: number) => 400_000_000 + i * 6_250
		// 256 live digital entries: the new nosync survives, the oldest digital goes.
		const a = new DsdChannelTiers()
		for (let i = 0; i < DSD_MAX_TIERS; i++) a.noteSync(key(hz(i)), i)
		a.noteFailure(key(hz(900)), 300, policy)
		let snap = a.snapshot(300, policy).tiers
		expect(snap).toHaveLength(DSD_MAX_TIERS)
		expect(snap.find(t => t.key === key(hz(900)))?.tier).toBe("nosync")
		expect(snap.some(t => t.key === key(hz(0)))).toBe(false)
		expect(snap.some(t => t.key === key(hz(1)))).toBe(true)
		// 255 digital entries + one older nosync: that nosync goes, every digital stays.
		const b = new DsdChannelTiers()
		b.noteFailure(key(hz(0)), 0, policy)
		for (let i = 1; i < DSD_MAX_TIERS; i++) b.noteSync(key(hz(i)), i)
		b.noteFailure(key(hz(900)), 300, policy)
		snap = b.snapshot(300, policy).tiers
		expect(snap).toHaveLength(DSD_MAX_TIERS)
		expect(snap.some(t => t.key === key(hz(0)))).toBe(false)
		expect(snap.filter(t => t.tier === "digital")).toHaveLength(
			DSD_MAX_TIERS - 1,
		)
		expect(snap.some(t => t.key === key(hz(900)))).toBe(true)
	})

	it("drops every entry of a source removed for good", () => {
		const tiers = new DsdChannelTiers()
		tiers.noteSync(dsdTierKey("voice", "a", 446_106_250)!, 0)
		tiers.noteFailure(dsdTierKey("voice", "a", 446_006_250)!, 0, policy)
		tiers.noteAnalogRetry(dsdGroupKey("voice", "a"), 0)
		tiers.noteSync(dsdTierKey("voice", "b", 446_106_250)!, 0)
		tiers.dropSource("a")
		const snap = tiers.snapshot(1, policy)
		expect(snap.tiers.map(t => t.key)).toEqual([
			dsdTierKey("voice", "b", 446_106_250),
		])
		expect(snap.tries).toEqual([])
		expect(snap.analogRetries).toEqual([])
	})

	it("ignores non-finite clocks", () => {
		const tiers = new DsdChannelTiers()
		expect(tiers.noteSync(key(446_106_250), NaN)).toBe(false)
		tiers.noteFailure(key(446_006_250), Infinity, policy)
		tiers.noteAnalogRetry(dsdGroupKey("voice", "rtl"), NaN)
		expect(tiers.snapshot(0, policy)).toEqual({
			tiers: [],
			analogRetries: [],
			tries: [],
		})
	})

	it("evicts nosync before digital, oldest write first (insertion renewed on every write)", () => {
		// Feature: dsd-digital-tiers, Property 1: a digital entry is never evicted while another nosync entry exists
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
					const kinds = new Map<string, "digital" | "nosync">()
					let now = 0
					for (const op of ops) {
						now += 1
						const k = key(400_000_000 + op.ch * 6_250)
						const before = new Set(
							tiers.snapshot(now, policy).tiers.map(t => t.key),
						)
						if (op.sync) tiers.noteSync(k, now)
						else tiers.noteFailure(k, now, policy)
						const after = tiers.snapshot(now, policy).tiers
						expect(after.length).toBeLessThanOrEqual(DSD_MAX_TIERS)
						const present = new Set(after.map(t => t.key))
						const evicted = [...before].filter(x => !present.has(x))
						// The entry just written always survives its own write.
						expect(present.has(k)).toBe(true)
						for (const e of evicted)
							if (kinds.get(e) === "digital")
								expect(
									after.some(t => t.tier === "nosync" && t.key !== k),
								).toBe(false)
						kinds.clear()
						for (const t of after) kinds.set(t.key, t.tier)
					}
				},
			),
			{ numRuns: 100 },
		)
	})
})

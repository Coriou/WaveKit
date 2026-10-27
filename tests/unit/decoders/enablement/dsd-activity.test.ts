import { describe, expect, it } from "vitest"
import {
	DSD_MAX_DEMOTIONS,
	DsdActivityDemotions,
	dsdNoSyncCooldownMs,
	dsdSyncProtectionUntil,
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
		"expires strictly at the cooldown bound: %i ms",
		age => {
			const notes = new DsdActivityDemotions()
			notes.note("slot", 137.3, policy)
			expect(notes.snapshot(137.3 + age)).toHaveLength(age < 120_000 ? 1 : 0)
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

	it("keeps exactly 256 entries and drops the oldest past that bound", () => {
		const notes = new DsdActivityDemotions()
		for (let i = 0; i < DSD_MAX_DEMOTIONS; i++) notes.note(String(i), i, policy)
		expect(notes.snapshot(300)).toHaveLength(256)
		notes.note("extra", 300, policy)
		const active = notes.snapshot(300)
		expect(active).toHaveLength(256)
		expect(active.some(n => n.key === "0")).toBe(false)
		expect(active.some(n => n.key === "1")).toBe(true)
		notes.clear("extra")
		expect(notes.snapshot(300)).toHaveLength(255)
	})

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

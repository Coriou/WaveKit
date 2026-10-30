import { describe, expect, it, vi } from "vitest"
import type {
	Band,
	BandPlanPack,
	ResolvedBandPlanView,
} from "@wavekit/api-types"
import type { Bandplan } from "../../../../src/core/scanner/bandplan/index.js"
import {
	createBandplanChannelLookup,
	createBandplanRangeLookup,
	createVfoTracker,
	vfoFromLiveDemod,
} from "../../../../src/decoders/enablement/channel-sources.js"

import { resolveBandPlans } from "../../../../src/core/bandplans/resolve.js"

function clock() {
	let now = 0
	const jobs = new Set<{ at: number; fn: () => void }>()
	return {
		now: () => now,
		setTimer(fn: () => void, ms: number) {
			const job = { at: now + ms, fn }
			jobs.add(job)
			return {
				cancel: () => {
					jobs.delete(job)
				},
			}
		},
		advance(ms: number) {
			const end = now + ms
			for (;;) {
				const job = [...jobs].sort((a, b) => a.at - b.at)[0]
				if (!job || job.at > end) break
				now = job.at
				jobs.delete(job)
				job.fn()
			}
			now = end
		},
	}
}

// Deliberately partial boundary fixtures also verify that unrelated DTO fields
// are not required by the lightweight channel reader.
const view = (channels: number[]) =>
	({
		bands: [
			{
				band: {
					startHz: 1,
					endHz: 1000,
					channels: channels.map(frequencyHz => ({ frequencyHz })),
				},
				segments: [{ startHz: 1, endHz: 1000 }],
			},
		],
	}) as unknown as ResolvedBandPlanView
const plans: Bandplan[] = [
	{
		id: "pager",
		name: "Pager",
		region: "all",
		ranges: [{ startHz: 100, endHz: 200, protocols: ["pocsag"] }],
	},
]

describe("channel sources", () => {
	it("VFO burst of 20 updates in 900 ms settles once, 1000 ms after the last", () => {
		const time = clock()
		const onSettled = vi.fn()
		const tracker = createVfoTracker({ ...time, onSettled })
		for (let i = 0; i < 20; i++) {
			tracker.update({ sourceId: "s", frequencyHz: 100 + i })
			if (i < 19) time.advance(900 / 19)
		}
		time.advance(999)
		expect(onSettled).not.toHaveBeenCalled()
		time.advance(1)
		expect(onSettled).toHaveBeenCalledExactlyOnceWith(
			{
				sourceId: "s",
				frequencyHz: 119,
			},
			"other",
		)
		time.advance(1)
		expect(onSettled).toHaveBeenCalledTimes(1)
	})
	it("a settle carries the origin of the latest change that moved the VFO", () => {
		const time = clock()
		const onSettled = vi.fn()
		const tracker = createVfoTracker({ ...time, onSettled })
		// A user tune, then a reconnect's baseline reset elsewhere: not the user's.
		tracker.update({ sourceId: "s", frequencyHz: 100 }, "user")
		time.advance(500)
		tracker.update({ sourceId: "s", frequencyHz: 150 }, "other")
		time.advance(1_000)
		expect(onSettled).toHaveBeenLastCalledWith(
			{ sourceId: "s", frequencyHz: 150 },
			"other",
		)
		// A reset, then the user's tune: the user's. A repeat of the pending
		// value with another origin changes nothing.
		tracker.update({ sourceId: "s", frequencyHz: 160 }, "other")
		tracker.update({ sourceId: "s", frequencyHz: 170 }, "user")
		tracker.update({ sourceId: "s", frequencyHz: 170 }, "other")
		time.advance(1_000)
		expect(onSettled).toHaveBeenLastCalledWith(
			{ sourceId: "s", frequencyHz: 170 },
			"user",
		)
		// No origin given is not the user's.
		tracker.update({ sourceId: "s", frequencyHz: 180 })
		time.advance(1_000)
		expect(onSettled).toHaveBeenLastCalledWith(
			{ sourceId: "s", frequencyHz: 180 },
			"other",
		)
		expect(onSettled).toHaveBeenCalledTimes(3)
	})
	it("identical updates do not postpone settlement; snapshots cannot mutate state", () => {
		const time = clock()
		const tracker = createVfoTracker({ ...time, onSettled: vi.fn() })
		const vfo = { sourceId: "s", frequencyHz: 100 }
		tracker.update(vfo)
		vfo.frequencyHz = 200
		time.advance(999)
		tracker.update({ sourceId: "s", frequencyHz: 100 })
		time.advance(1)
		expect(tracker.current()?.frequencyHz).toBe(100)
		const snapshot = tracker.current()!
		snapshot.frequencyHz = 300
		expect(tracker.current()?.frequencyHz).toBe(100)
		tracker.update(null)
		time.advance(1000)
		expect(tracker.current()).toBeNull()
		tracker.update(vfo)
		tracker.dispose()
		time.advance(1001)
		tracker.update(vfo)
		expect(tracker.current()).toBeNull()
	})
	it("VFO equals centre plus offsetHz on the liveDemod source without a listener", () => {
		expect(
			vfoFromLiveDemod({
				sourceId: () => "s",
				centreHz: () => 100,
				offsetHz: () => -20,
			}),
		).toEqual({ sourceId: "s", frequencyHz: 80 })
	})
	it.each([null, NaN, Infinity, 0, -1])("rejects invalid centre %s", centre => {
		expect(
			vfoFromLiveDemod({
				sourceId: () => "s",
				centreHz: () => centre,
				offsetHz: () => 20,
			}),
		).toBeNull()
	})
	it("rejects missing, overflowing and throwing live inputs", () => {
		for (const port of [
			{ sourceId: () => null, centreHz: () => 100, offsetHz: () => 0 },
			{
				sourceId: () => "s",
				centreHz: () => Number.MAX_VALUE,
				offsetHz: () => Number.MAX_VALUE,
			},
			{ sourceId: () => "s", centreHz: () => 100, offsetHz: () => NaN },
			{
				sourceId: () => {
					throw "private"
				},
				centreHz: () => 100,
				offsetHz: () => 0,
			},
		])
			expect(vfoFromLiveDemod(port)).toBeNull()
	})
	it("band-plan lookup returns only channels in a range listing the protocol, inclusive at edges", () => {
		const lookup = createBandplanChannelLookup({
			getResolved: () => view([99, 100, 101, 199, 200, 201, 200]),
			scannerPlans: () => plans,
		})
		expect(
			lookup({ sourceId: "s", minHz: 100, maxHz: 200 }, ["pocsag"]),
		).toEqual([100, 101, 199, 200])
		expect(
			lookup({ sourceId: "s", minHz: 101, maxHz: 199 }, ["pocsag"]),
		).toEqual([101, 199])
		expect(lookup({ sourceId: "s", minHz: 1, maxHz: 1000 }, ["dmr"])).toEqual(
			[],
		)
	})
	it("reads enabled built-in and imported packs with edits, excluding hidden and shadowed bands", () => {
		const band = (
			id: string,
			startHz: number,
			endHz: number,
			hz: number,
		): Band => ({
			id,
			name: id,
			startHz,
			endHz,
			group: "other",
			mode: null,
			bandwidthHz: null,
			stepHz: null,
			skip: null,
			channels: [
				{
					id: "channel",
					frequencyHz: hz,
					name: "Channel",
					aliases: [],
					registryRef: null,
				},
			],
			parentId: null,
			colourHint: null,
			registryRef: null,
			scan: null,
			provenance: { kind: "imported" },
		})
		const imported: BandPlanPack = {
			id: "imported-pack",
			kind: "imported",
			name: "Imported",
			region: null,
			provenance: {
				kind: "imported",
				trust: "community-unverified",
				format: "sdrpp-json",
				sourceName: "file.json",
				author: null,
				licence: null,
				importedAt: "2026-01-01T00:00:00.000Z",
				sha256: "ab".repeat(32),
			},
			bands: [band("visible", 120, 129, 125)],
		}
		const builtin: BandPlanPack = {
			...imported,
			id: "builtin-eu",
			kind: "builtin",
			bands: [
				band("original", 100, 109, 105),
				band("edited", 130, 139, 131),
				band("hidden", 140, 149, 145),
				band("covered", 120, 129, 126),
			],
		}
		const disabled: BandPlanPack = {
			...imported,
			id: "disabled",
			bands: [band("disabled", 150, 159, 155)],
		}
		const resolved = resolveBandPlans({
			packs: new Map(
				[imported, builtin, disabled].map(pack => [pack.id, pack]),
			),
			stack: [
				{ packId: imported.id, enabled: true },
				{ packId: builtin.id, enabled: true },
				{ packId: disabled.id, enabled: false },
			],
			operatorBands: [],
			edits: [
				{
					packId: builtin.id,
					bandId: "edited",
					set: {
						channels: [
							{
								id: "edited-channel",
								frequencyHz: 135,
								name: "Edited",
								aliases: [],
								registryRef: null,
							},
						],
					},
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
				{
					packId: builtin.id,
					bandId: "hidden",
					set: { hidden: true },
					updatedAt: "2026-01-01T00:00:00.000Z",
				},
			],
		})
		expect(resolved.hidden).toEqual(["builtin-eu/hidden"])
		expect(resolved.shadowed).toEqual(["builtin-eu/covered"])
		expect(
			createBandplanChannelLookup({
				getResolved: () => ({ ...view([]), ...resolved }),
				scannerPlans: () => plans,
			})({ sourceId: "s", minHz: 1, maxHz: 1000 }, ["pocsag"]),
		).toEqual([105, 125, 135])
	})
	it("uses inclusive visible segments; hidden and shadowed bands contribute no channels", () => {
		const resolved = {
			...view([]),
			bands: [
				{
					...view([100, 119, 120, 150, 180, 181, 200]).bands[0]!,
					segments: [
						{ startHz: 100, endHz: 119 },
						{ startHz: 181, endHz: 200 },
					],
				},
			],
			hidden: ["builtin-eu/hidden"],
			shadowed: ["imported-pack/covered"],
		}
		expect(
			createBandplanChannelLookup({
				getResolved: () => resolved,
				scannerPlans: () => plans,
			})({ sourceId: "s", minHz: 1, maxHz: 1000 }, ["pocsag"]),
		).toEqual([100, 119, 181, 200])
	})
	it("a narrowed band keeps in-edge channels and does not hide other bands", () => {
		const resolved = {
			bands: [
				{
					band: {
						startHz: 140,
						endHz: 160,
						channels: [120, 150, 180].map(frequencyHz => ({ frequencyHz })),
					},
					segments: [{ startHz: 140, endHz: 160 }],
				},
				{
					band: {
						startHz: 170,
						endHz: 190,
						channels: [{ frequencyHz: 175 }],
					},
					segments: [{ startHz: 170, endHz: 190 }],
				},
			],
		} as unknown as ResolvedBandPlanView
		expect(
			createBandplanChannelLookup({
				getResolved: () => resolved,
				scannerPlans: () => plans,
			})({ sourceId: "s", minHz: 1, maxHz: 1000 }, ["pocsag"]),
		).toEqual([150, 175])
	})
	it("missing, malformed and throwing inputs yield no channels", () => {
		for (const getResolved of [
			() => undefined,
			() => {
				throw "private"
			},
			() => ({}) as ResolvedBandPlanView,
			() => view([NaN]),
			() => ({
				...view([150]),
				bands: [{ ...view([150]).bands[0]!, segments: [] }],
			}),
			() => ({
				...view([150]),
				bands: [
					{
						...view([150]).bands[0]!,
						segments: [{ startHz: 200, endHz: 100 }],
					},
				],
			}),
		]) {
			expect(
				createBandplanChannelLookup({
					getResolved,
					scannerPlans: () => plans,
				})({ sourceId: "s", minHz: 1, maxHz: 1000 }, ["pocsag"]),
			).toEqual([])
		}
		const lookup = createBandplanChannelLookup({
			getResolved: () => view([150]),
			scannerPlans: () => {
				throw "private"
			},
		})
		expect(
			lookup({ sourceId: "s", minHz: 1, maxHz: 1000 }, ["pocsag"]),
		).toEqual([])
	})
})

it("VFO sum must be positive, including the 1 Hz edge", () => {
	for (const [offset, expected] of [
		[-99, 1],
		[-100, null],
	] as const) {
		expect(
			vfoFromLiveDemod({
				sourceId: () => "s",
				centreHz: () => 100,
				offsetHz: () => offset,
			})?.frequencyHz ?? null,
		).toBe(expected)
	}
})

it("rejects inverted windows and malformed or disabled scanner ranges", () => {
	const lookup = createBandplanChannelLookup({
		getResolved: () => view([150]),
		scannerPlans: () => plans,
	})
	expect(lookup({ sourceId: "s", minHz: 150, maxHz: 150 }, ["pocsag"])).toEqual(
		[150],
	)
	expect(lookup({ sourceId: "s", minHz: 151, maxHz: 150 }, ["pocsag"])).toEqual(
		[],
	)
	for (const range of [
		{
			startHz: 100,
			endHz: 200,
			protocols: ["pocsag" as const],
			enabled: false,
		},
		{ startHz: 201, endHz: 200, protocols: ["pocsag" as const] },
		{ startHz: NaN, endHz: 200, protocols: ["pocsag" as const] },
		{ startHz: 100, endHz: 200 },
	]) {
		const read = createBandplanChannelLookup({
			getResolved: () => view([150]),
			scannerPlans: () => [
				{ id: "p", name: "Pager", region: "all", ranges: [range] },
			],
		})
		expect(read({ sourceId: "s", minHz: 100, maxHz: 200 }, ["pocsag"])).toEqual(
			[],
		)
	}
})

describe("scanner range lookup", () => {
	it("matches protocols within inclusive enabled ranges", () => {
		const lookup = createBandplanRangeLookup({ scannerPlans: () => plans })
		for (const hz of [100, 150, 200])
			expect(lookup("s", hz, ["flex", "pocsag"])).toBe(true)
		for (const hz of [99, 201, 0, -1, NaN, Infinity])
			expect(lookup("s", hz, ["pocsag"])).toBe(false)
		expect(lookup("s", 150, ["flex"])).toBe(false)
		expect(lookup("s", 150, [])).toBe(false)
	})
	it("rejects disabled and malformed plans and throwing getters", () => {
		for (const range of [
			{ startHz: 100, endHz: 200, protocols: ["pocsag"], enabled: false },
			{ startHz: 100, endHz: 200 },
			{ startHz: 201, endHz: 100, protocols: ["pocsag"] },
			{ startHz: NaN, endHz: 200, protocols: ["pocsag"] },
			{ startHz: 100, endHz: 200, protocols: "pocsag" },
		]) {
			const lookup = createBandplanRangeLookup({
				scannerPlans: () =>
					[{ ...plans[0]!, ranges: [range] }] as unknown as Bandplan[],
			})
			expect(lookup("s", 150, ["pocsag"])).toBe(false)
		}
		for (const scannerPlans of [
			() => [],
			() => [{ ranges: null }] as unknown as Bandplan[],
			() => {
				throw "private"
			},
		])
			expect(
				createBandplanRangeLookup({ scannerPlans })("s", 150, ["pocsag"]),
			).toBe(false)
	})
})

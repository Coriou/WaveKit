// Band inspection UX (docs/specs/2026-10-25-band-inspection-ux.md req 1.1, 1.2): emitter clusters, out-of-view
// markers, and one collision layout for the signal chips over the trace.
import fc from "fast-check"
import { describe, expect, it } from "vitest"
import type { Discovery } from "@wavekit/api-types"

import { placeSavedTags } from "../../src/plot/saved-tags.ts"
import { withWhatIsThis } from "../../src/plot/signal-menu.ts"
import {
	AXIS_CSS,
	DISCOVERY_ROW_CSS,
	LANES_CSS,
	plotLayout,
	RULER_CSS,
} from "../../src/plot/layout.ts"
import {
	discoveryRowLayout,
	tagPopoverRows,
	TriggerFocus,
	clusterDiscoveries,
	outsideView,
	placeDiscoveryTags,
} from "../../src/plot/discovery-tags.ts"
import {
	describeTracks,
	placeLabels,
	type SignalInfo,
} from "../../src/plot/maths.ts"
import {
	chipRect,
	clusterSignals,
	layoutChips,
	SIGNAL_CHIPS_MAX,
} from "../../src/plot/signal-chips.ts"

const NOW = Date.parse("2026-10-25T08:00:00.000Z")
const view = { startHz: 433_000_000, endHz: 434_200_000 } // 1.2 MHz
const W = 600 // 2 kHz a pixel
const xHz = (px: number) => view.startHz + px * 2000

function disc(
	id: string,
	hz: number,
	over: Partial<Discovery> = {},
): Discovery {
	const stats = { peakDbfs: -40, meanDbfs: -50, snrDb: 20, floorDbfs: -70 }
	return {
		id,
		frequencyHz: hz,
		frequencyKey: String(hz),
		measuredOffsetHz: 0,
		bandwidthHz: 2000,
		protocol: "unknown",
		family: "unknown",
		class: "unknown",
		confidence: "activity",
		encrypted: false,
		coChannel: [],
		firstSeenAt: new Date(NOW - 7_200_000).toISOString(),
		lastSeenAt: new Date(NOW - 60_000).toISOString(),
		observationCount: 1,
		airtimeMs: 100,
		signal: { best: stats, last: stats },
		metadata: {
			talkgroups: [],
			sources: [],
			slots: [],
			callsigns: [],
			capcodes: [],
			ismModels: [],
		},
		sourceIds: ["pi"],
		jobIds: [],
		tuningTrust: "commanded",
		evidence: { recordings: 0, psd: false, iq: false },
		...over,
	}
}

const opts = { widthPx: W, activeNow: new Set<string>(), now: NOW }
const sizes = (cs: Discovery[][]) => cs.map(c => c.length)

describe("clusterDiscoveries", () => {
	it("18 px joins, 19 and 20 px start a new cluster (bandwidth rule out of reach)", () => {
		const at = (px: number[]) => px.map((p, i) => disc(`d${i}`, xHz(p)))
		expect(
			sizes(clusterDiscoveries(at([100, 118]), view, { widthPx: W })),
		).toEqual([2])
		expect(
			sizes(clusterDiscoveries(at([100, 119]), view, { widthPx: W })),
		).toEqual([1, 1])
		expect(
			sizes(clusterDiscoveries(at([100, 120]), view, { widthPx: W })),
		).toEqual([1, 1])
	})

	it("chains without bound: 0, 18, 36, 54, 72, 77 px is one tag at x = 0", () => {
		const ds = [0, 18, 36, 54, 72, 77].map((p, i) => disc(`c${i}`, xHz(p)))
		expect(sizes(clusterDiscoveries(ds, view, { widthPx: W }))).toEqual([6])
		const tags = placeDiscoveryTags(ds, view, opts)
		expect(tags).toHaveLength(1)
		expect(tags[0]!.hz).toBe(view.startHz)
		expect(tags[0]!.members).toHaveLength(6)
		expect(tags[0]!.title).toBe("6 signals, 433.0000-433.1540 MHz")
		expect(tags[0]!.label).toBe("Heard +5")
		expect(tags[0]!.x).toBe(0)
	})

	it("a long label keeps its count: the name is capped, the count's room comes on top", () => {
		const long = "A very long operator label that runs on and on and on"
		const ds = [
			disc("a", xHz(100), { operator: { label: long } }),
			disc("b", xHz(101)),
		]
		const [t] = placeDiscoveryTags(ds, view, opts)
		expect(t!.labelled).toBe(true)
		expect(t!.name).toBe(long)
		expect(t!.count).toBe("+1")
		expect(t!.width).toBe(Math.round(22 + 140 + 4 + 2 * 6.6))
	})

	it("a group without room for its label still shows its count", () => {
		const ds = [disc("a", xHz(100)), disc("b", xHz(101)), disc("c", xHz(112))]
		const [t] = placeDiscoveryTags(ds, view, {
			...opts,
			widthPx: W,
			maxLabelPx: 0,
			chromePx: 1000,
		})
		expect(t!.labelled).toBe(false)
		expect(t!.count).toBe("+2")
		expect(t!.width).toBeGreaterThan(15)
	})

	it("the bandwidth rule joins neighbours of a wide emitter", () => {
		const ds = [
			disc("a", xHz(100), { bandwidthHz: 100_000 }),
			disc("b", xHz(100) + 48_000),
		]
		expect(sizes(clusterDiscoveries(ds, view, { widthPx: W }))).toEqual([2])
	})

	it("zero width, an empty view and a non-finite frequency give nothing", () => {
		const d = [disc("a", xHz(10))]
		expect(clusterDiscoveries(d, view, { widthPx: 0 })).toEqual([])
		expect(
			clusterDiscoveries(d, { startHz: 1, endHz: 1 }, { widthPx: W }),
		).toEqual([])
		expect(placeDiscoveryTags([disc("n", Number.NaN)], view, opts)).toEqual([])
	})

	it("a cluster of one renders as before", () => {
		const [t] = placeDiscoveryTags([disc("solo", xHz(200))], view, opts)
		expect(t!.label).toBe("Heard")
		expect(t!.title).toMatch(/^Heard · 433\.4000 MHz · heard/)
		expect(t!.members.map(d => d.id)).toEqual(["solo"])
	})
})

const discsArb = fc.array(
	fc.record({
		hz: fc.integer({ min: 431_500_000, max: 435_700_000 }),
		bw: fc.constantFrom(0, 2000, 12_500, 60_000),
		conf: fc.constantFrom("activity", "candidate", "classified", "decoded"),
		ago: fc.integer({ min: 0, max: 10_000_000 }),
	}),
	{ maxLength: 60 },
)
const toDiscs = (xs: { hz: number; bw: number; conf: string; ago: number }[]) =>
	xs.map((x, i) =>
		disc(`p${i}`, x.hz, {
			bandwidthHz: x.bw,
			confidence: x.conf as Discovery["confidence"],
			lastSeenAt: new Date(NOW - x.ago).toISOString(),
		}),
	)

describe("band view properties", () => {
	// Feature: band-inspection-ux, Property 1: clusters cover and do not overlap
	// Validates: Requirements 1.1
	it("every in-view discovery is on exactly one tag; tags never overlap; each tag sits at its first member", () => {
		fc.assert(
			fc.property(discsArb, fc.integer({ min: 50, max: 2000 }), (xs, w) => {
				const ds = toDiscs(xs)
				const tags = placeDiscoveryTags(ds, view, { ...opts, widthPx: w })
				const inView = ds.filter(
					d => d.frequencyHz >= view.startHz && d.frequencyHz <= view.endHz,
				)
				const ids = tags.flatMap(t => t.members.map(d => d.id))
				expect(new Set(ids).size).toBe(ids.length)
				expect(ids.sort()).toEqual(inView.map(d => d.id).sort())
				for (let i = 1; i < tags.length; i++)
					expect(tags[i - 1]!.x + tags[i - 1]!.width + 4).toBeLessThanOrEqual(
						tags[i]!.x + 1e-9,
					)
				for (const t of tags) {
					const first = Math.min(...t.members.map(d => d.frequencyHz))
					expect(t.hz).toBe(first)
					// at x(first), moved inside the row when it would be clipped
					const ideal = ((first - view.startHz) / 1_200_000) * w - 7
					expect(t.x).toBeCloseTo(Math.min(w - t.width, Math.max(0, ideal)), 6)
					expect(t.x).toBeGreaterThanOrEqual(0)
					expect(t.x + t.width).toBeLessThanOrEqual(w + 1e-9)
				}
			}),
			{ numRuns: 200 },
		)
	})

	// Feature: band-inspection-ux, Property 2: clustering is invariant under input order
	// Validates: Requirements 1.1
	it("clustering does not depend on input order", () => {
		fc.assert(
			fc.property(
				discsArb.chain(xs =>
					fc.tuple(
						fc.constant(xs),
						fc.shuffledSubarray(
							xs.map((_, i) => i),
							{ minLength: xs.length, maxLength: xs.length },
						),
					),
				),
				([xs, order]) => {
					const ds = toDiscs(xs)
					const shuffled = order.map(i => ds[i]!)
					const key = (cs: Discovery[][]) =>
						cs.map(c => c.map(d => d.id).join(",")).join("|")
					expect(key(clusterDiscoveries(shuffled, view, { widthPx: W }))).toBe(
						key(clusterDiscoveries(ds, view, { widthPx: W })),
					)
					const ids = (t: ReturnType<typeof placeDiscoveryTags>) =>
						t.map(x => `${x.id}:${x.label}`)
					expect(ids(placeDiscoveryTags(shuffled, view, opts))).toEqual(
						ids(placeDiscoveryTags(ds, view, opts)),
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: band-inspection-ux, Property 3: no tag outside the view; markers + placed = fetched taggable
	// Validates: Requirements 1.2
	it("never draws outside the view and counts the rest once per side", () => {
		fc.assert(
			fc.property(discsArb, xs => {
				const ds = toDiscs(xs)
				const tags = placeDiscoveryTags(ds, view, opts)
				for (const t of tags)
					for (const m of t.members) {
						expect(m.frequencyHz).toBeGreaterThanOrEqual(view.startHz)
						expect(m.frequencyHz).toBeLessThanOrEqual(view.endHz)
					}
				const out = outsideView(ds, view, {})
				const span = view.endHz - view.startHz
				const fetched = ds.filter(
					d =>
						d.frequencyHz >= view.startHz - span / 2 &&
						d.frequencyHz <= view.endHz + span / 2,
				).length
				const placed = tags.reduce((n, t) => n + t.members.length, 0)
				expect((out.left?.count ?? 0) + (out.right?.count ?? 0) + placed).toBe(
					fetched,
				)
			}),
			{ numRuns: 200 },
		)
	})

	it("stale-cache: discoveries at 145.5 MHz after a retune to 433.92 MHz draw nothing and count nowhere", () => {
		const stale = [145_500_000, 145_512_500, 145_525_000].map((hz, i) =>
			disc(`s${i}`, hz),
		)
		const v = { startHz: 432_960_000, endHz: 434_880_000 }
		expect(placeDiscoveryTags(stale, v, { ...opts, widthPx: 1440 })).toEqual([])
		expect(outsideView(stale, v, {})).toEqual({ left: null, right: null })
	})

	it("nearby-off-screen: 1 on the left, 3 on the right, the nearest offered", () => {
		const v = { startHz: 432_960_000, endHz: 434_880_000 }
		const ds = [432_900_000, 434_900_000, 435_050_000, 435_300_000].map(
			(hz, i) => disc(`n${i}`, hz),
		)
		expect(outsideView(ds, v, {})).toEqual({
			left: { count: 1, nearestHz: 432_900_000 },
			right: { count: 3, nearestHz: 434_900_000 },
		})
	})
})

describe("signal chips over the trace (one layout across live and leaving chips)", () => {
	const plotView = { startHz: 434_650_000, endHz: 434_890_000 }
	const PW = 1440
	const overlap = (a: number[], b: number[]) =>
		a[0]! < b[2]! && a[2]! > b[0]! && a[1]! < b[3]! && a[3]! > b[1]!

	it("the bookmark case: bursts within 5 kHz give one chip, never the saved name repeated", () => {
		const hzs = [
			434_701_500, 434_703_500, 434_705_500, 434_707_500, 434_709_500,
		]
		const signals: SignalInfo[] = describeTracks(
			hzs.map(hz => ({
				startHz: hz - 750,
				endHz: hz + 750,
				flags: { burst: true, iqImage: false, edge: false },
				peakDb: -60,
			})),
			null,
		)
		const clustered = clusterSignals(signals, plotView, PW)
		expect(clustered).toHaveLength(1)
		expect(clustered[0]!.label).toMatch(/\+4$/)
	})

	// Feature: band-inspection-ux, Property 1: clusters cover and do not overlap (signal chip layer)
	// Validates: Requirements 1.1
	it("no two drawn chips overlap, live or leaving, and at most SIGNAL_CHIPS_MAX are drawn", () => {
		const sigArb = fc.array(
			fc.record({
				hz: fc.integer({ min: plotView.startHz, max: plotView.endHz }),
				w: fc.integer({ min: 500, max: 20_000 }),
				peak: fc.integer({ min: -100, max: -30 }),
				name: fc.constantFrom("Test cluster", "DMR · CC 1", "433.920"),
			}),
			{ maxLength: 40 },
		)
		fc.assert(
			fc.property(sigArb, sigArb, (live, gone) => {
				const info = (xs: typeof live): SignalInfo[] =>
					xs.map(x => ({
						hz: x.hz,
						widthHz: x.w,
						label: x.name,
						sub: "434.700",
						burst: true,
						known: true,
						peakDb: x.peak,
					}))
				const levels = { minDb: -110, maxDb: -20 }
				const placed = placeLabels(
					clusterSignals(info(live), plotView, PW),
					plotView,
					{
						widthPx: PW,
						traceCss: 300,
						levels,
						tunedHz: null,
					},
				)
				// leaving chips stand where an older layout put them: overlaps are likely
				const leaving = placeLabels(info(gone), plotView, {
					widthPx: PW,
					traceCss: 300,
					levels,
					tunedHz: null,
				})
				const laid = layoutChips(placed, leaving)
				const all = [...laid.placed, ...laid.leaving]
				expect(all.length).toBeLessThanOrEqual(SIGNAL_CHIPS_MAX)
				const rects = all.map(l => chipRect(l))
				for (let i = 0; i < rects.length; i++)
					for (let j = i + 1; j < rects.length; j++)
						expect(overlap(rects[i]!, rects[j]!)).toBe(false)
			}),
			{ numRuns: 150 },
		)
	})
})

type Rect = [number, number, number, number]
const hits = (a: Rect, b: Rect) =>
	a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]

describe("discovery row edges", () => {
	it("discoveries exactly at both boundaries plus one outside: inside the row, never under a marker", () => {
		const ds = [
			disc("lo", view.startHz),
			disc("hi", view.endHz),
			disc("out-l", view.startHz - 100_000),
			disc("out-r", view.endHz + 100_000),
		]
		const row = discoveryRowLayout(ds, view, opts)
		expect(row.tags.map(t => t.members.map(d => d.id))).toEqual([
			["lo"],
			["hi"],
		])
		const l = row.markers.left!
		const r = row.markers.right!
		const rects: Rect[] = [
			[l.x, 0, l.x + l.width, 1],
			[r.x, 0, r.x + r.width, 1],
			...row.tags.map((t): Rect => [t.x, 0, t.x + t.width, 1]),
		]
		for (const [a, b, c] of rects) {
			expect(a).toBeGreaterThanOrEqual(0)
			expect(c).toBeLessThanOrEqual(W)
			void b
		}
		for (let i = 0; i < rects.length; i++)
			for (let j = i + 1; j < rects.length; j++)
				expect(hits(rects[i]!, rects[j]!)).toBe(false)
	})

	it("a single discovery's popover has its next step and a Tune action (capture-too-narrow)", () => {
		const d = disc("one", xHz(300), {
			hint: "lora",
			coverage: [
				{
					decoderId: "lora-meshtastic",
					state: "suspended",
					suspensionReason: "capture-too-narrow",
				},
			],
		})
		const [t] = placeDiscoveryTags([d], view, opts)
		expect(tagPopoverRows(t!)).toEqual([
			{
				id: "one",
				freq: "433.6000",
				name: "Heard",
				protocol: null,
				likely: "likely LoRa",
				next: "Widen the capture so lora-meshtastic fits",
				tuneHz: xHz(300),
			},
		])
		expect(withWhatIsThis("433.6000 MHz", [d], xHz(300) + 500)).toBe(
			"433.6000 MHz · likely LoRa · Widen the capture so lora-meshtastic fits",
		)
		expect(
			withWhatIsThis(
				"x",
				[disc("v", xHz(300), { confidence: "decoded", protocol: "dmr" })],
				xHz(300),
			),
		).toBe("x")
	})

	it("Escape or Cancel gives focus back to the trigger, once; an outside click does not", () => {
		const calls: string[] = []
		const trigger = { focus: () => calls.push("focus") }
		const f = new TriggerFocus()
		f.remember(trigger)
		f.restore()
		f.restore()
		expect(calls).toEqual(["focus"])
		f.remember(trigger)
		f.forget()
		f.restore()
		expect(calls).toEqual(["focus"])
	})
})

// Feature: band-inspection-ux, Property 1: clusters cover and do not overlap (every chip layer)
// Validates: Requirements 1.1, 1.2
describe("all chip layers together", () => {
	it("trace chips, saved tags, discovery tags and edge markers: no rectangle overlaps, all inside the plot", () => {
		const PW = 1000
		const v = { startHz: 434_000_000, endHz: 435_000_000 }
		const hzArb = fc.integer({ min: 433_400_000, max: 435_600_000 })
		fc.assert(
			fc.property(
				fc.array(hzArb, { maxLength: 30 }),
				fc.array(fc.record({ hz: hzArb, name: fc.string({ maxLength: 20 }) }), {
					maxLength: 10,
				}),
				fc.array(
					fc.record({
						hz: fc.integer({ min: v.startHz, max: v.endHz }),
						w: fc.integer({ min: 500, max: 30_000 }),
						peak: fc.integer({ min: -100, max: -30 }),
					}),
					{ maxLength: 30 },
				),
				fc.integer({ min: 300, max: 1200 }),
				(dHz, savedIn, sigs, heightCss) => {
					const layout = plotLayout(heightCss, DISCOVERY_ROW_CSS + RULER_CSS)
					const lanesTop = layout.traceCss + AXIS_CSS
					const rowTop = lanesTop + LANES_CSS
					const rects: Rect[] = []
					// trace band
					const info: SignalInfo[] = sigs.map(x => ({
						hz: x.hz,
						widthHz: x.w,
						label: "Test cluster",
						sub: "434.700",
						burst: true,
						known: true,
						peakDb: x.peak,
					}))
					const placed = placeLabels(clusterSignals(info, v, PW), v, {
						widthPx: PW,
						traceCss: layout.traceCss,
						levels: { minDb: -110, maxDb: -20 },
						tunedHz: null,
					})
					for (const l of layoutChips(placed, []).placed)
						rects.push(chipRect(l))
					// lanes band: saved tags, 18 px chips
					const saved = placeSavedTags(
						savedIn.map((f, i) => ({
							id: `f${i}`,
							frequencyHz: f.hz,
							name: f.name || "x",
						})),
						v,
						{ widthPx: PW, showLabels: true },
					)
					for (const t of saved)
						rects.push([t.x, lanesTop + 3, t.x + t.width, lanesTop + 21])
					// discovery row: tags and markers, 16 px chips at top 2 px
					const row = discoveryRowLayout(
						dHz.map((hz, i) => disc(`d${i}`, hz)),
						v,
						{ ...opts, widthPx: PW },
					)
					for (const t of row.tags)
						rects.push([t.x, rowTop + 2, t.x + t.width, rowTop + 18])
					for (const m of [row.markers.left, row.markers.right])
						if (m) rects.push([m.x, rowTop + 2, m.x + m.width, rowTop + 18])
					const bottom = rowTop + DISCOVERY_ROW_CSS
					for (const r of rects) {
						expect(r[0]).toBeGreaterThanOrEqual(0)
						expect(r[2]).toBeLessThanOrEqual(PW + 1e-9)
						expect(r[1]).toBeGreaterThanOrEqual(0)
						expect(r[3]).toBeLessThanOrEqual(bottom)
					}
					for (let i = 0; i < rects.length; i++)
						for (let j = i + 1; j < rects.length; j++)
							expect(hits(rects[i]!, rects[j]!)).toBe(false)
				},
			),
			{ numRuns: 150 },
		)
	})
})

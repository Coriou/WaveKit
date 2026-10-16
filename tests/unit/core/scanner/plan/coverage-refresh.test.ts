import { describe, expect, it } from "vitest"
import {
	coverageFingerprint,
	createCoverageRefresh,
} from "../../../../../src/core/scanner/plan/coverage-refresh.js"
import { computeDecodedElsewhere } from "../../../../../src/core/scanner/plan/decoded-elsewhere.js"
import type {
	DecoderCoverageView,
	NormalisedJobSpec,
} from "../../../../../src/core/scanner/types.js"
import { DECODED_ELSEWHERE_MAX_TARGETS } from "@wavekit/api-types"

function fakeClock() {
	let t = 0
	let seq = 0
	const timers = new Map<number, { at: number; fn: () => void }>()
	return {
		now: () => t,
		setTimer: (fn: () => void, ms: number): unknown => {
			const id = ++seq
			timers.set(id, { at: t + ms, fn })
			return id
		},
		clearTimer: (h: unknown): void => {
			timers.delete(h as number)
		},
		pending: () => timers.size,
		advance(ms: number): void {
			const end = t + ms
			for (;;) {
				let next: [number, { at: number; fn: () => void }] | undefined
				for (const e of timers) if (!next || e[1].at < next[1].at) next = e
				if (!next || next[1].at > end) break
				timers.delete(next[0])
				t = Math.max(t, next[1].at)
				next[1].fn()
			}
			t = end
		},
	}
}

function setup(
	over: { fp?: () => string; onError?: (e: unknown) => void } = {},
) {
	const clock = fakeClock()
	let n = 0
	let fp = 0
	const refresh = createCoverageRefresh({
		...clock,
		fingerprint: over.fp ?? (() => String(fp)),
		onRefresh: () => {
			n++
		},
		...(over.onError ? { onError: over.onError } : {}),
	})
	return {
		clock,
		refresh,
		count: () => n,
		bump: () => {
			fp++
		},
	}
}

describe("createCoverageRefresh", () => {
	it("collapses a burst into one refresh 2 s after the last notify", () => {
		const s = setup()
		for (let i = 0; i < 100; i++) {
			s.refresh.notify()
			s.clock.advance(10)
		}
		s.clock.advance(1989)
		expect(s.count()).toBe(0)
		s.clock.advance(1)
		expect(s.count()).toBe(1)
		s.clock.advance(100000)
		expect(s.count()).toBe(1)
	})

	it("limits a flapping fingerprint at 1 Hz for 10 min to <= 21 refreshes", () => {
		const s = setup()
		for (let i = 0; i < 600; i++) {
			s.bump()
			s.refresh.notify()
			s.clock.advance(1000)
		}
		s.clock.advance(60000)
		expect(s.count()).toBeLessThanOrEqual(21)
		expect(s.count()).toBeGreaterThanOrEqual(1)
	})

	it("refreshes about every 30 s when changes arrive every 5 s", () => {
		const s = setup()
		for (let i = 0; i < 120; i++) {
			s.bump()
			s.refresh.notify()
			s.clock.advance(5000)
		}
		s.clock.advance(60000)
		expect(s.count()).toBeGreaterThan(10)
		expect(s.count()).toBeLessThanOrEqual(21)
	})

	it("does not refresh for an unchanged fingerprint", () => {
		const s = setup({ fp: () => "same" })
		s.refresh.notify()
		s.clock.advance(2000)
		expect(s.count()).toBe(1)
		for (let i = 0; i < 5; i++) {
			s.refresh.notify()
			s.clock.advance(40000)
		}
		expect(s.count()).toBe(1)
	})

	it("reports a throwing fingerprint and retries on the next notify", () => {
		const errs: unknown[] = []
		let boom = true
		const s = setup({
			fp: () => {
				if (boom) throw new Error("x")
				return "ok"
			},
			onError: e => errs.push(e),
		})
		s.refresh.notify()
		s.clock.advance(2000)
		expect(errs).toHaveLength(1)
		expect(s.count()).toBe(0)
		boom = false
		s.refresh.notify()
		s.clock.advance(30000)
		expect(s.count()).toBe(1)
	})

	it("reports a throwing onRefresh", () => {
		const errs: unknown[] = []
		const clock = fakeClock()
		const r = createCoverageRefresh({
			...clock,
			fingerprint: () => "a",
			onRefresh: () => {
				throw new Error("r")
			},
			onError: e => errs.push(e),
		})
		r.notify()
		clock.advance(2000)
		expect(errs).toHaveLength(1)
	})

	it("dispose mid-wait prevents the fire and ignores later notifies", () => {
		const s = setup()
		s.refresh.notify()
		s.clock.advance(1000)
		s.refresh.dispose()
		expect(s.clock.pending()).toBe(0)
		s.clock.advance(100000)
		expect(s.count()).toBe(0)
		s.refresh.notify()
		expect(s.clock.pending()).toBe(0)
		s.clock.advance(100000)
		expect(s.count()).toBe(0)
	})

	it("refreshes a change inside the interval at the interval end", () => {
		const s = setup()
		s.refresh.notify()
		s.clock.advance(2000)
		expect(s.count()).toBe(1)
		s.clock.advance(3000)
		s.bump()
		s.refresh.notify()
		s.clock.advance(26999)
		expect(s.count()).toBe(1)
		s.clock.advance(1)
		expect(s.count()).toBe(2)
	})

	it("never throws from notify", () => {
		const r = createCoverageRefresh({
			now: () => {
				throw new Error("n")
			},
			setTimer: () => 1,
			clearTimer: () => undefined,
			fingerprint: () => "",
			onRefresh: () => undefined,
		})
		expect(() => r.notify()).not.toThrow()
	})
})

function view(over: Record<string, unknown> = {}): DecoderCoverageView {
	return {
		id: "d1",
		running: true,
		health: "running",
		suspended: false,
		owner: "config",
		sourceId: "s1",
		inputKind: "iq",
		band: {
			verdict: "in-band",
			basis: "configured",
			targetsHz: [100, 200],
			rangesHz: [{ minHz: 1, maxHz: 2 }],
			captureCenterHz: 150,
			windowHalfWidthHz: 100,
		},
		...over,
	} as DecoderCoverageView
}

describe("coverageFingerprint", () => {
	const base = coverageFingerprint([view()])
	it("ignores unread fields", () => {
		const v = { ...view(), extra: 5, label: "x" } as DecoderCoverageView
		expect(coverageFingerprint([v])).toBe(base)
	})
	it("changes with each read field", () => {
		const band = view().band as NonNullable<DecoderCoverageView["band"]>
		const changes: Record<string, unknown>[] = [
			{ id: "d2" },
			{ running: false },
			{ health: "idle" },
			{ suspended: true },
			{ owner: "scanner" },
			{ sourceId: null },
			{ inputKind: "external" },
			{ band: null },
			{ band: { ...band, verdict: "unknown" } },
			{ band: { ...band, basis: "protocol" } },
			{ band: { ...band, targetsHz: [100, 201] } },
			{ band: { ...band, rangesHz: [{ minHz: 1, maxHz: 3 }] } },
			{ band: { ...band, captureCenterHz: 151 } },
			{ band: { ...band, windowHalfWidthHz: 101 } },
		]
		const seen = new Set([base])
		for (const c of changes) {
			const f = coverageFingerprint([view(c)])
			expect(seen.has(f)).toBe(false)
			seen.add(f)
		}
	})
	it("treats reorder as a change", () => {
		const a = view({ id: "a" })
		const b = view({ id: "b" })
		expect(coverageFingerprint([a, b])).not.toBe(coverageFingerprint([b, a]))
	})
	it("is total on malformed input", () => {
		const evil = {
			get id(): string {
				throw new Error("g")
			},
		}
		const junk = [
			null,
			3,
			"x",
			evil,
			view({ band: 7 }),
			view({ band: { targetsHz: 5 } }),
		]
		expect(() =>
			coverageFingerprint(junk as unknown as DecoderCoverageView[]),
		).not.toThrow()
		expect(() =>
			coverageFingerprint(null as unknown as DecoderCoverageView[]),
		).not.toThrow()
	})
})

describe("coverageFingerprint regressions", () => {
	const spec = {
		sourceId: "job",
		ranges: [{ startHz: 0, endHz: 1e9 }],
	} as unknown as Pick<NormalisedJobSpec, "sourceId" | "ranges">
	const covers = (views: unknown[]): number =>
		computeDecodedElsewhere(views as DecoderCoverageView[], spec).ranges.length

	it("never collides a valid '?' with a malformed value", () => {
		const a = view({ id: "?" })
		const b = view({ id: undefined })
		expect(covers([a])).toBeGreaterThan(0)
		expect(covers([b])).toBe(0)
		expect(coverageFingerprint([a])).not.toBe(coverageFingerprint([b]))
	})

	it("catches each indexed view read on its own", () => {
		const make = (running: boolean): DecoderCoverageView[] => {
			const arr: unknown[] = [view({ running }), null]
			Object.defineProperty(arr, 1, {
				get() {
					throw new Error("slot")
				},
			})
			return arr as DecoderCoverageView[]
		}
		expect(covers(make(true))).toBeGreaterThan(0)
		expect(covers(make(false))).toBe(0)
		expect(coverageFingerprint(make(true))).not.toBe(
			coverageFingerprint(make(false)),
		)
	})

	it("shares one targets-then-ranges budget like WG6", () => {
		const make = (running: boolean): DecoderCoverageView[] => {
			const ranges: unknown[] = [null]
			Object.defineProperty(ranges, 0, {
				get() {
					throw new Error("range")
				},
			})
			const targets = Array.from(
				{ length: DECODED_ELSEWHERE_MAX_TARGETS },
				(_, i) => 100 + i,
			)
			return [
				view({
					running,
					band: {
						verdict: "in-band",
						basis: "configured",
						targetsHz: targets,
						rangesHz: ranges,
						captureCenterHz: 150,
						windowHalfWidthHz: 100,
					},
				}),
			]
		}
		expect(covers(make(true))).toBeGreaterThan(0)
		expect(coverageFingerprint(make(true))).not.toBe(
			coverageFingerprint(make(false)),
		)
	})
})

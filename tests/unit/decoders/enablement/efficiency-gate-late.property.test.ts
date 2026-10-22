import { expect, it, vi } from "vitest"
import type { Logger } from "../../../../src/utils/logger.js"
import { createEfficiencyGate } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type { DropReader } from "../../../../src/decoders/enablement/efficiency-gate.js"
import type {
	LateDropWindow,
	RunningPlacement,
	WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"

import fc from "fast-check"
const placement = (key = "p", sourceId = "s"): WantedPlacement => ({
	key,
	decoderId: key,
	sourceId,
	reach: "raw",
	costCores: 0.1,
	sampleRateHz: 2048000,
	channelHz: null,
	origin: "band",
	primary: true,
})
function setup() {
	let mono = 0
	let attribution: unknown = "none"
	let windows: readonly LateDropWindow[] = []
	const warn = vi.fn()
	const drops: DropReader = {
		monoNow: () => mono,
		coverageCompleteAtMono: (_id, since, amount) =>
			mono >= since + amount ? since + amount : null,
		sources: () => ["s"],
		dropState: () => ({ state: "ok", dropBytesPerSecond: 0 }),
		droppedSinceMono: () => false,
		droppedWithinMs: () => false,
		latestAttribution: () =>
			attribution as ReturnType<NonNullable<DropReader["latestAttribution"]>>,
		lateWindows: () => windows,
	}
	const gate = createEfficiencyGate(
		{ budgetCores: 10, cpuGuardPercent: 90 },
		{ drops, log: { warn } as unknown as Logger },
	)
	return {
		gate,
		drops,
		warn,
		time: (value: number) => {
			mono = value
		},
		attribution: (value: unknown) => {
			attribution = value
		},
		windows: (value: readonly LateDropWindow[]) => {
			windows = value
		},
		running: (p = placement()): RunningPlacement => ({
			...p,
			admittedAtMs: 0,
			mode: "auto",
			startMode: "auto",
		}),
	}
}
const window = (
	startMono: number,
	condemning = true,
	linkOrUnknownDrops = false,
): LateDropWindow => ({
	startMono,
	endMono: startMono + 10000,
	condemning,
	linkOrUnknownDrops,
})

// Feature: link-burst-resilience, Property 10: Late shed
// Validates: Requirements 5.1, 5.2, 5.4, 5.5
it("sheds only the newest gated automatic placement after two of three windows", () => {
	fc.assert(
		fc.property(
			fc.array(fc.boolean(), { minLength: 3, maxLength: 3 }),
			fc.constantFrom("auto", "always", "operator", "config"),
			(hits, protection) => {
				const s = setup()
				const p = placement()
				expect(s.gate.admit(p, [], 0).admit).toBe(true)
				const active = s.running(p)
				if (protection === "always") active.mode = "always"
				if (protection === "operator") active.startMode = "operator"
				if (protection === "config") delete active.mode
				s.gate.probation([active], 0)
				s.time(30000)
				s.gate.probation([active], 0)
				s.windows(hits.map((hit, i) => window(30000 + i * 10000, hit)))
				s.time(60000)
				const expected =
					protection === "auto" && hits.filter(Boolean).length >= 2
				expect(s.gate.probation([active], 0)).toEqual(
					expected ? [{ key: p.key, detail: "late-drops" }] : [],
				)
				if (expected) {
					for (const at of [89999, 90000, 90001]) {
						s.time(at)
						expect(s.gate.probation([active], 0)).toEqual([])
					}
				}
			},
		),
		{ numRuns: 100 },
	)
})
// Feature: link-burst-resilience, Property 9: Clean window (gate half)
// Validates: Requirements 4.5
it("link admission never admits or records backoff", () => {
	fc.assert(
		fc.property(fc.integer({ min: 0, max: 1000000 }), now => {
			const s = setup()
			s.attribution("link")
			expect(s.gate.admit(placement(), [], now)).toEqual({
				admit: false,
				detail: "unknown",
				retryAtMs: now + 2000,
			})
			s.attribution("none")
			expect(s.gate.admit(placement(), [], now + 1).admit).toBe(true)
		}),
		{ numRuns: 100 },
	)
})

// Feature: link-burst-resilience, Property 8: Link neither condemns nor credits (gate half)
// Validates: Requirements 4.1, 4.2, 4.3
it("pull evidence preserves link probation and condemns other positive drops", () => {
	fc.assert(
		fc.property(
			fc.constantFrom("link", "consumer", "host", "unknown"),
			fc.integer({ min: 1, max: 29999 }),
			(attribution, time) => {
				const s = setup()
				const p = placement()
				s.gate.admit(p, [], 0)
				const active = [s.running(p)]
				s.gate.probation(active, 0)
				s.time(time)
				s.attribution(attribution)
				s.drops.droppedSinceMono = () => attribution !== "link"
				s.drops.coverageCompleteAtMono = () => null
				expect(s.gate.probation(active, 0)).toEqual(
					attribution === "link" ? [] : [{ key: p.key, detail: "drops" }],
				)
				expect(
					s.gate.view(active, [], 0).sources[0]?.admitted[0]?.probation,
				).toBe(true)
			},
		),
		{ numRuns: 100 },
	)
})

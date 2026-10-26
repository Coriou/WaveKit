import { describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import type { Logger } from "../../../../src/utils/logger.js"
import {
	createEfficiencyGate,
	type DropReader,
} from "../../../../src/decoders/enablement/efficiency-gate.js"
import {
	EFFICIENCY_DROP_WINDOW_MS,
	EFFICIENCY_PROBATION_MS,
	LATE_SHED_COOLDOWN_MS,
	type LateDropWindow,
	type RunningPlacement,
	type WantedPlacement,
} from "../../../../src/decoders/enablement/contract.js"

const wanted = (key: string): WantedPlacement => ({
	key,
	decoderId: key,
	sourceId: "s",
	reach: "raw",
	costCores: 0.1,
	sampleRateHz: 2048000,
	channelHz: null,
	origin: "band",
	primary: true,
})

type Kind = "auto" | "always" | "operator" | "yaml"

function harness() {
	let mono = 0
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
		latestAttribution: () => "consumer",
		lateWindows: () => windows,
	}
	const gate = createEfficiencyGate(
		{ budgetCores: 10, cpuGuardPercent: 90 },
		{ drops, log: { warn } as unknown as Logger },
	)
	let running: RunningPlacement[] = []
	const run = (key: string, kind: Kind): RunningPlacement => ({
		...wanted(key),
		admittedAtMs: 0,
		mode: kind === "always" ? "always" : "auto",
		startMode: kind === "operator" ? "operator" : "auto",
	})
	return {
		gate,
		warn,
		get mono() {
			return mono
		},
		get running() {
			return running
		},
		time(at: number) {
			mono = at
		},
		/** Admits through the gate (YAML never is), then graduates by coverage. */
		start(key: string, kind: Kind) {
			const p = run(key, kind)
			if (kind !== "yaml")
				expect(gate.admit(wanted(key), running, mono).admit).toBe(true)
			running = [...running, p]
			gate.probation(running, mono)
			mono += EFFICIENCY_PROBATION_MS
			gate.probation(running, mono)
		},
		/** Two condemning windows ending at or before `end`. */
		condemn(end: number) {
			windows = [
				{
					startMono: end - 2 * EFFICIENCY_DROP_WINDOW_MS,
					endMono: end - EFFICIENCY_DROP_WINDOW_MS,
					condemning: true,
					linkOrUnknownDrops: false,
				},
				{
					startMono: end - EFFICIENCY_DROP_WINDOW_MS,
					endMono: end,
					condemning: true,
					linkOrUnknownDrops: false,
				},
			]
		},
		/** Runs probation at `at`; applies any late shed like the manager. */
		step(at: number) {
			mono = at
			const verdicts = gate.probation(running, at)
			for (const v of verdicts) {
				gate.noteSuspended(v.key, v.detail, at)
				running = running.filter(p => p.key !== v.key)
			}
			return verdicts
		},
	}
}

describe("repeated late-drop shedding", () => {
	it("sheds four eligible placements newest first, one per cooldown, never protected ones", () => {
		const h = harness()
		// Interleave protected placements with the eligible ones so that
		// "newest admitted" alone would pick a protected placement each time.
		h.start("yaml", "yaml")
		h.start("a", "auto")
		h.start("always", "always")
		h.start("b", "auto")
		h.start("operator", "operator")
		h.start("c", "auto")
		h.start("d", "auto")
		h.start("always-2", "always")
		const shed: string[] = []
		let at = h.mono + 2 * EFFICIENCY_DROP_WINDOW_MS
		for (let round = 0; round < 4; round++) {
			if (round === 0) h.condemn(at)
			const verdicts = h.step(at)
			expect(verdicts).toHaveLength(1)
			expect(verdicts[0]!.detail).toBe("late-drops")
			shed.push(verdicts[0]!.key)
			// Fresh condemning windows wholly after the shed, inside the cooldown
			// (2 × 10 s = 20 s < 30 s): no shed at their end, nor one before the
			// bound; the next round sheds exactly at the bound.
			h.condemn(at + 2 * EFFICIENCY_DROP_WINDOW_MS)
			expect(h.step(at + 2 * EFFICIENCY_DROP_WINDOW_MS)).toEqual([])
			expect(h.step(at + LATE_SHED_COOLDOWN_MS - 1)).toEqual([])
			at += LATE_SHED_COOLDOWN_MS
		}
		expect(shed).toEqual(["d", "c", "b", "a"])
		// Only protected placements remain: still condemning, nothing sheds.
		h.condemn(at)
		expect(h.step(at)).toEqual([])
		expect(h.running.map(p => p.key).sort()).toEqual(
			["always", "always-2", "operator", "yaml"].sort(),
		)
		expect(h.warn).toHaveBeenCalledWith(
			expect.objectContaining({ reason: "nothing-sheddable" }),
			"Late drops not shed",
		)
	})

	it("windows from before the last shed cannot shed again after the cooldown", () => {
		const h = harness()
		for (const key of ["a", "b", "c"]) h.start(key, "auto")
		const at = h.mono + 2 * EFFICIENCY_DROP_WINDOW_MS
		h.condemn(at)
		expect(h.step(at)).toEqual([{ key: "c", detail: "late-drops" }])
		// The same windows (before late-since) at and past the cooldown bound.
		expect(h.step(at + LATE_SHED_COOLDOWN_MS)).toEqual([])
		expect(h.step(at + LATE_SHED_COOLDOWN_MS + 1)).toEqual([])
	})

	// Feature: link-burst-resilience, Property 10: Late shed
	// Validates: Requirements 5.2, 5.4, 5.5
	it("sheds in reverse admission order for any mix of eligible and protected placements", () => {
		fc.assert(
			fc.property(
				fc
					.array(fc.constantFrom<Kind>("always", "operator", "yaml"), {
						maxLength: 4,
					})
					.chain(protectedKinds =>
						fc
							.shuffledSubarray(
								[
									...protectedKinds.map(k => k),
									...Array.from({ length: 6 }, () => "auto" as const),
								],
								{ minLength: protectedKinds.length + 3 },
							)
							.map(kinds => kinds),
					),
				kinds => {
					const h = harness()
					const eligible: string[] = []
					kinds.forEach((kind, i) => {
						const key = `${kind}-${i}`
						if (kind === "auto") eligible.push(key)
						h.start(key, kind)
					})
					fc.pre(eligible.length >= 3)
					const shed: string[] = []
					let at = h.mono + 2 * EFFICIENCY_DROP_WINDOW_MS
					for (let round = 0; round <= eligible.length; round++) {
						h.condemn(at)
						for (const v of h.step(at)) shed.push(v.key)
						at += LATE_SHED_COOLDOWN_MS
					}
					expect(shed).toEqual([...eligible].reverse())
				},
			),
			{ numRuns: 100 },
		)
	})
})

// Validates: link-burst-resilience Requirement 5.3
it("preserves late-shed escalation across repeated graduated readmissions up to the cap", () => {
	const h = harness()
	h.start("a", "auto")
	for (const delay of [300_000, 600_000, 1_200_000, 1_800_000, 1_800_000]) {
		const shedAt = h.mono + 20_000
		h.condemn(shedAt)
		expect(h.step(shedAt)).toEqual([{ key: "a", detail: "late-drops" }])
		expect(h.gate.admit(wanted("a"), [], shedAt + 1)).toMatchObject({
			admit: false,
			detail: "late-drops",
			retryAtMs: shedAt + delay,
		})
		h.step(shedAt + delay)
		h.start("a", "auto")
	}
})

it.each([1_799_999, 1_800_000, 1_800_001, 7_200_000])(
	"decays late-shed history after 30 minutes since readmission: %s ms",
	elapsed => {
		const h = harness()
		h.start("a", "auto")
		h.condemn(50_000)
		expect(h.step(50_000)).toEqual([{ key: "a", detail: "late-drops" }])
		h.step(350_000)
		h.start("a", "auto")
		const shedAt = 350_000 + elapsed
		// Observe clean running at the exact boundary, independently of sampling cadence.
		expect(h.step(shedAt)).toEqual([])
		h.condemn(shedAt)
		expect(h.step(shedAt)).toEqual([{ key: "a", detail: "late-drops" }])
		expect(h.gate.admit(wanted("a"), [], shedAt + 1)).toMatchObject({
			admit: false,
			retryAtMs: shedAt + (elapsed < 1_800_000 ? 600_000 : 300_000),
		})
	},
)

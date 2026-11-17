import fc from "fast-check"
import { afterEach, expect, it, vi } from "vitest"
import { EFFICIENCY_SAMPLE_MS } from "../../../src/decoders/enablement/contract.js"
import {
	EFFICIENCY_REVIVE_MS,
	efficiencyReviveWaitMs,
} from "../../../src/decoders/manager.js"
import type {
	AdmissionDecision,
	WantedPlacement,
} from "../../../src/decoders/enablement/contract.js"
import { OTHERS, RATE, SECOND, passCostManager } from "./pass-cost-harness.js"

let f: ReturnType<typeof passCostManager> | undefined
afterEach(async () => {
	await f?.manager.destroy()
	f = undefined
	vi.useRealTimers()
})

/** The gate's answers for one decoder: each with the time asked and when it falls due. */
function refusals(decoderId: string) {
	return f!.admit.mock.calls.flatMap(([placement, , now], i) => {
		const answer = f!.admit.mock.results[i]?.value as
			| AdmissionDecision
			| undefined
		return placement.decoderId === decoderId && answer && !answer.admit
			? [{ now, dueAt: answer.retryAtMs }]
			: []
	})
}

/** Notices every 250 ms (a pass every 250 ms) for `ms`. */
async function noticesFor(ms: number) {
	for (let t = 0; t < ms; t += 250) {
		f!.notify()
		await f!.advance(250)
	}
}

const refuseOther =
	(delayMs: (n: number) => number, ids: readonly string[] = [OTHERS[1]]) =>
	(placement: WantedPlacement, now: number): AdmissionDecision | undefined => {
		if (!ids.includes(placement.decoderId)) return undefined
		return {
			admit: false,
			detail: "cpu",
			retryAtMs: now + delayMs(refusals(placement.decoderId).length),
		}
	}

it("re-evaluates a due refusal within a sample while activity passes run every 250 ms", async () => {
	f = passCostManager({ refuse: refuseOther(() => 3_000) })
	await f.manager.startAll()
	await f.advance(1_000)
	const first = refusals(OTHERS[1]).at(-1)!
	expect(first).toBeDefined()
	// Passes every 250 ms re-armed the 300 ms debounce before it fired, so the
	// due refusal was never asked again. Now its next answer is asked at most
	// EFFICIENCY_SAMPLE_MS (2,000 ms) after it fell due.
	await noticesFor(first.dueAt - performance.now() + EFFICIENCY_SAMPLE_MS + 250)
	const next = refusals(OTHERS[1]).find(r => r.now >= first.dueAt)
	expect(next).toBeDefined()
	expect(next!.now - first.dueAt).toBeLessThanOrEqual(EFFICIENCY_SAMPLE_MS)
})

it("retries an activity placement refused for budget at the next sample, not after the retry period", async () => {
	let refused: string | undefined
	f = passCostManager({
		refuse: (placement, now) => {
			if (placement.origin !== "activity" || refused === placement.key)
				return undefined
			if (refused !== undefined) return undefined
			refused = placement.key
			// The gate's answer to an activity slot over the budget (a race).
			return {
				admit: false,
				detail: "budget",
				retryAtMs: now + EFFICIENCY_SAMPLE_MS,
			}
		},
	})
	await f.manager.startAll()
	await f.advance(500)
	expect(refused).toBeDefined()
	const refusal = f.admit.mock.calls.findIndex(
		([placement]) => placement.key === refused,
	)
	const dueAt = (f.admit.mock.results[refusal]!.value as { retryAtMs: number })
		.retryAtMs
	await noticesFor(dueAt - performance.now() + EFFICIENCY_SAMPLE_MS + 250)
	const retry = f.admit.mock.calls
		.slice(refusal + 1)
		.find(([placement]) => placement.key === refused)
	expect(retry).toBeDefined()
	expect(retry![2]).toBeGreaterThanOrEqual(dueAt)
	expect(retry![2] - dueAt).toBeLessThanOrEqual(EFFICIENCY_SAMPLE_MS)
	expect(
		f
			.placements("voice")
			.find(p => p.channelHz !== null && p.origin === "activity" && !p.running),
	).toBeUndefined()
})

it("waits out the revive window of an unchanged due set at and past its bound", () => {
	const last = { due: '["b"]', atMs: 10_000 }
	// 2,000 - 300 = 1,700 ms after the evaluation began.
	expect(EFFICIENCY_REVIVE_MS).toBe(1_700)
	expect(efficiencyReviveWaitMs(last, '["b"]', 10_000 + 1_699)).toBe(1)
	expect(efficiencyReviveWaitMs(last, '["b"]', 10_000 + 1_700)).toBe(0)
	expect(efficiencyReviveWaitMs(last, '["b"]', 10_000 + 1_701)).toBe(0)
	// A changed set, no evaluation yet or an unreadable clock: now.
	expect(efficiencyReviveWaitMs(last, '["a","b"]', 10_001)).toBe(0)
	expect(efficiencyReviveWaitMs(undefined, '["b"]', 10_001)).toBe(0)
	expect(efficiencyReviveWaitMs(last, '["b"]', NaN)).toBe(0)
	expect(efficiencyReviveWaitMs({ due: '["b"]', atMs: NaN }, '["b"]', 1)).toBe(
		0,
	)
})

it("a decoder newly due is queued at once, without waiting out the window", async () => {
	f = passCostManager({ refuse: refuseOther(n => (n === 0 ? 0 : 300_000)) })
	await f.manager.startAll()
	await f.advance(5_000)
	// other-b settled on a long refusal; other-a now becomes due as well.
	const states = (
		f.manager as unknown as {
			decoders: Map<string, { admission?: AdmissionDecision }>
		}
	).decoders
	const a = states.get(OTHERS[0])!
	const asked = f.admit.mock.calls.length
	f.admit.mockImplementation((placement, _running, now) =>
		placement.decoderId === OTHERS[0] || placement.decoderId === OTHERS[1]
			? { admit: false, detail: "cpu", retryAtMs: now + 300_000 }
			: { admit: true },
	)
	await f.manager.stopDecoder(OTHERS[0])
	await f.manager.startDecoder(OTHERS[0])
	await f.advance(100)
	expect(a.admission?.admit).toBe(false)
	;(a.admission as { retryAtMs: number }).retryAtMs = performance.now()
	const start = performance.now()
	f.notify()
	// The pass (100 ms) queues it; the debounce (300 ms) runs it.
	await f.advance(100 + 300 + 50)
	const again = f.admit.mock.calls
		.slice(asked)
		.filter(([p, , now]) => p.decoderId === OTHERS[0] && now >= start)
	expect(again.length).toBeGreaterThanOrEqual(1)
	expect(again[0]![2] - start).toBeLessThanOrEqual(100 + 300)
})

// Every request is covered: whatever the pass timing, refusal delays and
// explicit triggers, each due refusal is asked again by an evaluation that
// starts after it fell due, within EFFICIENCY_SAMPLE_MS, and every revive
// that found a due decoder on a source is followed by an evaluation of that
// source. With a second source, each source is held to it on its own.
it("loses no evaluation: each due refusal and each revive request is covered by a later evaluation of its source", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.integer({ min: 0, max: 3_000 }), {
				minLength: 1,
				maxLength: 6,
			}),
			fc.array(fc.integer({ min: 100, max: 400 }), {
				minLength: 1,
				maxLength: 5,
			}),
			fc.array(fc.boolean(), { minLength: 1, maxLength: 7 }),
			fc.boolean(),
			async (delays, gaps, explicit, twoSources) => {
				try {
					const refused = twoSources
						? [OTHERS[1], SECOND.decoderId]
						: [OTHERS[1]]
					const sourceOf = new Map<string, string>([
						[OTHERS[1], "rtl"],
						[SECOND.decoderId, SECOND.sourceId],
					])
					f = passCostManager({
						refuse: refuseOther(n => delays[n % delays.length]!, refused),
						secondSource: twoSources,
					})
					await f.manager.startAll()
					await f.advance(1_000)
					const sourceIds = refused.map(id => sourceOf.get(id)!)
					const reviveAt: Array<{ at: number; sourceId: string }> = []
					const due = f.internals["dueEfficiencyBySource"]!.bind(f.manager) as (
						now: number,
					) => Map<string, string[]>
					const original = f.internals["reviveDueEfficiency"]!.bind(f.manager)
					f.internals["reviveDueEfficiency"] = ((...args: never[]) => {
						const now = performance.now()
						const excluded = (args as unknown[])[0]
						const dueNow = due(now)
						for (const sourceId of sourceIds)
							if (sourceId !== excluded && dueNow.has(sourceId))
								reviveAt.push({ at: now, sourceId })
						return original(...args)
					}) as (...args: never[]) => unknown
					const starts: Array<{ at: number; sourceId: string }> = []
					const handle = f.internals["handleCapsChange"]!.bind(f.manager)
					f.internals["handleCapsChange"] = ((...args: never[]) => {
						starts.push({
							at: performance.now(),
							sourceId: (args as unknown[])[0] as string,
						})
						return handle(...args)
					}) as (...args: never[]) => unknown
					const begin = performance.now()
					const end = begin + 6_000
					for (let i = 0; performance.now() < end; i++) {
						if (explicit[i % explicit.length])
							f.manager.notifyBandplansChanged()
						f.notify()
						await f.advance(gaps[i % gaps.length]!)
					}
					// Settle: requests still in flight get their evaluation.
					await f.advance(EFFICIENCY_SAMPLE_MS + 500)
					// Each refused decoder was refused on its own source.
					for (const id of refused)
						expect(refusals(id).length, id).toBeGreaterThan(0)
					for (const id of refused)
						for (const r of refusals(id)) {
							if (r.dueAt < begin || r.dueAt + EFFICIENCY_SAMPLE_MS > end)
								continue
							const next = refusals(id).find(n => n.now >= r.dueAt)
							expect(next).toBeDefined()
							expect(next!.now - r.dueAt).toBeLessThanOrEqual(
								EFFICIENCY_SAMPLE_MS,
							)
						}
					for (const r of reviveAt)
						if (r.at <= end)
							expect(
								starts.some(s => s.sourceId === r.sourceId && s.at >= r.at),
							).toBe(true)
				} finally {
					await f?.manager.destroy()
					f = undefined
					vi.useRealTimers()
				}
			},
		),
		{ numRuns: 100 },
	)
	// 100 runs of 9.5 s of fake time each (1 + 6 + 2.5 s); the runner's limit, not an assertion.
}, 60_000)

// A caps change (adapt) still re-arms the 300 ms debounce, as before this
// change: while a stream of them under 300 ms apart lasts, no evaluation of
// the source starts, so a due refusal is not asked again (unbounded while it
// lasts); once it stops, the evaluation starts 300 ms after the last one and
// asks it.
it("a stream of caps changes under 300 ms apart holds a due refusal until it stops, then asks it 300 ms after the last", async () => {
	f = passCostManager({ refuse: refuseOther(() => 0) })
	await f.manager.startAll()
	await f.advance(5_000)
	const starts: number[] = []
	const handle = f.internals["handleCapsChange"]!.bind(f.manager)
	f.internals["handleCapsChange"] = ((...args: never[]) => {
		if ((args as unknown[])[0] === "rtl") starts.push(performance.now())
		return handle(...args)
	}) as (...args: never[]) => unknown
	const begin = performance.now()
	// 15 changes 200 ms apart: 0 to 2,800 ms, longer than a sample.
	for (let i = 0; i < 15; i++) {
		f.sources.setRate("rtl", RATE)
		await f.advance(i < 14 ? 200 : 0)
	}
	const last = performance.now()
	expect(last - begin).toBe(2_800)
	expect(last - begin).toBeGreaterThan(EFFICIENCY_SAMPLE_MS)
	const asked = refusals(OTHERS[1]).length
	// Just before the debounce: nothing evaluated, nothing asked.
	await f.advance(299)
	expect(starts.filter(at => at >= begin)).toEqual([])
	expect(refusals(OTHERS[1])).toHaveLength(asked)
	// At it: one evaluation, which asks the due refusal again.
	await f.advance(1)
	expect(starts.filter(at => at >= begin)).toEqual([last + 300])
	expect(refusals(OTHERS[1]).length).toBeGreaterThan(asked)
	expect(refusals(OTHERS[1]).at(-1)!.now).toBe(last + 300)
})

/**
 * A gate that refuses OTHERS[1] for budget, due at once (retryAtMs = now),
 * with the sampling timer's fire times recorded; an explicit trigger lands
 * `leadMs` before a sample. Returns the evaluations of the source and the
 * refusals asked from the trigger on.
 */
async function budgetRefusalTrigger(leadMs: number, passesEveryMs?: number) {
	f = passCostManager({
		refuse: (placement, now) =>
			placement.decoderId === OTHERS[1]
				? { admit: false, detail: "budget", retryAtMs: now }
				: undefined,
	})
	const samples: number[] = []
	const schedule = globalThis.setTimeout
	vi.spyOn(globalThis, "setTimeout").mockImplementation(((
		callback: () => void,
		ms?: number,
	) => {
		if (ms === EFFICIENCY_SAMPLE_MS) samples.push(performance.now() + ms)
		return schedule(callback, ms)
	}) as typeof setTimeout)
	await f.manager.startAll()
	await f.advance(5_000)
	const starts: number[] = []
	const handle = f.internals["handleCapsChange"]!.bind(f.manager)
	f.internals["handleCapsChange"] = ((...args: never[]) => {
		if ((args as unknown[])[0] === "rtl") starts.push(performance.now())
		return handle(...args)
	}) as (...args: never[]) => unknown
	const sample = samples.filter(at => at > performance.now()).at(-1)!
	await f.advance(sample - leadMs - performance.now())
	const trigger = performance.now()
	f.manager.notifyBandplansChanged()
	if (passesEveryMs === undefined) await f.advance(4_700)
	else
		for (let t = 0; t < 4_700; t += passesEveryMs) {
			f.notify()
			await f.advance(passesEveryMs)
		}
	return {
		trigger,
		sample,
		starts: starts.filter(at => at >= trigger),
		asked: refusals(OTHERS[1]).filter(r => r.now >= trigger),
	}
}

// Without activity passes the revive timer is never armed for the source (a
// source evaluation's own reconciliation skips its source), so only the
// sampling timer asks: it finds the refusal due at the next sample and queues
// an evaluation behind the 300 ms caps debounce, as before this change. A
// refusal due d ms before that sample is asked d + 300 ms after it fell due.
// With the trigger L ms before a sample (0 < L < 300) it falls due 300 - L ms
// after it, so it is asked 2,000 - (300 - L) + 300 = 2,000 + L ms after it
// fell due: past one sample by L, and always under EFFICIENCY_SAMPLE_MS + 300.
it.each([10, 299])(
	"a budget refusal due at once, trigger %i ms before a sample, no passes: asked again at the next sample plus the debounce, under one sample plus 300 ms",
	async leadMs => {
		const r = await budgetRefusalTrigger(leadMs)
		// The trigger's evaluation, then one per sample, each 300 ms after it.
		expect(r.starts).toEqual([
			r.trigger + 300,
			r.sample + EFFICIENCY_SAMPLE_MS + 300,
			r.sample + 2 * EFFICIENCY_SAMPLE_MS + 300,
		])
		const [first, second] = r.asked
		expect(first).toEqual({ now: r.trigger + 300, dueAt: r.trigger + 300 })
		expect(second!.now).toBe(r.sample + EFFICIENCY_SAMPLE_MS + 300)
		const gap = second!.now - first!.dueAt
		expect(gap).toBe(EFFICIENCY_SAMPLE_MS + leadMs)
		expect(gap).toBeLessThan(EFFICIENCY_SAMPLE_MS + 300)
	},
)

// With activity passes every 250 ms (the case the revive window is for),
// a pass after the trigger's evaluation finds the same due set and arms the
// revive timer EFFICIENCY_REVIVE_MS (1,700 ms) after that evaluation began;
// its evaluation begins 300 ms later, EFFICIENCY_SAMPLE_MS after the first,
// which is when the refusal fell due: within one sample.
it("a budget refusal due at once, trigger just before a sample, passes every 250 ms: asked again within one sample", async () => {
	const r = await budgetRefusalTrigger(10, 250)
	// 1,700 + 300 = 2,000 ms apart from the trigger's evaluation on; the
	// samples in between join a queued evaluation or find it not yet due.
	const first = r.trigger + 300
	expect(r.starts).toEqual([
		first,
		first + EFFICIENCY_SAMPLE_MS,
		first + 2 * EFFICIENCY_SAMPLE_MS,
	])
	expect(r.asked.map(a => a.now)).toEqual(r.starts)
	for (let i = 1; i < r.asked.length; i++)
		expect(r.asked[i]!.now - r.asked[i - 1]!.dueAt).toBe(EFFICIENCY_SAMPLE_MS)
})

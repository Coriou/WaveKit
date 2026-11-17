import { readFile } from "node:fs/promises"
import { types } from "node:util"
import fc from "fast-check"
import { afterEach, describe, expect, it, vi } from "vitest"
import { EFFICIENCY_SAMPLE_MS } from "../../../src/decoders/enablement/contract.js"
import type {
	PlannerInput,
	WantedPlacement,
} from "../../../src/decoders/enablement/contract.js"
import {
	observedActivitySchemas,
	placementOptionsMemo,
} from "../../../src/decoders/manager.js"
import { OTHERS, VOICE, passCostManager } from "./pass-cost-harness.js"

let f: ReturnType<typeof passCostManager> | undefined
afterEach(async () => {
	await f?.manager.destroy()
	f = undefined
	vi.restoreAllMocks()
	vi.useRealTimers()
})

type State = { config: { id: string }; placement?: WantedPlacement }

/**
 * Records each band resolution with the synchronous section it ran in: a
 * section ends at the first microtask boundary (any await), which bumps
 * the section number.
 */
function bandResolutions(h: ReturnType<typeof passCostManager>) {
	const calls = h.count("resolveBandNow")
	const sections: number[] = []
	let section = 0
	let marked = false
	const original = h.internals["resolveBandNow"]!
	h.internals["resolveBandNow"] = ((...args: never[]) => {
		if (!marked) {
			marked = true
			queueMicrotask(() => {
				marked = false
				section++
			})
		}
		sections.push(section)
		return original(...args)
	}) as (...args: never[]) => unknown
	return {
		/** Resolutions of one state within one section, the largest count. */
		maxPerStateAndSection: () => {
			const seen = new Map<string, number>()
			calls.forEach((args, i) => {
				const key = `${sections[i]}:${(args[0] as State).config.id}`
				seen.set(key, (seen.get(key) ?? 0) + 1)
			})
			return Math.max(0, ...seen.values())
		},
		total: () => calls.length,
		results: calls,
	}
}

const refuseOtherB = (retryMs: number) => ({
	refuse: (placement: WantedPlacement, now: number) =>
		placement.decoderId === OTHERS[1]
			? {
					admit: false as const,
					detail: "cpu" as const,
					retryAtMs: now + retryMs,
				}
			: undefined,
})

describe("the cost of one activity pass", () => {
	it("plans once, resolves each band once per section, passes no unchanged options and parses no well-formed centres", async () => {
		f = passCostManager(refuseOtherB(300_000))
		await f.manager.startAll()
		await f.advance(5_000)
		// The realistic set: a primary and three activity slots of one type,
		// one other decoder running and one suspended for the gate.
		const voice = f.placements(VOICE)
		expect(
			voice.filter(p => p.origin === "activity" && p.running),
		).toHaveLength(3)
		expect(f.placements(OTHERS[0]).map(p => p.running)).toEqual([true])
		expect(f.manager.getStatus(OTHERS[1])?.suspension?.reasonCode).toBe(
			"efficiency-budget",
		)
		const passes = f.count("reconcilePlacementsPass")
		const bands = bandResolutions(f)
		const centres = vi.spyOn(observedActivitySchemas.centres, "safeParse")
		const copies = vi.spyOn(placementOptionsMemo, "copy")
		const compares = vi.spyOn(placementOptionsMemo, "same")
		const plans = f.plans.count
		const inputs = f.planner.mock.calls.length
		const lookups = f.bandplanChannels.mock.calls.length
		const updates = f.optionUpdates.length
		f.notify()
		// The pass runs ACTIVITY_PASS_COALESCE_MS (100 ms) after the notice.
		await f.advance(100)
		expect(passes).toHaveLength(1)
		// One planner run, given the grouping its queries came from, and an
		// input that carries the range lookup as production's does (it comes
		// from the enablement options, so both calls see it).
		expect(f.plans.count - plans).toBe(1)
		const input = f.planner.mock.calls[inputs]![0]
		expect(input.grouping).toBeDefined()
		expect(input.bandplanRangeContains).toBe(f.bandplanRangeContains)
		// One grouping: the one catalogue voice decoder on the one source looks
		// its band plan up once (twice when the plan groups again).
		expect(f.bandplanChannels.mock.calls.length - lookups).toBe(1)
		// At most one resolution per decoder state per synchronous section;
		// the set holds 1 + 3 voice states and 2 others, D = 6.
		expect(bands.total()).toBeGreaterThan(0)
		expect(bands.maxPerStateAndSection()).toBe(1)
		// Nothing changed in the options any placement passes: each placed
		// state is compared with its recorded copy, and nothing is copied or
		// built for the unchanged options.
		expect(f.optionUpdates.length - updates).toBe(0)
		expect(compares).toHaveBeenCalled()
		expect(compares.mock.results.every(r => r.value === true)).toBe(true)
		expect(copies).not.toHaveBeenCalled()
		// Three well-formed observed centres: the guard, no schema parse.
		expect(centres).not.toHaveBeenCalled()
	})

	it("20 notices 250 ms apart: at most 20 passes and ceil(5 s / sample) + 1 source evaluations", async () => {
		// The worst steady state: a refusal that is due again at once, so every
		// pass finds the same due decoder.
		f = passCostManager(refuseOtherB(0))
		await f.manager.startAll()
		await f.advance(5_000)
		const passes = f.count("reconcilePlacementsPass")
		const evaluations = f.count("handleCapsChange")
		for (let i = 0; i < 20; i++) {
			f.notify()
			await f.advance(250)
		}
		// A notice schedules a pass 100 ms later; notices while it is scheduled
		// or running only mark it dirty: at most one pass per notice, and each
		// source evaluation runs one more (its own reconciliation).
		const evaluated = evaluations.filter(([sourceId]) => sourceId === "rtl")
		expect(passes.length).toBeLessThanOrEqual(20 + evaluated.length)
		expect(passes.length - evaluated.length).toBeLessThanOrEqual(20)
		// 20 x 250 ms = 5,000 ms. An unchanged due set is queued again 1,700 ms
		// after its last evaluation began and the sampling timer adds at most
		// one per 2,000 ms, which joins it: at most one per sample, plus the
		// one a window may start with: ceil(5,000 / 2,000) + 1 = 4.
		expect(evaluated.length).toBeLessThanOrEqual(
			Math.ceil(5_000 / EFFICIENCY_SAMPLE_MS) + 1,
		)
		// And the due refusal is still asked again: not starved.
		expect(evaluated.length).toBeGreaterThanOrEqual(2)
	})
})

describe("band resolution memo", () => {
	it("a band override written during an awaited step of a pass is what the rest of the pass reads", async () => {
		f = passCostManager()
		await f.manager.startAll()
		await f.advance(5_000)
		const bands = bandResolutions(f)
		const override = {
			rangesHz: [{ minHz: 400_000_000, maxHz: 400_100_000 }],
		}
		let wrote = -1
		// The probation step is awaited by the pass before it plans.
		f.gate.probation = vi.fn(() => {
			if (wrote < 0) {
				wrote = bands.total()
				void f!.manager.setBandOverride(VOICE, override)
			}
			return []
		})
		const inputs = f.planner.mock.calls.length
		f.notify()
		await f.advance(100)
		// The probation step resolved the voice band before the write ...
		const before = bands.results
			.slice(0, wrote)
			.filter(([state]) => (state as State).config.id === VOICE)
		expect(before.length).toBeGreaterThan(0)
		// ... and the plan after the await reads the new band, not a memo.
		const input = f.planner.mock.calls[inputs]![0] as PlannerInput
		expect(input.decoders.find(d => d.id === VOICE)?.band?.rangesHz).toEqual(
			override.rangesHz,
		)
	})

	it("is never left on between sections", async () => {
		f = passCostManager()
		await f.manager.startAll()
		await f.advance(5_000)
		f.notify()
		await f.advance(100)
		expect((f.manager as unknown as { bandMemo: unknown }).bandMemo).toBeNull()
	})
})

describe("placement options", () => {
	it("passes options again after any other options update, and when they change", async () => {
		f = passCostManager()
		await f.manager.startAll()
		await f.advance(5_000)
		const decoder = f.decoders.get(OTHERS[0])!
		const own = () => f!.optionUpdates.filter(u => u.id === OTHERS[0])
		const before = own().length
		f.notify()
		await f.advance(250)
		expect(own().length).toBe(before)
		// An update from elsewhere (channel wiring, caps): the next pass
		// passes the placement's options again, once.
		;(
			f.internals["updateDecoderOptions"] as unknown as (
				d: unknown,
				u: Record<string, unknown>,
			) => void
		).call(f.manager, decoder, { inputSampleRate: 48_000 })
		f.notify()
		await f.advance(250)
		expect(own().length).toBe(before + 2)
		f.notify()
		await f.advance(250)
		expect(own().length).toBe(before + 2)
	})

	it("compares options as a merge tells them apart", () => {
		const { copy, same } = placementOptionsMemo
		/** Options `b` compare equal to a recorded copy of `a`. */
		const eq = (a: Record<string, unknown>, b: Record<string, unknown>) => {
			const recorded = copy(a)
			return recorded !== null && same(recorded, b)
		}
		expect(eq({ a: 1, b: [1, { c: "x" }] }, { a: 1, b: [1, { c: "x" }] })).toBe(
			true,
		)
		expect(eq({ a: undefined }, {})).toBe(false)
		expect(eq({}, { a: undefined })).toBe(false)
		expect(eq({ a: 0 }, { a: -0 })).toBe(false)
		expect(eq({ a: NaN }, { a: NaN })).toBe(true)
		expect(eq({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false)
		expect(eq({ a: [1] }, { a: [1, undefined] })).toBe(false)
		expect(eq({ a: [1, , 3] }, { a: [1, 3] })).toBe(false)
		expect(eq({ a: [1, , 3] }, { a: [1, undefined, 3] })).toBe(false)
		expect(eq({ a: "1" }, { a: 1 })).toBe(false)
		expect(eq({ a: 1n }, { a: 1 })).toBe(false)
		expect(eq({ a: [] }, { a: {} })).toBe(false)
		expect(eq({ a: null }, { a: {} })).toBe(false)
		const cyclic: Record<string, unknown> = {}
		cyclic["self"] = cyclic
		const accessor = Object.defineProperty({}, "a", {
			get: () => 1,
			enumerable: true,
		})
		const unvouched = [
			cyclic,
			accessor,
			{ a: new Date(0) },
			{ a: () => 1 },
			{ a: Symbol("s") },
			{ a: new Proxy({}, {}) },
			{ [Symbol("k")]: 1 },
			Object.defineProperty({}, "hidden", { value: 1, enumerable: false }),
		]
		// Options it cannot vouch for are not recorded (always passed again)
		// and never compare equal to a recorded copy.
		const recorded = copy({ a: 1, self: { self: {} } })!
		for (const unknown of unvouched) {
			const options = unknown as Record<string, unknown>
			expect(copy(options)).toBeNull()
			expect(same(recorded, options)).toBe(false)
		}
		const shared = { x: 1 }
		expect(eq({ a: shared, b: shared }, { a: { x: 1 }, b: { x: 1 } })).toBe(
			true,
		)
		// A null-prototype object reads as the plain one.
		expect(
			eq({ a: { x: 1 } }, { a: Object.assign(Object.create(null), { x: 1 }) }),
		).toBe(true)
		// An own "__proto__" member is a member, kept by the copy.
		const own = JSON.parse('{"__proto__": 1}') as Record<string, unknown>
		expect(
			eq(own, JSON.parse('{"__proto__": 1}') as Record<string, unknown>),
		).toBe(true)
		expect(eq(own, {})).toBe(false)
	})

	it("the recorded copy is not changed by an in-place change of the options passed", () => {
		const { copy, same } = placementOptionsMemo
		const options: Record<string, unknown> = { a: [1, 2], b: { c: 1 } }
		const recorded = copy(options)!
		;(options["a"] as number[]).push(3)
		expect(same(recorded, options)).toBe(false)
		expect(same(recorded, { a: [1, 2], b: { c: 1 } })).toBe(true)
	})

	// The comparison agrees with a structural identity string of the options
	// (the reference: equal strings for options a merge treats alike, null
	// for anything it cannot vouch for) on generated pairs.
	it("agrees with the structural identity of the options on generated pairs", () => {
		const leaf = fc.constantFrom<unknown>(
			0,
			-0,
			1,
			NaN,
			"1",
			"a",
			true,
			false,
			null,
			undefined,
			1n,
		)
		const odd = fc.constantFrom<unknown>(() => 1, Symbol.for("s"), new Date(0))
		const { value } = fc.letrec<{ value: unknown }>(tie => ({
			value: fc.oneof(
				{ depthSize: "small", withCrossShrink: true },
				{ weight: 6, arbitrary: leaf },
				{ weight: 1, arbitrary: odd },
				{ weight: 2, arbitrary: fc.array(tie("value"), { maxLength: 3 }) },
				{
					weight: 1,
					arbitrary: fc.sparseArray(tie("value"), { maxLength: 3 }),
				},
				{
					weight: 2,
					arbitrary: fc.dictionary(
						fc.constantFrom("a", "b", "1"),
						tie("value"),
						{ maxKeys: 3 },
					),
				},
			),
		}))
		const options = fc.dictionary(fc.constantFrom("x", "y", "0"), value, {
			maxKeys: 3,
		})
		let equal = 0
		fc.assert(
			fc.property(options, options, fc.boolean(), (a, other, twin) => {
				const b = twin ? (structuredCopy(a) as Record<string, unknown>) : other
				const ia = identity(a)
				const expected = ia !== null && ia === identity(b)
				const recorded = placementOptionsMemo.copy(a)
				expect(recorded === null).toBe(ia === null)
				expect(
					recorded !== null && placementOptionsMemo.same(recorded, b),
				).toBe(expected)
				if (expected) equal++
			}),
			{ numRuns: 300 },
		)
		// Not vacuous: many pairs compare equal.
		expect(equal).toBeGreaterThan(60)
	})
})

/**
 * Test reference: the structural identity of options as a string, or null
 * when it cannot vouch for them (an accessor, a non-enumerable or symbol
 * member, a Proxy, a non-plain object, a function, a symbol or a cycle).
 */
function identity(options: Readonly<Record<string, unknown>>): string | null {
	const parts: string[] = []
	const ancestors = new Set<object>()
	const visit = (value: unknown): boolean => {
		switch (typeof value) {
			case "undefined":
				parts.push("u")
				return true
			case "boolean":
				parts.push(value ? "t" : "f")
				return true
			case "number":
				parts.push(Object.is(value, -0) ? "n-0" : `n${value}`)
				return true
			case "bigint":
				parts.push(`b${value}`)
				return true
			case "string":
				parts.push(JSON.stringify(value))
				return true
			case "object":
				break
			default:
				return false
		}
		if (value === null) {
			parts.push("z")
			return true
		}
		if (types.isProxy(value) || ancestors.has(value)) return false
		const array = Array.isArray(value)
		const prototype: unknown = Object.getPrototypeOf(value)
		if (
			array
				? prototype !== Array.prototype
				: prototype !== Object.prototype && prototype !== null
		)
			return false
		ancestors.add(value)
		parts.push(array ? `[${(value as unknown[]).length}` : "{")
		for (const key of Reflect.ownKeys(value)) {
			if (array && key === "length") continue
			if (typeof key !== "string") return false
			const descriptor = Object.getOwnPropertyDescriptor(value, key)
			if (
				descriptor === undefined ||
				!descriptor.enumerable ||
				!("value" in descriptor)
			)
				return false
			parts.push(JSON.stringify(key), ":")
			if (!visit(descriptor.value)) return false
		}
		parts.push(array ? "]" : "}")
		ancestors.delete(value)
		return true
	}
	return visit(options) ? parts.join("") : null
}

/** A structural copy keeping member order, holes and every leaf as is. */
function structuredCopy(value: unknown): unknown {
	if (typeof value !== "object" || value === null || value instanceof Date)
		return value
	const out: Record<string, unknown> = Array.isArray(value)
		? (new Array<unknown>(value.length) as unknown as Record<string, unknown>)
		: {}
	for (const key of Object.keys(value))
		out[key] = structuredCopy((value as Record<string, unknown>)[key])
	return out
}

describe("source evaluation requests", () => {
	// Only a caps change re-arms the 300 ms debounce; any other request joins
	// the pending drain, and one arriving after a drain began arms a new
	// one. Requests every 50 ms over 900 ms (0 to 850 ms): drains at 300,
	// 600 and 900 ms, three evaluations, where re-arming gave one at 1,150 ms.
	it("a burst of re-evaluation requests over 900 ms gives one evaluation per 300 ms, each reading the state when it runs", async () => {
		f = passCostManager()
		await f.manager.startAll()
		await f.advance(5_000)
		const evaluations: Array<{ at: number; startMode: unknown }> = []
		const internals = f.internals
		const handle = internals["handleCapsChange"]!.bind(f.manager)
		const states = (
			f.manager as unknown as {
				decoders: Map<string, { startMode?: unknown }>
			}
		).decoders
		internals["handleCapsChange"] = ((...args: never[]) => {
			evaluations.push({
				at: performance.now(),
				startMode: states.get(OTHERS[0])?.startMode,
			})
			return handle(...args)
		}) as (...args: never[]) => unknown
		const set: Array<{ at: number; mode: "auto" | "operator" }> = []
		const begin = performance.now()
		for (let i = 0; i < 18; i++) {
			const mode = i % 2 === 0 ? "operator" : "auto"
			// A start-mode change re-evaluates the decoder's band: a request
			// with adapt false (reevaluateBand).
			expect(f.manager.setStartMode(OTHERS[0], mode)).toBe(true)
			set.push({ at: performance.now(), mode })
			await f.advance(50)
		}
		await f.advance(1_000)
		const ours = evaluations.filter(e => e.at >= begin)
		expect(ours.map(e => e.at - begin)).toEqual([300, 600, 900])
		// Each reads the start mode last set before it began, not the one of
		// the request that armed its debounce (a request at the same instant
		// as a drain comes after it: the fake clock ran the timer first).
		for (const e of ours) {
			const last = set.filter(s => s.at < e.at).at(-1)!
			expect(e.startMode).toBe(last.mode)
		}
		expect(ours[0]!.startMode).not.toBe(set[0]!.mode)
	})
})

describe("production planner shape", () => {
	// The harness above builds its planner as src/index.ts does; this fails
	// when index.ts stops doing so (a wrapper that adds input members would
	// make the planner's input differ from the one the queries were grouped
	// for, so every pass would group twice).
	it("src/index.ts passes planPlacements itself and the range lookup through the enablement options", async () => {
		const source = await readFile(
			new URL("../../../src/index.ts", import.meta.url),
			"utf8",
		)
		const block = /enablement: \{([\s\S]*?)\n\t{4}\},/.exec(source)?.[1]
		expect(block).toBeDefined()
		expect(block).toMatch(/\n\t+planner: planPlacements,\n/)
		expect(block).toMatch(/\n\t+bandplanRangeContains,\n/)
		expect(source).not.toMatch(/planPlacements\(/)
	})
})

describe("placement indexes", () => {
	it("pick the first state in insertion order holding a key, as the scans did", async () => {
		f = passCostManager()
		await f.manager.startAll()
		await f.advance(5_000)
		const m = f.manager as unknown as {
			decoders: Map<string, State & { parentId?: string }>
			statesByPlacementKey(): Map<string, unknown>
			workersByPlacementKey(): { byKey: Map<string, unknown[]> }
		}
		const states = [...m.decoders.values()]
		// Give a later worker an earlier state's key: the first one still wins.
		const placed = states.filter(s => s.placement)
		const worker = placed.filter(s => s.parentId !== undefined).at(-1)!
		const first = placed[0]!
		const saved = worker.placement!
		worker.placement = { ...saved, key: first.placement!.key }
		try {
			const byKey = m.statesByPlacementKey()
			for (const state of placed) {
				const key = state.placement!.key
				expect(byKey.get(key)).toBe(states.find(s => s.placement?.key === key))
			}
			const workers = m.workersByPlacementKey().byKey
			for (const state of placed) {
				const key = state.placement!.key
				expect(workers.get(key)?.[0]).toBe(
					states.find(
						s => s.parentId !== undefined && s.placement?.key === key,
					),
				)
			}
		} finally {
			worker.placement = saved
		}
	})
})

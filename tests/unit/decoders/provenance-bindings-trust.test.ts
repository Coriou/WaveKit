/**
 * WG5 req 6: verified tuning trust from the observed tuner state, over structural fakes.
 */

import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	createDecoderProvenanceIndex,
	type ProvenanceDecoderSource,
	type ProvenanceTunerSource,
	type ProvenanceTunerState,
} from "../../../src/decoders/provenance-bindings.js"

interface FakeDecoder {
	sourceId?: string
	targets?: number[]
	external?: boolean
}

class FakeDecoders extends EventEmitter implements ProvenanceDecoderSource {
	readonly items = new Map<string, FakeDecoder>()
	add(id: string, decoder: FakeDecoder): void {
		this.items.set(id, decoder)
		this.emit("decoder:created", id)
	}
	start(id: string): void {
		this.emit("decoder:started", id)
	}
	remove(id: string): void {
		this.items.delete(id)
		this.emit("decoder:removed", id)
	}
	getAllDecoders() {
		return [...this.items.keys()].map(id => ({ id }))
	}
	getStatus(id: string) {
		const decoder = this.items.get(id)
		if (!decoder) return undefined
		return {
			...(decoder.sourceId === undefined ? {} : { sourceId: decoder.sourceId }),
			...(decoder.targets === undefined
				? {}
				: { targetFrequenciesHz: decoder.targets }),
		}
	}
	getDecoder(id: string) {
		const decoder = this.items.get(id)
		if (!decoder) return undefined
		return { caps: { input: decoder.external ? "external" : "iq" } }
	}
}

class FakeTuner extends EventEmitter implements ProvenanceTunerSource {
	readonly states = new Map<string, ProvenanceTunerState>()
	reads = 0
	throws = false
	getState(sourceId: string): ProvenanceTunerState | undefined {
		this.reads++
		if (this.throws) throw new Error("tuner gone")
		const state = this.states.get(sourceId)
		return state ? { ...state } : undefined
	}
	set(sourceId: string, state: ProvenanceTunerState): void {
		this.states.set(sourceId, state)
		this.emit("state-changed", sourceId, { ...state })
	}
	mode(sourceId: string, controlMode: "internal" | "external"): void {
		const state = this.states.get(sourceId)
		if (state) this.states.set(sourceId, { ...state, controlMode })
		this.emit("control-mode-changed", sourceId, controlMode)
	}
}

const MAIN = "sdr-main"
const tuned = (
	frequency: number,
	controlMode: "internal" | "external" = "internal",
	sampleRate = 2_400_000,
): ProvenanceTunerState => ({ frequency, sampleRate, controlMode })

function setup(state: ProvenanceTunerState | null = tuned(131_000_000)) {
	const decoders = new FakeDecoders()
	const tuner = new FakeTuner()
	if (state) tuner.states.set(MAIN, state)
	let fallback: string | undefined = MAIN
	const index = createDecoderProvenanceIndex(decoders, () => fallback, tuner)
	return {
		decoders,
		tuner,
		index,
		setDefault: (id: string | undefined) => {
			fallback = id
		},
	}
}

describe("verified tuning trust (WG5 req 6)", () => {
	it("is unverified without a tuner source (req 6.1)", () => {
		const decoders = new FakeDecoders()
		decoders.add("a", { targets: [131_550_000] })
		const index = createDecoderProvenanceIndex(decoders, () => MAIN)
		expect(index.lookup("a")?.tuningTrust).toBe("unverified")
		expect(decoders.listenerCount("decoder:started")).toBe(0)
		index.dispose()
	})

	it("is commanded under internal control and relay under external (req 6.2)", () => {
		const { decoders, tuner, index } = setup()
		decoders.add("a", { targets: [131_550_000] })
		expect(index.lookup("a")).toEqual({
			sourceId: MAIN,
			targetFrequenciesHz: [131_550_000],
			tuningTrust: "commanded",
		})
		tuner.mode(MAIN, "external")
		expect(index.lookup("a")?.tuningTrust).toBe("relay")
	})

	it("drops to unverified after a retune until the decoder starts again (req 6.3)", () => {
		const { decoders, tuner, index } = setup()
		decoders.add("a", { targets: [131_550_000] })
		tuner.set(MAIN, tuned(131_100_000, "external"))
		expect(index.lookup("a")?.tuningTrust).toBe("unverified")
		decoders.start("a")
		expect(index.lookup("a")?.tuningTrust).toBe("relay")
		tuner.set(MAIN, tuned(131_000_000, "external"))
		expect(index.lookup("a")?.tuningTrust).toBe("unverified")
	})

	it("applies the 0.45 × rate margin at the bound and just past it", () => {
		const { decoders, index } = setup(tuned(100_000_000, "internal", 2_000_000))
		decoders.add("at", { targets: [100_900_000, 99_100_000] })
		decoders.add("past", { targets: [100_000_000, 100_900_001] })
		expect(index.lookup("at")?.tuningTrust).toBe("commanded")
		expect(index.lookup("past")?.tuningTrust).toBe("unverified")
	})

	it("is unverified with no targets, an own device or unknown fields", () => {
		const { decoders, tuner, index } = setup()
		decoders.add("none", {})
		decoders.add("ext", { external: true, sourceId: MAIN, targets: [131e6] })
		decoders.add("ok", { targets: [131_000_000] })
		expect(index.lookup("none")?.tuningTrust).toBe("unverified")
		expect(index.lookup("ext")).toMatchObject({
			sourceId: null,
			tuningTrust: "unverified",
		})
		for (const field of ["frequency", "sampleRate"] as const) {
			tuner.set(MAIN, { ...tuned(131_000_000), unknownFields: [field] })
			expect(index.lookup("ok")?.tuningTrust).toBe("unverified")
		}
		tuner.set(MAIN, { ...tuned(131_000_000), unknownFields: ["gain"] })
		expect(index.lookup("ok")?.tuningTrust).toBe("commanded")
	})

	it("is unverified when the source has no state, and never reads state in lookup", () => {
		const { decoders, tuner, index } = setup(null)
		decoders.add("a", { targets: [131_000_000] })
		const reads = tuner.reads
		for (let i = 0; i < 10; i++)
			expect(index.lookup("a")?.tuningTrust).toBe("unverified")
		expect(tuner.reads).toBe(reads)
		// State arriving later does not prove the centre the decoder bound to.
		tuner.set(MAIN, tuned(131_000_000))
		expect(index.lookup("a")?.tuningTrust).toBe("unverified")
		decoders.start("a")
		expect(index.lookup("a")?.tuningTrust).toBe("commanded")
	})

	it("treats a throwing getState as no snapshot (req 6.5)", () => {
		const { decoders, tuner, index } = setup(null)
		tuner.throws = true
		expect(() => decoders.add("a", { targets: [131e6] })).not.toThrow()
		expect(index.lookup("a")?.tuningTrust).toBe("unverified")
		tuner.states.set(MAIN, tuned(131e6))
		decoders.start("a")
		expect(index.lookup("a")?.tuningTrust).toBe("unverified")
		expect(() => tuner.mode(MAIN, "external")).not.toThrow()
		tuner.throws = false
		tuner.mode(MAIN, "internal")
		decoders.start("a")
		expect(index.lookup("a")?.tuningTrust).toBe("commanded")
		tuner.throws = true
		tuner.mode(MAIN, "external")
		expect(index.lookup("a")?.tuningTrust).toBe("unverified")
	})

	it("degrades malformed states to unverified without throwing", () => {
		const { decoders, tuner, index } = setup()
		decoders.add("a", { targets: [131_000_000] })
		const hostile: unknown[] = [
			undefined,
			null,
			42,
			{},
			{ frequency: 131e6 },
			{ frequency: Number.NaN, sampleRate: 2.4e6, controlMode: "internal" },
			{ frequency: 131e6, sampleRate: Number.NaN, controlMode: "internal" },
			{ frequency: 131e6, sampleRate: 0, controlMode: "internal" },
			{ frequency: 131e6, sampleRate: -1, controlMode: "internal" },
			{ frequency: 131e6, sampleRate: Infinity, controlMode: "internal" },
			{ frequency: "131e6", sampleRate: 2.4e6, controlMode: "internal" },
			{ frequency: 131e6, sampleRate: 2.4e6, unknownFields: "frequency" },
		]
		for (const state of hostile) {
			expect(() => tuner.emit("state-changed", MAIN, state)).not.toThrow()
			expect(index.lookup("a")?.tuningTrust).toBe("unverified")
		}
		tuner.set(MAIN, tuned(131_000_000))
		expect(index.lookup("a")?.tuningTrust).toBe("commanded")
	})

	it("binds the source read at start; a default-source change is unverified until restart", () => {
		const { decoders, tuner, index, setDefault } = setup()
		tuner.states.set("sdr-b", tuned(131_000_000))
		decoders.add("a", { targets: [131_000_000] })
		setDefault("sdr-b")
		expect(index.lookup("a")).toMatchObject({
			sourceId: "sdr-b",
			tuningTrust: "unverified",
		})
		decoders.start("a")
		expect(index.lookup("a")?.tuningTrust).toBe("commanded")
		setDefault(undefined)
		expect(index.lookup("a")).toMatchObject({
			sourceId: null,
			tuningTrust: "unverified",
		})
	})

	it("handles an unknown source, a removed decoder and events after dispose", () => {
		const { decoders, tuner, index } = setup()
		decoders.add("other", { sourceId: "sdr-gone", targets: [131e6] })
		expect(index.lookup("other")?.tuningTrust).toBe("unverified")
		decoders.add("a", { targets: [131_000_000] })
		decoders.remove("a")
		expect(index.lookup("a")).toBeNull()
		decoders.start("a")
		expect(index.lookup("a")).toBeNull()
		decoders.add("b", { targets: [131_000_000] })
		index.dispose()
		for (const event of [
			"decoder:created",
			"decoder:started",
			"decoder:removed",
		])
			expect(decoders.listenerCount(event)).toBe(0)
		expect(tuner.listenerCount("state-changed")).toBe(0)
		expect(tuner.listenerCount("control-mode-changed")).toBe(0)
		tuner.set(MAIN, tuned(1))
		decoders.add("c", { targets: [1] })
		expect(index.lookup("b")).toBeNull()
		expect(index.lookup("c")).toBeNull()
	})

	it("reuses one frozen binding per trust value (req 6.6)", () => {
		const { decoders, tuner, index } = setup()
		decoders.add("a", { targets: [131_000_000] })
		const commanded = index.lookup("a")
		expect(Object.isFrozen(commanded)).toBe(true)
		expect(index.lookup("a")).toBe(commanded)
		tuner.mode(MAIN, "external")
		const relay = index.lookup("a")
		expect(relay).not.toBe(commanded)
		tuner.mode(MAIN, "internal")
		expect(index.lookup("a")).toBe(commanded)
		tuner.mode(MAIN, "external")
		expect(index.lookup("a")).toBe(relay)
	})
})

type Trust = "unverified" | "commanded" | "relay"

function reference(
	state: ProvenanceTunerState | undefined,
	bindCentre: number | undefined,
	sameSource: boolean,
	targets: number[],
): Trust {
	if (!state) return "unverified"
	const unknown = state.unknownFields ?? []
	if (unknown.includes("frequency") || unknown.includes("sampleRate"))
		return "unverified"
	if (!Number.isFinite(state.frequency)) return "unverified"
	if (!(state.sampleRate > 0) || !Number.isFinite(state.sampleRate))
		return "unverified"
	if (targets.length === 0) return "unverified"
	if (!sameSource || bindCentre === undefined || bindCentre !== state.frequency)
		return "unverified"
	if (
		targets.some(t => Math.abs(t - state.frequency) > 0.45 * state.sampleRate)
	)
		return "unverified"
	return state.controlMode === "external" ? "relay" : "commanded"
}

describe("trust rule property", () => {
	// Feature: web-gaps-5, Property 10: Trust rule
	// Validates: Requirements 6.1, 6.2, 6.3, 6.5
	it("matches the reference rule over random states, centres and targets", () => {
		const centre = fc.constantFrom(100_000_000, 131_000_000)
		const rate = fc.constantFrom(
			0,
			-1,
			Number.NaN,
			Infinity,
			1_000_000,
			2_400_000,
		)
		const state = fc.record(
			{
				frequency: fc.oneof(centre, fc.constant(Number.NaN)),
				sampleRate: rate,
				controlMode: fc.constantFrom("internal" as const, "external" as const),
				unknownFields: fc.subarray([
					"frequency" as const,
					"sampleRate" as const,
					"gain" as const,
				]),
			},
			{ requiredKeys: ["frequency", "sampleRate", "controlMode"] },
		)
		const offset = fc.oneof(
			fc.integer({ min: -2_000_000, max: 2_000_000 }),
			fc.constantFrom(
				450_000,
				-450_000,
				450_001,
				1_080_000,
				1_080_001,
				-1_080_001,
			),
		)
		fc.assert(
			fc.property(
				fc.option(state, { nil: undefined }),
				fc.option(state, { nil: undefined }),
				fc.boolean(),
				fc.array(offset, { maxLength: 4 }),
				fc.boolean(),
				(atBind, now, sameSource, offsets, withTuner) => {
					const decoders = new FakeDecoders()
					const tuner = new FakeTuner()
					if (atBind) tuner.states.set(MAIN, atBind)
					const index = createDecoderProvenanceIndex(
						decoders,
						() => MAIN,
						withTuner ? tuner : undefined,
					)
					const base = atBind?.frequency ?? 131_000_000
					const targets = offsets.map(o => base + o)
					decoders.add("d", {
						targets,
						...(sameSource ? {} : { sourceId: "sdr-b" }),
					})
					if (now) tuner.set(MAIN, now)
					else tuner.emit("state-changed", MAIN, undefined)
					const binding = index.lookup("d")
					const usable = (s: ProvenanceTunerState | undefined) =>
						s !== undefined &&
						!(s.unknownFields ?? []).some(f => f !== "gain") &&
						Number.isFinite(s.frequency) &&
						Number.isFinite(s.sampleRate) &&
						s.sampleRate > 0
					const bindCentre = usable(atBind) ? atBind?.frequency : undefined
					const expected = withTuner
						? sameSource
							? reference(now, bindCentre, true, targets)
							: "unverified"
						: "unverified"
					index.dispose()
					return binding?.tuningTrust === expected
				},
			),
			{ numRuns: 300 },
		)
	})
})

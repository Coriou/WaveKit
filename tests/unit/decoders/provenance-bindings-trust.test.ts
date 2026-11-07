/**
 * WG5 req 6: verified tuning trust from the observed tuner state, over structural fakes.
 */

import { AisCatcherDecoder } from "../../../src/decoders/builtin/ais-catcher.js"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import { createActivityIngress } from "../../../src/core/activity/ingress.js"
import type {
	ActivityProvenanceLookup,
	DecodeEnvelope,
} from "../../../src/core/activity/types.js"
import { Rtl433Decoder } from "../../../src/decoders/builtin/rtl433.js"
import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import fc from "fast-check"
import {
	createDecoderProvenanceIndex,
	type ProvenanceDecoderSource,
	type ProvenanceTunerSource,
	type ProvenanceTunerState,
} from "../../../src/decoders/provenance-bindings.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"
import { placementKey } from "../../../src/decoders/enablement/contract.js"
import { createLogger } from "../../../src/utils/logger.js"

class ArgsRtl433Decoder extends Rtl433Decoder {
	args(): string[] {
		return this.getDecoderArgs()
	}
}

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
	removeSource(sourceId: string): void {
		this.states.delete(sourceId)
		this.emit("source-removed", sourceId)
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
): ProvenanceTunerState => ({
	frequency,
	sampleRate,
	controlMode,
	directSampling: "off",
})

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

	it("keeps a default AIS-catcher without configured targets unverified", () => {
		const { decoders, tuner, index } = setup()
		index.dispose()
		tuner.set(MAIN, tuned(162_000_000))
		decoders.add("ais", {})
		const decoder = new AisCatcherDecoder(
			{
				id: "ais",
				type: "ais-catcher",
				enabled: true,
				options: {},
			} as DecoderConfig,
			createLogger({ level: "error" }),
		)
		decoders.getStatus = () => ({ type: "ais-catcher", sourceId: MAIN })
		decoders.getDecoder = () => decoder
		const provenance = createDecoderProvenanceIndex(decoders, () => MAIN, tuner)
		try {
			expect(provenance.lookup("ais")).toMatchObject({
				targetFrequenciesHz: [],
				tuningTrust: "unverified",
			})
		} finally {
			provenance.dispose()
		}
	})

	it("is commanded under internal control and relay under external (req 6.2)", () => {
		const { decoders, tuner, index } = setup()
		decoders.add("a", { targets: [131_550_000] })
		expect(index.lookup("a")).toEqual({
			sourceId: MAIN,
			targetFrequenciesHz: [131_550_000],
			tuningTrust: "commanded",
			inputSampleRateHz: 2_400_000,
			captureCentreHz: 131_000_000,
		})
		tuner.mode(MAIN, "external")
		expect(index.lookup("a")?.tuningTrust).toBe("relay")
	})

	it("carries the centre a decoder started on only while the tuner is still there", () => {
		const { decoders, tuner, index } = setup(tuned(434_000_000))
		decoders.add("a", {})
		expect(index.lookup("a")?.captureCentreHz).toBe(434_000_000)
		// A retune with no restart: rtl_433's -f still holds the old centre.
		tuner.set(MAIN, tuned(434_300_000))
		expect(index.lookup("a")?.captureCentreHz).toBeUndefined()
		// The restart captures the new centre.
		decoders.emit("decoder:started", "a")
		expect(index.lookup("a")?.captureCentreHz).toBe(434_300_000)
		// A channel context hears a channel, not the capture.
		expect(
			index.lookup("a", { sourceId: MAIN, channelHz: 434_300_000 })
				?.captureCentreHz,
		).toBeUndefined()
		// An unusable snapshot (direct sampling) proves no centre.
		tuner.set(MAIN, { ...tuned(434_300_000), directSampling: "i" })
		expect(index.lookup("a")?.captureCentreHz).toBeUndefined()
	})

	it("reads a raw placement's centre from its own worker, the process that holds -f", () => {
		const { decoders, tuner, index } = setup(tuned(434_000_000))
		const raw = { sourceId: MAIN, channelHz: null }
		const worker = placementKey("a", MAIN, "raw", null)
		decoders.add("a", {})
		decoders.add(worker, { sourceId: MAIN })
		decoders.emit("decoder:started", worker)
		// The parent bound at another centre: only the worker's start counts.
		tuner.set(MAIN, tuned(868_000_000))
		decoders.emit("decoder:started", "a")
		tuner.set(MAIN, tuned(434_000_000))
		expect(index.lookup("a", raw)).toMatchObject({
			captureCentreHz: 434_000_000,
			inputSampleRateHz: 2_400_000,
		})
		// The capture moved and the worker has not restarted yet.
		tuner.set(MAIN, tuned(434_300_000))
		expect(index.lookup("a", raw)?.captureCentreHz).toBeUndefined()
		decoders.emit("decoder:started", worker)
		expect(index.lookup("a", raw)?.captureCentreHz).toBe(434_300_000)
		// With no worker bound there is no proof of a centre.
		expect(
			index.lookup("a", { sourceId: "other", channelHz: null })
				?.captureCentreHz,
		).toBeUndefined()
	})

	describe("rtl_433's frequency estimate", () => {
		const CENTRE = 434_000_000
		const RATE = 1_024_000
		const raw = { sourceId: MAIN, channelHz: null }
		const frequencyOf = (lookup: ActivityProvenanceLookup, id: string) => {
			const envelopes: DecodeEnvelope[] = []
			createActivityIngress({
				logger: createLogger({ level: "error" }),
				resolveProvenance: lookup,
				sink: envelope => {
					envelopes.push(envelope)
				},
			}).publish(id, "rtl433", {
				decoder: id,
				timestamp: new Date(),
				type: "signal",
				data: { freq: 434.05 },
				provenanceBinding: raw,
			})
			return envelopes[0]?.provenance.frequency?.hz ?? null
		}
		const placed = () => {
			const { decoders, tuner, index } = setup(tuned(CENTRE, "internal", RATE))
			return { decoders, tuner, index }
		}

		it("carries the centre for a primary raw placement, which runs as the decoder itself", () => {
			const { decoders, tuner, index } = placed()
			decoders.add("ism", { sourceId: MAIN })
			decoders.start("ism")
			expect(index.lookup("ism", raw)).toMatchObject({
				captureCentreHz: CENTRE,
				inputSampleRateHz: RATE,
			})
			expect(frequencyOf(index.lookup, "ism")).toBe(434_050_000)
			// Retuned with no restart: its -f still holds the old centre.
			tuner.set(MAIN, tuned(434_300_000, "internal", RATE))
			expect(index.lookup("ism", raw)?.captureCentreHz).toBeUndefined()
			decoders.start("ism")
			expect(index.lookup("ism", raw)?.captureCentreHz).toBe(434_300_000)
		})

		it("gives a secondary worker the same answer as the primary", () => {
			const { decoders, index } = placed()
			const worker = placementKey("ism", MAIN, "raw", null)
			decoders.add("ism", { sourceId: "other" })
			decoders.add(worker, { sourceId: MAIN })
			decoders.start(worker)
			expect(frequencyOf(index.lookup, "ism")).toBe(434_050_000)
		})

		it("refuses a primary bound on another source", () => {
			const { decoders, index } = placed()
			decoders.add("ism", { sourceId: "other" })
			expect(index.lookup("ism", raw)?.captureCentreHz).toBeUndefined()
			expect(frequencyOf(index.lookup, "ism")).toBeNull()
		})

		/** A real adapter, so its own -f rule and the index's are tested against each other. */
		const adapter = (extraArgs?: unknown) =>
			new ArgsRtl433Decoder(
				{
					id: "ism",
					type: "rtl433",
					enabled: true,
					options: {
						outputFormat: "json",
						inputCenterFreq: CENTRE,
						...(extraArgs === undefined ? {} : { extraArgs }),
					},
				},
				createLogger({ level: "error" }),
			)
		const realDecoders = (decoder: ArgsRtl433Decoder) => {
			const { decoders, tuner } = placed()
			decoders.getStatus = () => ({ type: "rtl433", sourceId: MAIN })
			decoders.getDecoder = () => decoder
			decoders.items.set("ism", {})
			const index = createDecoderProvenanceIndex(decoders, () => MAIN, tuner)
			return { decoders, index }
		}

		it.each([
			["no extra args", undefined, CENTRE],
			["an unrelated flag", ["-R", "1"], CENTRE],
			["a capital -F", ["-F", "json"], CENTRE],
			["-f as two entries", ["-f", "434100000"], undefined],
			["-f joined to its value", ["-f434100000"], undefined],
			["-f after other entries", ["-R", "1", "-f", "434100000"], undefined],
			["-f past the extraArgs cap", [...Array(64).fill("-q"), "-f"], CENTRE],
			["-f in a non-list value", "-f", CENTRE],
		])(
			"with %s, agrees with the adapter on whose -f it is",
			(_n, extra, hz) => {
				const decoder = adapter(extra)
				const { index } = realDecoders(decoder)
				expect(index.lookup("ism")?.captureCentreHz).toBe(hz)
				expect(index.lookup("ism", raw)?.captureCentreHz).toBe(hz)
				// The adapter adds its centre as -f exactly when the index keeps it.
				expect(decoder.args().includes(String(CENTRE))).toBe(hz !== undefined)
				expect(frequencyOf(index.lookup, "ism")).toBe(
					hz === undefined ? null : 434_050_000,
				)
				index.dispose()
			},
		)

		it("reads the options the adapter holds at its start", () => {
			const decoder = adapter()
			const { decoders, index } = realDecoders(decoder)
			expect(index.lookup("ism", raw)?.captureCentreHz).toBe(CENTRE)
			decoder.updateOptions({ extraArgs: ["-f", "434100000"] })
			decoders.start("ism")
			expect(index.lookup("ism", raw)?.captureCentreHz).toBeUndefined()
			decoder.updateOptions({ extraArgs: [] })
			decoders.start("ism")
			expect(index.lookup("ism", raw)?.captureCentreHz).toBe(CENTRE)
			index.dispose()
		})

		it("takes the override from the worker that runs the placement", () => {
			const { decoders, tuner } = placed()
			const worker = placementKey("ism", MAIN, "raw", null)
			const parent = adapter()
			const child = adapter(["-f", "434100000"])
			decoders.getStatus = () => ({ type: "rtl433", sourceId: MAIN })
			decoders.getDecoder = id => (id === worker ? child : parent)
			decoders.items.set("ism", {})
			const index = createDecoderProvenanceIndex(decoders, () => MAIN, tuner)
			decoders.start(worker)
			expect(index.lookup("ism", raw)?.captureCentreHz).toBeUndefined()
			index.dispose()
		})

		it("leaves another decoder type's -f alone", () => {
			const { decoders, tuner } = placed()
			decoders.getStatus = () => ({ type: "other", sourceId: MAIN })
			decoders.getDecoder = () => ({
				caps: { input: "iq" },
				config: { options: { extraArgs: ["-f", "1"] } },
			})
			decoders.items.set("x", {})
			const index = createDecoderProvenanceIndex(decoders, () => MAIN, tuner)
			expect(index.lookup("x")?.captureCentreHz).toBe(CENTRE)
			index.dispose()
		})
	})

	it("refuses another source's centre for a decoder following the default source", () => {
		const { decoders, tuner, index, setDefault } = setup(tuned(434_000_000))
		decoders.add("a", {})
		tuner.set("other", tuned(434_000_000))
		setDefault("other")
		expect(index.lookup("a")?.sourceId).toBe("other")
		expect(index.lookup("a")?.captureCentreHz).toBeUndefined()
	})

	it("resets the frozen binding when the centre changes with trust, rate and source the same", () => {
		const { decoders, tuner, index } = setup(tuned(434_000_000))
		decoders.add("a", {})
		const before = index.lookup("a")
		expect(index.lookup("a")).toBe(before)
		tuner.set(MAIN, tuned(434_300_000))
		const after = index.lookup("a")
		expect(after).not.toBe(before)
		expect(after?.tuningTrust).toBe(before?.tuningTrust)
		expect(after?.inputSampleRateHz).toBe(before?.inputSampleRateHz)
		expect(after?.captureCentreHz).toBeUndefined()
		expect(before?.captureCentreHz).toBe(434_000_000)
	})

	it("carries the observed input rate without a channel context, and follows a rate change", () => {
		const { decoders, tuner, index } = setup()
		decoders.add("a", { targets: [434_000_000] })
		expect(index.lookup("a")?.inputSampleRateHz).toBe(2_400_000)
		tuner.set(MAIN, tuned(131_000_000, "internal", 1_024_000))
		expect(index.lookup("a")?.inputSampleRateHz).toBe(1_024_000)
		// A channel context hears a channel, not the capture: rate unknown.
		expect(
			index.lookup("a", { sourceId: MAIN, channelHz: 434_000_000 })
				?.inputSampleRateHz,
		).toBeUndefined()
		// An unusable snapshot (direct sampling) gives no rate.
		tuner.set(MAIN, { ...tuned(131_000_000), directSampling: "q" } as never)
		expect(index.lookup("a")?.inputSampleRateHz).toBeUndefined()
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

	it("drops a removed source's snapshot; a re-added source restores it", () => {
		const { decoders, tuner, index } = setup()
		decoders.add("a", { targets: [131_550_000] })
		decoders.add("b", { sourceId: "other", targets: [131_550_000] })
		tuner.set("other", tuned(131_000_000))
		decoders.start("b")
		expect(index.lookup("a")?.tuningTrust).toBe("commanded")
		expect(index.lookup("b")?.tuningTrust).toBe("commanded")
		tuner.removeSource(MAIN)
		expect(index.lookup("a")?.tuningTrust).toBe("unverified")
		// Only the removed source's snapshot goes.
		expect(index.lookup("b")?.tuningTrust).toBe("commanded")
		const reads = tuner.reads
		// A start while the source is gone reads getState and stays unverified.
		decoders.start("a")
		expect(tuner.reads).toBe(reads + 1)
		expect(index.lookup("a")?.tuningTrust).toBe("unverified")
		// Re-added: the state event restores the snapshot, the next start re-reads it.
		tuner.set(MAIN, tuned(131_000_000))
		decoders.start("a")
		expect(tuner.reads).toBe(reads + 2)
		expect(index.lookup("a")?.tuningTrust).toBe("commanded")
		index.dispose()
		expect(tuner.listenerCount("source-removed")).toBe(0)
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

	it("invalidates the snapshot when reading a state event throws", () => {
		const { decoders, tuner, index } = setup()
		decoders.add("a", { targets: [131_000_000] })
		expect(index.lookup("a")?.tuningTrust).toBe("commanded")
		const hostile = {
			get frequency(): number {
				throw new Error("bad accessor")
			},
		}
		expect(() => tuner.emit("state-changed", MAIN, hostile)).not.toThrow()
		expect(index.lookup("a")?.tuningTrust).toBe("unverified")
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
	if ((state.declaredOnlyFields ?? []).length > 0) return "unverified"
	if (state.directSampling !== "off") return "unverified"
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
				directSampling: fc.constantFrom(
					"off" as const,
					"off" as const,
					"q" as const,
				),
				unknownFields: fc.subarray([
					"frequency" as const,
					"sampleRate" as const,
					"gain" as const,
				]),
				declaredOnlyFields: fc.subarray([
					"frequency" as const,
					"sampleRate" as const,
				]),
			},
			{
				requiredKeys: [
					"frequency",
					"sampleRate",
					"controlMode",
					"directSampling",
				],
			},
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
					// A bind captures any known centre, declared-only and direct sampling included.
					const bindable = (s: ProvenanceTunerState | undefined) =>
						s !== undefined &&
						!(s.unknownFields ?? []).includes("frequency") &&
						Number.isFinite(s.frequency)
					const bindCentre = bindable(atBind) ? atBind?.frequency : undefined
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

/** rtl_tcp opcodes (librtlsdr rtl_tcp.c). */
const RTL_TCP_COMMANDS = {
	SET_FREQUENCY: 0x01,
	SET_SAMPLE_RATE: 0x02,
	SET_DIRECT_SAMPLING: 0x09,
} as const

describe("trust from a real TunerController (WG5 R1)", () => {
	const AIS = "rtl-ais"
	const CENTRE = 162_000_000
	const RATE = 2_400_000
	const setupReal = (reconnectPolicy: "restore" | "reset" = "restore") => {
		let caps: SourceCaps = {
			kind: "iq",
			sampleRate: RATE,
			centerFreq: CENTRE,
			format: "U8_IQ",
			exclusive: false,
		}
		const sources = {
			assertTunerCommandActive: () => {},
			writeToSource: () => true,
			isRtlTcpSource: () => true,
			getCaps: () => ({ ...caps }),
			updateSourceCaps: (_id: string, update: Partial<SourceCaps>) => {
				caps = { ...caps, ...update }
				return caps
			},
			setTuningCaps: (
				_id: string,
				tuning: { sampleRate: number; centerFreq?: number },
			) => {
				caps = { ...caps, ...tuning }
				return caps
			},
		}
		const tuner = new TunerController(
			createLogger({ level: "fatal" }),
			sources as unknown as SourceManager,
			{ reconnectPolicy },
		)
		tuner.initializeSource(AIS, { ...caps }, "rtl_tcp")
		const decoders = new FakeDecoders()
		const index = createDecoderProvenanceIndex(decoders, () => AIS, tuner)
		decoders.add("ais", { targets: [161_975_000, 162_025_000] })
		const trust = () => index.lookup("ais")?.tuningTrust
		const command = async () => {
			await tuner.setSampleRate(AIS, RATE)
			await tuner.setFrequency(AIS, CENTRE)
		}
		return { tuner, decoders, trust, command }
	}

	it("a centre and rate only declared by config are unverified until WaveKit commands both", async () => {
		const { tuner, trust } = setupReal()
		expect(tuner.getState(AIS)?.declaredOnlyFields).toEqual([
			"frequency",
			"sampleRate",
		])
		expect(trust()).toBe("unverified")
		await tuner.setFrequency(AIS, CENTRE)
		expect(trust()).toBe("unverified")
		await tuner.setSampleRate(AIS, RATE)
		expect(tuner.getState(AIS)?.declaredOnlyFields).toBeUndefined()
		expect(trust()).toBe("commanded")
	})

	it("a reset reconnect is unverified until re-commanded", async () => {
		const { tuner, trust, command } = setupReal("reset")
		await command()
		expect(trust()).toBe("commanded")
		expect(tuner.synchronizeOnConnect(AIS).reset).toBe(true)
		expect(trust()).toBe("unverified")
		await command()
		expect(trust()).toBe("commanded")
	})

	it("accepted relay commands are relay", () => {
		const { tuner, trust } = setupReal()
		tuner.applyExternalCommand(AIS, RTL_TCP_COMMANDS.SET_SAMPLE_RATE, RATE)
		expect(trust()).toBe("unverified")
		tuner.applyExternalCommand(AIS, RTL_TCP_COMMANDS.SET_FREQUENCY, CENTRE)
		expect(trust()).toBe("relay")
	})

	it("direct sampling, then an ignored out-of-range frequency, is never relay", async () => {
		const { tuner, trust, command } = setupReal()
		await command()
		expect(trust()).toBe("commanded")
		tuner.applyExternalCommand(AIS, RTL_TCP_COMMANDS.SET_DIRECT_SAMPLING, 2)
		expect(trust()).toBe("unverified")
		tuner.applyExternalCommand(AIS, RTL_TCP_COMMANDS.SET_FREQUENCY, 14_200_000)
		expect(tuner.getState(AIS)?.unknownFields).toContain("frequency")
		expect(trust()).toBe("unverified")
		tuner.applyExternalCommand(AIS, RTL_TCP_COMMANDS.SET_DIRECT_SAMPLING, 0)
		// The receiver may still sit at 14.2 MHz: unknown until an accepted value.
		expect(trust()).toBe("unverified")
		tuner.applyExternalCommand(AIS, RTL_TCP_COMMANDS.SET_FREQUENCY, CENTRE)
		expect(tuner.getState(AIS)?.unknownFields ?? []).not.toContain("frequency")
		expect(trust()).toBe("relay")
	})

	it("relay direct sampling 3 (Q branch in librtlsdr) is unverified (WG5 R2)", async () => {
		const { tuner, trust, command } = setupReal()
		await command()
		tuner.applyExternalCommand(AIS, RTL_TCP_COMMANDS.SET_DIRECT_SAMPLING, 3)
		expect(trust()).toBe("unverified")
	})

	it("an ignored RTL-gap sample rate is unverified until an accepted rate", async () => {
		const { tuner, trust, command } = setupReal()
		await command()
		tuner.applyExternalCommand(AIS, RTL_TCP_COMMANDS.SET_SAMPLE_RATE, 500_000)
		expect(tuner.getState(AIS)?.sampleRate).toBe(RATE)
		expect(tuner.getState(AIS)?.unknownFields).toContain("sampleRate")
		expect(trust()).toBe("unverified")
		tuner.applyExternalCommand(AIS, RTL_TCP_COMMANDS.SET_SAMPLE_RATE, RATE)
		expect(trust()).toBe("relay")
	})
})

it.each(["internal", "external"] as const)(
	"placement context preserves payload carriers and %s tuning trust",
	controlMode => {
		const { decoders, tuner, index } = setup(tuned(162_000_000, controlMode))
		decoders.add("parent", { targets: [162_000_000] })
		const envelopes: DecodeEnvelope[] = []
		const ingress = createActivityIngress({
			logger: createLogger({ level: "error" }),
			resolveProvenance: index.lookup,
			sink: envelope => {
				envelopes.push(envelope)
			},
		})
		const publish = (
			type: "ship" | "message",
			data: unknown,
			channelHz: number | null,
		) => {
			ingress.publish("parent", "ais-catcher", {
				decoder: "parent",
				timestamp: new Date(),
				type,
				data,
				provenanceBinding: { sourceId: MAIN, channelHz },
			})
		}
		publish("ship", { channel: "A" }, 162_000_000)
		publish("ship", { channel: "B" }, 162_000_000)
		publish("message", {}, null)
		publish("message", {}, 162_025_000)
		expect(
			envelopes.map(envelope => envelope.provenance.frequency?.hz),
		).toEqual([161_975_000, 162_025_000, 162_000_000, 162_025_000])
		expect(
			envelopes.every(
				envelope =>
					envelope.provenance.frequency?.tuningTrust ===
					(controlMode === "internal" ? "commanded" : "relay"),
			),
		).toBe(true)
		tuner.set(MAIN, tuned(163_000_000, controlMode))
		publish("message", {}, 162_025_000)
		expect(envelopes.at(-1)?.provenance.frequency?.tuningTrust).toBe(
			"unverified",
		)
		index.dispose()
	},
)

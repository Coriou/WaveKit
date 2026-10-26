/**
 * WG5 req 6 composition: a real TunerController feeds the provenance index, whose lookup
 * the Activity ingress uses, so a stored reception carries the verified tuning trust.
 */

import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import { createActivityIngress } from "../../../src/core/activity/ingress.js"
import type { DecodeEnvelope } from "../../../src/core/activity/types.js"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import {
	createDecoderProvenanceIndex,
	type ProvenanceDecoderSource,
} from "../../../src/decoders/provenance-bindings.js"
import type { DecoderOutput } from "../../../src/decoders/types.js"
import { createLogger } from "../../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })
const SOURCE = "rtl-1"
const TARGET = 131_550_000

class OneDecoder extends EventEmitter implements ProvenanceDecoderSource {
	getAllDecoders() {
		return [{ id: "acars-1" }]
	}
	getStatus(id: string) {
		return id === "acars-1"
			? { sourceId: SOURCE, targetFrequenciesHz: [TARGET] }
			: undefined
	}
	getDecoder(id: string) {
		return id === "acars-1" ? { caps: { input: "iq" } } : undefined
	}
}

function setup() {
	const caps: SourceCaps = {
		kind: "iq",
		sampleRate: 2_048_000,
		centerFreq: 131_000_000,
		format: "U8_IQ",
		exclusive: false,
	}
	const sources = {
		assertTunerCommandActive: () => {},
		writeToSource: () => true,
		isRtlTcpSource: () => true,
		updateSourceCaps: () => caps,
		getCaps: () => ({ ...caps }),
		setTuningCaps: () => caps,
	}
	const tuner = new TunerController(logger, sources as unknown as SourceManager)
	tuner.initializeSource(SOURCE, { ...caps }, "rtl_tcp")
	const decoders = new OneDecoder()
	const index = createDecoderProvenanceIndex(decoders, () => SOURCE, tuner)
	const stored: DecodeEnvelope[] = []
	const ingress = createActivityIngress({
		sink: (_envelope, present) => {
			stored.push(present())
		},
		logger,
		resolveProvenance: index.lookup,
	})
	const receive = () => {
		const output: DecoderOutput = {
			timestamp: new Date(),
			decoder: "acars-1",
			type: "acars",
			data: { frequency: TARGET, text: "HELLO", tail: ".N123" },
		}
		ingress.publish("acars-1", "acarsdec", output)
		return stored.at(-1)?.provenance
	}
	return { tuner, decoders, index, receive }
}

describe("tuning trust through the tuner, index and ingress (WG5 req 6)", () => {
	it("stores commanded, then relay, then unverified after the source is removed", async () => {
		const { tuner, decoders, index, receive } = setup()
		// The config/caps baseline alone proves nothing (WG5 R1).
		expect(receive()?.frequency?.tuningTrust).toBe("unverified")
		await tuner.setSampleRate(SOURCE, 2_048_000)
		await tuner.setFrequency(SOURCE, 131_000_000)
		expect(receive()).toEqual({
			sourceId: SOURCE,
			frequency: { hz: TARGET, basis: "channel", tuningTrust: "commanded" },
		})
		tuner.setControlMode(SOURCE, "external")
		expect(receive()?.frequency?.tuningTrust).toBe("relay")
		tuner.setControlMode(SOURCE, "internal")
		expect(receive()?.frequency?.tuningTrust).toBe("commanded")

		tuner.removeSource(SOURCE)
		expect(receive()?.frequency?.tuningTrust).toBe("unverified")
		// Re-added at the same centre: its state event restores the snapshot.
		tuner.initializeSource(
			SOURCE,
			{
				kind: "iq",
				sampleRate: 2_048_000,
				centerFreq: 131_000_000,
				format: "U8_IQ",
				exclusive: false,
			},
			"rtl_tcp",
		)
		expect(receive()?.frequency?.tuningTrust).toBe("unverified")
		await tuner.setSampleRate(SOURCE, 2_048_000)
		await tuner.setFrequency(SOURCE, 131_000_000)
		expect(receive()?.frequency?.tuningTrust).toBe("commanded")
		decoders.emit("decoder:started", "acars-1")
		expect(receive()?.frequency?.tuningTrust).toBe("commanded")
		index.dispose()
		expect(tuner.listenerCount("source-removed")).toBe(0)
	})
})

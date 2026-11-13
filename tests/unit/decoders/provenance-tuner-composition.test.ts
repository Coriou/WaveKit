/**
 * WG5 req 6 composition: a real TunerController writes through a source manager that receipts
 * its frames into a tuning ledger (settle 0), the provenance index reads the ledger, and the
 * Activity ingress stores the reception with that trust.
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
import { FakeReceiverLedger } from "../../mocks/fake-receiver-ledger.js"

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
	let ledger = new FakeReceiverLedger(SOURCE, {
		rateHz: 2_048_000,
		settleMs: 0,
	})
	ledger.start()
	const sources = {
		assertTunerCommandActive: () => {},
		writeToSource: (
			_id: string,
			payload: Buffer,
			tag?: { writer: "operator" | "scanner" | "assert" | "relay" },
			onReceipt?: (r: unknown) => void,
		) => ledger.writePayload(payload, tag, onReceipt as never),
		isRtlTcpSource: () => true,
		updateSourceCaps: () => caps,
		getCaps: () => ({ ...caps }),
		setTuningCaps: () => caps,
	}
	const tuner = new TunerController(logger, sources as unknown as SourceManager)
	tuner.initializeSource(SOURCE, { ...caps }, "rtl_tcp")
	const decoders = new OneDecoder()
	const index = createDecoderProvenanceIndex(decoders, () => SOURCE, tuner, {
		trustNow: id => ledger.ledger.trustNow(id),
	})
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
	/** A source removed and added again: a new connection, nothing proven on it. */
	const newSession = () => {
		ledger = new FakeReceiverLedger(SOURCE, { rateHz: 2_048_000, settleMs: 0 })
		ledger.start()
	}
	return { tuner, decoders, index, receive, newSession }
}

describe("tuning trust through the tuner, index and ingress (WG5 req 6)", () => {
	it("stores commanded (control mode alone writes no frame), then unverified after the source is removed", async () => {
		const { tuner, decoders, index, receive, newSession } = setup()
		// The config/caps baseline alone proves nothing (WG5 R1).
		expect(receive()?.frequency?.tuningTrust).toBe("unverified")
		await tuner.setSampleRate(SOURCE, 2_048_000)
		await tuner.setFrequency(SOURCE, 131_000_000)
		expect(receive()).toEqual({
			sourceId: SOURCE,
			frequency: { hz: TARGET, basis: "channel", tuningTrust: "commanded" },
		})
		// External control writes no frame: the proof is still WaveKit's own (relay needs a relay
		// client's frame, provenance-relay-disconnect.test.ts).
		tuner.setControlMode(SOURCE, "external")
		expect(receive()?.frequency?.tuningTrust).toBe("commanded")
		tuner.setControlMode(SOURCE, "internal")
		expect(receive()?.frequency?.tuningTrust).toBe("commanded")

		tuner.removeSource(SOURCE)
		newSession()
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

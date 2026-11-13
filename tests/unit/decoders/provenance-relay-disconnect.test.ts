/**
 * WG7 req 10.8: a relay client connects, retunes and disconnects through the real tuner wiring.
 * Trust is the tuning ledger's: the source manager double receipts every frame (the core's own,
 * and the relay's, which the relay writes upstream before the controller sees it; settle 0).
 * A reception is `relay` once a relay client's frames prove the centre, `commanded` on WaveKit's
 * own, and `unverified` whenever the proven centre is not the one captured at decoder
 * create/start. Connecting or leaving writes no frame, so it changes no label by itself.
 */

import { EventEmitter } from "node:events"
import { describe, expect, it } from "vitest"
import type {
	SourceCaps,
	SourceManager,
} from "../../../src/core/source-manager.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import type { TunerRelay } from "../../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import {
	createDecoderProvenanceIndex,
	type ProvenanceDecoderSource,
} from "../../../src/decoders/provenance-bindings.js"
import { createLogger } from "../../../src/utils/logger.js"
import { FakeReceiverLedger } from "../../mocks/fake-receiver-ledger.js"

const logger = createLogger({ level: "fatal" })
const SOURCE = "rtl-1"
const CENTRE = 162_000_000
const OTHER = 131_000_000
const RATE = 2_400_000
const SET_FREQUENCY = 0x01

class Decoders extends EventEmitter implements ProvenanceDecoderSource {
	getAllDecoders() {
		return [{ id: "ais" }]
	}
	getStatus(id: string) {
		return id === "ais"
			? { sourceId: SOURCE, targetFrequenciesHz: [161_975_000, 162_025_000] }
			: undefined
	}
	getDecoder(id: string) {
		return id === "ais" ? { caps: { input: "iq" } } : undefined
	}
}

class FakeRelay extends EventEmitter {
	clients = 0
	constructor(private readonly ledger: FakeReceiverLedger) {
		super()
	}
	getStatus() {
		return {
			sourceId: SOURCE,
			controlPolicy: "shared",
			clientsConnected: this.clients,
			controlClientId: null,
		}
	}
	connect(): void {
		this.clients += 1
		this.emit("client-connected")
	}
	disconnect(): void {
		this.clients -= 1
		this.emit("client-disconnected")
	}
	retune(hz: number): void {
		// TunerRelay forwards the frame upstream (writer relay), then reports it.
		const frame = Buffer.alloc(5)
		frame[0] = SET_FREQUENCY
		frame.writeUInt32BE(hz, 1)
		this.ledger.writePayload(frame, { writer: "relay" })
		this.emit("command-received", {
			sourceId: SOURCE,
			command: SET_FREQUENCY,
			value: hz,
		})
	}
}

async function setup() {
	let caps: SourceCaps = {
		kind: "iq",
		sampleRate: RATE,
		centerFreq: CENTRE,
		format: "U8_IQ",
		exclusive: false,
	}
	const ledger = new FakeReceiverLedger(SOURCE, { rateHz: RATE, settleMs: 0 })
	ledger.start()
	const sourceManager = Object.assign(new EventEmitter(), {
		assertTunerCommandActive: () => {},
		writeToSource: (
			_id: string,
			payload: Buffer,
			tag?: { writer: "operator" | "scanner" | "assert" | "relay" },
			onReceipt?: (r: unknown) => void,
		) => ledger.writePayload(payload, tag, onReceipt as never),
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
	})
	const tuner = new TunerController(
		logger,
		sourceManager as unknown as SourceManager,
	)
	tuner.initializeSource(SOURCE, { ...caps }, "rtl_tcp")
	const relay = new FakeRelay(ledger)
	wireTunerControl({
		log: logger,
		sourceManager: sourceManager as unknown as SourceManager,
		tunerController: tuner,
		tunerRelay: relay as unknown as TunerRelay,
		relayEnabled: true,
	})
	const decoders = new Decoders()
	const index = createDecoderProvenanceIndex(
		decoders,
		() => SOURCE,
		tuner,
		ledger.ledger,
	)
	await tuner.setSampleRate(SOURCE, RATE)
	await tuner.setFrequency(SOURCE, CENTRE)
	const trust = () => index.lookup("ais")?.tuningTrust
	const mode = () => tuner.getState(SOURCE)?.controlMode
	return { tuner, relay, decoders, trust, mode }
}

describe("relay disconnect tuning trust (WG7 req 10.8)", () => {
	it("a relay retune away, then disconnect: internal and unverified, not commanded", async () => {
		const { relay, trust, mode } = await setup()
		expect(trust()).toBe("commanded")
		relay.connect()
		expect(mode()).toBe("external")
		// No relay frame yet: WaveKit's own frames still prove the centre.
		expect(trust()).toBe("commanded")
		relay.retune(OTHER)
		expect(trust()).toBe("unverified")
		relay.disconnect()
		expect(mode()).toBe("internal")
		expect(trust()).toBe("unverified")
	})

	it("a relay that leaves the centre as captured: relay before and after (its frames remain the proof)", async () => {
		const { relay, trust, mode } = await setup()
		relay.connect()
		relay.retune(CENTRE)
		expect(trust()).toBe("relay")
		relay.disconnect()
		expect(mode()).toBe("internal")
		// Leaving writes no frame: the relay's frames are still the proof.
		expect(trust()).toBe("relay")
	})

	it("a relay retune away and back: relay after disconnect (centre equals captured, the relay's frame proves it)", async () => {
		const { relay, trust } = await setup()
		relay.connect()
		relay.retune(OTHER)
		expect(trust()).toBe("unverified")
		relay.retune(CENTRE)
		expect(trust()).toBe("relay")
		relay.disconnect()
		expect(trust()).toBe("relay")
	})

	it("a decoder restarted on the relay centre keeps that capture after disconnect", async () => {
		const { relay, decoders, trust } = await setup()
		relay.connect()
		relay.retune(161_900_000)
		expect(trust()).toBe("unverified")
		decoders.emit("decoder:started", "ais")
		expect(trust()).toBe("relay")
		relay.disconnect()
		expect(trust()).toBe("relay")
	})

	it("one of two relay clients leaving keeps external control and relay", async () => {
		const { relay, trust, mode } = await setup()
		relay.connect()
		relay.connect()
		relay.retune(CENTRE)
		relay.disconnect()
		expect(mode()).toBe("external")
		expect(trust()).toBe("relay")
		relay.disconnect()
		expect(mode()).toBe("internal")
		expect(trust()).toBe("relay")
	})
})

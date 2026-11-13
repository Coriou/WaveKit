/**
 * The receiver gate governs what assert holds (tuning trust step 2, receiver switch): a centre or
 * rate accepted on one receiver is never asserted to another, nor to an unknown one. Production
 * wiring: the real SourceManager and its tuning ledger, TunerController, TunerRelay, TunerArbiter
 * and ReceiverIdentityTracker on wireTunerControl, against the stamped fake rtl_tcp on an
 * ephemeral loopback port whose header (tuner type) names the receiver. Every check reads the
 * frames the fake received, the ledger's receipts, and the stamps of the samples.
 */
import * as net from "node:net"
import pino from "pino"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { SourceConfig } from "../../../src/config.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import type { ReceiverIdentity } from "../../../src/core/receiver-identity.js"
import { ReceiverIdentityTracker } from "../../../src/core/receiver-identity-tracker.js"
import { TunerArbiter } from "../../../src/core/scanner/tuner-arbiter.js"
import { SourceManager } from "../../../src/core/source-manager.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import { TunerRelay } from "../../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../../src/core/tuner-wiring.js"
import type { TuningReceipt } from "../../../src/core/tuning-ledger.js"
import { createLogger } from "../../../src/utils/logger.js"
import { FakeClock } from "../../mocks/scanner/arbiter-fakes.js"
import { testSettings } from "../../mocks/scanner/engine-fakes.js"
import { startStampedRtlTcp } from "../../mocks/stamped-rtl-tcp.js"

const logger = createLogger({ level: "fatal" })
const cleanups: (() => unknown)[] = []

afterEach(async () => {
	vi.restoreAllMocks()
	for (const fn of cleanups.splice(0).reverse()) await fn()
})

/** 250 ksps U8 IQ: 500 kB/s, which the fake delivers (2500 B every 5 ms): rate truth agrees. */
const RATE = 250_000
const CHUNK = 2_500
/** The declared (config caps) centre, and the one the operator accepts on receiver A. */
const F0 = 100_000_000
const A_CENTRE = 145_000_000
const SET_FREQUENCY = 0x01
/** Header tuner types: receiver A, another model B, and a malformed one (unknown receiver). */
const TYPE_A = 5
const TYPE_B = 6
const TYPE_UNKNOWN = 1_000

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function until(check: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms
	while (!check()) {
		if (Date.now() > end) throw new Error("timed out")
		await wait(10)
	}
}

async function freePort(): Promise<number> {
	const server = net.createServer()
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const { port } = server.address() as net.AddressInfo
	await new Promise<void>(resolve => server.close(() => resolve()))
	return port
}

function config(port: number): SourceConfig {
	return {
		id: "rtl",
		type: "rtl_tcp",
		host: "127.0.0.1",
		port,
		loop: false,
		playbackSpeed: 1,
		caps: {
			kind: "iq",
			format: "U8_IQ",
			sampleRate: RATE,
			centerFreq: F0,
			exclusive: false,
		},
	} as SourceConfig
}

async function harness() {
	// The shortest reconnect backoff (equal jitter at its floor).
	vi.spyOn(Math, "random").mockReturnValue(0)
	const fake = await startStampedRtlTcp({
		initialHz: F0,
		initialRate: RATE,
		chunkBytes: CHUNK,
	})
	cleanups.push(() => fake.close())
	// 4 KiB settle (8 ms of payload): proof comes from positions, not from test time.
	const manager = new SourceManager(logger, {
		tuningSettleMs: () => 0,
		tuningInFlightBytes: 4096,
	})
	cleanups.push(() => manager.disconnectAll())
	manager.on("error", () => undefined)
	const tracker = new ReceiverIdentityTracker({
		sources: manager,
		logger,
		sdrHostApplies: () => false,
	})
	cleanups.push(() => tracker.stop())
	const controller = new TunerController(logger, manager, {
		receiverIdentity: id => tracker.provisional(id),
		receiverTracked: () => true,
	})
	controller.on("error", () => undefined)
	// As src/index.ts: the settled identity binds the receiver's learned state.
	tracker.on("identity", (id: string, identity: ReceiverIdentity) =>
		controller.noteReceiverBound(
			id,
			{
				key: identity.strength === "unknown" ? null : identity.key,
				adoptLegacy: false,
			},
			identity,
		),
	)
	const fanout = new FanoutManager(logger)
	cleanups.push(() => fanout.destroy())
	const relay = new TunerRelay(logger, manager, fanout, {
		enabled: true,
		host: "127.0.0.1",
		port: await freePort(),
		sourceId: "rtl",
		controlPolicy: "exclusive",
	})
	cleanups.push(() => relay.stop())
	await relay.start()
	controller.initializeSource("rtl", config(fake.port).caps, "rtl_tcp")
	wireTunerControl({
		log: logger,
		sourceManager: manager,
		tunerController: controller,
		tunerRelay: relay,
		relayEnabled: true,
	})
	const clock = new FakeClock()
	const arbiter = new TunerArbiter({
		tuner: controller,
		sources: manager,
		epochs: id => (id === "rtl" ? clock : undefined),
		settings: () => testSettings(),
		link: () => "network",
		persistLease: () => Promise.resolve(),
		impactSources: {
			liveDemod: null,
			digitalVoice: null,
			decoders: { getAllStatus: () => [] },
		},
		scannerJobsOn: () => [],
		canHandOver: () => true,
		logger: pino({ level: "silent" }),
	})
	cleanups.push(() => arbiter.dispose())
	const receipts: TuningReceipt[] = []
	manager.tuningLedger.subscribe((id, change) => {
		if (id === "rtl" && change.kind === "receipt") receipts.push(change.receipt)
	})
	const stream = await manager.connect(config(fake.port))
	stream.resume()
	fanout.attachSource(stream)
	const ledger = manager.tuningLedger
	const session = () => ledger.position("rtl")?.session ?? 0
	const sessionFlowing = async (n: number, bytes = 64 * 1024) => {
		await until(
			() => session() === n && (ledger.position("rtl")?.pos ?? 0) > bytes,
		)
	}
	const proofOf = () => controller.getState("rtl")!.proof!
	const frequencyReceipts = (n: number) =>
		receipts
			.filter(r => r.session === n && r.field === "frequency")
			.map(r => [r.value, r.writer])
	/** The receiver comes back as another unit (on its own default tuning). */
	const switchTo = async (tunerType: number, n: number) => {
		const from = fake.frames.length
		fake.restart({ keepTuning: false, tunerType })
		await sessionFlowing(n)
		await until(() => proofOf().frequency.state === "commanded")
		return fake.frames.slice(from)
	}
	return {
		fake,
		controller,
		ledger,
		sessionFlowing,
		proofOf,
		frequencyReceipts,
		switchTo,
	}
}

describe("assert under the receiver gate", () => {
	it(
		"A accepted a centre; B is asserted the declared centre only, also after a doubt; back on A the centre is asserted",
		{ timeout: 30_000 },
		async () => {
			const h = await harness()
			await h.sessionFlowing(1)
			await h.controller.setFrequency("rtl", A_CENTRE)
			await until(() => h.fake.tuning().centre === A_CENTRE)

			const onB = await h.switchTo(TYPE_B, 2)
			expect(onB).not.toContainEqual([SET_FREQUENCY, A_CENTRE])
			expect(h.frequencyReceipts(2)).toEqual([[F0, "assert"]])
			await until(() => h.fake.tuning().centre === F0)

			// A doubt on B: assert re-proves with what it holds for B, still not A's centre.
			const before = h.fake.frames.length
			h.ledger.raiseDoubt("rtl", "frequency", "test")
			await until(() => h.frequencyReceipts(2).length === 2)
			expect(h.fake.frames.slice(before)).toEqual([[SET_FREQUENCY, F0]])
			expect(h.frequencyReceipts(2)).toEqual([
				[F0, "assert"],
				[F0, "assert"],
			])

			const onA = await h.switchTo(TYPE_A, 3)
			expect(onA).toContainEqual([SET_FREQUENCY, A_CENTRE])
			expect(h.frequencyReceipts(3)).toEqual([[A_CENTRE, "assert"]])
			await until(() => h.fake.tuning().centre === A_CENTRE)
			expect(h.ledger.trustNow("rtl")).toMatchObject({
				trust: "commanded",
				frequency: A_CENTRE,
			})
		},
	)

	it(
		"an unknown receiver is asserted no accepted value",
		{ timeout: 30_000 },
		async () => {
			const h = await harness()
			await h.sessionFlowing(1)
			await h.controller.setFrequency("rtl", A_CENTRE)
			await until(() => h.fake.tuning().centre === A_CENTRE)

			const onUnknown = await h.switchTo(TYPE_UNKNOWN, 2)
			expect(onUnknown).not.toContainEqual([SET_FREQUENCY, A_CENTRE])
			expect(h.frequencyReceipts(2)).toEqual([[F0, "assert"]])
			await until(() => h.fake.tuning().centre === F0)
			expect(h.controller.getState("rtl")?.frequency).toBe(F0)
		},
	)
})

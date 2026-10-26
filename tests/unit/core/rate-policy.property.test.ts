import { it, expect } from "vitest"
import fc from "fast-check"
import { createServer, createConnection } from "node:net"
import type { AddressInfo } from "node:net"
import { once } from "node:events"
import { createRatePolicy } from "../../../src/core/rate-policy.js"
import { TunerController } from "../../../src/core/tuner-controller.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type {
	TunerRatePolicyEventData,
	DecoderMode,
	LinkAdvisory,
} from "@wavekit/api-types"
import { createLogger } from "../../../src/utils/logger.js"
import { WaveKitError } from "../../../src/utils/errors.js"

async function harness(enabled = true) {
	const received: Buffer[] = []
	const server = createServer(socket => {
		socket.on("data", data => received.push(data))
		socket.on("error", () => {})
	})
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	const socket = createConnection({
		host: "127.0.0.1",
		port: (server.address() as AddressInfo).port,
	})
	socket.on("error", () => {})
	await once(socket, "connect")
	const commands: Array<[number, number]> = []
	let fail = false
	const source = {
		assertTunerCommandActive() {},
		writeToSource(_id: string, frame: Buffer) {
			if (fail && frame[0] === 2)
				throw new WaveKitError("rate failed", "TEST_RATE_FAILED")
			commands.push([frame.readUInt8(0), frame.readUInt32BE(1)])
			return socket.write(frame)
		},
		updateSourceCaps() {},
		isRtlTcpSource() {
			return true
		},
	}
	const log = createLogger({ level: "fatal" })
	const tuner = new TunerController(log, source as unknown as SourceManager)
	tuner.on("error", () => {})
	tuner.initializeSource("s", {
		kind: "iq",
		sampleRate: 2_048_000,
		centerFreq: 162_000_000,
		format: "U8_IQ",
		exclusive: false,
	})
	let mode: DecoderMode = "auto"
	let ownDevice = false
	const events: TunerRatePolicyEventData[] = []
	const link: LinkAdvisory = {
		level: "unproven",
		transport: "network",
		payloadBytesPerSecond: 4_800_000,
		sustainedBytesPerSecond: null,
		shortfallPercent: null,
		upstreamDropBytesPerSecond: null,
	}
	const reports: LinkAdvisory[] = []
	const policy = createRatePolicy({
		port: { readsbOn: () => ({ mode, ownDevice }) },
		tuner: {
			sampleRateOf: id => tuner.getState(id)?.sampleRate ?? null,
			controlModeOf: id => tuner.getState(id)?.controlMode ?? null,
			setSampleRate: (id, hz, opts) => tuner.setSampleRate(id, hz, opts),
		},
		link: { observe() {}, reset() {}, classify: () => link },
		linkInput: sourceId => ({
			sourceId,
			host: "localhost",
			sampleRateHz: 2_048_000,
		}),
		upstreamDropsOf: () => null,
		reportLink: (_id, value) => {
			reports.push(value)
		},
		setTimer: () => ({ cancel() {} }),
		emit: event => {
			events.push(event)
		},
		now: () => new Date(0),
		log,
		enabled,
	})
	tuner.setBeforeOperatorRetune((...args) =>
		policy.beforeOperatorRetune(...args),
	)
	tuner.setOnOperatorSampleRate(id => policy.onOperatorSampleRate(id))
	tuner.setOnRelayRetune((id, hz) => policy.onRelayRetune(id, hz))
	tuner.setRatePolicyRecordFor(id => policy.recordFor(id))
	return {
		tuner,
		policy,
		commands,
		events,
		reports,
		link,
		setMode(value: DecoderMode) {
			mode = value
		},
		setOwn(value: boolean) {
			ownDevice = value
		},
		setFail() {
			fail = true
		},
		async close() {
			policy.dispose()
			socket.end()
			await once(socket, "close")
			await new Promise<void>((resolve, reject) =>
				server.close(err => (err ? reject(err) : resolve())),
			)
			const wire = Buffer.concat(received)
			expect(wire.length).toBe(commands.length * 5)
			for (let i = 0; i < commands.length; i++)
				expect([wire.readUInt8(i * 5), wire.readUInt32BE(i * 5 + 1)]).toEqual(
					commands[i],
				)
		},
	}
}

// Feature: decoder-enablement, Property 9: Raise and restore
// Validates: Requirements 6.1, 6.2, 6.3, 6.4, 10.1
it("mixed operator, scanner and relay sequences match the rate model", async () => {
	await fc.assert(
		fc.asyncProperty(
			fc.array(fc.integer({ min: 0, max: 10 }), { maxLength: 40 }),
			async steps => {
				const h = await harness()
				let rate = 2_048_000
				let previous: number | undefined
				let external = false
				let off = false
				let advised = false
				let rateWritten = false
				const expected: Array<[number, number]> = []
				const actions: Array<[string, string | undefined]> = []
				try {
					for (const step of steps) {
						if (step <= 1) {
							const hz = step === 0 ? 1_090_000_000 : 162_000_000
							if (external) {
								await expect(
									h.tuner.setFrequency("s", hz, { origin: "rest" }),
								).rejects.toThrow()
							} else {
								advised = false
								if (previous !== undefined && (step === 1 || off)) {
									rate = previous
									previous = undefined
									expected.push([2, rate])
									rateWritten = true
									actions.push(["restored", undefined])
								} else if (
									previous === undefined &&
									step === 0 &&
									!off &&
									rate < 2_400_000
								) {
									previous = rate
									rate = 2_400_000
									expected.push([2, rate])
									rateWritten = true
									actions.push(["raised", undefined])
								} else if (
									previous === undefined &&
									step === 0 &&
									!off &&
									rate > 2_400_000
								)
									actions.push(["skipped", "rate-above"])
								if (!rateWritten) {
									expected.push([2, rate])
									rateWritten = true
									previous = undefined
								}
								expected.push([1, hz])
								await h.tuner.setFrequency("s", hz, { origin: "rest" })
							}
						} else if (step === 2 || step === 3) {
							const hz = step === 2 ? 2_048_000 : 3_200_000
							if (!external) {
								rate = hz
								previous = undefined
								rateWritten = true
								expected.push([2, rate])
								await h.tuner.setSampleRate("s", rate, { origin: "rest" })
							}
						} else if (step === 4) {
							if (!external) {
								expected.push([1, 1_090_000_000])
								await h.tuner.setFrequency("s", 1_090_000_000, {
									origin: "scanner",
								})
							}
						} else if (step === 5 || step === 6) {
							external = true
							if (step === 6) advised = false
							else if (!advised && !off && rate !== 2_400_000) {
								advised = true
								actions.push([
									"skipped",
									rate > 2_400_000 ? "rate-above" : "external-control",
								])
							}
							h.tuner.applyExternalCommand(
								"s",
								1,
								step === 5 ? 1_090_000_000 : 162_000_000,
							)
						} else if (step === 7) {
							external = true
							rate = 2_048_000
							previous = undefined
							rateWritten = true
							h.tuner.applyExternalCommand("s", 2, rate)
						} else if (step === 8) {
							external = false
							advised = false
							h.tuner.setControlMode("s", "internal")
						} else {
							off = step === 9
							h.setMode(off ? "off" : "auto")
						}
						expect(h.commands).toEqual(expected)
						expect(h.events.map(e => [e.action, e.skipped])).toEqual(actions)
						expect(h.policy.recordFor("s")?.raisedFromHz).toBe(previous)
					}
				} finally {
					await h.close()
				}
			},
		),
		{ numRuns: 100 },
	)
})

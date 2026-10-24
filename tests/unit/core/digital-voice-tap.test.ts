/**
 * Digital voice taps for the auto listen route (docs/specs/auto-listen-route 3.2, 3.3, 4.10,
 * 7.2): frames reach a tap without a digital voice client, the service's own stream and
 * counters are byte-identical with a tap, clear then encrypted with audio queued routes nothing
 * more, and removal detaches. UDP is mocked; HTTP binds 127.0.0.1 port 0.
 */
import { EventEmitter } from "node:events"
import type * as http from "node:http"
import { Writable } from "node:stream"
import fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DigitalVoiceConfigSchema } from "../../../src/config.js"
import type {
	AutoRouteClock,
	VoiceCoveragePort,
	VoiceTap,
	VoiceTapCall,
} from "../../../src/core/auto-listen/contract.js"
import { AUTO_ROUTE_STREAM } from "../../../src/core/auto-listen/contract.js"
import { AutoListenRouter } from "../../../src/core/auto-listen/router.js"
import type { DigitalVoiceService as Service } from "../../../src/core/digital-voice.js"
import type { DecoderConfig } from "../../../src/decoders/types.js"
import type { Logger } from "../../../src/utils/logger.js"
import { createLogger } from "../../../src/utils/logger.js"
import { capturingLogger } from "./live-demodulator-continuity-fakes.js"

class FakeSocket extends EventEmitter {
	static created: FakeSocket[] = []
	static nextPort = 41_500
	port = FakeSocket.nextPort++
	closed = false
	constructor(readonly options: unknown) {
		super()
		FakeSocket.created.push(this)
	}
	bind(_port: number, _host: string, cb: () => void): void {
		setImmediate(cb)
	}
	address(): { port: number } {
		return { port: this.port }
	}
	close(): void {
		this.closed = true
	}
}

vi.mock("node:dgram", () => ({
	createSocket: (options: unknown) => new FakeSocket(options),
}))

const logger = createLogger({ level: "fatal" })

class Transport extends Writable {
	readonly chunks: Buffer[] = []
	override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
		this.chunks.push(Buffer.from(chunk))
		cb()
	}
	received(): Buffer {
		return Buffer.concat(this.chunks)
	}
}

class RouteClock implements AutoRouteClock {
	t = 0
	private fn: (() => void) | null = null
	now(): number {
		return this.t
	}
	setInterval(fn: () => void): unknown {
		this.fn = fn
		return 1
	}
	clearInterval(): void {
		this.fn = null
	}
	tick(ms: number): void {
		this.t += ms
		this.fn?.()
	}
}

function dsd(id: string): DecoderConfig {
	return { id, type: "dsd-fme", enabled: true, options: { mode: "auto" } }
}

/** 20 ms stereo datagram, both channels = value. */
function datagram(value: number): Buffer {
	const buf = Buffer.alloc(640)
	for (let i = 0; i < 160; i++) {
		buf.writeInt16LE(value, i * 4)
		buf.writeInt16LE(value, i * 4 + 2)
	}
	return buf
}

const state = (overrides: Record<string, unknown> = {}) => ({
	callId: "dsd-fme-abc-1",
	protocol: "DMR",
	talkgroup: 9,
	source: 2060945,
	slot: 1,
	encrypted: false,
	active: true,
	startedAt: "2026-10-09T12:00:00.000Z",
	...overrides,
})

interface Internals {
	http: { start(port: number, host?: string): Promise<void> }
	channels: Map<
		string,
		{
			registry: {
				register(res: unknown, addr: string, stream: unknown): unknown
			}
		}
	>
}

interface Recorded {
	frames: Array<{ id: string; pcm: Buffer; call: VoiceTapCall | null }>
	calls: Array<{ id: string; call: VoiceTapCall }>
	detaches: string[]
}

function recordingTap(): { tap: VoiceTap; rec: Recorded } {
	const rec: Recorded = { frames: [], calls: [], detaches: [] }
	return {
		rec,
		tap: {
			frame: (id, pcm, call) =>
				rec.frames.push({
					id,
					pcm: Buffer.from(pcm),
					call: call === null ? null : { ...call },
				}),
			call: (id, call) => rec.calls.push({ id, call: { ...call } }),
			detach: id => rec.detaches.push(id),
		},
	}
}

let DigitalVoiceService: new (
	...args: ConstructorParameters<typeof Service>
) => Service
const services: Service[] = []

beforeEach(async () => {
	FakeSocket.created = []
	DigitalVoiceService = (await import("../../../src/core/digital-voice.js"))
		.DigitalVoiceService
	vi.useFakeTimers({
		toFake: ["setInterval", "clearInterval", "Date", "performance"],
	})
})

afterEach(async () => {
	vi.useRealTimers()
	for (const service of services.splice(0)) await service.destroy()
})

/** A started service with one dsd-fme channel; HTTP rebound to 127.0.0.1 port 0. */
async function started(log: Logger = logger): Promise<{
	service: Service
	decoder: EventEmitter
	socket: FakeSocket
	connect(): Transport
}> {
	const config = DigitalVoiceConfigSchema.parse({
		httpPort: 41_235,
		jitterBufferMs: 100,
		maxBufferMs: 500,
	})
	const service = new DigitalVoiceService(log, config, {
		httpHost: "127.0.0.1",
	})
	services.push(service)
	const internals = service as unknown as Internals
	const start = internals.http.start.bind(internals.http)
	internals.http.start = () => start(0, "127.0.0.1")
	const first = FakeSocket.created.length
	await service.prepareDecoderConfigs([dsd("dsd-fme")])
	const decoder = new EventEmitter()
	service.attachDecoder("dsd-fme", decoder)
	await service.start()
	const socket = FakeSocket.created[first]
	if (socket === undefined) throw new Error("no socket")
	return {
		service,
		decoder,
		socket,
		connect() {
			const transport = new Transport()
			internals.channels
				.get("dsd-fme")
				?.registry.register(transport as unknown as http.ServerResponse, "t", {
					rate: 8000,
					format: "s16le",
				})
			return transport
		},
	}
}

type Step =
	| { kind: "datagram"; value: number; size: number }
	| { kind: "call"; encrypted: boolean; active: boolean; slot: number | null }
	| { kind: "advance"; ms: number }

const stepArb: fc.Arbitrary<Step> = fc.oneof(
	{
		weight: 6,
		arbitrary: fc.record({
			kind: fc.constant("datagram" as const),
			value: fc.integer({ min: -30_000, max: 30_000 }),
			size: fc.constantFrom(640, 320, 641, 0),
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant("call" as const),
			encrypted: fc.boolean(),
			active: fc.boolean(),
			slot: fc.constantFrom(1, 2, null),
		}),
	},
	{
		weight: 2,
		arbitrary: fc.record({
			kind: fc.constant("advance" as const),
			ms: fc.integer({ min: 1, max: 200 }),
		}),
	},
)

async function runScript(
	steps: readonly Step[],
	withTap: boolean,
	ownClient: boolean,
): Promise<{ own: Buffer; status: unknown; rec: Recorded }> {
	const { service, decoder, socket, connect } = await started()
	const { tap, rec } = recordingTap()
	if (withTap) service.addVoiceTap(tap)
	const own = ownClient ? connect() : null
	for (const step of steps) {
		if (step.kind === "datagram") {
			const buf = Buffer.alloc(step.size)
			datagram(step.value).copy(buf, 0, 0, Math.min(640, step.size))
			socket.emit("message", buf)
		} else if (step.kind === "call")
			decoder.emit(
				"voice-call",
				state({
					encrypted: step.encrypted,
					active: step.active,
					slot: step.slot,
				}),
			)
		else vi.advanceTimersByTime(step.ms)
	}
	const status = service.getStatus().decoders.map(d => ({
		...d,
		lastDatagramAt: null,
		// A fresh fake socket per run.
		udpPort: 0,
	}))
	const out = own?.received() ?? Buffer.alloc(0)
	await service.destroy()
	services.splice(services.indexOf(service), 1)
	return { own: out, status, rec }
}

describe("digital voice taps", () => {
	it("exposes the 8 kHz voice rate and delivers mono frames without a voice client", async () => {
		const { service, decoder, socket } = await started()
		expect(service.voiceSampleRate).toBe(8_000)
		const { tap, rec } = recordingTap()
		const remove = service.addVoiceTap(tap)
		decoder.emit("voice-call", state())
		socket.emit("message", datagram(700))
		expect(rec.calls).toHaveLength(1)
		expect(rec.calls[0]?.call).toMatchObject({
			callId: "dsd-fme-abc-1",
			active: true,
			encrypted: false,
			protocol: "DMR",
			slot: 1,
		})
		expect(rec.frames).toHaveLength(1)
		expect(rec.frames[0]?.pcm.length).toBe(320)
		expect(rec.frames[0]?.pcm.readInt16LE(0)).toBe(700)
		expect(rec.frames[0]?.call?.callId).toBe("dsd-fme-abc-1")
		// The service's own counters do not move for tap-only ingest.
		const own = service.getStatus().decoders[0]
		expect(own?.datagramsReceived).toBe(1)
		expect(own?.bufferedMs).toBe(0)
		expect(own?.encryptedDatagramsDropped).toBe(0)
		remove()
		socket.emit("message", datagram(700))
		expect(rec.frames).toHaveLength(1)
	})

	it("drops a wholly encrypted datagram before the taps", async () => {
		const { service, decoder, socket } = await started()
		const { tap, rec } = recordingTap()
		service.addVoiceTap(tap)
		decoder.emit("voice-call", state({ encrypted: true, slot: null }))
		socket.emit("message", datagram(700))
		expect(rec.frames).toHaveLength(0)
		expect(rec.calls.at(-1)?.call.encrypted).toBe(true)
	})

	it("survives a throwing tap and still feeds the others", async () => {
		const { service, socket } = await started()
		service.addVoiceTap({
			frame: () => {
				throw new Error("boom")
			},
			call: () => undefined,
			detach: () => undefined,
		})
		const { tap, rec } = recordingTap()
		service.addVoiceTap(tap)
		socket.emit("message", datagram(5))
		socket.emit("message", datagram(6))
		expect(rec.frames).toHaveLength(2)
	})

	it("logs a fixed message for any thrown value and keeps later taps and the own stream", async () => {
		const { logger: log, lines } = capturingLogger()
		const { service, socket, connect } = await started(log)
		const hostile = {
			get name(): string {
				throw new Error("getter")
			},
			get message(): string {
				throw new Error("getter")
			},
			toString(): string {
				throw new Error("getter")
			},
		}
		const thrown: unknown[] = [new Error("SECRET-TEXT"), hostile]
		let n = 0
		service.addVoiceTap({
			frame: () => {
				throw thrown[n++ % thrown.length]
			},
			call: () => {
				throw hostile
			},
			detach: () => undefined,
		})
		const { tap, rec } = recordingTap()
		service.addVoiceTap(tap)
		const own = connect()
		for (let i = 0; i < 20; i++) socket.emit("message", datagram(900))
		vi.advanceTimersByTime(400)
		expect(rec.frames).toHaveLength(20)
		expect(own.received().some(b => b !== 0)).toBe(true)
		expect(service.getStatus().decoders[0]?.datagramsReceived).toBe(20)
		const tapLines = lines.filter(l => l.msg === "Auto listen voice tap failed")
		expect(tapLines).toHaveLength(1)
		const text = JSON.stringify(lines)
		expect(text).not.toContain("SECRET-TEXT")
		expect(text).not.toContain("getter")
		expect(tapLines[0]).not.toHaveProperty("err")
	})

	it("detaches on channel removal and on stop", async () => {
		const first = await started()
		const a = recordingTap()
		first.service.addVoiceTap(a.tap)
		await first.service.removeChannel("dsd-fme")
		expect(a.rec.detaches).toEqual(["dsd-fme"])
		const second = await started()
		const b = recordingTap()
		second.service.addVoiceTap(b.tap)
		await second.service.stop()
		expect(b.rec.detaches).toContain("dsd-fme")
	})

	// Feature: auto-listen-route, Property 13: Existing streams unchanged
	// Validates: Requirements 7.1, 7.2
	it("own stream bytes and counters are byte-identical with a tap", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.array(stepArb, { minLength: 1, maxLength: 40 }),
				fc.boolean(),
				async (steps, ownClient) => {
					const plain = await runScript(steps, false, ownClient)
					const tapped = await runScript(steps, true, ownClient)
					expect(tapped.own.equals(plain.own)).toBe(true)
					expect(tapped.status).toEqual(plain.status)
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)
})

describe("digital voice into the router (4.10)", () => {
	function coverage(): VoiceCoveragePort {
		return { generation: 1, covers: () => "yes" }
	}

	async function routed() {
		const voice = await started()
		const clock = new RouteClock()
		const router = new AutoListenRouter(logger, { clock })
		router.attachVoice(voice.service, coverage())
		const auto = new Transport()
		router.registry.register(
			auto as unknown as http.ServerResponse,
			"auto",
			AUTO_ROUTE_STREAM,
		)
		return { ...voice, router, clock, auto }
	}

	it("routes clear voice without a digital voice client", async () => {
		const { decoder, socket, router, clock, auto } = await routed()
		decoder.emit("voice-call", state())
		for (let i = 0; i < 15; i++) socket.emit("message", datagram(4_000))
		for (let i = 0; i < 40; i++) clock.tick(20)
		const out = auto.received()
		let nonZero = 0
		for (let i = 0; i + 1 < out.length; i += 2)
			if (out.readInt16LE(i) !== 0) nonZero++
		expect(nonZero).toBeGreaterThan(0)
		expect(router.level()).toEqual({ active: "none" })
		router.destroy()
	})

	it("clear then encrypted with audio queued and no further datagram: nothing more is routed", async () => {
		const { decoder, socket, router, clock, auto } = await routed()
		const changes: string[] = []
		router.on("auto-route-changed", (level: { active: string }) =>
			changes.push(level.active),
		)
		decoder.emit("voice-call", state())
		// 100 ms of voice: under the 200 ms start buffer, so it is queued, not playing.
		for (let i = 0; i < 5; i++) socket.emit("message", datagram(4_000))
		decoder.emit("voice-call", state({ encrypted: true }))
		for (let i = 0; i < 50; i++) clock.tick(20)
		expect(auto.received().every(b => b === 0)).toBe(true)
		expect(auto.received().length).toBeGreaterThan(0)
		expect(changes).not.toContain("digital")
		expect(router.droppedSamples).toBeGreaterThan(0)
		router.destroy()
	})

	it("detach drops the decoder's queued voice", async () => {
		const { service, decoder, socket, router, clock, auto } = await routed()
		decoder.emit("voice-call", state())
		for (let i = 0; i < 5; i++) socket.emit("message", datagram(4_000))
		await service.removeChannel("dsd-fme")
		for (let i = 0; i < 50; i++) clock.tick(20)
		expect(auto.received().every(b => b === 0)).toBe(true)
		expect(router.status({ httpUrl: "", wavUrl: "" }).digitalAvailable).toBe(
			true,
		)
		router.destroy()
	})
})

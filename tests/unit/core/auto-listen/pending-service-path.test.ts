/**
 * What the auto-listen router really receives of a call's head: recorded dv-latency seed lines
 * through the production dsd-fme adapter, its `voice-call` events into the real
 * DigitalVoiceService, and decoded voice datagrams (stereo, dsd-fme copying the lone slot to
 * both channels) into its UDP socket, recorded at a voice tap. Voice before the call's first
 * snapshot reaches the tap with no call (the router keeps it as pending voice); while the call
 * is announced but its encryption is not known the tap gets nothing (unknown slot) or zeros
 * (known slot): /auto never has that span, and /stream's hold releases it instead. Once the
 * call is known clear the tap gets the voice with the call. pending-promotion.test.ts models
 * this gate when it drives the router. UDP is mocked; HTTP binds 127.0.0.1 port 0.
 */
import { EventEmitter } from "node:events"
import type * as http from "node:http"
import { Writable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DigitalVoiceConfigSchema } from "../../../../src/config.js"
import type { VoiceTapCall } from "../../../../src/core/auto-listen/contract.js"
import type { DigitalVoiceService as Service } from "../../../../src/core/digital-voice.js"
import { DsdFmeDecoder } from "../../../../src/decoders/builtin/dsd-fme.js"
import { createLogger } from "../../../../src/utils/logger.js"
import { ADAPTER_TIMER_MS, firstVoiceLine, loadSeed } from "./dv-seed-replay.js"

class FakeSocket extends EventEmitter {
	static created: FakeSocket[] = []
	static nextPort = 42_500
	port = FakeSocket.nextPort++
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
	close(): void {}
}

vi.mock("node:dgram", () => ({
	createSocket: (options: unknown) => new FakeSocket(options),
}))

const logger = createLogger({ level: "fatal" })
const T0 = Date.UTC(2026, 0, 2, 3, 4, 5)
const BURST_MS = 60

class Transport extends Writable {
	override _write(_chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
		cb()
	}
}

let DigitalVoiceService: new (
	...args: ConstructorParameters<typeof Service>
) => Service
const services: Service[] = []

beforeEach(async () => {
	FakeSocket.created = []
	DigitalVoiceService = (await import("../../../../src/core/digital-voice.js"))
		.DigitalVoiceService
	vi.useFakeTimers({
		toFake: ["setInterval", "clearInterval", "Date", "performance"],
	})
	vi.setSystemTime(T0)
})

afterEach(async () => {
	vi.useRealTimers()
	for (const service of services.splice(0)) await service.destroy()
})

interface TapFrame {
	atMs: number
	/** First sample (the datagram's value, 0 when muted). */
	value: number
	call: VoiceTapCall | null
}

/** One stereo 20 ms datagram, both channels `value` (a lone slot copied to both). */
function datagram(value: number): Buffer {
	const buf = Buffer.alloc(640)
	for (let i = 0; i < 160; i++) {
		buf.writeInt16LE(value, i * 4)
		buf.writeInt16LE(value, i * 4 + 2)
	}
	return buf
}

/**
 * Replays one recorded over (call timer at phase 0) through the adapter into the service, with
 * three datagrams per 60 ms burst from the first voice sync line to the over's end; returns the
 * tap's frames and call snapshots with their seed times.
 */
async function replayThroughService(
	scene: string,
	overIndex: number,
	ownClient: boolean,
): Promise<{
	frames: TapFrame[]
	calls: Array<{ atMs: number; call: VoiceTapCall }>
	voiceMs: number
}> {
	const seed = loadSeed(scene)
	const over = seed.overs[overIndex]
	if (over === undefined) throw new Error("no over")
	const line = firstVoiceLine(seed, over)
	if (line === undefined) throw new Error("no voice line")
	const config = DigitalVoiceConfigSchema.parse({
		httpPort: 41_236,
		jitterBufferMs: 100,
		maxBufferMs: 500,
	})
	const service = new DigitalVoiceService(logger, config, {
		httpHost: "127.0.0.1",
	})
	services.push(service)
	const internals = service as unknown as {
		http: { start(port: number, host?: string): Promise<void> }
		channels: Map<
			string,
			{ registry: { register(res: unknown, a: string, s: unknown): unknown } }
		>
	}
	const start = internals.http.start.bind(internals.http)
	internals.http.start = () => start(0, "127.0.0.1")
	const first = FakeSocket.created.length
	const decoderConfig = {
		id: "dsd-fme",
		type: "dsd-fme",
		enabled: true,
		options: { mode: "auto" },
	}
	await service.prepareDecoderConfigs([decoderConfig])
	const decoder = new DsdFmeDecoder(decoderConfig, logger)
	service.attachDecoder("dsd-fme", decoder)
	await service.start()
	const socket = FakeSocket.created[first]
	if (socket === undefined) throw new Error("no socket")
	if (ownClient)
		internals.channels
			.get("dsd-fme")
			?.registry.register(
				new Transport() as unknown as http.ServerResponse,
				"t",
				{
					rate: 8000,
					format: "s16le",
				},
			)
	const frames: TapFrame[] = []
	const calls: Array<{ atMs: number; call: VoiceTapCall }> = []
	const now = (): number => Date.now() - T0
	service.addVoiceTap({
		frame: (_id, pcm, call) =>
			frames.push({
				atMs: now(),
				value: pcm.readInt16LE(0),
				call: call === null ? null : { ...call },
			}),
		call: (_id, call) => calls.push({ atMs: now(), call: { ...call } }),
		detach: () => undefined,
	})
	const adapter = decoder as unknown as {
		handleOutputLine(line: string): void
		checkCallTimeoutAsync(): void
	}
	// Time-ordered steps: lines, timer ticks, datagrams (value = 1 + burst index, never 0).
	const steps: Array<{ at: number; order: number; run: () => void }> = []
	for (const l of seed.lines)
		steps.push({
			at: l.atMs,
			order: 0,
			run: () => adapter.handleOutputLine(l.text),
		})
	const lastLine = seed.lines.at(-1)?.atMs ?? 0
	for (let t = 0; t <= lastLine + 5_000; t += ADAPTER_TIMER_MS)
		steps.push({ at: t, order: 1, run: () => adapter.checkCallTimeoutAsync() })
	let n = 0
	for (let b = line.atMs; b <= over.endMs; b += BURST_MS) {
		const value = 1 + n++
		steps.push({
			at: b,
			order: 2,
			run: () => {
				for (let k = 0; k < 3; k++) socket.emit("message", datagram(value))
			},
		})
	}
	steps.sort((a, b) => a.at - b.at || a.order - b.order)
	for (const step of steps) {
		const to = T0 + step.at
		if (to > Date.now()) vi.setSystemTime(to)
		step.run()
	}
	// This over only: an earlier over's call has ended before its first voice line.
	return {
		frames,
		calls: calls.filter(c => c.atMs >= line.atMs),
		voiceMs: line.atMs,
	}
}

const known = (call: VoiceTapCall): boolean | undefined =>
	(call as VoiceTapCall & { encryptionKnown?: boolean }).encryptionKnown

describe("what the auto-listen tap gets of a call's head (recorded seeds, real adapter and service)", () => {
	for (const ownClient of [false, true]) {
		const mode = ownClient
			? "with a /stream listener (hold engaged)"
			: "tap only"
		it(`direct mode, announced with slot and encryption unknown: voice before the announce with no call, nothing until known clear, then voice with the call (${mode})`, async () => {
			const { frames, calls } = await replayThroughService(
				"dmr-direct-gaps-other",
				0,
				ownClient,
			)
			const announce = calls.find(c => c.call.active)
			const clear = calls.find(
				c => c.call.active && !c.call.encrypted && known(c.call) !== false,
			)
			expect(announce).toBeDefined()
			expect(clear).toBeDefined()
			const announceAt = announce?.atMs ?? 0
			const clearAt = clear?.atMs ?? 0
			// Announced unknown, on no slot yet, about 1 s before it is known clear.
			expect(known(announce?.call as VoiceTapCall)).toBe(false)
			expect(announce?.call.slot).toBeNull()
			expect(clearAt - announceAt).toBeGreaterThan(600)
			const before = frames.filter(f => f.atMs < announceAt)
			const between = frames.filter(
				f => f.atMs >= announceAt && f.atMs < clearAt,
			)
			const after = frames.filter(f => f.atMs >= clearAt)
			expect(before.length).toBeGreaterThan(0)
			expect(before.every(f => f.call === null && f.value !== 0)).toBe(true)
			expect(between).toHaveLength(0)
			expect(after.length).toBeGreaterThan(0)
			expect(after.every(f => f.call !== null && f.value !== 0)).toBe(true)
		})

		it(`direct mode, announced on slot 1 with encryption unknown: muted (zero) frames until known clear (${mode})`, async () => {
			const { frames, calls } = await replayThroughService(
				"dmr-direct-lengths",
				1,
				ownClient,
			)
			const announce = calls.find(c => c.call.active)
			const clear = calls.find(
				c => c.call.active && !c.call.encrypted && known(c.call) !== false,
			)
			const announceAt = announce?.atMs ?? 0
			const clearAt = clear?.atMs ?? 0
			expect(known(announce?.call as VoiceTapCall)).toBe(false)
			expect(announce?.call.slot).toBe(1)
			const between = frames.filter(
				f => f.atMs >= announceAt && f.atMs < clearAt,
			)
			expect(between.length).toBeGreaterThan(0)
			expect(between.every(f => f.value === 0)).toBe(true)
			expect(
				frames.filter(f => f.atMs < announceAt).every(f => f.call === null),
			).toBe(true)
			// This 1 s over ends (7 660.8 ms) before its call is known clear: the tap gets none of
			// its voice after the announce, /auto plays only the head before it.
			expect(frames.filter(f => f.atMs >= clearAt)).toHaveLength(0)
			expect(
				frames.filter(f => f.atMs < announceAt && f.value !== 0).length,
			).toBeGreaterThan(0)
		})
	}

	it("behind a repeater, announced known clear at once: the tap gets every frame, first with no call, then with it", async () => {
		const { frames, calls } = await replayThroughService(
			"dmr-repeater-gaps-same",
			0,
			false,
		)
		const announce = calls.find(c => c.call.active)
		expect(announce?.call.encrypted).toBe(false)
		expect(known(announce?.call as VoiceTapCall)).not.toBe(false)
		expect(frames.every(f => f.value !== 0)).toBe(true)
		const at = announce?.atMs ?? 0
		expect(frames.filter(f => f.atMs < at).every(f => f.call === null)).toBe(
			true,
		)
		expect(frames.filter(f => f.atMs >= at).every(f => f.call !== null)).toBe(
			true,
		)
	})
})

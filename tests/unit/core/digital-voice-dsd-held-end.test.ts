/**
 * A dsd-fme call_end held for its WAV lookup (DSD_FME_WAV_END_WAIT_MS) never delays the call
 * state the digital voice stream mutes and holds by: the real adapter publishes every
 * "voice-call" state at production, and only its DecoderOutputs wait in the outbox. Driven with
 * the real DsdFmeDecoder attached to the real DigitalVoiceService (UDP mocked, HTTP on
 * 127.0.0.1 port 0): voice of a call B starting while a clear call A's end is held is muted on
 * the taps and held on /stream exactly as when nothing is held (no recording lookup). Ids and
 * paths are synthetic.
 */
import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import type * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { Writable } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DigitalVoiceConfigSchema } from "../../../src/config.js"
import type {
	VoiceTap,
	VoiceTapCall,
} from "../../../src/core/auto-listen/contract.js"
import type { DigitalVoiceService as Service } from "../../../src/core/digital-voice.js"
import {
	DSD_FME_WAV_END_WAIT_MS,
	type DsdFmeDecoder,
} from "../../../src/decoders/builtin/dsd-fme.js"
import type {
	DecoderConfig,
	DecoderOutput,
} from "../../../src/decoders/types.js"
import { createLogger } from "../../../src/utils/logger.js"
import { createDecoder } from "../decoders/dsd-fme-call-first-helpers.js"

class FakeSocket extends EventEmitter {
	static created: FakeSocket[] = []
	static nextPort = 41_700
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

class Transport extends Writable {
	readonly chunks: Buffer[] = []
	override _write(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
		this.chunks.push(Buffer.from(chunk))
		cb()
	}
}

interface ServiceInternals {
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

interface AdapterInternals {
	callState: unknown
	endCall(now: Date, timeout: boolean): DecoderOutput | null
	emitOutput(o: DecoderOutput): void
	outbox: unknown[]
}

const START = new Date(2026, 0, 9, 10, 53, 27)
const dsd = (): DecoderConfig => ({
	id: "dsd-fme",
	type: "dsd-fme",
	enabled: true,
	options: { mode: "auto" },
})

/** 20 ms stereo datagram: slot 1 (left) and slot 2 (right). */
function datagram(left: number, right: number): Buffer {
	const buf = Buffer.alloc(640)
	for (let i = 0; i < 160; i++) {
		buf.writeInt16LE(left, i * 4)
		buf.writeInt16LE(right, i * 4 + 2)
	}
	return buf
}

let DigitalVoiceService: new (
	...args: ConstructorParameters<typeof Service>
) => Service
const services: Service[] = []
let root = ""

beforeEach(async () => {
	FakeSocket.created = []
	DigitalVoiceService = (await import("../../../src/core/digital-voice.js"))
		.DigitalVoiceService
	root = fs.mkdtempSync(path.join(os.tmpdir(), "wk-dv-held-end-"))
	vi.useFakeTimers({
		toFake: [
			"setInterval",
			"clearInterval",
			"setTimeout",
			"clearTimeout",
			"Date",
			"performance",
		],
	})
	vi.setSystemTime(START)
	// A stuck directory read: the lookup's first attempt never answers, so a held end waits
	// its whole DSD_FME_WAV_END_WAIT_MS.
	vi.spyOn(fs.promises, "opendir").mockImplementation(
		() => new Promise<fs.Dir>(() => undefined),
	)
})

afterEach(async () => {
	vi.useRealTimers()
	vi.restoreAllMocks()
	for (const service of services.splice(0)) await service.destroy()
	fs.rmSync(root, { recursive: true, force: true })
})

interface Run {
	/** A's call_end and B's call_start were still in the outbox while B's voice arrived. */
	heldWhileVoice: boolean
	frames: { pcm: Buffer; call: VoiceTapCall | null }[]
	calls: VoiceTapCall[]
	/** /stream hold counters after B's voice. */
	voiceHold: unknown
	/** The call the service obeys while B's voice arrives. */
	callDuringVoice: unknown
	outputs: string[]
}

/**
 * A clear D-STAR call A ends (its end held for a WAV lookup when `held`), call B starts, then
 * B's voice arrives on slot 1 (left channel); later A's hold runs out.
 */
async function run(
	held: boolean,
	b: { protocol: string; slot: number | null },
): Promise<Run> {
	const config = DigitalVoiceConfigSchema.parse({
		httpPort: 41_236,
		jitterBufferMs: 100,
		maxBufferMs: 500,
	})
	const service = new DigitalVoiceService(logger, config, {
		httpHost: "127.0.0.1",
	})
	services.push(service)
	const si = service as unknown as ServiceInternals
	const start = si.http.start.bind(si.http)
	si.http.start = () => start(0, "127.0.0.1")
	const first = FakeSocket.created.length
	await service.prepareDecoderConfigs([dsd()])
	const decoder: DsdFmeDecoder = createDecoder(
		held
			? {
					enablePerCallRecording: true,
					perCallRecordingDir: root,
					perCallRecordingPrune: false,
				}
			: {},
	)
	service.attachDecoder("dsd-fme", decoder)
	await service.start()
	const socket = FakeSocket.created[first]
	if (socket === undefined) throw new Error("no socket")
	const frames: Run["frames"] = []
	const calls: VoiceTapCall[] = []
	const tap: VoiceTap = {
		frame: (_id, pcm, call) =>
			frames.push({
				pcm: Buffer.from(pcm),
				call: call === null ? null : { ...call },
			}),
		call: (_id, call) => calls.push({ ...call }),
		detach: () => undefined,
	}
	service.addVoiceTap(tap)
	// A /stream listener, so the hold engages.
	si.channels
		.get("dsd-fme")
		?.registry.register(
			new Transport() as unknown as http.ServerResponse,
			"t",
			{
				rate: 8000,
				format: "s16le",
			},
		)
	const outputs: string[] = []
	decoder.on("output", (o: DecoderOutput) => {
		const data = o.data as { callId?: string }
		outputs.push(`${o.type}:${data.callId ?? "?"}`)
	})

	const adapter = decoder as unknown as AdapterInternals
	const callA = {
		callId: "call-a",
		protocol: "dstar",
		talkgroup: 41,
		source: 7,
		slot: null,
		startTime: START,
		startWallMs: START.getTime(),
		lastUpdate: START,
		quality: { crcErrs: 0, fecErrs: 0 },
		flags: {},
		announced: true,
	}
	adapter.emitOutput({
		timestamp: START,
		decoder: "dsd-fme",
		type: "call_start",
		data: {
			callId: "call-a",
			protocol: "dstar",
			talkgroup: 41,
			source: 7,
			slot: null,
			encrypted: false,
			startedAt: START.toISOString(),
		},
	})
	// A's clear voice plays.
	for (let i = 0; i < 3; i++) socket.emit("message", datagram(1000, 1000))
	await vi.advanceTimersByTimeAsync(60)
	adapter.callState = callA
	const ended = adapter.endCall(new Date(START.getTime() + 60), false)
	if (ended === null) throw new Error("no end")
	adapter.emitOutput(ended)
	// B starts within A's hold, its encryption not known yet.
	adapter.emitOutput({
		timestamp: new Date(START.getTime() + 80),
		decoder: "dsd-fme",
		type: "call_start",
		data: {
			callId: "call-b",
			protocol: b.protocol,
			talkgroup: 42,
			source: 8,
			slot: b.slot,
			encrypted: false,
			...(b.protocol === "dmr" ? {} : { encryptionKnown: false }),
			startedAt: new Date(START.getTime() + 80).toISOString(),
		},
	})
	const before = frames.length
	for (let i = 0; i < 5; i++) socket.emit("message", datagram(1000, 0))
	await vi.advanceTimersByTimeAsync(100)
	const heldWhileVoice = adapter.outbox.length > 0
	const status = service.getStatus().decoders[0]
	const result = {
		heldWhileVoice,
		frames: frames.slice(before),
		calls,
		voiceHold: { ...status?.voiceHold, bufferedMs: undefined },
		callDuringVoice: status?.call,
		outputs,
	}
	// A's hold runs out: its end and B's start go out, with no second voice-call state.
	await vi.advanceTimersByTimeAsync(DSD_FME_WAV_END_WAIT_MS)
	expect(adapter.outbox).toHaveLength(0)
	return result
}

const silent = (pcm: Buffer): boolean => pcm.every(b => b === 0)

describe("digital voice with a dsd-fme call_end held for its WAV lookup", () => {
	it("mutes and holds a non-DMR call B started within A's hold, as with nothing held", async () => {
		const b = { protocol: "p25p1", slot: null }
		const heldRun = await run(true, b)
		const plain = await run(false, b)
		expect(heldRun.heldWhileVoice).toBe(true)
		expect(plain.heldWhileVoice).toBe(false)
		// The service obeys B (not known clear), not A, while A's end is still held.
		expect(heldRun.callDuringVoice).toMatchObject({
			callId: "call-b",
			active: true,
			encryptionKnown: false,
		})
		// Whole-datagram restriction: the taps get no frame of B's voice at all, and /stream holds it.
		expect(heldRun.frames.filter(f => !silent(f.pcm))).toEqual([])
		expect(heldRun.voiceHold).toMatchObject({ heldMs: expect.any(Number) })
		expect((heldRun.voiceHold as { heldMs: number }).heldMs).toBeGreaterThan(0)
		// Exactly as when nothing is held.
		expect(heldRun.frames).toEqual(plain.frames)
		expect(heldRun.voiceHold).toEqual(plain.voiceHold)
		expect(heldRun.calls).toEqual(plain.calls)
		expect(heldRun.calls.map(c => `${c.callId}:${c.active}`)).toEqual([
			"call-a:true",
			"call-a:false",
			"call-b:true",
		])
		// The outputs keep production order either way.
		expect(heldRun.outputs).toEqual(plain.outputs)
	})

	it("a DMR call_start behind a held non-DMR end keeps its hold (its slot muted on the taps)", async () => {
		const b = { protocol: "dmr", slot: 1 }
		const heldRun = await run(true, b)
		const plain = await run(false, b)
		expect(heldRun.heldWhileVoice).toBe(true)
		expect(heldRun.callDuringVoice).toMatchObject({
			callId: "call-b",
			protocol: "dmr",
			slot: 1,
			encryptionKnown: false,
		})
		// Slot 1 carries B's voice: muted on the taps (frames delivered, silent).
		expect(heldRun.frames.length).toBeGreaterThan(0)
		expect(heldRun.frames.every(f => silent(f.pcm))).toBe(true)
		expect((heldRun.voiceHold as { heldMs: number }).heldMs).toBeGreaterThan(0)
		expect(heldRun.frames).toEqual(plain.frames)
		expect(heldRun.voiceHold).toEqual(plain.voiceHold)
		expect(heldRun.calls).toEqual(plain.calls)
	})
})

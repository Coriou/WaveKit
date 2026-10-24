/**
 * Auto listen route wiring in the live demodulator (docs/specs/auto-listen-route, task 3):
 * `/auto` and `/auto.wav` on the live-audio server with the same access path as `/stream`,
 * clients kept across a restart and a rate change, sample-aligned analog spans (Property 8) and
 * `/stream` bytes unchanged by `/auto` (Property 13). Fake CSDR stages, an injected router
 * clock, HTTP on 127.0.0.1 port 0 only.
 */
import { createHash } from "node:crypto"
import * as http from "node:http"
import fc from "fast-check"
import { afterEach, describe, expect, it } from "vitest"
import { ConnectionLeases } from "../../../src/access/connection-leases.js"
import {
	digestMachineToken,
	generateMachineToken,
	sessionCredentialBinding,
} from "../../../src/access/credentials.js"
import type { NodeHttpAccessOptions } from "../../../src/access/node-http-adapter.js"
import { AccessPolicy } from "../../../src/access/policy.js"
import { SessionStore } from "../../../src/access/sessions.js"
import { AUTO_ROUTE_STREAM } from "../../../src/core/auto-listen/contract.js"
import type { AutoRouteClock } from "../../../src/core/auto-listen/contract.js"
import { PolyphaseResampler } from "../../../src/core/auto-listen/resampler.js"
import type { AutoListenRouter } from "../../../src/core/auto-listen/router.js"
import type {
	AudioClient,
	StreamFormat,
} from "../../../src/core/audio-stream-server.js"
import type { EvidenceSquelchFactory } from "../../../src/core/evidence-squelch/contract.js"
import { PreRoll } from "../../../src/core/evidence-squelch/pre-roll.js"
import type { LiveDemodulator } from "../../../src/core/live-demodulator.js"
import { LiveDemodConfigSchema } from "../../../src/config.js"
import { createLogger } from "../../../src/utils/logger.js"
import {
	ClientTransport,
	createFakeFanout,
	createFakeSourceManager,
	FakeProcess,
	ManualClock,
} from "./live-demodulator-continuity-fakes.js"
import { FakeGate } from "./live-demodulator-evidence-fakes.js"
import { feed } from "./auto-listen/helpers.js"

const logger = createLogger({ level: "fatal" })
const AUTHORITY = "receiver.local:8081"
const ORIGIN = "http://receiver.local:8080"

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

interface Span {
	bytes: Buffer
	audible: boolean
	stream: StreamFormat
}

interface FakeToneGate {
	push(chunk: Buffer, format: string, start: number, end: number): void
	open(): boolean
	skip(): void
	reset(): void
}

interface Internals {
	http: {
		start(port: number, host?: string): Promise<void>
		server: http.Server | null
	}
	autoRoute: AutoListenRouter
	audio: {
		closeAll(reason: string, destroy: boolean): void
		clearRemainder(): void
	}
	options: { evidenceSquelch?: EvidenceSquelchFactory }
	run: {
		squelch: object
		stream: StreamFormat
		tone: { gate: FakeToneGate | null; key: string } | null
		pcmPhase: number
		pcmTailMuted: boolean
		evidenceModulation?: string | undefined
	} | null
	handleAudioData(chunk: Buffer): void
	registerClient(response: unknown, remoteAddress: string): AudioClient
}

interface HarnessOptions {
	config?: Record<string, unknown>
	httpAccess?: NodeHttpAccessOptions
	factory?: EvidenceSquelchFactory
}

const disposers: Array<() => Promise<void>> = []
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose()
})

/**
 * A started demodulator on fake stages. The live-audio listener is rebound to 127.0.0.1 port 0
 * (the configured port is never bound); stage 1 is scripted through `stage.open`.
 */
async function harness(options: HarnessOptions = {}) {
	const { LiveDemodulator: Demod } =
		await import("../../../src/core/live-demodulator.js")
	const processes: FakeProcess[] = []
	const realKill = process.kill.bind(process)
	process.kill = ((pid: number, signal?: string | number): true => {
		const proc = processes.find(p => p.pid === Math.abs(pid))
		if (!proc) {
			const err = new Error("ESRCH") as NodeJS.ErrnoException
			err.code = "ESRCH"
			throw err
		}
		proc.receive((signal ?? "SIGTERM") as NodeJS.Signals)
		return true
	}) as typeof process.kill
	const routeClock = new RouteClock()
	const config = LiveDemodConfigSchema.parse({
		enabled: true,
		sourceId: "rtl-pi",
		// Never bound: the listener below is rebound to port 0.
		httpPort: 41_234,
		...options.config,
	})
	const demod: LiveDemodulator = new Demod(
		logger,
		createFakeSourceManager() as never,
		createFakeFanout() as never,
		config,
		{
			httpHost: "127.0.0.1",
			clock: new ManualClock(),
			restartBaseDelayMs: 1,
			autoRouteClock: routeClock,
			...(options.httpAccess !== undefined
				? { httpAccess: options.httpAccess }
				: {}),
			...(options.factory !== undefined
				? { evidenceSquelch: options.factory }
				: {}),
			spawnStage: (command: string) => {
				const proc = new FakeProcess(command)
				processes.push(proc)
				return proc as never
			},
		},
	)
	const internals = demod as unknown as Internals
	const start = internals.http.start.bind(internals.http)
	internals.http.start = () => start(0, "127.0.0.1")
	disposers.push(async () => {
		try {
			await demod.stop()
		} catch {
			// cleanup only
		}
		process.kill = realKill
	})
	await demod.start()
	const stage = { open: false }
	const script = () => {
		const run = internals.run
		if (run === null) throw new Error("no run")
		Object.defineProperty(run.squelch, "open", {
			configurable: true,
			get: () => stage.open,
		})
	}
	script()
	const spans: Span[] = []
	const router = internals.autoRoute
	const push = router.pushAnalog.bind(router)
	router.pushAnalog = (chunk, start, end, audible, stream) => {
		if (router.wanted)
			spans.push({
				bytes: Buffer.from(chunk.subarray(start, end)),
				audible,
				stream,
			})
		push(chunk, start, end, audible, stream)
	}
	return {
		demod,
		internals,
		router,
		routeClock,
		stage,
		script,
		spans,
		port(): number {
			const address = internals.http.server?.address()
			if (!address || typeof address === "string") throw new Error("no port")
			return address.port
		},
		addStreamClient() {
			const transport = new ClientTransport()
			internals.registerClient(transport, "stream")
			return transport
		},
		addAutoClient() {
			const transport = new ClientTransport()
			const client = router.registry.register(
				transport as never,
				"auto",
				AUTO_ROUTE_STREAM,
			)
			return { transport, client }
		},
		feed(chunk: Buffer) {
			internals.handleAudioData(chunk)
		},
		/** Fresh clients, framing and evidence path (rebuilt from the factory) for the next run. */
		reset() {
			internals.audio.closeAll("test", true)
			internals.audio.clearRemainder()
			router.registry.closeAll("test", true)
			const run = internals.run
			if (run === null) throw new Error("no run")
			run.pcmPhase = 0
			run.pcmTailMuted = false
			run.evidenceModulation = undefined
			spans.length = 0
		},
	}
}

interface Reply {
	status: number
	headers: http.IncomingHttpHeaders
	body: Buffer
}

/** One request; streaming responses are read until the first data (or end) and closed. */
function request(
	port: number,
	path: string,
	headers: Record<string, string> = {},
	method = "GET",
): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				host: "127.0.0.1",
				port,
				path,
				method,
				headers: { Host: AUTHORITY, Connection: "close", ...headers },
			},
			response => {
				const chunks: Buffer[] = []
				let done = false
				const finish = () => {
					if (done) return
					done = true
					resolve({
						status: response.statusCode ?? 0,
						headers: response.headers,
						body: Buffer.concat(chunks),
					})
					response.destroy()
				}
				response.on("data", (chunk: Buffer) => {
					chunks.push(chunk)
					if (response.headers["x-audio-format"] !== undefined) finish()
				})
				response.on("end", finish)
				response.on("close", finish)
				response.on("error", finish)
				// Streams without data yet: headers are enough.
				if (response.headers["x-audio-format"] !== undefined)
					setImmediate(finish)
			},
		)
		req.on("error", reject)
		req.end()
	})
}

function accessHeaders(
	headers: http.IncomingHttpHeaders,
): Record<string, unknown> {
	const out: Record<string, unknown> = {}
	for (const [key, value] of Object.entries(headers))
		if (key.startsWith("access-control-") || key === "cache-control")
			out[key] = value
	return out
}

async function protectedAccess() {
	const token = generateMachineToken()
	const digest = digestMachineToken(token)
	const sessions = await SessionStore.open({
		credentialBinding: sessionCredentialBinding(digest),
		persist: () => Promise.resolve(),
	})
	const session = await sessions.create()
	if (session.kind !== "created") throw new Error("no session")
	const policy = new AccessPolicy({
		listenerScheme: "http",
		allowedAuthorities: [AUTHORITY],
		allowedOrigins: [ORIGIN],
		sessionCookieName: "wavekit_session",
		machineSecretDigest: digest,
		sessions,
	})
	const leases = new ConnectionLeases(sessions)
	disposers.push(() => {
		leases.dispose()
		return Promise.resolve()
	})
	return {
		access: { policy, sessions, leases },
		bearer: { Authorization: `Bearer ${token}` },
		cookie: {
			Cookie: `wavekit_session=${session.cookieValue}`,
			Origin: ORIGIN,
		},
	}
}

/** Non-zero s16le samples whose two bytes are both non-zero (a muted sample is all zeros). */
function ramp(samples: number, seed: number): Buffer {
	const out = Buffer.alloc(samples * 2)
	for (let i = 0; i < samples; i++) {
		const v = (seed + i) % 32_000
		out[2 * i] = 1 + (v % 254)
		out[2 * i + 1] = 1 + (Math.floor(v / 254) % 126)
	}
	return out
}

/** Per sample: the qualification of the span holding its first byte. */
function sampleFlags(spans: readonly Span[], width: number): boolean[] {
	const flags: boolean[] = []
	let at = 0
	for (const span of spans) {
		for (let b = 0; b < span.bytes.length; b++, at++)
			if (at % width === 0) flags.push(span.audible)
	}
	return flags
}

/**
 * The spans carry exactly the client bytes; the registry holds back at most one split sample
 * (it writes whole samples only), so the spans may run ahead by less than one sample.
 */
function expectSameBytes(spans: readonly Span[], out: Buffer, width = 2): void {
	const all = Buffer.concat(spans.map(s => s.bytes))
	expect(all.length - out.length).toBeGreaterThanOrEqual(0)
	expect(all.length - out.length).toBeLessThan(width)
	expect(firstDifference(all.subarray(0, out.length), out)).toBe(-1)
}

/** Index of the first differing element, -1 when equal (fast on large arrays). */
function firstDifference(
	a: ArrayLike<number | boolean>,
	b: ArrayLike<number | boolean>,
): number {
	const n = Math.max(a.length, b.length)
	for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i
	return -1
}

function sha256(buffer: Buffer): string {
	return createHash("sha256").update(buffer).digest("hex")
}

const chunkSizesArb = fc.array(fc.integer({ min: 1, max: 3_000 }), {
	minLength: 1,
	maxLength: 24,
})

describe("auto listen route: transport", () => {
	it("serves /auto and /auto.wav at 48 kHz s16le mono; other paths stay 404", async () => {
		const h = await harness()
		const port = h.port()
		const raw = await request(port, "/auto")
		expect(raw.status).toBe(200)
		expect(raw.headers["x-audio-format"]).toBe("s16le")
		expect(raw.headers["x-sample-rate"]).toBe("48000")
		expect(raw.headers["x-channels"]).toBe("1")
		const wav = await request(port, "/auto.wav")
		expect(wav.status).toBe(200)
		expect(wav.headers["content-type"]).toBe("audio/wav")
		expect(wav.body.subarray(0, 4).toString("ascii")).toBe("RIFF")
		expect(wav.body.readUInt32LE(24)).toBe(48_000)
		for (const path of ["/autox", "/auto/", "/auto.mp3", "/streams"])
			expect((await request(port, path)).status).toBe(404)
	})

	it("reports autoRoute while listening with /auto URLs and analog only without voice", async () => {
		const h = await harness()
		h.addAutoClient()
		const route = h.demod.getStatus().autoRoute
		expect(route).toMatchObject({
			active: "none",
			httpUrl: "http://localhost:41234/auto",
			wavUrl: "http://localhost:41234/auto.wav",
			clientCount: 1,
			digitalAvailable: false,
			underruns: 0,
			droppedMs: 0,
			clockRebases: 0,
		})
		await h.demod.stop()
		expect(h.demod.getStatus().autoRoute).toBeUndefined()
		expect(h.router.registry.size).toBe(0)
	})

	it("emits auto-route-changed and puts autoRoute on level events only with a client", async () => {
		const h = await harness({ config: { squelchMode: "manual" } })
		const changes: string[] = []
		h.demod.on("auto-route-changed", level => changes.push(level.active))
		h.addAutoClient()
		h.stage.open = true
		h.feed(ramp(2_000, 1))
		h.routeClock.tick(20)
		expect(changes).toEqual(["analog"])
		expect(h.demod.getStatus().autoRoute?.active).toBe("analog")
	})
})

describe("auto listen route: access parity with /stream (1.2)", () => {
	it("legacy: same wildcard CORS and OPTIONS preflight", async () => {
		const h = await harness()
		const port = h.port()
		for (const method of ["GET", "OPTIONS"]) {
			const stream = await request(port, "/stream", {}, method)
			const auto = await request(port, "/auto", {}, method)
			expect(auto.status).toBe(stream.status)
			expect(accessHeaders(auto.headers)).toEqual(accessHeaders(stream.headers))
		}
		expect((await request(port, "/auto", {}, "OPTIONS")).status).toBe(204)
	})

	it("protected: same denial without credentials, same admission and CORS with a session or bearer", async () => {
		const env = await protectedAccess()
		const h = await harness({ httpAccess: env.access })
		const port = h.port()
		const cases: Array<[string, Record<string, string>]> = [
			["none", {}],
			["foreign origin", { Origin: "http://evil.example" }],
			["cookie", env.cookie],
			["bearer", env.bearer],
		]
		for (const [, headers] of cases) {
			for (const method of ["GET", "OPTIONS"]) {
				const stream = await request(port, "/stream", headers, method)
				const auto = await request(port, "/auto", headers, method)
				expect(auto.status).toBe(stream.status)
				expect(accessHeaders(auto.headers)).toEqual(
					accessHeaders(stream.headers),
				)
				if (stream.status !== 200)
					expect(auto.body.toString()).toBe(stream.body.toString())
			}
		}
		expect((await request(port, "/auto", env.cookie)).status).toBe(200)
		expect((await request(port, "/auto")).status).toBe(401)
	})
})

describe("auto listen route: lifetime (1.4, 5.2)", () => {
	it("keeps an /auto client across a pipeline restart with a rate change", async () => {
		const h = await harness({ config: { squelchMode: "manual" } })
		const auto = h.addAutoClient()
		const before = h.internals.run?.stream.rate
		await h.demod.reconfigure({ bandwidth: 50_000 })
		h.script()
		const after = h.internals.run?.stream.rate
		expect(after).not.toBe(before)
		expect(h.router.registry.size).toBe(1)
		expect(h.router.registry.clients.has(auto.client.id)).toBe(true)
		expect(h.demod.getStatus().autoRoute?.clientCount).toBe(1)
		// The new rate is routed: analog plays again at 48 kHz.
		h.stage.open = true
		h.feed(ramp(4_000, 3))
		h.routeClock.tick(20)
		expect(h.demod.getStatus().autoRoute?.active).toBe("analog")
		expect(h.spans.at(-1)?.stream.rate).toBe(after)
		await h.demod.reconfigure({ modulation: "am" })
		expect(h.router.registry.size).toBe(1)
	})
})

/** Per sample of the client bytes: qualified by its span, and played (non-zero). */
function qualification(spans: readonly Span[], out: Buffer) {
	const flags = sampleFlags(spans, 2)
	const qualified: boolean[] = []
	const playing: boolean[] = []
	for (let s = 0; s * 2 + 1 < out.length; s++) {
		qualified.push(flags[s] ?? false)
		playing.push(out[2 * s] !== 0 || out[2 * s + 1] !== 0)
	}
	return { qualified, playing }
}

type Harness = Awaited<ReturnType<typeof harness>>

/** Mutable gate script for the evidence factory (read at each evidence build). */
const evidenceScript = { latchByte: null as number | null, guardBytes: 0 }
const scriptedEvidence: EvidenceSquelchFactory = {
	createGate: options =>
		new FakeGate(options, evidenceScript.latchByte, evidenceScript.guardBytes),
	createPreRoll: options => new PreRoll(options),
}

function feedScript(
	h: Harness,
	sizes: readonly number[],
	opens: readonly boolean[],
	between?: (i: number) => void,
): number {
	let seed = 0
	sizes.forEach((size, i) => {
		between?.(i)
		h.stage.open = opens[i] ?? false
		h.feed(ramp(Math.ceil(size / 2), seed).subarray(0, size))
		seed += size
	})
	return seed
}

describe("auto listen route: analog spans (Property 8)", () => {
	// Feature: auto-listen-route, Property 8: Analog equals /stream, sample-aligned
	// Validates: Requirements 3.1, 3.6
	it("manual: spans are the /stream bytes, flagged by the gate at each chunk", async () => {
		const h = await harness({ config: { squelchMode: "manual" } })
		await fc.assert(
			fc.asyncProperty(
				chunkSizesArb,
				fc.array(fc.boolean(), { minLength: 24, maxLength: 24 }),
				async (sizes, opens) => {
					h.reset()
					const stream = h.addStreamClient()
					h.addAutoClient()
					const perChunk: boolean[] = []
					const expected: boolean[] = []
					feedScript(h, sizes, opens, () => {
						const at = h.spans.length
						if (at > 0) perChunk.push(h.spans[at - 1]?.audible ?? false)
					})
					for (const span of h.spans) expected.push(span.audible)
					expectSameBytes(h.spans, stream.received())
					// One span per chunk, carrying that chunk's gate state.
					expect(h.spans.length).toBe(sizes.length)
					expect(expected).toEqual(sizes.map((_, i) => opens[i] ?? false))
					return Promise.resolve()
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)

	it("tone: one span per slice; exactly the unmuted samples qualify", async () => {
		const h = await harness({
			config: {
				modulation: "nfm",
				squelchMode: "manual",
				toneSquelch: { kind: "ctcss", frequencyTenthsHz: 670 },
			},
		})
		await fc.assert(
			fc.asyncProperty(
				chunkSizesArb,
				fc.array(fc.boolean(), { minLength: 1, maxLength: 64 }),
				fc.array(fc.boolean(), { minLength: 24, maxLength: 24 }),
				async (sizes, decisions, opens) => {
					h.reset()
					const run = h.internals.run
					if (run === null) throw new Error("no run")
					let n = 0
					run.tone = {
						key: "fake",
						gate: {
							push() {},
							open: () => decisions[n++ % decisions.length] ?? false,
							skip() {},
							reset() {},
						},
					}
					const stream = h.addStreamClient()
					h.addAutoClient()
					feedScript(h, sizes, opens)
					const out = stream.received()
					expectSameBytes(h.spans, out)
					const { qualified, playing } = qualification(h.spans, out)
					expect(firstDifference(qualified, playing)).toBe(-1)
					return Promise.resolve()
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)

	it("evidence: open, latch, close and the final pre-roll drain qualify exactly the played samples", async () => {
		const h = await harness({
			config: { modulation: "nfm", squelchMode: "auto" },
			factory: scriptedEvidence,
		})
		await fc.assert(
			fc.asyncProperty(
				chunkSizesArb,
				fc.array(fc.boolean(), { minLength: 24, maxLength: 24 }),
				fc.option(fc.integer({ min: 0, max: 30_000 }), { nil: null }),
				fc.integer({ min: 0, max: 4_000 }),
				async (sizes, opens, latchSample, guardBytes) => {
					evidenceScript.latchByte =
						latchSample === null ? null : latchSample * 2
					evidenceScript.guardBytes = guardBytes
					h.reset()
					const stream = h.addStreamClient()
					h.addAutoClient()
					const seed = feedScript(h, sizes, opens)
					// A closed tail drains whatever the pre-roll still holds.
					h.stage.open = false
					for (let i = 0; i < 4; i++) h.feed(ramp(10_000, seed + i))
					const out = stream.received()
					expectSameBytes(h.spans, out)
					const { qualified, playing } = qualification(h.spans, out)
					expect(firstDifference(qualified, playing)).toBe(-1)
					return Promise.resolve()
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)

	it("evidence: a chunk spanning the latch and the final drain is split at the exact samples", async () => {
		evidenceScript.latchByte = 1_000
		evidenceScript.guardBytes = 0
		const h = await harness({
			config: { modulation: "nfm", squelchMode: "auto" },
			factory: scriptedEvidence,
		})
		h.reset()
		const stream = h.addStreamClient()
		h.addAutoClient()
		h.stage.open = true
		h.feed(ramp(2_000, 0))
		h.stage.open = false
		h.feed(ramp(30_000, 7))
		const out = stream.received()
		const { qualified, playing } = qualification(h.spans, out)
		expect(firstDifference(qualified, playing)).toBe(-1)
		// The 2 000-sample over plays once, delayed by the 500 pending samples before the latch;
		// its last 500 samples are the final drain inside the closed chunk.
		expect(qualified.indexOf(true)).toBe(500)
		expect(qualified.lastIndexOf(true)).toBe(2_499)
		expect(qualified.filter(Boolean).length).toBe(2_000)
		expect(qualified.length).toBeGreaterThan(2_499)
	})

	it("manual: /auto output equals the /stream bytes through the reference resampler", async () => {
		const h = await harness({ config: { squelchMode: "manual" } })
		const stream = h.addStreamClient()
		const auto = h.addAutoClient()
		h.stage.open = true
		feedScript(
			h,
			[1, 333, 4_096, 7, 2_000, 999, 12_000],
			[true, true, true, true, true, true, true],
		)
		for (let i = 0; i < 40; i++) h.routeClock.tick(20)
		const rate = h.internals.run?.stream.rate ?? 0
		const pcm = stream.received()
		const input = new Int16Array(Math.floor(pcm.length / 2))
		for (let i = 0; i < input.length; i++) input[i] = pcm.readInt16LE(2 * i)
		const ref = feed(new PolyphaseResampler(rate, 48_000), input, [], 4_096)
		const got = auto.transport.received()
		expect(got.length).toBeGreaterThan(ref.samples.length * 2)
		const head: number[] = []
		for (let i = 0; i < ref.samples.length; i++)
			head.push(got.readInt16LE(2 * i))
		expect(head).toEqual(ref.samples)
		const tail = got.subarray(ref.samples.length * 2)
		expect(tail.every(b => b === 0)).toBe(true)
	})
})

describe("auto listen route: existing streams unchanged (Property 13)", () => {
	const configs: Array<{
		name: string
		config: Record<string, unknown>
		evidence: boolean
	}> = [
		{ name: "manual", config: { squelchMode: "manual" }, evidence: false },
		{
			name: "noise",
			config: { modulation: "nfm", squelchMode: "noise" },
			evidence: false,
		},
		{
			name: "evidence",
			config: { modulation: "nfm", squelchMode: "auto" },
			evidence: true,
		},
		{
			name: "auto wfm",
			config: { modulation: "wfm", squelchMode: "auto" },
			evidence: false,
		},
	]

	function streamBytes(
		h: Harness,
		sizes: readonly number[],
		opens: readonly boolean[],
		toggles: readonly boolean[] | null,
	): Buffer {
		h.reset()
		const stream = h.addStreamClient()
		let auto: AudioClient | null = null
		feedScript(h, sizes, opens, i => {
			if (toggles !== null && toggles[i] === true) {
				if (auto === null) auto = h.addAutoClient().client
				else {
					h.router.registry.close(auto, "test", true)
					auto = null
				}
			}
			h.routeClock.tick(20)
		})
		return stream.received()
	}

	// Feature: auto-listen-route, Property 13: Existing streams unchanged
	// Validates: Requirements 7.1, 7.2
	it("/stream bytes are identical with random /auto connects and disconnects", async () => {
		const harnesses = new Map<string, Harness>()
		for (const testCase of configs)
			harnesses.set(
				testCase.name,
				await harness({
					config: testCase.config,
					...(testCase.evidence ? { factory: scriptedEvidence } : {}),
				}),
			)
		await fc.assert(
			fc.asyncProperty(
				fc.constantFrom(...configs),
				chunkSizesArb,
				fc.array(fc.boolean(), { minLength: 24, maxLength: 24 }),
				fc.array(fc.boolean(), { minLength: 24, maxLength: 24 }),
				fc.integer({ min: 0, max: 20_000 }),
				async (testCase, sizes, opens, toggles, latch) => {
					const h = harnesses.get(testCase.name)
					if (h === undefined) throw new Error("no harness")
					evidenceScript.latchByte = latch * 2
					evidenceScript.guardBytes = 300
					const without = streamBytes(h, sizes, opens, null)
					const withAuto = streamBytes(h, sizes, opens, toggles)
					expect(withAuto.length).toBe(without.length)
					expect(firstDifference(withAuto, without)).toBe(-1)
					return Promise.resolve()
				},
			),
			{ numRuns: 100 },
		)
	}, 60_000)

	it("/stream golden: an /auto client does not change the frozen pass-through bytes", async () => {
		const h = await harness({ config: { squelchMode: "manual" } })
		const stream = h.addStreamClient()
		h.addAutoClient()
		const script = ramp(25_000, 11)
		for (let offset = 0, i = 0; offset < script.length; i++) {
			const end = Math.min(
				script.length,
				offset + ([1, 333, 4_096][i % 3] ?? 1),
			)
			h.stage.open = i % 2 === 0
			h.feed(Buffer.from(script.subarray(offset, end)))
			h.routeClock.tick(20)
			offset = end
		}
		// Manual mode passes every client byte through unchanged (frozen behaviour).
		expect(sha256(stream.received())).toBe(sha256(script))
	})
})

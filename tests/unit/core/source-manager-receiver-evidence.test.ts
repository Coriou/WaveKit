import type { EventEmitter } from "node:events"
import * as fs from "node:fs"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import fc from "fast-check"
import { SourceManager } from "../../../src/core/source-manager.js"
import type { SourceConfig } from "../../../src/core/source-manager.js"
import { createLogger } from "../../../src/utils/logger.js"
import type { Logger } from "../../../src/utils/logger.js"
import { TUNER_REST_COMMAND_POLICY } from "../../../src/core/tuner-controller.js"
import { createReceiverCapabilitiesProvider } from "../../../src/core/tuner-capabilities/provider.js"
import type { SourceReceiverEvidence } from "../../../src/core/tuner-capabilities/types.js"

interface MockSocket extends EventEmitter {
	connect: ReturnType<typeof vi.fn>
	destroy: ReturnType<typeof vi.fn>
	pause: ReturnType<typeof vi.fn>
	resume: ReturnType<typeof vi.fn>
	setTimeout: ReturnType<typeof vi.fn>
	setKeepAlive: ReturnType<typeof vi.fn>
	isPaused(): boolean
}
const transport = vi.hoisted(() => ({
	sockets: [] as MockSocket[],
	constructorFault: null as (() => void) | null,
}))
vi.mock("node:net", async () => {
	const { EventEmitter: Base } = await import("node:events")
	class Socket extends Base {
		paused = false
		connect = vi.fn()
		destroy = vi.fn(() => {
			this.emit("close")
		})
		pause = vi.fn(() => {
			this.paused = true
		})
		resume = vi.fn(() => {
			this.paused = false
		})
		setTimeout = vi.fn()
		setKeepAlive = vi.fn()
		isPaused() {
			return this.paused
		}
		constructor() {
			super()
			transport.sockets.push(this)
			const fault = transport.constructorFault
			transport.constructorFault = null
			fault?.()
		}
	}
	return { Socket }
})
vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => true),
	statSync: vi.fn(() => ({ size: 4096 })),
	openSync: vi.fn(() => 12),
	closeSync: vi.fn(),
	readSync: vi.fn(
		(_fd: number, buffer: Buffer, _offset: number, length: number) => {
			buffer.fill(128)
			return length
		},
	),
}))
interface StateInspection {
	config: SourceConfig
	stream: {
		emit(name: string): boolean
		write: (chunk: Buffer) => boolean
		end: () => unknown
		destroyed: boolean
	}
	attempt: { phase: string; watchdog: ReturnType<typeof setInterval> | null }
	rateTruth: { reset(): boolean }
	signalLevel: { reset(): boolean }
	reconnectTimer: ReturnType<typeof setTimeout> | null
	stallTimer: ReturnType<typeof setInterval> | null
	recordingState?: {
		fileDescriptor: number | null
		position: number
		isPlaying: boolean
		playbackTimer: ReturnType<typeof setTimeout> | null
	}
}
function inspect(manager: SourceManager) {
	return manager as unknown as {
		evidenceCounter: bigint
		evidenceFailed: boolean
		logger: Logger
		sources: Map<string, StateInspection>
		attemptConnection(id: string): Promise<void>
		calculateChunkSize(caps: SourceConfig["caps"]): number
	}
}
function config(
	id = "rtl",
	overrides: Partial<SourceConfig> = {},
): SourceConfig {
	return {
		id,
		type: "rtl_tcp",
		host: "test.invalid",
		port: 1234,
		loop: false,
		playbackSpeed: 1,
		caps: {
			kind: "iq",
			format: "U8_IQ",
			sampleRate: 2400000,
			exclusive: false,
		},
		...overrides,
	}
}
const managers: SourceManager[] = []
function manager() {
	const result = new SourceManager(createLogger({ level: "fatal" }))
	managers.push(result)
	return result
}
function socket() {
	return transport.sockets.at(-1)!
}
async function connected(m: SourceManager, c = config()) {
	const promise = m.connect(c)
	const s = socket()
	s.emit("connect")
	await promise
	return s
}
function evidence(m: SourceManager, id = "rtl"): SourceReceiverEvidence {
	const result = m.getReceiverEvidence(id)
	expect(result.kind).toBe("present")
	if (result.kind !== "present") throw new Error("Expected evidence")
	return result.evidence
}
function provider(m: SourceManager) {
	return createReceiverCapabilitiesProvider(
		{
			read: id => m.getReceiverEvidence(id),
			readPage: (after, limit) => m.getReceiverEvidencePage(after, limit),
		},
		TUNER_REST_COMMAND_POLICY,
	)
}
function header(magic = Buffer.from("RTL0")) {
	const bytes = Buffer.alloc(12)
	magic.copy(bytes)
	bytes.writeUInt32BE(3, 4)
	bytes.writeUInt32BE(29, 8)
	return bytes
}
beforeEach(() => {
	vi.useFakeTimers()
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"))
	vi.clearAllMocks()
	transport.sockets.length = 0
	transport.constructorFault = null
	vi.mocked(fs.existsSync).mockReturnValue(true)
	vi.mocked(fs.statSync).mockReturnValue({ size: 4096 } as fs.Stats)
	vi.mocked(fs.openSync).mockReturnValue(12)
	vi.mocked(fs.readSync).mockImplementation(
		(
			_fd: number,
			buffer: NodeJS.ArrayBufferView,
			offsetOrOptions: number | fs.ReadSyncOptions = 0,
			length = buffer.byteLength,
		) => {
			;(buffer as Buffer).fill(128)
			return typeof offsetOrOptions === "number"
				? length
				: (offsetOrOptions.length ?? buffer.byteLength)
		},
	)
})
afterEach(async () => {
	for (const m of managers.splice(0)) await m.disconnectAll()
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe("actual SourceManager receiver evidence", () => {
	// Feature: receiver-capabilities, Property 1: Session nonrevival and allocator exhaustion
	// Validates: Requirements 2.1, 2.2, 2.3, 2.6
	it("rejects captured old callbacks after remove/readd for every generated schedule", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.shuffledSubarray(["connect", "data", "error", "close", "timeout"], {
					minLength: 5,
					maxLength: 5,
				}),
				async events => {
					const m = manager()
					const old = await connected(m)
					const before = evidence(m)
					const callbacks = new Map(
						events.map(event => [event, old.listeners(event)]),
					)
					await m.disconnect("rtl")
					const next = await connected(m)
					const current = evidence(m)
					expect(current.sourceIncarnation).not.toBe(before.sourceIncarnation)
					expect(current.sessionId).not.toBe(before.sessionId)
					for (const event of events)
						for (const callback of callbacks.get(event) ?? [])
							callback(event === "data" ? header() : new Error("old"))
					const after = evidence(m)
					expect({ ...after, snapshotId: null }).toEqual({
						...current,
						snapshotId: null,
					})
					expect(next.destroy).not.toHaveBeenCalled()
					expect(next.pause).not.toHaveBeenCalled()
					await m.disconnectAll()
				},
			),
			{ numRuns: 100 },
		)
	})
	// Feature: receiver-capabilities, Property 2: Header chunk invariance
	// Validates: Requirements 1.3, 2.4
	it("only literal current-session headers advertise peer facts across generated splits", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 11 }),
				fc.boolean(),
				async (split, invalid) => {
					const m = manager()
					const s = await connected(m)
					const bytes = header(
						invalid ? Buffer.from([0xd2, 0x54, 0x4c, 0x30]) : undefined,
					)
					s.emit("data", bytes.subarray(0, split))
					expect(evidence(m).header.capture).toBe("partial")
					s.emit("data", bytes.subarray(split))
					const result = provider(m).get("rtl")
					expect(result.ok).toBe(true)
					if (result.ok) {
						expect(result.value.peerHeader.state).toBe(
							invalid ? "unknown" : "advertised",
						)
						for (const control of result.value.controls) {
							expect(control.physical.state).toBe("unknown")
							expect(control.currentValue.state).toBe("unknown")
						}
					}
					await m.disconnectAll()
				},
			),
			{ numRuns: 100 },
		)
	})
	// Feature: receiver-capabilities, Property 4: Detached coherence
	// Validates: Requirements 2.2, 3.2
	it("reads detach buffers/caps without acquisition, transport calls or timer allocation", async () => {
		await fc.assert(
			fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async reads => {
				const m = manager()
				const s = await connected(m)
				s.emit("data", header())
				const timerCount = vi.getTimerCount()
				const socketCount = transport.sockets.length
				for (let i = 0; i < reads; i++) {
					const e = evidence(m)
					e.header.bytes?.fill(0)
					;(e.caps as { sampleRate: number }).sampleRate = 1
					const p = provider(m).get("rtl")
					expect(p.ok && p.value.peerHeader.state).toBe("advertised")
				}
				expect(evidence(m).caps.sampleRate).toBe(2400000)
				expect(transport.sockets).toHaveLength(socketCount)
				expect(vi.getTimerCount()).toBe(timerCount)
				expect(s.connect).toHaveBeenCalledTimes(1)
				expect(fs.readSync).not.toHaveBeenCalled()
				await m.disconnectAll()
			}),
			{ numRuns: 100 },
		)
	})
	// Feature: receiver-capabilities, Property 5: Read purity/bounds/pagination
	// Validates: Requirements 1.6, 3.2, 3.7
	it("uses one token/clock for at most seventeen fully projected UTF8 candidates", async () => {
		await fc.assert(
			fc.asyncProperty(
				fc.integer({ min: 1, max: 16 }),
				fc.integer({ min: 1, max: 20 }),
				async (limit, count) => {
					const m = manager()
					for (let i = count - 1; i >= 0; i--)
						await connected(
							m,
							config(`source-${i.toString().padStart(2, "0")}`),
						)
					const before = inspect(m).evidenceCounter
					const page = m.getReceiverEvidencePage(null, limit)
					expect(page.kind).toBe("candidates")
					expect(inspect(m).evidenceCounter).toBe(before + 1n)
					if (page.kind === "candidates") {
						expect(page.candidates).toHaveLength(Math.min(count, limit + 1))
						expect(new Set(page.candidates.map(e => e.snapshotId)).size).toBe(1)
						expect(new Set(page.candidates.map(e => e.capturedAt)).size).toBe(1)
					}
					const result = provider(m).list({ after: null, limit })
					expect(result.ok).toBe(true)
					if (result.ok)
						expect(result.value.nextAfter).toBe(
							count > limit
								? `source-${(limit - 1).toString().padStart(2, "0")}`
								: null,
						)
					await m.disconnectAll()
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: receiver-capabilities, Property 5: Read purity/bounds/pagination
	// Validates: Requirements 3.2, 3.7
	it("selection never retains more than limit plus one references, even during insertion", async () => {
		const m = manager()
		for (let i = 19; i >= 0; i--)
			await connected(m, config(`source-${i.toString().padStart(2, "0")}`))
		const original = Array.prototype.splice
		let peak = 0
		const splice = vi
			.spyOn(Array.prototype, "splice")
			.mockImplementation(function (
				this: unknown[],
				start: number,
				deleteCount: number,
				...items: unknown[]
			) {
				const result = original.call(
					this,
					start,
					deleteCount,
					...items,
				) as unknown[]
				const item = items[0]
				if (
					typeof item === "object" &&
					item !== null &&
					"state" in item &&
					"id" in item
				)
					peak = Math.max(peak, this.length)
				return result
			})
		try {
			for (const limit of [1, 8, 16]) {
				peak = 0
				const page = m.getReceiverEvidencePage("source-02", limit)
				expect(page.kind).toBe("candidates")
				if (page.kind === "candidates")
					expect(page.candidates.map(e => e.sourceId)).toEqual(
						Array.from(
							{ length: limit + 1 },
							(_, i) => `source-${(i + 3).toString().padStart(2, "0")}`,
						),
					)
				expect(peak).toBeGreaterThan(0)
				expect(peak).toBeLessThanOrEqual(limit + 1)
			}
		} finally {
			splice.mockRestore()
		}
	})
	it("explicit reconnect creates a new registration and rejects retired socket callbacks", async () => {
		const m = manager()
		const old = await connected(m)
		old.emit("data", header())
		const before = evidence(m)
		const oldCallbacks = ["connect", "data", "error", "close", "timeout"].map(
			event => [event, old.listeners(event)] as const,
		)
		const promise = m.reconnect("rtl")
		const next = socket()
		next.emit("connect")
		await promise
		const current = evidence(m)
		expect(current.sourceIncarnation).not.toBe(before.sourceIncarnation)
		expect(current.sessionId).not.toBe(before.sessionId)
		expect(current.header.capture).toBe("missing")
		for (const [event, callbacks] of oldCallbacks)
			for (const callback of callbacks)
				callback(event === "data" ? header() : new Error("retired"))
		expect({ ...evidence(m), snapshotId: null }).toEqual({
			...current,
			snapshotId: null,
		})
		expect(next.destroy).not.toHaveBeenCalled()
	})
	it("automatic retry keeps S but isolates all old socket callbacks from the new attempt", async () => {
		const m = manager()
		const old = await connected(m)
		const state = inspect(m).sources.get("rtl")!
		const before = evidence(m)
		const oldCallbacks = ["connect", "data", "error", "close", "timeout"].map(
			event => [event, old.listeners(event)] as const,
		)
		old.emit("error", new Error("retry"))
		vi.advanceTimersByTime(5000)
		const next = socket()
		next.emit("connect")
		next.emit("data", Buffer.concat([header(), Buffer.from([128, 128])]))
		const current = evidence(m)
		const timer = state.stallTimer
		expect(inspect(m).sources.get("rtl")).toBe(state)
		expect(current.sourceIncarnation).toBe(before.sourceIncarnation)
		expect(current.sessionId).not.toBe(before.sessionId)
		for (const [event, callbacks] of oldCallbacks)
			for (const callback of callbacks)
				callback(event === "data" ? header() : new Error("retired"))
		expect({ ...evidence(m), snapshotId: null }).toEqual({
			...current,
			snapshotId: null,
		})
		expect(state.stallTimer).toBe(timer)
		expect(next.destroy).not.toHaveBeenCalled()
		expect(provider(m).get("rtl")).toMatchObject({
			ok: true,
			value: {
				peerHeader: { state: "advertised", sessionId: current.sessionId },
			},
		})
	})
	// Feature: receiver-capabilities, Property 3: Authority separation
	// Validates: Requirements 1.2, 1.3, 1.5, 3.4
	it.each([
		["sdrpp-network", "iq", "U8_IQ", "not-applicable", "non-rtl-transport"],
		[
			"sdrpp-network",
			"audio_pcm",
			"S16LE",
			"not-applicable",
			"non-rtl-transport",
		],
		["rtl_tcp", "audio_pcm", "S16LE", "not-applicable", "non-iq-source"],
		["rtl_tcp", "iq", "S16_IQ", "unknown", "format-not-captured"],
	] as const)(
		"real %s %s %s reader keeps transport distinct from physical authority",
		async (type, kind, format, headerState, reason) => {
			const m = manager()
			const c = config("variant", {
				type,
				caps: { kind, format, sampleRate: 2400000, exclusive: false },
			})
			const s = await connected(m, c)
			s.emit("data", Buffer.alloc(16, 128))
			const e = evidence(m, "variant")
			expect(e.header.capture).toBe("not-applicable")
			expect(e.delivery.state).toBe("streaming")
			expect(e.sessionId).not.toBeNull()
			const result = provider(m).get("variant")
			expect(result.ok).toBe(true)
			if (result.ok) {
				expect(result.value.peerHeader).toMatchObject({
					state: headerState,
					reason,
				})
				for (const control of result.value.controls) {
					expect(control.transport.state).toBe(
						type === "rtl_tcp" ? "applicable" : "not-applicable",
					)
					expect(control.physical.state).toBe("unknown")
					expect(control.currentValue.state).toBe("unknown")
				}
			}
		},
	)
	it.each(["network", "recording"] as const)(
		"real %s long-pause drain preserves aged sample waiting and lookahead projection",
		async variant => {
			const m = manager()
			await connected(m, config("a"))
			let s: MockSocket | undefined
			if (variant === "recording") {
				vi.mocked(fs.statSync).mockReturnValue({ size: 1000000 } as fs.Stats)
				await m.connect(
					config("z", { type: "recording", filePath: "/TEST-only" }),
				)
			} else s = await connected(m, config("z", { stallTimeoutMs: 0 }))
			const state = inspect(m).sources.get("z")!
			state.stream.write = () => false
			if (s) s.emit("data", Buffer.concat([header(), Buffer.from([128, 128])]))
			else vi.advanceTimersByTime(14)
			const sample = evidence(m, "z").delivery.lastSampleAt
			expect(sample).not.toBeNull()
			expect(evidence(m, "z").delivery.state).toBe("paused")
			vi.setSystemTime(Date.now() + 10001)
			state.stream.emit("drain")
			const waiting = evidence(m, "z")
			expect(waiting.delivery).toMatchObject({
				state: "waiting",
				lastSampleAt: sample,
			})
			expect(waiting.delivery.sampleAgeMs).toBeGreaterThanOrEqual(10001)
			const p = provider(m)
			expect(p.get("z")).toMatchObject({
				ok: true,
				value: {
					delivery: {
						state: "waiting",
						lastSampleAt: new Date(sample!).toISOString(),
					},
				},
			})
			expect(p.list({ after: null, limit: 1 })).toMatchObject({
				ok: true,
				value: { items: [{ sourceId: "a" }], nextAfter: "a" },
			})
			if (s)
				expect(p.get("z")).toMatchObject({
					ok: true,
					value: {
						peerHeader: { state: "advertised", sessionId: waiting.sessionId },
					},
				})
			else expect(waiting.header.capture).toBe("not-applicable")
			vi.setSystemTime(Date.now() + 10000)
			expect(evidence(m, "z").delivery.state).toBe("stale")
			expect(p.get("z")).toMatchObject({
				ok: true,
				value: { delivery: { state: "stale" } },
			})
			state.stream.write = () => true
			if (s) s.emit("data", Buffer.from([128, 128]))
			else vi.advanceTimersByTime(14)
			expect(p.get("z")).toMatchObject({
				ok: true,
				value: { delivery: { state: "streaming" } },
			})
		},
	)
	it("connect/header/payload/stale/paused/failure/retry follows committed transitions", async () => {
		const m = manager()
		const pending = m.connect(config())
		const s = socket()
		const initial = evidence(m)
		expect(initial.connection).toBe("connecting")
		expect(initial.delivery.state).toBe("waiting")
		s.emit("connect")
		await pending
		expect(evidence(m).header.capture).toBe("missing")
		s.emit("data", header())
		expect(evidence(m).delivery.state).toBe("waiting")
		s.emit("data", Buffer.from([128, 128]))
		expect(evidence(m).delivery.state).toBe("streaming")
		vi.advanceTimersByTime(10001)
		expect(evidence(m).delivery.state).toBe("stale")
		const state = inspect(m).sources.get("rtl")!
		state.stream.write = () => false
		s.emit("data", Buffer.from([128, 128]))
		expect(evidence(m).delivery.state).toBe("paused")
		state.stream.emit("drain")
		expect(evidence(m).delivery.state).toBe("streaming")
		let inside: SourceReceiverEvidence | undefined
		m.on("error", () => {
			inside = evidence(m)
		})
		s.emit("error", new Error("failure"))
		expect(inside).toMatchObject({
			connection: "disconnected",
			sessionId: null,
			delivery: {
				state: "disconnected",
				lastSampleAt: null,
				sampleAgeMs: null,
			},
		})
		expect(provider(m).get("rtl")).toMatchObject({
			ok: true,
			value: { peerHeader: { state: "unknown", reason: "not-connected" } },
		})
		vi.advanceTimersByTime(5000)
		const next = socket()
		expect(next).not.toBe(s)
		next.emit("connect")
		const retried = evidence(m)
		expect(retried.sourceIncarnation).toBe(initial.sourceIncarnation)
		expect(retried.sessionId).not.toBe(initial.sessionId)
		expect(retried.header.capture).toBe("missing")
	})
	it("late old watchdog, retry and drain callbacks cannot touch new resources", async () => {
		const intervals = vi.spyOn(globalThis, "setInterval")
		const timeouts = vi.spyOn(globalThis, "setTimeout")
		const m = manager()
		const old = await connected(m)
		const oldState = inspect(m).sources.get("rtl")!
		const watchdog = intervals.mock.calls.find(([, ms]) => ms === 1000)?.[0] as
			| (() => void)
			| undefined
		expect(watchdog).toBeTypeOf("function")
		old.emit("data", Buffer.concat([header(), Buffer.from([128, 128])]))
		old.emit("error", new Error("retry"))
		const retry = timeouts.mock.calls.find(
			([, ms]) => typeof ms === "number" && ms >= 2000,
		)?.[0] as (() => void) | undefined
		vi.advanceTimersByTime(5000)
		const next = socket()
		next.emit("connect")
		const timer = inspect(m).sources.get("rtl")!.stallTimer
		const count = transport.sockets.length
		watchdog!()
		retry!()
		expect(inspect(m).sources.get("rtl")!.stallTimer).toBe(timer)
		expect(transport.sockets).toHaveLength(count)
		expect(next.destroy).not.toHaveBeenCalled()
		await m.disconnect("rtl")
		await connected(m)
		oldState.stream.emit("drain")
		expect(socket().resume).not.toHaveBeenCalled()
	})
	it("watchdog rechecks attempt ownership after socket pause inspection", async () => {
		const intervals = vi.spyOn(globalThis, "setInterval")
		const m = manager()
		const old = await connected(m)
		old.emit("data", Buffer.concat([header(), Buffer.from([128, 128])]))
		const watchdog = intervals.mock.calls.find(
			([, ms]) => ms === 1000,
		)?.[0] as () => void
		let next: MockSocket | undefined
		let nextTimer: ReturnType<typeof setInterval> | null = null
		vi.spyOn(old, "isPaused").mockImplementationOnce(() => {
			old.emit("error", new Error("replace attempt"))
			vi.advanceTimersByTime(5000)
			next = socket()
			next.emit("connect")
			next.emit("data", Buffer.concat([header(), Buffer.from([128, 128])]))
			nextTimer = inspect(m).sources.get("rtl")!.stallTimer
			vi.setSystemTime(Date.now() + 15001)
			return false
		})
		vi.setSystemTime(Date.now() + 15001)
		watchdog()
		expect(next).toBeDefined()
		expect(nextTimer).not.toBeNull()
		expect(inspect(m).sources.get("rtl")!.stallTimer).toBe(nextTimer)
		expect(next!.destroy).not.toHaveBeenCalled()
		expect(evidence(m).connection).toBe("connected")
	})
	it("logger and stream-write replacements abort all old payload continuations", async () => {
		for (const boundary of ["log", "write"] as const) {
			const m = manager()
			const old = await connected(m)
			const data = vi.fn()
			const payload = vi.fn()
			m.on("data", data)
			m.on("payload-started", payload)
			let replacement: Promise<unknown> | undefined
			const replace = () => {
				void m.disconnect("rtl")
				replacement = connected(m)
			}
			if (boundary === "log")
				vi.spyOn(inspect(m).logger, "info").mockImplementationOnce(replace)
			else
				inspect(m).sources.get("rtl")!.stream.write = () => {
					replace()
					return false
				}
			old.emit("data", Buffer.concat([header(), Buffer.from([128, 128])]))
			await replacement
			expect(data).not.toHaveBeenCalled()
			expect(payload).not.toHaveBeenCalled()
			expect(socket().pause).not.toHaveBeenCalled()
			expect(evidence(m).delivery.lastSampleAt).toBeNull()
			await m.disconnectAll()
		}
	})
	it("prospective recording-resource failure cleans opened fd before error notification", async () => {
		const m = manager()
		const original = new Error("prospective-R")
		vi.spyOn(inspect(m), "calculateChunkSize").mockImplementationOnce(() => {
			throw original
		})
		let observed = false
		m.once("error", () => {
			expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(12)
			expect(evidence(m).connection).toBe("disconnected")
			observed = true
		})
		await expect(
			m.connect(config("rtl", { type: "recording", filePath: "/TEST-only" })),
		).rejects.toBe(original)
		expect(observed).toBe(true)
		expect(fs.closeSync).toHaveBeenCalledTimes(1)
	})
	it("network nonconnection-error catch cannot delete a constructor-reentrant successor", async () => {
		const m = manager()
		const original = new Error("constructor")
		let replacement: Promise<unknown> | undefined
		transport.constructorFault = () => {
			void m.disconnect("rtl")
			replacement = connected(m)
			throw original
		}
		await expect(m.connect(config())).rejects.toBe(original)
		await replacement
		expect(evidence(m).connection).toBe("connected")
		expect(socket().destroy).not.toHaveBeenCalled()
	})

	it("recording failure after published resource retains evidence and cleans file once", async () => {
		const m = manager()
		const original = new Error("post-R")
		vi.spyOn(inspect(m).logger, "info").mockImplementationOnce(() => {
			throw original
		})
		const ended = vi.fn()
		m.on("ended", ended)
		await expect(
			m.connect(config("rtl", { type: "recording", filePath: "/TEST-only" })),
		).rejects.toBe(original)
		expect(evidence(m)).toMatchObject({
			connection: "disconnected",
			sessionId: null,
			delivery: { lastSampleAt: null, state: "disconnected" },
		})
		expect(inspect(m).sources.get("rtl")!.stream.destroyed).toBe(false)
		expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(12)
		expect(ended).not.toHaveBeenCalled()
		expect(fs.readSync).not.toHaveBeenCalled()
	})
	it("post-resource startup logger recreation cannot let old cleanup or catch affect successor", async () => {
		const m = manager()
		const original = new Error("post-R replacement")
		let replacement: Promise<unknown> | undefined
		vi.spyOn(inspect(m).logger, "info").mockImplementationOnce(() => {
			void m.disconnect("rtl")
			replacement = connected(m)
			throw original
		})
		await expect(
			m.connect(config("rtl", { type: "recording", filePath: "/TEST-only" })),
		).rejects.toBe(original)
		await replacement
		expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(12)
		expect(evidence(m).source.type).toBe("rtl_tcp")
		expect(socket().destroy).not.toHaveBeenCalled()
	})
	it("retired recording timer/read/drain cannot read, close or schedule successor", async () => {
		const timers = vi.spyOn(globalThis, "setTimeout")
		const m = manager()
		await m.connect(
			config("rtl", { type: "recording", filePath: "/TEST-only" }),
		)
		const old = inspect(m).sources.get("rtl")!
		const tick = timers.mock.calls.at(-1)?.[0] as () => void
		await m.disconnect("rtl")
		vi.mocked(fs.openSync).mockReturnValue(42)
		await m.connect(
			config("rtl", { type: "recording", filePath: "/TEST-successor" }),
		)
		const current = inspect(m).sources.get("rtl")!
		const timer = current.recordingState!.playbackTimer
		tick()
		old.stream.emit("drain")
		expect(fs.readSync).not.toHaveBeenCalled()
		expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(12)
		expect(current.recordingState!.fileDescriptor).toBe(42)
		expect(current.recordingState!.playbackTimer).toBe(timer)
	})
	it("config/caps accessor input never invokes getters and invalid existing IDs remain operational", async () => {
		let calls = 0
		const m = manager()
		const c = config()
		Object.defineProperty(c, "caps", {
			enumerable: true,
			get() {
				calls++
				throw new Error("getter")
			},
		})
		await expect(m.connect(c)).rejects.toMatchObject({
			code: "SOURCE_CONFIG_INVALID",
		})
		expect(calls).toBe(0)
		expect(inspect(m).sources.size).toBe(0)
		await connected(m, config("x".repeat(101)))
		expect(m.getReceiverEvidence("x".repeat(101))).toEqual({ kind: "limit" })
		expect(m.getStatus("x".repeat(101))?.connected).toBe(true)
	})

	it("allocation exhaustion/corruption latch, missing/empty and precheck consume nothing", async () => {
		const m = manager()
		const max = (1n << 128n) - 1n
		inspect(m).evidenceCounter = max
		expect(m.getReceiverEvidence("missing")).toEqual({ kind: "missing" })
		expect(m.getReceiverEvidencePage(null, 1)).toMatchObject({
			kind: "candidates",
			snapshotId: null,
		})
		expect(inspect(m).evidenceCounter).toBe(max)
		await connected(m)
		expect(inspect(m).sources.has("rtl")).toBe(true)
		expect(m.getReceiverEvidence("rtl")).toEqual({ kind: "unavailable" })
		expect(inspect(m).evidenceFailed).toBe(true)
		const fresh = manager()
		await connected(fresh)
		inspect(fresh).evidenceCounter = max
		expect(evidence(fresh).snapshotId).toBe("f".repeat(32))
		expect(fresh.getReceiverEvidence("rtl")).toEqual({ kind: "unavailable" })
		inspect(fresh).evidenceCounter = 1n
		expect(fresh.getReceiverEvidence("rtl")).toEqual({ kind: "unavailable" })
		const corrupt = manager()
		inspect(corrupt).evidenceCounter = 0n
		await connected(corrupt)
		expect(corrupt.getReceiverEvidence("rtl")).toEqual({ kind: "unavailable" })
	})
	it("invalid IDs before cursor and invalid lookahead fail whole page without token", async () => {
		const m = manager()
		await connected(m, config("a/invalid"))
		await connected(m, config("z"))
		const before = inspect(m).evidenceCounter
		expect(m.getReceiverEvidencePage("y", 1)).toEqual({ kind: "limit" })
		expect(inspect(m).evidenceCounter).toBe(before)
		await m.disconnect("a/invalid")
		await connected(m, config("zz"))
		inspect(m).sources.get("zz")!.config.caps.sampleRate = 0
		expect(m.getReceiverEvidencePage(null, 1)).toEqual({ kind: "conflict" })
		expect(inspect(m).evidenceCounter).toBe(before + 2n)
	})
	it("failed provider projection consumes the one already allocated observation", async () => {
		const m = manager()
		await connected(
			m,
			config("rtl", {
				caps: {
					kind: "audio_pcm",
					format: "U8_IQ",
					sampleRate: 2400000,
					exclusive: false,
				},
			}),
		)
		const before = inspect(m).evidenceCounter
		expect(provider(m).get("rtl")).toEqual({ ok: false, code: "CONFLICT" })
		expect(inspect(m).evidenceCounter).toBe(before + 1n)
	})
	it.each([
		"connected",
		"data",
		"payload-started",
		"disconnected",
		"error",
		"rate-truth-changed",
		"signal-flat-changed",
		"caps-changed",
	])("%s reentrancy cannot continue on a replacement", async event => {
		const m = manager()
		const old = await connected(m)
		const state = inspect(m).sources.get("rtl")!
		let replacement: Promise<unknown> | undefined
		m.once(event, () => {
			void m.disconnect("rtl")
			replacement = m.connect(config())
			socket().emit("connect")
		})
		if (event === "connected") {
			await m.disconnect("rtl")
			const promise = m.connect(config())
			socket().emit("connect")
			await promise
		} else if (event === "error") old.emit("error", new Error("failed"))
		else if (event === "disconnected") old.emit("close")
		else if (event === "caps-changed")
			m.updateSourceCaps("rtl", { sampleRate: 2000000 })
		else if (
			event === "rate-truth-changed" ||
			event === "signal-flat-changed"
		) {
			vi.spyOn(
				event === "rate-truth-changed" ? state.rateTruth : state.signalLevel,
				"reset",
			).mockReturnValueOnce(true)
			old.emit("close")
			vi.advanceTimersByTime(5000)
			socket().emit("connect")
		} else old.emit("data", Buffer.concat([header(), Buffer.from([128, 128])]))
		await replacement
		const next = socket()
		expect(inspect(m).sources.get("rtl")).not.toBe(state)
		expect(next.destroy).not.toHaveBeenCalled()
		expect(next.pause).not.toHaveBeenCalled()
		expect(evidence(m).delivery.lastSampleAt).toBeNull()
	})
	it.each(["missing", "empty", "stat", "open"])(
		"recording %s startup retains registration and original rejection without readers doing I/O",
		async failure => {
			const m = manager()
			const error = new Error(failure)
			if (failure === "missing") vi.mocked(fs.existsSync).mockReturnValue(false)
			if (failure === "empty")
				vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as fs.Stats)
			if (failure === "stat")
				vi.mocked(fs.statSync).mockImplementation(() => {
					throw error
				})
			if (failure === "open")
				vi.mocked(fs.openSync).mockImplementation(() => {
					throw error
				})
			let inside: SourceReceiverEvidence | undefined
			const ended = vi.fn()
			m.on("ended", ended)
			m.on("error", () => {
				inside = evidence(m)
			})
			const promise = m.connect(
				config("rtl", { type: "recording", filePath: "/TEST-only" }),
			)
			await expect(promise).rejects.toThrow(
				failure === "missing"
					? "not found"
					: failure === "empty"
						? "empty"
						: failure,
			)
			expect(inside).toMatchObject({
				sessionId: null,
				connection: "disconnected",
				delivery: {
					state: "disconnected",
					lastSampleAt: null,
					sampleAgeMs: null,
				},
				header: { capture: "not-applicable" },
			})
			const calls = vi.mocked(fs.statSync).mock.calls.length
			evidence(m)
			expect(fs.statSync).toHaveBeenCalledTimes(calls)
			expect(fs.readSync).not.toHaveBeenCalled()
			expect(ended).not.toHaveBeenCalled()
			expect(inspect(m).sources.has("rtl")).toBe(true)
		},
	)
	it("recording no-listener startup failure and allocator failure remain operationally registered", async () => {
		const m = manager()
		inspect(m).evidenceCounter = 0n
		vi.mocked(fs.existsSync).mockReturnValue(false)
		await expect(
			m.connect(config("rtl", { type: "recording", filePath: "/TEST-only" })),
		).rejects.toThrow("not found")
		expect(inspect(m).sources.has("rtl")).toBe(true)
		expect(m.getReceiverEvidence("rtl")).toEqual({ kind: "unavailable" })
	})
	it("recording opened descriptor after reentrant removal closes only the old local file", async () => {
		const m = manager()
		vi.mocked(fs.openSync).mockImplementationOnce(() => {
			void m.disconnect("rtl")
			void connected(m)
			return 41
		})
		await m.connect(
			config("rtl", { type: "recording", filePath: "/TEST-only" }),
		)
		expect(fs.closeSync).toHaveBeenCalledExactlyOnceWith(41)
		expect(evidence(m).source.type).toBe("rtl_tcp")
		expect(socket().destroy).not.toHaveBeenCalled()
	})
	it("recording startup error listener recreation survives outer rejected-await catch", async () => {
		const m = manager()
		vi.mocked(fs.openSync).mockImplementationOnce(() => {
			throw new Error("original")
		})
		let replacement: Promise<unknown> | undefined
		m.once("error", () => {
			void m.disconnect("rtl")
			replacement = connected(m)
		})
		await expect(
			m.connect(config("rtl", { type: "recording", filePath: "/TEST-only" })),
		).rejects.toThrow("original")
		await replacement
		expect(evidence(m).source.type).toBe("rtl_tcp")
		expect(socket().destroy).not.toHaveBeenCalled()
	})
	it("recording EOF/read failure end once and clear samples; loop resets current activity", async () => {
		const m = manager()
		const ended = vi.fn()
		m.on("ended", ended)
		await m.connect(
			config("rtl", { type: "recording", filePath: "/TEST-only" }),
		)
		expect(evidence(m).sessionId).toBeNull()
		vi.advanceTimersByTime(50)
		expect(evidence(m).connection).toBe("ended")
		expect(evidence(m).delivery.lastSampleAt).toBeNull()
		expect(ended).toHaveBeenCalledTimes(1)
		expect(fs.closeSync).toHaveBeenCalledTimes(1)
		await m.disconnect("rtl")
		vi.mocked(fs.readSync).mockImplementationOnce(() => {
			throw new Error("read")
		})
		await m.connect(
			config("rtl", { type: "recording", filePath: "/TEST-only" }),
		)
		vi.advanceTimersByTime(50)
		expect(evidence(m).connection).toBe("ended")
		expect(ended).toHaveBeenCalledTimes(2)
		await m.disconnect("rtl")
		await m.connect(
			config("rtl", { type: "recording", filePath: "/TEST-only", loop: true }),
		)
		const state = inspect(m).sources.get("rtl")!
		state.stream.write = () => true
		const recording = state.recordingState!
		const timerCount = vi.getTimerCount()
		const closeCount = vi.mocked(fs.closeSync).mock.calls.length
		const readCount = vi.mocked(fs.readSync).mock.calls.length
		vi.advanceTimersToNextTimer()
		const before = evidence(m)
		expect(before.delivery.state).toBe("streaming")
		expect(before.delivery.lastSampleAt).not.toBeNull()
		expect(recording.position).toBe(4096)
		expect(fs.readSync).toHaveBeenCalledTimes(readCount + 1)
		const firstNextTimer = recording.playbackTimer
		vi.advanceTimersToNextTimer()
		const rewound = evidence(m)
		expect(rewound.sourceIncarnation).toBe(before.sourceIncarnation)
		expect(rewound.sessionId).toBeNull()
		expect(rewound.header.capture).toBe("not-applicable")
		expect(rewound.delivery).toMatchObject({
			state: "waiting",
			lastSampleAt: null,
			sampleAgeMs: null,
		})
		expect(recording.position).toBe(0)
		expect(state.recordingState).toBe(recording)
		expect(recording.fileDescriptor).toBe(12)
		expect(recording.isPlaying).toBe(true)
		expect(recording.playbackTimer).not.toBeNull()
		expect(recording.playbackTimer).not.toBe(firstNextTimer)
		expect(vi.getTimerCount()).toBe(timerCount)
		expect(fs.closeSync).toHaveBeenCalledTimes(closeCount)
		expect(fs.readSync).toHaveBeenCalledTimes(readCount + 1)
		expect(provider(m).get("rtl")).toMatchObject({
			ok: true,
			value: { delivery: { state: "waiting" } },
		})
		vi.advanceTimersToNextTimer()
		expect(evidence(m).delivery.state).toBe("streaming")
		expect(fs.readSync).toHaveBeenCalledTimes(readCount + 2)
	})
})

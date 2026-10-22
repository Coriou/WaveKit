import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import pino from "pino"
import fc from "fast-check"
import { describe, expect, it, vi } from "vitest"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { SourceFanoutRouter } from "../../../src/core/source-fanout-router.js"
import type { SourceManager } from "../../../src/core/source-manager.js"
import type {
	BurstAbsorberDeps,
	IngestRecorder,
	LinkBurstFactories,
} from "../../../src/core/link-burst/contract.js"

function setup(
	options: {
		host?: string
		type?: string
		format?: string
		seconds?: number
		replay?: boolean
		secondary?: boolean
	} = {},
) {
	const stream = new PassThrough()
	const caps = { format: options.format ?? "U8_IQ", sampleRate: 2_048_000 }
	const config = {
		host: options.host ?? "example.invalid",
		type: options.type ?? "rtl_tcp",
		burstAbsorber: { seconds: options.seconds ?? 2 },
	}
	const sources = Object.assign(new EventEmitter(), {
		getAllStatus: () => [{ id: "a", connected: options.replay ?? false }],
		getStatus: () => ({ connected: true }),
		getStream: () => stream,
		getCaps: () => caps,
		getConfig: () => config,
	})
	const recorder: IngestRecorder = {
		configure: vi.fn(),
		resetArrival: vi.fn(),
		observeChunk: vi.fn(),
		noteHolding: vi.fn(),
		interval: () => null,
		window: () => ({
			worstStallMs: null,
			gapP99Ms: null,
			burstSeconds: 0,
			catchupBytes: 0,
			chunks: 0,
		}),
		histograms: () => ({
			gapBucketUpperMs: [],
			gapCounts: [],
			chunkSizeBucketUpperBytes: [],
			chunkSizeCounts: [],
			catchupBucketUpperBytes: [],
			catchupCounts: [],
		}),
	}
	const totals = {
		capacityBytes: 0,
		heldBytes: 0,
		absorbedBytesTotal: 0,
		overflowBytesTotal: 42,
		overflowChunksTotal: 3,
		flushedBytesTotal: 0,
		window: {
			peakHeldBytes: 0,
			absorbedBytes: 0,
			overflowBytes: 0,
			flushedBytes: 0,
			peakHeldMs: 0,
			maxLaggardExcludeMs: null,
		},
	}
	const absorber = {
		configure: vi.fn(),
		ingest: vi.fn(),
		flush: vi.fn(),
		counters: () => totals,
		dispose: vi.fn(),
	}
	const factories: LinkBurstFactories = {
		createRecorder: vi.fn(() => recorder),
		createAbsorber: vi.fn((_id: string, _deps: BurstAbsorberDeps) => absorber),
		monoNow: () => 123,
	}
	const logger = pino({ level: "silent" })
	const primary = new FanoutManager(logger)
	const router = new SourceFanoutRouter(
		sources as unknown as SourceManager,
		primary,
		logger,
		options.secondary ? "other" : "a",
		{ linkBurst: factories },
	)
	const fanout = options.secondary ? router.getFanout("a") : primary
	if (!options.replay && !options.secondary) sources.emit("connected", "a")
	return {
		sources,
		stream,
		caps,
		recorder,
		absorber,
		factories,
		router,
		fanout,
		logger,
		close() {
			router.destroy()
			primary.destroy()
			stream.destroy()
		},
	}
}

describe("link burst router", () => {
	// Feature: link-burst-resilience, Property 2: Pass-through identity (router half)
	// Validates: Requirements 1.1, 1.3
	it("passes loopback, recording, audio and zero capacity chunks synchronously by identity", () => {
		fc.assert(
			fc.property(
				fc.uint8Array({ minLength: 1, maxLength: 256 }),
				fc.constantFrom("loopback", "recording", "audio", "zero"),
				(bytes, mode) => {
					const s = setup(
						mode === "loopback"
							? { host: "localhost" }
							: mode === "recording"
								? { type: "recording" }
								: mode === "audio"
									? { format: "S16_AUDIO" }
									: { seconds: 0 },
					)
					try {
						const received = vi.fn()
						s.fanout.addBranch({ id: "sink" }).on("data", received)
						const chunk = Buffer.from(bytes)
						s.stream.emit("data", chunk)
						expect(received).toHaveBeenCalledExactlyOnceWith(chunk)
						expect(received.mock.calls[0]?.[0]).toBe(chunk)
						expect(s.factories.createAbsorber).not.toHaveBeenCalled()
					} finally {
						s.close()
					}
				},
			),
			{ numRuns: 100 },
		)
	})
	it.each([{}, { replay: true }, { secondary: true }])(
		"network IQ source gets one absorber sized seconds × rate × frame %j",
		options => {
			const s = setup(options)
			try {
				expect(s.absorber.configure).toHaveBeenLastCalledWith(8_192_000)
				s.sources.emit("connected", "a")
				expect(s.factories.createAbsorber).toHaveBeenCalledTimes(1)
				s.stream.emit("data", Buffer.alloc(2))
				expect(s.recorder.observeChunk).toHaveBeenCalledExactlyOnceWith(2, 123)
				expect(s.absorber.ingest).toHaveBeenCalledTimes(1)
			} finally {
				s.close()
			}
		},
	)
	it("caps-changed flushes and resizes", () => {
		const s = setup()
		try {
			s.caps.sampleRate = 100
			s.sources.emit("caps-changed", "a", s.caps)
			expect(s.absorber.flush).toHaveBeenCalledWith("rate")
			expect(s.absorber.configure).toHaveBeenLastCalledWith(400)
			expect(s.recorder.configure).toHaveBeenLastCalledWith(100, 2)
			s.caps.format = "S16_IQ"
			s.sources.emit("caps-changed", "a", s.caps)
			expect(s.factories.createAbsorber).toHaveBeenCalledTimes(2)
			expect(s.absorber.configure).toHaveBeenLastCalledWith(800)
		} finally {
			s.close()
		}
		expect(s.sources.listenerCount("caps-changed")).toBe(0)
	})
	it("disconnect while holding flushes and resets arrival", () => {
		const s = setup()
		try {
			s.stream.emit("data", Buffer.alloc(10))
			s.sources.emit("disconnected", "a")
			expect(s.absorber.flush).toHaveBeenCalledWith("disconnect")
			expect(s.recorder.resetArrival).toHaveBeenCalledTimes(1)
			expect(s.stream.listenerCount("data")).toBe(0)
			s.sources.emit("connected", "a")
			expect(s.factories.createRecorder).toHaveBeenCalledTimes(1)
			s.sources.emit("removed", "a")
			expect(s.absorber.flush).toHaveBeenCalledWith("removed")
			expect(s.absorber.dispose).toHaveBeenCalledTimes(1)
			expect(s.router.linkBurst("a")).toBeNull()
		} finally {
			s.close()
		}
	})
	it("counter map marks inactive branches", () => {
		const s = setup()
		try {
			s.fanout.addBranch({ id: "deferred", deferred: true })
			expect(
				[...s.router.branchDropCounters("a")!.values()].some(v => !v.active),
			).toBe(true)
		} finally {
			s.close()
		}
	})
	it("@absorber key carries overflow totals and a fresh instance per absorber", () => {
		const s = setup()
		try {
			const first = [...s.router.branchDropCounters("a")!][0]!
			expect(first[0]).toMatch(/^@absorber#\d+$/)
			expect(first[1]).toEqual({
				droppedBytesTotal: 42,
				droppedChunksTotal: 3,
				active: true,
			})
			s.sources.emit("removed", "a")
			s.sources.emit("connected", "a")
			expect([...s.router.branchDropCounters("a")!.keys()][0]).not.toBe(
				first[0],
			)
		} finally {
			s.close()
		}
	})
	it("a branch id starting with @ is refused", () => {
		const s = setup()
		try {
			const warn = vi.spyOn(s.logger, "warn")
			s.fanout.addBranch({ id: "@untrusted" })
			expect(s.fanout.getBranchIds()).toEqual([])
			expect(warn).toHaveBeenCalledExactlyOnceWith(
				"Reserved fanout branch prefix",
			)
		} finally {
			s.close()
		}
	})
	it("other data taps see chunks while the absorber holds", () => {
		const s = setup()
		try {
			const tap = vi.fn()
			s.sources.on("data", tap)
			s.stream.on("data", chunk => s.sources.emit("data", "a", chunk))
			const chunk = Buffer.alloc(2)
			s.stream.emit("data", chunk)
			expect(tap).toHaveBeenCalledExactlyOnceWith("a", chunk)
			expect(s.absorber.ingest).toHaveBeenCalledWith(chunk)
		} finally {
			s.close()
		}
	})
})

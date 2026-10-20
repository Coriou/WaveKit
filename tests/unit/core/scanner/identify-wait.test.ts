/** WG12: identify waits for a gated transmission, then times the trial from its start. */
import { Writable } from "node:stream"
import pino from "pino"
import { describe, expect, it } from "vitest"
import {
	IDENTIFY_WAIT_DEFAULT_MS,
	IDENTIFY_WAIT_MAX_MS,
	IDENTIFY_WAIT_MIN_MS,
} from "@wavekit/api-types"
import type { ScannerIdentifyEventData } from "@wavekit/api-types"
import type { Logger } from "../../../../src/utils/logger.js"
import {
	IdentifyRunner,
	normaliseIdentify,
	type IdentifyTrackView,
} from "../../../../src/core/scanner/identify.js"
import type { KnownProtocolMemory } from "../../../../src/core/scanner/known-protocol-contract.js"
import type { Discovery } from "../../../../src/core/scanner/types.js"
import { testSettings } from "../../../mocks/scanner/engine-fakes.js"
import {
	TARGET_HZ,
	fakeInner,
	identifyRecord,
	summaryOf,
	trackOf,
	viewOf,
} from "../../../mocks/scanner/identify-fakes.js"
import { flushAsync, poolHarness } from "../../../mocks/scanner/probe-fakes.js"
import { FakeMemory } from "./identify-heard-fakes.js"
import golden from "./identify-wait-default-golden.json" with { type: "json" }

/** The c6eef7e1 transcript, with undefined fields dropped the way the golden file stores them. */
function canon(events: ScannerIdentifyEventData[]): unknown {
	return JSON.parse(JSON.stringify(events)) as unknown
}

type GateStart = { startSample: number; atMs: number }
type GateFn = (
	sourceId: string,
	hz: number,
	toleranceHz: number,
) => GateStart | null

interface WaitOpts {
	request?: {
		timeoutMs?: number
		waitMs?: number
		waitUntilSignal?: boolean
		protocols?: ("dmr" | "analog-fm")[]
	}
	gatedAt?: (
		sourceId: string,
		hz: number,
		toleranceHz: number,
	) => GateStart | null
	tracks?: IdentifyTrackView[]
	knownProtocols?: KnownProtocolMemory
	discoveryOf?: (observationId: string) => Discovery | undefined
	logger?: Logger
}

function waitHarness(opts: WaitOpts = {}) {
	const settings = testSettings()
	const pool = poolHarness({ settings, cpuPercent: null })
	const record = identifyRecord()
	const tracks = opts.tracks ?? []
	const events: ScannerIdentifyEventData[] = []
	const request = {
		target: { frequencyHz: TARGET_HZ },
		record: false as const,
		...opts.request,
	}
	const runner = new IdentifyRunner({
		record,
		identify: normaliseIdentify(request),
		inner: fakeInner(record, () => pool.clock.now),
		probes: pool.pool,
		engine: () => pool.engine,
		artefactAt: () => Promise.resolve(null),
		liveTracks: () => tracks,
		lastSummary: () => summaryOf(),
		discoveryOf: opts.discoveryOf ?? (() => undefined),
		priorsAt: () => ({}),
		format: () => "U8_IQ",
		channelizer: () => false,
		settings: () => settings,
		emit: d => events.push(structuredClone(d)),
		logger: opts.logger ?? pino({ level: "silent" }),
		now: () => pool.clock.now,
		...(opts.knownProtocols ? { knownProtocols: opts.knownProtocols } : {}),
		...(opts.gatedAt ? { gatedAt: opts.gatedAt } : {}),
	})
	const advanceTo = async (at: number): Promise<void> => {
		pool.clock.now = at
		runner.tick(pool.clock.now)
		pool.pool.pump()
		await flushAsync()
		await flushAsync()
	}
	const advance = async (ms: number): Promise<void> => {
		await advanceTo(pool.clock.now + ms)
	}
	return {
		...pool,
		record,
		tracks,
		events,
		runner,
		advance,
		advanceTo,
		last: () => events.at(-1),
		destroy: async () => {
			await runner.dispose()
			await pool.pool.destroy()
		},
	}
}

const dmrTrack = () =>
	viewOf(trackOf({ acf30: -0.94, acf60: 0.99, blocks: 20 }), "d_1")

function captureLogger(): { logger: Logger; text: () => string } {
	const chunks: string[] = []
	const logger = pino(
		{ level: "info" },
		new Writable({
			write(chunk, _enc, cb) {
				chunks.push(String(chunk))
				cb()
			},
		}),
	)
	return { logger, text: () => chunks.join("") }
}

describe("IdentifyRunner waits for a gated transmission (WG12)", () => {
	it("waits, then timeoutMs counts from the gated start", async () => {
		const cell = { gateAt: Number.POSITIVE_INFINITY, now: () => 0 }
		const h = waitHarness({
			request: { timeoutMs: 2000, waitUntilSignal: true, waitMs: 10_000 },
			gatedAt: () =>
				cell.now() >= cell.gateAt
					? { startSample: 10, atMs: cell.gateAt }
					: null,
		})
		cell.now = () => h.clock.now
		try {
			await h.runner.start()
			const started = h.record.startedAt ?? 0
			h.tracks.push(viewOf(trackOf({ blocks: 20 })))
			await h.advanceTo(started + 10)
			expect(h.last()?.state).toBe("waiting-for-signal")
			expect(h.decoders.created.size).toBe(0)
			await h.advanceTo(started + 2000)
			expect(h.last()?.state).toBe("waiting-for-signal")
			expect(h.last()?.result).toBeUndefined()
			expect(h.decoders.created.size).toBe(0)
			h.tracks.length = 0
			await h.advanceTo(started + 4999)
			expect(h.last()?.state).toBe("waiting-for-signal")
			cell.gateAt = started + 5000
			await h.advanceTo(started + 5000)
			expect(h.last()?.state).toBe("waiting-for-signal")
			expect(h.last()?.result?.ended).not.toBe("no-signal")
			expect(h.decoders.created.size).toBe(0)
			await h.advanceTo(started + 6999)
			expect(h.last()?.state).toBe("waiting-for-signal")
			await h.advanceTo(started + 7000)
			expect(h.last()?.state).toBe("unidentified")
			expect(h.last()?.result?.ended).toBeUndefined()
			expect(h.last()?.result?.protocol).toBeUndefined()
			expect(h.clock.now).toBe(started + 7000)
			expect(h.decoders.created.size).toBe(0)
			expect(h.runner.view()).not.toHaveProperty("waitUntilSignal")
			expect(h.runner.view()).not.toHaveProperty("waitMs")
		} finally {
			await h.destroy()
		}
	})

	it("a gated start exactly at waitMs counts timeoutMs from that instant", async () => {
		const cell = { started: 0, now: () => 0 }
		const h = waitHarness({
			request: { timeoutMs: 2000, waitUntilSignal: true, waitMs: 1000 },
			gatedAt: () =>
				cell.now() >= cell.started + 1000
					? { startSample: 4, atMs: cell.started + 1000 }
					: null,
		})
		cell.now = () => h.clock.now
		try {
			await h.runner.start()
			const started = h.record.startedAt ?? 0
			cell.started = started
			await h.advanceTo(started + 10)
			await h.advanceTo(started + 999)
			expect(h.last()?.state).toBe("waiting-for-signal")
			await h.advanceTo(started + 1000)
			expect(h.last()?.state).toBe("waiting-for-signal")
			expect(h.last()?.result?.ended).not.toBe("no-signal")
			await h.advanceTo(started + 2999)
			expect(h.last()?.state).toBe("waiting-for-signal")
			expect(h.last()?.result?.ended).not.toBe("no-signal")
			await h.advanceTo(started + 3000)
			expect(h.last()?.state).toBe("unidentified")
			expect(h.last()?.result?.ended).toBeUndefined()
			expect(h.clock.now).toBe(started + 3000)
		} finally {
			await h.destroy()
		}
	})

	it("waitMs 1000 with no transmission ends no-signal at 1000 ms with all trials cancelled", async () => {
		const h = waitHarness({
			request: { timeoutMs: 15_000, waitUntilSignal: true, waitMs: 1000 },
			gatedAt: () => null,
			tracks: [dmrTrack()],
		})
		try {
			await h.runner.start()
			const started = h.record.startedAt ?? 0
			await h.advanceTo(started + 10)
			await h.advanceTo(started + 999)
			expect(h.last()?.state).toBe("waiting-for-signal")
			expect(h.events.some(e => e.state === "trying")).toBe(false)
			await h.advanceTo(started + 1000)
			const last = h.last()
			expect(last?.state).toBe("unidentified")
			expect(last?.result?.ended).toBe("no-signal")
			expect(last?.result?.protocol).toBeUndefined()
			expect(last?.result?.identity).toBeUndefined()
			expect(last?.result?.analog).toBeUndefined()
			expect(last?.result?.artefact).toBeUndefined()
			expect(last?.result?.confidence).toBe("activity")
			expect(last?.result?.measurements.source).toBe("spectrum")
			expect(last?.trials.every(t => t.outcome === "cancelled")).toBe(true)
			expect(h.events.some(e => e.state === "trying")).toBe(false)
			expect(h.decoders.created.size).toBe(0)
			expect(h.clock.now).toBe(started + 1000)
		} finally {
			await h.destroy()
		}
	})

	it("clamps waitMs below the minimum to IDENTIFY_WAIT_MIN_MS", async () => {
		const h = waitHarness({
			request: { timeoutMs: 15_000, waitUntilSignal: true, waitMs: 0 },
			gatedAt: () => null,
			tracks: [dmrTrack()],
		})
		try {
			await h.runner.start()
			const started = h.record.startedAt ?? 0
			await h.advanceTo(started + 10)
			await h.advanceTo(started + IDENTIFY_WAIT_MIN_MS - 1)
			expect(h.last()?.state).toBe("waiting-for-signal")
			expect(h.last()?.result?.ended).not.toBe("no-signal")
			await h.advanceTo(started + IDENTIFY_WAIT_MIN_MS)
			expect(h.last()?.state).toBe("unidentified")
			expect(h.last()?.result?.ended).toBe("no-signal")
			expect(h.clock.now).toBe(started + IDENTIFY_WAIT_MIN_MS)
		} finally {
			await h.destroy()
		}
	})

	it("clamps waitMs above the maximum to IDENTIFY_WAIT_MAX_MS", async () => {
		const h = waitHarness({
			request: {
				timeoutMs: 2000,
				waitUntilSignal: true,
				waitMs: IDENTIFY_WAIT_MAX_MS,
			},
			gatedAt: () => null,
		})
		const past = waitHarness({
			request: {
				timeoutMs: 2000,
				waitUntilSignal: true,
				waitMs: IDENTIFY_WAIT_MAX_MS + 60_000,
			},
			gatedAt: () => null,
		})
		try {
			await h.runner.start()
			const started = h.record.startedAt ?? 0
			await h.advanceTo(started + 10)
			await h.advanceTo(started + IDENTIFY_WAIT_MAX_MS - 1)
			expect(h.last()?.state).toBe("waiting-for-signal")
			expect(h.last()?.result?.ended).not.toBe("no-signal")
			await h.advanceTo(started + IDENTIFY_WAIT_MAX_MS)
			expect(h.last()?.state).toBe("unidentified")
			expect(h.last()?.result?.ended).toBe("no-signal")
			expect(h.clock.now).toBe(started + IDENTIFY_WAIT_MAX_MS)

			await past.runner.start()
			const began = past.record.startedAt ?? 0
			await past.advanceTo(began + 10)
			await past.advanceTo(began + IDENTIFY_WAIT_MAX_MS - 1)
			expect(past.last()?.state).toBe("waiting-for-signal")
			expect(past.last()?.result?.ended).not.toBe("no-signal")
			await past.advanceTo(began + IDENTIFY_WAIT_MAX_MS)
			expect(past.last()?.state).toBe("unidentified")
			expect(past.last()?.result?.ended).toBe("no-signal")
			expect(past.clock.now).toBe(began + IDENTIFY_WAIT_MAX_MS)
		} finally {
			await h.destroy()
			await past.destroy()
		}
	})

	it("omitted waitMs ends no-signal at IDENTIFY_WAIT_DEFAULT_MS", async () => {
		const h = waitHarness({
			request: { waitUntilSignal: true, timeoutMs: 2000 },
			gatedAt: () => null,
			tracks: [dmrTrack()],
		})
		try {
			await h.runner.start()
			const started = h.record.startedAt ?? 0
			await h.advanceTo(started + 10)
			await h.advanceTo(started + IDENTIFY_WAIT_DEFAULT_MS - 1)
			expect(h.last()?.state).toBe("waiting-for-signal")
			expect(h.last()?.result?.ended).not.toBe("no-signal")
			expect(h.decoders.created.size).toBe(0)
			await h.advanceTo(started + IDENTIFY_WAIT_DEFAULT_MS)
			expect(h.last()?.state).toBe("unidentified")
			expect(h.last()?.result?.ended).toBe("no-signal")
			expect(h.clock.now).toBe(started + IDENTIFY_WAIT_DEFAULT_MS)
			expect(h.events.some(e => e.state === "trying")).toBe(false)
		} finally {
			await h.destroy()
		}
	})

	it("No miss is recorded on no-signal", async () => {
		const mem = new FakeMemory(
			new Map([["d_1", { protocol: "dmr", confidence: "decoded" }]]),
		)
		const discovery = {
			id: "d_1",
			protocol: "dmr",
			confidence: "decoded",
		} as Discovery
		const h = waitHarness({
			request: {
				timeoutMs: 15_000,
				waitUntilSignal: true,
				waitMs: 1000,
				protocols: ["dmr"],
			},
			gatedAt: () => null,
			tracks: [dmrTrack()],
			knownProtocols: mem,
			discoveryOf: () => discovery,
		})
		try {
			await h.runner.start()
			const started = h.record.startedAt ?? 0
			await h.advanceTo(started + 10)
			await h.advanceTo(started + 1000)
			expect(h.last()?.result?.ended).toBe("no-signal")
			expect(h.last()?.state).toBe("unidentified")
			expect(mem.calls.filter(c => c.startsWith("miss:"))).toEqual([])
			expect(h.decoders.created.size).toBe(0)
			expect(h.events.some(e => e.state === "trying")).toBe(false)
		} finally {
			await h.destroy()
		}
	})

	it("Without waitUntilSignal: deep-equal to the base identify transcript", async () => {
		const transcript = async (
			kind: "base" | "gate-ignored" | "flag-without-gate",
		): Promise<ScannerIdentifyEventData[]> => {
			const h = waitHarness({
				request: {
					protocols: ["dmr"],
					timeoutMs: 3000,
					...(kind === "flag-without-gate" ? { waitUntilSignal: true } : {}),
				},
				...(kind === "gate-ignored"
					? {
							gatedAt: () => ({ startSample: 1, atMs: 0 }),
						}
					: {}),
			})
			try {
				await h.runner.start()
				h.tracks.push(dmrTrack())
				await h.advance(100)
				await h.advance(100)
				await flushAsync()
				return structuredClone(h.events)
			} finally {
				await h.destroy()
			}
		}
		const base = await transcript("base")
		const gateIgnored = await transcript("gate-ignored")
		const flagWithoutGate = await transcript("flag-without-gate")
		expect(base.some(e => e.trials.some(t => t.outcome === "running"))).toBe(
			true,
		)
		expect(canon(base)).toEqual(golden.dmr)
		expect(canon(gateIgnored)).toEqual(golden.dmr)
		expect(canon(flagWithoutGate)).toEqual(golden.dmr)

		const quiet = async (
			kind: "base" | "gate-ignored" | "flag-without-gate",
		): Promise<ScannerIdentifyEventData[]> => {
			const h = waitHarness({
				request: {
					timeoutMs: 3000,
					...(kind === "flag-without-gate" ? { waitUntilSignal: true } : {}),
				},
				...(kind === "gate-ignored"
					? { gatedAt: () => ({ startSample: 1, atMs: 0 }) }
					: {}),
			})
			try {
				await h.runner.start()
				const started = h.record.startedAt ?? 0
				await h.advanceTo(started + 1000)
				await h.advanceTo(started + 2000)
				await h.advanceTo(started + 3000)
				await h.advanceTo(started + 3100)
				return structuredClone(h.events)
			} finally {
				await h.destroy()
			}
		}
		const quietBase = await quiet("base")
		expect(quietBase.at(-1)?.state).toBe("unidentified")
		expect(quietBase.at(-1)?.result?.ended).toBeUndefined()
		expect(canon(quietBase)).toEqual(golden.quiet)
		expect(canon(await quiet("gate-ignored"))).toEqual(golden.quiet)
		expect(canon(await quiet("flag-without-gate"))).toEqual(golden.quiet)
	})

	it("A window move during the wait ends window-moved", async () => {
		const h = waitHarness({
			request: { timeoutMs: 15_000, waitUntilSignal: true, waitMs: 1000 },
			gatedAt: () => null,
			tracks: [dmrTrack()],
		})
		try {
			await h.runner.start()
			const started = h.record.startedAt ?? 0
			await h.advanceTo(started + 10)
			expect(h.last()?.state).toBe("waiting-for-signal")
			h.engine.setEpoch(2, 447_500_000)
			await h.advanceTo(started + 1000)
			expect(h.last()?.result?.ended).toBe("window-moved")
			expect(h.last()?.trials.every(t => t.outcome === "cancelled")).toBe(true)
			expect(h.events.some(e => e.result?.ended === "no-signal")).toBe(false)
			expect(h.decoders.created.size).toBe(0)
		} finally {
			await h.destroy()
		}
	})

	it("Lookups per tick ≤ open tracks (≤ 256)", async () => {
		const openTracks = 300
		const tracks = Array.from({ length: openTracks }, (_, i) =>
			viewOf(
				trackOf({
					trackId: `t${i}`,
					centreHz: TARGET_HZ,
					blocks: 20,
				}),
				null,
			),
		)
		let calls = 0
		const h = waitHarness({
			request: { waitUntilSignal: true, waitMs: 5000, timeoutMs: 2000 },
			tracks,
			gatedAt: () => {
				calls += 1
				return null
			},
		})
		try {
			await h.runner.start()
			const started = h.record.startedAt ?? 0
			calls = 0
			await h.advanceTo(started + 10)
			expect(calls).toBe(0)
			for (let i = 0; i < 4; i++) {
				calls = 0
				await h.advanceTo(started + 20 + i * 10)
				expect(calls).toBeGreaterThanOrEqual(1)
				expect(calls).toBeLessThanOrEqual(Math.min(openTracks, 256))
			}
		} finally {
			await h.destroy()
		}
	})

	it("a throwing gatedAt ends no-signal and logs only the error type", async () => {
		const log = captureLogger()
		const secret = `SECRET frequency ${TARGET_HZ}`
		const h = waitHarness({
			request: { waitUntilSignal: true, waitMs: 1000, timeoutMs: 2000 },
			logger: log.logger,
			tracks: [dmrTrack()],
			gatedAt: () => {
				throw new Error(secret)
			},
		})
		try {
			await h.runner.start()
			const started = h.record.startedAt ?? 0
			await h.advanceTo(started + 10)
			await h.advanceTo(started + 400)
			expect(h.last()?.state).toBe("waiting-for-signal")
			await h.advanceTo(started + 1000)
			expect(h.last()?.state).toBe("unidentified")
			expect(h.last()?.result?.ended).toBe("no-signal")
			expect(h.decoders.created.size).toBe(0)
			const text = log.text()
			expect(text).toContain("Gated transmission lookup failed")
			expect(text).toContain('"type":"Error"')
			expect(text.match(/Gated transmission lookup failed/g)?.length).toBe(1)
			expect(text).not.toContain("SECRET")
			expect(text).not.toContain(String(TARGET_HZ))
			expect(text).not.toContain(secret)
		} finally {
			await h.destroy()
		}
	})

	it("a malformed gatedAt ends no-signal without logging the value", async () => {
		const log = captureLogger()
		const h = waitHarness({
			request: { waitUntilSignal: true, waitMs: 1000, timeoutMs: 5000 },
			logger: log.logger,
			gatedAt: (() => ({
				startSample: "nope",
				atMs: Number.NaN,
			})) as unknown as GateFn,
		})
		try {
			await h.runner.start()
			const started = h.record.startedAt ?? 0
			await h.advanceTo(started + 10)
			await h.advanceTo(started + 1000)
			expect(h.last()?.result?.ended).toBe("no-signal")
			expect(h.last()?.state).toBe("unidentified")
			expect(log.text()).not.toContain("nope")
			expect(log.text()).not.toContain("NaN")
		} finally {
			await h.destroy()
		}
	})

	it("a settled track's probe trials end at the gated deadline", async () => {
		const cell = { at: Number.POSITIVE_INFINITY, now: () => 0 }
		const h = waitHarness({
			request: {
				protocols: ["dmr"],
				timeoutMs: 1000,
				waitUntilSignal: true,
				waitMs: 20_000,
			},
			tracks: [dmrTrack()],
			gatedAt: () =>
				cell.now() >= cell.at ? { startSample: 8, atMs: cell.at } : null,
		})
		cell.now = () => h.clock.now
		try {
			await h.runner.start()
			const started = h.record.startedAt ?? 0
			cell.at = started + 200
			await h.advanceTo(started + 10)
			await h.advanceTo(started + 199)
			expect(h.last()?.state).toBe("waiting-for-signal")
			expect(h.decoders.created.size).toBe(0)
			await h.advanceTo(started + 200)
			expect(h.decoders.created.size).toBeGreaterThan(0)
			expect(h.last()?.state).toBe("trying")
			await h.advanceTo(started + 1199)
			expect(h.last()?.state).toBe("trying")
			expect(
				h
					.last()
					?.trials.some(
						t => t.outcome === "running" || t.outcome === "pending",
					),
			).toBe(true)
			await h.advanceTo(started + 1200)
			const last = h.last()
			expect(
				last?.state === "trying" || last?.state === "waiting-for-signal",
			).toBe(false)
			expect(
				last?.trials.some(
					t => t.outcome === "running" || t.outcome === "pending",
				),
			).toBe(false)
			expect(h.clock.now).toBe(started + 1200)
			expect(h.pool.status().filter(p => p.state !== "stopping")).toEqual([])
		} finally {
			await h.destroy()
		}
	})

	it("a gated deadline that cuts a known DMR hold short records no miss", async () => {
		const mem = new FakeMemory(
			new Map([["d_1", { protocol: "dmr", confidence: "decoded" }]]),
		)
		const discovery = {
			id: "d_1",
			protocol: "dmr",
			confidence: "decoded",
		} as Discovery
		const cell = { at: Number.POSITIVE_INFINITY, now: () => 0 }
		const h = waitHarness({
			request: {
				protocols: ["dmr"],
				timeoutMs: 1000,
				waitUntilSignal: true,
				waitMs: 20_000,
			},
			tracks: [dmrTrack()],
			knownProtocols: mem,
			discoveryOf: () => discovery,
			gatedAt: () =>
				cell.now() >= cell.at ? { startSample: 8, atMs: cell.at } : null,
		})
		cell.now = () => h.clock.now
		try {
			await h.runner.start()
			const started = h.record.startedAt ?? 0
			cell.at = started + 200
			await h.advanceTo(started + 10)
			await h.advanceTo(started + 199)
			expect(h.last()?.state).toBe("waiting-for-signal")
			expect(h.decoders.created.size).toBe(0)
			await h.advanceTo(started + 200)
			expect(h.decoders.created.size).toBeGreaterThan(0)
			expect(h.last()?.state).toBe("trying")
			await h.advanceTo(started + 1200)
			expect(mem.calls.filter(c => c.startsWith("miss:"))).toEqual([])
			expect(h.last()?.trials.find(t => t.protocol === "dmr")?.outcome).toBe(
				"cancelled",
			)
			expect(h.last()?.state).not.toBe("trying")
			expect(h.last()?.state).not.toBe("waiting-for-signal")
		} finally {
			await h.destroy()
		}
	})

	it("accepts a transmission already open when the job started and times out from the job start", async () => {
		const cell = { started: 0 }
		const h = waitHarness({
			request: {
				protocols: ["dmr"],
				timeoutMs: 1000,
				waitUntilSignal: true,
				waitMs: 20_000,
			},
			tracks: [dmrTrack()],
			gatedAt: () => ({ startSample: 3, atMs: cell.started - 5000 }),
		})
		try {
			await h.runner.start()
			cell.started = h.record.startedAt ?? 0
			await h.advanceTo(cell.started + 10)
			await h.advanceTo(cell.started + 50)
			expect(h.decoders.created.size).toBeGreaterThan(0)
			expect(h.last()?.state).toBe("trying")
			await h.advanceTo(cell.started + 999)
			expect(h.last()?.state).toBe("trying")
			expect(
				h.last()?.trials.find(t => t.protocol === "dmr")?.outcome,
			).not.toBe("cancelled")
			await h.advanceTo(cell.started + 1000)
			expect(h.last()?.trials.find(t => t.protocol === "dmr")?.outcome).toBe(
				"cancelled",
			)
			expect(h.last()?.state).not.toBe("trying")
			expect(h.last()?.state).not.toBe("waiting-for-signal")
			expect(h.clock.now).toBe(cell.started + 1000)
		} finally {
			await h.destroy()
		}
	})

	it("rejects a gate timestamp after now", async () => {
		const cell = { started: 0 }
		const h = waitHarness({
			request: {
				protocols: ["dmr"],
				timeoutMs: 1000,
				waitUntilSignal: true,
				waitMs: 8000,
			},
			tracks: [dmrTrack()],
			gatedAt: () => ({ startSample: 4, atMs: cell.started + 5000 }),
		})
		try {
			await h.runner.start()
			cell.started = h.record.startedAt ?? 0
			await h.advanceTo(cell.started + 10)
			await h.advanceTo(cell.started + 1000)
			expect(h.last()?.state).toBe("waiting-for-signal")
			expect(h.decoders.created.size).toBe(0)
			await h.advanceTo(cell.started + 4999)
			expect(h.last()?.state).toBe("waiting-for-signal")
			expect(h.decoders.created.size).toBe(0)
			await h.advanceTo(cell.started + 5000)
			expect(h.decoders.created.size).toBeGreaterThan(0)
			expect(h.last()?.state).toBe("trying")
		} finally {
			await h.destroy()
		}
	})

	it("a promised gate and a negative start sample are not a transmission", async () => {
		let mode: "promise" | "negative" = "promise"
		const h = waitHarness({
			request: { waitUntilSignal: true, waitMs: 1000, timeoutMs: 5000 },
			gatedAt: (() => {
				if (mode === "promise")
					return Promise.resolve({ startSample: 5, atMs: 0 })
				return { startSample: -5, atMs: 0 }
			}) as unknown as GateFn,
		})
		try {
			await h.runner.start()
			const started = h.record.startedAt ?? 0
			await h.advanceTo(started + 10)
			await h.advanceTo(started + 1000)
			expect(h.last()?.result?.ended).toBe("no-signal")
			mode = "negative"
			const again = waitHarness({
				request: { waitUntilSignal: true, waitMs: 1000, timeoutMs: 5000 },
				gatedAt: () => ({ startSample: -3, atMs: started }),
			})
			try {
				await again.runner.start()
				const began = again.record.startedAt ?? 0
				await again.advanceTo(began + 10)
				await again.advanceTo(began + 1000)
				expect(again.last()?.result?.ended).toBe("no-signal")
				expect(again.last()?.state).toBe("unidentified")
			} finally {
				await again.destroy()
			}
		} finally {
			await h.destroy()
		}
	})
})

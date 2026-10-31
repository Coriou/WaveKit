import { EventEmitter } from "node:events"
import { mkdtempSync, rmSync } from "node:fs"
import { PassThrough, Writable } from "node:stream"
import pino from "pino"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	ChannelizerConfigSchema,
	type SourceCaps,
} from "../../../../src/config.js"
import { ChannelizerManager } from "../../../../src/core/channelizer/channelizer-manager.js"
import type {
	ChannelizerProcessLike,
	ChannelizerProcessOptions,
} from "../../../../src/core/channelizer/channelizer-process.js"
import type {
	ChannelizerEvent,
	ChannelizerRequest,
} from "../../../../src/core/channelizer/protocol.js"
import type { DecoderChannelRequest } from "../../../../src/core/channelizer/types.js"
import { FanoutManager } from "../../../../src/core/fanout-manager.js"
import { createBurstAbsorber } from "../../../../src/core/link-burst/absorber.js"
import { channelizerBranchId } from "../../../../src/decoders/enablement/contract.js"

/**
 * A busy band (requirement R1): activity slots add, remove and retarget channels every few seconds while
 * other consumers share the source fanout. Channel changes are control messages to the running process;
 * they never respawn it, never remove its fanout branch, and never disturb a snapshot or raw-branch consumer.
 */
const logger = pino({ level: "silent" })
const SOURCE = "rtl"
const RATE = 2_048_000
const CENTER = 868e6
// 10 ms of CU8 at 2.048 Msps: 2 048 000 × 2 B × 0.010 s = 40 960 B per source chunk.
const CHUNK_MS = 10
const CHUNK_BYTES = (RATE * 2 * CHUNK_MS) / 1000
// A slow `closed` reply: past the manager's 250 ms close budget, as on a loaded host.
const SLOW_CLOSE_MS = 400
const REPLY_MS = 5
const CHANGES = 50

const caps: SourceCaps = {
	kind: "iq",
	format: "U8_IQ",
	sampleRate: RATE,
	centerFreq: CENTER,
	exclusive: false,
}
const channel = (centerHz: number): DecoderChannelRequest => ({
	centerHz,
	bandwidthHz: 12_500,
	transitionHz: 2_500,
	outputRateHz: 48_000,
	format: "cu8",
})

/** runtime.rs PROGRESS_EVERY. */
const PROGRESS_EVERY_MS = 100

/**
 * Answers like wavekit-chan between blocks and consumes its input continuously (a live, busy process). It reports
 * `progress` after more input, at most every 100 ms, like the runtime's main loop.
 */
class BusyProcess extends EventEmitter implements ChannelizerProcessLike {
	consumed = 0
	closes = 0
	progressLines = 0
	private lastProgress = -Infinity
	readonly input = new Writable({
		write: (chunk: Buffer, _enc, done) => {
			this.consumed += chunk.length
			const now = Date.now()
			if (now - this.lastProgress >= PROGRESS_EVERY_MS) {
				this.progressLines++
				this.lastProgress = now
				this.event({
					v: 1,
					type: "progress",
					generation: this.generation,
					inputSamples: Math.floor(this.consumed / 2),
				})
			}
			done()
		},
	})
	constructor(readonly generation: number) {
		super()
	}
	start(): Promise<void> {
		this.event({ v: 1, type: "ready", generation: this.generation, pid: 7 })
		return Promise.resolve()
	}
	stop(): Promise<void> {
		this.input.destroy()
		this.emit("exit", 0, null)
		return Promise.resolve()
	}
	event(e: ChannelizerEvent) {
		this.emit("event", e)
	}
	send(r: ChannelizerRequest) {
		const generation = this.generation
		if (r.type === "open")
			setTimeout(
				() =>
					this.event({
						v: 1,
						type: "opened",
						generation,
						id: r.id,
						socket: `/tmp/${r.id}.sock`,
						outputRateHz: r.outputRateHz,
						format: r.format,
						filterTaps: 63,
						groupDelaySamples: 31,
					}),
				REPLY_MS,
			)
		else if (r.type === "retune")
			setTimeout(
				() =>
					this.event({
						v: 1,
						type: "retuned",
						generation,
						channelId: r.channelId,
						centerHz: r.centerHz,
					}),
				REPLY_MS,
			)
		else if (r.type === "close") {
			setTimeout(
				() => {
					this.event({
						v: 1,
						type: "closed",
						generation,
						id: r.id,
						reason: "requested",
					})
				},
				// Every other close is slow.
				this.closes++ % 2 === 0 ? SLOW_CLOSE_MS : REPLY_MS,
			)
		}
	}
}

/** A flowing consumer: arrival times (fake clock) and bytes. */
function consume(stream: PassThrough) {
	const c = { bytes: 0, maxGapMs: 0, first: -1, last: -1, ended: false }
	stream.on("data", (chunk: Buffer) => {
		const now = Date.now()
		if (c.first < 0) c.first = now
		else c.maxGapMs = Math.max(c.maxGapMs, now - c.last)
		c.last = now
		c.bytes += chunk.length
	})
	stream.on("close", () => {
		c.ended = true
	})
	return c
}

const flushImmediates = () => new Promise<void>(done => setImmediate(done))
let dir: string
beforeEach(() => {
	dir = mkdtempSync("/tmp/wkcc-")
	vi.useFakeTimers({
		toFake: [
			"setTimeout",
			"clearTimeout",
			"setInterval",
			"clearInterval",
			"Date",
		],
	})
})
afterEach(() => {
	vi.useRealTimers()
	rmSync(dir, { recursive: true, force: true })
})

async function churn() {
	const sources = Object.assign(new EventEmitter(), { getCaps: () => caps })
	const fanout = new FanoutManager(logger)
	fanout.setByteRate(RATE * 2)
	// The live source is a network rtl_tcp link, so input goes through the burst absorber (1 s capacity).
	const absorber = createBurstAbsorber({
		fanout,
		recorder: null,
		monoNow: () => Date.now(),
		frameBytes: 2,
		log: logger,
	})
	absorber.configure(RATE * 2)
	const branchId = channelizerBranchId(SOURCE)
	const branchEvents = { added: 0, removed: 0, otherRemoved: 0 }
	fanout.on("branch-added", (id: string) => {
		if (id === branchId) branchEvents.added++
	})
	fanout.on("branch-removed", (id: string) => {
		if (id === branchId) branchEvents.removed++
		else branchEvents.otherRemoved++
	})
	const processes: BusyProcess[] = []
	const m = new ChannelizerManager({
		sourceManager: sources as never,
		routing: { getFanout: () => fanout, releaseUnused: () => {} },
		config: ChannelizerConfigSchema.parse({ enabled: true, socketDir: dir }),
		logger,
		// Auto composition (the live default) lingers 60 s on zero channels.
		idleStopMs: 60_000,
		openNow: Date.now,
		connect: () => Promise.resolve(new PassThrough()),
		createProcess: (o: ChannelizerProcessOptions) => {
			const p = new BusyProcess(o.generation)
			processes.push(p)
			return p
		},
	})
	const invalidations: unknown[][] = []
	m.on("channel-invalidated", (...args: unknown[]) => invalidations.push(args))

	const snapshot = consume(
		fanout.addBranch({
			id: "iq-snapshot:churn",
			sourceId: SOURCE,
			highWaterMark: 1,
		}),
	)
	const raw = consume(fanout.addBranch({ id: "rtl433", sourceId: SOURCE }))
	let ingested = 0
	const feed = setInterval(() => {
		const chunk = Buffer.alloc(CHUNK_BYTES, ingested & 0xff)
		ingested += chunk.length
		absorber.ingest(chunk)
	}, CHUNK_MS)

	const settle = async (ms: number) => {
		await vi.advanceTimersByTimeAsync(ms)
		await flushImmediates()
	}
	const acquire = async (decoderId: string, hz: number) => {
		const pending = m.requestChannel(SOURCE, decoderId, channel(hz), caps)
		await settle(REPLY_MS * 2)
		const result = await pending
		if (!result.ok) throw new Error(`grant ${decoderId}: ${result.detail}`)
		return result
	}
	const release = async (channelId: string) => {
		const pending = m.releaseChannel(channelId)
		await settle(SLOW_CLOSE_MS + REPLY_MS)
		await pending
	}

	// Two long-lived channel decoders: any teardown of the generation would invalidate them.
	const steady = [
		await acquire("dsd-fme", CENTER),
		await acquire("multimon-ng", CENTER + 200_000),
	]
	const slots = new Map<string, { channelId: string; hz: number }>()
	const firstByteMs: number[] = []
	const counts = { add: 0, remove: 0, retune: 0, reopen: 0 }
	for (let i = 0; i < CHANGES; i++) {
		const hz = CENTER - 600_000 + ((i * 37) % 24) * 50_000
		const slot = `dsd-fme-slot-${i % 3}`
		const held = slots.get(slot)
		const op = !held ? "add" : (["retune", "reopen", "remove"] as const)[i % 3]!
		if (op === "add") {
			const grant = await acquire(slot, hz)
			slots.set(slot, { channelId: grant.channelId, hz })
		} else if (op === "retune" && held) {
			const verdict = m
				.retuneChannel(SOURCE, held.channelId, hz)
				.catch(() => "lost" as const)
			await settle(REPLY_MS * 2)
			if ((await verdict) === "retuned") held.hz = hz
			else {
				// The grant died with its generation: reacquire, as the decoder manager would.
				const grant = await acquire(slot, hz)
				slots.set(slot, { channelId: grant.channelId, hz })
			}
		} else if (op === "reopen" && held) {
			// Retarget as close + open, the decoder manager's path when in-place retune is not taken.
			await release(held.channelId)
			const grant = await acquire(slot, hz)
			slots.set(slot, { channelId: grant.channelId, hz })
		} else if (held) {
			await release(held.channelId)
			slots.delete(slot)
		}
		counts[op]++
		if (i % 10 === 5) {
			// A fresh snapshot request during the churn: time to its first byte.
			const id = `iq-snapshot:${i}`
			const opened = Date.now()
			const s = consume(
				fanout.addBranch({ id, sourceId: SOURCE, highWaterMark: 1 }),
			)
			await settle(CHUNK_MS * 3)
			firstByteMs.push(s.first < 0 ? Infinity : s.first - opened)
			fanout.removeBranch(id)
		}
		await settle(100)
	}
	clearInterval(feed)
	const telemetry = (id: string) => fanout.getBranchTelemetry(id)
	const result = {
		counts,
		spawns: processes.length,
		branchAdded: branchEvents.added,
		branchRemoved: branchEvents.removed,
		otherBranchesRemoved: branchEvents.otherRemoved - firstByteMs.length,
		invalidations: invalidations.length,
		steadyAlive: steady.every(g => !g.stream.destroyed),
		snapshot: {
			ended: snapshot.ended,
			maxGapMs: snapshot.maxGapMs,
			dropped: telemetry("iq-snapshot:churn")?.droppedBytesTotal,
		},
		raw: {
			ended: raw.ended,
			maxGapMs: raw.maxGapMs,
			dropped: telemetry("rtl433")?.droppedBytesTotal,
		},
		channelizerDropped: telemetry(branchId)?.droppedBytesTotal,
		maxSnapshotFirstByteMs: Math.max(...firstByteMs),
		bytes: { ingested, snapshot: snapshot.bytes, raw: raw.bytes },
	}
	await m.destroy()
	absorber.dispose()
	fanout.destroy()
	return { result, processes }
}

describe("channel churn at a busy band", () => {
	it("50 adds, removes and retargets never respawn the process or re-create its branch", async () => {
		const { result, processes } = await churn()
		expect(
			result.counts.add +
				result.counts.remove +
				result.counts.retune +
				result.counts.reopen,
		).toBe(CHANGES)
		expect(result.counts.remove).toBeGreaterThan(0)
		expect(result.counts.retune).toBeGreaterThan(0)
		expect(result.counts.reopen).toBeGreaterThan(0)
		expect({
			spawns: result.spawns,
			branchAdded: result.branchAdded,
			branchRemoved: result.branchRemoved,
			invalidations: result.invalidations,
			steadyAlive: result.steadyAlive,
		}).toEqual({
			spawns: 1,
			branchAdded: 1,
			branchRemoved: 0,
			invalidations: 0,
			steadyAlive: true,
		})
		// The one process consumed its input throughout: nothing dropped on its branch.
		expect(result.channelizerDropped).toBe(0)
		expect(processes[0]!.consumed).toBeGreaterThan(0)
	})

	it("a snapshot consumer and a raw-branch consumer see continuous data through the churn", async () => {
		const { result } = await churn()
		for (const consumer of [result.snapshot, result.raw])
			expect(consumer).toEqual({ ended: false, maxGapMs: CHUNK_MS, dropped: 0 })
		expect(result.otherBranchesRemoved).toBe(0)
		// Both attached before the first chunk, so each received every byte ingested.
		expect(result.bytes.snapshot).toBe(result.bytes.ingested)
		expect(result.bytes.raw).toBe(result.bytes.ingested)
		// A snapshot started mid-churn gets its first byte within one source chunk.
		expect(result.maxSnapshotFirstByteMs).toBeLessThanOrEqual(CHUNK_MS)
	})
})

import { PassThrough } from "node:stream"
import pino from "pino"
import { describe, expect, it, vi } from "vitest"
import type {
	SpectrumFrameEventData,
	SpectrumProfileEventData,
} from "@wavekit/api-types"
import type { SourceConfig } from "../../../../src/config.js"
import {
	SpectrumService,
	accumulateHold,
	decodeBins,
	encodeBins,
	nearestProfile,
	normaliseProfile,
	reduceMaxHold,
	summariesPerFrame,
	type SpectrumPersistence,
	type SpectrumProfile,
} from "../../../../src/core/spectrum/spectrum-service.js"
import { DEFAULT_TUNING } from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../../src/core/spectrum/pipeline-host.js"
import type { OccupancyState } from "../../../../src/core/spectrum/occupancy.js"
import type {
	BlockSummary,
	EngineState,
	PipelineConfig,
	PipelineEvent,
	PipelineInput,
} from "../../../../src/core/spectrum/types.js"
import type { ScannerSettings } from "../../../../src/core/scanner/types.js"
import {
	FakeFanout,
	FakeSources,
	FakeTuner,
	settle,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"
import {
	CENTRE,
	FS,
	feedTone,
	serviceHarness,
	tick,
} from "../../../mocks/scanner/service-fakes.js"

import { WaveKitError } from "../../../../src/utils/errors.js"

const AIR_CENTRE = 131_725_000

function gate(): { promise: Promise<void>; open(): void } {
	let open!: () => void
	const promise = new Promise<void>(resolve => (open = resolve))
	return { promise, open }
}

function memoryPersistence() {
	const engines = new Map<string, EngineState>()
	const occupancy = new Map<string, OccupancyState>()
	/** loadEngine(id) waits for this gate: holds an acquire in flight. */
	const engineGates = new Map<string, Promise<void>>()
	const loads: string[] = []
	const persistence: SpectrumPersistence = {
		writeEngine: (id, s) => (engines.set(id, s), Promise.resolve()),
		loadEngine: async id => {
			loads.push(id)
			await engineGates.get(id)
			return engines.get(id) ?? null
		},
		writeOccupancy: (id, s) => (occupancy.set(id, s), Promise.resolve()),
		loadOccupancy: id => Promise.resolve(occupancy.get(id) ?? null),
	}
	return { persistence, engines, occupancy, engineGates, loads }
}

/** Test host: records inputs, emits what the test tells it, and can hold close() open. */
class FakeHost implements PipelineHost {
	readonly inputs: PipelineInput[] = []
	closeGate: Promise<void> | null = null
	constructor(
		readonly cfg: PipelineConfig,
		readonly handlers: PipelineHostHandlers,
	) {}
	send(input: PipelineInput, transfer?: ArrayBuffer): void {
		this.inputs.push(input)
		if (transfer) this.handlers.buffer(transfer)
	}
	exportState(): Promise<EngineState> {
		return Promise.resolve({
			version: 1,
			absoluteFloors: [],
			spurs: [],
			kByRange: [],
		})
	}
	async close(): Promise<void> {
		await this.closeGate
	}
	utilization(): number | null {
		return null
	}
	emit(...events: PipelineEvent[]): void {
		this.handlers.events(events)
	}
	/** Starts `epoch`; `first` is the stream's own start (settleMode "none"). */
	epoch(epoch: number, first = false): void {
		this.emit({
			kind: "epoch-started",
			epoch,
			startSample: 0,
			settleMode: first ? "none" : "timer",
		})
	}
	summaries(epoch: number, count = 1, peakBin = 100): void {
		for (let i = 0; i < count; i++)
			this.emit({
				kind: "block-summary",
				summary: blockSummary(this.cfg, epoch, peakBin),
			})
	}
}

/** A native-resolution summary of the usable span (≈ 0.8 · fftSize bins, d = 1). */
function blockSummary(
	cfg: PipelineConfig,
	epoch: number,
	peakBin: number,
): BlockSummary {
	const usable = Math.floor(cfg.fftSize * 0.8)
	const centre = cfg.sourceId === "air" ? AIR_CENTRE : CENTRE
	const binHz = cfg.sampleRateHz / cfg.fftSize
	return {
		sourceId: cfg.sourceId,
		stream: 0,
		epoch,
		endSample: 0,
		centreHz: centre,
		sampleRateHz: cfg.sampleRateHz,
		binHz,
		startHz: centre - (usable / 2) * binHz,
		bins: Array.from({ length: usable }, (_, i) =>
			i === peakBin ? -20 - epoch : -80,
		),
		floorDbfs: -80,
		thresholdDb: 10,
		tracks: [],
		masks: { dcHz: centre, dcGuardHz: 1500, spurRanges: [] },
		floorOccupied: false,
		overload: false,
	}
}

interface LoggedProfile {
	kind: "profile"
	clientId: string
	ack: SpectrumProfileEventData
	snapshots: SpectrumFrameEventData[]
}

type Logged =
	| LoggedProfile
	| { kind: "frame"; frame: SpectrumFrameEventData; clientIds: string[] }
	| { kind: "stream"; sourceId: string; stream: number; reason: string }
	| { kind: "released"; sourceId: string; consumer: string }

type Seen =
	| { type: "ack"; ack: SpectrumProfileEventData }
	| { type: "snapshot"; frame: SpectrumFrameEventData }
	| { type: "frame"; frame: SpectrumFrameEventData }

function make(
	opts: {
		patch?: (s: ScannerSettings) => void
		fake?: boolean
		fs?: number
	} = {},
) {
	const fs = opts.fs ?? FS
	const sources = new FakeSources("rtl", { sampleRate: fs, centerFreq: CENTRE })
	sources.caps.set("air", {
		...sources.getCaps("rtl")!,
		centerFreq: AIR_CENTRE,
	})
	sources.streams.set("air", new PassThrough())
	sources.caps.set("aud", {
		kind: "audio_pcm",
		format: "S16LE",
		sampleRate: 48_000,
		exclusive: false,
	})
	const tuner = new FakeTuner()
	tuner.states.set("air", {
		...tuner.states.get("rtl")!,
		sourceId: "air",
		frequency: AIR_CENTRE,
	})
	const fanouts = new Map([
		["rtl", new FakeFanout()],
		["air", new FakeFanout()],
	])
	const mem = memoryPersistence()
	const settings = testSettings(opts.patch)
	const hosts: FakeHost[] = []
	let now = 0
	const service = new SpectrumService({
		sources: sources as never,
		routing: {
			getFanout: (id: string) => fanouts.get(id)!,
			releaseUnused: () => undefined,
		} as never,
		tuner: tuner as never,
		sourceConfigs: ["rtl", "air", "aud"].map(
			id =>
				({
					id,
					type: "rtl_tcp",
					host: "127.0.0.1",
					port: 1234,
					loop: false,
					playbackSpeed: 1,
					caps: sources.getCaps(id)!,
				}) as SourceConfig,
		),
		settings: () => settings,
		tuning: () => DEFAULT_TUNING,
		persistence: mem.persistence,
		logger: pino({ level: "silent" }),
		now: () => (now += 25),
		engineHost: "inline",
		...(opts.fake
			? {
					createHost: (cfg: PipelineConfig, handlers: PipelineHostHandlers) => {
						const host = new FakeHost(cfg, handlers)
						hosts.push(host)
						return host
					},
				}
			: {}),
	})
	const log: Logged[] = []
	service.on(
		"profile",
		(
			clientId: string,
			ack: SpectrumProfileEventData,
			snapshots: SpectrumFrameEventData[],
		) => log.push({ kind: "profile", clientId, ack, snapshots }),
	)
	service.on(
		"frame",
		(frame: SpectrumFrameEventData, clientIds: readonly string[]) =>
			log.push({ kind: "frame", frame, clientIds: [...clientIds] }),
	)
	service.on("stream", (sourceId: string, stream: number, reason: string) =>
		log.push({ kind: "stream", sourceId, stream, reason }),
	)
	service.on("released", (sourceId: string, consumer: string) =>
		log.push({ kind: "released", sourceId, consumer }),
	)
	const hostsOf = (sourceId: string) =>
		hosts.filter(h => h.cfg.sourceId === sourceId)
	return {
		service,
		sources,
		fanouts,
		fanout: fanouts.get("rtl")!,
		mem,
		settings,
		hosts,
		hostsOf,
		host: (sourceId = "rtl") => hostsOf(sourceId).at(-1)!,
		log,
		acks: (clientId: string) =>
			log.flatMap(e =>
				e.kind === "profile" && e.clientId === clientId ? [e.ack] : [],
			),
		/** What one client receives, in order: the wiring sends an ack, its snapshots, then live frames. */
		seen: (clientId: string, from = 0): Seen[] =>
			log.slice(from).flatMap((e): Seen[] => {
				if (e.kind === "profile")
					return e.clientId === clientId
						? [
								{ type: "ack", ack: e.ack },
								...e.snapshots.map(frame => ({
									type: "snapshot" as const,
									frame,
								})),
							]
						: []
				return e.kind === "frame" && e.clientIds.includes(clientId)
					? [{ type: "frame", frame: e.frame }]
					: []
			}),
		frames: (from = 0) =>
			log
				.slice(from)
				.flatMap(e => (e.kind === "frame" ? [e] : []))
				.map(e => ({ ...e.frame, clientIds: e.clientIds })),
		serviceEvents: (from = 0) =>
			log.slice(from).filter(e => e.kind === "stream" || e.kind === "released"),
	}
}

type Made = ReturnType<typeof make>

/** Frame keys emitted for each of `count` summaries of `epoch` on the source's host. */
function keysPerSummary(
	h: Made,
	sourceId: string,
	epoch: number,
	count: number,
): string[][] {
	const out: string[][] = []
	for (let i = 0; i < count; i++) {
		const from = h.log.length
		h.host(sourceId).summaries(epoch)
		out.push(h.frames(from).map(f => f.profile))
	}
	return out
}

/** Non-default keys among one summary's frames. */
const nonDefault = (keys: string[], def: string): string[] =>
	keys.filter(k => k !== def)

describe("spectrum bin encoding", () => {
	it("round-trips dBFS in 0.5 dB steps and clamps to −127.5…0", () => {
		const dbfs = [-127.5, -100.26, -43.7, -0.2, 0, 3, -200]
		expect(decodeBins(encodeBins(dbfs))).toEqual([
			-127.5, -100.5, -43.5, 0, 0, 0, -127.5,
		])
	})

	it("reduces by max-hold to at most the profile's bins", () => {
		const bins = Array.from({ length: 2048 }, (_, i) =>
			i === 1234 ? -10 : -60,
		)
		const r = reduceMaxHold(bins, 512)
		expect(r.factor).toBe(4)
		expect(r.bins.length).toBe(512)
		expect(r.bins[Math.floor(1234 / 4)]).toBe(-10)
		expect(reduceMaxHold(bins.slice(0, 300), 512).bins.length).toBe(300)
	})

	it("starts a new max-hold when the epoch or the bin layout changes, so a frame never mixes two centres", () => {
		let hold = accumulateHold(
			undefined,
			{ bins: Float32Array.from([-60, -10, -60]), factor: 1 },
			1,
		)
		expect(hold.count).toBe(0)
		hold = accumulateHold(
			hold,
			{ bins: Float32Array.from([-40, -80, -80]), factor: 1 },
			1,
		)
		expect([...hold.bins!]).toEqual([-40, -10, -60])
		hold.count = 3
		hold = accumulateHold(
			hold,
			{ bins: Float32Array.from([-50, -70, -50]), factor: 1 },
			2,
		)
		expect(hold.epoch).toBe(2)
		expect([...hold.bins!]).toEqual([-50, -70, -50])
		// the decimation count survives the reset
		expect(hold.count).toBe(3)
		hold = accumulateHold(
			hold,
			{ bins: Float32Array.from([-30, -90]), factor: 2 },
			2,
		)
		expect([hold.factor, [...hold.bins!]]).toEqual([2, [-30, -90]])
	})
})

describe("SpectrumService", () => {
	it("runs an engine only while a consumer holds it", async () => {
		const { service, fanout } = make()
		await service.start()
		expect(service.sourceIds()).toEqual([])
		expect(fanout.branches.size).toBe(0)
		await service.subscribe("c1", undefined)
		expect(service.sourceIds().sort()).toEqual(["air", "rtl"])
		expect([...fanout.branches.keys()]).toEqual(["scanner-rtl"])
		await service.acquire("rtl", "job:a")
		await service.unsubscribe("c1")
		expect(service.sourceIds()).toEqual(["rtl"])
		await service.release("rtl", "job:a")
		expect(service.sourceIds()).toEqual([])
		expect(fanout.branches.size).toBe(0)
		await service.stop()
	})

	it("emits encoded frames at the profile rate, carrying the epoch's trust, only with subscribers", async () => {
		const { service, fanout, frames } = make({
			patch: s => {
				s.ws.spectrumHz = 4
				s.ws.spectrumBins = 256
			},
		})
		await service.start()
		let summaries = 0
		service.on("pipeline", (sourceId: string, ev: PipelineEvent) => {
			if (sourceId === "rtl" && ev.kind === "block-summary") summaries += 1
		})
		await service.acquire("rtl", "job:a")
		feedTone(fanout, 1, 93_750)
		await settle()
		expect(frames()).toEqual([])
		await service.subscribe("c1", undefined)
		summaries = 0
		feedTone(fanout, 1, 93_750)
		await settle()
		const rtl = frames().filter(f => f.sourceId === "rtl")
		// blockHz 20, hz 4: one frame per 5 summaries
		expect(summaries).toBeGreaterThanOrEqual(10)
		expect(rtl.length).toBe(Math.floor(summaries / 5))
		for (const f of rtl) {
			expect(f).toMatchObject({
				sourceId: "rtl",
				profile: "4:256",
				binEncoding: "u8-halfdb-127.5",
				nativeBinHz: 1000,
			})
			expect(f.clientIds).toEqual(["c1"])
			expect(["commanded", "unverified"]).toContain(f.tuningTrust)
			const bins = decodeBins(f.bins)
			expect(bins.length).toBe(f.binCount)
			expect(f.masks.dcHz).toBe(f.centerHz)
			expect(
				f.tracks.every(
					t =>
						typeof t.flags.burst === "boolean" &&
						typeof t.flags.iqImage === "boolean",
				),
			).toBe(true)
			expect(f.binCount).toBeLessThanOrEqual(256)
		}
		const last = rtl.at(-1)!
		const bins = decodeBins(last.bins)
		const peak = bins.indexOf(Math.max(...bins))
		expect(
			Math.abs(last.startHz + (peak + 0.5) * last.binHz - (CENTRE + 93_750)),
		).toBeLessThan(2 * last.binHz)
		await service.stop()
	})

	it("feeds the occupancy history and seeds hops from it", async () => {
		const { service, fanout } = make()
		await service.start()
		await service.acquire("rtl", "job:a")
		feedTone(fanout, 2, 93_750)
		await settle()
		const occ = service.occupancyQuery(
			"rtl",
			{ startHz: CENTRE + 50_000, endHz: CENTRE + 150_000 },
			3_600_000,
		)
		expect(occ?.buckets.some(b => b.activeMs > 0)).toBe(true)
		expect(occ?.top[0]?.startHz).toBeLessThanOrEqual(CENTRE + 93_750)
		const seed = service.activitySeed("rtl")
		expect(
			seed({ startHz: CENTRE + 80_000, endHz: CENTRE + 110_000 }),
		).toBeGreaterThan(0)
		expect(
			service.occupancyQuery("nope", { startHz: 1, endHz: 2 }, 1000),
		).toBeNull()
		await service.release("rtl", "job:a")
		await service.stop()
	})

	it("serves a subscription without options the 10 Hz × 512 default on every eligible source", async () => {
		const h = make()
		await h.service.start()
		await h.service.subscribe("c1", undefined)
		expect(h.acks("c1")).toEqual([
			{
				selection: "default",
				sourceId: null,
				profile: { key: "10:512", hz: 10, bins: 512 },
				effectiveHz: null,
				outcome: "default",
				adjusted: [],
			},
		])
		feedTone(h.fanouts.get("rtl")!, 0.5, 93_750)
		feedTone(h.fanouts.get("air")!, 0.5, -50_000)
		await settle()
		const frames = h.frames()
		for (const id of ["rtl", "air"]) {
			const own = frames.filter(f => f.sourceId === id)
			expect(own.length).toBeGreaterThan(0)
			expect(own.every(f => f.binCount <= 512 && f.profile === "10:512")).toBe(
				true,
			)
		}
		await h.service.stop()
	})

	it("builds each distinct profile once and routes frames only to its clients (CLI and web on one source)", async () => {
		const h = make({ fake: true })
		await h.service.start()
		await h.service.subscribe("c1", undefined)
		await h.service.subscribe("c2", { sourceId: "rtl", hz: 25, bins: 2048 })
		await h.service.subscribe("c3", { sourceId: "rtl", hz: 25, bins: 2048 })
		h.host("rtl").epoch(1, true)
		const from = h.log.length
		const perSummary: { profile: string; clientIds: string[] }[][] = []
		for (let i = 0; i < 4; i++) {
			const at = h.log.length
			h.host("rtl").summaries(1)
			perSummary.push(h.frames(at))
		}
		for (const group of perSummary) {
			const keys = group.map(f => f.profile)
			expect(new Set(keys).size).toBe(keys.length)
			const ids = group.flatMap(f => f.clientIds)
			expect(new Set(ids).size).toBe(ids.length)
		}
		const frames = h.frames(from)
		expect(
			frames.filter(f => f.profile === "25:2048").map(f => f.clientIds),
		).toEqual([
			["c2", "c3"],
			["c2", "c3"],
			["c2", "c3"],
			["c2", "c3"],
		])
		expect(
			frames.filter(f => f.profile === "10:512").map(f => f.clientIds),
		).toEqual([["c1"], ["c1"]])
		await h.service.stop()
	})

	it("never upsamples: a profile above the native detail reports the true bin count and width", async () => {
		const h = make()
		await h.service.start()
		await h.service.subscribe("c1", { sourceId: "rtl", bins: 2048 })
		expect(h.acks("c1")[0]).toMatchObject({
			outcome: "exact",
			profile: { key: "10:2048" },
			effectiveHz: 10,
		})
		feedTone(h.fanout, 0.5, 93_750)
		await settle()
		const frames = h.frames().filter(f => f.sourceId === "rtl")
		expect(frames.length).toBeGreaterThan(0)
		for (const f of frames) {
			expect(f.binCount).toBe(819)
			expect(f.binHz).toBe(1000)
			expect(f.nativeBinHz).toBe(1000)
		}
		await h.service.stop()
	})

	it("serves the nearest admissible profile", async () => {
		const a = make({ fake: true })
		await a.service.start()
		await a.service.subscribe("c1", { sourceId: "rtl", hz: 99, bins: 50 })
		expect(a.acks("c1")[0]).toMatchObject({
			outcome: "nearest",
			profile: { key: "25:128", hz: 25, bins: 128 },
			adjusted: ["hz", "bins"],
		})
		await a.service.stop()

		const b = make({ fake: true, patch: s => (s.ws.spectrumMaxProfiles = 2) })
		await b.service.start()
		await b.service.subscribe("c1", { sourceId: "rtl", hz: 20, bins: 1024 })
		await b.service.subscribe("c2", { sourceId: "rtl", hz: 25, bins: 128 })
		await b.service.subscribe("c3", { sourceId: "rtl", hz: 25, bins: 2048 })
		expect(b.acks("c3")[0]).toMatchObject({
			selection: "source",
			sourceId: "rtl",
			outcome: "nearest",
			profile: { key: "20:1024" },
			adjusted: ["profile-limit"],
		})
		await b.service.stop()

		const c = make({ fake: true, patch: s => (s.ws.spectrumMaxProfiles = 1) })
		await c.service.start()
		await c.service.subscribe("c1", { sourceId: "rtl", hz: 25, bins: 2048 })
		// prefer not larger: the default, not the active 25:2048
		await c.service.subscribe("c2", { sourceId: "rtl", hz: 20, bins: 1024 })
		expect(c.acks("c2")[0]).toMatchObject({
			outcome: "nearest",
			profile: { key: "10:512" },
			adjusted: ["profile-limit"],
		})
		// a request equal to the default key needs no slot
		await c.service.subscribe("c3", { sourceId: "rtl", hz: 10, bins: 512 })
		expect(c.acks("c3")[0]).toMatchObject({
			outcome: "exact",
			profile: { key: "10:512" },
			adjusted: [],
		})
		expect(c.service.allocation().reserved).toEqual(["rtl:25:2048"])
		await c.service.stop()
	})

	it("rejects unservable requests with a code and keeps the previous selection", async () => {
		const h = make({ fake: true })
		await h.service.start()
		await h.service.subscribe("c1", { sourceId: "rtl", hz: 25, bins: 2048 })
		const bad: [unknown, string][] = [
			[{ sourceId: "rtl", hz: "x" }, "SPECTRUM_OPTIONS_INVALID"],
			[{ hz: 10 }, "SPECTRUM_OPTIONS_INVALID"],
			[{ sourceId: "rtl", extra: 1 }, "SPECTRUM_OPTIONS_INVALID"],
			[{ sourceId: "nope" }, "SPECTRUM_SOURCE_NOT_FOUND"],
			[{ sourceId: "aud" }, "SPECTRUM_SOURCE_NOT_IQ"],
		]
		for (const [options] of bad) await h.service.subscribe("c1", options)
		const rejected = h.acks("c1").slice(1)
		expect(rejected.map(a => a.code)).toEqual(bad.map(([, code]) => code))
		for (const ack of rejected)
			expect(ack).toMatchObject({
				outcome: "rejected",
				selection: "source",
				sourceId: "rtl",
				profile: { key: "25:2048" },
			})
		h.host("rtl").epoch(1, true)
		const from = h.log.length
		h.host("rtl").summaries(1)
		expect(h.frames(from).map(f => [f.profile, f.clientIds])).toEqual([
			["25:2048", ["c1"]],
		])
		await h.service.stop()
	})

	it("switches make-before-break: ack, then snapshot, then live frames, while the old engine is still closing", async () => {
		const h = make({ fake: true })
		await h.service.start()
		await h.service.acquire("air", "job:b")
		h.host("air").epoch(1, true)
		h.host("air").summaries(1)
		await h.service.subscribe("c1", { sourceId: "rtl" })
		h.host("rtl").epoch(1, true)
		h.host("rtl").summaries(1, 2)
		const rtlHost = h.host("rtl")
		const closing = gate()
		rtlHost.closeGate = closing.promise
		const from = h.log.length
		const switching = h.service.subscribe("c1", {
			sourceId: "air",
			hz: 25,
			bins: 1024,
		})
		await settle()
		// the old engine is still closing: both sources emit
		h.host("air").summaries(1)
		rtlHost.summaries(1, 2)
		const seen = h.seen("c1", from)
		expect(seen.map(s => s.type)).toEqual(["ack", "snapshot", "frame"])
		expect(seen[0]).toMatchObject({
			type: "ack",
			ack: { selection: "source", sourceId: "air", outcome: "exact" },
		})
		expect(seen[1]).toMatchObject({
			type: "snapshot",
			frame: { sourceId: "air", profile: "25:1024", snapshot: true },
		})
		expect(seen[2]).toMatchObject({
			type: "frame",
			frame: { sourceId: "air", profile: "25:1024" },
		})
		closing.open()
		await switching
		expect(h.service.sourceIds()).toEqual(["air"])
		expect(h.fanout.branches.size).toBe(0)
		await h.service.stop()
	})

	it("sends a late-joining client a snapshot of its own profile and the current epoch", async () => {
		const h = make({ fake: true })
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		h.host("rtl").epoch(1, true)
		h.host("rtl").epoch(3)
		h.host("rtl").summaries(3)
		await h.service.subscribe("c2", { sourceId: "rtl", hz: 25, bins: 2048 })
		const seen = h.seen("c2")
		expect(seen.map(s => s.type)).toEqual(["ack", "snapshot"])
		expect(seen[1]).toMatchObject({
			frame: {
				profile: "25:2048",
				epoch: 3,
				tuningTrust: "commanded",
				snapshot: true,
				binCount: 819,
			},
		})
		await h.service.stop()
	})

	it("sends no snapshot across a retune boundary, and a reconnect gets the new epoch's snapshot", async () => {
		const h = make({ fake: true })
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		h.host("rtl").epoch(1, true)
		h.host("rtl").summaries(1)
		h.host("rtl").epoch(4)
		await h.service.subscribe("c1", { sourceId: "rtl" })
		expect(h.seen("c1").map(s => s.type)).toEqual(["ack"])
		h.host("rtl").summaries(4)
		await h.service.subscribe("c9", { sourceId: "rtl" })
		const seen = h.seen("c9")
		expect(seen.map(s => s.type)).toEqual(["ack", "snapshot"])
		expect(seen[1]).toMatchObject({ frame: { epoch: 4, snapshot: true } })
		await h.service.stop()
	})

	it("restarts every profile's hold at an epoch change and carries the epoch's trust", async () => {
		const h = make({ fake: true })
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		const host = h.host("rtl")
		host.epoch(1, true)
		await h.service.subscribe("c1", { sourceId: "rtl" })
		await h.service.subscribe("c2", { sourceId: "rtl", hz: 5, bins: 256 })
		host.epoch(3)
		const from = h.log.length
		host.summaries(3, 1, 100)
		host.epoch(4)
		host.summaries(4, 3, 600)
		const frames = h.frames(from)
		// 10 Hz: frames at summaries 2 and 4; 5 Hz: at summary 4. Each after the epoch-4 start.
		expect(frames.map(f => [f.profile, f.epoch])).toEqual([
			["10:512", 4],
			["10:512", 4],
			["5:256", 4],
		])
		for (const f of frames) {
			const bins = decodeBins(f.bins)
			const factor = Math.round(f.binHz / f.nativeBinHz)
			expect(bins[Math.floor(100 / factor)]).toBe(-80)
			expect(bins[Math.floor(600 / factor)]).toBe(-24)
		}
		host.emit(
			{ kind: "untracked-retune", epoch: 5, startSample: 0, deltaHz: 20_000 },
			{ kind: "epoch-started", epoch: 5, startSample: 0, settleMode: "timer" },
		)
		const at = h.log.length
		host.summaries(5, 4)
		const unverified = h.frames(at)
		expect(unverified.length).toBe(3)
		expect(unverified.every(f => f.tuningTrust === "unverified")).toBe(true)
		await h.service.stop()
	})

	it("releases demand on unsubscribe, disconnect and a subscribe still in flight, and survives unsubscribe → subscribe in one tick", async () => {
		const h = make({ fake: true })
		await h.service.start()
		const g = gate()
		h.mem.engineGates.set("rtl", g.promise)
		const first = h.service.subscribe("c1", { sourceId: "rtl" })
		const leave = h.service.unsubscribe("c1")
		g.open()
		await Promise.all([first, leave])
		expect(h.service.sourceIds()).toEqual([])
		expect(h.fanout.branches.size).toBe(0)
		expect(h.acks("c1")).toEqual([])
		expect(h.service.allocation().clients).toBe(0)

		void h.service.subscribe("c1", { sourceId: "rtl" })
		void h.service.unsubscribe("c1")
		await h.service.subscribe("c1", { sourceId: "rtl", hz: 25, bins: 2048 })
		expect(h.acks("c1").map(a => a.profile?.key)).toEqual(["25:2048"])
		expect(h.service.allocation().consumers["rtl"]?.displays).toEqual(["ws:c1"])
		await h.service.unsubscribe("c1")
		expect(h.service.allocation()).toEqual({
			reserved: [],
			built: [],
			consumers: {},
			clients: 0,
		})
		expect(h.service.sourceIds()).toEqual([])

		await h.service.subscribe("c1", undefined)
		await h.service.subscribe("c2", undefined)
		await h.service.unsubscribe("c1")
		expect(h.service.sourceIds().sort()).toEqual(["air", "rtl"])
		await h.service.unsubscribe("c2")
		expect(h.service.sourceIds()).toEqual([])
		await h.service.stop()
	})

	it("coalesces requests to one running and one pending; superseded requests send nothing and keep no demand", async () => {
		const h = make({ fake: true })
		await h.service.start()
		const g = gate()
		h.mem.engineGates.set("air", g.promise)
		void h.service.subscribe("c1", { sourceId: "air" })
		void h.service.subscribe("c1", { sourceId: "rtl", hz: 20, bins: 1024 })
		const last = h.service.subscribe("c1", {
			sourceId: "rtl",
			hz: 25,
			bins: 2048,
		})
		g.open()
		await last
		expect(h.mem.loads).toEqual(["air", "rtl"])
		expect(h.acks("c1").map(a => a.profile?.key)).toEqual(["25:2048"])
		const consumers = h.service.allocation().consumers
		expect(consumers["rtl"]?.displays).toEqual(["ws:c1"])
		expect(consumers["air"]?.displays ?? []).toEqual([])
		await h.service.stop()

		const b = make({ fake: true })
		await b.service.start()
		const requests = Array.from({ length: 10 }, (_, i) => ({
			sourceId: i % 2 === 0 ? "air" : "rtl",
			hz: 2 * (i + 1),
		}))
		const done = requests.map(r => b.service.subscribe("c1", r))
		await Promise.all(done)
		expect(b.mem.loads.length).toBeLessThanOrEqual(2)
		expect(b.acks("c1").map(a => [a.sourceId, a.profile?.key])).toEqual([
			["rtl", "20:512"],
		])
		await b.service.stop()
	})

	it("stop() cancels in-flight subscribes", async () => {
		const h = make({ fake: true })
		await h.service.start()
		const g = gate()
		h.mem.engineGates.set("rtl", g.promise)
		void h.service.subscribe("c1", { sourceId: "rtl" })
		void h.service.subscribe("c1", { sourceId: "rtl", hz: 25, bins: 2048 })
		const stopping = h.service.stop()
		g.open()
		await stopping
		expect(h.acks("c1")).toEqual([])
		expect(h.service.allocation().clients).toBe(0)
		expect(h.service.sourceIds()).toEqual([])
		expect(h.fanout.branches.size).toBe(0)
		const loads = h.mem.loads.length
		await h.service.subscribe("c2", undefined)
		expect(h.acks("c2")).toEqual([])
		expect(h.mem.loads.length).toBe(loads)
		expect(h.service.sourceIds()).toEqual([])
	})

	it("refuses an acquire once stop() began (S1-B final review, finding 5)", async () => {
		const h = make({ fake: true })
		await h.service.start()
		const stopping = h.service.stop()
		await expect(h.service.acquire("rtl", "job:late")).rejects.toMatchObject({
			code: "SPECTRUM_STOPPED",
		})
		await stopping
		await expect(h.service.acquire("rtl", "job:late")).rejects.toMatchObject({
			code: "SPECTRUM_STOPPED",
		})
		expect(h.service.sourceIds()).toEqual([])
		expect(h.fanout.branches.size).toBe(0)
	})

	it("an acquire waits for a closing engine of the same source", async () => {
		const h = make({ fake: true })
		await h.service.start()
		await h.service.subscribe("c1", { sourceId: "rtl" })
		const closing = gate()
		h.host("rtl").closeGate = closing.promise
		void h.service.unsubscribe("c1")
		const joining = h.service.subscribe("c2", { sourceId: "rtl" })
		await settle()
		expect(h.acks("c2")).toEqual([])
		closing.open()
		await joining
		expect(h.fanout.branches.size).toBe(1)
		expect(h.hostsOf("rtl")).toHaveLength(2)
		h.host("rtl").epoch(1, true)
		const from = h.log.length
		h.host("rtl").summaries(1, 2)
		expect(h.frames(from).map(f => f.clientIds)).toEqual([["c2"]])
		await h.service.stop()
	})

	it("permanent removal releases display demand and notifies affected clients; a reconnect does not", async () => {
		const h = make({ fake: true })
		await h.service.start()
		await h.service.subscribe("c1", { sourceId: "rtl" })
		await h.service.subscribe("c2", undefined)
		const from = h.log.length
		h.sources.emit("removed", "rtl")
		await settle()
		expect(h.log.length).toBe(from)
		expect(h.service.sourceIds().sort()).toEqual(["air", "rtl"])
		h.sources.emit("source-removed", "rtl", new Date())
		expect(h.acks("c1").at(-1)).toEqual({
			selection: "none",
			sourceId: null,
			profile: null,
			effectiveHz: null,
			outcome: "removed",
			adjusted: [],
			removedSourceId: "rtl",
			code: "SPECTRUM_SOURCE_REMOVED",
		})
		expect(h.acks("c2").at(-1)).toMatchObject({
			selection: "default",
			profile: { key: "10:512" },
			outcome: "removed",
			removedSourceId: "rtl",
		})
		await settle()
		expect(h.service.sourceIds()).toEqual(["air"])
		expect(h.fanout.branches.size).toBe(0)
		expect(h.serviceEvents(from)).toEqual([])
		expect(h.service.status().profiles.some(p => p.sourceId === "rtl")).toBe(
			false,
		)
		expect(h.service.allocation().reserved).toEqual([])
		h.host("air").epoch(1, true)
		const at = h.log.length
		h.host("air").summaries(1, 2)
		expect(h.frames(at).map(f => [f.sourceId, f.clientIds])).toEqual([
			["air", ["c2"]],
		])
		const loads = h.mem.loads.length
		await h.service.subscribe("c3", undefined)
		expect(h.mem.loads.length).toBe(loads)
		expect(Object.keys(h.service.allocation().consumers)).toEqual(["air"])
		await h.service.subscribe("c4", { sourceId: "rtl" })
		expect(h.acks("c4").at(-1)).toMatchObject({
			outcome: "rejected",
			code: "SPECTRUM_SOURCE_REMOVED",
			selection: "none",
		})
		h.sources.emit("connected", "rtl")
		await h.service.subscribe("c4", { sourceId: "rtl" })
		expect(h.acks("c4").at(-1)).toMatchObject({
			outcome: "exact",
			sourceId: "rtl",
		})
		await h.service.stop()

		const j = make({ fake: true })
		await j.service.start()
		await j.service.acquire("rtl", "job:a")
		await j.service.subscribe("c1", { sourceId: "rtl" })
		j.host("rtl").epoch(1, true)
		j.host("rtl").summaries(1)
		const rtlStatus = () =>
			j.service.status().sources.find(s => s.sourceId === "rtl")
		expect(rtlStatus()?.summaryBinCount).toBe(819)
		j.sources.emit("source-removed", "rtl", new Date())
		await settle()
		expect(j.service.sourceIds()).toEqual(["rtl"])
		expect(j.service.allocation().consumers["rtl"]).toEqual({
			jobs: ["job:a"],
			displays: [],
		})
		// the job keeps the engine, but no display data of the removed source survives
		expect(rtlStatus()).toMatchObject({
			summaryBinCount: null,
			latestFrame: null,
		})
		await j.service.release("rtl", "job:a")
		expect(j.service.sourceIds()).toEqual([])
		await j.service.stop()
	})

	it("a removal during an in-flight acquire sends one removal notice and keeps no demand", async () => {
		const h = make({ fake: true })
		await h.service.start()
		const g = gate()
		h.mem.engineGates.set("rtl", g.promise)
		const pending = h.service.subscribe("c1", { sourceId: "rtl" })
		await settle()
		h.sources.emit("source-removed", "rtl", new Date())
		g.open()
		await pending
		await settle()
		expect(h.seen("c1")).toEqual([
			{
				type: "ack",
				ack: {
					selection: "none",
					sourceId: null,
					profile: null,
					effectiveHz: null,
					outcome: "removed",
					adjusted: [],
					removedSourceId: "rtl",
					code: "SPECTRUM_SOURCE_REMOVED",
				},
			},
		])
		expect(h.service.allocation().consumers["rtl"]).toBeUndefined()
		expect(h.service.sourceIds()).toEqual([])
		expect(h.fanout.branches.size).toBe(0)
		await h.service.stop()

		// A default client: the removed source is skipped, and the removal is no engine error.
		const d = make({ fake: true })
		await d.service.start()
		const dg = gate()
		d.mem.engineGates.set("rtl", dg.promise)
		const joining = d.service.subscribe("c2", undefined)
		await settle()
		d.sources.emit("source-removed", "rtl", new Date())
		dg.open()
		await joining
		await settle()
		expect(d.acks("c2").map(a => a.outcome)).toEqual(["default"])
		expect(d.service.sourceIds()).toEqual(["air"])
		const rtl = d.service.status().sources.find(s => s.sourceId === "rtl")
		expect(rtl).toMatchObject({
			engine: "idle",
			eligible: false,
			reason: "source-removed",
		})
		expect(rtl?.lastError).toBeUndefined()
		await d.service.stop()
	})

	it("the profile cap stays bounded across default PATCH changes", async () => {
		const h = make({ fake: true, patch: s => (s.ws.spectrumMaxProfiles = 1) })
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		h.host("rtl").epoch(1, true)
		const reserved = () => h.service.allocation().reserved
		const check = (def: string) => {
			expect(reserved().length).toBeLessThanOrEqual(1)
			for (const keys of keysPerSummary(h, "rtl", 1, 4))
				expect(nonDefault(keys, def).length).toBeLessThanOrEqual(1)
		}
		// A = 10:512
		await h.service.subscribe("c1", { sourceId: "rtl", hz: 10, bins: 512 })
		expect(h.acks("c1").at(-1)).toMatchObject({ outcome: "exact" })
		expect(reserved()).toEqual([])
		check("10:512")
		// B = 10:256: c1's pair now counts
		h.settings.ws.spectrumBins = 256
		check("10:256")
		expect(reserved()).toEqual(["rtl:10:512"])
		await h.service.subscribe("c2", { sourceId: "rtl", hz: 10, bins: 256 })
		expect(h.acks("c2").at(-1)).toMatchObject({ outcome: "exact" })
		check("10:256")
		// C = 10:128: B no longer fits; c2 is remapped, c1 keeps A
		h.settings.ws.spectrumBins = 128
		const c1Acks = h.acks("c1").length
		check("10:128")
		expect(h.acks("c2").at(-1)).toMatchObject({
			selection: "source",
			sourceId: "rtl",
			profile: { key: "10:128" },
			outcome: "nearest",
			adjusted: ["profile-limit"],
		})
		expect(h.acks("c1")).toHaveLength(c1Acks)
		expect(reserved()).toEqual(["rtl:10:512"])
		// the reverse transition (a custom key becomes the default and back)
		await h.service.unsubscribe("c1")
		await h.service.unsubscribe("c2")
		await h.service.subscribe("c4", { sourceId: "rtl", hz: 20, bins: 1024 })
		expect(h.acks("c4").at(-1)).toMatchObject({ outcome: "exact" })
		expect(reserved()).toEqual(["rtl:20:1024"])
		h.settings.ws.spectrumHz = 20
		h.settings.ws.spectrumBins = 1024
		check("20:1024")
		expect(reserved()).toEqual([])
		await h.service.subscribe("c5", { sourceId: "rtl", hz: 25, bins: 2048 })
		expect(h.acks("c5").at(-1)).toMatchObject({ outcome: "exact" })
		check("20:1024")
		h.settings.ws.spectrumHz = 10
		h.settings.ws.spectrumBins = 512
		check("10:512")
		expect(h.acks("c4").at(-1)).toMatchObject({
			profile: { key: "10:512" },
			outcome: "nearest",
			adjusted: ["profile-limit"],
		})
		expect(reserved()).toEqual(["rtl:25:2048"])
		await h.service.stop()
	})

	it("make-before-break never builds more than the cap, and reserves at most cap + 1", async () => {
		const h = make({ fake: true, patch: s => (s.ws.spectrumMaxProfiles = 1) })
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		h.host("rtl").epoch(1, true)
		await h.service.subscribe("c1", { sourceId: "rtl", hz: 20, bins: 1024 })
		await h.service.subscribe("c2", { sourceId: "rtl", hz: 20, bins: 1024 })
		await h.service.subscribe("c1", { sourceId: "rtl", hz: 25, bins: 2048 })
		expect(h.acks("c1").at(-1)).toMatchObject({
			outcome: "nearest",
			profile: { key: "20:1024" },
			adjusted: ["profile-limit"],
		})
		await h.service.unsubscribe("c2")
		await h.service.subscribe("c1", { sourceId: "rtl", hz: 20, bins: 1024 })
		await h.service.subscribe("c1", { sourceId: "rtl", hz: 25, bins: 2048 })
		expect(h.acks("c1").at(-1)).toMatchObject({
			outcome: "exact",
			profile: { key: "25:2048" },
		})
		await h.service.subscribe("c1", { sourceId: "rtl", hz: 20, bins: 1024 })
		// cross-source switch, held in flight
		const g = gate()
		h.mem.engineGates.set("air", g.promise)
		const switching = h.service.subscribe("c1", {
			sourceId: "air",
			hz: 25,
			bins: 2048,
		})
		await settle()
		expect(h.service.allocation().reserved).toEqual([
			"air:25:2048",
			"rtl:20:1024",
		])
		expect(h.service.allocation().built).toEqual(["rtl:20:1024"])
		await h.service.subscribe("c2", { sourceId: "rtl", hz: 15, bins: 256 })
		await h.service.subscribe("c3", { sourceId: "rtl", hz: 20, bins: 1024 })
		for (const id of ["c2", "c3"])
			expect(h.acks(id).at(-1)).toMatchObject({
				outcome: "nearest",
				profile: { key: "10:512" },
				adjusted: ["profile-limit"],
			})
		for (const keys of keysPerSummary(h, "rtl", 1, 4))
			expect(nonDefault(keys, "10:512").length).toBeLessThanOrEqual(1)
		g.open()
		await switching
		expect(h.service.allocation().reserved).toEqual(["air:25:2048"])
		await h.service.stop()
	})

	it("the reported effective rate equals the delivered cadence", async () => {
		const h = make({ fake: true })
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		h.host("rtl").epoch(1, true)
		const rates = [15, 25, 7, 0.5]
		for (const [i, hz] of rates.entries())
			await h.service.subscribe(`c${i}`, { sourceId: "rtl", hz })
		const from = h.log.length
		h.host("rtl").summaries(1, 40)
		const frames = h.frames(from)
		const status = h.service.status().profiles
		const expected = [
			{ frames: 20, n: 2, hz: 10 },
			{ frames: 40, n: 1, hz: 20 },
			{ frames: 13, n: 3, hz: 20 / 3 },
			{ frames: 1, n: 40, hz: 0.5 },
		]
		for (const [i, hz] of rates.entries()) {
			const key = `${hz}:512`
			const delivered = frames.filter(f => f.profile === key).length
			const p = status.find(s => s.key === key)!
			const want = expected[i]!
			expect(delivered).toBe(want.frames)
			expect(p.summariesPerFrame).toBe(want.n)
			expect(p.effectiveHz).toBeCloseTo(want.hz, 3)
			expect(delivered).toBe(Math.floor(40 / p.summariesPerFrame!))
			// 40 summaries at 20 per second = 2 s
			expect(Math.abs(delivered - p.effectiveHz! * 2)).toBeLessThanOrEqual(1)
			expect(h.acks(`c${i}`)[0]?.effectiveHz).toBeCloseTo(want.hz, 3)
		}
		await h.service.stop()

		const slow = make({
			fake: true,
			patch: s => (s.detection.sensitivity = "high"),
		})
		await slow.service.start()
		await slow.service.subscribe("c1", { sourceId: "rtl", hz: 15 })
		expect(slow.acks("c1")[0]?.effectiveHz).toBe(10)
		expect(slow.service.status().profiles[0]).toMatchObject({
			key: "15:512",
			summariesPerFrame: 1,
			effectiveHz: 10,
		})
		await slow.service.stop()
	})

	it("display choices never restart the engine or reach the detector", async () => {
		const h = make({ fake: true })
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		const engine = h.service.engine("rtl")
		const from = h.log.length
		await h.service.subscribe("c1", undefined)
		await h.service.subscribe("c2", { sourceId: "rtl", hz: 25, bins: 2048 })
		await h.service.subscribe("c3", { sourceId: "rtl", hz: 5, bins: 256 })
		await h.service.subscribe("c1", { sourceId: "rtl", hz: 20, bins: 1024 })
		await h.service.unsubscribe("c2")
		await h.service.subscribe("c3", { sourceId: "air" })
		await h.service.unsubscribe("c1")
		await h.service.unsubscribe("c3")
		expect(h.hostsOf("rtl")).toHaveLength(1)
		expect(h.host("rtl").cfg.spectrumBins).toBe(
			h.settings.ws.spectrumSummaryBins,
		)
		expect(h.serviceEvents(from)).toEqual([])
		expect(h.service.engine("rtl")).toBe(engine)
		await h.service.stop()
	})

	it("a display-only engine's start, restart and stop emit no scanner-facing event", async () => {
		const h = make({ fake: true })
		await h.service.start()
		await h.service.subscribe("c1", { sourceId: "rtl" })
		h.sources.setCaps("rtl", { sampleRate: 2_048_000 })
		await settle()
		await settle()
		expect(h.hostsOf("rtl")).toHaveLength(2)
		await h.service.unsubscribe("c1")
		expect(h.service.sourceIds()).toEqual([])
		expect(h.serviceEvents()).toEqual([])

		const j = make({ fake: true })
		await j.service.start()
		await j.service.acquire("rtl", "job:a")
		await j.service.subscribe("c1", { sourceId: "rtl" })
		const from = j.log.length
		j.sources.setCaps("rtl", { sampleRate: 2_048_000 })
		await settle()
		await settle()
		expect(j.hostsOf("rtl")).toHaveLength(2)
		expect(j.serviceEvents(from)).toEqual([
			{ kind: "stream", sourceId: "rtl", stream: 1, reason: "restart" },
		])
		await j.service.release("rtl", "job:a")
		expect(j.serviceEvents(from).slice(1)).toEqual([
			{ kind: "released", sourceId: "rtl", consumer: "job:a" },
		])
		await j.service.unsubscribe("c1")
		expect(j.service.sourceIds()).toEqual([])
		expect(j.serviceEvents(from)).toHaveLength(2)
		await j.service.stop()
	})

	it("reports active profiles, limits and summary detail in the status", async () => {
		const h = make({ fake: true })
		await h.service.start()
		await h.service.subscribe("c1", { sourceId: "rtl", hz: 15 })
		h.host("rtl").epoch(1, true)
		h.host("rtl").summaries(1)
		const status = h.service.status()
		expect(status).toMatchObject({
			defaultProfile: { key: "10:512", hz: 10, bins: 512 },
			limits: {
				maxProfiles: 4,
				hz: { min: 0.5, max: 25, step: 0.5 },
				bins: { min: 128, max: 2048 },
			},
			subscribers: 1,
			profiles: [
				{
					sourceId: "rtl",
					key: "15:512",
					hz: 15,
					bins: 512,
					isDefault: false,
					clients: 1,
					binCount: 410,
					binHz: 2000,
					summariesPerFrame: 2,
					effectiveHz: 10,
				},
			],
		})
		const rtl = status.sources.find(s => s.sourceId === "rtl")!
		expect(rtl).toMatchObject({
			eligible: true,
			engine: "running",
			consumers: 1,
			summaryBinCount: 819,
			summaryBinHz: 1000,
			summaryHz: 20,
			latestFrame: { profile: "10:512", binCount: 410 },
		})
		expect(status.sources.find(s => s.sourceId === "aud")).toMatchObject({
			eligible: false,
			reason: "source-not-iq",
		})
		h.sources.emit("source-removed", "rtl", new Date())
		await settle()
		expect(
			h.service.status().sources.find(s => s.sourceId === "rtl"),
		).toMatchObject({ eligible: false, reason: "source-removed" })
		await h.service.stop()
	})

	it("the default profile follows a settings change at the next frame", async () => {
		const h = make({ fake: true })
		await h.service.start()
		await h.service.subscribe("c1", undefined)
		await h.service.subscribe("c2", { sourceId: "rtl", hz: 25, bins: 2048 })
		h.host("rtl").epoch(1, true)
		const before = keysPerSummary(h, "rtl", 1, 2).flat()
		expect(new Set(before)).toEqual(new Set(["10:512", "25:2048"]))
		h.settings.ws.spectrumBins = 256
		const from = h.log.length
		h.host("rtl").summaries(1, 2)
		expect(
			h.frames(from).map(f => [f.profile, f.clientIds, f.binCount <= 256]),
		).toEqual([
			["25:2048", ["c2"], false],
			["10:256", ["c1"], true],
			["25:2048", ["c2"], false],
		])
		await h.service.stop()
	})

	it("normaliseProfile, nearestProfile and summariesPerFrame are pure and bounded", () => {
		const def: SpectrumProfile = { key: "10:512", hz: 10, bins: 512 }
		const hz = (v: number) => normaliseProfile({ hz: v }, def)
		expect(hz(7.3)).toEqual({
			profile: { key: "7.5:512", hz: 7.5, bins: 512 },
			adjusted: ["hz"],
		})
		expect(hz(0.1).profile.hz).toBe(0.5)
		expect(hz(99).profile.hz).toBe(25)
		expect(hz(12.5)).toEqual({
			profile: { key: "12.5:512", hz: 12.5, bins: 512 },
			adjusted: [],
		})
		expect(normaliseProfile({ bins: 300.4 }, def)).toEqual({
			profile: { key: "10:300", hz: 10, bins: 300 },
			adjusted: ["bins"],
		})
		expect(normaliseProfile({ bins: 50 }, def).profile.bins).toBe(128)
		const odd: SpectrumProfile = { key: "7.3:512", hz: 7.3, bins: 512 }
		expect(normaliseProfile({ bins: 512 }, odd)).toEqual({
			profile: odd,
			adjusted: [],
		})
		const p = (h: number, b: number): SpectrumProfile => ({
			key: `${h}:${b}`,
			hz: h,
			bins: b,
		})
		// not larger first, even when a larger one is closer
		expect(nearestProfile(p(20, 1024), [p(25, 2048), p(10, 512)]).key).toBe(
			"10:512",
		)
		// nothing smaller: the metric decides
		expect(nearestProfile(p(5, 128), [p(25, 2048), p(10, 512)]).key).toBe(
			"10:512",
		)
		// equal metric: fewer bins wins, whatever the order
		expect(nearestProfile(p(20, 1024), [p(10, 1024), p(20, 512)]).key).toBe(
			"20:512",
		)
		expect(nearestProfile(p(20, 1024), [p(20, 512), p(10, 1024)]).key).toBe(
			"20:512",
		)
		// equal metric and bins: lower hz
		expect(nearestProfile(p(10, 1024), [p(20, 2048), p(5, 2048)]).key).toBe(
			"5:2048",
		)
		expect(summariesPerFrame(20, 15)).toBe(2)
		expect(summariesPerFrame(20, 20)).toBe(1)
		expect(summariesPerFrame(20, 25)).toBe(1)
		expect(summariesPerFrame(20, 7)).toBe(3)
		expect(summariesPerFrame(20, 0.5)).toBe(40)
		expect(summariesPerFrame(10, 15)).toBe(1)
	})
})

describe("ScannerService with the scanner disabled", () => {
	it("starts no engine without a spectrum subscriber and serves the feed with one", async () => {
		const h = serviceHarness({
			patch: s => {
				s.enabled = false
			},
		})
		await h.service.start()
		await tick(30)
		expect(h.service.spectrum.sourceIds()).toEqual([])
		expect(h.fanout.branches.size).toBe(0)
		await expect(
			h.service.createJob({ sourceId: "rtl", mode: "in-window" }),
		).rejects.toMatchObject({ code: "SCANNER_DISABLED" })
		await h.service.spectrum.subscribe("c1", undefined)
		expect(h.fanout.branches.has("scanner-rtl")).toBe(true)
		await h.service.spectrum.unsubscribe("c1")
		expect(h.fanout.branches.size).toBe(0)
		await h.service.stop()
	})
})

describe("fatal engine lifecycle (review F5)", () => {
	it("invalidates status and snapshots, discards late messages, and reacquires for subscribers", async () => {
		const h = make({ fake: true })
		await h.service.start()
		try {
			await h.service.subscribe("existing", { sourceId: "rtl" })
			const old = h.host()
			old.epoch(1, true)
			old.summaries(1, 2)
			expect(
				h.service.status().sources.find(s => s.sourceId === "rtl")?.latestFrame,
			).not.toBeNull()
			const handlers = old.handlers as PipelineHostHandlers & {
				fatal?(err: Error): void
			}
			const error = new WaveKitError("worker exited", "SCANNER_WORKER_EXIT")
			if (handlers.fatal) handlers.fatal(error)
			else handlers.error(error)
			expect(
				h.service.status().sources.find(s => s.sourceId === "rtl"),
			).toMatchObject({ engine: "error", latestFrame: null })
			const from = h.log.length
			old.summaries(1, 4)
			expect(h.frames(from)).toEqual([])
			await h.service.subscribe("new", { sourceId: "rtl" })
			expect(h.hostsOf("rtl")).toHaveLength(2)
			expect(h.seen("new").filter(e => e.type === "snapshot")).toEqual([])
			await h.service.subscribe("existing", { sourceId: "rtl" })
			const next = h.host()
			next.epoch(1, true)
			next.summaries(1, 10)
			expect(
				h
					.frames(from)
					.some(
						f =>
							f.clientIds.includes("existing") && f.clientIds.includes("new"),
					),
			).toBe(true)
		} finally {
			await h.service.stop()
		}
	})
	it("reports restart-not-IQ as dead and rejects new demand instead of replaying stale data", async () => {
		const h = make({ fake: true })
		await h.service.start()
		try {
			await h.service.subscribe("existing", { sourceId: "rtl" })
			h.host().epoch(1, true)
			h.host().summaries(1)
			h.sources.setCaps("rtl", {
				kind: "audio_pcm",
				format: "S16LE",
				sampleRate: 48_000,
			})
			await vi.waitFor(() =>
				expect(
					h.service.status().sources.find(s => s.sourceId === "rtl"),
				).toMatchObject({ engine: "error", latestFrame: null }),
			)
			await h.service.subscribe("new", { sourceId: "rtl" })
			expect(h.acks("new").at(-1)?.code).toBe("SPECTRUM_SOURCE_NOT_IQ")
			expect(h.seen("new").filter(e => e.type === "snapshot")).toEqual([])
		} finally {
			await h.service.stop()
		}
	})
})

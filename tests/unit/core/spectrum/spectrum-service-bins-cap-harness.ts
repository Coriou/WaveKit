/**
 * WG8 lane SB: shared harness for the bins-cap tests and for the golden capture (run once against
 * the frozen code, commit 30f17b43). Builds a SpectrumService like spectrum-service-backfill.test.ts.
 */
import { createHash } from "node:crypto"
import fc from "fast-check"
import pino from "pino"
import type {
	SpectrumBinsCapView,
	SpectrumFrameEventData,
	SpectrumProfileEventData,
	SpectrumStatus,
} from "@wavekit/api-types"
import type { SourceConfig } from "../../../../src/config.js"
import {
	SpectrumService,
	type SpectrumPersistence,
} from "../../../../src/core/spectrum/spectrum-service.js"
import { DEFAULT_TUNING } from "../../../../src/core/spectrum/spectrum-engine.js"
import type {
	PipelineHost,
	PipelineHostHandlers,
} from "../../../../src/core/spectrum/pipeline-host.js"
import type {
	BlockSummary,
	EngineState,
	PipelineConfig,
	PipelineEvent,
	PipelineInput,
} from "../../../../src/core/spectrum/types.js"
import type { OccupancyState } from "../../../../src/core/spectrum/occupancy.js"
import {
	FakeFanout,
	FakeSources,
	FakeTuner,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"
import { CENTRE, FS } from "../../../mocks/scanner/service-fakes.js"

export class FakeHost implements PipelineHost {
	constructor(
		readonly cfg: PipelineConfig,
		readonly handlers: PipelineHostHandlers,
	) {}
	send(_input: PipelineInput): void {}
	exportState(): Promise<EngineState> {
		return Promise.resolve({
			version: 1,
			absoluteFloors: [],
			spurs: [],
			kByRange: [],
		})
	}
	async close(): Promise<void> {}
	utilization(): number | null {
		return null
	}
	emit(...events: PipelineEvent[]): void {
		this.handlers.events(events)
	}
	epoch(epoch: number, first = false): void {
		this.emit({
			kind: "epoch-started",
			epoch,
			startSample: 0,
			settleMode: first ? "none" : "timer",
		})
	}
	/** A deterministic summary of `bins` bins: a ripple plus a peak at `peak` (index). */
	summary(epoch: number, peak: number, bins: number): void {
		const binHz = this.cfg.sampleRateHz / this.cfg.fftSize
		const summary: BlockSummary = {
			sourceId: this.cfg.sourceId,
			stream: 0,
			epoch,
			endSample: 0,
			centreHz: CENTRE,
			sampleRateHz: this.cfg.sampleRateHz,
			binHz,
			startHz: CENTRE - (bins / 2) * binHz,
			bins: Array.from({ length: bins }, (_, i) =>
				i === peak ? -20 : -90 + ((i * 7) % 13) / 2,
			),
			floorDbfs: -90,
			thresholdDb: 10,
			tracks: [],
			masks: { dcHz: CENTRE, dcGuardHz: 1500, spurRanges: [] },
			floorOccupied: false,
			overload: false,
		}
		this.emit({ kind: "block-summary", summary })
	}
}

export interface Logged {
	ack: SpectrumProfileEventData
	snapshots: SpectrumFrameEventData[]
	backfill: SpectrumFrameEventData[]
}

export interface MakeOptions {
	summaryBins: number
	binsCap?: () => SpectrumBinsCapView
}

export function makeService(opts: MakeOptions) {
	const sources = new FakeSources("rtl", { sampleRate: FS, centerFreq: CENTRE })
	const tuner = new FakeTuner()
	const fanout = new FakeFanout()
	const engines = new Map<string, EngineState>()
	const occupancy = new Map<string, OccupancyState>()
	const persistence: SpectrumPersistence = {
		writeEngine: (id, s) => (engines.set(id, s), Promise.resolve()),
		loadEngine: id => Promise.resolve(engines.get(id) ?? null),
		writeOccupancy: (id, s) => (occupancy.set(id, s), Promise.resolve()),
		loadOccupancy: id => Promise.resolve(occupancy.get(id) ?? null),
	}
	const settings = testSettings(s => {
		s.ws.spectrumSummaryBins = opts.summaryBins
	})
	const hosts: FakeHost[] = []
	const service = new SpectrumService({
		sources: sources as never,
		routing: {
			getFanout: () => fanout,
			releaseUnused: () => undefined,
		} as never,
		tuner: tuner as never,
		sourceConfigs: [
			{
				id: "rtl",
				type: "rtl_tcp",
				host: "127.0.0.1",
				port: 1234,
				loop: false,
				playbackSpeed: 1,
				caps: sources.getCaps("rtl")!,
			} as SourceConfig,
		],
		settings: () => settings,
		tuning: () => DEFAULT_TUNING,
		persistence,
		logger: pino({ level: "silent" }),
		now: () => 1_700_000_000_000,
		engineHost: "inline",
		createHost: (cfg, handlers) => {
			const host = new FakeHost(cfg, handlers)
			hosts.push(host)
			return host
		},
		...(opts.binsCap ? { binsCap: opts.binsCap } : {}),
	})
	const profiles: (Logged & { clientId: string })[] = []
	const frames: { frame: SpectrumFrameEventData; clientIds: string[] }[] = []
	service.on(
		"profile",
		(
			clientId: string,
			ack: SpectrumProfileEventData,
			snapshots: SpectrumFrameEventData[],
			backfill: SpectrumFrameEventData[] = [],
		) => profiles.push({ clientId, ack, snapshots, backfill }),
	)
	service.on(
		"frame",
		(frame: SpectrumFrameEventData, clientIds: readonly string[]) =>
			frames.push({ frame, clientIds: [...clientIds] }),
	)
	return {
		service,
		settings,
		profiles,
		frames,
		host: () => hosts.at(-1)!,
	}
}

/**
 * Post-subscribe summaries: 20 summaries/s (50 ms integration), so 40 yield 20 frames at 10 Hz and
 * one at 0.5 Hz (the slowest profile), making live frames non-empty for every served profile.
 */
export const LIVE_SUMMARIES = 40

/** A frame with its base64 bins replaced by their sha256 (keeps the golden small, still byte-exact). */
function digestFrame(frame: SpectrumFrameEventData): SpectrumFrameEventData {
	return {
		...frame,
		bins: createHash("sha256").update(frame.bins).digest("hex"),
	}
}

/** Subscribes one option set on a fresh service and records ack, snapshot, backfill, live frames and status. */
export async function runScenario(
	opts: MakeOptions,
	options: unknown,
	feedBins = opts.summaryBins,
): Promise<{
	logged: Logged | undefined
	live: SpectrumFrameEventData[]
	status: SpectrumStatus
}> {
	const h = makeService(opts)
	await h.service.start()
	await h.service.acquire("rtl", "job:a")
	h.host().epoch(1, true)
	for (let i = 0; i < 3; i++) h.host().summary(1, i * 3, feedBins)
	await h.service.subscribe("c1", options)
	const before = h.frames.length
	for (let i = 0; i < LIVE_SUMMARIES; i++)
		h.host().summary(1, 5 + (i % 11), feedBins)
	const logged = h.profiles.at(-1)
	const live = h.frames.slice(before).map(f => digestFrame(f.frame))
	const status = h.service.status()
	await h.service.stop()
	return {
		logged: logged && {
			ack: logged.ack,
			snapshots: logged.snapshots.map(digestFrame),
			backfill: logged.backfill.map(digestFrame),
		},
		live,
		status,
	}
}

/** The fixed golden option list (hz, bins around 128/2048, 8192, 1e9, non-integers, averaging, backfill, absent). */
export const GOLDEN_OPTIONS: unknown[] = [
	undefined,
	{ sourceId: "rtl" },
	{ sourceId: "rtl", bins: 64 },
	{ sourceId: "rtl", bins: 127 },
	{ sourceId: "rtl", bins: 128 },
	{ sourceId: "rtl", bins: 129 },
	{ sourceId: "rtl", bins: 512 },
	{ sourceId: "rtl", bins: 1000.4 },
	{ sourceId: "rtl", bins: 1000.5 },
	{ sourceId: "rtl", bins: 2047 },
	{ sourceId: "rtl", bins: 2048 },
	{ sourceId: "rtl", bins: 2049 },
	{ sourceId: "rtl", bins: 4096 },
	{ sourceId: "rtl", bins: 8192 },
	{ sourceId: "rtl", bins: 8193 },
	{ sourceId: "rtl", bins: 1e9 },
	{ sourceId: "rtl", bins: -5 },
	{ sourceId: "rtl", bins: 0 },
	{ sourceId: "rtl", hz: 0.1 },
	{ sourceId: "rtl", hz: 1.2 },
	{ sourceId: "rtl", hz: 10 },
	{ sourceId: "rtl", hz: 25 },
	{ sourceId: "rtl", hz: 60 },
	{ sourceId: "rtl", hz: 25, bins: 2048 },
	{ sourceId: "rtl", hz: 25, bins: 4096 },
	{ sourceId: "rtl", hz: 7.3, bins: 300.7 },
	{ sourceId: "rtl", averaging: 1 },
	{ sourceId: "rtl", averaging: 4 },
	{ sourceId: "rtl", averaging: 0 },
	{ sourceId: "rtl", averaging: 99 },
	{ sourceId: "rtl", averaging: 2.6, bins: 4096 },
	{ sourceId: "rtl", backfillMs: 0 },
	{ sourceId: "rtl", backfillMs: 1000 },
	{ sourceId: "rtl", backfillMs: 80_000 },
	{ sourceId: "rtl", backfillMs: -3 },
	{ sourceId: "rtl", hz: 25, bins: 2048, backfillMs: 5000 },
	{ sourceId: "rtl", hz: 25, bins: 8192, backfillMs: 5000, averaging: 3 },
	{ sourceId: "rtl", bins: 1e9, hz: 1e9, averaging: 1e9, backfillMs: 1e9 },
	{ sourceId: "nope", bins: 512 },
	{ sourceId: "rtl", bins: "x" },
]

/** Property 13's subscribe options (all keys optional; hostile ranges on every axis). */
export const optionArb = fc.record(
	{
		hz: fc.double({ min: -5, max: 80, noNaN: true }),
		bins: fc.oneof(
			fc.integer({ min: -10, max: 20_000 }),
			fc.double({ min: -10, max: 20_000, noNaN: true }),
			fc.constant(1e9),
		),
		averaging: fc.double({ min: -3, max: 50, noNaN: true }),
		backfillMs: fc.oneof(
			fc.integer({ min: -5, max: 12_000 }),
			fc.constant(80_000),
		),
	},
	{ requiredKeys: [] },
)

/** Seed and size of the sampled frozen oracle (`golden.sampled`, captured at 30f17b43). */
export const SAMPLED_SEED = 13
export const SAMPLED_RUNS = 100

export function sampledOptions(): unknown[] {
	return fc
		.sample(optionArb, { seed: SAMPLED_SEED, numRuns: SAMPLED_RUNS })
		.map(o => ({ sourceId: "rtl", ...o }))
}

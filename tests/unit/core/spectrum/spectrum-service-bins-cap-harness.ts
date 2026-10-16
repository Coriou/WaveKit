/**
 * WG8 lane SB: shared harness for the bins-cap tests and for the golden capture (run once against
 * the frozen code, commit 30f17b43). Builds a SpectrumService like spectrum-service-backfill.test.ts.
 */
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

/** Subscribes one option set on a fresh service and records ack, snapshot, backfill, a live frame and status. */
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
	h.host().summary(1, 5, feedBins)
	const logged = h.profiles.at(-1)
	const live = h.frames.slice(before).map(f => f.frame)
	const status = h.service.status()
	await h.service.stop()
	return {
		logged: logged && {
			ack: logged.ack,
			snapshots: logged.snapshots,
			backfill: logged.backfill,
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

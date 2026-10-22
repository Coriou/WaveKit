/**
 * WG11 lane TR: a SpectrumService over a fake pipeline host, for frame-track goldens and the
 * identity lookup tests (same shape as spectrum-service-backfill.test.ts).
 */
import { PassThrough } from "node:stream"
import pino from "pino"
import type {
	SpectrumFrameEventData,
	SpectrumProfileEventData,
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

export const NOW = 1_700_000_000_000

export class FakeHost implements PipelineHost {
	readonly inputs: PipelineInput[] = []
	constructor(
		readonly cfg: PipelineConfig,
		readonly handlers: PipelineHostHandlers,
	) {}
	send(input: PipelineInput): void {
		this.inputs.push(input)
	}
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
	summary(summary: BlockSummary): void {
		this.emit({ kind: "block-summary", summary })
	}
}

export interface ProfileLog {
	clientId: string
	ack: SpectrumProfileEventData
	snapshots: SpectrumFrameEventData[]
	backfill: SpectrumFrameEventData[]
}

export function makeService(
	opts: { logLines?: string[]; extraSourceIds?: readonly string[] } = {},
) {
	const sources = new FakeSources("rtl", { sampleRate: FS, centerFreq: CENTRE })
	const tuner = new FakeTuner()
	const extra = opts.extraSourceIds ?? []
	for (const id of extra) {
		sources.caps.set(id, { ...sources.getCaps("rtl")! })
		sources.streams.set(id, new PassThrough())
		tuner.states.set(id, { ...tuner.getState("rtl")!, sourceId: id })
	}
	const engines = new Map<string, EngineState>()
	const occupancy = new Map<string, OccupancyState>()
	const persistence: SpectrumPersistence = {
		writeEngine: (id, s) => (engines.set(id, s), Promise.resolve()),
		loadEngine: id => Promise.resolve(engines.get(id) ?? null),
		writeOccupancy: (id, s) => (occupancy.set(id, s), Promise.resolve()),
		loadOccupancy: id => Promise.resolve(occupancy.get(id) ?? null),
	}
	const settings = testSettings()
	const hosts: FakeHost[] = []
	let clock = NOW
	/** Every log line at debug and above when `logLines` is passed (pino JSON lines). */
	const logger = opts.logLines
		? pino(
				{ level: "debug" },
				{ write: (line: string) => void opts.logLines?.push(line) },
			)
		: pino({ level: "silent" })
	const service = new SpectrumService({
		sources: sources as never,
		routing: {
			getFanout: () => new FakeFanout(),
			releaseUnused: () => undefined,
		} as never,
		tuner: tuner as never,
		sourceConfigs: ["rtl", ...extra].map(
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
		persistence,
		logger,
		now: () => clock,
		engineHost: "inline",
		createHost: (cfg, handlers) => {
			const host = new FakeHost(cfg, handlers)
			hosts.push(host)
			return host
		},
	})
	const profiles: ProfileLog[] = []
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
		host: () => hosts.at(-1)!,
		/** The latest host of one source (several sources run side by side). */
		hostOf: (sourceId: string) =>
			hosts.filter(h => h.cfg.sourceId === sourceId).at(-1)!,
		profiles,
		frames,
		advance: (ms: number) => {
			clock += ms
		},
	}
}

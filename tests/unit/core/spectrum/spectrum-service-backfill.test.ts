import pino from "pino"
import { describe, expect, it } from "vitest"
import type {
	SpectrumFrameEventData,
	SpectrumProfileEventData,
} from "@wavekit/api-types"
import type { SourceConfig } from "../../../../src/config.js"
import {
	SpectrumService,
	decodeBins,
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
import type { ScannerSettings } from "../../../../src/core/scanner/types.js"
import {
	FakeFanout,
	FakeSources,
	FakeTuner,
	testSettings,
} from "../../../mocks/scanner/engine-fakes.js"
import { CENTRE, FS } from "../../../mocks/scanner/service-fakes.js"

const BINS = 16

class FakeHost implements PipelineHost {
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
	summary(epoch: number, peak: number): void {
		this.emit({
			kind: "block-summary",
			summary: blockSummary(this.cfg, epoch, peak),
		})
	}
}

function blockSummary(
	cfg: PipelineConfig,
	epoch: number,
	peak: number,
): BlockSummary {
	const centre = CENTRE
	return {
		sourceId: cfg.sourceId,
		stream: 0,
		epoch,
		endSample: 0,
		centreHz: centre,
		sampleRateHz: cfg.sampleRateHz,
		binHz: cfg.sampleRateHz / cfg.fftSize,
		startHz: centre - (BINS / 2) * (cfg.sampleRateHz / cfg.fftSize),
		bins: Array.from({ length: BINS }, (_, i) =>
			i === peak ? -20 - epoch : -80,
		),
		floorDbfs: -80,
		thresholdDb: 10,
		tracks: [],
		masks: { dcHz: centre, dcGuardHz: 1500, spurRanges: [] },
		floorOccupied: false,
		overload: false,
	}
}

interface ProfileLog {
	clientId: string
	ack: SpectrumProfileEventData
	snapshots: SpectrumFrameEventData[]
	backfill: SpectrumFrameEventData[]
}

function make(patch?: (s: ScannerSettings) => void) {
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
	const settings = testSettings(patch)
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
	const host = () => hosts.at(-1)!
	return { service, settings, host, profiles, frames }
}

const of = (h: ReturnType<typeof make>, clientId: string) =>
	h.profiles.filter(p => p.clientId === clientId)

describe("spectrum service backfill and averaging", () => {
	it("a subscribe without the new options is unchanged", async () => {
		const h = make()
		await h.service.start()
		await h.service.subscribe("c1", undefined)
		expect(of(h, "c1")).toEqual([
			{
				clientId: "c1",
				ack: {
					selection: "default",
					sourceId: null,
					profile: { key: "10:512", hz: 10, bins: 512 },
					effectiveHz: null,
					outcome: "default",
					adjusted: [],
				},
				snapshots: [],
				backfill: [],
			},
		])
		await h.service.stop()
	})

	it("sends ack, then backfill, then the snapshot, and reports backfillFrames", async () => {
		const h = make()
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		h.host().epoch(1, true)
		for (let i = 0; i < 5; i++) h.host().summary(1, i)
		await h.service.subscribe("c1", {
			sourceId: "rtl",
			hz: 25,
			bins: 2048,
			backfillMs: 5_000,
		})
		const logged = of(h, "c1")
		expect(logged).toHaveLength(1)
		const { ack, snapshots, backfill } = logged[0]!
		expect(ack).toMatchObject({
			outcome: "exact",
			profile: { key: "25:2048", hz: 25, bins: 2048 },
			backfillFrames: 4,
			adjusted: [],
		})
		expect(ack.backfillFrames).toBe(backfill.length)
		expect(snapshots).toHaveLength(1)
		expect(snapshots[0]).toMatchObject({ snapshot: true, epoch: 1 })
		expect(snapshots[0]?.backfill).toBeUndefined()
		expect(backfill.map(f => f.backfill)).toEqual([true, true, true, true])
		expect(backfill.every(f => f.snapshot === undefined)).toBe(true)
		const peaks = backfill.map(f => decodeBins(f.bins).findIndex(v => v > -80))
		expect(peaks).toEqual([0, 1, 2, 3])
		expect(decodeBins(snapshots[0]!.bins).findIndex(v => v > -80)).toBe(4)
		const order = [
			"ack",
			...backfill.map(() => "backfill"),
			...snapshots.map(() => "snapshot"),
		]
		expect(order).toEqual([
			"ack",
			"backfill",
			"backfill",
			"backfill",
			"backfill",
			"snapshot",
		])
		await h.service.stop()
	})

	it("an epoch change clears the ring", async () => {
		const h = make()
		await h.service.start()
		await h.service.acquire("rtl", "job:a")
		h.host().epoch(1, true)
		h.host().summary(1, 1)
		h.host().summary(1, 2)
		h.host().epoch(2)
		h.host().summary(2, 3)
		h.host().summary(2, 4)
		h.host().summary(2, 5)
		await h.service.subscribe("c1", {
			sourceId: "rtl",
			hz: 25,
			bins: 2048,
			backfillMs: 10_000,
		})
		const { ack, backfill, snapshots } = of(h, "c1")[0]!
		expect(ack.backfillFrames).toBe(2)
		expect(backfill.map(f => f.epoch)).toEqual([2, 2])
		expect(snapshots.map(f => f.epoch)).toEqual([2])
		await h.service.stop()
	})

	it("a rejected ack and a default selection carry no backfill", async () => {
		const h = make()
		await h.service.start()
		await h.service.subscribe("c1", {
			sourceId: "rtl",
			hz: 25,
			bins: 2048,
			backfillMs: 1000,
		})
		h.host().epoch(1, true)
		h.host().summary(1, 1)
		await h.service.subscribe("c1", { sourceId: "rtl", hz: "nope" })
		const rejected = of(h, "c1").at(-1)!
		expect(rejected.ack).toMatchObject({
			outcome: "rejected",
			code: "SPECTRUM_OPTIONS_INVALID",
		})
		expect(rejected.ack.backfillFrames).toBeUndefined()
		expect(rejected.backfill).toEqual([])
		expect(rejected.snapshots).toEqual([])
		await h.service.subscribe("c2", undefined)
		const def = of(h, "c2")[0]!
		expect(def.ack.backfillFrames).toBeUndefined()
		expect(def.backfill).toEqual([])
		await h.service.subscribe("c3", { sourceId: "rtl", backfillMs: 0 })
		const zero = of(h, "c3")[0]!
		expect(zero.ack.backfillFrames).toBeUndefined()
		expect(zero.backfill).toEqual([])
		await h.service.stop()
	})

	it("reports backfillFrames 0 when the window is empty and names a clamped backfillMs", async () => {
		const h = make()
		await h.service.start()
		await h.service.subscribe("c1", { sourceId: "rtl", backfillMs: 1000 })
		expect(of(h, "c1")[0]!.ack.backfillFrames).toBe(0)
		expect(of(h, "c1")[0]!.backfill).toEqual([])
		await h.service.subscribe("c2", { sourceId: "rtl", backfillMs: 80_000 })
		expect(of(h, "c2")[0]!.ack).toMatchObject({
			outcome: "nearest",
			adjusted: ["backfillMs"],
			backfillFrames: 0,
		})
		await h.service.stop()
	})

	it("gives averaged and plain clients different keys, and the cap counts both", async () => {
		const h = make()
		await h.service.start()
		await h.service.subscribe("c1", { sourceId: "rtl", hz: 15, bins: 512 })
		await h.service.subscribe("c2", {
			sourceId: "rtl",
			hz: 15,
			bins: 512,
			averaging: 4,
		})
		expect(of(h, "c1")[0]!.ack).toMatchObject({
			outcome: "exact",
			profile: { key: "15:512", hz: 15, bins: 512 },
		})
		expect(of(h, "c1")[0]!.ack.profile?.averaging).toBeUndefined()
		expect(of(h, "c2")[0]!.ack.profile).toEqual({
			key: "15:512:a4",
			hz: 15,
			bins: 512,
			averaging: 4,
		})
		const keys = h.service
			.status()
			.profiles.map(p => p.key)
			.sort()
		expect(keys).toEqual(["15:512", "15:512:a4"])
		expect(h.service.allocation().reserved.sort()).toEqual([
			"rtl:15:512",
			"rtl:15:512:a4",
		])
		h.host().epoch(1, true)
		h.host().summary(1, 1)
		h.host().summary(1, 2)
		const sent = h.frames.map(f => [f.frame.profile, f.clientIds])
		expect(sent).toEqual([
			["15:512", ["c1"]],
			["15:512:a4", ["c2"]],
		])
		await h.service.stop()
	})

	it("at the limit, a request without averaging never lands on an averaged profile", async () => {
		const h = make(s => {
			s.ws.spectrumMaxProfiles = 1
		})
		await h.service.start()
		await h.service.subscribe("c1", {
			sourceId: "rtl",
			hz: 15,
			bins: 1024,
			averaging: 4,
		})
		await h.service.subscribe("c2", { sourceId: "rtl", hz: 20, bins: 1024 })
		const ack = of(h, "c2")[0]!.ack
		expect(ack).toMatchObject({
			outcome: "nearest",
			profile: { key: "10:512", hz: 10, bins: 512 },
			adjusted: ["profile-limit"],
		})
		expect(ack.profile?.averaging).toBeUndefined()
		expect(ack.profile?.key.includes(":a")).toBe(false)
		await h.service.stop()
	})

	it("snapshots an averaged profile from its running average", async () => {
		const h = make()
		await h.service.start()
		await h.service.subscribe("c1", {
			sourceId: "rtl",
			hz: 25,
			bins: 2048,
			averaging: 2,
		})
		h.host().epoch(1, true)
		h.host().summary(1, 1)
		h.host().summary(1, 2)
		const live = h.frames.filter(f => f.clientIds.includes("c1"))
		expect(live).toHaveLength(2)
		const second = decodeBins(live[1]!.frame.bins)
		expect(second[1]).toBe(-50.5)
		expect(second[2]).toBe(-50.5)
		await h.service.subscribe("c2", {
			sourceId: "rtl",
			hz: 25,
			bins: 2048,
			averaging: 2,
		})
		const snap = decodeBins(of(h, "c2")[0]!.snapshots[0]!.bins)
		expect(snap).toEqual(second)
		expect(of(h, "c2")[0]!.snapshots[0]).toMatchObject({
			snapshot: true,
			profile: "25:2048:a2",
		})
		await h.service.stop()
	})

	it("backfill of an averaged profile matches the live frames of that profile", async () => {
		const h = make()
		await h.service.start()
		await h.service.subscribe("c1", {
			sourceId: "rtl",
			hz: 25,
			bins: 2048,
			averaging: 2,
		})
		h.host().epoch(1, true)
		for (let i = 0; i < 4; i++) h.host().summary(1, i)
		await h.service.subscribe("c2", {
			sourceId: "rtl",
			hz: 25,
			bins: 2048,
			averaging: 2,
			backfillMs: 10_000,
		})
		const live = h.frames
			.filter(f => f.clientIds.includes("c1"))
			.map(f => f.frame.bins)
		const { backfill, snapshots, ack } = of(h, "c2")[0]!
		expect(ack.backfillFrames).toBe(3)
		expect(backfill.map(f => f.bins)).toEqual(live.slice(0, 3))
		expect(snapshots[0]!.bins).toBe(live[3])
		await h.service.stop()
	})
})

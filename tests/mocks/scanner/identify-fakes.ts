import pino from "pino"
import type {
	ScannerIdentifyEventData,
	ScannerIdentifyRequest,
} from "@wavekit/api-types"
import { ScannerApiError } from "../../../src/core/scanner/errors.js"
import {
	IdentifyRunner,
	normaliseIdentify,
	type IdentifyTrackView,
} from "../../../src/core/scanner/identify.js"
import type {
	JobDriver,
	JobRecord,
} from "../../../src/core/scanner/job-runner.js"
import type { TransportStrategy } from "../../../src/core/scanner/probes/probe-pool.js"
import {
	transition,
	type JobEvent,
} from "../../../src/core/scanner/job-state.js"
import type {
	NormalisedJobSpec,
	ScannerSettings,
} from "../../../src/core/scanner/types.js"
import type { ArtefactKind } from "../../../src/core/spectrum/artefacts.js"
import type {
	BlockSummary,
	TrackFlags,
	TrackSnapshot,
} from "../../../src/core/spectrum/types.js"
import { testSettings } from "./engine-fakes.js"
import { flushAsync, poolHarness } from "./probe-fakes.js"

/** 25 kHz above the FakeEngineView centre (446.1 MHz at 2.048 Msps). */
export const TARGET_HZ = 446_125_000

export const FLAGS: TrackFlags = {
	overload: false,
	gap: false,
	truncated: false,
	edge: false,
	skirt: false,
	obwBiased: false,
	burst: false,
	iqImage: false,
	spur: false,
}

export function trackOf(over: Partial<TrackSnapshot> = {}): TrackSnapshot {
	return {
		trackId: "t1",
		sourceId: "rtl",
		stream: 0,
		epoch: 1,
		startSample: 1_000_000,
		lastSample: 1_400_000,
		centreHz: TARGET_HZ,
		obwHz: 9000,
		obwMethod: "-20dB",
		peakDbfs: -40,
		meanDbfs: -45,
		snrDb: 30,
		floorDbfs: -75,
		thresholdDb: 6,
		blocks: 20,
		maxBlockSnrDb: 35,
		dutyCycle: 1,
		spectralShape: "flat",
		tuningTrust: "commanded",
		...over,
		flags: { ...FLAGS, ...over.flags },
	}
}

export function viewOf(
	track: TrackSnapshot,
	discoveryId: string | null = "d_1",
): IdentifyTrackView {
	return {
		observationId: `o_${track.trackId}`,
		trackId: track.trackId,
		epoch: track.epoch,
		discoveryId,
		track,
	}
}

/** Block summary of the FakeEngineView window: floor −80 dBFS, one −50 dBFS bin at TARGET_HZ. */
export function summaryOf(): BlockSummary {
	const startHz = 446_100_000 - 1_024_000
	const binHz = 4000
	const bins = Array.from({ length: 512 }, () => -80)
	bins[Math.floor((TARGET_HZ - startHz) / binHz)] = -50
	return {
		sourceId: "rtl",
		stream: 0,
		epoch: 1,
		endSample: 2_000_000,
		centreHz: 446_100_000,
		sampleRateHz: 2_048_000,
		binHz,
		startHz,
		bins,
		floorDbfs: -80,
		thresholdDb: 6,
		tracks: [],
		masks: { dcHz: 446_100_000, dcGuardHz: 2000, spurRanges: [] },
		floorOccupied: false,
		overload: false,
	}
}

export function identifyRecord(): JobRecord {
	return {
		id: "j_ident",
		name: "Identify",
		passive: false,
		rawSpec: { kind: "identify" },
		spec: {
			sourceId: "rtl",
			mode: "in-window",
			kind: "identify",
			priority: 100,
			protocols: [],
			integrationMs: 50,
		} as unknown as NormalisedJobSpec,
		plan: { hops: [], usableHalfSpanHz: 0, dcGuardHz: 0, ppmMarginHz: 0 },
		issues: [],
		impact: null,
		consentedImpact: null,
		state: "pending",
		createdAt: 0,
		updatedAt: 0,
		unrestorable: [],
		counts: { observations: 0, transients: 0 },
	}
}

/** The in-window JobRunner's lifecycle only: the real transition table, no engine, no probes. */
export function fakeInner(record: JobRecord, now: () => number): JobDriver {
	const dispatch = (e: JobEvent): Promise<void> => {
		const from =
			record.reason === undefined
				? { state: record.state }
				: { state: record.state, reason: record.reason }
		const t = transition(from, e)
		if ("invalid" in t)
			return Promise.reject(
				new ScannerApiError(
					`invalid ${e.type}`,
					"SCANNER_INVALID_TRANSITION",
					409,
				),
			)
		record.state = t.state
		if (t.reason === undefined) delete record.reason
		else record.reason = t.reason
		if (t.state === "running" && record.startedAt === undefined)
			record.startedAt = now()
		return Promise.resolve()
	}
	const active = (): boolean =>
		record.state === "starting" ||
		record.state === "running" ||
		record.state === "holding"
	return {
		record,
		dispatch,
		start: () =>
			dispatch({ type: "start" }).then(() =>
				dispatch({ type: "engine-ready" }),
			),
		idle: () => Promise.resolve(),
		covers: (sourceId: string) => sourceId === record.spec.sourceId && active(),
		progress: () => ({
			sweepIndex: 0,
			hopIndex: 0,
			hopCount: 0,
			sweepPeriodMs: null,
			coverage: 0,
			holdingOn: null,
			settleMode: null,
			probes: [],
			counts: {
				observations: 0,
				transients: 0,
				discoveries: { activity: 0, candidate: 0, classified: 0, decoded: 0 },
			},
		}),
		tick: () => undefined,
		onEpochStarted: () => undefined,
		onBlock: () => undefined,
		onStale: () => undefined,
		onTrack: () => undefined,
		onTrackClosed: () => undefined,
		onUntrackedRetune: () => undefined,
		onEvidence: () => undefined,
		leaseLost: () => Promise.resolve(),
		replan: () => undefined,
		dispose: () => Promise.resolve(),
	}
}

/** A real ProbePool (fake decoders, FakeEngineView) under an IdentifyRunner with a manual clock. */
export function identifyHarness(
	opts: {
		request?: Partial<ScannerIdentifyRequest>
		artefact?: ArtefactKind | null
		channelizer?: boolean
		cpuPercent?: number | null
		patch?: (s: ScannerSettings) => void
		/** Pool transports (default `[offsetTransport]`); Task 40 passes the post-channelizer order. */
		transports?: readonly TransportStrategy[]
	} = {},
) {
	const settings = testSettings(opts.patch)
	const pool = poolHarness({
		settings,
		cpuPercent: opts.cpuPercent ?? null,
		...(opts.transports ? { transports: opts.transports } : {}),
	})
	const record = identifyRecord()
	const inner = fakeInner(record, () => pool.clock.now)
	const tracks: IdentifyTrackView[] = []
	/** `stale`: the worker's masks lag the main-thread epoch (ScannerService.artefactAt). */
	const state: {
		artefact: ArtefactKind | null | "stale"
		summary: BlockSummary | null
	} = { artefact: opts.artefact ?? null, summary: summaryOf() }
	const events: ScannerIdentifyEventData[] = []
	const runner = new IdentifyRunner({
		record,
		identify: normaliseIdentify({
			target: { frequencyHz: TARGET_HZ },
			record: false,
			...opts.request,
		}),
		inner,
		probes: pool.pool,
		engine: () => pool.engine,
		artefactAt: () => Promise.resolve(state.artefact),
		liveTracks: () => tracks,
		lastSummary: () => state.summary,
		discoveryOf: () => undefined,
		priorsAt: () => ({}),
		format: () => "U8_IQ",
		channelizer: () => opts.channelizer ?? false,
		settings: () => settings,
		emit: d => events.push(structuredClone(d)),
		logger: pino({ level: "silent" }),
		now: () => pool.clock.now,
	})
	/** Advances the clock, ticks the runner and pumps the pool (as ScannerService.tick does), then lets spawns and releases settle. */
	const advance = async (ms: number): Promise<void> => {
		pool.clock.now += ms
		runner.tick(pool.clock.now)
		pool.pool.pump()
		await flushAsync()
		await flushAsync()
	}
	const last = (): ScannerIdentifyEventData | undefined => events.at(-1)
	return {
		...pool,
		settings,
		record,
		tracks,
		state,
		events,
		runner,
		advance,
		last,
	}
}

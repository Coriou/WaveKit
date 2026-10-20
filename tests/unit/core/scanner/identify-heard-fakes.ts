/** WG11 lane ID: a shared IdentifyRunner harness with the WG11 optional deps (test helper, not a test). */
import pino from "pino"
import type {
	ScannerIdentifyEventData,
	ScannerIdentifyRequest,
} from "@wavekit/api-types"
import {
	IdentifyRunner,
	normaliseIdentify,
	type IdentifyAmbientLookup,
	type IdentifyTrackView,
} from "../../../../src/core/scanner/identify.js"
import type {
	AnalogEvidenceTransmission,
	IdentifyAnalogEvidence,
} from "../../../../src/core/scanner/identify-analog-contract.js"
import type { KnownProtocolMemory } from "../../../../src/core/scanner/known-protocol-contract.js"
import type {
	Discovery,
	ScannerProtocol,
} from "../../../../src/core/scanner/types.js"
import type { TrackSnapshot } from "../../../../src/core/spectrum/types.js"
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

export const START = 1_000_000
const ENDED = ["completed", "cancelled", "failed"]

export class FakePort implements IdentifyAnalogEvidence {
	list: AnalogEvidenceTransmission[] = []
	live = true
	transmissionsNear(): readonly AnalogEvidenceTransmission[] {
		return this.list
	}
	monitoring(): boolean {
		return this.live
	}
}

export function tx(
	over: Partial<AnalogEvidenceTransmission> = {},
): AnalogEvidenceTransmission {
	return {
		transmissionId: "tx1",
		sourceId: "rtl",
		startedAtMs: START - 3000,
		endedAtMs: START - 1000,
		hz: TARGET_HZ,
		tuningTrust: "commanded",
		modulation: "nfm",
		ctcssHz: 88.5,
		dcs: null,
		...over,
	}
}

/** A counting fake of the frozen memory: known while decoded with < 2 misses. */
export class FakeMemory implements KnownProtocolMemory {
	misses = new Map<string, number>()
	calls: string[] = []
	constructor(
		public readonly stored: Map<
			string,
			{ protocol: ScannerProtocol; confidence: string }
		> = new Map(),
	) {}
	known(id: string): ScannerProtocol | null {
		const d = this.stored.get(id)
		if (!d || d.confidence !== "decoded") return null
		return (this.misses.get(id) ?? 0) < 2 ? d.protocol : null
	}
	recordMiss(id: string, protocol: ScannerProtocol): void {
		this.calls.push(`miss:${id}:${protocol}`)
		this.misses.set(id, (this.misses.get(id) ?? 0) + 1)
	}
	recordDecode(id: string): void {
		this.calls.push(`decode:${id}`)
		this.misses.set(id, 0)
	}
	forget(id: string): void {
		this.misses.delete(id)
	}
}

export interface HarnessOpts {
	request?: Partial<ScannerIdentifyRequest>
	port?: IdentifyAnalogEvidence | null
	discovery?: Discovery
	ambient?: IdentifyAmbientLookup
	narrowRasterAt?: (hz: number) => boolean
	rangeProtocolsAt?: (hz: number) => {
		protocols: readonly ScannerProtocol[]
		explicit: boolean
	}
	knownProtocols?: KnownProtocolMemory
	priors?: Partial<Record<ScannerProtocol, number>>
}

export function harness(opts: HarnessOpts = {}) {
	const settings = testSettings()
	const pool = poolHarness({ settings, cpuPercent: null })
	const record = identifyRecord()
	const inner = fakeInner(record, () => pool.clock.now)
	const tracks: IdentifyTrackView[] = []
	const events: ScannerIdentifyEventData[] = []
	const port = opts.port === undefined ? new FakePort() : opts.port
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
		artefactAt: () => Promise.resolve(null),
		liveTracks: () => tracks,
		lastSummary: () => summaryOf(),
		discoveryOf: () => opts.discovery,
		priorsAt: () => opts.priors ?? {},
		format: () => "U8_IQ",
		channelizer: () => false,
		settings: () => settings,
		emit: d => events.push(structuredClone(d)),
		logger: pino({ level: "silent" }),
		now: () => pool.clock.now,
		...(port ? { analogEvidence: port } : {}),
		...(opts.ambient ? { ambient: opts.ambient } : {}),
		...(opts.rangeProtocolsAt
			? { rangeProtocolsAt: opts.rangeProtocolsAt }
			: {}),
		...(opts.narrowRasterAt ? { narrowRasterAt: opts.narrowRasterAt } : {}),
		...(opts.knownProtocols ? { knownProtocols: opts.knownProtocols } : {}),
	})
	const advance = async (ms: number): Promise<void> => {
		pool.clock.now += ms
		runner.tick(pool.clock.now)
		pool.pool.pump()
		await flushAsync()
		await flushAsync()
	}
	const settle = async (stepMs = 1000, steps = 60): Promise<void> => {
		for (let i = 0; i < steps && !ENDED.includes(record.state); i++)
			await advance(stepMs)
	}
	const start = async (track: TrackSnapshot = trackOf({ obwHz: 11_000 })) => {
		await runner.start()
		tracks.push(viewOf(track))
		await advance(100)
		await advance(100)
		await flushAsync()
	}
	const last = () => events.at(-1)
	const trials = () =>
		Object.fromEntries((last()?.trials ?? []).map(t => [t.protocol, t.outcome]))
	return {
		...pool,
		port: port as FakePort,
		record,
		tracks,
		events,
		runner,
		advance,
		settle,
		start,
		last,
		trials,
	}
}

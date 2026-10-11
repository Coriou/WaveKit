import type {
	Classification,
	ConfidenceCap,
	DecodeEvidence,
	Identity,
	ObservationInput,
	ScannerClass,
	ScannerProtocol,
} from "../../../src/core/scanner/types.js"
import type { TrackSnapshot } from "../../../src/core/spectrum/types.js"

export interface ObsSpec {
	id: string
	centreHz: number
	startedAt: number
	durationMs?: number // default 1000
	open?: boolean // no endedAt
	blocks?: number // default 4
	obwHz?: number // default 9000
	snrDb?: number // default 20
	maxBlockSnrDb?: number // default snrDb
	thresholdDb?: number // default 9
	cls?: ScannerClass // default "unknown"
	hypotheses?: [ScannerProtocol, number][]
	cap?: ConfidenceCap
	tier?: "spectral" | "channel"
	jobIds?: string[] // default ["job-1"]
	sourceId?: string // default "src-1"
	truncated?: boolean
	edge?: boolean
	burst?: boolean // short-path burst track (Task 10a)
	iqImage?: boolean // IQ mirror image (Task 11a)
	spur?: boolean // on a spur line (Task 7a)
	sweep?: boolean // singleBlockSurfacingAllowed
}

export function classification(
	cls: ScannerClass,
	hypotheses: [ScannerProtocol, number][] = [],
	cap?: ConfidenceCap,
	tier: "spectral" | "channel" = "spectral",
): Classification {
	const c: Classification = {
		class: cls,
		hypotheses: hypotheses
			.map(([protocol, score]) => ({ protocol, score }))
			.sort((a, b) => b.score - a.score),
		tier,
	}
	if (cap !== undefined) c.cap = cap
	return c
}

export function makeTrack(s: ObsSpec): TrackSnapshot {
	const snrDb = s.snrDb ?? 20
	return {
		trackId: `t-${s.id}`,
		sourceId: s.sourceId ?? "src-1",
		stream: 1,
		epoch: 1,
		startSample: s.startedAt * 2048,
		lastSample: (s.startedAt + (s.durationMs ?? 1000)) * 2048,
		centreHz: s.centreHz,
		obwHz: s.obwHz ?? 9000,
		obwMethod: "-20dB",
		peakDbfs: -80 + snrDb + 5,
		meanDbfs: -80 + snrDb,
		snrDb,
		floorDbfs: -80,
		thresholdDb: s.thresholdDb ?? 9,
		blocks: s.blocks ?? 4,
		maxBlockSnrDb: s.maxBlockSnrDb ?? snrDb,
		dutyCycle: 1,
		spectralShape: "flat",
		flags: {
			overload: false,
			gap: false,
			truncated: s.truncated ?? false,
			edge: s.edge ?? false,
			skirt: false,
			obwBiased: false,
			burst: s.burst ?? false,
			iqImage: s.iqImage ?? false,
			spur: s.spur ?? false,
		},
		tuningTrust: "commanded",
	}
}

export function makeObs(s: ObsSpec): ObservationInput {
	const obs: ObservationInput = {
		id: s.id,
		sourceId: s.sourceId ?? "src-1",
		jobIds: s.jobIds ?? ["job-1"],
		track: makeTrack(s),
		classification: classification(
			s.cls ?? "unknown",
			s.hypotheses ?? [],
			s.cap,
			s.tier ?? "spectral",
		),
		startedAt: s.startedAt,
		singleBlockSurfacingAllowed: s.sweep ?? false,
	}
	if (s.open !== true) {
		obs.endedAt = s.startedAt + (s.durationMs ?? 1000)
		obs.endReason = "quiet"
	}
	return obs
}

export function evidence(
	protocol: ScannerProtocol,
	at: number,
	extra: {
		identity?: Identity
		encrypted?: boolean
		crcClean?: boolean
		talkgroups?: string[]
	} = {},
): DecodeEvidence {
	const ev: DecodeEvidence = {
		protocol,
		metadata:
			extra.talkgroups !== undefined ? { talkgroups: extra.talkgroups } : {},
		crcClean: extra.crcClean ?? true,
		at,
		epoch: 1,
		origin: "probe",
	}
	if (extra.identity !== undefined) ev.identity = extra.identity
	if (extra.encrypted !== undefined) ev.encrypted = extra.encrypted
	return ev
}

export const dmrCc = (cc: number): Identity => ({
	kind: "dmr-cc",
	value: String(cc),
})

/** Sequential ids so tests are deterministic. */
export function counterIds(): () => string {
	let n = 0
	return () => {
		n += 1
		return n.toString(36).toUpperCase().padStart(26, "0")
	}
}

/**
 * Identify mode (spec § 10.8, the primary use case): "what is this signal?" for one waterfall
 * target or every surfaced emission in the window. Never retunes. A target on an artefact mask
 * (DC, spur or comb tooth, IQ image; § 4.9) is answered without a trial; otherwise every plausible
 * decoder tries the resolved track: sequential `offset` probes with pre-roll at identify priority
 * before the channelizer, parallel probes within `maxProbes.channel` after it (Task 40), stopping
 * at the first H2-accepted identity unless `exhaustive`. The pure planning functions carry P25.
 * IdentifyRunner decorates the job's in-window JobRunner, which keeps the lifecycle (transition
 * table), the engine reference and the teardown.
 */
import { DQ_DATA_HOLD_MS } from "./data-decode-gate.js"
import type {
	DiscoveryMetadata,
	ScanJobProgress,
	ScannerIdentifyAnalog,
	ScannerIdentifyEventData,
	ScannerIdentifyMeasurements,
	ScannerIdentifyRequest,
	ScannerIdentifyResult,
	ScannerIdentifyState,
	ScannerIdentifyTrial,
	ScannerIdentifyView,
	ScannerAmbientDecoderType,
	ScannerProbeDecoderType,
	ScannerTrialOutcome,
	TuningTrust,
} from "@wavekit/api-types"
import {
	IDENTIFY_AMBIENT_MAX_TRIALS,
	DCS_STANDARD_CODES,
	IDENTIFY_ANALOG_LOOKBACK_MS,
	IDENTIFY_WAIT_DEFAULT_MS,
	IDENTIFY_WAIT_MAX_MS,
	IDENTIFY_WAIT_MIN_MS,
	SCANNER_AMBIENT_DECODER_PROTOCOL,
	SCANNER_AMBIENT_PROTOCOLS,
	SCANNER_AMBIENT_TARGET_TOLERANCE_HZ,
} from "@wavekit/api-types"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import { CTCSS_HZ } from "../audio-tones/ctcss.js"
import type { ArtefactKind } from "../spectrum/artefacts.js"
import {
	USABLE_FRACTION,
	type EngineEpoch,
} from "../spectrum/spectrum-engine.js"
import type { BlockSummary, TrackSnapshot } from "../spectrum/types.js"
import {
	classHypotheses,
	classOf,
	classifySpectral,
	protocolPrior,
} from "./classify/classifier.js"
import { proofFromFacts } from "./proof.js"
import { ScannerApiError } from "./errors.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import { replayMissEligible } from "../iq-capture/replay-miss.js"
import {
	IDENTIFY_REPLAY_MAX_CAPTURES,
	IQ_REPLAY_MAX_TRIALS,
	type IqCapturePort,
	type IqCaptureRefusal,
	type IqCaptureRequest,
	type IqCaptureView,
} from "./iq-capture-contract.js"

/**
 * WG11 req 6.8 (review M2): the capture port as identify uses it. With `captureFor` and `view` (the
 * capture service), a capture identify requests is held for the job from the start, so the replay
 * queue never takes it over; without them, the frozen port alone (claimed once finished).
 */
export type IdentifyIqCapture = IqCapturePort & {
	captureFor?(
		req: IqCaptureRequest,
		holder: string,
	): { captureId: string } | { refused: IqCaptureRefusal }
	view?(captureId: string): IqCaptureView | null
}
import type {
	AnalogEvidenceTransmission,
	IdentifyAnalogEvidence,
} from "./identify-analog-contract.js"
import {
	ANALOG_TRIAL_FRAME_MS,
	ANALOG_TRIAL_MAX_FRAMES,
	type AnalogTrialMode,
	type AnalogTrialRunner,
} from "./scanner-redesign-contract.js"
import {
	JOB_STARTUP_CAP_MS,
	type JobDriver,
	type JobRecord,
} from "./job-runner.js"
import type { JobEvent } from "./job-state.js"
import type { KnownProtocolMemory } from "./known-protocol-contract.js"
import { PROTOCOL_DECODER, probeTransportFor } from "./plan/plan-preview.js"
import {
	probeModesFor,
	type ProbeMode,
	type ProbePool,
	type ProbeRequest,
} from "./probes/probe-pool.js"
import type {
	DecodeEvidence,
	Discovery,
	Hypothesis,
	Identity,
	ScannerClass,
	ScannerConfidence,
	ScannerProtocol,
	ScannerSettings,
	ScannerProof,
} from "./types.js"

export const IDENTIFY_DEFAULT_TIMEOUT_MS = 15_000
/** Above every job priority (0–100): identify trials preempt passive and job probes at once. */
export const IDENTIFY_PROBE_PRIORITY = 101
/** Every run lasts at least the DMR late-entry hold (§ 6.4 row 1): the click may come mid-call. */
export const IDENTIFY_MIN_HOLD_MS = 1800
/** A run that gets no probe slot within this time is reported `skipped-budget`. */
export const IDENTIFY_QUEUE_WAIT_MS = 3000
/** Trials are planned once the track has 300 ms of envelope at 50 ms blocks (the § 6.2 ACF test), or closed. */
export const IDENTIFY_SETTLE_BLOCKS = 6
export const IDENTIFY_MIN_TOLERANCE_HZ = 1000
export const IDENTIFY_ALL_MAX_TARGETS = 16
export const IDENTIFY_CANDIDATE_SCORE = 0.5
/** Weight of a class the bandwidth allows but the spectral features did not pick. */
export const IDENTIFY_ALT_CLASS_WEIGHT = 0.5
export const IDENTIFY_ANALOG_MIN_SCORE = 0.3
/** Relative slack on each class's OBW window (below 20 dB SNR the OBW is the on-bin width). */
export const IDENTIFY_OBW_SLACK = 0.25
/**
 * WG11 req 1.3: the floor score of the narrow digital trials (`nxdn48`, `dpmr`, `dstar`) on a target inside a
 * band plan range listing a raster of at most 6 250 Hz, before the bandplan prior.
 */
export const IDENTIFY_NARROW_DIGITAL_MIN_SCORE = 0.3
/** WG11 req 1.3: the classes whose hypotheses a narrow raster adds, and the protocols taken from them. */
const NARROW_DIGITAL_CLASSES: readonly ScannerClass[] = [
	"fsk4-6k25",
	"gmsk-narrow",
]
const NARROW_DIGITAL_PROTOCOLS: ReadonlySet<ScannerProtocol> =
	new Set<ScannerProtocol>(["nxdn48", "dpmr", "dstar"])
/** Ended identify jobs kept listed (they are never persisted). */
export const IDENTIFY_KEEP_JOBS = 50
/** WG11 req 6.8: how long a requested capture may take to finish once the live runs are over. */
export const IDENTIFY_REPLAY_CAPTURE_WAIT_MS = 2000
/**
 * Wall-clock cap for one analog replay trial.
 * ANALOG_TRIAL_MAX_FRAMES × ANALOG_TRIAL_FRAME_MS is the longest capture
 * (IQ_CAPTURE_MAX_MS, 4 000 ms). ANALOG_REPLAY_TRIAL_SLACK_MS bounds process
 * startup and the tone pass after the last statistics frame.
 * 80 × 50 + 1 000 = 5 000.
 */
const ANALOG_REPLAY_TRIAL_SLACK_MS = 1_000
export const ANALOG_REPLAY_TRIAL_DEADLINE_MS =
	ANALOG_TRIAL_MAX_FRAMES * ANALOG_TRIAL_FRAME_MS + ANALOG_REPLAY_TRIAL_SLACK_MS
/** The classifier's burst limit (Task 11): a track this short may be an OOK burst. */
const BURST_MAX_BLOCKS = 4

/** Protocols a trial can name; `digital-unknown`, `carrier` and `unknown` are not decoders. */
export const IDENTIFY_PROTOCOLS: readonly ScannerProtocol[] = [
	"analog-fm",
	"analog-am",
	"dmr",
	"p25p1",
	"p25p2",
	"nxdn48",
	"nxdn96",
	"ysf",
	"dstar",
	"dpmr",
	"pocsag",
	"flex",
	"aprs",
	"ism",
	// WG7 req 1.7: ambient-only protocols (no probe decoder; named by a decoder already running there).
	"ais",
	"acars",
	"vdl2",
	"lora",
	"adsb",
]

/**
 * WG7 req 1.5: one running ambient decoder whose target frequency lies within the identify target's tolerance
 * (structurally the `AmbientCoverage` of `probes/ambient.ts`).
 */
export type AmbientCoverageLike = {
	decoderId: string
	type: ScannerAmbientDecoderType
	protocol: ScannerProtocol
}

export type IdentifyAmbientLookup = (
	sourceId: string,
	hz: number,
	toleranceHz: number,
) => readonly AmbientCoverageLike[]

/** OBW window (Hz) of each bandwidth-defined class (§ 6.1; Task 11's class limits). */
export const CLASS_OBW_HZ: Readonly<
	Partial<Record<ScannerClass, readonly [number, number]>>
> = {
	"fsk4-12k5": [6000, 10_500],
	"fsk4-6k25": [2500, 5500],
	"gmsk-narrow": [4000, 7500],
	"fsk2-wide": [8000, 14_000],
	"afsk-fm": [7500, 18_000],
	"analog-fm": [7500, 18_000],
	"ook-burst": [0, 25_000],
}

/** The class whose § 6.4 mode list holds a protocol's probe mode. */
const MODE_CLASS: Readonly<Partial<Record<ScannerProtocol, ScannerClass>>> = {
	dmr: "fsk4-12k5",
	p25p1: "fsk4-12k5",
	p25p2: "fsk4-12k5",
	ysf: "fsk4-12k5",
	nxdn96: "fsk4-12k5",
	dstar: "gmsk-narrow",
	nxdn48: "fsk4-6k25",
	dpmr: "fsk4-6k25",
	pocsag: "fsk2-wide",
	flex: "fsk2-wide",
	aprs: "afsk-fm",
	ism: "ook-burst",
}

export type NormalisedIdentify = Omit<ScannerIdentifyView, "targets"> & {
	/** WG12 req 6.1: stay waiting until a gated transmission. Absent: today's path. */
	waitUntilSignal?: boolean
	/** Give up that wait after this many ms. Absent: IDENTIFY_WAIT_DEFAULT_MS. */
	waitMs?: number
}

export interface IdentifyTrackView {
	observationId: string
	trackId: string
	epoch: number
	/** Null until the store surfaced the observation (§ 7.2). */
	discoveryId: string | null
	track: TrackSnapshot
}

export interface IdentifyRun {
	key: string
	/** The first protocol's mode, covering every protocol of the run. */
	mode: ProbeMode
	cls: ScannerClass
	protocols: ScannerProtocol[]
	/** Without the probe start latency (added when the run starts). */
	holdMs: number
}

export interface IdentifyPlannedTrial {
	protocol: ScannerProtocol
	score: number
	decoder: ScannerIdentifyTrial["decoder"]
	mode: string | null
	transport: "offset" | "channel" | "ambient" | null
	reason?: NonNullable<ScannerIdentifyTrial["reason"]>
	run: number | null
}

export interface IdentifyPlan {
	trials: IdentifyPlannedTrial[]
	runs: IdentifyRun[]
}

export interface TrialSeen {
	output: boolean
	crcFailures: number
	identity: Identity | null
}

export function normaliseIdentify(
	r: ScannerIdentifyRequest,
): NormalisedIdentify {
	return {
		target:
			"all" in r.target
				? { all: true }
				: {
						frequencyHz: r.target.frequencyHz,
						...(r.target.bandwidthHz !== undefined
							? { bandwidthHz: r.target.bandwidthHz }
							: {}),
					},
		timeoutMs: r.timeoutMs ?? IDENTIFY_DEFAULT_TIMEOUT_MS,
		protocols: [...new Set(r.protocols ?? [])],
		exhaustive: r.exhaustive ?? false,
		record: r.record ?? true,
		...(r.waitUntilSignal === true ? { waitUntilSignal: true as const } : {}),
		...(r.waitUntilSignal === true &&
		typeof r.waitMs === "number" &&
		Number.isFinite(r.waitMs)
			? { waitMs: r.waitMs }
			: {}),
	}
}

/** § 10.8: a track resolves the target within max(1 kHz, bw/2). */
export function toleranceHz(bandwidthHz: number | undefined): number {
	return Math.max(IDENTIFY_MIN_TOLERANCE_HZ, (bandwidthHz ?? 0) / 2)
}

export function inWindow(
	hz: number,
	bandwidthHz: number,
	window: { centreHz: number; sampleRateHz: number },
	usableFraction: number,
): boolean {
	return (
		Math.abs(hz - window.centreHz) + bandwidthHz / 2 <=
		(window.sampleRateHz * usableFraction) / 2
	)
}

/** The classes the track's bandwidth and features allow, the spectral class first. */
export function compatibleClasses(track: TrackSnapshot): ScannerClass[] {
	const own = classOf(track)
	if (own === "wideband") return [own]
	const out: ScannerClass[] = [own]
	if (track.obwHz <= 18_000 * (1 + IDENTIFY_OBW_SLACK) && own !== "analog-fm")
		out.push("analog-fm")
	if (own === "carrier") return out
	const short = track.flags.burst || track.blocks <= BURST_MAX_BLOCKS
	for (const [cls, window] of Object.entries(CLASS_OBW_HZ) as [
		ScannerClass,
		readonly [number, number],
	][]) {
		if (out.includes(cls) || (cls === "ook-burst" && !short)) continue
		if (
			track.obwHz >= window[0] * (1 - IDENTIFY_OBW_SLACK) &&
			track.obwHz <= window[1] * (1 + IDENTIFY_OBW_SLACK)
		)
			out.push(cls)
	}
	return out
}

/**
 * § 10.8 plausible decoders: every identify protocol some compatible class lists, scored
 * hypothesis × class weight × bandplan prior (missing = 1), bounded only by explicit protocols,
 * best first (ties by name). Priors never exclude a protocol. WG11 req 1.3: with `narrow` (the target lies on a
 * <= 6.25 kHz raster) `nxdn48`, `dpmr` and `dstar` are scored at least IDENTIFY_NARROW_DIGITAL_MIN_SCORE before the
 * prior, whatever the track's width; absent or false: today's scores.
 */
export function identifyScores(
	track: TrackSnapshot,
	ctx: {
		priors: Partial<Record<ScannerProtocol, number>>
		protocols: readonly ScannerProtocol[]
		narrow?: boolean
		/** Non-explicit defaults order trials without excluding protocols. */
		explicit?: boolean
	},
): Hypothesis[] {
	const classes = compatibleClasses(track)
	const own = classes[0]
	const only =
		ctx.explicit !== false && ctx.protocols.length > 0
			? new Set(ctx.protocols)
			: null
	const best = new Map<ScannerProtocol, number>()
	for (const cls of classes) {
		const weight = cls === own ? 1 : IDENTIFY_ALT_CLASS_WEIGHT
		for (const h of classHypotheses(cls, ctx.priors)) {
			if (
				(own === "carrier" && h.protocol !== "analog-fm") ||
				!IDENTIFY_PROTOCOLS.includes(h.protocol) ||
				SCANNER_AMBIENT_PROTOCOLS.includes(h.protocol) ||
				(only && !only.has(h.protocol))
			)
				continue
			const score = Math.min(
				1,
				Math.max(0, h.score * weight * protocolPrior(ctx.priors[h.protocol])),
			)
			if (score > (best.get(h.protocol) ?? 0)) best.set(h.protocol, score)
		}
	}
	if (ctx.narrow === true) {
		for (const cls of NARROW_DIGITAL_CLASSES) {
			const weight = cls === own ? 1 : IDENTIFY_ALT_CLASS_WEIGHT
			for (const h of classHypotheses(cls, ctx.priors)) {
				if (
					!NARROW_DIGITAL_PROTOCOLS.has(h.protocol) ||
					(only && !only.has(h.protocol))
				)
					continue
				const base = Math.max(
					h.score * weight,
					IDENTIFY_NARROW_DIGITAL_MIN_SCORE,
				)
				const score = Math.min(
					1,
					Math.max(0, base * protocolPrior(ctx.priors[h.protocol])),
				)
				if (score > (best.get(h.protocol) ?? 0)) best.set(h.protocol, score)
			}
		}
	}
	// An explicit request can try a protocol even outside its expected bandwidth.
	for (const protocol of new Set<ScannerProtocol>([
		"analog-fm",
		...(only ?? []),
	])) {
		if (
			SCANNER_AMBIENT_PROTOCOLS.includes(protocol) ||
			(only && !only.has(protocol)) ||
			(!only && protocol === "analog-fm" && !classes.includes("analog-fm"))
		)
			continue
		const base =
			protocol === "analog-fm" && classes.includes("analog-fm")
				? IDENTIFY_ANALOG_MIN_SCORE
				: 0.01
		const score = Math.min(1, base * protocolPrior(ctx.priors[protocol]))
		best.set(protocol, Math.max(best.get(protocol) ?? 0, score))
	}
	if (ctx.explicit === false && ctx.protocols.length > 0) {
		for (const [protocol, score] of best)
			if (!ctx.protocols.includes(protocol)) best.set(protocol, score * 0.5)
	}
	return [...best]
		.map(([protocol, score]) => ({ protocol, score }))
		.sort((a, b) => b.score - a.score || a.protocol.localeCompare(b.protocol))
}

/** The § 6.4 probe mode that decodes one protocol, or null (no decoder, or ISM before Task 40). */
export function identifyModeFor(protocol: ScannerProtocol): ProbeMode | null {
	const cls = MODE_CLASS[protocol]
	return cls ? (probeModesFor(cls, [protocol])[0] ?? null) : null
}

function modeKey(mode: ProbeMode): string {
	return `${mode.decoderType}:${JSON.stringify(mode.options)}`
}

function modeLabel(mode: ProbeMode): string {
	const m = mode.options["mode"]
	return typeof m === "string" ? m : mode.decoderType
}

/** One trial per scored protocol; protocols that share a probe mode share one run (P25). */
export function planIdentifyTrials(
	scores: readonly Hypothesis[],
	opts: { format: string; channelizer: boolean },
): IdentifyPlan {
	const trials: IdentifyPlannedTrial[] = []
	const runs: IdentifyRun[] = []
	for (const h of scores) {
		const pt = probeTransportFor(h.protocol, opts.format, opts.channelizer)
		const mode = pt.transport ? identifyModeFor(h.protocol) : null
		const cls = MODE_CLASS[h.protocol]
		if (!pt.transport || !mode || !cls) {
			trials.push({
				protocol: h.protocol,
				score: h.score,
				decoder: PROTOCOL_DECODER[h.protocol],
				mode: null,
				transport: null,
				reason: pt.reason ?? "no-decoder",
				run: null,
			})
			continue
		}
		const key = modeKey(mode)
		let index = runs.findIndex(r => r.key === key)
		if (index < 0) {
			runs.push({
				key,
				mode: { ...mode, covers: [] },
				cls,
				protocols: [],
				holdMs: IDENTIFY_MIN_HOLD_MS,
			})
			index = runs.length - 1
		}
		const run = runs[index]!
		run.protocols.push(h.protocol)
		run.mode = {
			...run.mode,
			covers: [...new Set([...run.mode.covers, ...mode.covers])],
		}
		run.holdMs = Math.max(run.holdMs, mode.holdMs)
		trials.push({
			protocol: h.protocol,
			score: h.score,
			decoder: mode.decoderType,
			mode: modeLabel(mode),
			transport: pt.transport,
			run: index,
		})
	}
	return { trials, runs }
}

/**
 * WG11 req 1.7 (pure): `scores` with the known protocol first (stable order otherwise, never a removal), so its
 * probe mode's run is the plan's first. Added at its own score (0 when the track did not suggest it) unless it
 * has no probe mode or the request's explicit protocol list excludes it.
 */
export function knownFirst(
	scores: readonly Hypothesis[],
	known: ScannerProtocol,
	priors: Partial<Record<ScannerProtocol, number>>,
	protocols: readonly ScannerProtocol[],
): Hypothesis[] {
	const prior = protocolPrior(priors[known])
	if (
		identifyModeFor(known) === null ||
		(protocols.length > 0 && !protocols.includes(known)) ||
		!(prior > 0)
	)
		return [...scores]
	const own = scores.find(h => h.protocol === known) ?? {
		protocol: known,
		score: 0,
	}
	return [own, ...scores.filter(h => h.protocol !== known)]
}

/**
 * WG7 req 1.5: one ambient trial per protocol a running ambient decoder covers at the target (deduplicated per
 * protocol, at most IDENTIFY_AMBIENT_MAX_TRIALS, ordered by decoder id), restricted to `protocols` when given.
 * A protocol `protocols` names explicitly without coverage is `unsupported`/`no-ambient-decoder`. The lookup
 * gets the target's own tolerance, never below SCANNER_AMBIENT_TARGET_TOLERANCE_HZ. A missing or throwing
 * lookup is no coverage (fail closed). Ambient trials hold no run and no probe (`run: null`, score 0).
 */
export function planAmbientTrials(
	target: { sourceId: string; hz: number; toleranceHz: number },
	ambient: IdentifyAmbientLookup | undefined,
	protocols: readonly ScannerProtocol[],
	onError?: (err: unknown) => void,
): IdentifyPlannedTrial[] {
	const only = protocols.length > 0 ? new Set(protocols) : null
	let coverage: readonly AmbientCoverageLike[] = []
	if (ambient) {
		try {
			coverage = ambient(
				target.sourceId,
				target.hz,
				Math.max(target.toleranceHz, SCANNER_AMBIENT_TARGET_TOLERANCE_HZ),
			)
		} catch (err) {
			onError?.(err)
			coverage = []
		}
	}
	const byProtocol = new Map<ScannerProtocol, AmbientCoverageLike>()
	for (const c of [...coverage].sort((a, b) =>
		a.decoderId < b.decoderId ? -1 : a.decoderId > b.decoderId ? 1 : 0,
	)) {
		// Only a decoder type that names this protocol counts (defensive against a mismatched lookup).
		if (
			SCANNER_AMBIENT_DECODER_PROTOCOL[c.type] !== c.protocol ||
			!SCANNER_AMBIENT_PROTOCOLS.includes(c.protocol) ||
			(only && !only.has(c.protocol)) ||
			byProtocol.has(c.protocol)
		)
			continue
		byProtocol.set(c.protocol, c)
	}
	const trials: IdentifyPlannedTrial[] = [...byProtocol.values()]
		.slice(0, IDENTIFY_AMBIENT_MAX_TRIALS)
		.map(c => ({
			protocol: c.protocol,
			score: 0,
			decoder: c.type,
			mode: c.type,
			transport: "ambient",
			run: null,
		}))
	if (only) {
		for (const p of protocols) {
			if (!SCANNER_AMBIENT_PROTOCOLS.includes(p) || byProtocol.has(p)) continue
			const type = (
				Object.keys(
					SCANNER_AMBIENT_DECODER_PROTOCOL,
				) as ScannerAmbientDecoderType[]
			).find(k => SCANNER_AMBIENT_DECODER_PROTOCOL[k] === p)
			trials.push({
				protocol: p,
				score: 0,
				decoder: type ?? null,
				mode: null,
				transport: null,
				reason: "no-ambient-decoder",
				run: null,
			})
		}
	}
	return trials
}

/** The nearest candidate within the tolerance; the stronger one on equal distance. */
export function resolveTarget<T extends { track: TrackSnapshot }>(
	hz: number,
	tolHz: number,
	candidates: readonly T[],
): T | null {
	let best: T | null = null
	let bestDistance = Number.POSITIVE_INFINITY
	for (const c of candidates) {
		const d = Math.abs(c.track.centreHz - hz)
		if (d > tolHz) continue
		if (
			d < bestDistance ||
			(d === bestDistance && best !== null && c.track.snrDb > best.track.snrDb)
		) {
			best = c
			bestDistance = d
		}
	}
	return best
}

/** What one protocol's trial saw during its run (H2: an identity is an accepted one). */
export function trialOutcome(
	seen: TrialSeen | undefined,
): "decoded" | "no-sync" | "crc-errors" | "timeout" {
	if (!seen || !seen.output) return "no-sync"
	if (seen.identity) return "decoded"
	return seen.crcFailures > 0 ? "crc-errors" : "timeout"
}

/** WG10 req 3.4: what the verdict needs from matching analog evidence (absent/null: none). */
export interface IdentifyVerdictAnalog {
	/** The reported transmission carried a CTCSS tone or a DCS code. */
	tone: boolean
	/** Its frequency trust is `commanded` or `relay`. */
	trusted: boolean
}

export function identifyVerdict(v: {
	artefact: ArtefactKind | null
	decoded: boolean
	heardIdentity: boolean
	discoveryConfidence: ScannerConfidence | null
	topScore: number
	analog?: IdentifyVerdictAnalog | null
}): "identified" | "candidate" | "unidentified" {
	try {
		if (v.artefact) return "unidentified"
		if (v.decoded === true) return "identified"
		if (v.heardIdentity === true) return "candidate" // an identity capped by a leak/intermod flag (§ 6.2)
		// WG10 req 3.4: a digital decode wins; analog voice is identified only with a reported tone on a trusted frequency.
		if (
			v.analog &&
			typeof v.analog.tone === "boolean" &&
			typeof v.analog.trusted === "boolean"
		)
			return v.analog.tone === true && v.analog.trusted === true
				? "identified"
				: "candidate"
		return "unidentified"
	} catch {
		return "unidentified"
	}
}

/** Completed unsuccessful digital trials prove the attempt, never a protocol label. */
export function identifyDigitalProof(
	trials: readonly ScannerIdentifyTrial[],
	observationId: string,
	at: number,
): ScannerProof | null {
	try {
		const decoders = new Set([
			"dsd-fme",
			"multimon-ng",
			"direwolf",
			"rtl433",
			"ais-catcher",
			"acarsdec",
			"dumpvdl2",
			"lora-meshtastic",
			"readsb",
			"live-audio",
			"analog-demod",
			null,
		])
		const transports = new Set(["offset", "channel", "ambient", "replay", null])
		const outcomes = new Set([
			"not-needed",
			"pending",
			"running",
			"decoded",
			"no-sync",
			"crc-errors",
			"timeout",
			"unsupported",
			"cancelled",
			"heard",
			"data-like",
			"carrier-only",
		])
		if (
			!trials.every(
				t =>
					t !== null &&
					IDENTIFY_PROTOCOLS.includes(t.protocol) &&
					decoders.has(t.decoder) &&
					transports.has(t.transport) &&
					(t.mode === null || typeof t.mode === "string") &&
					outcomes.has(t.outcome) &&
					(t.outcome === "unsupported" ||
						(t.decoder !== null && t.transport !== null)),
			)
		)
			return null
		const digital = trials.filter(
			t =>
				t.decoder !== "live-audio" &&
				t.decoder !== "analog-demod" &&
				t.decoder !== null &&
				t.outcome !== "unsupported" &&
				t.outcome !== "not-needed",
		)
		const dataLike = trials.filter(
			t =>
				t.decoder === "analog-demod" &&
				IDENTIFY_ANALOG_PROTOCOLS.includes(t.protocol) &&
				t.outcome === "data-like",
		)
		if (
			(digital.length === 0 && dataLike.length === 0) ||
			!digital.every(t => t.outcome === "no-sync" || t.outcome === "timeout") ||
			trials.some(t => t.outcome === "decoded" || t.outcome === "heard")
		)
			return null
		const supporting = [...digital, ...dataLike]
		return proofFromFacts(
			{
				observationId,
				decodes: [],
				analog: [],
				unavailable: [],
				trust: "unverified",
				digitalPlanComplete: true,
				trials: digital.map((t, order) => ({
					protocol: t.protocol,
					decoder: t.decoder ?? "",
					outcome: t.outcome,
					order,
					at,
				})),
			},
			{
				kind: "digital-undecoded",
				protocol: "digital-unknown",
				transport: supporting.every(t => t.transport === "replay")
					? "replay"
					: "live",
				at,
				encrypted: false,
			},
		)
	} catch {
		return null
	}
}

/**
 * WG10 R2: how long past its deadline an analog trial with an open (or not yet published) match waits
 * for that transmission's closed event: the tracker's merge gap (1500 ms) plus the squelch hang
 * (250 ms), since a transmission whose audio ended by the deadline is final at most that late. Fixed
 * from the deadline, so the wait is bounded whatever the evidence does.
 *
 * Detection quality R4.3: the data decode gate holds each closed event DQ_DATA_HOLD_MS before the
 * evidence log sees it, so 1 750 + 1 000 = 2 750 ms. Applied unconditionally: identify does not know
 * whether the composition wires a gate, the extra second only applies to a trial that still has an
 * open match at its deadline, and a closed match decides at once, so it never delays a decided trial.
 */
export const IDENTIFY_ANALOG_SETTLE_MS = 1_500 + 250 + DQ_DATA_HOLD_MS

/** WG10 req 3.2: the analog protocols live-audio evidence answers, and the modulations that answer each. */
export const IDENTIFY_ANALOG_PROTOCOLS: readonly ScannerProtocol[] = [
	"analog-fm",
	"analog-am",
]
const ANALOG_MODULATIONS: Readonly<
	Partial<Record<ScannerProtocol, ReadonlySet<string>>>
> = {
	"analog-fm": new Set(["nfm", "wfm"]),
	"analog-am": new Set(["am", "dsb"]),
}

export interface AnalogTarget {
	sourceId: string
	hz: number
	toleranceHz: number
	/** Job start − IDENTIFY_ANALOG_LOOKBACK_MS. */
	sinceMs: number
	/** The job/ambient end: a transmission that ended after it is not this job's evidence. */
	untilMs?: number
}

const ANALOG_CTCSS: ReadonlySet<number> = new Set(CTCSS_HZ)
const ANALOG_DCS: ReadonlySet<string> = new Set(DCS_STANDARD_CODES)

/**
 * WG10 req 3.1/3.2 (pure, fail closed): the port's transmissions that answer `protocol` at the target,
 * re-checked here whatever the port returned: same source, finite frequency within the tolerance,
 * a modulation of the protocol, open or ended at or after `sinceMs` (and at or before `untilMs` when
 * given). `closed` newest first.
 */
export function analogMatches(
	transmissions: readonly AnalogEvidenceTransmission[],
	target: AnalogTarget,
	protocol: ScannerProtocol,
): { closed: AnalogEvidenceTransmission[]; open: boolean } {
	const modulations = ANALOG_MODULATIONS[protocol]
	const closed: AnalogEvidenceTransmission[] = []
	let open = false
	if (!modulations || !Array.isArray(transmissions)) return { closed, open }
	for (const x of transmissions) {
		if (
			typeof x !== "object" ||
			x === null ||
			// Detection quality R4.2: a data burst (pager, APRS) is not analog evidence.
			x.data === true ||
			x.sourceId !== target.sourceId ||
			typeof x.hz !== "number" ||
			!Number.isFinite(x.hz) ||
			!(Math.abs(x.hz - target.hz) <= target.toleranceHz) ||
			!modulations.has(x.modulation)
		)
			continue
		if (x.endedAtMs === null) open = true
		else if (
			typeof x.endedAtMs === "number" &&
			Number.isFinite(x.endedAtMs) &&
			x.endedAtMs >= target.sinceMs &&
			(target.untilMs === undefined || x.endedAtMs <= target.untilMs)
		)
			closed.push(x)
	}
	closed.sort((a, b) => (b.endedAtMs ?? 0) - (a.endedAtMs ?? 0))
	return { closed, open }
}

/** WG10 req 3.4 (pure): `result.analog` from the latest closed match; only what the tracker reported. */
export function analogResultOf(
	closed: readonly AnalogEvidenceTransmission[],
): ScannerIdentifyAnalog | null {
	const latest = closed[0]
	if (!latest) return null
	const modulation = latest.modulation
	if (
		modulation !== "nfm" &&
		modulation !== "wfm" &&
		modulation !== "am" &&
		modulation !== "dsb"
	)
		return null
	const ctcss = latest.ctcssHz
	const dcs = latest.dcs
	return {
		source: "live-audio",
		modulation,
		transmissions: closed.length,
		transmissionId: latest.transmissionId,
		// Re-checked against the standard tables as analog-evidence does: a non-standard tone is no tone.
		ctcssHz:
			typeof ctcss === "number" && ANALOG_CTCSS.has(ctcss) ? ctcss : null,
		dcs:
			dcs &&
			typeof dcs.code === "string" &&
			ANALOG_DCS.has(dcs.code) &&
			(dcs.polarity === "normal" || dcs.polarity === "inverted")
				? { code: dcs.code, polarity: dcs.polarity }
				: null,
		tuningTrust:
			latest.tuningTrust === "commanded" || latest.tuningTrust === "relay"
				? latest.tuningTrust
				: "unverified",
	}
}

/** WG10 req 3.4 (pure): the verdict input of `result.analog`. */
export function analogVerdictOf(
	a: ScannerIdentifyAnalog | null,
): IdentifyVerdictAnalog | null {
	if (!a) return null
	return {
		tone: a.ctcssHz !== null || a.dcs !== null,
		trusted: a.tuningTrust === "commanded" || a.tuningTrust === "relay",
	}
}

const ANALOG_TRIAL_OUTCOMES = new Set([
	"decoded",
	"heard",
	"data-like",
	"carrier-only",
	"no-sync",
])

/**
 * A replay verdict the runner will trust. An error, a missing body or an unknown outcome is
 * no verdict (the trial is cancelled). Tones are re-checked separately.
 */
function parseAnalogTrial(raw: unknown): {
	outcome: "decoded" | "heard" | "data-like" | "carrier-only" | "no-sync"
	mode: AnalogTrialMode
	tones: unknown
} | null {
	if (typeof raw !== "object" || raw === null) return null
	if (typeof (raw as { then?: unknown }).then === "function") return null
	const error = (raw as { error?: unknown }).error
	if (error !== undefined) return null
	const outcome = (raw as { outcome?: unknown }).outcome
	if (typeof outcome !== "string" || !ANALOG_TRIAL_OUTCOMES.has(outcome))
		return null
	const mode = (raw as { mode?: unknown }).mode
	if (mode !== "nfm" && mode !== "am") return null
	return {
		outcome: outcome as
			| "decoded"
			| "heard"
			| "data-like"
			| "carrier-only"
			| "no-sync",
		mode,
		tones: (raw as { tones?: unknown }).tones,
	}
}

/** A gated start the runner will time from. Anything else, including a promise, is no start. */
function parseGateStart(
	raw: unknown,
): { startSample: number; atMs: number } | null {
	if (typeof raw !== "object" || raw === null) return null
	if (typeof (raw as { then?: unknown }).then === "function") return null
	const startSample = (raw as { startSample?: unknown }).startSample
	const atMs = (raw as { atMs?: unknown }).atMs
	if (typeof startSample !== "number" || typeof atMs !== "number") return null
	if (!Number.isFinite(startSample) || startSample < 0) return null
	if (!Number.isFinite(atMs)) return null
	return { startSample, atMs }
}

/** Trust is only the three known answers. Anything else is unverified. */
function captureTrust(trust: unknown): TuningTrust {
	return trust === "commanded" || trust === "relay" ? trust : "unverified"
}

/** A standard CTCSS tone or DCS code. A heard result, or anything else, is no tone. */
function standardTone(tones: unknown): {
	ctcssHz: number | null
	dcs: ScannerIdentifyAnalog["dcs"]
} {
	if (typeof tones !== "object" || tones === null)
		return { ctcssHz: null, dcs: null }
	const ctcss = (tones as { ctcssHz?: unknown }).ctcssHz
	const dcs = (tones as { dcs?: unknown }).dcs
	let code: string | null = null
	let polarity: "normal" | "inverted" | null = null
	if (typeof dcs === "object" && dcs !== null) {
		const c = (dcs as { code?: unknown }).code
		const p = (dcs as { polarity?: unknown }).polarity
		if (typeof c === "string" && ANALOG_DCS.has(c)) code = c
		if (p === "normal" || p === "inverted") polarity = p
	}
	return {
		ctcssHz:
			typeof ctcss === "number" && ANALOG_CTCSS.has(ctcss) ? ctcss : null,
		dcs: code !== null && polarity !== null ? { code, polarity } : null,
	}
}

/**
 * WG10 req 3.2: with the analog port, the analog trials become ambient `live-audio` trials (no run, mode
 * unknown until a transmission matches). When either analog protocol is scored, or the request names one,
 * the other one is planned too (the classifier cannot tell FM from AM voice); `protocols` still restricts.
 */
export function planAnalogTrials(
	trials: readonly IdentifyPlannedTrial[],
	protocols: readonly ScannerProtocol[],
): IdentifyPlannedTrial[] {
	const live = (protocol: ScannerProtocol): IdentifyPlannedTrial => ({
		protocol,
		score: 0,
		decoder: "live-audio",
		mode: null,
		transport: "ambient",
		run: null,
	})
	const out = trials.map(p =>
		IDENTIFY_ANALOG_PROTOCOLS.includes(p.protocol) && p.run === null
			? { ...live(p.protocol), score: p.score }
			: p,
	)
	const only = protocols.length > 0 ? new Set(protocols) : null
	const wanted = only
		? IDENTIFY_ANALOG_PROTOCOLS.filter(p => only.has(p))
		: out.some(p => IDENTIFY_ANALOG_PROTOCOLS.includes(p.protocol))
			? IDENTIFY_ANALOG_PROTOCOLS
			: []
	for (const p of wanted)
		if (!out.some(x => x.protocol === p)) out.push(live(p))
	return out
}

const PROBE_DECODER_TYPES: ReadonlySet<string> =
	new Set<ScannerProbeDecoderType>([
		"dsd-fme",
		"multimon-ng",
		"direwolf",
		"rtl433",
	])

/**
 * WG10 req 3.5 (pure): the plan's trials whose run's decoder type `memo` names become `unsupported`/
 * `decoder-unavailable` with no mode, no transport and no run; `skip` holds the runs never to request,
 * `used` the memo types that matched a run (sorted).
 */
export function applyUnavailableMemo(
	plan: IdentifyPlan,
	memo: ReadonlySet<string>,
): {
	trials: IdentifyPlannedTrial[]
	skip: Set<number>
	used: ScannerProbeDecoderType[]
} {
	const skip = new Set<number>()
	const used = new Set<ScannerProbeDecoderType>()
	plan.runs.forEach((run, i) => {
		const type = run.mode.decoderType
		if (memo.has(type) && PROBE_DECODER_TYPES.has(type)) {
			skip.add(i)
			used.add(type as ScannerProbeDecoderType)
		}
	})
	const trials = plan.trials.map((p): IdentifyPlannedTrial => {
		if (p.run === null || !skip.has(p.run)) return p
		return {
			protocol: p.protocol,
			score: p.score,
			decoder: p.decoder,
			mode: null,
			transport: null,
			reason: "decoder-unavailable",
			run: null,
		}
	})
	return { trials, skip, used: [...used].sort() }
}

/** § 10.8 measurements: from the track, else the strongest summary bin within the tolerance. */
export function measureTarget(
	track: TrackSnapshot | null,
	summary: BlockSummary | null,
	targetHz: number,
	halfWidthHz: number,
): ScannerIdentifyMeasurements {
	if (track) {
		return {
			source: "track",
			centreHz: track.centreHz,
			obwHz: track.obwHz,
			peakDbfs: track.peakDbfs,
			snrDb: track.snrDb,
			floorDbfs: track.floorDbfs,
			dutyCycle: track.dutyCycle,
			...(track.acf30 !== undefined ? { acf30: track.acf30 } : {}),
			...(track.acf60 !== undefined ? { acf60: track.acf60 } : {}),
			class: classOf(track),
		}
	}
	let peak: number | null = null
	if (summary) {
		const half = Math.max(halfWidthHz, summary.binHz / 2)
		const lo = Math.max(
			0,
			Math.floor((targetHz - half - summary.startHz) / summary.binHz),
		)
		const hi = Math.min(
			summary.bins.length - 1,
			Math.floor((targetHz + half - summary.startHz) / summary.binHz),
		)
		for (let i = lo; i <= hi; i++) {
			const b = summary.bins[i]
			if (b !== undefined && (peak === null || b > peak)) peak = b
		}
	}
	const floor = summary?.floorDbfs ?? null
	return {
		source: "spectrum",
		centreHz: targetHz,
		obwHz: null,
		peakDbfs: peak,
		snrDb: peak !== null && floor !== null ? peak - floor : null,
		floorDbfs: floor,
		dutyCycle: null,
		class: "unknown",
	}
}

export interface IdentifyDeps {
	record: JobRecord
	identify: NormalisedIdentify
	/** The job's in-window JobRunner: transition table, engine reference, probe release on end, teardown. */
	inner: JobDriver
	probes: Pick<
		ProbePool,
		| "request"
		| "release"
		| "dequeue"
		| "startLatencyMs"
		| "status"
		| "on"
		| "off"
	> &
		ProbeUnavailableMemo
	engine: (sourceId: string) => { currentEpoch(): EngineEpoch } | undefined
	/**
	 * `artefactOf(hz, epoch, masks)` on the engine's current masks (Task 32 carries them from the worker).
	 * `stale`: the worker's masks are still for an older epoch (just after a retune); the runner asks again next tick.
	 */
	artefactAt: (
		sourceId: string,
		hz: number,
	) => Promise<ArtefactKind | null | "stale">
	/** Live observations with a track on the source (ScannerService.live). */
	liveTracks: (sourceId: string) => IdentifyTrackView[]
	lastSummary: (sourceId: string) => BlockSummary | null
	discoveryOf: (observationId: string) => Discovery | undefined
	/** Bandplan priors at a frequency (Task 12 `priorsFor` over the region's bandplans). */
	priorsAt: (hz: number) => Partial<Record<ScannerProtocol, number>>
	rangeProtocolsAt?: (hz: number) => {
		protocols: readonly ScannerProtocol[]
		explicit: boolean
	}
	format: (sourceId: string) => string
	/** True once the core channelizer serves probe channels (S2, Task 40): parallel trials. */
	channelizer: () => boolean
	settings: () => ScannerSettings
	emit: (data: ScannerIdentifyEventData) => void
	logger: Logger
	now: () => number
	/** WG7 req 1.5: running ambient decoders covering a frequency (AmbientEvidence.coverageAt). Absent: no ambient trials. */
	ambient?: IdentifyAmbientLookup
	/** WG10 req 3.1: the live demodulator's transmissions. Absent: analog trials stay `unsupported`/`no-decoder`. */
	analogEvidence?: IdentifyAnalogEvidence
	/**
	 * WG11 req 1.3: true when a band plan range of the active region containing `hz` lists a raster of at most
	 * 6 250 Hz. Absent (or throwing): no narrow digital trials are added, today's plan.
	 */
	narrowRasterAt?: (hz: number) => boolean
	/**
	 * WG11 req 1.7/1.8: the known-protocol memory. Absent: today's order and no miss or decode counting.
	 */
	knownProtocols?: KnownProtocolMemory
	/**
	 * WG11 req 6.8: the IQ capture port. Absent: no capture is claimed, requested or replayed, and the
	 * flow is unchanged.
	 */
	iqCapture?: IdentifyIqCapture
	/**
	 * WG12 req 6.1: the next gated transmission at a point target, or null. One call per waiting
	 * target per tick. Absent, or without `waitUntilSignal`: today's path.
	 */
	gatedAt?: (
		sourceId: string,
		hz: number,
		toleranceHz: number,
	) => { startSample: number; atMs: number } | null
	/**
	 * WG12 req 6.6: analog replay of a claimed capture whose plan includes analog. Absent: no
	 * `analog-demod` trial. The runner owns admission to the probe budget.
	 */
	analogTrial?: AnalogTrialRunner
}

/**
 * WG10 req 3.5: the probe pool's unavailable memo (`ProbePool.unavailableTypes`). Optional and checked at
 * run time: a pool without it, or one that throws, is an empty memo.
 */
export interface ProbeUnavailableMemo {
	unavailableTypes?: (now: number) => ReadonlySet<ScannerProbeDecoderType>
}

/** WG10: one target's analog evidence state. */
interface AnalogState {
	/** `monitoring` answered true on some tick of this target. */
	everMonitored: boolean
	/** WG10 R2: protocols with an open or pending match seen at or after the deadline (decided `timeout`). */
	openSeen: Set<ScannerProtocol>
	/** Evidence of the trial that decoded (the first one; the newest on a tie). */
	result: ScannerIdentifyAnalog | null
	resultProtocol: ScannerProtocol | null
}

interface RunState {
	runIndex: number
	run: IdentifyRun
	req: ProbeRequest
	probeId: string | null
	queuedUntil: number | null
	endsAt: number | null
	seen: Map<ScannerProtocol, TrialSeen>
	/** WG9 req 5.4: the pool reported this run's decoder program cannot run. */
	unavailable: boolean
	/**
	 * WG11 req 6.5: a replay run of a claimed capture. Its `runIndex` is -1 (it owns no trial; the live
	 * trials stay as they are unless the replay decodes or completes one); `planRun` is the plan run it repeats.
	 */
	replay?: { captureId: string; planRun: number }
	/** The pool reported the replay decoder's clean end (its verdict is the evidence seen). */
	replayDone: boolean
}

/** One step of a target's replay queue: a probe run, or the analog trial that shares that queue. */
type ReplayWork =
	| { kind: "probe"; captureId: string; planRun: number }
	| { kind: "analog"; captureId: string }

/** WG11 req 6.8: one target's IQ captures. */
interface ReplayState {
	/** Captures this job holds (claimed at plan, or once a requested one finished). */
	claimed: string[]
	/** each claimed capture's own epoch, observation and tuning trust (its replay carries them). */
	views: Map<
		string,
		{
			epoch: number
			observationId: string | null
			tuningTrust: TuningTrust
		}
	>
	/** Replay runs still to start; null until the live runs are over. */
	queue: ReplayWork[] | null
	/** A capture requested for the resolved track (at most once per target). */
	requested: string | null
	/** The requested capture is held for this job from the start (captureFor). */
	reserved: boolean
	asked: boolean
	waitUntil: number | null
}

interface TargetState {
	targetHz: number
	toleranceHz: number
	/** The target band for the window check: the request's bandwidth, or the collected track's OBW (`all`). */
	bandwidthHz: number
	state: ScannerIdentifyState
	deadline: number
	view: IdentifyTrackView | null
	/** The track resolved before an in-window epoch change: the verdict's evidence if nothing re-resolves. */
	fallback: IdentifyTrackView | null
	/** Decoder outcomes of runs completed before an in-window epoch change; a re-plan keeps them and skips their runs. */
	done: Map<ScannerProtocol, ScannerTrialOutcome>
	/** The resolved track closed: trials run on its last snapshot (pre-roll from the ring). */
	gone: boolean
	/** The start-of-target artefact check met stale masks: repeat it while waiting (§ 10.8 (1) "ends at once"). */
	recheckArtefact: boolean
	plan: IdentifyPlan | null
	trials: ScannerIdentifyTrial[]
	nextRun: number
	active: RunState[]
	decoded: { protocol: ScannerProtocol; identity: Identity } | null
	result: ScannerIdentifyResult | null
	/** WG7: running ambient trials end `timeout` at this time (the wait deadline, or plan time + timeoutMs for `all`). */
	ambientUntil: number
	/** WG10 req 3.5: plan runs not requested because the memo names their decoder type. */
	memoSkip: Set<number>
	analog: AnalogState
	replay: ReplayState
	/** WG11 req 1.7: the resolved discovery's known protocol at plan time (its run is first); null: none. */
	known: { discoveryId: string; protocol: ScannerProtocol } | null
	/** WG12: the gated start this target times from. Null until one is accepted. */
	gate: { startSample: number; atMs: number } | null
	/** Claimed captures that already have an analog replay trial. */
	analogArmed: Set<string>
	/**
	 * Captures whose analog replay decoded or was heard. R4.6: the remaining digital
	 * replays of that capture are not run. Other captures are unaffected.
	 */
	analogStopped: Set<string>
	/** In-flight analog replay trials. Aborted when the target ends or replans. */
	analogAbort: AbortController[]
	/** Per-trial wall-clock deadline (ANALOG_REPLAY_TRIAL_DEADLINE_MS from start). */
	analogDue: Map<AbortController, number>
}

const FINAL: ReadonlySet<ScannerIdentifyState> = new Set([
	"identified",
	"candidate",
	"unidentified",
])

/** Trial outcomes a decoder actually produced (kept across an in-window epoch change). */
const COMPLETED: ReadonlySet<ScannerTrialOutcome> = new Set([
	"decoded",
	// WG11 req 1.1: final like `decoded` (a live-audio match without a tone or code).
	"heard",
	"no-sync",
	"crc-errors",
	"timeout",
])

function emptyMetadata(): DiscoveryMetadata {
	return {
		talkgroups: [],
		sources: [],
		slots: [],
		callsigns: [],
		capcodes: [],
		ismModels: [],
	}
}

export class IdentifyRunner implements JobDriver {
	readonly record: JobRecord
	private readonly log: Logger
	private readonly targets: TargetState[] = []
	private phase: "idle" | "collecting" | "running" | "finished" = "idle"
	/** Artefact checks and probe releases in flight; tick waits for them. */
	private inflight = 0
	/** Set while this runner calls `probes.request` (the call's own "starting" is not a queued start). */
	private requesting = false
	private detached = false
	private ambientErrorLogged = false
	private analogErrorLogged = false
	/** WG12: a throwing gatedAt is logged once per job, with no frequency and no message. */
	private gateErrorLogged = false
	/** dispose() has run: a late analog result must not emit. */
	private disposed = false
	/** WG10 req 3.5: probe decoder types unavailable during this job (memo at planning, or reported). */
	private readonly unavailableTypes = new Set<ScannerProbeDecoderType>()
	/** Cancel / source-down: captures are settled once the probes are released. */
	private aborting = false

	constructor(private readonly deps: IdentifyDeps) {
		this.record = deps.record
		this.log = createComponentLogger(deps.logger, `Identify:${deps.record.id}`)
		deps.probes.on("probe-state", this.onProbeState)
		deps.probes.on("evidence", this.onPoolEvidence)
		deps.probes.on("decoder-unavailable", this.onDecoderUnavailable)
		if (deps.iqCapture) deps.probes.on("replay-end", this.onReplayEnd)
	}

	private get sourceId(): string {
		return this.record.spec.sourceId
	}

	/** `ScanJob.identify` (Task 25). The wait fields stay on the request, not this view. */
	view(): ScannerIdentifyView {
		const identify = this.deps.identify
		return {
			target: identify.target,
			timeoutMs: identify.timeoutMs,
			protocols: identify.protocols,
			exhaustive: identify.exhaustive,
			record: identify.record,
			targets: this.targets.map(t => this.eventOf(t)),
		}
	}

	// === JobDriver ===

	start(): Promise<void> {
		return this.deps.inner.start()
	}

	async dispatch(e: JobEvent): Promise<void> {
		switch (e.type) {
			case "pause":
			case "resume":
				throw new ScannerApiError(
					"Identify jobs cannot be paused; cancel it and identify again",
					"SCANNER_IDENTIFY_NOT_PAUSABLE",
					409,
				)
			case "source-down":
				// A 15 s identify does not wait for a reconnect: it ends with what it has (the stop-condition row).
				if (this.record.state === "starting")
					return this.failStartup({ type: "engine-failed" })
				return this.endWithResults()
			case "tuner-error":
				return this.failStartup(e)
			case "cancel":
			case "source-removed":
			case "engine-failed":
				if (e.type === "engine-failed" && this.record.state === "starting")
					return this.failStartup(e)
				await this.abort()
				try {
					await this.deps.inner.dispatch(e)
				} finally {
					this.detach()
				}
				return
			default:
				return this.deps.inner.dispatch(e)
		}
	}

	idle(): Promise<void> {
		return this.deps.inner.idle()
	}

	covers(sourceId: string, hz: number): boolean {
		if (!this.deps.inner.covers(sourceId, hz)) return false
		const target = this.deps.identify.target
		return (
			"all" in target ||
			Math.abs(hz - target.frequencyHz) <= toleranceHz(target.bandwidthHz)
		)
	}

	progress(): ScanJobProgress {
		return this.deps.inner.progress()
	}

	tick(now: number): void {
		if (
			this.record.state === "starting" &&
			this.phase !== "finished" &&
			now - this.record.createdAt >=
				Math.min(this.deps.identify.timeoutMs, JOB_STARTUP_CAP_MS)
		) {
			void this.failStartup({ type: "engine-failed" }).catch((err: unknown) =>
				this.log.warn({ err }, "Identify startup failed"),
			)
			return
		}
		this.deps.inner.tick(now)
		this.step(now)
	}

	onEpochStarted(epoch: EngineEpoch): void {
		this.deps.inner.onEpochStarted(epoch)
	}

	onBlock(endSample: number, overload: boolean): void {
		this.deps.inner.onBlock(endSample, overload)
	}

	onStale(blocks: number): void {
		this.deps.inner.onStale(blocks)
	}

	onTrack(): void {
		// Identify plans its own trials from tick(); the inner runner must not open window-hold probes.
	}

	onTrackClosed(trackId: string): void {
		this.deps.inner.onTrackClosed(trackId)
	}

	onUntrackedRetune(): void {
		this.deps.inner.onUntrackedRetune()
	}

	onEvidence(): void {
		// Trial outcomes come from the probe pool's own events (onPoolEvidence); the store has the evidence already.
	}

	/**
	 * An identify job never holds a lease (the in-window rows strip the lease actions, P5), so the arbiter never
	 * revokes one. Should it, the job ends like on source-down: probes released, results so far reported.
	 */
	leaseLost(): Promise<void> {
		return this.endWithResults()
	}

	/**
	 * § 10.8: whether identify owns the confirmation of a track at `hz` (other jobs then request no probe
	 * for it). Before and during the `all` collection that is everything it covers; afterwards only the
	 * tolerances of the targets still being identified.
	 */
	owns(sourceId: string, hz: number): boolean {
		if (this.phase === "finished" || !this.covers(sourceId, hz)) return false
		if (this.phase === "idle" || this.phase === "collecting") return true
		return this.targets.some(
			t => !FINAL.has(t.state) && Math.abs(hz - t.targetHz) <= t.toleranceHz,
		)
	}

	replan(): void {
		throw new ScannerApiError(
			"Identify jobs cannot be edited",
			"SCANNER_IDENTIFY_NOT_EDITABLE",
			409,
		)
	}

	async dispose(): Promise<void> {
		this.disposed = true
		for (const t of this.targets) this.stopAnalog(t)
		this.detach()
		await this.deps.inner.dispose()
	}

	// === the identify flow (tick-driven) ===

	private step(now: number): void {
		if (this.phase === "finished" || this.record.state !== "running") return
		// The window moved off a target (operator retune, sweep takeover): end it now with what it has.
		// This runs before the inflight return. Artefact checks and probe releases take that slot;
		// an analog replay trial does not.
		let moved = false
		for (const x of this.targets) {
			if (FINAL.has(x.state) || !this.windowMoved(x)) continue
			this.endMoved(x)
			moved = true
		}
		if (moved) return
		if (this.inflight > 0) return
		// First-IQ startup is separately capped; this budget bounds signal wait after readiness.
		const started = this.record.startedAt ?? now
		const { target, timeoutMs } = this.deps.identify
		if (this.phase === "idle") {
			if ("all" in target) {
				this.phase = "collecting"
			} else {
				this.phase = "running"
				const t = this.newTarget(
					target.frequencyHz,
					toleranceHz(target.bandwidthHz),
					target.bandwidthHz ?? 0,
					started + timeoutMs,
					null,
				)
				// § 10.8 (1): a target on an artefact mask ends at once, before any trial.
				this.checkArtefact(t, false)
				return
			}
		}
		if (this.phase === "collecting") {
			const found = this.currentTracks()
				.filter(
					v =>
						v.discoveryId !== null &&
						!v.track.flags.iqImage &&
						!v.track.flags.spur &&
						!v.track.flags.truncated,
				)
				.sort((a, b) => b.track.snrDb - a.track.snrDb)
				.slice(0, IDENTIFY_ALL_MAX_TARGETS)
			if (found.length === 0) {
				if (now >= started + timeoutMs) this.finishJob()
				return
			}
			this.phase = "running"
			// Each target's track is already resolved, so no wait deadline applies (a shared started + timeoutMs would
			// have passed by the time later targets get their turn); restartTarget gives one after an epoch change.
			// The window-move check looks at the centre only: detection keeps track centres in the usable span, but an
			// edge track's OBW may reach past it without the window having moved.
			for (const v of found)
				this.newTarget(
					v.track.centreHz,
					toleranceHz(v.track.obwHz),
					0,
					Number.POSITIVE_INFINITY,
					v,
				)
		}
		const t = this.targets.find(x => !FINAL.has(x.state))
		if (!t) {
			this.finishJob()
			return
		}
		if (t.state === "waiting-for-signal") this.waitStep(t, now)
		else this.tryStep(t, now)
	}

	private newTarget(
		targetHz: number,
		tolHz: number,
		bandwidthHz: number,
		deadline: number,
		view: IdentifyTrackView | null,
	): TargetState {
		const t: TargetState = {
			targetHz,
			toleranceHz: tolHz,
			bandwidthHz,
			state: "waiting-for-signal",
			deadline,
			view,
			fallback: null,
			done: new Map(),
			gone: false,
			recheckArtefact: false,
			plan: null,
			trials: [],
			nextRun: 0,
			active: [],
			decoded: null,
			result: null,
			ambientUntil: Number.POSITIVE_INFINITY,
			memoSkip: new Set(),
			replay: {
				claimed: [],
				views: new Map(),
				queue: null,
				requested: null,
				reserved: false,
				asked: false,
				waitUntil: null,
			},
			analog: {
				everMonitored: false,
				openSeen: new Set(),
				result: null,
				resultProtocol: null,
			},
			known: null,
			gate: null,
			analogArmed: new Set(),
			analogStopped: new Set(),
			analogAbort: [],
			analogDue: new Map(),
		}
		this.targets.push(t)
		this.emitTarget(t)
		return t
	}

	/**
	 * Artefact masks at the target. `dc`, `spur` and `image` end the target at once; `rfi` is
	 * evidence of absence (Task 7a) and counts only on the final check, after the wait found nothing.
	 */
	private checkArtefact(t: TargetState, final: boolean): void {
		this.hold(
			this.deps
				.artefactAt(this.sourceId, t.targetHz)
				.catch((err: unknown) => {
					this.log.warn(
						{ err },
						"Artefact masks unavailable; identifying without them",
					)
					return null
				})
				.then(kind => {
					if (kind === "stale") {
						if (final) this.finishTarget(t, null)
						else t.recheckArtefact = true
						return
					}
					t.recheckArtefact = false
					if (kind && (kind !== "rfi" || final)) this.finishTarget(t, kind)
					else if (final) this.finishTarget(t, null)
				}),
		)
	}

	private waitStep(t: TargetState, now: number): void {
		if (t.recheckArtefact) {
			t.recheckArtefact = false
			this.checkArtefact(t, false)
			return
		}
		// WG12 req 6.1: a point target with waitUntilSignal stays here until a gated start. The trial
		// timeout then counts from that start. The wait elapsing first is no-signal, not a verdict.
		if (this.blockingOnGate(t)) {
			const start = this.takeGate(t)
			const signalStarted = this.signalStarted()
			const signalDeadline = signalStarted + this.signalWaitMs()
			// A start still in the future is not a transmission this tick. One already open when
			// the job started is: the trial timeout counts from the job start, not the earlier gate.
			const openedAt =
				start === null ? null : Math.max(start.atMs, signalStarted)
			if (
				start !== null &&
				openedAt !== null &&
				start.atMs <= now &&
				openedAt <= signalDeadline
			) {
				t.gate = start
				t.deadline = openedAt + this.deps.identify.timeoutMs
			} else if (now >= signalDeadline) {
				this.endNoSignal(t)
				return
			} else {
				return
			}
		}
		// Restarted by an in-window epoch change past the deadline: end with the evidence so far (like a window move).
		if (t.fallback && now >= t.deadline) {
			this.finishTarget(t, null)
			return
		}
		const hit = resolveTarget(t.targetHz, t.toleranceHz, this.currentTracks())
		if (hit) {
			t.view = hit
			t.gone = false
			if (hit.track.flags.iqImage || hit.track.flags.spur) {
				this.finishTarget(t, hit.track.flags.iqImage ? "image" : "spur")
				return
			}
		} else if (t.view) {
			t.gone = true
		}
		// The timeout bounds the wait for a signal only: a track that keyed inside it still gets its trials, once it
		// has IDENTIFY_SETTLE_BLOCKS of envelope, closes, or (a slow-settling track) at most settleGraceMs past the deadline.
		if (
			t.view &&
			(t.gone ||
				t.view.track.blocks >= IDENTIFY_SETTLE_BLOCKS ||
				now >= t.deadline + this.settleGraceMs())
		) {
			this.plan(t)
			this.tryStep(t, now)
			return
		}
		if (t.view === null && now >= t.deadline) {
			t.deadline = Number.POSITIVE_INFINITY
			// Nothing transmitted in time: check once more (a comb may have been promoted, or RFI is the answer).
			this.checkArtefact(t, true)
		}
	}

	/** How long past the deadline a resolved but young track may settle: IDENTIFY_SETTLE_BLOCKS blocks plus 1 s. */
	private settleGraceMs(): number {
		return IDENTIFY_SETTLE_BLOCKS * this.record.spec.integrationMs + 1000
	}

	private plan(t: TargetState): void {
		const view = t.view
		if (!view) return
		const priors = this.deps.priorsAt(view.track.centreHz)
		const narrow = this.narrowAt(t.targetHz)
		let range:
			| { protocols: readonly ScannerProtocol[]; explicit: boolean }
			| undefined
		try {
			range = this.deps.rangeProtocolsAt?.(t.targetHz)
		} catch {
			/* No range constraint. */
		}
		const requested = this.deps.identify.protocols
		const protocols =
			requested.length > 0 ? requested : (range?.protocols ?? [])
		const explicit = requested.length > 0 || range?.explicit === true
		const bounds = explicit ? protocols : []
		let scores = identifyScores(view.track, {
			priors,
			protocols,
			explicit,
			...(narrow ? { narrow } : {}),
		})
		t.known = this.knownOf(view)
		if (t.known) scores = knownFirst(scores, t.known.protocol, priors, bounds)
		const plan = planIdentifyTrials(scores, {
			format: this.deps.format(this.sourceId),
			channelizer: this.deps.channelizer(),
		})
		// WG7 req 1.5: ambient trials after the probe trials; they never take a run, so probes are not delayed.
		plan.trials.push(
			...planAmbientTrials(
				{
					sourceId: this.sourceId,
					hz: t.targetHz,
					toleranceHz: t.toleranceHz,
				},
				this.deps.ambient,
				bounds,
				// Fixed message, no exception payload (its text may carry decoder details); once per job.
				() => {
					if (this.ambientErrorLogged) return
					this.ambientErrorLogged = true
					this.log.warn("Ambient coverage unavailable; no ambient trials")
				},
			),
		)
		if (this.deps.analogEvidence || this.deps.analogTrial?.runLive)
			plan.trials = planAnalogTrials(plan.trials, bounds)
		t.memoSkip = this.applyMemo(plan)
		t.plan = plan
		t.ambientUntil = Number.isFinite(t.deadline)
			? t.deadline
			: this.deps.now() + this.deps.identify.timeoutMs
		t.trials = plan.trials.map(
			(p): ScannerIdentifyTrial => ({
				protocol: p.protocol,
				decoder: p.decoder,
				mode: p.mode,
				transport: p.transport,
				outcome:
					p.transport === "ambient"
						? (t.done.get(p.protocol) ?? "running")
						: p.run === null
							? "unsupported"
							: (t.done.get(p.protocol) ?? "pending"),
				...(p.reason ? { reason: p.reason } : {}),
			}),
		)
		t.nextRun = 0
		t.active = []
		t.state = "trying"
		this.claimCaptures(t, view)
		if (this.deps.analogTrial?.runLive && this.analogChoice(t))
			this.startAnalogItem(t, "", view)
		this.emitTarget(t)
	}

	/** WG12: wait for a gate only on a point target that asked, and only until one is accepted. */
	private blockingOnGate(t: TargetState): boolean {
		if (this.deps.identify.waitUntilSignal !== true) return false
		if (this.deps.gatedAt === undefined) return false
		if (t.gate !== null) return false
		return !("all" in this.deps.identify.target)
	}

	private signalStarted(): number {
		return this.record.startedAt ?? this.record.createdAt
	}

	private signalWaitMs(): number {
		const waitMs = this.deps.identify.waitMs
		const raw =
			typeof waitMs === "number" && Number.isFinite(waitMs)
				? waitMs
				: IDENTIFY_WAIT_DEFAULT_MS
		// The route already rejects values outside this span. Clamp here so an
		// internal caller cannot wait forever or give the signal up immediately.
		if (raw < IDENTIFY_WAIT_MIN_MS) return IDENTIFY_WAIT_MIN_MS
		if (raw > IDENTIFY_WAIT_MAX_MS) return IDENTIFY_WAIT_MAX_MS
		return raw
	}

	/** One lookup. A throw or a malformed value is no start; the value itself is never logged. */
	private takeGate(
		t: TargetState,
	): { startSample: number; atMs: number } | null {
		const gatedAt = this.deps.gatedAt
		if (!gatedAt) return null
		try {
			return parseGateStart(gatedAt(this.sourceId, t.targetHz, t.toleranceHz))
		} catch (err: unknown) {
			this.gateFailed(err)
			return null
		}
	}

	private gateFailed(err: unknown): void {
		if (this.gateErrorLogged) return
		this.gateErrorLogged = true
		this.log.warn(
			{ err: safeErrorFields(err) },
			"Gated transmission lookup failed",
		)
	}

	/** No gated transmission in time: unidentified, every trial cancelled, no verdict and no miss. */
	private endNoSignal(t: TargetState): void {
		if (FINAL.has(t.state)) return
		this.stopAnalog(t)
		const runs = t.active.splice(0)
		for (const r of runs) this.setTrials(t, r.runIndex, () => "cancelled")
		this.releaseRuns(runs)
		for (const trial of t.trials)
			if (trial.outcome === "pending" || trial.outcome === "running")
				trial.outcome = "cancelled"
		t.result = {
			confidence: "activity",
			metadata: emptyMetadata(),
			measurements: measureTarget(
				null,
				this.deps.lastSummary(this.sourceId),
				t.targetHz,
				t.toleranceHz,
			),
			ended: "no-signal",
		}
		t.state = "unidentified"
		if (!this.aborting) this.settleTarget(t)
		this.emitTarget(t)
	}

	private tryStep(t: TargetState, now: number): void {
		const plan = t.plan
		if (!plan) return
		if (this.analogStep(t, now)) this.emitTarget(t)
		// Req 6.1: once a gate is accepted, timeoutMs is the end of the trials, not only of the wait.
		const gateOver =
			t.gate !== null && Number.isFinite(t.deadline) && now >= t.deadline
		for (const r of [...t.active]) {
			if (r.endsAt !== null && now >= r.endsAt) {
				this.endRun(t, r, "hold")
				// One run per tick, unless this tick is the gated deadline (finish it below).
				if (!gateOver) return
				continue
			}
			if (r.queuedUntil !== null && now >= r.queuedUntil) {
				this.deps.probes.dequeue(r.req)
				t.active.splice(t.active.indexOf(r), 1)
				this.setTrials(t, r.runIndex, () => "skipped-budget")
				this.emitTarget(t)
			}
		}
		// Live-audio trials are decided by analogStep (which may wait IDENTIFY_ANALOG_SETTLE_MS past the deadline).
		if (
			now >= t.ambientUntil &&
			this.endAmbient(
				t,
				"timeout",
				x =>
					x.decoder !== "analog-demod" &&
					!(this.deps.analogEvidence && x.decoder === "live-audio"),
			)
		)
			this.emitTarget(t)
		if (gateOver) {
			this.stopForGateDeadline(t)
			return
		}
		if (!this.fillRuns(t, now)) return
		// A target with running ambient trials waits for their evidence or deadline.
		// Replay (and the analog trial that shares that queue) starts only once the live runs are done.
		if (
			t.active.length !== 0 ||
			t.nextRun < plan.runs.length ||
			this.ambientRunning(t)
		)
			return
		if (this.replayStep(t, now)) return
		if (this.analogReplayOpen(t)) return
		this.finishTarget(t, null)
	}

	/**
	 * The gated deadline has arrived. A run whose full hold already elapsed ends as that hold. A run
	 * the deadline cuts short is cancelled, not a completed hold, and never a known-protocol miss
	 * (the same rule as a job hold that releases a probe before its mode timer). Drop replay still
	 * queued, and abort analog replay. Live-audio may keep settling; the target finishes when it stops.
	 */
	private stopForGateDeadline(t: TargetState): void {
		if (FINAL.has(t.state)) return
		if (t.plan) t.nextRun = t.plan.runs.length
		if (t.replay.queue) t.replay.queue = []
		for (const r of [...t.active]) {
			const completed = r.replay
				? r.replayDone
				: r.endsAt !== null && this.deps.now() >= r.endsAt
			this.endRun(t, r, completed ? "hold" : "deadline")
		}
		this.stopAnalog(t)
		for (const trial of t.trials)
			if (
				trial.decoder === "analog-demod" &&
				(trial.outcome === "running" || trial.outcome === "pending")
			)
				trial.outcome = "cancelled"
		this.endAmbient(
			t,
			"timeout",
			x => !(this.deps.analogEvidence && x.decoder === "live-audio"),
		)
		if (this.ambientRunning(t)) return
		if (!FINAL.has(t.state)) this.finishTarget(t, null)
	}

	/** Starts runs up to the parallel limit; false when the target went back to waiting (the epoch moved). */
	private fillRuns(t: TargetState, now: number): boolean {
		const plan = t.plan
		if (!plan) return false
		// Never a new run while the job ends (cancel, source-down, stop) or once it left `running`.
		if (this.phase !== "running" || this.record.state !== "running") return true
		// A gated deadline ends the trials (req 6.1). endRun asks for the next run before releasing the slot.
		if (t.gate !== null && Number.isFinite(t.deadline) && now >= t.deadline)
			return true
		// [S2] After the channelizer: parallel runs within maxProbes.channel (Task 40 sets `channelizer`).
		const parallel = this.deps.channelizer()
			? Math.max(1, this.deps.settings().maxProbes.channel)
			: 1
		while (t.active.length < parallel && t.nextRun < plan.runs.length) {
			if (!this.startRun(t, now)) return false
		}
		return true
	}

	/** Starts the plan's next run; false when the target went back to waiting (the epoch moved). */
	private startRun(t: TargetState, now: number): boolean {
		const view = t.view
		const runIndex = t.nextRun
		const run = t.plan?.runs[runIndex]
		if (!view || !run) return false
		t.nextRun += 1
		// Completed before an in-window epoch change: not run again.
		if (run.protocols.every(p => t.done.has(p)) || t.memoSkip.has(runIndex))
			return true
		const fs = this.deps.engine(this.sourceId)?.currentEpoch().sampleRateHz ?? 0
		const preRollSamples = Math.round(
			(this.deps.settings().hold.preRollMs * fs) / 1000,
		)
		const req: ProbeRequest = {
			jobId: this.record.id,
			priority: IDENTIFY_PROBE_PRIORITY,
			sourceId: this.sourceId,
			trackId: view.trackId,
			observationId: view.observationId,
			discoveryId: this.deps.discoveryOf(view.observationId)?.id ?? null,
			targetHz: view.track.centreHz,
			epoch: view.epoch,
			cls: run.cls,
			protocols: run.protocols,
			modes: [run.mode],
			// § 6.5: pre-roll from the observation start, so a click after key-up still sees the header.
			preRollFromSample: Math.max(0, view.track.startSample - preRollSamples),
			holdMs: run.holdMs,
			record: this.deps.identify.record,
			admission: { kind: "protocol-target", snrDb: view.track.snrDb },
		}
		const res = this.request(req)
		const state: RunState = {
			runIndex,
			run,
			req,
			probeId: null,
			queuedUntil: null,
			endsAt: null,
			seen: new Map(),
			unavailable: false,
			replayDone: false,
		}
		if ("started" in res) {
			t.active.push(state)
			this.begin(t, state, res.started, now)
		} else {
			switch (res.deferred) {
				case "max-probes":
				case "budget":
				case "cpu":
					// Queued in the pool (a lower-priority probe was preempted); begin() runs on its "starting".
					state.queuedUntil = now + IDENTIFY_QUEUE_WAIT_MS
					t.active.push(state)
					break
				case "no-transport":
				case "format": {
					// Same shape as a planned unsupported trial (CLI-COORDINATION 2026-10-10): no mode, no transport, a reason.
					const reason =
						res.deferred === "format"
							? "unsupported-format"
							: this.deps.channelizer()
								? "no-decoder"
								: "needs-channelizer"
					this.setTrials(t, runIndex, (_protocol, trial) => {
						trial.mode = null
						trial.transport = null
						trial.reason = reason
						return "unsupported"
					})
					break
				}
				case "stale-epoch":
					this.restartTarget(t, now)
					return false
			}
		}
		this.emitTarget(t)
		return true
	}

	/**
	 * The epoch changed under the track with the target still in the window (gain change, reconnect at the
	 * same centre): resolve the target again. The original deadline stays, so repeated epoch changes never
	 * extend the job; an `all` target (no wait deadline) gets one now. A window move ends the target instead.
	 */
	private restartTarget(t: TargetState, now: number): void {
		if (this.windowMoved(t)) {
			this.endMoved(t)
			return
		}
		const runs = t.active.splice(0)
		for (const r of runs) this.setTrials(t, r.runIndex, () => "cancelled")
		this.releaseRuns(runs)
		this.stopAnalog(t)
		for (const trial of t.trials)
			if (
				trial.decoder === "analog-demod" &&
				(trial.outcome === "running" || trial.outcome === "pending")
			)
				trial.outcome = "cancelled"
		t.analogArmed.clear()
		t.analogDue.clear()
		this.requeueAnalog(t)
		// Keep the evidence: decoder outcomes of completed runs, and the resolved track for the verdict.
		// An analog replay trial shares the analog-fm/analog-am protocol with live audio. Copying it
		// would start the replanned live-audio trial as already heard, instead of running.
		for (const trial of t.trials)
			if (COMPLETED.has(trial.outcome) && trial.decoder !== "analog-demod")
				t.done.set(trial.protocol, trial.outcome)
		t.fallback = t.view ?? t.fallback
		t.state = "waiting-for-signal"
		if (!Number.isFinite(t.deadline))
			t.deadline = now + this.deps.identify.timeoutMs
		t.view = null
		t.gone = false
		t.nextRun = 0
		this.emitTarget(t)
	}

	private begin(
		t: TargetState,
		r: RunState,
		probeId: string,
		now: number,
	): void {
		const transport =
			this.deps.probes.status().find(p => p.probeId === probeId)?.transport ??
			(this.deps.channelizer() ? "channel" : "offset")
		r.probeId = probeId
		r.queuedUntil = null
		// Full hold, gated or not. An ungated wait deadline does not cut it. A gated deadline
		// that arrives sooner cancels the run; it does not move endsAt, so the cut is not a
		// completed hold and not a known-protocol miss.
		r.endsAt =
			now +
			r.run.holdMs +
			this.deps.probes.startLatencyMs(r.run.mode.decoderType, transport)
		this.setTrials(t, r.runIndex, (_protocol, trial) => {
			trial.transport = transport
			return "running"
		})
	}

	private endRun(
		t: TargetState,
		r: RunState,
		why: "hold" | "stopped" | "decoded" | "deadline",
	): void {
		const index = t.active.indexOf(r)
		if (index < 0) return
		t.active.splice(index, 1)
		// § 10.8 (3): stop at the first accepted decode unless exhaustive.
		const stop = why === "decoded" && !this.deps.identify.exhaustive
		// The pool stopped the probe before its hold (epoch change, spawn failure, shutdown) and nothing was
		// accepted: that is no decoder verdict.
		// A gated deadline that arrives before the full hold is the same kind of cut.
		// A replay run stopped without its decoder's clean end (input failed, capture gone) is cut short
		// whatever the wall clock says.
		// a replay run's verdict needs its clean replay-end; a hold expiry without it
		// (a decoder that never exited) is cut short too: cancelled, no miss.
		const sawIdentity = [...r.seen.values()].some(
			seen => seen.identity !== null,
		)
		const cutShort = r.replay
			? why !== "decoded" && !r.replayDone
			: (why === "deadline" && !sawIdentity) ||
				(why === "stopped" &&
					!r.replayDone &&
					r.endsAt !== null &&
					this.deps.now() < r.endsAt &&
					!sawIdentity)
		// WG9 req 5.4: a run whose decoder program could not run and that saw no
		// output is no decoder verdict either; it is unsupported, not no-sync.
		const unavailable =
			why === "stopped" &&
			r.unavailable &&
			![...r.seen.values()].some(seen => seen.output)
		this.countKnownMiss(t, r, why, unavailable)
		this.setTrials(t, r.runIndex, (protocol, trial) => {
			if (unavailable) {
				if (PROBE_DECODER_TYPES.has(r.run.mode.decoderType))
					this.unavailableTypes.add(
						r.run.mode.decoderType as ScannerProbeDecoderType,
					)
				trial.reason = "decoder-unavailable"
				return "unsupported"
			}
			if (cutShort) return "cancelled"
			const outcome = trialOutcome(r.seen.get(protocol))
			return stop && outcome !== "decoded" ? "not-needed" : outcome
		})
		if (r.replay) this.applyReplayRun(t, r, cutShort || unavailable)
		const ended = [r]
		if (stop) {
			for (const other of t.active.splice(0)) {
				this.setTrials(t, other.runIndex, () => "not-needed")
				ended.push(other)
			}
			for (const trial of t.trials)
				if (trial.outcome === "pending") trial.outcome = "not-needed"
			this.endAmbient(t, "not-needed")
			t.nextRun = t.plan?.runs.length ?? 0
		} else if (
			t.state === "trying" &&
			why !== "stopped" &&
			why !== "deadline"
		) {
			// Request the next run before this one's slot is released: the pool's priority queue then hands the slot to
			// it, not to a queued passive probe that the next run would only preempt again (a spawn and a kill per run).
			// A run the pool stopped is followed from the next tick (after an epoch change, or never at shutdown).
			this.fillRuns(t, this.deps.now())
		}
		this.releaseRuns(ended)
		this.emitTarget(t)
	}

	private finishTarget(
		t: TargetState,
		artefact: ArtefactKind | null,
		ended?: "window-moved",
		unavailable = false,
	): void {
		if (FINAL.has(t.state)) return
		this.stopAnalog(t)
		const resolved = t.view ?? t.fallback
		const latest = resolved
			? (this.deps
					.liveTracks(this.sourceId)
					.find(v => v.trackId === resolved.trackId) ?? resolved)
			: null
		const track = latest?.track ?? null
		const discovery = latest
			? this.deps.discoveryOf(latest.observationId)
			: undefined
		const top = track
			? classifySpectral(track, {
					priors: this.deps.priorsAt(track.centreHz),
					protocols: [],
				}).hypotheses[0]
			: undefined
		const analog = t.analog.result

		const analogVerdict = analogVerdictOf(analog)
		const state = identifyVerdict({
			analog: analogVerdict,
			artefact,
			// identified = an identity this job's trials accepted (H2) on a discovery not capped below decoded; a discovery
			// decoded earlier (another PTT, passive discovery) without a decode now is a candidate carrying its identity
			decoded:
				t.decoded !== null &&
				(discovery?.confidence ?? "decoded") === "decoded",
			heardIdentity: t.decoded !== null,
			discoveryConfidence: discovery?.confidence ?? null,
			topScore: top?.score ?? 0,
		})
		// A tone can name analog; voice alone cannot name a protocol.
		const analogProtocol =
			analog && analogVerdict?.tone === true && t.decoded === null
				? t.analog.resultProtocol
				: null
		const protocol =
			state === "unidentified"
				? undefined
				: (t.decoded?.protocol ?? analogProtocol ?? undefined)
		const identity = state === "unidentified" ? undefined : t.decoded?.identity
		const analogIdentified = analogProtocol !== null && state === "identified"
		const baseMetadata = discovery?.metadata ?? emptyMetadata()
		const unavailableTypes = [...this.unavailableTypes].sort()
		for (const trial of t.trials)
			if (trial.outcome === "pending" || trial.outcome === "running")
				trial.outcome = "cancelled"
		const proof = identifyDigitalProof(
			t.trials,
			latest?.observationId ?? "identify",
			this.deps.now(),
		)
		t.result = {
			...(proof && !analog && !t.decoded && !artefact ? { proof } : {}),
			...(!protocol && track && !artefact ? { hint: classOf(track) } : {}),
			...(protocol ? { protocol } : {}),
			confidence: analogIdentified
				? "classified"
				: (discovery?.confidence ?? (t.decoded ? "decoded" : "activity")),
			...(identity ? { identity } : {}),
			metadata:
				analogProtocol !== null && analog && analog.ctcssHz !== null
					? { ...baseMetadata, ctcssHz: analog.ctcssHz }
					: baseMetadata,
			...(discovery ? { discoveryId: discovery.id } : {}),
			...(latest ? { observationId: latest.observationId } : {}),
			// After a window move the latest summary shows another window: measure from the track or not at all.
			measurements: measureTarget(
				track,
				ended || unavailable ? null : this.deps.lastSummary(this.sourceId),
				t.targetHz,
				t.toleranceHz,
			),
			...(artefact ? { artefact } : {}),
			...(ended ? { ended } : {}),
			// A digital decode won: the analog evidence is not part of the result (beside a classified digital
			// candidate it is supplementary).
			...(analog && !artefact && t.decoded === null ? { analog } : {}),
			...(unavailableTypes.length > 0
				? { decodersUnavailable: unavailableTypes }
				: {}),
		}
		t.state = state
		// WG11 req 6.8: the result exists; its claimed captures are discarded (after the probes on abort).
		if (!this.aborting) this.settleTarget(t)
		this.emitTarget(t)
	}

	/** No accepted IQ: never use a retained summary as an RF measurement. */
	private async failStartup(event: JobEvent): Promise<void> {
		if (this.phase === "finished") return
		const target = this.deps.identify.target
		if (this.targets.length === 0 && "frequencyHz" in target) {
			const t = this.newTarget(
				target.frequencyHz,
				toleranceHz(target.bandwidthHz),
				target.bandwidthHz ?? 0,
				0,
				null,
			)
			this.finishTarget(t, null, undefined, true)
		}
		await this.abort()
		try {
			await this.deps.inner.dispatch(event)
		} finally {
			this.detach()
		}
	}

	private finishJob(): void {
		if (this.phase === "finished") return
		this.phase = "finished"
		void this.deps.inner
			.dispatch({ type: "stop-condition" })
			.catch((err: unknown) =>
				this.log.debug({ err }, "Identify stop ignored in this state"),
			)
			.finally(() => this.detach())
	}

	/** source-down (and a lease loss, never expected): end through the stop-condition row with the results so far. */
	private async endWithResults(): Promise<void> {
		await this.abort()
		try {
			await this.deps.inner.dispatch({ type: "stop-condition" })
		} finally {
			this.detach()
		}
	}

	/** A sweep now holds the source, or the target band left the tuned window. */
	private windowMoved(t: TargetState): boolean {
		if (!this.deps.inner.covers(this.sourceId, t.targetHz)) return true
		const epoch = this.deps.engine(this.sourceId)?.currentEpoch()
		return (
			epoch !== undefined &&
			!inWindow(t.targetHz, t.bandwidthHz, epoch, USABLE_FRACTION)
		)
	}

	/** Ends a target whose window moved: runs released, open trials `cancelled`, `ended: "window-moved"`. */
	private endMoved(t: TargetState): void {
		this.log.info(
			{ targetHz: t.targetHz, state: t.state },
			"Identify target ended: window moved",
		)
		const runs = t.active.splice(0)
		for (const r of runs) this.setTrials(t, r.runIndex, () => "cancelled")
		this.releaseRuns(runs)
		this.finishTarget(t, null, "window-moved")
	}

	/** Live tracks of the current epoch only (old-epoch observations linger briefly behind a thread host). */
	private currentTracks(): IdentifyTrackView[] {
		const epoch = this.deps.engine(this.sourceId)?.currentEpoch().epoch
		return this.deps
			.liveTracks(this.sourceId)
			.filter(v => epoch === undefined || v.epoch === epoch)
	}

	/** Cancel, source-down, source-removed: release every probe and report what each target has so far. */
	private async abort(): Promise<void> {
		if (this.phase === "finished") return
		this.phase = "finished"
		this.aborting = true
		const releases: Promise<void>[] = []
		for (const t of this.targets) {
			for (const r of t.active.splice(0)) {
				if (r.probeId) releases.push(this.deps.probes.release(r.probeId))
				else this.deps.probes.dequeue(r.req)
				this.setTrials(t, r.runIndex, () => "cancelled")
			}
			this.finishTarget(t, null)
		}
		await Promise.all(releases).catch((err: unknown) =>
			this.log.warn({ err }, "Releasing identify probes failed"),
		)
		for (const t of this.targets) this.settleTarget(t)
	}

	// === probe pool events ===

	/** WG9 req 5.4: marks the run; its "stopped" state follows and ends it. */
	private readonly onDecoderUnavailable = (
		probeId: string,
		req: ProbeRequest,
	): void => {
		if (req.jobId !== this.record.id) return
		const hit = this.findRun(r => r.probeId === probeId)
		if (hit) hit.r.unavailable = true
	}

	/** WG11 req 6.5: the replay decoder ended cleanly: the evidence seen is its verdict, not a cut-short run. */
	private readonly onReplayEnd = (probeId: string, req: ProbeRequest): void => {
		if (req.jobId !== this.record.id) return
		const hit = this.findRun(r => r.probeId === probeId)
		if (hit) hit.r.replayDone = true
	}

	private readonly onProbeState = (
		probeId: string,
		state: string,
		req: ProbeRequest,
	): void => {
		if (req.jobId !== this.record.id || this.requesting) return
		const hit = this.findRun(
			r =>
				r.probeId === probeId ||
				(r.probeId === null && r.queuedUntil !== null && r.req === req),
		)
		if (state === "starting") {
			if (hit && hit.r.probeId === null) {
				this.begin(hit.t, hit.r, probeId, this.deps.now())
				this.emitTarget(hit.t)
			} else if (!hit) {
				// Not a run of ours any more (e.g. the pool's re-request after an epoch change): give the slot back.
				void this.deps.probes.release(probeId).catch(() => undefined)
			}
			return
		}
		if (state === "stopped" && hit && hit.r.probeId === probeId) {
			hit.r.probeId = null
			this.endRun(hit.t, hit.r, "stopped")
		}
	}

	private readonly onPoolEvidence = (
		probeId: string,
		req: ProbeRequest,
		ev: DecodeEvidence,
	): void => {
		if (req.jobId !== this.record.id) return
		const hit = this.findRun(r => r.probeId === probeId)
		if (!hit) return
		const seen = hit.r.seen.get(ev.protocol) ?? {
			output: false,
			crcFailures: 0,
			identity: null,
		}
		seen.output = true
		if (!ev.crcClean) seen.crcFailures += 1
		// H2: the interpreters attach an identity only after the second CRC-clean line with the same value.
		if (ev.identity) seen.identity = ev.identity
		hit.r.seen.set(ev.protocol, seen)
		if (!ev.identity) return
		this.countDecode(hit.t)
		hit.t.decoded ??= { protocol: ev.protocol, identity: ev.identity }
		// WG11 req 6.5: a live decode discards the observation's captures that were not replayed yet.
		if (!hit.r.replay) this.confirmLive(req.observationId)
		if (!this.deps.identify.exhaustive) this.endRun(hit.t, hit.r, "decoded")
	}

	/**
	 * WG7 req 1.5: ambient evidence paired with one of this job's observations. Decodes a running ambient trial
	 * of the target whose resolved observation it is, when the evidence is CRC-clean, ambient and carries an
	 * accepted (H2) identity for the trial's protocol.
	 */
	onAmbientEvidence(observationId: string, ev: DecodeEvidence): void {
		if (
			this.phase !== "running" ||
			ev.origin !== "ambient" ||
			!ev.crcClean ||
			!ev.identity
		)
			return
		const identity = ev.identity
		const now = this.deps.now()
		for (const t of this.targets) {
			if (t.state !== "trying" || t.view?.observationId !== observationId)
				continue
			// Only evidence of the resolved observation's epoch counts, and only before the ambient
			// deadline (late evidence is ignored; the next tick ends the trial `timeout`).
			if (ev.epoch !== t.view.epoch || !(now < t.ambientUntil)) continue
			const trial = t.trials.find(
				x =>
					x.transport === "ambient" &&
					x.decoder !== "live-audio" &&
					x.protocol === ev.protocol &&
					x.outcome === "running",
			)
			if (!trial) continue
			trial.outcome = "decoded"
			// WG11 batch review R1 4: the scanner's ambient path records this evidence's decode
			// (once, only where the observation accepted it); counting here too would double it.
			t.decoded ??= { protocol: ev.protocol, identity }
			this.confirmLive(observationId)
			if (!this.deps.identify.exhaustive) {
				// § 10.8 (3) like a probe decode: every other trial is not needed.
				const runs = t.active.splice(0)
				for (const r of runs) this.setTrials(t, r.runIndex, () => "not-needed")
				for (const x of t.trials)
					if (x.outcome === "pending") x.outcome = "not-needed"
				this.endAmbient(t, "not-needed")
				t.nextRun = t.plan?.runs.length ?? 0
				this.releaseRuns(runs)
			}
			this.emitTarget(t)
			return
		}
	}

	// === WG10: analog evidence and the unavailable memo ===

	/** Applies the probe pool's memo to a fresh plan; records the types it used. */
	private applyMemo(plan: IdentifyPlan): Set<number> {
		const memo = this.memoTypes()
		if (memo.size === 0) return new Set()
		const out = applyUnavailableMemo(plan, memo)
		plan.trials = out.trials
		for (const type of out.used) this.unavailableTypes.add(type)
		return out.skip
	}

	private memoTypes(): ReadonlySet<string> {
		const probes = this.deps.probes
		if (typeof probes.unavailableTypes !== "function") return new Set()
		try {
			const got = probes.unavailableTypes(this.deps.now())
			const out = new Set<string>()
			if (got instanceof Set)
				for (const x of got as Set<unknown>)
					if (typeof x === "string" && PROBE_DECODER_TYPES.has(x)) out.add(x)
			return out
		} catch {
			return new Set()
		}
	}

	/**
	 * WG10 req 3.2/3.3: re-reads the analog evidence for the target's running `live-audio` trials. A closed
	 * match decodes its trial (a stop unless exhaustive); at the ambient deadline the rest end `timeout` (an
	 * open match only), `no-sync` (live audio was on the target) or `unsupported`/`no-live-audio`. True when a
	 * trial changed. A throwing port is no evidence and not monitoring. R2: a trial with an open match, or a
	 * pending opening (`pendingNear`, started by the deadline), keeps running until a closed match that
	 * ended by the deadline decodes it or IDENTIFY_ANALOG_SETTLE_MS past the deadline, then ends `timeout`.
	 */
	private analogStep(t: TargetState, now: number): boolean {
		const port = this.deps.analogEvidence
		if (!port) return false
		const running = t.trials.filter(
			x => x.decoder === "live-audio" && x.outcome === "running",
		)
		if (running.length === 0) return false
		const target: AnalogTarget = {
			sourceId: this.sourceId,
			hz: t.targetHz,
			toleranceHz: t.toleranceHz,
			sinceMs:
				(this.record.startedAt ?? this.record.createdAt) -
				IDENTIFY_ANALOG_LOOKBACK_MS,
			untilMs: t.ambientUntil,
		}
		let monitoring = false
		let list: readonly AnalogEvidenceTransmission[] = []
		try {
			monitoring =
				port.monitoring(target.sourceId, target.hz, target.toleranceHz) === true
		} catch {
			this.analogUnavailable()
		}
		try {
			list = port.transmissionsNear(
				target.sourceId,
				target.hz,
				target.toleranceHz,
				target.sinceMs,
			)
		} catch {
			this.analogUnavailable()
		}
		if (monitoring) t.analog.everMonitored = true
		const atDeadline = now >= t.ambientUntil
		// WG10 R2: an opening the tracker holds back (under the minimum audio) that started by the deadline.
		let pending: readonly AnalogEvidenceTransmission[] = []
		if (atDeadline && typeof port.pendingNear === "function") {
			try {
				pending = (
					port.pendingNear(target.sourceId, target.hz, target.toleranceHz) ?? []
				).filter(
					x =>
						typeof x === "object" &&
						x !== null &&
						x.startedAtMs <= t.ambientUntil,
				)
			} catch {
				this.analogUnavailable()
			}
		}
		const settled = now >= t.ambientUntil + IDENTIFY_ANALOG_SETTLE_MS
		let changed = false
		let decoded = false
		let best: {
			protocol: ScannerProtocol
			analog: ScannerIdentifyAnalog
			endedAtMs: number
		} | null = null
		for (const trial of running) {
			const m = analogMatches(list, target, trial.protocol)
			const analog = analogResultOf(m.closed)
			// A closed match (ended at or before the deadline) decides even when first seen on the deadline tick.
			// WG11 req 1.1: `decoded` only when that newest match carried a (standard) CTCSS tone or DCS code,
			// else `heard` (a squelch opening is no decode).
			if (analog) {
				trial.outcome =
					analog.ctcssHz !== null || analog.dcs !== null ? "decoded" : "heard"
				trial.mode = analog.modulation
				decoded = true
				changed = true
				const endedAtMs = m.closed[0]?.endedAtMs ?? 0
				if (!best || endedAtMs > best.endedAtMs)
					best = { protocol: trial.protocol, analog, endedAtMs }
				continue
			}
			if (!atDeadline) continue
			// R2: an open or pending match waits (bounded) for its closed event before deciding `timeout`.
			if (m.open || analogMatches(pending, target, trial.protocol).open) {
				t.analog.openSeen.add(trial.protocol)
				if (!settled) continue
			}
			changed = true
			if (t.analog.openSeen.has(trial.protocol)) trial.outcome = "timeout"
			else if (t.analog.everMonitored) trial.outcome = "no-sync"
			else if (this.deps.analogTrial?.runLive) trial.outcome = "not-needed"
			else {
				trial.outcome = "unsupported"
				trial.mode = null
				trial.transport = null
				trial.reason = "no-live-audio"
			}
		}
		if (best && t.analog.result === null) {
			t.analog.result = best.analog
			t.analog.resultProtocol = best.protocol
		}
		// WG11 req 1.2 (WG10 3.3 amended): a match ends only the other live-audio trials still running (they
		// cannot add evidence) unless exhaustive. Probe runs and ambient trials of other decoders keep going to
		// their own end, so a digital decode still wins (a digital signal also opens the squelch).
		if (decoded && !this.deps.identify.exhaustive)
			this.endAmbient(t, "not-needed", x => x.decoder === "live-audio")
		return changed
	}

	// === WG11: narrow rasters and the known-protocol memory ===

	/** `deps.narrowRasterAt` at the target; absent, throwing or not `true`: false (today's plan). */
	private narrowAt(hz: number): boolean {
		const at = this.deps.narrowRasterAt
		if (!at) return false
		try {
			return at(hz) === true
		} catch {
			return false
		}
	}

	/** The discovery id of a resolved view (the store's), or null. */
	private discoveryIdOf(view: IdentifyTrackView | null): string | null {
		if (!view) return null
		try {
			const id = this.deps.discoveryOf(view.observationId)?.id
			return typeof id === "string" ? id : null
		} catch {
			return null
		}
	}

	/** Req 1.7: the resolved discovery's known protocol, when it names an identify protocol; never throws. */
	private knownOf(
		view: IdentifyTrackView,
	): { discoveryId: string; protocol: ScannerProtocol } | null {
		const memory = this.deps.knownProtocols
		if (!memory) return null
		const discoveryId = this.discoveryIdOf(view)
		if (discoveryId === null) return null
		try {
			const protocol = memory.known(discoveryId)
			return typeof protocol === "string" &&
				IDENTIFY_PROTOCOLS.includes(protocol)
				? { discoveryId, protocol }
				: null
		} catch {
			return null
		}
	}

	/**
	 * Req 1.8: the run of the known protocol ran its full hold (ended by the hold, or stopped by the pool at or
	 * after its end) and decoded nothing: one miss. A run cut short, including one a gated deadline ends
	 * before that hold, unavailable, never begun or cancelled is no miss; a decode is counted by countDecode.
	 */
	private countKnownMiss(
		t: TargetState,
		r: RunState,
		why: "hold" | "stopped" | "decoded" | "deadline",
		unavailable: boolean,
	): void {
		const memory = this.deps.knownProtocols
		const known = t.known
		if (!memory || !known || !r.run.protocols.includes(known.protocol)) return
		if (why === "decoded" || why === "deadline" || unavailable) return
		if (r.replay) {
			// a replay's wall clock says nothing (faster than real time). It is a miss
			// only after the decoder's clean end over a gap-free capture holding the whole mode hold.
			if (!r.replayDone) return
			if ([...r.seen.values()].some(seen => seen.identity !== null)) return
			let capture: IqCaptureView | null = null
			try {
				capture = this.deps.iqCapture?.view?.(r.replay.captureId) ?? null
			} catch {
				capture = null
			}
			if (!replayMissEligible(capture, r.run.mode.holdMs)) return
			try {
				memory.recordMiss(known.discoveryId, known.protocol)
			} catch {
				// As below.
			}
			return
		}
		if (r.endsAt === null) return
		if (why === "stopped" && this.deps.now() < r.endsAt) return
		if ([...r.seen.values()].some(seen => seen.identity !== null)) return
		// Review m2: the transmission must cover the whole known hold. A track that closed before
		// the run (trials on its last snapshot) or during it is no longer live at the hold's end.
		if (!this.trackLive(t)) return
		try {
			memory.recordMiss(known.discoveryId, known.protocol)
		} catch {
			// The memory never throws by contract; a broken one changes nothing here.
		}
	}

	/** The target's resolved track is still live in the current epoch (never throws: false). */
	private trackLive(t: TargetState): boolean {
		const view = t.view
		if (!view || t.gone) return false
		try {
			return this.currentTracks().some(
				v => v.trackId === view.trackId && v.epoch === view.epoch,
			)
		} catch {
			return false
		}
	}

	/** Req 1.8: an accepted (H2) decode on the target's discovery resets its miss count. */
	private countDecode(t: TargetState): void {
		const memory = this.deps.knownProtocols
		if (!memory) return
		const discoveryId =
			this.discoveryIdOf(t.view) ?? t.known?.discoveryId ?? null
		if (discoveryId === null) return
		try {
			memory.recordDecode(discoveryId)
		} catch {
			// As above.
		}
	}

	/** Fixed message, no exception payload; once per job. */
	private analogUnavailable(): void {
		if (this.analogErrorLogged) return
		this.analogErrorLogged = true
		this.log.warn("Analog evidence unavailable; no analog trials evidence")
	}

	// === helpers ===

	private ambientRunning(t: TargetState): boolean {
		return t.trials.some(
			x => x.transport === "ambient" && x.outcome === "running",
		)
	}

	/** Ends every running ambient trial of `t` (those `which` selects) with `outcome`; true when one ended. */
	private endAmbient(
		t: TargetState,
		outcome: ScannerTrialOutcome,
		which: (trial: ScannerIdentifyTrial) => boolean = () => true,
	): boolean {
		let ended = false
		for (const x of t.trials)
			if (x.transport === "ambient" && x.outcome === "running" && which(x)) {
				x.outcome = outcome
				ended = true
			}
		return ended
	}

	// === WG12 req 6.6: analog replay of a claimed capture ===

	private stopAnalog(t: TargetState): void {
		// Copy first: an abort listener splices the controller out, and a live loop would skip one.
		const pending = t.analogAbort.splice(0)
		for (const ac of pending) ac.abort()
	}

	private analogReplayOpen(t: TargetState): boolean {
		return t.trials.some(
			x =>
				x.decoder === "analog-demod" &&
				(x.outcome === "pending" || x.outcome === "running"),
		)
	}

	/** Abort analog replay trials whose own deadline has passed. The abort marks them cancelled. */
	private expireAnalog(t: TargetState, now: number): void {
		for (const ac of [...t.analogAbort]) {
			const due = t.analogDue.get(ac)
			if (due !== undefined && now >= due) ac.abort()
		}
	}

	/** nfm when the plan includes analog-fm (alone or with AM); am only when AM is the analog plan. */
	private analogChoice(
		t: TargetState,
	): { protocol: ScannerProtocol; mode: AnalogTrialMode } | null {
		const protocols = new Set((t.plan?.trials ?? []).map(p => p.protocol))
		const am = protocols.has("analog-am")
		const fm = protocols.has("analog-fm")
		if (!am && !fm) return null
		if (am && !fm) return { protocol: "analog-am", mode: "am" }
		return { protocol: "analog-fm", mode: "nfm" }
	}

	/**
	 * One analog-demod replay trial for a claimed capture. Does not take the identify inflight slot:
	 * a stalled runner must not hide a window move. "running" while the runner is in flight.
	 * The injected runner admits the trial to the probe budget; this job does not reserve cores.
	 */
	private startAnalogItem(
		t: TargetState,
		captureId: string,
		live?: IdentifyTrackView,
	): "running" | "skipped" {
		if (t.analogArmed.has(captureId) || (captureId.length === 0 && !live))
			return "skipped"
		const runner = this.deps.analogTrial
		const choice = this.analogChoice(t)
		if (!runner || !choice) return "skipped"
		t.analogArmed.add(captureId)
		const trial: ScannerIdentifyTrial = {
			protocol: choice.protocol,
			decoder: "analog-demod",
			mode: choice.mode,
			transport: live ? "ambient" : "replay",
			outcome: "pending",
		}
		t.trials.push(trial)
		trial.outcome = "running"
		const ac = new AbortController()
		t.analogAbort.push(ac)
		t.analogDue.set(
			ac,
			this.deps.now() + ANALOG_REPLAY_TRIAL_DEADLINE_MS + (live ? 2000 : 0),
		)
		const mode = choice.mode
		let settled = false
		const finish = (raw: unknown, failed: boolean): void => {
			if (settled) return
			settled = true
			const index = t.analogAbort.indexOf(ac)
			if (index >= 0) t.analogAbort.splice(index, 1)
			t.analogDue.delete(ac)
			if (ac.signal.aborted || this.disposed) {
				if (
					!this.disposed &&
					(trial.outcome === "running" || trial.outcome === "pending")
				)
					trial.outcome = "cancelled"
				return
			}
			if (failed) {
				this.log.warn(
					{ err: safeErrorFields(raw) },
					"Analog replay trial failed",
				)
				this.applyAnalogReplay(t, trial, captureId, null)
				return
			}
			this.applyAnalogReplay(t, trial, captureId, raw)
		}
		ac.signal.addEventListener("abort", () => {
			finish(null, false)
		})
		void Promise.resolve()
			.then(() =>
				live && runner.runLive
					? runner.runLive(
							{
								sourceId: this.sourceId,
								observationId: live.observationId,
								epoch: live.epoch,
								rfHz: live.track.centreHz,
								tuningTrust: live.track.tuningTrust,
								fromSample: live.track.startSample,
								reason: "identify",
							},
							mode,
							ac.signal,
						)
					: runner.run(captureId, mode, ac.signal),
			)
			.then(result => {
				finish(result, false)
			})
			.catch((err: unknown) => {
				finish(err, true)
			})
		this.emitTarget(t)
		return "running"
	}

	/** After an in-window restart, analog trials still owed to claimed captures go back on the queue. */
	private requeueAnalog(t: TargetState): void {
		const queue = t.replay.queue
		if (!queue || !this.deps.analogTrial || !this.analogChoice(t)) return
		const queued = new Set(
			queue.flatMap(item => (item.kind === "analog" ? [item.captureId] : [])),
		)
		for (const captureId of t.replay.claimed) {
			if (captureId.length === 0 || queued.has(captureId)) continue
			queue.push({ kind: "analog", captureId })
		}
	}

	/**
	 * Feed a decoded or heard verdict as a live-audio match. A tone counts only on `decoded` and only
	 * when it is in the standard tables. no-sync, data-like and carrier-only stay on the trial.
	 * A throw, a missing result or an unknown outcome cancels the trial and records no analog match.
	 */
	private applyAnalogReplay(
		t: TargetState,
		trial: ScannerIdentifyTrial,
		captureId: string,
		raw: unknown,
	): void {
		if (this.disposed) return
		if (FINAL.has(t.state)) return
		if (trial.outcome !== "running" && trial.outcome !== "pending") return
		const parsed = parseAnalogTrial(raw)
		// A verdict for a different mode than the one requested is no match.
		if (!parsed || parsed.mode !== trial.mode) {
			if (
				raw !== null &&
				typeof raw === "object" &&
				(raw as { error?: unknown }).error === "not-protected"
			) {
				trial.outcome = "unsupported"
				trial.reason = "decoder-unavailable"
			} else trial.outcome = "cancelled"
			this.emitTarget(t)
			return
		}
		if (parsed.outcome === "decoded" || parsed.outcome === "heard") {
			const tone =
				parsed.outcome === "decoded"
					? standardTone(parsed.tones)
					: { ctcssHz: null, dcs: null }
			const noTone = tone.ctcssHz === null && tone.dcs === null
			trial.outcome =
				parsed.outcome === "decoded" && noTone ? "heard" : parsed.outcome
			const stored =
				captureId === ""
					? t.view
						? {
								observationId: t.view.observationId,
								tuningTrust: t.view.track.tuningTrust,
							}
						: undefined
					: t.replay.views.get(captureId)
			this.keepAnalog(t, trial.protocol, {
				source: "live-audio",
				modulation: trial.mode === "am" ? "am" : "nfm",
				transmissions: 1,
				transmissionId:
					typeof stored?.observationId === "string"
						? stored.observationId
						: "analog-replay",
				ctcssHz: tone.ctcssHz,
				dcs: tone.dcs,
				tuningTrust: captureTrust(stored?.tuningTrust),
			})
			// R4.6: heard or a tone ends this capture's remaining digital replays.
			// The known-protocol probe already ran (it is queued ahead of analog).
			t.analogStopped.add(captureId)
		} else {
			trial.outcome = parsed.outcome
		}
		this.emitTarget(t)
	}

	/** A stronger analog match replaces a weaker one. no-sync never clears a match already kept. */
	private keepAnalog(
		t: TargetState,
		protocol: ScannerProtocol,
		analog: ScannerIdentifyAnalog,
	): void {
		const rank = (a: ScannerIdentifyAnalog | null): number => {
			const v = analogVerdictOf(a)
			if (!v) return 0
			return v.tone && v.trusted ? 2 : 1
		}
		if (rank(analog) <= rank(t.analog.result)) return
		t.analog.result = analog
		t.analog.resultProtocol = protocol
	}

	// === WG11 req 6.8: IQ capture claim, replay runs, settle ===

	/** At plan: claim the newest captures near the target; request one for the track when none exists. */
	private claimCaptures(t: TargetState, view: IdentifyTrackView): void {
		const port = this.deps.iqCapture
		if (!port) return
		try {
			const near = this.claimNear(t, view)
			if (near > 0 || t.replay.asked) return
			t.replay.asked = true
			const req: IqCaptureRequest = {
				sourceId: this.sourceId,
				observationId: view.observationId,
				epoch: view.epoch,
				rfHz: view.track.centreHz,
				tuningTrust: view.track.tuningTrust,
				fromSample: view.track.startSample,
				reason: "identify",
			}
			// Review M2: held for this job from the start (the queue skips held captures).
			const reserve = port.captureFor !== undefined && port.view !== undefined
			const res =
				reserve && port.captureFor
					? port.captureFor(req, this.record.id)
					: port.capture(req)
			if ("captureId" in res) {
				t.replay.requested = res.captureId
				t.replay.reserved = reserve
			}
		} catch (err: unknown) {
			this.log.warn(
				{ err: safeErrorFields(err) },
				"IQ capture claim failed; identifying live only",
			)
		}
	}

	/**
	 * Claims the newest unheld finished captures near the target (its own source; trusted tuning or
	 * its observation) up to IDENTIFY_REPLAY_MAX_CAPTURES; returns how many were found near.
	 */
	private claimNear(t: TargetState, view: IdentifyTrackView): number {
		const port = this.deps.iqCapture
		if (!port) return 0
		const near = port.near(this.sourceId, view.track.centreHz, t.toleranceHz, {
			observationId: view.observationId,
			limit: IDENTIFY_REPLAY_MAX_CAPTURES,
		})
		for (const c of near) {
			if (t.replay.claimed.length >= IDENTIFY_REPLAY_MAX_CAPTURES) break
			if (
				c.sourceId !== this.sourceId ||
				t.replay.claimed.includes(c.captureId) ||
				!(
					c.tuningTrust === "commanded" ||
					c.tuningTrust === "relay" ||
					c.observationId === view.observationId
				) ||
				// the target's own transmission only: its epoch, or its observation.
				!(c.epoch === view.epoch || c.observationId === view.observationId)
			)
				continue
			if (port.claim(c.captureId, this.record.id)) {
				t.replay.claimed.push(c.captureId)
				t.replay.views.set(c.captureId, {
					epoch: c.epoch,
					observationId: c.observationId,
					tuningTrust: captureTrust(c.tuningTrust),
				})
			}
		}
		return near.length
	}

	/**
	 * After the live runs: claim the requested capture once it finished, then one replay step per tick
	 * (a probe run, or the analog trial that shares the queue). True while the target must keep waiting.
	 * A decode that stops the probes skips every remaining probe and analog item.
	 */
	private replayStep(t: TargetState, now: number): boolean {
		const port = this.deps.iqCapture
		const rp = t.replay
		if (
			!port ||
			this.phase !== "running" ||
			this.record.state !== "running" ||
			!t.view
		)
			return false
		const stopProbes = t.decoded !== null && !this.deps.identify.exhaustive
		try {
			if (!stopProbes && rp.requested !== null) {
				const id = rp.requested
				const done =
					rp.reserved && port.view
						? port.view(id) !== null
						: port
								.near(this.sourceId, t.view.track.centreHz, t.toleranceHz, {
									observationId: t.view.observationId,
									limit: IDENTIFY_REPLAY_MAX_CAPTURES + 1,
								})
								.some(c => c.captureId === id)
				if (done) {
					const reserved = rp.reserved
					rp.requested = null
					rp.reserved = false
					if (
						rp.claimed.length < IDENTIFY_REPLAY_MAX_CAPTURES &&
						port.claim(id, this.record.id)
					) {
						rp.claimed.push(id)
						// Requested for the resolved track: its epoch and observation, or the capture's own.
						const cv = port.view?.(id)
						rp.views.set(id, {
							epoch: cv?.epoch ?? t.view.epoch,
							observationId: cv?.observationId ?? t.view.observationId,
							tuningTrust: captureTrust(cv?.tuningTrust),
						})
					} else if (reserved) port.settle(id, this.record.id)
				} else if (rp.waitUntil === null) {
					// The track may still be on air: finish the capture now, then wait a bounded time for it.
					port.end(id)
					rp.waitUntil = now + IDENTIFY_REPLAY_CAPTURE_WAIT_MS
					return true
				} else if (now < rp.waitUntil) return true
				else this.dropRequested(t) // never finished in time
			}
			// Review M2: captures of the target finished meanwhile (the queue left them to this job).
			if (
				!stopProbes &&
				rp.queue === null &&
				rp.claimed.length < IDENTIFY_REPLAY_MAX_CAPTURES
			)
				this.claimNear(t, t.view)
		} catch (err: unknown) {
			this.log.warn({ err: safeErrorFields(err) }, "IQ capture lookup failed")
			this.dropRequested(t)
		}
		rp.queue ??= this.replayQueue(t)
		// Req 5.5: one analog trial at a time, and never beside a replay probe.
		// Each trial's own deadline is ANALOG_REPLAY_TRIAL_DEADLINE_MS from its start.
		// Past that, abort it: cancelled, no match and no miss, so the target can finish
		// and release the capture.
		if (this.analogReplayOpen(t)) {
			this.expireAnalog(t, now)
			if (this.analogReplayOpen(t)) return true
		}
		while (rp.queue.length > 0) {
			const next = rp.queue.shift()
			if (!next) break
			if (next.kind === "analog") {
				if (stopProbes) continue
				if (this.startAnalogItem(t, next.captureId) === "running") return true
				continue
			}
			// R4.6 is per capture. A digital decode still stops every remaining probe.
			if (t.analogStopped.has(next.captureId)) continue
			if (stopProbes) continue
			if (this.startReplayRun(t, next, now)) return true
		}
		return false
	}

	/** Probe replays for one capture, plus its analog trial after the known-protocol run (else first). */
	private replayQueue(t: TargetState): ReplayWork[] {
		const out: ReplayWork[] = []
		for (const captureId of t.replay.claimed)
			out.push(...this.replayItemsForCapture(t, captureId))
		return out
	}

	private replayItemsForCapture(
		t: TargetState,
		captureId: string,
	): ReplayWork[] {
		const probes = this.probeReplayItems(t, captureId)
		if (!this.analogWorkFor(t, captureId)) return probes
		const analog: ReplayWork = { kind: "analog", captureId }
		const knownRun = this.knownPlanRun(t)
		const at = probes.findIndex(
			item => item.kind === "probe" && item.planRun === knownRun,
		)
		if (at >= 0) probes.splice(at + 1, 0, analog)
		else probes.unshift(analog)
		// Req 5.5: the analog trial counts as one of the eight. Probe-only queues stay unsliced.
		return probes.slice(0, IQ_REPLAY_MAX_TRIALS)
	}

	private analogWorkFor(t: TargetState, captureId: string): boolean {
		return (
			captureId.length > 0 &&
			this.deps.analogTrial !== undefined &&
			this.analogChoice(t) !== null &&
			!t.analogArmed.has(captureId)
		)
	}

	/** The known protocol's plan run, when that protocol has a probe mode. */
	private knownPlanRun(t: TargetState): number | null {
		const known = t.known
		if (!known) return null
		const planned = t.plan?.trials.find(p => p.protocol === known.protocol)
		return planned?.run ?? null
	}

	private probeReplayItems(t: TargetState, captureId: string): ReplayWork[] {
		const out: ReplayWork[] = []
		const runs = t.plan?.runs ?? []
		runs.forEach((run, planRun) => {
			const type = run.mode.decoderType
			const live = t.plan?.trials.flatMap((p, i) =>
				p.run === planRun && t.trials[i] ? [t.trials[i]!] : [],
			)
			if (
				type === "rtl433" ||
				t.memoSkip.has(planRun) ||
				this.unavailableTypes.has(type as ScannerProbeDecoderType) ||
				(live ?? []).some(
					x => x.outcome === "decoded" || x.outcome === "unsupported",
				)
			)
				return
			out.push({ kind: "probe", captureId, planRun })
		})
		return out
	}

	/** Requests one replay run; false when it cannot run (no replay transport, stale source): skipped. */
	private startReplayRun(
		t: TargetState,
		next: { captureId: string; planRun: number },
		now: number,
	): boolean {
		const view = t.view
		const run = t.plan?.runs[next.planRun]
		if (!view || !run) return false
		// the replay's evidence is the capture's: its own epoch and observation.
		const cv = t.replay.views.get(next.captureId)
		const observationId = cv?.observationId ?? view.observationId
		const req: ProbeRequest = {
			jobId: this.record.id,
			priority: IDENTIFY_PROBE_PRIORITY,
			sourceId: this.sourceId,
			trackId: view.trackId,
			observationId,
			discoveryId: this.deps.discoveryOf(observationId)?.id ?? null,
			targetHz: view.track.centreHz,
			epoch: cv?.epoch ?? view.epoch,
			cls: run.cls,
			protocols: run.protocols,
			modes: [run.mode],
			preRollFromSample: null,
			holdMs: run.holdMs,
			record: false,
			admission: { kind: "protocol-target", snrDb: view.track.snrDb },
			replay: { captureId: next.captureId },
		}
		const res = this.request(req)
		const state: RunState = {
			runIndex: -1,
			run,
			req,
			probeId: null,
			queuedUntil: null,
			endsAt: null,
			seen: new Map(),
			unavailable: false,
			replayDone: false,
			replay: { captureId: next.captureId, planRun: next.planRun },
		}
		if ("started" in res) {
			t.active.push(state)
			this.begin(t, state, res.started, now)
		} else if (
			res.deferred === "max-probes" ||
			res.deferred === "budget" ||
			res.deferred === "cpu"
		) {
			state.queuedUntil = now + IDENTIFY_QUEUE_WAIT_MS
			t.active.push(state)
		} else return false
		this.emitTarget(t)
		return true
	}

	/**
	 * A finished replay run decides its plan run's trials only where it adds a verdict: a decode, or a
	 * completed outcome over a live trial that never completed (cancelled, skipped). Transport `replay` then.
	 */
	private applyReplayRun(t: TargetState, r: RunState, cutShort: boolean): void {
		const replay = r.replay
		if (!replay || cutShort) return
		t.plan?.trials.forEach((planned, i) => {
			const trial = t.trials[i]
			if (planned.run !== replay.planRun || !trial) return
			const outcome = trialOutcome(r.seen.get(planned.protocol))
			if (
				outcome === "decoded" ||
				(COMPLETED.has(outcome) && !COMPLETED.has(trial.outcome))
			) {
				trial.outcome = outcome
				trial.transport = "replay"
			}
		})
	}

	private confirmLive(observationId: string): void {
		try {
			this.deps.iqCapture?.confirmLive(this.sourceId, observationId)
		} catch (err: unknown) {
			this.log.warn(
				{ err: safeErrorFields(err) },
				"IQ capture live confirmation failed",
			)
		}
	}

	/** A reserved capture that is no use any more is released (discarded); others are left to the TTL. */
	private dropRequested(t: TargetState): void {
		const id = t.replay.requested
		const reserved = t.replay.reserved
		t.replay.requested = null
		t.replay.reserved = false
		if (id === null || !reserved) return
		try {
			this.deps.iqCapture?.settle(id, this.record.id)
		} catch (err: unknown) {
			this.log.warn({ err: safeErrorFields(err) }, "IQ capture settle failed")
		}
	}

	/**
	 * Review M2: whether this job works on the capture's observation (a target resolved to it that has
	 * no result yet, or a job still collecting that covers its frequency): the replay queue leaves the
	 * capture for this job.
	 */
	worksOn(capture: IqCaptureView): boolean {
		if (this.phase === "finished" || capture.sourceId !== this.sourceId)
			return false
		if (this.phase === "idle" || this.phase === "collecting")
			return this.covers(capture.sourceId, capture.rfHz)
		return this.targets.some(
			t =>
				!FINAL.has(t.state) &&
				capture.observationId !== null &&
				t.view?.observationId === capture.observationId,
		)
	}

	/** Discards every capture this target holds; safe to repeat. */
	private settleTarget(t: TargetState): void {
		const port = this.deps.iqCapture
		this.dropRequested(t)
		const ids = t.replay.claimed.splice(0)
		t.replay.views.clear()
		if (!port) return
		for (const id of ids)
			try {
				port.settle(id, this.record.id)
			} catch (err: unknown) {
				this.log.warn({ err: safeErrorFields(err) }, "IQ capture settle failed")
			}
	}

	private request(req: ProbeRequest): ReturnType<ProbePool["request"]> {
		this.requesting = true
		try {
			return this.deps.probes.request(req)
		} finally {
			this.requesting = false
		}
	}

	private releaseRuns(runs: readonly RunState[]): void {
		const pending: Promise<void>[] = []
		for (const r of runs) {
			if (r.probeId) pending.push(this.deps.probes.release(r.probeId))
			else this.deps.probes.dequeue(r.req)
			r.probeId = null
		}
		if (pending.length > 0) this.hold(Promise.all(pending))
	}

	private hold(p: Promise<unknown>): void {
		this.inflight += 1
		void p
			.catch((err: unknown) => this.log.warn({ err }, "Identify step failed"))
			.finally(() => {
				this.inflight -= 1
			})
	}

	private setTrials(
		t: TargetState,
		runIndex: number,
		outcome: (
			protocol: ScannerProtocol,
			trial: ScannerIdentifyTrial,
		) => ScannerTrialOutcome,
	): void {
		t.plan?.trials.forEach((planned, i) => {
			const trial = t.trials[i]
			if (planned.run === runIndex && trial)
				trial.outcome = outcome(planned.protocol, trial)
		})
	}

	private findRun(
		match: (r: RunState) => boolean,
	): { t: TargetState; r: RunState } | null {
		for (const t of this.targets)
			for (const r of t.active) if (match(r)) return { t, r }
		return null
	}

	private eventOf(t: TargetState): ScannerIdentifyEventData {
		return {
			jobId: this.record.id,
			targetHz: t.targetHz,
			state: t.state,
			trials: t.trials.map(x => ({ ...x })),
			...(t.result ? { result: t.result } : {}),
		}
	}

	private emitTarget(t: TargetState): void {
		this.deps.emit(this.eventOf(t))
	}

	private detach(): void {
		if (this.detached) return
		this.detached = true
		// Shutdown, dispose, or any end path that did not settle: no capture stays held by a finished job.
		for (const t of this.targets) this.settleTarget(t)
		if (this.deps.iqCapture)
			this.deps.probes.off("replay-end", this.onReplayEnd)
		this.deps.probes.off("probe-state", this.onProbeState)
		this.deps.probes.off("evidence", this.onPoolEvidence)
		this.deps.probes.off("decoder-unavailable", this.onDecoderUnavailable)
	}
}

/**
 * Replay-first confirm (WG12 req 4.2, 4.3) and the replay result's evidence
 * mapping (req 4.5, design A12). Pure: the scanner-service diff calls these
 * and writes nothing else onto an observation. The result is untrusted. Only
 * known outcomes, finite numbers and known tones are forwarded. `not-needed`
 * trials are skipped. The analog trial is recorded as decoder `analog-demod`
 * with transport `replay`. A positive analog trial is recorded only when
 * `result.analog` judges to the same outcome and the mode that trial
 * requested; a mode mismatch is `cancelled` and is not a successful replay.
 * Otherwise that trial is `cancelled`. A validated analog `decoded` or
 * `heard` is a successful replay. `not-needed` and `skipped-budget` are not
 * unsuccessful attempts.
 * Capture state, the first gate-pass request and a capture
 * removed before its replay settles are decided here so the seam stays thin.
 */
import type {
	ScannerProbeDecoderType,
	ScannerTrialOutcome,
} from "@wavekit/api-types"
import type {
	IqReplayResult,
	IqReplayTrialOutcome,
} from "../scanner/iq-capture-contract.js"
import type {
	AnalogTrialMode,
	ChannelGateState,
	ObservationEvidenceSink,
} from "../scanner/scanner-redesign-contract.js"
import type { ScannerProtocol } from "../scanner/types.js"
import { judgeAnalogResult } from "./analog-result.js"

export interface LiveConfirmInput {
	gate: ChannelGateState | undefined
	captureRunning: boolean
	capturePending: boolean
	replayEnded: boolean
	replayDecoded: boolean
	trackOpen: boolean
	discoveryDecoded: boolean
	emitterOnAir: boolean
}

const PROTOCOLS: Record<ScannerProtocol, true> = {
	"analog-fm": true,
	"analog-am": true,
	dmr: true,
	p25p1: true,
	p25p2: true,
	nxdn48: true,
	nxdn96: true,
	ysf: true,
	dstar: true,
	dpmr: true,
	pocsag: true,
	flex: true,
	aprs: true,
	ism: true,
	"digital-unknown": true,
	carrier: true,
	unknown: true,
	ais: true,
	acars: true,
	vdl2: true,
	lora: true,
	adsb: true,
}

const TRIAL_OUTCOMES: Record<ScannerTrialOutcome, true> = {
	pending: true,
	running: true,
	decoded: true,
	"no-sync": true,
	"crc-errors": true,
	timeout: true,
	"skipped-budget": true,
	unsupported: true,
	"not-needed": true,
	cancelled: true,
	heard: true,
	"data-like": true,
	"carrier-only": true,
}

const PROBE_DECODERS: Record<ScannerProbeDecoderType, true> = {
	"dsd-fme": true,
	"multimon-ng": true,
	direwolf: true,
	rtl433: true,
}

const ANALOG_MODES: Record<AnalogTrialMode, true> = {
	nfm: true,
	am: true,
}

/**
 * Whether a live confirm hold may start. An absent or not-passed gate is the
 * safe answer: false, no live probe. Otherwise true only for requirement 4.2:
 * (a) capture is not running, (b) the track is still open after replay ended
 * without a decode, (c) identity follow-up on a decoded discovery whose
 * emitter is on air. While a capture is pending or its replay has not ended,
 * the answer stays false, including for (c).
 */
export function needsLiveConfirm(input: LiveConfirmInput): boolean {
	if (input.gate !== "passed") return false
	if (!input.captureRunning) return true
	if (input.capturePending || !input.replayEnded) return false
	if (!input.replayDecoded && input.trackOpen) return true
	if (input.discoveryDecoded && input.emitterOnAir) return true
	return false
}

/**
 * True only when `port.state()` is `"on"`. The call stays on the port: the
 * capture service reads `this.st`, and a method pulled off the object throws
 * (then looks like capture is off). A missing method or any throw is off, so
 * confirm keeps today's path.
 */
export function captureServiceIsOn(
	port: { state?: () => unknown } | null | undefined,
	onError?: (err: unknown) => void,
): boolean {
	if (!port || typeof port.state !== "function") return false
	try {
		return port.state() === "on"
	} catch (err: unknown) {
		try {
			onError?.(err)
		} catch {
			// A logger failure stays off.
		}
		return false
	}
}

/** Bookkeeping the seam holds for one observation, as `needsLiveConfirm` reads it. */
export interface ReplayConfirmSnapshot {
	serviceOn: boolean
	refused: boolean
	pendingCapture: boolean
	replaySettled: boolean
	replayDecoded: boolean
	acceptedIdentity: boolean
	gate: ChannelGateState | undefined
	trackOpen: boolean
	discoveryDecoded: boolean
	emitterOnAir: boolean
}

/**
 * A settled replay follows the service's own on/off. Otherwise the service
 * being off, a refusal, or an accepted identity whose capture is already gone
 * is not running. Pending is an accepted capture with no result yet.
 */
export function replayCaptureRunning(
	snapshot: Pick<
		ReplayConfirmSnapshot,
		| "serviceOn"
		| "refused"
		| "pendingCapture"
		| "replaySettled"
		| "acceptedIdentity"
	>,
): boolean {
	if (snapshot.replaySettled) return snapshot.serviceOn
	if (!snapshot.serviceOn) return false
	if (snapshot.refused) return false
	if (snapshot.acceptedIdentity && !snapshot.pendingCapture) return false
	return true
}

/** The seam's capture flags, in the shape `needsLiveConfirm` takes. */
export function replayConfirmInput(
	snapshot: ReplayConfirmSnapshot,
): LiveConfirmInput {
	return {
		gate: snapshot.gate,
		captureRunning: replayCaptureRunning(snapshot),
		capturePending: snapshot.pendingCapture && !snapshot.replaySettled,
		replayEnded: snapshot.replaySettled,
		replayDecoded: snapshot.replayDecoded,
		trackOpen: snapshot.trackOpen,
		discoveryDecoded: snapshot.discoveryDecoded,
		emitterOnAir: snapshot.emitterOnAir,
	}
}

export interface GatePassCaptureInput {
	synthetic: boolean
	late: boolean
	closing: boolean
	gate: ChannelGateState | undefined
	hasDiscovery: boolean
	/** The one-second ingest throttle already ran for this snapshot. */
	ingestedThisSnapshot: boolean
	/** An earlier snapshot already ingested, or the throttle just did. */
	everIngested: boolean
	/** `requestIqCapture` already passed the once-per-transmission gate. */
	alreadyRequested: boolean
}

export interface GatePassCaptureDecision {
	/**
	 * Ingest now, ahead of the one-second throttle, so a discovery exists.
	 * The caller does this before `request`.
	 */
	materialize: boolean
	/** Ask `requestIqCapture` once. Its WG11 6.3 bounds still decide. */
	request: boolean
}

/**
 * First open gate pass of a real track. Inside the first second the throttle
 * has not ingested, so materialize the discovery once, then request capture.
 * A later pass with `alreadyRequested` does not request again. Closing,
 * synthetic, late and not-passed gates do not ask. Spur, image, span and the
 * per-source cap stay inside `requestIqCapture`.
 */
export function gatePassCapture(
	input: GatePassCaptureInput,
): GatePassCaptureDecision {
	const ask =
		!input.synthetic &&
		!input.late &&
		!input.closing &&
		input.gate === "passed" &&
		!input.alreadyRequested
	return {
		materialize:
			ask &&
			!input.hasDiscovery &&
			!input.ingestedThisSnapshot &&
			!input.everIngested,
		request: ask,
	}
}

export interface PendingCapture {
	observationId: string
	captureId: string
}

/**
 * An accepted capture left the store with no replay result (native abort or
 * error). Returns the observation whose pending capture the seam drops and
 * gives up, so live confirm sees capture not running. A different capture, or
 * one whose replay already settled, is left alone.
 */
export function captureRemovedRelease(input: {
	removedCaptureId: string
	removedObservationId: string | null
	pending: readonly PendingCapture[]
	settledObservationIds: { has(observationId: string): boolean }
}): string | null {
	const match = input.pending.find(entry => {
		if (entry.captureId !== input.removedCaptureId) return false
		return (
			input.removedObservationId === null ||
			entry.observationId === input.removedObservationId
		)
	})
	if (!match) return null
	if (input.settledObservationIds.has(match.observationId)) return null
	return match.observationId
}

/**
 * Maps one replay result onto `ObservationEvidenceSink`. One `nextTrialOrder`
 * per trial that is kept, in result order. Nothing else is called: no miss
 * and no undecoded mark, including for `unsupported`. A positive analog-demod
 * trial is forwarded only when `result.analog` judges to that same outcome,
 * the analog-demod trial's own outcome equals that judged outcome, and the
 * mode the trial requested. A cancelled trial beside a valid decoded analog
 * is not positive: `recordAnalog` is not called. A mode mismatch is not
 * positive either, and the trial is recorded as `cancelled`. A malformed
 * positive analog result is not passed to `recordAnalog`.
 */
export function replayEvidenceCalls(
	result: IqReplayResult,
	observationId: string,
	sink: ObservationEvidenceSink,
	at: number,
): void {
	if (!Number.isFinite(at)) return
	if (typeof observationId !== "string" || observationId.length === 0) return
	if (!isObject(result)) return
	const trials = Array.isArray(result.trials) ? result.trials : []
	const judged = judgeAnalogResult(result.analog, requestedAnalogMode(trials))
	for (const trial of trials)
		recordTrial(trial, observationId, sink, at, judged)
	const analog = judged.analog
	if (analog && analogTrialOutcome(trials) === judged.outcome)
		sink.recordAnalog(observationId, {
			outcome: analog.outcome,
			mode: analog.mode,
			voice: analog.voice,
			tone: {
				ctcssHz: analog.tones.ctcssHz,
				dcs: analog.tones.dcs,
			},
			transport: "replay",
			at,
		})
	for (const type of unavailableTypes(result.unavailable))
		sink.recordUnavailable(observationId, type)
}

/** Trials that do not count as an unsuccessful replay attempt. */
const NOT_UNSUCCESSFUL: ReadonlySet<string> = new Set([
	"cancelled",
	"decoded",
	"unsupported",
	"not-needed",
	"skipped-budget",
])

type ReplayTrial = IqReplayResult["trials"][number]

export interface ReplayOutcomeSummary {
	/**
	 * A digital decode, or an analog result `judgeAnalogResult` accepted as
	 * `decoded` or `heard` whose outcome equals the analog-demod trial's own
	 * outcome, in the mode that trial requested. A mode mismatch, or a
	 * cancelled trial beside a valid decoded analog, is not a decode. The
	 * seam treats this as a settled successful replay: no `no-sync` mark and
	 * no live re-confirm.
	 */
	replayDecoded: boolean
	/**
	 * Trials that count toward a miss or an undecoded reason, in result order.
	 * `not-needed` and `skipped-budget` are absent. A `heard` trial is absent
	 * when the analog result validated as a positive.
	 */
	unsuccessful: ReplayTrial[]
}

/**
 * Whether this replay decoded, and which trials were unsuccessful attempts.
 * Pure. The scanner-service diff calls it instead of deciding inline.
 * `result` is untrusted: a missing or malformed analog positive is not a
 * decode, and an unknown trial outcome is not bookkeeping.
 */
export function replayOutcomeSummary(
	result: IqReplayResult,
): ReplayOutcomeSummary {
	if (!isObject(result)) return { replayDecoded: false, unsuccessful: [] }
	const trials = Array.isArray(result["trials"]) ? result["trials"] : []
	const judged = judgeAnalogResult(
		result["analog"],
		requestedAnalogMode(trials),
	)
	const analogPositive =
		(judged.outcome === "decoded" || judged.outcome === "heard") &&
		analogTrialOutcome(trials) === judged.outcome
	const unsuccessful: ReplayTrial[] = []
	for (const trial of trials) {
		if (!isObject(trial)) continue
		const outcome = knownOutcome(trial["outcome"])
		if (!outcome || !countsAsUnsuccessful(outcome, analogPositive)) continue
		unsuccessful.push(trial as ReplayTrial)
	}
	return {
		replayDecoded: result["decoded"] != null || analogPositive,
		unsuccessful,
	}
}

function countsAsUnsuccessful(
	outcome: string,
	analogPositive: boolean,
): boolean {
	if (NOT_UNSUCCESSFUL.has(outcome)) return false
	if (outcome === "heard" && analogPositive) return false
	return true
}

function recordTrial(
	trial: unknown,
	observationId: string,
	sink: ObservationEvidenceSink,
	at: number,
	judged: ReturnType<typeof judgeAnalogResult>,
): void {
	if (!isObject(trial)) return
	let outcome = knownOutcome(trial["outcome"])
	if (!outcome || outcome === "not-needed") return
	if (isAnalogTrial(trial) && (outcome === "decoded" || outcome === "heard")) {
		if (!analogTrialAgrees(trial, outcome, judged)) outcome = "cancelled"
	}
	const protocol = knownProtocol(trial["protocol"])
	const decoder = decoderOf(trial)
	if (!protocol || !decoder) return
	const order = sink.nextTrialOrder()
	sink.recordTrial(observationId, {
		protocol,
		decoder,
		outcome,
		order,
		at,
	})
}

/**
 * Mode the analog trial requested, when the result records one. The same
 * value `judgeAnalogResult` uses for the queue, evidence and the summary.
 */
/** Outcome stored on the analog-demod trial, when the result has one. */
function analogTrialOutcome(trials: readonly unknown[]): string | undefined {
	for (const trial of trials) {
		if (!isObject(trial) || !isAnalogTrial(trial)) continue
		const outcome = trial["outcome"]
		return typeof outcome === "string" ? outcome : undefined
	}
	return undefined
}

function requestedAnalogMode(
	trials: readonly unknown[],
): AnalogTrialMode | undefined {
	for (const trial of trials) {
		if (!isObject(trial) || !isAnalogTrial(trial)) continue
		if (isAnalogMode(trial["mode"])) return trial["mode"]
	}
	return undefined
}

/**
 * A positive analog-demod trial agrees when the judged analog result has the
 * same outcome and the mode the trial requested. A mismatch was already
 * dropped by `judgeAnalogResult`, so `analog` is null and this returns false.
 */
function analogTrialAgrees(
	trial: Record<string, unknown>,
	outcome: IqReplayTrialOutcome,
	judged: ReturnType<typeof judgeAnalogResult>,
): boolean {
	const analog = judged.analog
	if (!analog || judged.outcome !== outcome) return false
	return trial["mode"] === analog.mode
}

function decoderOf(trial: Record<string, unknown>): string | null {
	if (isAnalogTrial(trial)) return "analog-demod"
	const decoder = trial["decoder"]
	const decoderType = trial["decoderType"]
	if (isProbeDecoder(decoder)) return decoder
	if (isProbeDecoder(decoderType)) return decoderType
	return null
}

function isAnalogTrial(trial: Record<string, unknown>): boolean {
	return isAnalogMode(trial["mode"]) || trial["decoder"] === "analog-demod"
}

function unavailableTypes(raw: unknown): ScannerProbeDecoderType[] {
	if (!Array.isArray(raw)) return []
	const out: ScannerProbeDecoderType[] = []
	for (const type of raw) {
		if (!isProbeDecoder(type) || out.includes(type)) continue
		out.push(type)
	}
	return out
}

function knownOutcome(value: unknown): ScannerTrialOutcome | null {
	return typeof value === "string" && isTrialOutcome(value) ? value : null
}

function knownProtocol(value: unknown): ScannerProtocol | null {
	return typeof value === "string" && isProtocol(value) ? value : null
}

function isProtocol(value: string): value is ScannerProtocol {
	return Object.prototype.hasOwnProperty.call(PROTOCOLS, value)
}

function isTrialOutcome(value: string): value is ScannerTrialOutcome {
	return Object.prototype.hasOwnProperty.call(TRIAL_OUTCOMES, value)
}

function isAnalogMode(value: unknown): value is AnalogTrialMode {
	return (
		typeof value === "string" &&
		Object.prototype.hasOwnProperty.call(ANALOG_MODES, value)
	)
}

function isProbeDecoder(value: unknown): value is ScannerProbeDecoderType {
	return (
		typeof value === "string" &&
		Object.prototype.hasOwnProperty.call(PROBE_DECODERS, value)
	)
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null
}

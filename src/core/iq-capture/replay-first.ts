/**
 * Replay-first confirm (WG12 req 4.2, 4.3) and the replay result's evidence
 * mapping (req 4.5, design A12). Pure: the scanner-service diff calls these
 * and writes nothing else onto an observation. The result is untrusted. Only
 * known outcomes, finite numbers and known tones are forwarded. `not-needed`
 * trials are skipped. The analog trial is recorded as decoder `analog-demod`
 * with transport `replay`. A malformed `heard` or `decoded` analog result is
 * not recorded. Capture state, the first gate-pass request and a capture
 * removed before its replay settles are decided here so the seam stays thin.
 */
import type {
	ScannerProbeDecoderType,
	ScannerTrialOutcome,
} from "@wavekit/api-types"
import type { IqReplayResult } from "../scanner/iq-capture-contract.js"
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
 * and no undecoded mark, including for `unsupported`. A malformed positive
 * analog result is not recorded.
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
	for (const trial of trials) recordTrial(trial, observationId, sink, at)
	const judged = judgeAnalogResult(result.analog)
	const analog = judged.analog
	if (analog)
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

function recordTrial(
	trial: unknown,
	observationId: string,
	sink: ObservationEvidenceSink,
	at: number,
): void {
	if (!isObject(trial)) return
	const outcome = knownOutcome(trial["outcome"])
	if (!outcome || outcome === "not-needed") return
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

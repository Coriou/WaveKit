/**
 * Tuner Controller - Primary RTL-TCP tuner control interface.
 *
 * Provides direct tuning control for rtl_tcp/rtlmux sources and supports
 * releasing control to external tuner clients (e.g., SDR++ via TunerRelay).
 */

import type { RatePolicy } from "./rate-policy-contract.js"
import { safeErrorFields } from "../decoders/safe-error-fields.js"
import { AsyncLocalStorage } from "node:async_hooks"
import { EventEmitter } from "node:events"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import { WaveKitError } from "../utils/errors.js"
import type {
	SourceCaps,
	SourceConfig,
	SourceManager,
} from "./source-manager.js"
import type { SourceTunerConfig } from "../config.js"
import {
	ReceiptOnce,
	TuningLedger,
	type FieldState,
	type GatedField,
	type LedgerChange,
	type LedgerConnection,
	type ReceiptCallback,
	type TuningWriterTag,
} from "./tuning-ledger.js"
import { configuredTuningFrames } from "./tuner-config-gain.js"
import { nearestGainStep } from "./band-gain-schema.js"
import type { BandGainSettingsService, SavedOperatorGain } from "./band-gain.js"
import type {
	SourceFeedRestoreTuning,
	TunerBandGain,
	TunerBandGainOwner,
	TunerState,
	TunerStateField,
	TunerGainMode,
	TunerDirectSampling,
	TunerControlMode,
	TunerCommandOrigin,
	TunerChangeActor,
	TunerChangeField,
	TunerChangeReason,
	TunerLastChange,
	TunerRatePolicyEventData,
	TuneRestore,
	TuneRestoreTuning,
	TuneSetting,
	TunerLastTune,
	TunerFieldProof,
	TunerTuningProof,
} from "@wavekit/api-types"

/**
 * Optional last argument of every write. `origin` is reported on
 * "command-sent" (signal discovery spec § 10.3). `accept: false` writes the
 * command and updates state and caps, marks the field known (inferred) and
 * records no desired field; a field accepted earlier is still replayed with
 * its current value. Test mode is never a desired field, so it is never replayed.
 * `actor`, `jobId` and `restore` only describe the write for `lastChange`: `actor` says who a
 * REST write came from (from the request's access principal, never from the client), `jobId`
 * which job's lease a scanner write serves, `restore` that it puts the snapshot back (a scanner
 * lease's, or with origin "rest" a temporary tune's; that one is no operator gain choice).
 * `beforeWrite` runs in the same synchronous section as each frame of the write, band gain and rate
 * proof included: a throw stops it with nothing sent. `run` says which tune a write belongs to.
 * `forceWrite` is read by `applyTune` for each setting: true sends the frame even for a value in
 * place and proven, as a tune that takes a job's lease needs one for the arbiter to see.
 */
export interface TunerWriteOptions {
	origin?: TunerCommandOrigin
	accept?: boolean
	actor?: Extract<TunerChangeActor, "web" | "agent">
	jobId?: string
	restore?: boolean
	beforeWrite?: () => void
	run?: TuneWriteRun
	forceWrite?: () => boolean
	/**
	 * The call's tuning-ledger receipt once its frames left the socket: called at most once per
	 * call, with the receipt of its last frame, or null when any frame got none. A call that can
	 * write several frames (setFrequency with the band gain or rate proof, configure, applyTune)
	 * folds them into exactly one call, null when it wrote none. Information only: it changes
	 * nothing in the write.
	 */
	onReceipt?: ReceiptCallback
}

/**
 * One POST /tune, by identity: "last-change" hands it back, so a tune tells its own writes from
 * anybody else's whatever their actor or reason. A temporary tune sets `keepsSavedGain`: while it
 * is temporary it writes nothing to the file of gains saved before a band, in any path. It becomes
 * an operator tune, once, only if it stays (TunerController.noteTuneKept).
 */
export interface TuneWriteRun {
	keepsSavedGain: boolean
}

/**
 * Writes of one actor, reason and job this close (under a second) extend `lastChange.fields`
 * instead of replacing it: a hop or a PATCH writes its fields back to back. Merging only ever
 * adds a closed field once, so a fast sweep cannot grow it past TUNER_CHANGE_FIELDS (15).
 */
export const TUNER_CHANGE_MERGE_MS = 1_000

/** A tune's settings under GET /api/tuner's names; absent settings are left alone. */
export type TuneValues = TuneRestoreTuning

/** `restore` and `lastTune` of a source's published state. */
type TuneStatusOf = (sourceId: string) => {
	restore?: TuneRestore
	lastTune?: TunerLastTune
}

/** What `tuneSnapshot` read before a temporary tune. */
export interface TuneSnapshot {
	/** The fields the core knows (not in `unknownFields`). */
	state: TuneValues
	bandGain?: TunerBandGain
}

/**
 * Sample rates the RTL2832U accepts. librtlsdr's rtlsdr_set_sample_rate()
 * rejects 300 001-900 000 Hz, so the overall 225 001-3 200 000 bound is not
 * enough: a gap rate would be recorded in caps and replayed on reconnect
 * while the dongle keeps its previous rate.
 */
export const RTL_SAMPLE_RATE_RANGES = [
	{ min: 225_001, max: 300_000 },
	{ min: 900_001, max: 3_200_000 },
] as const

/** True when librtlsdr can set `hz` (an integer in one of the RTL ranges). */
export function isValidRtlSampleRate(hz: number): boolean {
	return (
		Number.isInteger(hz) &&
		RTL_SAMPLE_RATE_RANGES.some(range => hz >= range.min && hz <= range.max)
	)
}

/**
 * Rates rtl_tcp clients commonly set (SDR++, rtl_sdr tools). adoptObservedSampleRate snaps a
 * measured rate to one of them. The closest neighbours are 2.048 and 2.16 Msps (5.5 % apart),
 * so two ±RESUME_RATE_MATCH windows (3 % together) never overlap.
 */
export const COMMON_RTL_SAMPLE_RATES = [
	250_000, 1_024_000, 1_536_000, 1_792_000, 1_920_000, 2_048_000, 2_160_000,
	2_400_000, 2_560_000, 2_880_000, 3_200_000,
] as const

/** Relative distance within which a measured rate counts as a common rate (1.5 %). */
export const RESUME_RATE_MATCH = 0.015

/** Fields a plain resume never writes and reports unknown until set (synchronizeOnPlainResume). */
const PLAIN_RESUME_UNVERIFIED: readonly TunerStateField[] = [
	"frequency",
	"sampleRate",
	"gainMode",
	"gain",
]

// Validation constants
const VALIDATION = {
	frequency: { min: 24_000_000, max: 1_900_000_000 },
	/** Outer bound only; see RTL_SAMPLE_RATE_RANGES for the gap. */
	sampleRate: { min: 225_001, max: 3_200_000 },
	gain: { min: 0, max: 500 },
	ppm: { min: -500, max: 500 },
	uint32: { min: 0, max: 0xffffffff },
	uint16: { min: 0, max: 0xffff },
} as const

/** The tuner's value bounds, for route schemas: the controller still checks every write. */
export const TUNER_VALUE_BOUNDS = VALIDATION

const DEFAULT_FREQUENCY = 100_000_000

/**
 * The saved pre-band gain write (temp file, fsync, rename of at most 8 KiB) normally takes
 * well under 100 ms; 5 s is 50x that. Past it the save counts as failed (no band gain), so
 * one stuck write never holds the per-source REST retune queue.
 */
export const OPERATOR_GAIN_SAVE_TIMEOUT_MS = 5_000

function withSaveTimeout(save: Promise<boolean>): Promise<boolean> {
	let timer: NodeJS.Timeout | undefined
	const expiry = new Promise<boolean>(resolve => {
		timer = setTimeout(() => resolve(false), OPERATOR_GAIN_SAVE_TIMEOUT_MS)
		timer.unref()
	})
	return Promise.race([save, expiry]).finally(() => clearTimeout(timer))
}
const DEFAULT_SAMPLE_RATE = 2_400_000

// RTL-TCP commands (mirrored from tuner-relay.ts for consistency)
const RTL_TCP_COMMANDS = {
	SET_FREQUENCY: 0x01,
	SET_SAMPLE_RATE: 0x02,
	SET_GAIN_MODE: 0x03,
	SET_GAIN: 0x04,
	SET_FREQ_CORRECTION: 0x05,
	SET_IF_GAIN: 0x06,
	SET_TEST_MODE: 0x07,
	SET_AGC_MODE: 0x08,
	SET_DIRECT_SAMPLING: 0x09,
	SET_OFFSET_TUNING: 0x0a,
	SET_RTL_XTAL: 0x0b,
	SET_TUNER_XTAL: 0x0c,
	SET_TUNER_GAIN_INDEX: 0x0d,
	SET_BIAS_TEE: 0x0e,
	SET_TUNER_IF_GAIN: 0x0f,
} as const

function freezeRestPolicy<T extends readonly object[]>(rows: T): T {
	for (const row of rows) Object.freeze(row)
	Object.freeze(rows)
	return rows
}

/** The admitted REST argument policy, independent of receiver qualification. */
export const TUNER_REST_COMMAND_POLICY = freezeRestPolicy([
	{
		id: "frequency",
		unit: "Hz",
		opcode: RTL_TCP_COMMANDS.SET_FREQUENCY,
		rule: Object.freeze({ kind: "integer-range", ...VALIDATION.frequency }),
	},
	{
		id: "sampleRate",
		unit: "Hz",
		opcode: RTL_TCP_COMMANDS.SET_SAMPLE_RATE,
		rule: Object.freeze({
			kind: "integer-ranges",
			ranges: Object.freeze([
				Object.freeze({ ...RTL_SAMPLE_RATE_RANGES[0] }),
				Object.freeze({ ...RTL_SAMPLE_RATE_RANGES[1] }),
			] as const),
		}),
	},
	{
		id: "gainMode",
		unit: "enum",
		opcode: RTL_TCP_COMMANDS.SET_GAIN_MODE,
		rule: Object.freeze({
			kind: "enum",
			values: Object.freeze(["manual", "agc"]),
		}),
	},
	{
		id: "gain",
		unit: "tenthsDb",
		opcode: RTL_TCP_COMMANDS.SET_GAIN,
		rule: Object.freeze({ kind: "integer-range", ...VALIDATION.gain }),
	},
	{
		id: "ppm",
		unit: "ppm",
		opcode: RTL_TCP_COMMANDS.SET_FREQ_CORRECTION,
		rule: Object.freeze({ kind: "integer-range", ...VALIDATION.ppm }),
	},
	{
		id: "ifGain",
		unit: "rawInteger",
		opcode: RTL_TCP_COMMANDS.SET_IF_GAIN,
		rule: Object.freeze({ kind: "integer-range", ...VALIDATION.uint32 }),
	},
	{
		id: "testMode",
		unit: "boolean",
		opcode: RTL_TCP_COMMANDS.SET_TEST_MODE,
		rule: Object.freeze({ kind: "boolean" }),
	},
	{
		id: "agcMode",
		unit: "boolean",
		opcode: RTL_TCP_COMMANDS.SET_AGC_MODE,
		rule: Object.freeze({ kind: "boolean" }),
	},
	{
		id: "directSampling",
		unit: "enum",
		opcode: RTL_TCP_COMMANDS.SET_DIRECT_SAMPLING,
		rule: Object.freeze({
			kind: "enum",
			values: Object.freeze(["off", "i", "q"]),
		}),
	},
	{
		id: "offsetTuning",
		unit: "boolean",
		opcode: RTL_TCP_COMMANDS.SET_OFFSET_TUNING,
		rule: Object.freeze({ kind: "boolean" }),
	},
	{
		id: "rtlXtal",
		unit: "Hz",
		opcode: RTL_TCP_COMMANDS.SET_RTL_XTAL,
		rule: Object.freeze({ kind: "integer-range", ...VALIDATION.uint32 }),
	},
	{
		id: "tunerXtal",
		unit: "Hz",
		opcode: RTL_TCP_COMMANDS.SET_TUNER_XTAL,
		rule: Object.freeze({ kind: "integer-range", ...VALIDATION.uint32 }),
	},
	{
		id: "gainIndex",
		unit: "index",
		opcode: RTL_TCP_COMMANDS.SET_TUNER_GAIN_INDEX,
		rule: Object.freeze({ kind: "integer-range", ...VALIDATION.uint32 }),
	},
	{
		id: "biasTee",
		unit: "boolean",
		opcode: RTL_TCP_COMMANDS.SET_BIAS_TEE,
		rule: Object.freeze({ kind: "boolean" }),
	},
	{
		id: "tunerIfGain",
		unit: "stageRawPair",
		opcode: RTL_TCP_COMMANDS.SET_TUNER_IF_GAIN,
		rule: Object.freeze({ kind: "uint16-pair" }),
	},
] as const)

// Command names for logging (matches tuner-relay.ts)
const COMMAND_NAMES: Record<number, string> = {
	0x01: "set-frequency",
	0x02: "set-sample-rate",
	0x03: "set-gain-mode",
	0x04: "set-gain",
	0x05: "set-freq-correction",
	0x06: "set-if-gain",
	0x07: "set-test-mode",
	0x08: "set-agc-mode",
	0x09: "set-direct-sampling",
	0x0a: "set-offset-tuning",
	0x0b: "set-rtl-xtal",
	0x0c: "set-tuner-xtal",
	0x0d: "set-tuner-gain-index",
	0x0e: "set-bias-tee",
	0x0f: "set-tuner-if-gain",
}

/** Tuner fields that can hold an accepted (commanded) desired value. */
type DesiredField =
	| "frequency"
	| "sampleRate"
	| "gainMode"
	| "gain"
	| "ppm"
	| "ifGain"
	| "agcMode"
	| "directSampling"
	| "offsetTuning"
	| "rtlXtal"
	| "tunerXtal"
	| "tunerGainIndex"
	| "biasTee"
	| "tunerIfGain"

const COMMAND_FIELDS: Record<number, DesiredField> = {
	[RTL_TCP_COMMANDS.SET_FREQUENCY]: "frequency",
	[RTL_TCP_COMMANDS.SET_SAMPLE_RATE]: "sampleRate",
	[RTL_TCP_COMMANDS.SET_GAIN_MODE]: "gainMode",
	[RTL_TCP_COMMANDS.SET_GAIN]: "gain",
	[RTL_TCP_COMMANDS.SET_FREQ_CORRECTION]: "ppm",
	[RTL_TCP_COMMANDS.SET_IF_GAIN]: "ifGain",
	[RTL_TCP_COMMANDS.SET_AGC_MODE]: "agcMode",
	[RTL_TCP_COMMANDS.SET_DIRECT_SAMPLING]: "directSampling",
	[RTL_TCP_COMMANDS.SET_OFFSET_TUNING]: "offsetTuning",
	[RTL_TCP_COMMANDS.SET_RTL_XTAL]: "rtlXtal",
	[RTL_TCP_COMMANDS.SET_TUNER_XTAL]: "tunerXtal",
	[RTL_TCP_COMMANDS.SET_TUNER_GAIN_INDEX]: "tunerGainIndex",
	[RTL_TCP_COMMANDS.SET_BIAS_TEE]: "biasTee",
	[RTL_TCP_COMMANDS.SET_TUNER_IF_GAIN]: "tunerIfGain",
}

/** The field each command names in `lastChange` (test mode is no desired field, so it is added). */
const CHANGE_FIELDS: ReadonlyMap<string, TunerChangeField> = new Map<
	string,
	TunerChangeField
>([
	...Object.entries(COMMAND_FIELDS).flatMap(
		([cmd, field]): Array<[string, TunerChangeField]> => {
			const name = COMMAND_NAMES[Number(cmd)]
			return name === undefined ? [] : [[name, field]]
		},
	),
	["set-test-mode", "testMode"],
])

const OPERATOR_WRITER: TuningWriterTag = Object.freeze({ writer: "operator" })
const ASSERT_WRITER: TuningWriterTag = Object.freeze({ writer: "assert" })
const RELAY_WRITER: TuningWriterTag = Object.freeze({ writer: "relay" })

/** The two fields trust depends on, in assert's write order (rate before centre). */
const GATED_FIELDS: readonly GatedField[] = ["sampleRate", "frequency"]

/**
 * Why assert writes nothing for an unproven field (the API's `proof.reason`): rule 1 (a relay
 * client attached, external control, lost ownership), rule 2 (a scanner lease: its holder
 * re-sends its hop) or rule 3 without a held value, the declared fallback being off: a plain
 * resume's hold (`plain-resume`), `tuner.reconnectPolicy: reset` (`reset-policy`) or
 * tuner.writeDeclaredTuningOnConnect false (`declared-write-off`).
 */
type AssertBlock =
	| "lost-ownership"
	| "plain-resume"
	| "reset-policy"
	| "relay-attached"
	| "external-control"
	| "scanner-lease"
	| "declared-write-off"

/** The doubt reason of the spectrum engine's untracked-retune alarm (TunerTuningProof.assertFights). */
const UNTRACKED_RETUNE_DOUBT = "untracked-retune"

/** A scanner lease as the controller sees it (TunerArbiter.setLeaseView). */
export interface TunerLeaseView {
	/** True while a scanner job holds the source's lease. */
	holds(sourceId: string): boolean
	/** The holder re-sends its current hop (assert rule 2); never throws. */
	resend(sourceId: string): void
}

/** The tuning-ledger writer of a write: the scanner's for its origin, else the operator's. */
function writerOf(opts: TunerWriteOptions): TuningWriterTag {
	if (opts.origin !== "scanner") return OPERATOR_WRITER
	return opts.jobId !== undefined
		? { writer: "scanner", jobId: opts.jobId }
		: { writer: "scanner" }
}

/** Who and why, from what the core itself knows of a write; any gap reads `unknown`. */
function changeOf(opts: TunerWriteOptions): {
	actor: TunerChangeActor
	reason: TunerChangeReason
	jobId?: string
} {
	const job = opts.jobId !== undefined ? { jobId: opts.jobId } : {}
	switch (opts.origin) {
		case "rest":
			return opts.restore === true
				? { actor: "restore", reason: "tune-restore" }
				: { actor: opts.actor ?? "unknown", reason: "rest-command" }
		case "scanner":
			return opts.restore === true
				? { actor: "restore", reason: "scanner-restore", ...job }
				: { actor: "scanner-job", reason: "scanner-hop", ...job }
		case "replay":
			return { actor: "restore", reason: "reconnect-replay" }
		case "config":
			return { actor: "config", reason: "source-config" }
		case "decoder-rate":
			return { actor: "decoder-rate", reason: "decoder-rate" }
		default:
			return { actor: "unknown", reason: "unknown" }
	}
}

/**
 * rtl_tcp header tuner types (R820T 5, R828D 6) whose `rtlsdr_set_tuner_gain` selects manual gain.
 * Other tuners set the gain mode apart, so a gain write there proves nothing about it.
 */
const MANUAL_ON_GAIN_TUNER_TYPES: ReadonlySet<number> = new Set([5, 6])

/** Placeholder-capable fields, in TunerState order, for `unknownFields`. */
const STATE_FIELDS: readonly TunerStateField[] = [
	"frequency",
	"sampleRate",
	"gainMode",
	"gain",
	"ppm",
	"agcMode",
	"biasTee",
	"directSampling",
	"offsetTuning",
	"ifGain",
	"tunerIfGain",
	"testMode",
]

/**
 * Reconnect replay order (librtlsdr semantics): sampling path, xtals and PPM
 * first, rate before center, then front-end toggles, then the gain group in
 * acceptance order.
 */
const REPLAY_PHASES: ReadonlyArray<{
	fields: readonly DesiredField[]
	byAcceptance: boolean
}> = [
	{
		fields: ["directSampling", "offsetTuning", "rtlXtal", "tunerXtal", "ppm"],
		byAcceptance: false,
	},
	{ fields: ["sampleRate", "frequency"], byAcceptance: false },
	{ fields: ["biasTee", "agcMode"], byAcceptance: false },
	{
		fields: ["gainMode", "gain", "tunerGainIndex", "ifGain", "tunerIfGain"],
		byAcceptance: true,
	},
]

/**
 * What happens to accepted tuner state when an rtl_tcp source reconnects:
 * "restore" re-sends it, "reset" discards it and falls back to the configured
 * baseline without writing anything to the receiver.
 */
export type TunerReconnectPolicy = "restore" | "reset"

/**
 * How the first session after a paused feed's resume is synchronised (SourceManager.resumeKind):
 * "plain" writes no tuning, "restore" restores the accepted state whatever the policy says.
 */
export type TunerResumeKind = "plain" | "restore"

/** Outcome of synchronizing a source after it (re)connects. */
export interface TunerConnectSyncResult {
	policy: TunerReconnectPolicy
	/** Command names written upstream, in wire order (no hardware acknowledgement). */
	commands: string[]
	/** True when accepted state was discarded under the "reset" policy. */
	reset: boolean
	/** Write failure that stopped the replay; the next connection replays again. */
	error?: string
	/** Set for the session of a resumed paused feed (see synchronizeOnConnect). */
	resume?: TunerResumeKind
}

export interface TunerControllerEvents {
	"rate-policy": (event: TunerRatePolicyEventData) => void
	"state-changed": (sourceId: string, state: TunerState) => void
	"command-sent": (
		sourceId: string,
		command: string,
		value: number,
		origin?: TunerCommandOrigin,
	) => void
	"control-mode-changed": (sourceId: string, mode: TunerControlMode) => void
	/** WG5: the source's tuner state is gone (removeSource); getState now returns undefined. */
	"source-removed": (sourceId: string) => void
	/** A change was recorded for `lastChange`: synchronous, before the state it brings is set. */
	"last-change": (
		sourceId: string,
		change: TunerLastChange,
		run: TuneWriteRun | undefined,
	) => void
	/** An operator's bulk update of tuning fields is done, even if it needed no frame. */
	"operator-choice": (sourceId: string, actor: TunerChangeActor) => void
	error: (sourceId: string, error: Error) => void
}

export interface TunerControllerConfig {
	defaultFrequency?: number
	defaultSampleRate?: number
	/** Reconnect behaviour for accepted tuner state (default "restore"). */
	reconnectPolicy?: TunerReconnectPolicy
	/**
	 * `tuner.writeDeclaredTuningOnConnect` (default true): assert writes the declared centre and
	 * rate (config or caps) to a connection on which nothing proves them when nothing was ever
	 * accepted for them. False: such a field stays unverified until somebody sets it.
	 */
	writeDeclaredTuningOnConnect?: boolean
	/**
	 * True once this core lost private ownership: the tuner and tuner-band-gain.json may be another
	 * owner's. From then on nothing writes either, whoever asks and however long it waited in a queue.
	 */
	lostOwnership?: () => boolean
}

type ControlModeOrigin = "user" | "relay"

export class TunerControllerError extends Error {
	public readonly statusCode: number
	public readonly code: string

	constructor(message: string, code: string, statusCode: number) {
		super(message)
		this.name = "TunerControllerError"
		this.code = code
		this.statusCode = statusCode
		if (Error.captureStackTrace) {
			Error.captureStackTrace(this, this.constructor)
		}
	}
}

export class TunerSourceNotFoundError extends TunerControllerError {
	constructor(sourceId: string) {
		super(`Tuner source not found: ${sourceId}`, "TUNER_SOURCE_NOT_FOUND", 404)
		this.name = "TunerSourceNotFoundError"
	}
}

export class TunerControlModeError extends TunerControllerError {
	constructor(sourceId: string) {
		super(
			`Cannot send commands: control released to external tuner for ${sourceId}`,
			"TUNER_CONTROL_EXTERNAL",
			409,
		)
		this.name = "TunerControlModeError"
	}
}

export class TunerValidationError extends TunerControllerError {
	/**
	 * The field that failed, by its schema name (e.g. "sampleRate", "tunerIfGain.stage"):
	 * always a constant from this module, never the submitted value.
	 */
	readonly field: string | undefined
	constructor(message: string, field?: string) {
		super(message, "TUNER_VALIDATION_ERROR", 400)
		this.name = "TunerValidationError"
		this.field = field
	}
}

/** The reported TunerState field a command writes, if it has one (rtlXtal, tunerXtal and tunerGainIndex do not). */
function stateFieldOf(cmd: number): TunerStateField | undefined {
	if (cmd === RTL_TCP_COMMANDS.SET_TEST_MODE) return "testMode"
	const field = COMMAND_FIELDS[cmd]
	return STATE_FIELDS.find(known => known === field)
}

export class TunerController extends EventEmitter {
	private withoutCommand<T>(work: () => T): T {
		// Small transport fakes need only implement the write boundary.
		return this.sourceManager?.withoutTunerCommand
			? this.sourceManager.withoutTunerCommand(work)
			: work()
	}

	override emit(event: string | symbol, ...args: unknown[]): boolean {
		return this.withoutCommand(() => super.emit(event, ...args))
	}

	private beforeOperatorRetune: RatePolicy["beforeOperatorRetune"] | null = null
	private onOperatorSampleRate: RatePolicy["onOperatorSampleRate"] | null = null
	private onRelayRetune: RatePolicy["onRelayRetune"] | null = null
	private ratePolicyRecordFor: RatePolicy["recordFor"] | null = null

	setBeforeOperatorRetune(
		hook: RatePolicy["beforeOperatorRetune"] | null,
	): void {
		this.beforeOperatorRetune = hook
	}

	hasBeforeOperatorRetune(): boolean {
		return this.beforeOperatorRetune !== null
	}

	/**
	 * Who made the centre change whose `caps-changed` is being emitted right
	 * now: "user" for a REST frequency write or a relay (SDR++) retune,
	 * "other" for a reconnect's caps reconcile (baseline reset, forgotten
	 * inferred tuning) and every other write (scanner, replay, config,
	 * decoder rate). Undefined outside such a change: a caps change the
	 * controller did not make has no known origin.
	 */
	centreChangeOrigin(sourceId: string): "user" | "other" | undefined {
		return this.centreOrigins.get(sourceId)
	}

	private withCentreOrigin<T>(
		sourceId: string,
		origin: "user" | "other",
		apply: () => T,
	): T {
		const outer = this.centreOrigins.get(sourceId)
		this.centreOrigins.set(sourceId, origin)
		try {
			return apply()
		} finally {
			if (outer === undefined) this.centreOrigins.delete(sourceId)
			else this.centreOrigins.set(sourceId, outer)
		}
	}

	setOnOperatorSampleRate(
		hook: RatePolicy["onOperatorSampleRate"] | null,
	): void {
		this.onOperatorSampleRate = hook
	}

	setOnRelayRetune(hook: RatePolicy["onRelayRetune"] | null): void {
		this.onRelayRetune = hook
	}

	setRatePolicyRecordFor(hook: RatePolicy["recordFor"] | null): void {
		this.ratePolicyRecordFor = hook
	}

	emitRatePolicy(event: TunerRatePolicyEventData): void {
		this.emit("rate-policy", event)
	}

	// === Per-band gain ===

	private bandGain: BandGainSettingsService | null = null
	private gainSteps: ((sourceId: string) => readonly number[] | null) | null =
		null
	/**
	 * The operator's gain mode and gain from before "apply to my tuning" first changed them
	 * (null when they were unknown then; an AGC gain may be unknown, null). Restored, and
	 * cleared, when an operator retune leaves the bands with a gain; an operator gain or gain
	 * mode or gain index choice clears it (RTL AGC and IF gain writes do not). Persisted through
	 * the band gain settings, so a restart inside a band still restores it on leaving; kept
	 * across a source's teardown and reconnect for the same reason.
	 */
	private operatorGainBeforeBand: Map<string, SavedOperatorGain | null> =
		new Map()
	/** Sources whose band gain write is in flight (its own gain writes keep the saved gain). */
	private applyingBandGain: Set<string> = new Set()
	/**
	 * What entering a band with no record would have saved, per source, while the tune that entered
	 * it is temporary. Never in `operatorGainBeforeBand`, as every save writes that whole map. One
	 * per source: the tune's restore, its failure, shutdown and removal drop it unwritten, and a
	 * restart forgets it. Only a tune that stays writes it (noteTuneKept).
	 */
	private tuneGainSaves: Map<string, SavedOperatorGain | null> = new Map()
	/** The saveOperatorGain call that wrote each saved gain (a drop or newer save replaces it). */
	private savedRecords: Map<string, { value: SavedOperatorGain | null }> =
		new Map()
	/**
	 * The band gain on the tuner per source (TunerState.bandGain). Set only after the band's
	 * writes succeed; any later gain, gain mode or frequency write drops it, and cloneState
	 * drops it once the known state no longer shows exactly this manual gain.
	 */
	private appliedBandGain: Map<string, TunerBandGain> = new Map()
	/**
	 * Operator gain and gain mode choices per source (REST or relay), counted when issued.
	 * The scanner drops a pending gain restore of a lost lease once this count moves.
	 */
	/**
	 * Gain choice marks per source: `seq` numbers every operator gain choice as it is issued
	 * (never reused); `done` is the newest one that took effect; `inFlight` those still being
	 * written. A failed write leaves `inFlight` and never moves `done`.
	 */
	private gainChoices: Map<
		string,
		{
			seq: number
			done: number
			inFlight: Set<number>
			operatorDone: number
			temporary: Set<number>
		}
	> = new Map()
	/** The scanner's gain restore of a lost lease per source; an operator band gain waits for it. */
	private gainRestoreHolds: Map<string, Promise<void>> = new Map()
	/** The last queued REST retune per source while "apply to my tuning" is on (never rejects). */
	private restRetunes: Map<string, Promise<void>> = new Map()

	setBandGain(settings: BandGainSettingsService | null): void {
		this.bandGain = settings
		this.operatorGainBeforeBand = new Map(settings?.savedOperatorGains() ?? [])
	}

	bandGainSettings(): BandGainSettingsService | null {
		return this.bandGain
	}

	/** The tuner's supported gain steps (tenths), or null when unknown. */
	setGainStepsResolver(
		resolver: ((sourceId: string) => readonly number[] | null) | null,
	): void {
		this.gainSteps = resolver
	}

	/**
	 * The band gain to write at `hz` (tenths, snapped to the tuner's nearest supported step
	 * when its table is known), or null to leave gain alone: a "keep" entry, no entry, no
	 * table configured, or any failure (the safe answer).
	 */
	bandGainFor(sourceId: string, hz: number): number | null {
		try {
			const gain = this.bandGain?.gainAt(hz) ?? "keep"
			if (gain === "keep") return null
			const steps = this.gainSteps?.(sourceId) ?? null
			const snapped = nearestGainStep(gain, steps)
			return this.isWithinRange(snapped, VALIDATION.gain) ? snapped : null
		} catch (err) {
			this.log.warn(
				{ sourceId, err: safeErrorFields(err) },
				"Band gain lookup failed; gain left unchanged",
			)
			return null
		}
	}

	/**
	 * The mark of the newest operator gain choice on `sourceId` (REST and relay) that took
	 * effect or is still being written. It only grows while choices succeed; a failed write
	 * drops back to the choice before it. A later choice than a mark `m` exists exactly when
	 * this is greater than `m`, so a failed write never hides or fakes one (no reused values).
	 */
	gainChoiceCount(sourceId: string): number {
		const marks = this.gainChoices.get(sourceId)
		if (!marks) return 0
		let mark = marks.done
		for (const seq of marks.inFlight) if (seq > mark) mark = seq
		return mark
	}

	/**
	 * `gainChoiceCount` without a pending temporary tune's writes. A saved gain is superseded only
	 * by a choice that stays; a temporary tune that stays settles the record in `noteTuneKept`.
	 */
	private savedGainChoiceCount(sourceId: string): number {
		const marks = this.gainChoices.get(sourceId)
		if (!marks) return 0
		let mark = marks.operatorDone
		for (const seq of marks.inFlight)
			if (seq > mark && !marks.temporary.has(seq)) mark = seq
		return mark
	}

	private gainChoiceMarks(sourceId: string): {
		seq: number
		done: number
		inFlight: Set<number>
		operatorDone: number
		temporary: Set<number>
	} {
		let marks = this.gainChoices.get(sourceId)
		if (!marks) {
			marks = {
				seq: 0,
				done: 0,
				inFlight: new Set(),
				operatorDone: 0,
				temporary: new Set(),
			}
			this.gainChoices.set(sourceId, marks)
		}
		return marks
	}

	/**
	 * The scanner is putting the operator's gain back after a lost lease: an operator band
	 * gain on `sourceId` waits for `restore` to settle, so the gain it saves is the
	 * operator's and not the scanner's band gain.
	 */
	holdBandGainFor(sourceId: string, restore: Promise<unknown>): void {
		const hold = restore.then(
			() => undefined,
			() => undefined,
		)
		this.gainRestoreHolds.set(sourceId, hold)
		void hold.then(() => {
			if (this.gainRestoreHolds.get(sourceId) === hold)
				this.gainRestoreHolds.delete(sourceId)
		})
	}

	/**
	 * Marked when issued (before the write), so a queued scanner restore sees it. A choice
	 * with no write (a relay command, an unchanged PATCH value) takes effect at once.
	 */
	private noteGainChoice(
		sourceId: string,
		opts: TunerWriteOptions,
		inFlight = false,
	): number | null {
		if (
			opts.origin === "scanner" ||
			opts.origin === "replay" ||
			opts.origin === "config"
		)
			return null
		const marks = this.gainChoiceMarks(sourceId)
		marks.seq += 1
		const temporary = opts.run?.keepsSavedGain === true
		if (inFlight) {
			marks.inFlight.add(marks.seq)
			if (temporary) marks.temporary.add(marks.seq)
		} else {
			marks.done = marks.seq
			if (!temporary) marks.operatorDone = marks.seq
		}
		return marks.seq
	}

	/** A gain write that threw (e.g. the source disconnected) chose nothing. */
	private async countedGainWrite(
		sourceId: string,
		opts: TunerWriteOptions,
		write: () => Promise<void>,
	): Promise<void> {
		const seq = this.noteGainChoice(sourceId, opts, true)
		const marks = this.gainChoices.get(sourceId)
		try {
			await write()
			this.sourceManager.assertTunerCommandActive()
			if (seq !== null && marks) {
				if (seq > marks.done) marks.done = seq
				if (!marks.temporary.has(seq) && seq > marks.operatorDone)
					marks.operatorDone = seq
			}
		} finally {
			if (seq !== null) {
				marks?.inFlight.delete(seq)
				marks?.temporary.delete(seq)
			}
		}
	}

	/**
	 * With "apply to my tuning", REST retunes of one source run one at a time: one retune's
	 * band gain or restore writes never land after the next one's frequency.
	 */
	private serialRestRetune(
		sourceId: string,
		retune: () => Promise<void>,
	): Promise<void> {
		const previous = this.restRetunes.get(sourceId) ?? Promise.resolve()
		const run = previous.then(retune)
		const tail = run.catch(() => undefined)
		this.restRetunes.set(sourceId, tail)
		void tail.then(() => {
			if (this.restRetunes.get(sourceId) === tail)
				this.restRetunes.delete(sourceId)
		})
		return run
	}

	/**
	 * Saves the operator's gain before a band gain: "saved" once it is durable, "failed"
	 * when persisting it failed (the record is taken back), "superseded" when an operator
	 * gain choice came meanwhile (the record is dropped: that choice is the newest gain).
	 */
	private async saveOperatorGain(
		sourceId: string,
		saved: SavedOperatorGain | null,
	): Promise<"saved" | "failed" | "superseded"> {
		const record = { value: saved }
		const choices = this.savedGainChoiceCount(sourceId)
		this.operatorGainBeforeBand.set(sourceId, saved)
		this.savedRecords.set(sourceId, record)
		const durable =
			this.bandGain === null
				? true
				: await withSaveTimeout(this.saveOperatorGains(sourceId))
		const current = this.savedRecords.get(sourceId) === record
		if (current && this.savedGainChoiceCount(sourceId) > choices) {
			this.dropOperatorGain(sourceId)
			return "superseded"
		}
		if (!durable && current) {
			this.savedRecords.delete(sourceId)
			this.operatorGainBeforeBand.delete(sourceId)
			// A save that timed out may still land later: the next save in the service's chain
			// writes the gains without this record, so it never comes back from disk.
			void this.saveOperatorGains()
		}
		if (!current) return "superseded"
		return durable ? "saved" : "failed"
	}

	private dropOperatorGain(sourceId: string): void {
		this.tuneGainSaves.delete(sourceId)
		this.savedRecords.delete(sourceId)
		if (!this.operatorGainBeforeBand.delete(sourceId)) return
		void this.saveOperatorGains()
	}

	/** False when nothing was written: no service, or no ownership left to write it under. */
	private saveOperatorGains(required?: string): Promise<boolean> {
		if (this.bandGain === null || this.config.lostOwnership?.() === true)
			return Promise.resolve(false)
		return this.bandGain.saveOperatorGains(
			this.operatorGainBeforeBand,
			required,
		)
	}

	/**
	 * An operator retune applies the band gain only with "apply to my tuning". A failed
	 * gain write is logged: the retune itself already succeeded.
	 */
	private async applyOperatorBandGain(
		sourceId: string,
		hz: number,
		opts: TunerWriteOptions,
	): Promise<void> {
		if (opts.origin !== "rest" || this.bandGain?.applyToMyTuning() !== true)
			return
		// This retune may have taken a scanner lease: its gain restore runs first.
		const hold = this.gainRestoreHolds.get(sourceId)
		if (hold !== undefined) await hold
		const state = this.tunerStates.get(sourceId)
		if (!state || state.controlMode !== "internal") return
		const target = this.bandGainFor(sourceId, hz)
		const saved = this.operatorGainBeforeBand.has(sourceId)
			? this.operatorGainBeforeBand.get(sourceId)
			: this.tuneGainSaves.get(sourceId)
		if (target === null && saved === undefined) return
		this.applyingBandGain.add(sourceId)
		try {
			if (target !== null) {
				const unknown = this.fieldProof(sourceId).unknownFields
				// The band gain goes on only once the gain it replaces is durable, so a restart
				// in the band still restores it. Unsaved, or chosen meanwhile: the gain stays.
				// A temporary tune only holds it: its restore puts that gain back.
				if (saved === undefined) {
					// A gain or gain mode not known yet (right after a restart, before any gain
					// write) could never be restored: no band gain, as for a scanner hop.
					if (unknown.includes("gainMode") || unknown.includes("gain")) return
					const before = { gainMode: state.gainMode, gain: state.gain }
					if (opts.run?.keepsSavedGain === true)
						this.tuneGainSaves.set(sourceId, before)
					else {
						const outcome = await this.saveOperatorGain(sourceId, before)
						if (outcome === "failed") this.logGainSaveFailed(sourceId)
						if (outcome !== "saved") return
					}
				}
				const now = this.tunerStates.get(sourceId) ?? state
				const proof = this.fieldProof(sourceId).unknownFields
				if (now.gainMode !== "manual" || proof.includes("gainMode"))
					await this.setGainMode(sourceId, "manual", opts)
				if (now.gain !== target || proof.includes("gain"))
					await this.setGain(sourceId, target, opts)
				this.noteBandGainApplied(sourceId, target, "user", hz)
				return
			}
			if (saved === null || saved === undefined) {
				this.useSavedGain(sourceId, opts)
				return
			}
			// The saved gain is dropped only after the restore succeeds: a failed write keeps
			// it, so the next out-of-band retune retries the restore.
			// rtl_tcp SET_GAIN switches the tuner to manual: an AGC restore writes the gain
			// first and the mode last, so the tuner ends in AGC with the exact saved gain.
			if (saved.gainMode === "agc") {
				if (saved.gain !== null) await this.setGain(sourceId, saved.gain, opts)
				await this.setGainMode(sourceId, "agc", opts)
			} else if (saved.gain !== null) {
				if (state.gainMode !== "manual")
					await this.setGainMode(sourceId, "manual", opts)
				await this.setGain(sourceId, saved.gain, opts)
			}
			this.useSavedGain(sourceId, opts)
		} catch (err) {
			this.log.warn(
				{ sourceId, err: safeErrorFields(err) },
				"Applying the band gain after a retune failed",
			)
		} finally {
			this.applyingBandGain.delete(sourceId)
		}
	}

	private logGainSaveFailed(sourceId: string): void {
		this.log.warn(
			{ sourceId },
			"Saving the gain from before the band failed; band gain not applied",
		)
	}

	/**
	 * Records that the band gain `tenthsDb` for `hz` is on the tuner after its writes
	 * succeeded (or were not needed). Ignored unless the known state shows exactly this
	 * manual gain at `hz`, so the reported band gain is always the tuner's confirmed one.
	 */
	noteBandGainApplied(
		sourceId: string,
		tenthsDb: number,
		owner: TunerBandGainOwner,
		hz: number,
	): void {
		const state = this.tunerStates.get(sourceId)
		if (!state) return
		this.appliedBandGain.delete(sourceId)
		if (state.frequency === hz) {
			let label: string | undefined
			try {
				label = this.bandGain?.labelAt(hz)
			} catch {
				label = undefined
			}
			this.appliedBandGain.set(sourceId, {
				tenthsDb,
				owner,
				...(label !== undefined ? { label } : {}),
			})
		}
		this.emitStateChanged(sourceId)
	}

	/** The confirmed band gain of `state`, dropping a record the tuner has left. */
	private confirmedBandGain(
		state: TunerState,
		unknownFields: readonly TunerStateField[],
	): TunerBandGain | undefined {
		const applied = this.appliedBandGain.get(state.sourceId)
		if (!applied) return undefined
		if (
			state.controlMode !== "internal" ||
			state.gainMode !== "manual" ||
			state.gain !== applied.tenthsDb ||
			unknownFields.includes("gain") ||
			unknownFields.includes("gainMode")
		) {
			// Once the tuner leaves the band gain it is never reported again until rewritten.
			this.appliedBandGain.delete(state.sourceId)
			return undefined
		}
		return { ...applied }
	}

	/**
	 * A bulk update's gain or gain mode field equal to the tuner's: no write, but still
	 * the operator's choice (as POST /gain): counted, and it supersedes the saved gain. An
	 * explicit gain also replaces a confirmed band gain (the gain is now the operator's);
	 * an unchanged mode keeps it.
	 */
	private noteUnchangedGainChoice(
		sourceId: string,
		opts: TunerWriteOptions,
		gain = false,
	): void {
		this.noteGainChoice(sourceId, opts)
		this.noteOperatorGainWrite(sourceId, opts)
		if (gain && this.appliedBandGain.delete(sourceId))
			this.emitStateChanged(sourceId)
	}

	/** An explicit operator gain write supersedes the gain saved before a band. */
	private noteOperatorGainWrite(
		sourceId: string,
		opts: TunerWriteOptions,
	): void {
		if (
			opts.origin === "rest" &&
			opts.restore !== true &&
			!this.applyingBandGain.has(sourceId)
		)
			this.useSavedGain(sourceId, opts)
	}

	/** An operator tune uses the saved gain up; a temporary one leaves it. */
	private useSavedGain(sourceId: string, opts: TunerWriteOptions): void {
		if (opts.run?.keepsSavedGain !== true) this.dropOperatorGain(sourceId)
	}

	private readonly log: Logger
	private readonly sourceManager: SourceManager
	private readonly config: TunerControllerConfig
	private tunerStates: Map<string, TunerState> = new Map()
	/** The last change per source: one entry each, gone with the source (removeSource). */
	private readonly lastChanges = new Map<string, TunerLastChange>()
	/** The tune behind each `lastChange`, for those a tune wrote. Gone with the source. */
	private readonly lastChangeRuns = new Map<string, TuneWriteRun>()
	/**
	 * The last value of each command per source: at most one per closed command, gone with the
	 * source. A reconnect frame equal to it moves nothing, so it leaves `lastChange` alone.
	 */
	private readonly frameValues = new Map<string, Map<string, number>>()
	/** The write options of the tune whose rate policy hook is running: its frames are the tune's. */
	private readonly retuneHookTune = new AsyncLocalStorage<TunerWriteOptions>()
	/** Scoped onReceipt callbacks of running multi-frame calls (withReceiptOnce). */
	private readonly receiptScopes = new WeakMap<ReceiptCallback, ReceiptOnce>()
	/**
	 * Frames that went out per source and state field, whoever wrote them: at most one counter per
	 * closed field per source, gone with the source (removeSource).
	 */
	private readonly fieldWrites = new Map<string, Map<TunerStateField, number>>()
	private controlModeOrigins: Map<string, ControlModeOrigin> = new Map()
	/**
	 * Per source, who changed the centre whose caps update is being applied
	 * now; set only for the synchronous `caps-changed` it emits.
	 */
	private readonly centreOrigins = new Map<string, "user" | "other">()
	/** Accepted desired fields per source, keyed to their acceptance sequence. */
	private desiredFields: Map<string, Map<DesiredField, number>> = new Map()
	/** Fields inferred from observed relay commands (known, never replayed). */
	private inferredFields: Map<string, Set<TunerStateField>> = new Map()
	/**
	 * WG5: frequency/sampleRate a relay client set to a value the controller ignored
	 * (the relay forwards raw bytes upstream before validation, so the receiver may be
	 * there). Unknown until the next accepted or written value.
	 */
	private ignoredRelayFields: Map<string, Set<TunerStateField>> = new Map()
	/**
	 * Fields a plain resume of a paused feed left unwritten: during the pause another client
	 * (SDR++ through rtlmux) may have changed them unseen, so the state keeps the last known value
	 * and reports the field unknown until a value is written, accepted or inferred.
	 */
	private unverifiedFields: Map<string, Set<TunerStateField>> = new Map()
	/** setGainMode calls whose frame may be out while the state still shows the old mode. */
	private readonly gainModeWritesInFlight: Map<string, number> = new Map()
	/**
	 * The sample rate adoptObservedSampleRate took from the stream's measured rate, per source.
	 * Reported as `measuredFields` only while the rate is still unverified and the state still
	 * shows this value; a new pause, a resume of either kind or the source's teardown forgets
	 * it: a measurement holds only for the connection that took it.
	 */
	private measuredRates: Map<string, number> = new Map()
	/**
	 * acceptanceSeq when the source's feed was paused (noteFeedPaused): fields accepted after it
	 * (relay commands during the pause) are written by a plain resume. Consumed by the next sync.
	 */
	private pausedAtSeq: Map<string, number> = new Map()
	/**
	 * Sources whose last resume was plain: until a restore resume (or the source's removal) no
	 * configured frame is owed on any later connection of the source, so a dropout reconnect
	 * writes no configured gain mode, gain or AGC the user did not set ("never fight SDR++").
	 * Fields the user sets afterwards (API or relay) are accepted and replayed as usual.
	 */
	private plainResumeHold: Set<string> = new Set()
	private acceptanceSeq = 0
	/**
	 * Intent: the last accepted (operator or relay) centre and rate per source, the value assert
	 * writes back (rule 3); without one, the declared value. A scanner hop (accept: false) is not
	 * one. Proof is the tuning ledger's alone: nothing here says what a connection carries.
	 */
	private acceptedTuning: Map<string, Partial<Record<GatedField, number>>> =
		new Map()
	/**
	 * The ledger session a restore resume opened, per source: under `reconnectPolicy: reset` that
	 * session follows the restore policy (the operator asked for the tuning back), so its declared
	 * fallback stands. Any later session is the reset policy's again.
	 */
	private restoreResumeSession: Map<string, number> = new Map()
	/**
	 * Assert frames written while the field's live doubt was an untracked-retune alarm, per source
	 * (TunerTuningProof.assertFights): a client bypassing the relay retuning the receiver, and the
	 * core putting its value back. Counted, never limited.
	 */
	private assertFights: Map<string, number> = new Map()
	/**
	 * The ledger of a source manager without one (test doubles: every write flushes at once, with
	 * no settle): one session per connection the controller is told of.
	 */
	private standInLedger: TuningLedger | null = null
	private readonly standInConnections = new Map<string, LedgerConnection>()
	/** The scanner's lease view (TunerArbiter): assert rule 2. */
	private leaseView: TunerLeaseView | null = null
	/** True while a tuner relay client is attached to the source (assert rule 1). */
	private relayAttached: ((sourceId: string) => boolean) | null = null
	/** Sources with an assert check queued (one microtask per source at a time). */
	private readonly assertQueued = new Set<string>()
	/** Sources whose published state is due after the queued check (doubt, hold, session end). */
	private readonly publishQueued = new Set<string>()
	/** Caps metadata as first registered, before any accepted command. */
	private baselineCaps: Map<string, SourceCaps | undefined> = new Map()
	/**
	 * WG11 req 4.1, 4.2: configured gain/AGC per source (`sources[].tuner`), with its
	 * frames in write order. The source's baseline for gainMode, gain and agcMode.
	 */
	private configuredTuning: Map<
		string,
		{
			tuner: SourceTunerConfig
			frames: ReadonlyArray<readonly [number, number]>
		}
	> = new Map()
	/**
	 * WG11 req 4.2: sources whose current connection has not had its configured
	 * frames considered yet. Set on `connected`, consumed by the next
	 * synchronizeOnConnect, so a repeated payload-started writes them once.
	 */
	private configWriteDue: Set<string> = new Set()
	/**
	 * WG11 req 4.5: gain fields whose configured value was written (every frame of
	 * the set succeeded) on the current connection. Known while it lasts.
	 */
	private configProvenFields: Map<string, Set<TunerStateField>> = new Map()

	constructor(
		logger: Logger,
		sourceManager: SourceManager,
		config: TunerControllerConfig = {},
	) {
		super()
		this.log = createComponentLogger(logger, "TunerController")
		this.sourceManager = sourceManager
		this.config = config
		this.ledger().subscribe(this.onLedgerChange)
	}

	// === Tuning ledger: proof, assert and the skip rule ===

	/** The source manager's tuning ledger, else the stand-in (test doubles). */
	private ledger(): TuningLedger {
		const real = (
			this.sourceManager as Partial<Pick<SourceManager, "tuningLedger">> | null
		)?.tuningLedger
		if (real) return real
		this.standInLedger ??= new TuningLedger({
			// A double's write flushes when it returns: no settle, no in-flight bytes.
			settleLink: () => ({ configuredSettleMs: 0, inFlightBytes: 0 }),
			frameBytes: () => 2,
			capsRate: () => 1,
		})
		return this.standInLedger
	}

	/** Starts a new stand-in session for the source (a double's new connection). */
	private standInSession(sourceId: string): void {
		if (this.standInLedger === null) return
		this.standInConnections.get(sourceId)?.close()
		const conn = this.standInLedger.connection(sourceId)
		this.standInConnections.set(sourceId, conn)
		conn.start()
	}

	/** Records a frame a double took (its write returned) in the stand-in ledger. */
	private standInFrame(
		sourceId: string,
		cmd: number,
		value: number,
		writer: TuningWriterTag,
	): void {
		const conn = this.standInConnections.get(sourceId)
		if (!conn) return
		conn.write(this.encodeFrame(cmd, value), writer)(null)
	}

	/**
	 * The scanner's lease view (TunerArbiter): while a lease is held, assert writes nothing and
	 * asks the holder to re-send its hop. Null detaches it.
	 */
	setLeaseView(view: TunerLeaseView | null): void {
		this.leaseView = view
	}

	/** Whether a tuner relay client is attached to a source (assert writes nothing then). */
	setRelayAttachedView(view: ((sourceId: string) => boolean) | null): void {
		this.relayAttached = view
	}

	/**
	 * A trigger of assert (relay client detached, scanner lease released): re-checks the source on
	 * a later microtask. Writes only what the ledger says is unproven.
	 */
	requestAssert(sourceId: string): void {
		this.scheduleAssert(sourceId, false)
	}

	private readonly onLedgerChange = (
		sourceId: string,
		change: LedgerChange,
	): void => {
		if (!this.tunerStates.has(sourceId)) return
		switch (change.kind) {
			// The connect sync asserts (wired to the session's start).
			case "session-started":
				return
			case "receipt":
				// Only an untagged frame of either field leaves it unproven (a tagged one settles).
				if (
					change.receipt.writer === undefined &&
					(change.field === "frequency" || change.field === "sampleRate")
				)
					this.scheduleAssert(sourceId, true)
				return
			case "session-ended":
			case "doubt":
			case "hold":
				this.scheduleAssert(sourceId, true)
				return
		}
	}

	/** One check per source per microtask, out of any tuner command context. */
	private scheduleAssert(sourceId: string, publish: boolean): void {
		if (publish) this.publishQueued.add(sourceId)
		if (this.assertQueued.has(sourceId)) return
		this.assertQueued.add(sourceId)
		queueMicrotask(() => {
			this.assertQueued.delete(sourceId)
			const published = this.publishQueued.delete(sourceId)
			this.withoutCommand(() => {
				try {
					const wrote = this.runAssert(sourceId)
					if (published && !wrote) this.emitStateChanged(sourceId)
				} catch (err) {
					this.log.warn(
						{ sourceId, err: safeErrorFields(err) },
						"Asserting the held tuning failed",
					)
				}
			})
		})
	}

	/** Assert outside a connect sync: writes, publishes and reports. True when it wrote. */
	private runAssert(sourceId: string): boolean {
		const state = this.tunerStates.get(sourceId)
		if (!state) return false
		const { written, failure } = this.writeAssertFrames(sourceId, state)
		if (written.length === 0 && !failure) return false
		if (written.length > 0) {
			state.commandCount += written.length
			state.lastCommandAt = new Date().toISOString()
		}
		if (failure) {
			state.lastError = `Tuner state assert failed: ${failure.message}`
			this.log.warn(
				{ sourceId, err: failure.message },
				"Writing the held tuning failed; retried on the next trigger",
			)
		} else delete state.lastError
		this.reconcileCaps(sourceId, state)
		if (written.length > 0)
			this.log.info(
				{ sourceId, commands: written.map(w => w.name) },
				"Asserted the held tuning on an unproven connection",
			)
		for (const { name, value, shown } of written) {
			this.noteReconnectFrame(sourceId, name, value, "replay", shown)
			this.emit("command-sent", sourceId, name, value, "replay")
		}
		if (failure) this.emit("error", sourceId, failure)
		this.emitStateChanged(sourceId)
		return true
	}

	/**
	 * The declared value of a field: the configured default, else the source's caps as first
	 * registered. Undefined when neither declares it.
	 */
	private declaredValue(
		sourceId: string,
		field: GatedField,
	): number | undefined {
		const caps = this.baselineCaps.get(sourceId)
		return field === "frequency"
			? (this.config.defaultFrequency ?? caps?.centerFreq)
			: (this.config.defaultSampleRate ?? caps?.sampleRate)
	}

	/**
	 * Why the declared fallback of rule 3 is off for the source now, or null: a plain resume's hold
	 * (until a restore resume; values accepted since are still written), `reconnectPolicy: reset`
	 * outside a restore resume's session (another operator may own the receiver: only what was
	 * accepted on the current connection is written, see synchronizeOnConnect), or the kill switch.
	 */
	private declaredBlock(sourceId: string): AssertBlock | null {
		if (this.plainResumeHold.has(sourceId)) return "plain-resume"
		if (
			this.config.reconnectPolicy === "reset" &&
			this.restoreResumeSession.get(sourceId) !==
				this.ledger().position(sourceId)?.session
		)
			return "reset-policy"
		if (this.config.writeDeclaredTuningOnConnect === false)
			return "declared-write-off"
		return null
	}

	/** What assert writes for a field (rule 3): last accepted, else declared (declaredBlock). */
	private heldValue(sourceId: string, field: GatedField): number | null {
		const accepted = this.acceptedTuning.get(sourceId)?.[field]
		const value =
			accepted ??
			(this.declaredBlock(sourceId) !== null
				? undefined
				: this.declaredValue(sourceId, field))
		if (value === undefined) return null
		const valid =
			field === "frequency"
				? this.isWithinRange(value, VALIDATION.frequency)
				: isValidRtlSampleRate(value)
		return valid ? value : null
	}

	/**
	 * Why assert writes nothing for the source now (rules 1 and 2), or null. A plain resume's hold
	 * is no block: it turns off only the declared fallback (declaredBlock), so a value accepted
	 * after the resume is written back on a later connection.
	 */
	private assertBlock(sourceId: string, state: TunerState): AssertBlock | null {
		if (this.config.lostOwnership?.() === true) return "lost-ownership"
		if (this.relayAttached?.(sourceId) === true) return "relay-attached"
		if (state.controlMode === "external") return "external-control"
		if (this.leaseView?.holds(sourceId) === true) return "scanner-lease"
		return null
	}

	/**
	 * A field assert owes a write: unproven in the live session with no frame of it settling or
	 * waiting to leave. A standing hold (rate-truth mismatch) is owed one write after it was set.
	 */
	private static assertDue(fs: FieldState): boolean {
		if (fs.queued !== null) return false
		if (fs.hold)
			return !fs.hold.answered || fs.hold.withoutHold === "unverified"
		return fs.state === "unverified"
	}

	/**
	 * Assert (the only automatic writer of centre and rate): for each field the live session does
	 * not prove, with nothing settling or queued for it, writes per rule: nothing under a relay
	 * client, external control, a plain resume's hold or lost ownership; under a scanner lease the
	 * holder re-sends its hop; otherwise the held value (heldValue). Rate before centre. Updates
	 * the state; the caller reconciles caps, publishes and emits.
	 */
	private writeAssertFrames(
		sourceId: string,
		state: TunerState,
	): {
		written: Array<{ value: number; name: string; shown: number }>
		failure?: Error
	} {
		const written: Array<{ value: number; name: string; shown: number }> = []
		const ledger = this.ledger()
		if (ledger.position(sourceId) === null) return { written }
		const fields = ledger.fieldState(sourceId)
		const due = GATED_FIELDS.filter(field =>
			TunerController.assertDue(fields[field]),
		)
		if (due.length === 0) return { written }
		const block = this.assertBlock(sourceId, state)
		if (block === "scanner-lease") {
			try {
				this.leaseView?.resend(sourceId)
			} catch (err) {
				this.log.warn(
					{ sourceId, err: safeErrorFields(err) },
					"The scanner lease holder's hop re-send failed",
				)
			}
			return { written }
		}
		if (block !== null) return { written }
		for (const field of due) {
			const value = this.heldValue(sourceId, field)
			if (value === null) continue
			const cmd =
				field === "frequency"
					? RTL_TCP_COMMANDS.SET_FREQUENCY
					: RTL_TCP_COMMANDS.SET_SAMPLE_RATE
			try {
				this.writeFrame(sourceId, cmd, value, ASSERT_WRITER)
			} catch (err) {
				return {
					written,
					failure:
						err instanceof Error
							? err
							: new WaveKitError(String(err), "TUNER_RESTORE_FAILED"),
				}
			}
			// A setter waiting on its own frame of this field is superseded by this one.
			this.noteFieldWrite(sourceId, field)
			// A fight with a client retuning the receiver past the relay: counted, never limited.
			if (fields[field].doubtReason === UNTRACKED_RETUNE_DOUBT)
				this.assertFights.set(
					sourceId,
					(this.assertFights.get(sourceId) ?? 0) + 1,
				)
			const shown = state[field]
			if (field === "frequency") {
				if (state.frequency !== value) {
					this.appliedBandGain.delete(sourceId)
					// The asserted centre is the operator's held one: its band gain follows it as
					// after an operator retune (applyOperatorBandGain, "apply to my tuning" only).
					this.reapplyBandGain(sourceId, value)
				}
				state.frequency = value
			} else state.sampleRate = value
			this.clearIgnoredRelayField(sourceId, field)
			written.push({
				value,
				name: COMMAND_NAMES[cmd] ?? `cmd-0x${cmd}`,
				shown,
			})
		}
		return { written }
	}

	/**
	 * After assert moved the centre: the band gain at `hz` under the operator retune's rule, on a
	 * later microtask (assert writes synchronously, the band gain awaits its saved gain). Failures
	 * are logged by applyOperatorBandGain; the retune itself already went out.
	 */
	private reapplyBandGain(sourceId: string, hz: number): void {
		if (this.bandGain?.applyToMyTuning() !== true) return
		queueMicrotask(() => {
			this.withoutCommand(() => {
				this.applyOperatorBandGain(sourceId, hz, { origin: "rest" }).catch(
					(err: unknown) =>
						this.log.warn(
							{ sourceId, err: safeErrorFields(err) },
							"Applying the band gain after an assert failed",
						),
				)
			})
		})
	}

	/** The ledger's state of the source's two gated fields (and gain). */
	private ledgerFields(
		sourceId: string,
	): Record<GatedField | "gain", FieldState> {
		return this.ledger().fieldState(sourceId)
	}

	/**
	 * The skip rule: a write of `value` to `field` may be skipped only when the live session
	 * proves it, or a frame of it at that value is settling or waiting to leave.
	 */
	private ledgerHolds(
		sourceId: string,
		field: GatedField,
		value: number,
		fields = this.ledgerFields(sourceId),
	): boolean {
		const fs = fields[field]
		if (fs.queued !== null) return fs.queued.value === value
		return fs.state !== "unverified" && fs.value === value
	}

	/** The API's per-field proof (TunerState.proof); absent without the source manager's ledger. */
	private proofOf(state: TunerState): TunerTuningProof | undefined {
		const real = (
			this.sourceManager as Partial<Pick<SourceManager, "tuningLedger">> | null
		)?.tuningLedger
		if (!real) return undefined
		const fields = real.fieldState(state.sourceId)
		const block = this.assertBlock(state.sourceId, state)
		const one = (field: GatedField): TunerFieldProof => {
			const fs = fields[field]
			if (fs.queued !== null)
				return {
					state: "settling",
					writer: fs.queued.writer,
					session: fs.session,
					reason: "queued",
				}
			if (fs.state === "proven")
				return {
					state: fs.writer === "relay" ? "relay" : "commanded",
					writer: fs.writer,
					session: fs.session,
				}
			if (fs.state === "settling")
				return { state: "settling", writer: fs.writer, session: fs.session }
			const blocked =
				block ??
				(this.heldValue(state.sourceId, field) === null
					? this.declaredBlock(state.sourceId)
					: null)
			return {
				state: "unverified",
				writer: fs.writer,
				session: fs.session,
				reason: fs.doubtReason ?? blocked ?? fs.reason ?? "unverified",
			}
		}
		const fights = this.assertFights.get(state.sourceId)
		return {
			frequency: one("frequency"),
			sampleRate: one("sampleRate"),
			...(fights !== undefined ? { assertFights: fights } : {}),
		}
	}

	// === Lifecycle ===

	initializeSource(
		sourceId: string,
		caps?: SourceCaps,
		sourceType?: SourceConfig["type"],
	): void {
		if (this.tunerStates.has(sourceId)) {
			this.log.debug({ sourceId }, "Tuner source already initialized")
			return
		}

		const isRtlTcp =
			sourceType !== undefined
				? sourceType === "rtl_tcp"
				: this.sourceManager.isRtlTcpSource(sourceId)

		if (!isRtlTcp) {
			this.log.debug({ sourceId }, "Skipping tuner init for non-RTL-TCP source")
			return
		}

		// Default state: sensible defaults for immediate use
		const state: TunerState = {
			sourceId,
			frequency: DEFAULT_FREQUENCY,
			sampleRate: DEFAULT_SAMPLE_RATE,
			gainMode: "agc",
			gain: 0,
			ppm: 0,
			agcMode: true,
			biasTee: false,
			directSampling: "off",
			offsetTuning: false,
			ifGain: 0,
			tunerIfGain: null,
			testMode: false,
			controlMode: "internal",
			commandCount: 0,
		}
		this.applyBaselineFields(state, caps)

		this.baselineCaps.set(sourceId, caps ? { ...caps } : undefined)
		this.tunerStates.set(sourceId, state)
		this.controlModeOrigins.set(sourceId, "user")
		// A double's source counts as connected from here (its writes return when taken).
		this.standInSession(sourceId)
		this.log.info({ sourceId }, "Tuner source initialized")
		this.emitStateChanged(sourceId)
	}

	removeSource(sourceId: string): void {
		// The saved pre-band gain stays (as on disk): a reconnect still restores it on leaving a band.
		this.tuneGainSaves.delete(sourceId)
		this.appliedBandGain.delete(sourceId)
		// WG11: configured tuning belongs to the removed source's config; a source
		// re-added under the same id brings its own (resolved on `connected`).
		this.configuredTuning.delete(sourceId)
		this.configWriteDue.delete(sourceId)
		this.configProvenFields.delete(sourceId)
		if (!this.tunerStates.has(sourceId)) return
		this.tunerStates.delete(sourceId)
		this.lastChanges.delete(sourceId)
		this.lastChangeRuns.delete(sourceId)
		this.frameValues.delete(sourceId)
		this.fieldWrites.delete(sourceId)
		this.controlModeOrigins.delete(sourceId)
		this.desiredFields.delete(sourceId)
		this.inferredFields.delete(sourceId)
		this.ignoredRelayFields.delete(sourceId)
		this.unverifiedFields.delete(sourceId)
		this.measuredRates.delete(sourceId)
		this.pausedAtSeq.delete(sourceId)
		this.plainResumeHold.delete(sourceId)
		this.acceptedTuning.delete(sourceId)
		this.restoreResumeSession.delete(sourceId)
		this.assertFights.delete(sourceId)
		this.standInConnections.get(sourceId)?.close()
		this.standInConnections.delete(sourceId)
		this.baselineCaps.delete(sourceId)
		this.configWriteDue.delete(sourceId)
		this.configProvenFields.delete(sourceId)
		this.log.info({ sourceId }, "Tuner source removed")
		this.emit("source-removed", sourceId)
	}

	// === Configured gain and AGC (WG11 req 4) ===

	/**
	 * Stores the configured gain/AGC of a source (undefined clears it). The values
	 * become the source's baseline: gain fields not accepted or observed in this
	 * process take them now (still unknown until written), the `reset` policy
	 * returns to them, and each new connection writes them (synchronizeOnConnect).
	 * Writes nothing itself.
	 */
	setConfiguredTuning(
		sourceId: string,
		tuner: SourceTunerConfig | undefined,
	): void {
		if (tuner === undefined) this.configuredTuning.delete(sourceId)
		else
			this.configuredTuning.set(sourceId, {
				tuner: { ...tuner },
				frames: configuredTuningFrames(tuner),
			})
		// A changed configuration is not what was written on this connection.
		this.configProvenFields.delete(sourceId)
		const state = this.tunerStates.get(sourceId)
		if (!state) return
		const baseline = this.gainBaseline(sourceId)
		const held = (field: TunerStateField) =>
			this.isOperatorHeld(sourceId, field)
		if (!held("gainMode")) state.gainMode = baseline.gainMode
		if (!held("gain")) state.gain = baseline.gain
		if (!held("agcMode")) state.agcMode = baseline.agcMode
		this.emitStateChanged(sourceId)
	}

	/**
	 * Applies the source's current configured tuning (from its live config, so a
	 * source added or replaced at runtime is followed) only when it differs from
	 * the stored one, so an unchanged config does not churn state or proof.
	 */
	syncConfiguredTuning(
		sourceId: string,
		tuner: SourceTunerConfig | undefined,
	): void {
		const current = this.configuredTuning.get(sourceId)?.tuner
		const key = (t: SourceTunerConfig | undefined) =>
			t === undefined ? "" : JSON.stringify([t.gainMode, t.gainDb, t.agcMode])
		if (key(current) === key(tuner)) return
		this.setConfiguredTuning(sourceId, tuner)
	}

	/**
	 * A new connection of the source opened (wired to SourceManager `connected`):
	 * its first synchronizeOnConnect writes the configured frames. Writes nothing.
	 */
	noteSourceConnected(sourceId: string): void {
		this.configWriteDue.add(sourceId)
		// Proof is per connection: nothing is written on the new one yet.
		if (this.configProvenFields.delete(sourceId))
			this.emitStateChanged(sourceId)
	}

	// === Control Mode ===

	setControlMode(
		sourceId: string,
		mode: TunerControlMode,
		origin: ControlModeOrigin = "user",
	): void {
		const state = this.validateSource(sourceId)
		if (state.controlMode === mode) {
			this.controlModeOrigins.set(sourceId, origin)
			return
		}

		state.controlMode = mode
		// Either hand-over may change the tuning: a band gain is reported again only once rewritten.
		this.appliedBandGain.delete(sourceId)
		if (mode === "internal" && this.onRelayRetune) {
			try {
				this.withoutCommand(() =>
					this.onRelayRetune?.(sourceId, state.frequency),
				)
			} catch (err) {
				this.log.warn(
					{ sourceId, err: safeErrorFields(err) },
					"Relay rate policy hook failed",
				)
			}
		}
		this.controlModeOrigins.set(sourceId, origin)
		this.log.info({ sourceId, mode }, "Control mode changed")
		this.emit("control-mode-changed", sourceId, mode)
		this.emitStateChanged(sourceId)
		// A relay client handed control back: an unproven centre or rate is asserted (rule 3),
		// unless a rule holds. A user's own switch is followed by the user's own writes.
		if (mode === "internal" && origin === "relay") this.requestAssert(sourceId)
	}

	/**
	 * Synchronize control mode with external relay activity.
	 *
	 * - When external control is active, switch to "external" if currently internal.
	 * - When external control ends, return to "internal" only if relay set the mode.
	 */
	syncExternalControl(sourceId: string, active: boolean): void {
		const state = this.tunerStates.get(sourceId)
		if (!state) {
			this.log.warn({ sourceId }, "Relay control ignored (tuner not found)")
			return
		}

		const origin = this.controlModeOrigins.get(sourceId)
		if (active) {
			if (state.controlMode !== "external") {
				this.setControlMode(sourceId, "external", "relay")
			}
			return
		}

		if (state.controlMode === "external" && origin === "relay") {
			this.setControlMode(sourceId, "internal", "relay")
		}
	}

	/**
	 * Apply an external RTL-TCP command to local tuner state without forwarding.
	 */
	applyExternalCommand(sourceId: string, command: number, value: number): void {
		const state = this.tunerStates.get(sourceId)
		if (!state) {
			this.log.warn({ sourceId, command, value }, "External command ignored")
			return
		}

		if (state.controlMode === "internal") {
			this.setControlMode(sourceId, "external", "relay")
		}
		// A relay client's tuning write supersedes the band gain.
		this.appliedBandGain.delete(sourceId)
		// A relay gain or gain mode choice is the operator's newest gain: never restore the older
		// one over it. Gain index sets the same tuner stage, so it counts; RTL2832 digital AGC and IF gain writes
		// set other stages and keep it.
		if (
			command === RTL_TCP_COMMANDS.SET_GAIN ||
			command === RTL_TCP_COMMANDS.SET_GAIN_MODE ||
			command === RTL_TCP_COMMANDS.SET_TUNER_GAIN_INDEX
		) {
			this.dropOperatorGain(sourceId)
			// Also cancels a scanner restore owed from a lost lease.
			this.noteGainChoice(sourceId, {})
		}

		const cmdName = COMMAND_NAMES[command] ?? `cmd-0x${command.toString(16)}`
		// The relay forwards raw bytes upstream before any check below, so even a value this
		// controller ignores may have moved the receiver: the client did it either way.
		this.noteFieldWrite(sourceId, stateFieldOf(command))
		// A double's relay frames reach no ledger: the stand-in records them (the real relay writes
		// through the source manager, whose ledger receipts them at flush).
		this.standInFrame(sourceId, command, value, RELAY_WRITER)
		// A gain or gain index frame may move the gain mode (gainFrameMode; state below). IF gain
		// frames never do.
		const relayGainMode = this.gainFrameMode(sourceId, command, value)
		if (relayGainMode !== "none") this.noteFieldWrite(sourceId, "gainMode")
		this.noteChange(sourceId, cmdName, value, {
			actor: "relay",
			reason: "relay-command",
		})
		const now = new Date().toISOString()
		let updated = false

		switch (command) {
			case RTL_TCP_COMMANDS.SET_FREQUENCY:
				if (this.isWithinRange(value, VALIDATION.frequency)) {
					state.frequency = value
					this.withCentreOrigin(sourceId, "user", () =>
						this.sourceManager.updateSourceCaps(sourceId, {
							centerFreq: value,
						}),
					)
					updated = true
				} else {
					this.markIgnoredRelayField(sourceId, "frequency")
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range frequency from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_SAMPLE_RATE:
				if (isValidRtlSampleRate(value)) {
					state.sampleRate = value
					updated = true
					try {
						this.sourceManager.updateSourceCaps(sourceId, {
							sampleRate: value,
						})
					} catch (err) {
						this.log.warn(
							{ sourceId, err },
							"Failed to update sample rate from relay",
						)
					}
				} else {
					this.markIgnoredRelayField(sourceId, "sampleRate")
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range sample rate from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_GAIN_MODE:
				if (value === 0 || value === 1) {
					state.gainMode = value === 1 ? "manual" : "agc"
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring unknown gain mode from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_GAIN:
				if (this.isWithinRange(value, VALIDATION.gain)) {
					state.gain = value
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range gain from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_FREQ_CORRECTION: {
				const ppm = this.decodeSignedInt32(value)
				if (this.isWithinRange(ppm, VALIDATION.ppm)) {
					state.ppm = ppm
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value: ppm },
						"Ignoring out-of-range PPM from relay",
					)
				}
				break
			}
			case RTL_TCP_COMMANDS.SET_IF_GAIN:
				if (this.isWithinRange(value, VALIDATION.uint32)) {
					state.ifGain = value
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range IF gain from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_TEST_MODE:
				state.testMode = value !== 0
				updated = true
				break
			case RTL_TCP_COMMANDS.SET_AGC_MODE:
				state.agcMode = value !== 0
				updated = true
				break
			case RTL_TCP_COMMANDS.SET_DIRECT_SAMPLING: {
				// librtlsdr rtlsdr_set_direct_sampling: 0 off, 1 the I branch, any value
				// above 1 the Q branch.
				const nextMode: TunerDirectSampling | null =
					value === 0
						? "off"
						: value === 1
							? "i"
							: value >= 2 && value <= 0xffffffff
								? "q"
								: null
				if (nextMode) {
					state.directSampling = nextMode
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring unknown direct sampling mode from relay",
					)
				}
				break
			}
			case RTL_TCP_COMMANDS.SET_OFFSET_TUNING:
				state.offsetTuning = value !== 0
				updated = true
				break
			case RTL_TCP_COMMANDS.SET_RTL_XTAL:
				if (this.isWithinRange(value, VALIDATION.uint32)) {
					state.rtlXtal = value
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range RTL XTAL from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_TUNER_XTAL:
				if (this.isWithinRange(value, VALIDATION.uint32)) {
					state.tunerXtal = value
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range tuner XTAL from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_TUNER_GAIN_INDEX:
				if (this.isWithinRange(value, VALIDATION.uint16)) {
					state.tunerGainIndex = value
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range tuner gain index from relay",
					)
				}
				break
			case RTL_TCP_COMMANDS.SET_BIAS_TEE:
				state.biasTee = value !== 0
				updated = true
				break
			case RTL_TCP_COMMANDS.SET_TUNER_IF_GAIN: {
				const stage = (value >>> 16) & 0xffff
				const gain = value & 0xffff
				if (
					this.isWithinRange(stage, VALIDATION.uint16) &&
					this.isWithinRange(gain, VALIDATION.uint16)
				) {
					state.tunerIfGain = { stage, gain }
					updated = true
				} else {
					this.log.warn(
						{ sourceId, command: cmdName, value },
						"Ignoring out-of-range tuner IF gain from relay",
					)
				}
				break
			}
			default:
				this.log.debug(
					{ sourceId, command: cmdName, value },
					"Unhandled relay command",
				)
				break
		}

		state.commandCount += 1
		state.lastCommandAt = now

		if (updated) {
			try {
				if (command === RTL_TCP_COMMANDS.SET_FREQUENCY)
					this.withoutCommand(() => this.onRelayRetune?.(sourceId, value))
				if (command === RTL_TCP_COMMANDS.SET_SAMPLE_RATE)
					this.withoutCommand(() => this.onOperatorSampleRate?.(sourceId))
			} catch (err) {
				this.log.warn(
					{ sourceId, err: safeErrorFields(err) },
					"Relay rate policy hook failed",
				)
			}
			if (command === RTL_TCP_COMMANDS.SET_TEST_MODE) {
				this.markWrittenNotAccepted(sourceId, command)
			} else {
				this.markAccepted(sourceId, command, value)
			}
			// A gain or gain index frame selects manual only where gainFrameMode says so.
			if (relayGainMode !== "none")
				this.noteGainFrameMode(sourceId, relayGainMode)
			delete state.lastError
			this.log.debug(
				{ sourceId, command: cmdName, value },
				"Applied relay command update",
			)
		} else if (relayGainMode !== "none") {
			// A value this controller ignores still went upstream: the mode it left is not known.
			this.noteGainFrameMode(sourceId, "unknown")
		}

		this.emitStateChanged(sourceId)
	}

	// === Tuning Commands (only when controlMode === "internal") ===

	async setFrequency(
		sourceId: string,
		hz: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		return this.withReceiptOnce(opts, opts => {
			if (opts.origin === "rest" && this.bandGain?.applyToMyTuning() === true)
				return this.serialRestRetune(sourceId, () =>
					this.setFrequencyNow(sourceId, hz, opts),
				)
			return this.setFrequencyNow(sourceId, hz, opts)
		})
	}

	/**
	 * Runs a call that may write several frames with an `onReceipt` that fires once for the whole
	 * call (TunerWriteOptions.onReceipt); a call that throws reports null. A nested call inside one
	 * keeps the outer scope. A frame written after the call returned is not reported (ReceiptOnce).
	 */
	private withReceiptOnce<T>(
		opts: TunerWriteOptions,
		run: (opts: TunerWriteOptions) => Promise<T>,
	): Promise<T> {
		const target = opts.onReceipt
		// Without a receipt to fold: the call itself, with no extra promise or microtask tick.
		if (!target || this.receiptScopes.has(target)) return run(opts)
		return this.withReceiptScope(target, opts, run)
	}

	private async withReceiptScope<T>(
		target: ReceiptCallback,
		opts: TunerWriteOptions,
		run: (opts: TunerWriteOptions) => Promise<T>,
	): Promise<T> {
		const once = new ReceiptOnce(target)
		// Called directly (not through writeFrame), the scoped callback counts as one frame.
		const scoped: ReceiptCallback = receipt => once.frame()(receipt)
		this.receiptScopes.set(scoped, once)
		try {
			return await run({ ...opts, onReceipt: scoped })
		} catch (err) {
			once.fail()
			throw err
		} finally {
			once.end()
		}
	}

	private async setFrequencyNow(
		sourceId: string,
		hz: number,
		opts: TunerWriteOptions,
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateRange("frequency", hz, VALIDATION.frequency)
		if (opts.origin === "rest" && this.beforeOperatorRetune) {
			// Awaited hook work belongs to this command, including its continuations.
			await this.beforeOperatorRetune(sourceId, hz, opts)
			await this.proveSampleRateForFrequency(sourceId, opts, hz)
		}
		await this.writeFrequency(sourceId, hz, opts, state)
		await this.applyOperatorBandGain(sourceId, hz, opts)
	}

	private async writeFrequency(
		sourceId: string,
		hz: number,
		opts: TunerWriteOptions,
		state: TunerState,
	): Promise<void> {
		// Before the write: a failed write may still have moved the tuner off the band.
		this.appliedBandGain.delete(sourceId)
		const mine = this.nextFieldWrite(sourceId, "frequency")
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_FREQUENCY, hz, opts)
		this.sourceManager.assertTunerCommandActive()
		if (this.supersededWrite(sourceId, "frequency", mine)) return
		state.frequency = hz
		this.withCentreOrigin(
			sourceId,
			opts.origin === "rest" ? "user" : "other",
			() => this.sourceManager.updateSourceCaps(sourceId, { centerFreq: hz }),
		)
		this.emitStateChanged(sourceId)
	}

	/**
	 * WG10 req 2.8: before an operator frequency write, writes the sample rate the core holds
	 * (value unchanged, origin from `opts`, normally `rest`) when the live session does not prove
	 * it (the skip rule: proven, settling or queued at that value skips), so the trust label can
	 * become `commanded`. Writes only in internal control and for a held rate (accepted, or the
	 * declared one the state still shows) that is a valid RTL rate. Returns true when it wrote. A
	 * failed write throws the tuner error of `setSampleRate` (the caller then writes no
	 * frequency). Concurrent callers share the first one's frame (queued at once, so the rest
	 * skip). The scanner path never calls this (WG9 hop rule unchanged). `frequencyHz`, when
	 * given, is the frequency about to be written: outside the frequency range nothing is
	 * written (the frequency write then fails as today).
	 */
	async proveSampleRateForFrequency(
		sourceId: string,
		opts: TunerWriteOptions = {},
		frequencyHz?: number,
	): Promise<boolean> {
		this.sourceManager.assertTunerCommandActive()
		const state = this.tunerStates.get(sourceId)
		if (!state || state.controlMode !== "internal") return false
		if (
			frequencyHz !== undefined &&
			!(
				Number.isInteger(frequencyHz) &&
				frequencyHz >= VALIDATION.frequency.min &&
				frequencyHz <= VALIDATION.frequency.max
			)
		)
			return false
		// A rate a plain resume left unverified, or a relay value the controller ignored, is a
		// placeholder: never written to prove it.
		if (
			this.unverifiedFields.get(sourceId)?.has("sampleRate") === true ||
			this.ignoredRelayFields.get(sourceId)?.has("sampleRate") === true
		)
			return false
		const hz = state.sampleRate
		const held =
			this.acceptedTuning.get(sourceId)?.sampleRate === hz ||
			this.declaredValue(sourceId, "sampleRate") === hz
		if (
			!held ||
			!Number.isInteger(hz) ||
			hz < VALIDATION.sampleRate.min ||
			hz > VALIDATION.sampleRate.max ||
			!isValidRtlSampleRate(hz)
		)
			return false
		if (this.ledgerHolds(sourceId, "sampleRate", hz)) return false
		await this.withoutCommand(() => this.setSampleRate(sourceId, hz, opts))
		this.sourceManager.assertTunerCommandActive()
		return true
	}

	async setSampleRate(
		sourceId: string,
		hz: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateRange("sampleRate", hz, VALIDATION.sampleRate)
		if (!isValidRtlSampleRate(hz)) {
			throw new TunerValidationError(
				`sampleRate ${hz} is not supported by RTL-SDR (expected 225001-300000 or 900001-3200000)`,
				"sampleRate",
			)
		}
		const mine = this.nextFieldWrite(sourceId, "sampleRate")
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_SAMPLE_RATE, hz, opts)
		this.sourceManager.assertTunerCommandActive()
		if (this.supersededWrite(sourceId, "sampleRate", mine)) return
		state.sampleRate = hz
		if (opts.origin === "rest")
			this.withoutCommand(() => this.onOperatorSampleRate?.(sourceId))
		try {
			this.sourceManager.updateSourceCaps(sourceId, { sampleRate: hz })
		} catch (err) {
			this.log.warn({ sourceId, err }, "Failed to update source caps")
		}
		this.emitStateChanged(sourceId)
	}

	async setGainMode(
		sourceId: string,
		mode: TunerGainMode,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		const value = mode === "manual" ? 1 : 0
		this.appliedBandGain.delete(sourceId)
		const mine = this.nextFieldWrite(sourceId, "gainMode")
		this.gainModeWritesInFlight.set(
			sourceId,
			(this.gainModeWritesInFlight.get(sourceId) ?? 0) + 1,
		)
		try {
			await this.countedGainWrite(sourceId, opts, () =>
				this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_GAIN_MODE, value, opts),
			)
		} finally {
			const left = (this.gainModeWritesInFlight.get(sourceId) ?? 1) - 1
			if (left > 0) this.gainModeWritesInFlight.set(sourceId, left)
			else this.gainModeWritesInFlight.delete(sourceId)
		}
		if (this.supersededWrite(sourceId, "gainMode", mine)) return
		state.gainMode = mode
		this.noteOperatorGainWrite(sourceId, opts)
		this.emitStateChanged(sourceId)
	}

	async setGain(
		sourceId: string,
		tenthsDb: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateRange("gain", tenthsDb, VALIDATION.gain)
		this.appliedBandGain.delete(sourceId)
		const mine = this.nextFieldWrite(sourceId, "gain")
		await this.countedGainWrite(sourceId, opts, () =>
			this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_GAIN, tenthsDb, opts),
		)
		if (this.supersededWrite(sourceId, "gain", mine)) return
		state.gain = tenthsDb
		this.noteOperatorGainWrite(sourceId, opts)
		this.emitStateChanged(sourceId)
	}

	/**
	 * What a gain frame does to the tuner's gain mode. rtl_tcp SET_GAIN and SET_TUNER_GAIN_INDEX
	 * go through `rtlsdr_set_tuner_gain`; on an R820T or R828D (rtl_tcp header tuner type 5 or 6)
	 * that selects manual gain. Other tuners set the mode apart (E4000, FC0012, FC0013, FC2580), an
	 * unknown tuner or server may do anything, and rtl_tcp ignores a gain index outside the
	 * advertised gain table. So "manual" only on those two tuners with a gain table and, for an
	 * index, one inside it; any other gain frame makes the mode "unknown", never a guess. "none"
	 * for a frame that never changes the mode (IF gain and every other command).
	 */
	private gainFrameMode(
		sourceId: string,
		cmd: number,
		value: number,
	): "manual" | "unknown" | "none" {
		if (
			cmd !== RTL_TCP_COMMANDS.SET_GAIN &&
			cmd !== RTL_TCP_COMMANDS.SET_TUNER_GAIN_INDEX
		)
			return "none"
		const header = this.rtlTcpHeader(sourceId)
		if (
			header === undefined ||
			!MANUAL_ON_GAIN_TUNER_TYPES.has(header.tunerType) ||
			header.gainCount <= 0
		)
			return "unknown"
		if (
			cmd === RTL_TCP_COMMANDS.SET_TUNER_GAIN_INDEX &&
			value >= header.gainCount
		)
			return "unknown"
		return "manual"
	}

	/** The source's parsed rtl_tcp header; a source manager without one (a partial double) has none. */
	private rtlTcpHeader(
		sourceId: string,
	): { tunerType: number; gainCount: number } | undefined {
		const manager: Partial<Pick<SourceManager, "getRtlTcpInfo">> =
			this.sourceManager
		return manager.getRtlTcpInfo?.(sourceId)
	}

	/**
	 * The advertised gain table length of the source's rtl_tcp header, when it gives one
	 * (undefined without a header or with no table): valid gain indexes are 0 to count - 1.
	 */
	tunerGainCount(sourceId: string): number | undefined {
		const count = this.rtlTcpHeader(sourceId)?.gainCount
		return count !== undefined && count > 0 ? count : undefined
	}

	/**
	 * The gain mode after a gain frame (gainFrameMode). Manual: the state says so (inferred), so it
	 * never claims AGC on a manual tuner, and a later AGC request differs and writes the mode. An
	 * accepted gain mode keeps its place in the replay and is replayed before the gain written after
	 * it. Unknown: the mode is unverified, so it is never claimed and the next mode request writes.
	 * No gain frame selects AGC, so a proven manual mode stays manual, unless a mode write is in
	 * flight: its frame may already have changed the mode the state still shows.
	 */
	private noteGainFrameMode(
		sourceId: string,
		mode: "manual" | "unknown",
	): void {
		const state = this.tunerStates.get(sourceId)
		if (!state) return
		const provenManual =
			state.gainMode === "manual" && !this.isUnproven(sourceId, "gainMode")
		if (mode === "unknown") {
			if (!provenManual || this.gainModeWritesInFlight.has(sourceId))
				this.markGainModeUnknown(sourceId)
			return
		}
		if (provenManual) return
		state.gainMode = "manual"
		this.markInferred(sourceId, "gainMode")
	}

	/** The gain mode may have changed in a way nothing proves: unknown until the next mode write. */
	private markGainModeUnknown(sourceId: string): void {
		this.inferredFields.get(sourceId)?.delete("gainMode")
		let unverified = this.unverifiedFields.get(sourceId)
		if (!unverified) {
			unverified = new Set()
			this.unverifiedFields.set(sourceId, unverified)
		}
		unverified.add("gainMode")
	}

	private noteLeftAgc(sourceId: string, cmd: number, value: number): void {
		const mode = this.gainFrameMode(sourceId, cmd, value)
		if (mode === "none") return
		// A gain mode setter still waiting on its own frame is overridden by this one.
		this.noteFieldWrite(sourceId, "gainMode")
		this.noteGainFrameMode(sourceId, mode)
	}

	async setPpm(
		sourceId: string,
		ppm: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateRange("ppm", ppm, VALIDATION.ppm)
		const value = this.encodeSignedInt32(ppm)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_FREQ_CORRECTION,
			value,
			opts,
		)
		this.sourceManager.assertTunerCommandActive()
		state.ppm = ppm
		this.emitStateChanged(sourceId)
	}

	async setIfGain(
		sourceId: string,
		gain: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUint32("ifGain", gain)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_IF_GAIN, gain, opts)
		this.sourceManager.assertTunerCommandActive()
		state.ifGain = gain
		// Another gain stage: the band gain and the saved pre-band gain stay.
		this.emitStateChanged(sourceId)
	}

	/**
	 * RTL2832 test mode (counter samples). Used by the scanner as a retune
	 * marker; never accepted state, so reconnect replay cannot re-send it
	 * (signal discovery spec § 4.6). The reported state still follows it.
	 */
	async setTestMode(
		sourceId: string,
		enabled: boolean,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_TEST_MODE,
			enabled ? 1 : 0,
			{ ...opts, accept: false },
		)
		this.sourceManager.assertTunerCommandActive()
		state.testMode = enabled
		this.emitStateChanged(sourceId)
	}

	async setAgcMode(
		sourceId: string,
		enabled: boolean,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		// The RTL2832 digital AGC is a separate stage from the tuner gain mode and gain: it is no
		// gain choice, keeps the saved pre-band gain and the band gain on the tuner.
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_AGC_MODE,
			enabled ? 1 : 0,
			opts,
		)
		this.sourceManager.assertTunerCommandActive()
		state.agcMode = enabled
		this.emitStateChanged(sourceId)
	}

	async setDirectSampling(
		sourceId: string,
		mode: TunerDirectSampling,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		const value = mode === "off" ? 0 : mode === "i" ? 1 : 2
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_DIRECT_SAMPLING,
			value,
			opts,
		)
		this.sourceManager.assertTunerCommandActive()
		state.directSampling = mode
		this.emitStateChanged(sourceId)
	}

	async setOffsetTuning(
		sourceId: string,
		enabled: boolean,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_OFFSET_TUNING,
			enabled ? 1 : 0,
			opts,
		)
		this.sourceManager.assertTunerCommandActive()
		state.offsetTuning = enabled
		this.emitStateChanged(sourceId)
	}

	async setRtlXtal(
		sourceId: string,
		hz: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUint32("rtlXtal", hz)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_RTL_XTAL, hz, opts)
		this.sourceManager.assertTunerCommandActive()
		state.rtlXtal = hz
		this.emitStateChanged(sourceId)
	}

	async setTunerXtal(
		sourceId: string,
		hz: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUint32("tunerXtal", hz)
		await this.sendCommand(sourceId, RTL_TCP_COMMANDS.SET_TUNER_XTAL, hz, opts)
		this.sourceManager.assertTunerCommandActive()
		state.tunerXtal = hz
		this.emitStateChanged(sourceId)
	}

	async setTunerGainIndex(
		sourceId: string,
		index: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUint32("tunerGainIndex", index)
		// rtl_tcp 0x0d sets the same tuner gain stage by table index: a gain choice, as setGain.
		this.appliedBandGain.delete(sourceId)
		await this.countedGainWrite(sourceId, opts, () =>
			this.sendCommand(
				sourceId,
				RTL_TCP_COMMANDS.SET_TUNER_GAIN_INDEX,
				index,
				opts,
			),
		)
		state.tunerGainIndex = index
		this.noteOperatorGainWrite(sourceId, opts)
		this.emitStateChanged(sourceId)
	}

	async setBiasTee(
		sourceId: string,
		enabled: boolean,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_BIAS_TEE,
			enabled ? 1 : 0,
			opts,
		)
		this.sourceManager.assertTunerCommandActive()
		state.biasTee = enabled
		this.emitStateChanged(sourceId)
	}

	async setTunerIfGain(
		sourceId: string,
		stage: number,
		gain: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUint16("tunerIfGain.stage", stage)
		this.validateUint16("tunerIfGain.gain", gain)
		const value = (stage << 16) | (gain & 0xffff)
		await this.sendCommand(
			sourceId,
			RTL_TCP_COMMANDS.SET_TUNER_IF_GAIN,
			value,
			opts,
		)
		this.sourceManager.assertTunerCommandActive()
		state.tunerIfGain = { stage, gain }
		// Another gain stage: the band gain and the saved pre-band gain stay.
		this.emitStateChanged(sourceId)
	}

	// === Bulk Update ===

	/** Not async itself: without `onReceipt` the call is configureNow's promise (no extra tick). */
	configure(
		sourceId: string,
		updates: Partial<TunerState>,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		return this.withReceiptOnce(opts, opts =>
			this.configureNow(sourceId, updates, opts),
		)
	}

	private async configureNow(
		sourceId: string,
		updates: Partial<TunerState>,
		opts: TunerWriteOptions,
	): Promise<void> {
		const state = this.validateSource(sourceId)
		const hasCommandUpdates = this.hasCommandUpdates(updates)

		if (hasCommandUpdates && state.controlMode === "external") {
			if (updates.controlMode !== "internal") {
				throw new TunerControlModeError(sourceId)
			}
		}

		// WG10 R1 m2: every field is validated before anything is written (the rate proof
		// below included), so an invalid field writes nothing and changes no mode.
		this.validateUpdates(updates)

		if (updates.controlMode === "internal") {
			this.sourceManager.assertTunerCommandActive()
			this.setControlMode(sourceId, "internal")
		}

		const policyBulk =
			opts.origin === "rest" && this.beforeOperatorRetune !== null
		if (updates.frequency !== undefined && updates.sampleRate === undefined) {
			if (policyBulk) {
				await this.beforeOperatorRetune?.(sourceId, updates.frequency, opts)
				this.sourceManager.assertTunerCommandActive()
				this.emitStateChanged(sourceId)
			}
			await this.proveSampleRateForFrequency(sourceId, opts, updates.frequency)
		}

		// The skip rule: centre and rate are written unless the live session proves them (or a
		// frame of that value is settling or waiting to leave).
		if (
			updates.frequency !== undefined &&
			this.ledgerHolds(sourceId, "frequency", updates.frequency)
		)
			this.acceptSkipped(sourceId, "frequency", updates.frequency, opts)
		else if (updates.frequency !== undefined) {
			if (policyBulk) {
				const hz = updates.frequency
				const retune = async () => {
					await this.writeFrequency(sourceId, hz, opts, state)
					await this.applyOperatorBandGain(sourceId, hz, opts)
				}
				await (this.bandGain?.applyToMyTuning() === true
					? this.serialRestRetune(sourceId, retune)
					: retune())
			} else await this.setFrequency(sourceId, updates.frequency, opts)
		}
		if (
			updates.sampleRate !== undefined &&
			!this.ledgerHolds(sourceId, "sampleRate", updates.sampleRate)
		) {
			await this.setSampleRate(sourceId, updates.sampleRate, opts)
		} else if (updates.sampleRate !== undefined) {
			this.acceptSkipped(sourceId, "sampleRate", updates.sampleRate, opts)
			if (opts.origin === "rest" && this.onOperatorSampleRate) {
				this.sourceManager.assertTunerCommandActive()
				this.withoutCommand(() => this.onOperatorSampleRate?.(sourceId))
				this.emitStateChanged(sourceId)
			}
		}
		// As a tune (applyTune): a value in place and proven sends nothing, an unproven one is
		// written, and one not accepted yet is accepted beside a held partner. rtl_tcp SET_GAIN
		// switches the tuner to manual, so for AGC the gain goes first and the mode last.
		const inPlace: Array<"gainMode" | "gain"> = []
		const operator = opts.origin === "rest"
		const notAccepted = (field: "gainMode" | "gain") =>
			this.desiredFields.get(sourceId)?.has(field) !== true
		const gainMode = updates.gainMode
		const gain = updates.gain
		let wroteMode = false
		const writeMode = async (mode: TunerGainMode) => {
			if (mode !== state.gainMode || this.isUnproven(sourceId, "gainMode")) {
				await this.setGainMode(sourceId, mode, opts)
				wroteMode = true
			} else {
				this.noteUnchangedGainChoice(sourceId, opts)
				if (operator && notAccepted("gainMode")) inPlace.push("gainMode")
			}
		}
		// A written gain mode is followed by a written gain: a tuner switched to manual may reset it.
		const writeGain = async (tenthsDb: number) => {
			if (
				tenthsDb !== state.gain ||
				wroteMode ||
				this.isUnproven(sourceId, "gain")
			)
				await this.setGain(sourceId, tenthsDb, opts)
			else {
				this.noteUnchangedGainChoice(sourceId, opts, true)
				if (operator && notAccepted("gain")) inPlace.push("gain")
			}
		}
		if (gainMode === "agc") {
			if (gain !== undefined) await writeGain(gain)
			await writeMode(gainMode)
		} else {
			if (gainMode !== undefined) await writeMode(gainMode)
			if (gain !== undefined) await writeGain(gain)
		}
		if (inPlace.length > 0) this.acceptBesideHeld(sourceId, inPlace)
		if (updates.ppm !== undefined && updates.ppm !== state.ppm) {
			await this.setPpm(sourceId, updates.ppm, opts)
		}
		if (updates.ifGain !== undefined && updates.ifGain !== state.ifGain) {
			await this.setIfGain(sourceId, updates.ifGain, opts)
		}
		if (updates.testMode !== undefined && updates.testMode !== state.testMode) {
			await this.setTestMode(sourceId, updates.testMode, opts)
		}
		if (updates.agcMode !== undefined && updates.agcMode !== state.agcMode) {
			await this.setAgcMode(sourceId, updates.agcMode, opts)
		}
		if (updates.biasTee !== undefined && updates.biasTee !== state.biasTee) {
			await this.setBiasTee(sourceId, updates.biasTee, opts)
		}
		if (
			updates.directSampling !== undefined &&
			updates.directSampling !== state.directSampling
		) {
			await this.setDirectSampling(sourceId, updates.directSampling, opts)
		}
		if (
			updates.offsetTuning !== undefined &&
			updates.offsetTuning !== state.offsetTuning
		) {
			await this.setOffsetTuning(sourceId, updates.offsetTuning, opts)
		}
		if (updates.rtlXtal !== undefined && updates.rtlXtal !== state.rtlXtal) {
			await this.setRtlXtal(sourceId, updates.rtlXtal, opts)
		}
		if (
			updates.tunerXtal !== undefined &&
			updates.tunerXtal !== state.tunerXtal
		) {
			await this.setTunerXtal(sourceId, updates.tunerXtal, opts)
		}
		if (
			updates.tunerGainIndex !== undefined &&
			updates.tunerGainIndex !== state.tunerGainIndex
		) {
			await this.setTunerGainIndex(sourceId, updates.tunerGainIndex, opts)
		} else if (updates.tunerGainIndex !== undefined)
			this.noteUnchangedGainChoice(sourceId, opts, true)
		if (
			updates.tunerIfGain !== undefined &&
			!this.isSameTunerIfGain(updates.tunerIfGain, state.tunerIfGain)
		) {
			if (updates.tunerIfGain === null) {
				this.sourceManager.assertTunerCommandActive()
				state.tunerIfGain = null
				this.desiredFields.get(sourceId)?.delete("tunerIfGain")
				this.emitStateChanged(sourceId)
			} else {
				await this.setTunerIfGain(
					sourceId,
					updates.tunerIfGain.stage,
					updates.tunerIfGain.gain,
					opts,
				)
			}
		}

		// A field already at its value sends no frame, and it is still somebody's choice.
		if (opts.origin === "rest" && hasCommandUpdates)
			this.emit("operator-choice", sourceId, opts.actor ?? "unknown")

		if (updates.controlMode === "external") {
			this.sourceManager.assertTunerCommandActive()
			this.setControlMode(sourceId, "external")
		}
	}

	// === Tune in one call ===

	/**
	 * The settings of a tune with the setters' own value checks, for a refusal before anything
	 * waits or writes. Throws TunerValidationError naming the field by its GET /api/tuner name.
	 */
	validateTune(values: TuneValues): void {
		this.validateUpdates(values)
	}

	/**
	 * Applies a tune inside one tuner command: the rate first (rate before centre, as a reconnect
	 * replays them), then the centre, then the gain. An operator's tune follows the bulk update's
	 * rules: the rate policy and the rate proof run only without an explicit rate, a band gain
	 * applies after the centre, and an explicit gain overrides it. A field already at the value and
	 * proven is not written, unless `opts.forceWrite` says so, but still counts as applied.
	 *
	 * `opts.restore` puts a temporary tune's prior tuning back: exactly the given values, only
	 * where they differ (never a write to prove a value nobody changed), with no rate policy and no
	 * band gain. `applied` is called after each setting; a throw from it stops the tune there.
	 * `leftAgc`: a gain written since the mode was (rtl_tcp SET_GAIN switches the tuner to manual
	 * and the state does not show it), so going back to AGC writes the mode even when it matches.
	 * A written gain mode is always followed by a written gain: a tuner switched to manual may
	 * reset its gain. A centre or rate the skip rule leaves unwritten is still accepted (unless
	 * `accept: false`).
	 *
	 * Not async itself: without `onReceipt` the call is applyTuneNow's promise (no extra tick).
	 */
	applyTune(
		sourceId: string,
		values: TuneValues,
		opts: TunerWriteOptions,
		applied: (setting: TuneSetting) => void,
		leftAgc = false,
	): Promise<void> {
		return this.withReceiptOnce(opts, opts =>
			this.applyTuneNow(sourceId, values, opts, applied, leftAgc),
		)
	}

	private async applyTuneNow(
		sourceId: string,
		values: TuneValues,
		opts: TunerWriteOptions,
		applied: (setting: TuneSetting) => void,
		leftAgc: boolean,
	): Promise<void> {
		const state = this.validateSourceForControl(sourceId)
		this.validateUpdates(values)
		const restoring = opts.restore === true
		const operator = opts.origin === "rest" && !restoring
		const unproven = (field: TunerStateField): boolean => {
			const proof = this.fieldProof(sourceId)
			return (
				proof.unknownFields.includes(field) ||
				proof.declaredOnlyFields.includes(field)
			)
		}
		const changed = (field: TunerStateField, differs: boolean): boolean =>
			differs || (!restoring && unproven(field)) || opts.forceWrite?.() === true
		// Centre and rate follow the skip rule alone (a restore too: an unproven field is written).
		const gatedChanged = (field: GatedField, value: number): boolean =>
			!this.ledgerHolds(sourceId, field, value) || opts.forceWrite?.() === true

		const hz = values.sampleRate
		if (hz !== undefined) {
			if (gatedChanged("sampleRate", hz))
				await this.setSampleRate(sourceId, hz, opts)
			else {
				this.acceptSkipped(sourceId, "sampleRate", hz, opts)
				if (operator && this.onOperatorSampleRate) {
					this.sourceManager.assertTunerCommandActive()
					this.withoutCommand(() => this.onOperatorSampleRate?.(sourceId))
					this.emitStateChanged(sourceId)
				}
			}
			applied("sampleRateHz")
		}

		const frequency = values.frequency
		if (frequency !== undefined) {
			if (operator && hz === undefined) {
				const hook = this.beforeOperatorRetune
				if (hook !== null) {
					await (opts.run
						? this.retuneHookTune.run(opts, () =>
								hook(sourceId, frequency, opts),
							)
						: hook(sourceId, frequency, opts))
					this.sourceManager.assertTunerCommandActive()
					this.emitStateChanged(sourceId)
				}
				await this.proveSampleRateForFrequency(sourceId, opts, frequency)
			}
			if (gatedChanged("frequency", frequency)) {
				const retune = async () => {
					await this.writeFrequency(sourceId, frequency, opts, state)
					if (operator)
						await this.applyOperatorBandGain(sourceId, frequency, opts)
				}
				await (operator && this.bandGain?.applyToMyTuning() === true
					? this.serialRestRetune(sourceId, retune)
					: retune())
			} else this.acceptSkipped(sourceId, "frequency", frequency, opts)
			applied("frequencyHz")
		}

		let wroteGain = leftAgc
		let wroteMode = false
		// Operator values in place that sent no frame and are not accepted yet (acceptBesideHeld).
		const inPlace: Array<"gainMode" | "gain"> = []
		const notAccepted = (field: "gainMode" | "gain") =>
			this.desiredFields.get(sourceId)?.has(field) !== true
		const writeMode = async (mode: TunerGainMode) => {
			if (
				changed("gainMode", mode !== state.gainMode) ||
				(mode === "agc" && wroteGain)
			) {
				await this.setGainMode(sourceId, mode, opts)
				wroteMode = true
			} else if (operator) {
				this.noteUnchangedGainChoice(sourceId, opts)
				if (notAccepted("gainMode")) inPlace.push("gainMode")
			}
			applied("gainMode")
		}
		const writeGain = async (tenthsDb: number) => {
			if (changed("gain", tenthsDb !== state.gain) || wroteMode) {
				await this.setGain(sourceId, tenthsDb, opts)
				wroteGain = true
			} else if (operator) {
				this.noteUnchangedGainChoice(sourceId, opts, true)
				if (notAccepted("gain")) inPlace.push("gain")
			}
			applied("gain")
		}
		// rtl_tcp SET_GAIN switches the tuner to manual: for AGC the mode goes last.
		if (values.gainMode === "agc") {
			if (values.gain !== undefined) await writeGain(values.gain)
			await writeMode("agc")
		} else {
			if (values.gainMode !== undefined) await writeMode(values.gainMode)
			if (values.gain !== undefined) await writeGain(values.gain)
		}
		if (inPlace.length > 0) this.acceptBesideHeld(sourceId, inPlace)
	}

	/** What a temporary tune must remember to put the tuner back. */
	tuneSnapshot(sourceId: string): TuneSnapshot | undefined {
		const state = this.tunerStates.get(sourceId)
		if (!state) return undefined
		const { unknownFields } = this.fieldProof(sourceId)
		const known = (field: TunerStateField) => !unknownFields.includes(field)
		const bandGain = this.confirmedBandGain(state, unknownFields)
		return {
			state: {
				...(known("sampleRate") ? { sampleRate: state.sampleRate } : {}),
				...(known("frequency") ? { frequency: state.frequency } : {}),
				...(known("gainMode") ? { gainMode: state.gainMode } : {}),
				...(known("gain") ? { gain: state.gain } : {}),
			},
			...(bandGain ? { bandGain } : {}),
		}
	}

	/**
	 * A restore put `snapshot` back: what the tune held for the record goes unwritten, and the file
	 * is as it was before the tune (TuneWriteRun). A band gain confirmed at the snapshot is confirmed
	 * again when the known state shows it.
	 */
	noteTuneRestored(sourceId: string, snapshot: TuneSnapshot): void {
		this.dropTuneGainSave(sourceId)
		const hz = this.tunerStates.get(sourceId)?.frequency
		if (snapshot.bandGain !== undefined && hz !== undefined)
			this.noteBandGainApplied(
				sourceId,
				snapshot.bandGain.tenthsDb,
				snapshot.bandGain.owner,
				hz,
			)
	}

	/** A temporary tune ended without staying: what it held for the record goes unwritten. */
	dropTuneGainSave(sourceId: string): void {
		this.tuneGainSaves.delete(sourceId)
	}

	/**
	 * A temporary tune stays, so it stops being temporary and acts as an operator tune, once. With a
	 * gain or gain mode of its own the record goes, as for an explicit gain write, durably: the old
	 * gain can never come back over it, even after a restart. Without one, a band it entered with no
	 * record saves the gain from before the tune, so leaving the band gives it back. With neither
	 * the file is untouched, and a later retune handles the record as usual.
	 */
	noteTuneKept(sourceId: string, choseGain: boolean): void {
		if (choseGain) {
			const dropped = this.operatorGainBeforeBand.get(sourceId)
			// Nothing else can tell the operator afterwards what the record held.
			if (dropped)
				this.log.info(
					{ sourceId, gainMode: dropped.gainMode, gain: dropped.gain },
					"A temporary tune with its own gain stays; the gain saved before the band is dropped",
				)
			this.dropOperatorGain(sourceId)
			return
		}
		const held = this.tuneGainSaves.get(sourceId)
		if (held === undefined) return
		this.tuneGainSaves.delete(sourceId)
		void this.saveOperatorGain(sourceId, held).then(outcome => {
			if (outcome === "failed") this.logGainSaveFailed(sourceId)
		})
	}

	/** The tune behind the current `lastChange`, if a tune wrote it. */
	lastChangeRun(sourceId: string): TuneWriteRun | undefined {
		return this.lastChangeRuns.get(sourceId)
	}

	private tuneStatus: TuneStatusOf | null = null

	/** Where `restore` and `lastTune` of the published state come from. */
	setTuneStatus(status: TuneStatusOf | null): void {
		this.tuneStatus = status
	}

	/** Publishes the state again after `restore` or `lastTune` changed. */
	publishState(sourceId: string): void {
		this.emitStateChanged(sourceId)
	}

	// === Reconnect Synchronization ===

	/**
	 * Synchronize tuner state and source metadata for a new source session.
	 * Wired to the session's first payload (see core/tuner-wiring.ts).
	 *
	 * rtl_tcp cannot report the receiver's rate or center, so after a reconnect
	 * the receiver may be at its own defaults. Policy (config `tuner.reconnectPolicy`):
	 * - "restore": re-send fields accepted through the API or relay (never config
	 *   defaults). Frames are written synchronously before any event fires, so a
	 *   later API/relay command is always written after the batch and wins. Centre
	 *   and rate: assert writes the held value (accepted, else declared).
	 * - "reset": write nothing; discard accepted state and fall back to the
	 *   configured baseline, exactly as after a fresh start. Centre and rate: no
	 *   declared write (declaredBlock); assert writes only values accepted on this
	 *   connection (discarded here, at its start), after a doubt.
	 * Either way source caps are then reconciled with what the tuner state can
	 * back, so stale metadata is never kept silently. Success means "written",
	 * never "applied": rtl_tcp has no acknowledgement or readback.
	 *
	 * `options.resume` marks the first session after a paused feed's resume (whatever the policy):
	 * - "restore" (POST /api/sources/:id/resume with `restoreTuning: true`): the "restore" policy.
	 * - "plain" (the default resume): see synchronizeOnPlainResume; no tuning is written.
	 */
	synchronizeOnConnect(
		sourceId: string,
		options: { resume?: TunerResumeKind } = {},
	): TunerConnectSyncResult {
		const policy =
			options.resume === "restore"
				? "restore"
				: (this.config.reconnectPolicy ?? "restore")
		const state = this.tunerStates.get(sourceId)
		if (!state) return { policy, commands: [], reset: false }
		// The pause is over either way. Unverified fields stay so until written (or a reset).
		const pausedAt = this.pausedAtSeq.get(sourceId)
		this.pausedAtSeq.delete(sourceId)
		const desired = this.desiredFields.get(sourceId)
		// A double's new connection: a new stand-in session (the real ledger opened one already).
		this.standInSession(sourceId)
		// WG11 req 4.2: the configured frames are considered once per connection.
		const configDue = this.configWriteDue.delete(sourceId)
		if (configDue) this.configProvenFields.delete(sourceId)

		if (options.resume === "plain")
			return this.synchronizeOnPlainResume(sourceId, state, pausedAt)
		// A restore resume writes the configured frames again (and every later connection).
		// It measured nothing yet: a rate it does not write stays unverified, not measured.
		if (options.resume === "restore") {
			this.plainResumeHold.delete(sourceId)
			this.forgetMeasuredRate(sourceId)
			// This session follows the restore policy whatever tuner.reconnectPolicy says.
			const session = this.ledger().position(sourceId)?.session
			if (session !== undefined)
				this.restoreResumeSession.set(sourceId, session)
		}

		if (policy === "reset") {
			const reset = desired !== undefined && desired.size > 0
			// Inferred or ignored-relay fields alone are no reset, but their proof is gone too.
			const forgot =
				(this.inferredFields.get(sourceId)?.size ?? 0) > 0 ||
				(this.ignoredRelayFields.get(sourceId)?.size ?? 0) > 0
			// After a plain resume (plainResumeHold) the receiver is another client's to tune: the
			// configured baseline is no better a guess than the last known values, so they stay,
			// unverified with every discarded field, and caps hold them (rate adoption continues).
			const hold = this.plainResumeHold.has(sourceId)
			if (hold) this.holdUnverified(sourceId, desired)
			this.desiredFields.delete(sourceId)
			this.acceptedTuning.delete(sourceId)
			this.inferredFields.delete(sourceId)
			this.ignoredRelayFields.delete(sourceId)
			if (!hold) this.unverifiedFields.delete(sourceId)
			// With nothing accepted every non-baseline value came from an inferred write or
			// relay command, so a forget also returns the values to the baseline (WG5 R2).
			if ((reset || forgot) && !hold)
				this.applyBaselineFields(state, this.baselineCaps.get(sourceId))
			if (reset) {
				this.log.warn(
					{ sourceId },
					"Source reconnected: discarded accepted tuner state (reconnectPolicy=reset); receiver state unconfirmed",
				)
			}
			// Accepted fields are gone, so every configured field is written.
			const configured = configDue
				? this.writeConfiguredTuning(sourceId, state)
				: undefined
			// Nothing accepted is left, and the reset policy turns the declared fallback off
			// (declaredBlock): assert writes only what is accepted on this connection from now on.
			const asserted =
				configured?.error === undefined
					? this.writeAssertFrames(sourceId, state)
					: { written: [] }
			if (asserted.written.length > 0) {
				state.commandCount += asserted.written.length
				state.lastCommandAt = new Date().toISOString()
			}
			if (asserted.failure)
				state.lastError = `Tuner state assert failed: ${asserted.failure.message}`
			const capsChanged = this.reconcileCaps(sourceId, state)
			for (const { name, value, shown } of asserted.written) {
				this.noteReconnectFrame(sourceId, name, value, "replay", shown)
				this.emit("command-sent", sourceId, name, value, "replay")
			}
			if (asserted.failure) this.emit("error", sourceId, asserted.failure)
			if (
				reset ||
				forgot ||
				capsChanged ||
				configured?.attempted === true ||
				asserted.written.length > 0
			)
				this.emitStateChanged(sourceId)
			const commands = [
				...(configured?.commands ?? []),
				...asserted.written.map(w => w.name),
			]
			const error = configured?.error ?? state.lastError
			return configured?.error !== undefined || asserted.failure
				? { policy, commands, reset, ...(error ? { error } : {}) }
				: { policy, commands, reset }
		}

		// Centre and rate are not replayed: assert writes them where the new session does not
		// prove them (writeAssertFrames), in the replay's place (after the sampling path, crystals
		// and ppm, before the front end and gain). An unaccepted centre (a scanner hop) is no held
		// value: under the lease its holder re-sends it, without one the held value goes back.

		// WG11 req 4.2, 4.3: configured fields not held by the operator, before the
		// restore; a failed configured write stops the restore too (today's failure).
		const configured = configDue
			? this.writeConfiguredTuning(sourceId, state)
			: undefined
		if (configured?.error !== undefined) {
			const capsChanged = this.reconcileCaps(sourceId, state)
			if (configured.attempted || capsChanged) this.emitStateChanged(sourceId)
			return {
				policy,
				commands: configured.commands,
				reset: false,
				error: configured.error,
			}
		}

		const written: Array<{ value: number; name: string; shown?: number }> = []
		let failure: Error | undefined
		const replay = desired
			? this.buildReplayPlan(state, desired, true)
			: { before: [], after: [] }
		const plan = [...replay.before, ...replay.after]
		// A gain mode inferred on the last connection (a gain frame's manual, or a mode written and
		// not accepted) is not replayed: this connection may reach another receiver, so only a gain
		// frame replayed on it, judged against its own header, proves the mode again. An accepted
		// mode is replayed and proven by its own frame.
		const inferredMode =
			desired?.has("gainMode") !== true &&
			this.inferredFields.get(sourceId)?.has("gainMode") === true
		let lastGainFrame: [number, number] | undefined
		let assertedAny = false
		for (const [i, [cmd, value]] of plan.entries()) {
			if (i === replay.before.length) {
				const asserted = this.writeAssertFrames(sourceId, state)
				written.push(...asserted.written)
				if (asserted.written.length > 0) assertedAny = true
				if (asserted.failure) {
					failure = asserted.failure
					break
				}
			}
			try {
				this.writeFrame(sourceId, cmd, value)
			} catch (err) {
				failure =
					err instanceof Error
						? err
						: new WaveKitError(String(err), "TUNER_RESTORE_FAILED")
				break
			}
			const name = COMMAND_NAMES[cmd] ?? `cmd-0x${cmd.toString(16)}`
			written.push({ value, name })
			const field = stateFieldOf(cmd)
			if (field !== undefined) this.clearIgnoredRelayField(sourceId, field)
			if (cmd === RTL_TCP_COMMANDS.SET_GAIN_MODE) lastGainFrame = undefined
			else if (this.gainFrameMode(sourceId, cmd, value) !== "none")
				lastGainFrame = [cmd, value]
		}
		// No frame after the sampling path: assert still runs (centre and rate are always due).
		if (!failure && replay.after.length === 0) {
			const asserted = this.writeAssertFrames(sourceId, state)
			written.push(...asserted.written)
			if (asserted.written.length > 0) assertedAny = true
			if (asserted.failure) failure = asserted.failure
		}
		// A gain frame replayed after the mode moves it as a live one does (gainFrameMode).
		const replayedMode =
			lastGainFrame === undefined
				? "none"
				: this.gainFrameMode(sourceId, ...lastGainFrame)
		if (inferredMode) {
			if (replayedMode === "manual") {
				state.gainMode = "manual"
				this.markInferred(sourceId, "gainMode")
			} else {
				this.markGainModeUnknown(sourceId)
			}
		} else if (replayedMode !== "none") {
			this.noteGainFrameMode(sourceId, replayedMode)
		}

		if (written.length > 0) {
			state.commandCount += written.length
			state.lastCommandAt = new Date().toISOString()
		}
		if (failure) {
			state.lastError = `Tuner state restore failed: ${failure.message}`
		} else if (written.length > 0) {
			delete state.lastError
		}

		const capsChanged = this.reconcileCaps(sourceId, state)

		const replayed = written.map(entry => entry.name)
		const commands = [...(configured?.commands ?? []), ...replayed]
		if (failure) {
			this.log.warn(
				{ sourceId, commands: replayed, err: failure.message },
				"Tuner state restore interrupted; will retry on next connection",
			)
		} else if (replayed.length > 0) {
			this.log.info(
				{ sourceId, commands: replayed },
				"Restored desired tuner state",
			)
		}

		for (const { name, value, shown } of written) {
			this.noteReconnectFrame(sourceId, name, value, "replay", shown)
			this.emit("command-sent", sourceId, name, value, "replay")
		}
		if (failure) this.emit("error", sourceId, failure)
		if (
			plan.length > 0 ||
			assertedAny ||
			capsChanged ||
			inferredMode ||
			configured?.attempted === true
		)
			this.emitStateChanged(sourceId)

		const resume =
			options.resume === "restore" ? { resume: "restore" as const } : {}
		return failure
			? {
					policy,
					commands,
					reset: false,
					error: state.lastError ?? failure.message,
					...resume,
				}
			: { policy, commands, reset: false, ...resume }
	}

	/**
	 * Plain resume of a paused feed ("never fight SDR++"): while the core was disconnected another
	 * client may have retuned the shared receiver (SDR++ through rtlmux), and rtl_tcp cannot report
	 * its centre, rate or gain. So nothing accepted before the pause and no configured frame is
	 * written. Those fields leave the accepted set (a later dropout reconnect does not replay them
	 * either) and centre, rate, gain mode and gain read unknown (`unknownFields`) with their last
	 * known values until they are written, accepted or observed (adoptObservedSampleRate).
	 * Fields accepted during the pause (tuner relay commands while the source was down; without
	 * a pause marker, every accepted field: the feed was paused at boot) are the operator's newest
	 * state and are written, as on a restore. Caps keep their values; replayed fields follow.
	 */
	private synchronizeOnPlainResume(
		sourceId: string,
		state: TunerState,
		pausedAt: number | undefined,
	): TunerConnectSyncResult {
		const policy = this.config.reconnectPolicy ?? "restore"
		const desired = this.desiredFields.get(sourceId)
		const since = pausedAt ?? 0
		const kept = new Map<DesiredField, number>()
		const dropped: DesiredField[] = []
		for (const [field, seq] of desired ?? []) {
			if (seq > since) kept.set(field, seq)
			else dropped.push(field)
		}
		if (kept.size > 0) this.desiredFields.set(sourceId, kept)
		else this.desiredFields.delete(sourceId)
		const accepted = this.acceptedTuning.get(sourceId)
		for (const field of GATED_FIELDS)
			if (accepted && !kept.has(field)) delete accepted[field]
		// A pre-pause inferred value is no more proven than an accepted one.
		this.inferredFields.delete(sourceId)
		// The gain saved before a band gain is a pre-pause snapshot too: leaving the band later
		// must not write it over whatever gain the receiver has now. The band gain record goes
		// with it, so no gain on the tuner reads as the scanner's or the operator's band gain.
		this.dropOperatorGain(sourceId)
		this.appliedBandGain.delete(sourceId)
		// Nothing configured is owed on this or any later connection (plainResumeHold).
		this.plainResumeHold.add(sourceId)

		const doubt = new Set<TunerStateField>(PLAIN_RESUME_UNVERIFIED)
		for (const field of dropped) {
			const stateField = STATE_FIELDS.find(f => f === field)
			if (stateField !== undefined) doubt.add(stateField)
		}
		const commanded: ReadonlyMap<string, number> = kept
		const unverified = new Set<TunerStateField>()
		for (const field of doubt) if (!commanded.has(field)) unverified.add(field)
		this.unverifiedFields.set(sourceId, unverified)
		this.measuredRates.delete(sourceId)

		const written: Array<{ value: number; name: string }> = []
		let failure: Error | undefined
		// Fields accepted during the pause are the operator's newest: written (centre and rate too,
		// tagged assert: the core puts them back, nobody asked for them on this connection).
		for (const [cmd, value] of this.buildReplayPlan(state, kept).before) {
			try {
				this.writeFrame(
					sourceId,
					cmd,
					value,
					cmd === RTL_TCP_COMMANDS.SET_FREQUENCY ||
						cmd === RTL_TCP_COMMANDS.SET_SAMPLE_RATE
						? ASSERT_WRITER
						: OPERATOR_WRITER,
				)
			} catch (err) {
				failure =
					err instanceof Error
						? err
						: new WaveKitError(String(err), "TUNER_RESTORE_FAILED")
				break
			}
			const name = COMMAND_NAMES[cmd] ?? `cmd-0x${cmd.toString(16)}`
			written.push({ value, name })
		}
		if (written.length > 0) {
			state.commandCount += written.length
			state.lastCommandAt = new Date().toISOString()
		}
		if (failure)
			state.lastError = `Tuner state restore failed: ${failure.message}`
		else if (written.length > 0) delete state.lastError

		// Caps keep the last known centre and rate (reconcileCaps holds unverified fields); a
		// field the relay commanded during the pause follows its written value.
		this.reconcileCaps(sourceId, state)

		const commands = written.map(entry => entry.name)
		this.log.info(
			{ sourceId, commands, unverified: [...unverified] },
			"Resumed the paused feed without restoring its tuning; centre, rate and gain unverified until set",
		)
		if (failure)
			this.log.warn(
				{ sourceId, commands, err: failure.message },
				"Writing relay commands from the pause interrupted; will retry on next connection",
			)
		for (const { name, value } of written) {
			this.noteReconnectFrame(sourceId, name, value, "replay")
			this.emit("command-sent", sourceId, name, value, "replay")
		}
		if (failure) this.emit("error", sourceId, failure)
		this.emitStateChanged(sourceId)
		return failure
			? {
					policy,
					commands,
					reset: false,
					error: state.lastError ?? failure.message,
					resume: "plain",
				}
			: { policy, commands, reset: false, resume: "plain" }
	}

	/**
	 * A reset-policy reconnect under plainResumeHold: the plain resume's unverified fields stay so,
	 * and the accepted, inferred and ignored-relay fields it is about to discard join them (their
	 * values were written on an earlier connection the receiver may no longer reflect).
	 */
	private holdUnverified(
		sourceId: string,
		desired: ReadonlyMap<DesiredField, number> | undefined,
	): void {
		const unverified = new Set(this.unverifiedFields.get(sourceId))
		const discarded = [
			...(desired?.keys() ?? []),
			...(this.inferredFields.get(sourceId) ?? []),
			...(this.ignoredRelayFields.get(sourceId) ?? []),
		]
		for (const field of discarded) {
			const stateField = STATE_FIELDS.find(f => f === field)
			if (stateField !== undefined) unverified.add(stateField)
		}
		this.unverifiedFields.set(sourceId, unverified)
	}

	/**
	 * Marks the source's feed paused (wired to SourceManager "feed-changed", which a repeated
	 * pause of an already paused feed does not emit): fields accepted from now on (tuner relay
	 * commands while the source is down) are written by a plain resume. Each new pause moves the
	 * mark, so a relay command from an earlier pause whose resume never reached a payload is not
	 * written later. The next synchronizeOnConnect consumes it.
	 */
	noteFeedPaused(sourceId: string): void {
		if (!this.tunerStates.has(sourceId)) return
		this.pausedAtSeq.set(sourceId, this.acceptanceSeq)
		// The measured rate was this connection's: nothing measures a paused feed.
		this.forgetMeasuredRate(sourceId)
	}

	/** Drops the source's measured-rate provenance, publishing the state when it was shown. */
	private forgetMeasuredRate(sourceId: string): void {
		if (this.measuredRates.delete(sourceId)) this.emitStateChanged(sourceId)
	}

	/**
	 * What a restore resume would write back for centre, rate and gain (the accepted fields);
	 * undefined without an accepted centre. Shown on the paused feed (SourceFeed.restoreTuning).
	 */
	restorableTuning(sourceId: string): SourceFeedRestoreTuning | undefined {
		const state = this.tunerStates.get(sourceId)
		const desired = this.desiredFields.get(sourceId)
		if (!state || desired?.has("frequency") !== true) return undefined
		return {
			centerFreq: state.frequency,
			...(desired.has("sampleRate") ? { sampleRate: state.sampleRate } : {}),
			...(desired.has("gainMode") ? { gainMode: state.gainMode } : {}),
			...(desired.has("gain") ? { gain: state.gain } : {}),
		}
	}

	/**
	 * A plain resume left the sample rate unverified and the source's measured rate disagrees
	 * with it (rate truth, sustained): when the measurement is within RESUME_RATE_MATCH of exactly
	 * one common rtl_tcp rate, adopt that rate (state and caps; never accepted or replayed). The
	 * rate stays unverified (a measurement, not a command), so caps hold it through a dropout and a
	 * later external rate change is adopted the same way; setting a rate ends it. True when adopted.
	 * Anything else keeps the old rate and the mismatch flag.
	 */
	/** True while a plain resume left the source's sample rate unverified (adoption may apply). */
	isSampleRateUnverified(sourceId: string): boolean {
		return this.unverifiedFields.get(sourceId)?.has("sampleRate") === true
	}

	adoptObservedSampleRate(sourceId: string, measuredHz: number): boolean {
		const state = this.tunerStates.get(sourceId)
		if (!state || !this.isSampleRateUnverified(sourceId)) return false
		const matches = COMMON_RTL_SAMPLE_RATES.filter(
			rate => Math.abs(measuredHz / rate - 1) <= RESUME_RATE_MATCH,
		)
		const rate = matches.length === 1 ? matches[0] : undefined
		if (rate === undefined || !isValidRtlSampleRate(rate)) return false
		this.measuredRates.set(sourceId, rate)
		// Retried on every measurement update (tuner-wiring): an adopted rate is no news.
		if (
			state.sampleRate === rate &&
			this.sourceManager.getCaps(sourceId)?.sampleRate === rate
		)
			return false
		state.sampleRate = rate
		try {
			this.sourceManager.updateSourceCaps(sourceId, { sampleRate: rate })
		} catch (err) {
			this.log.warn(
				{ sourceId, err: safeErrorFields(err) },
				"Adopting the measured sample rate failed",
			)
		}
		this.log.info(
			{ sourceId, sampleRate: rate },
			"Adopted the measured sample rate after a plain resume",
		)
		this.emitStateChanged(sourceId)
		return true
	}

	/**
	 * Align source caps with what the tuner state backs: accepted values for
	 * commanded fields, otherwise the configured baseline. One caps-changed at
	 * most, and none when metadata already matches (no decoder restart storm).
	 * An unverified centre or rate (plain resume) keeps its last known value: the receiver may
	 * be anywhere, and the baseline is no better a guess than where it was.
	 */
	private reconcileCaps(sourceId: string, state: TunerState): boolean {
		const accepted = this.desiredFields.get(sourceId)
		const unverified = this.unverifiedFields.get(sourceId)
		const inferred = this.inferredFields.get(sourceId)
		// A written centre or rate (accepted, asserted, or a scanner hop's) is what caps show; an
		// unverified one keeps its last known value.
		const desired = {
			has: (field: "frequency" | "sampleRate") =>
				accepted?.has(field) === true ||
				unverified?.has(field) === true ||
				inferred?.has(field) === true ||
				this.acceptedTuning.get(sourceId)?.[field] !== undefined,
		}
		const baseline = this.baselineCaps.get(sourceId)
		const current = this.sourceManager.getCaps(sourceId)
		if (!current) return false

		const sampleRate = desired.has("sampleRate")
			? state.sampleRate
			: (baseline?.sampleRate ?? current.sampleRate)
		const centerFreq = desired.has("frequency")
			? state.frequency
			: baseline
				? baseline.centerFreq
				: current.centerFreq
		if (current.sampleRate === sampleRate && current.centerFreq === centerFreq)
			return false

		this.log.warn(
			{
				sourceId,
				staleSampleRate: current.sampleRate,
				staleCenterFreq: current.centerFreq,
				sampleRate,
				centerFreq,
			},
			"Reconciling source tuning metadata after reconnect",
		)
		try {
			this.withCentreOrigin(sourceId, "other", () =>
				this.sourceManager.setTuningCaps(sourceId, { sampleRate, centerFreq }),
			)
		} catch (err) {
			this.log.warn({ sourceId, err }, "Failed to reconcile source caps")
			return false
		}
		return true
	}

	/**
	 * WG11 req 4.2-4.5: writes the configured frames of a new connection, in order
	 * gain mode, gain, AGC, skipping each field the operator holds (accepted or
	 * observed in this process; a gain is also skipped when the gain mode is held,
	 * since an rtl_tcp gain write switches the tuner to manual). Internal control
	 * only. The written fields are known (and state shows the configured values)
	 * only when every frame of the set was written; a failure claims none, warns,
	 * sets lastError and is retried on the next connection. Emits `command-sent`
	 * with origin `config`. `attempted` is false when nothing was tried.
	 */
	private writeConfiguredTuning(
		sourceId: string,
		state: TunerState,
	): { attempted: boolean; commands: string[]; error?: string } {
		const configured = this.configuredTuning.get(sourceId)
		if (
			!configured ||
			state.controlMode !== "internal" ||
			this.plainResumeHold.has(sourceId)
		)
			return { attempted: false, commands: [] }
		const held = (field: TunerStateField) =>
			this.isOperatorHeld(sourceId, field)
		// A held tuner gain index is replayed after the configured frames and sets
		// the tuner gain itself: a configured gain or gain mode would be claimed
		// (and proven) but overridden.
		const indexHeld =
			this.desiredFields.get(sourceId)?.has("tunerGainIndex") === true
		const frames = configured.frames.filter(([cmd]) => {
			if (cmd === RTL_TCP_COMMANDS.SET_GAIN)
				return !held("gain") && !held("gainMode") && !indexHeld
			// A held gain is replayed as SET_GAIN, which switches the tuner to
			// manual: a configured gain mode would be claimed but overridden.
			if (cmd === RTL_TCP_COMMANDS.SET_GAIN_MODE)
				return !held("gainMode") && !held("gain") && !indexHeld
			const field = stateFieldOf(cmd)
			return field !== undefined && !held(field)
		})
		if (frames.length === 0) return { attempted: false, commands: [] }

		const written: Array<{ cmd: number; value: number; name: string }> = []
		let failure: Error | undefined
		for (const [cmd, value] of frames) {
			try {
				this.writeFrame(sourceId, cmd, value)
			} catch (err) {
				failure =
					err instanceof Error
						? err
						: new WaveKitError(String(err), "TUNER_RESTORE_FAILED")
				break
			}
			written.push({
				cmd,
				value,
				name: COMMAND_NAMES[cmd] ?? `cmd-0x${cmd.toString(16)}`,
			})
		}
		const commands = written.map(entry => entry.name)
		if (written.length > 0) {
			state.commandCount += written.length
			state.lastCommandAt = new Date().toISOString()
		}

		if (failure) {
			state.lastError = `Tuner state restore failed: ${failure.message}`
			this.log.warn(
				{ sourceId, commands, err: failure.message },
				"Tuner state restore interrupted; will retry on next connection",
			)
		} else {
			const proven = new Set<TunerStateField>()
			for (const { cmd, value } of written) {
				if (cmd === RTL_TCP_COMMANDS.SET_GAIN_MODE) {
					state.gainMode = value === 1 ? "manual" : "agc"
					proven.add("gainMode")
				} else if (cmd === RTL_TCP_COMMANDS.SET_GAIN) {
					state.gain = value
					proven.add("gain")
				} else if (cmd === RTL_TCP_COMMANDS.SET_AGC_MODE) {
					state.agcMode = value !== 0
					proven.add("agcMode")
				}
			}
			this.configProvenFields.set(sourceId, proven)
			for (const field of proven) this.clearIgnoredRelayField(sourceId, field)
			delete state.lastError
			this.log.info(
				{ sourceId, commands },
				"Wrote configured tuner gain on connect",
			)
		}

		for (const { name, value } of written) {
			this.noteReconnectFrame(sourceId, name, value, "config")
			this.emit("command-sent", sourceId, name, value, "config")
		}
		if (failure) {
			this.emit("error", sourceId, failure)
			return {
				attempted: true,
				commands,
				error: state.lastError ?? failure.message,
			}
		}
		return { attempted: true, commands }
	}

	/** A gain field accepted (REST or relay) or observed (inferred) in this process. */
	private isOperatorHeld(sourceId: string, field: TunerStateField): boolean {
		const desired: ReadonlyMap<string, number> | undefined =
			this.desiredFields.get(sourceId)
		return (
			desired?.has(field) === true ||
			this.inferredFields.get(sourceId)?.has(field) === true
		)
	}

	/** gainMode, gain and agcMode of the baseline: configured, else the built-in. */
	private gainBaseline(sourceId: string): {
		gainMode: TunerGainMode
		gain: number
		agcMode: boolean
	} {
		const tuner = this.configuredTuning.get(sourceId)?.tuner
		if (!tuner) return { gainMode: "agc", gain: 0, agcMode: true }
		return {
			gainMode: tuner.gainMode,
			gain:
				tuner.gainMode === "manual" && tuner.gainDb !== undefined
					? Math.round(tuner.gainDb * 10)
					: 0,
			agcMode: tuner.agcMode ?? true,
		}
	}

	// === State Accessors ===

	/**
	 * WG9 req 3.2: true only when the tuning ledger's live session holds a frame of both frequency
	 * and sample rate that no doubt has undone (settled, settling or waiting to leave), whoever
	 * wrote it. A caps change with no such frame is `unverified`.
	 */
	tuningWrittenOnConnection(sourceId: string): boolean {
		if (!this.tunerStates.has(sourceId)) return false
		const fields = this.ledgerFields(sourceId)
		return GATED_FIELDS.every(field => {
			const fs = fields[field]
			return fs.queued !== null || fs.state !== "unverified"
		})
	}

	getState(sourceId: string): TunerState | undefined {
		const state = this.tunerStates.get(sourceId)
		return state ? this.cloneState(state) : undefined
	}

	getAllStates(): TunerState[] {
		return Array.from(this.tunerStates.values()).map(state =>
			this.cloneState(state),
		)
	}

	getRtlTcpSourceIds(): string[] {
		return Array.from(this.tunerStates.keys())
	}

	// === Private Helpers ===

	private hasCommandUpdates(updates: Partial<TunerState>): boolean {
		return (
			updates.frequency !== undefined ||
			updates.sampleRate !== undefined ||
			updates.gainMode !== undefined ||
			updates.gain !== undefined ||
			updates.ppm !== undefined ||
			updates.ifGain !== undefined ||
			updates.testMode !== undefined ||
			updates.agcMode !== undefined ||
			updates.biasTee !== undefined ||
			updates.directSampling !== undefined ||
			updates.offsetTuning !== undefined ||
			updates.rtlXtal !== undefined ||
			updates.tunerXtal !== undefined ||
			updates.tunerGainIndex !== undefined ||
			updates.tunerIfGain !== undefined
		)
	}

	private validateSource(sourceId: string): TunerState {
		const state = this.tunerStates.get(sourceId)
		if (!state) {
			throw new TunerSourceNotFoundError(sourceId)
		}
		return state
	}

	private validateSourceForControl(sourceId: string): TunerState {
		const state = this.validateSource(sourceId)
		if (state.controlMode === "external") {
			throw new TunerControlModeError(sourceId)
		}
		return state
	}

	/** The setters' own value checks, for a bulk update before its first write. */
	private validateUpdates(updates: Partial<TunerState>): void {
		if (updates.frequency !== undefined)
			this.validateRange("frequency", updates.frequency, VALIDATION.frequency)
		if (updates.sampleRate !== undefined) {
			this.validateRange(
				"sampleRate",
				updates.sampleRate,
				VALIDATION.sampleRate,
			)
			if (!isValidRtlSampleRate(updates.sampleRate))
				throw new TunerValidationError(
					`sampleRate ${updates.sampleRate} is not supported by RTL-SDR (expected 225001-300000 or 900001-3200000)`,
					"sampleRate",
				)
		}
		if (updates.gain !== undefined)
			this.validateRange("gain", updates.gain, VALIDATION.gain)
		if (updates.ppm !== undefined)
			this.validateRange("ppm", updates.ppm, VALIDATION.ppm)
		if (updates.ifGain !== undefined)
			this.validateUint32("ifGain", updates.ifGain)
		if (updates.rtlXtal !== undefined)
			this.validateUint32("rtlXtal", updates.rtlXtal)
		if (updates.tunerXtal !== undefined)
			this.validateUint32("tunerXtal", updates.tunerXtal)
		if (updates.tunerGainIndex !== undefined)
			this.validateUint32("tunerGainIndex", updates.tunerGainIndex)
		if (updates.tunerIfGain !== undefined && updates.tunerIfGain !== null) {
			this.validateUint16("tunerIfGain.stage", updates.tunerIfGain.stage)
			this.validateUint16("tunerIfGain.gain", updates.tunerIfGain.gain)
		}
	}

	private validateRange(
		name: string,
		value: number,
		range: { min: number; max: number },
	): void {
		this.validateInteger(name, value)
		if (value < range.min || value > range.max) {
			throw new TunerValidationError(
				`${name} out of range: ${value} (expected ${range.min}-${range.max})`,
				name,
			)
		}
	}

	private isWithinRange(
		value: number,
		range: { min: number; max: number },
	): boolean {
		return (
			Number.isFinite(value) &&
			Number.isInteger(value) &&
			value >= range.min &&
			value <= range.max
		)
	}

	private validateInteger(name: string, value: number): void {
		if (!Number.isFinite(value) || !Number.isInteger(value)) {
			throw new TunerValidationError(`${name} must be an integer`, name)
		}
	}

	private validateUint32(name: string, value: number): void {
		this.validateRange(name, value, VALIDATION.uint32)
	}

	private validateUint16(name: string, value: number): void {
		this.validateRange(name, value, VALIDATION.uint16)
	}

	private encodeSignedInt32(value: number): number {
		if (!Number.isFinite(value)) {
			throw new TunerValidationError("ppm must be a finite number", "ppm")
		}
		return value < 0 ? 0xffffffff + value + 1 : value
	}

	private decodeSignedInt32(value: number): number {
		return value > 0x7fffffff ? value - 0x100000000 : value
	}

	/** Reset tunable fields to the startup baseline (control mode/counters kept). */
	private applyBaselineFields(state: TunerState, caps?: SourceCaps): void {
		state.frequency =
			this.config.defaultFrequency ?? caps?.centerFreq ?? DEFAULT_FREQUENCY
		state.sampleRate =
			this.config.defaultSampleRate ?? caps?.sampleRate ?? DEFAULT_SAMPLE_RATE
		const gain = this.gainBaseline(state.sourceId)
		state.gainMode = gain.gainMode
		state.gain = gain.gain
		state.ppm = 0
		state.agcMode = gain.agcMode
		state.biasTee = false
		state.directSampling = "off"
		state.offsetTuning = false
		state.ifGain = 0
		state.tunerIfGain = null
		state.testMode = false
		delete state.rtlXtal
		delete state.tunerXtal
		delete state.tunerGainIndex
	}

	private markIgnoredRelayField(
		sourceId: string,
		field: TunerStateField,
	): void {
		let ignored = this.ignoredRelayFields.get(sourceId)
		if (!ignored) {
			ignored = new Set()
			this.ignoredRelayFields.set(sourceId, ignored)
		}
		ignored.add(field)
	}

	/** A value was written, accepted or inferred: the field is no longer in doubt. */
	private clearIgnoredRelayField(
		sourceId: string,
		field: TunerStateField,
	): void {
		this.ignoredRelayFields.get(sourceId)?.delete(field)
		this.unverifiedFields.get(sourceId)?.delete(field)
	}

	private markInferred(sourceId: string, field: TunerStateField): void {
		this.clearIgnoredRelayField(sourceId, field)
		let inferred = this.inferredFields.get(sourceId)
		if (!inferred) {
			inferred = new Set()
			this.inferredFields.set(sourceId, inferred)
		}
		inferred.add(field)
	}

	/**
	 * An operator tune's gain mode or gain already in place, proven and not accepted: no frame was
	 * sent. While its partner (gain for the mode, the mode for the gain) is not accepted either, the
	 * next connection's configured frames write the pair, as before the tune: nothing to do. Once the
	 * partner is accepted the configured pair is skipped, so the value the tune asked for would come
	 * back unknown after a reconnect (a rate change's: TUNER_TUNE_PARTIAL). It is accepted then,
	 * placed beside the partner in the replay order the writes keep: a manual mode before its gain,
	 * a gain before AGC. Every other accepted field keeps its place.
	 */
	private acceptBesideHeld(
		sourceId: string,
		fields: ReadonlyArray<"gainMode" | "gain">,
	): void {
		const desired = this.desiredFields.get(sourceId)
		const state = this.tunerStates.get(sourceId)
		if (!desired || !state) return
		for (const field of fields) {
			// A held tuner gain index also skips the configured pair, so it partners the mode too.
			const partner =
				field === "gain"
					? "gainMode"
					: desired.has("gain")
						? "gain"
						: "tunerGainIndex"
			const partnerSeq = desired.get(partner)
			if (partnerSeq === undefined || desired.has(field)) continue
			this.sourceManager.assertTunerCommandActive()
			const modeFirst = state.gainMode === "manual"
			// Manual: the mode goes before its gain or gain index. AGC: after them, since either one
			// written after AGC selects manual on the receiver.
			const before = (field === "gainMode") === modeFirst
			// Strictly between the partner and its neighbour on that side, so no other field moves;
			// never past the newest sequence, which a pause marker compares with.
			let neighbour = before ? partnerSeq - 1 : Number.POSITIVE_INFINITY
			for (const seq of desired.values()) {
				if (before && seq < partnerSeq && seq > neighbour) neighbour = seq
				if (!before && seq > partnerSeq && seq < neighbour) neighbour = seq
			}
			this.clearIgnoredRelayField(sourceId, field)
			desired.set(
				field,
				neighbour === Number.POSITIVE_INFINITY
					? ++this.acceptanceSeq
					: (partnerSeq + neighbour) / 2,
			)
		}
	}

	/**
	 * A centre or rate the skip rule did not write (the live session proves it, or a frame of it
	 * is settling or queued) is accepted as a written one would be (sendCommand): an operator
	 * naming the value a scanner hop left in place makes it the held value assert writes back.
	 * `accept: false` (a scanner hop) accepts nothing.
	 */
	private acceptSkipped(
		sourceId: string,
		field: GatedField,
		value: number,
		opts: TunerWriteOptions,
	): void {
		if (opts.accept === false) return
		this.sourceManager.assertTunerCommandActive()
		this.markAccepted(
			sourceId,
			field === "frequency"
				? RTL_TCP_COMMANDS.SET_FREQUENCY
				: RTL_TCP_COMMANDS.SET_SAMPLE_RATE,
			value,
		)
		this.emitStateChanged(sourceId)
	}

	private markAccepted(sourceId: string, cmd: number, value: number): void {
		const field = COMMAND_FIELDS[cmd]
		if (!field) return
		if (field === "frequency" || field === "sampleRate") {
			const held = this.acceptedTuning.get(sourceId) ?? {}
			held[field] = value
			this.acceptedTuning.set(sourceId, held)
		}
		const stateField = stateFieldOf(cmd)
		if (stateField !== undefined)
			this.clearIgnoredRelayField(sourceId, stateField)
		let desired = this.desiredFields.get(sourceId)
		if (!desired) {
			desired = new Map()
			this.desiredFields.set(sourceId, desired)
		}
		desired.set(field, ++this.acceptanceSeq)
	}

	/**
	 * A written but not accepted value (`accept: false`, every test-mode write, a
	 * relay TEST_MODE) is known: the state shows it. It is not a desired field.
	 */
	private markWrittenNotAccepted(sourceId: string, cmd: number): void {
		const field = stateFieldOf(cmd)
		if (field !== undefined) this.markInferred(sourceId, field)
	}

	/**
	 * The replay of accepted fields in REPLAY_PHASES order. `withoutTuning`: centre and rate left
	 * out (assert writes them), the frames split where they would have gone: `before` (sampling
	 * path, crystals, ppm) and `after` (front end, gain).
	 */
	private buildReplayPlan(
		state: TunerState,
		desired: ReadonlyMap<DesiredField, number>,
		withoutTuning = false,
	): { before: Array<[number, number]>; after: Array<[number, number]> } {
		const before: Array<[number, number]> = []
		const after: Array<[number, number]> = []
		let plan = before
		for (const phase of REPLAY_PHASES) {
			const tuning = phase.fields.includes("frequency")
			if (tuning && withoutTuning) {
				plan = after
				continue
			}
			const fields = phase.fields.filter(field => desired.has(field))
			if (phase.byAcceptance) {
				fields.sort((a, b) => (desired.get(a) ?? 0) - (desired.get(b) ?? 0))
			}
			for (const field of fields) {
				const frame = this.encodeDesiredField(state, field)
				if (frame) plan.push(frame)
			}
		}
		return { before, after }
	}

	private encodeDesiredField(
		state: TunerState,
		field: DesiredField,
	): [number, number] | null {
		const flag = (enabled: boolean) => (enabled ? 1 : 0)
		switch (field) {
			case "frequency":
				return [RTL_TCP_COMMANDS.SET_FREQUENCY, state.frequency]
			case "sampleRate":
				return [RTL_TCP_COMMANDS.SET_SAMPLE_RATE, state.sampleRate]
			case "gainMode":
				return [
					RTL_TCP_COMMANDS.SET_GAIN_MODE,
					flag(state.gainMode === "manual"),
				]
			case "gain":
				return [RTL_TCP_COMMANDS.SET_GAIN, state.gain]
			case "ppm":
				return [
					RTL_TCP_COMMANDS.SET_FREQ_CORRECTION,
					this.encodeSignedInt32(state.ppm),
				]
			case "ifGain":
				return [RTL_TCP_COMMANDS.SET_IF_GAIN, state.ifGain]
			case "agcMode":
				return [RTL_TCP_COMMANDS.SET_AGC_MODE, flag(state.agcMode)]
			case "directSampling":
				return [
					RTL_TCP_COMMANDS.SET_DIRECT_SAMPLING,
					state.directSampling === "off"
						? 0
						: state.directSampling === "i"
							? 1
							: 2,
				]
			case "offsetTuning":
				return [RTL_TCP_COMMANDS.SET_OFFSET_TUNING, flag(state.offsetTuning)]
			case "biasTee":
				return [RTL_TCP_COMMANDS.SET_BIAS_TEE, flag(state.biasTee)]
			case "rtlXtal":
				return state.rtlXtal === undefined
					? null
					: [RTL_TCP_COMMANDS.SET_RTL_XTAL, state.rtlXtal]
			case "tunerXtal":
				return state.tunerXtal === undefined
					? null
					: [RTL_TCP_COMMANDS.SET_TUNER_XTAL, state.tunerXtal]
			case "tunerGainIndex":
				return state.tunerGainIndex === undefined
					? null
					: [RTL_TCP_COMMANDS.SET_TUNER_GAIN_INDEX, state.tunerGainIndex]
			case "tunerIfGain":
				return state.tunerIfGain === null
					? null
					: [
							RTL_TCP_COMMANDS.SET_TUNER_IF_GAIN,
							(state.tunerIfGain.stage << 16) |
								(state.tunerIfGain.gain & 0xffff),
						]
		}
	}

	private encodeFrame(cmd: number, value: number): Buffer {
		const buf = Buffer.alloc(5)
		buf.writeUInt8(cmd, 0)
		buf.writeUInt32BE(value >>> 0, 1)
		return buf
	}

	/** The count `field` will show once a frame about to go out has gone. */
	private nextFieldWrite(sourceId: string, field: TunerStateField): number {
		return (this.fieldWrites.get(sourceId)?.get(field) ?? 0) + 1
	}

	private noteFieldWrite(
		sourceId: string,
		field: TunerStateField | undefined,
	): void {
		if (field === undefined) return
		let fields = this.fieldWrites.get(sourceId)
		if (!fields) {
			fields = new Map()
			this.fieldWrites.set(sourceId, fields)
		}
		fields.set(field, (fields.get(field) ?? 0) + 1)
	}

	/**
	 * A newer frame of `field` went out while this setter waited for its own, from a listener or
	 * another writer's turn. That write owns the state and the reconnect replay, and this setter
	 * publishes nothing. Checked in the same synchronous section as the publish, so no write can
	 * land between them.
	 */
	private supersededWrite(
		sourceId: string,
		field: TunerStateField,
		mine: number,
	): boolean {
		return (this.fieldWrites.get(sourceId)?.get(field) ?? 0) !== mine
	}

	/**
	 * Every frame this controller writes passes here. `writer` tags the tuning-ledger receipt:
	 * the controller's own writes (API, replay, configured tuning) are the operator's; a scanner
	 * hop's are the scanner's (writerOf). `onReceipt` hears the frame's receipt at flush.
	 */
	private writeFrame(
		sourceId: string,
		cmd: number,
		value: number,
		writer: TuningWriterTag = OPERATOR_WRITER,
		onReceipt?: ReceiptCallback,
	): void {
		this.assertOwnsTuner()
		// Inside a multi-frame call: this frame's receipt joins the call's one (withReceiptOnce).
		const scope = onReceipt ? this.receiptScopes.get(onReceipt) : undefined
		const frameReceipt = scope ? scope.frame() : onReceipt
		try {
			this.sourceManager.writeToSource(
				sourceId,
				this.encodeFrame(cmd, value),
				writer,
				frameReceipt,
			)
		} catch (err) {
			// writeToSource calls no callback when it throws: this frame has no receipt.
			if (scope) frameReceipt?.(null)
			throw err
		}
		this.standInFrame(sourceId, cmd, value, writer)
	}

	private assertOwnsTuner(): void {
		if (this.config.lostOwnership?.() === true)
			throw new TunerControllerError(
				"This core no longer owns its state, so it writes nothing to the tuner",
				"ACCESS_UNAVAILABLE",
				503,
			)
	}

	private async sendCommand(
		sourceId: string,
		cmd: number,
		value: number,
		opts: TunerWriteOptions = {},
	): Promise<void> {
		this.sourceManager.assertTunerCommandActive()
		// Not a failed write: no error event and no lastError for a refusal by design.
		this.assertOwnsTuner()
		const hookTune =
			opts.origin === "decoder-rate"
				? this.retuneHookTune.getStore()
				: undefined
		;(opts.beforeWrite ?? hookTune?.beforeWrite)?.()
		try {
			this.writeFrame(sourceId, cmd, value, writerOf(opts), opts.onReceipt)
			this.noteFieldWrite(sourceId, stateFieldOf(cmd))
			// In the same step as the frame: no other write can see the old mode in between.
			this.noteLeftAgc(sourceId, cmd, value)
			if (opts.accept === false) this.markWrittenNotAccepted(sourceId, cmd)
			else this.markAccepted(sourceId, cmd, value)
			const state = this.tunerStates.get(sourceId)
			if (state) {
				state.commandCount++
				state.lastCommandAt = new Date().toISOString()
				delete state.lastError
			}
			const cmdName = COMMAND_NAMES[cmd] ?? `cmd-0x${cmd.toString(16)}`
			// A scanner settle marker (test mode on and off) moves nothing.
			if (
				!(cmd === RTL_TCP_COMMANDS.SET_TEST_MODE && opts.origin === "scanner")
			)
				this.noteChange(
					sourceId,
					cmdName,
					value,
					changeOf(opts),
					opts.run ?? hookTune?.run,
				)
			this.emit("command-sent", sourceId, cmdName, value, opts.origin)
			this.log.debug(
				{ sourceId, command: cmdName, value, origin: opts.origin },
				"Command sent",
			)
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err)
			const state = this.tunerStates.get(sourceId)
			if (state) {
				state.lastError = message
			}
			this.log.error({ sourceId, err: message }, "Failed to send tuner command")
			this.emit(
				"error",
				sourceId,
				err instanceof Error ? err : new Error(message),
			)
			this.emitStateChanged(sourceId)
			throw err
		}
	}

	/**
	 * A frame a reconnect wrote. The same value as that command's last frame moves nothing: who
	 * last moved the tuner stays who moved it. Only another value is a change.
	 */
	private noteReconnectFrame(
		sourceId: string,
		commandName: string,
		value: number,
		origin: "replay" | "config",
		shown?: number,
	): void {
		// As framed: a relay's negative value arrives as its unsigned 32 bits.
		const last = this.frameValues.get(sourceId)?.get(commandName)
		if (last === value >>> 0) return
		// The first frame of a command writing the value the state already showed (assert's
		// declared centre or rate) moves nothing either.
		if (last === undefined && shown === value) return
		this.noteChange(sourceId, commandName, value, changeOf({ origin }))
	}

	/**
	 * Remembers a change for `lastChange`. One entry per known source, and `fields` holds each of
	 * the closed fields at most once, so this memory is bounded by the sources. A command with no
	 * field (an unhandled relay command) is no change. The writes of one tune merge however long
	 * they take: a rate change's recovery can part them by seconds.
	 */
	private noteChange(
		sourceId: string,
		commandName: string,
		value: number,
		change: ReturnType<typeof changeOf>,
		run?: TuneWriteRun,
	): void {
		const field = CHANGE_FIELDS.get(commandName)
		if (field === undefined || !this.tunerStates.has(sourceId)) return
		let values = this.frameValues.get(sourceId)
		if (values === undefined) {
			values = new Map()
			this.frameValues.set(sourceId, values)
		}
		values.set(commandName, value >>> 0)
		const now = Date.now()
		const last = this.lastChanges.get(sourceId)
		const extending =
			last !== undefined &&
			last.actor === change.actor &&
			last.reason === change.reason &&
			last.jobId === change.jobId &&
			(now - Date.parse(last.at) < TUNER_CHANGE_MERGE_MS ||
				(run !== undefined && this.lastChangeRuns.get(sourceId) === run))
		const fields = extending ? last.fields : []
		const next: TunerLastChange = {
			...change,
			at: new Date(now).toISOString(),
			fields: fields.includes(field) ? fields : [...fields, field],
		}
		this.lastChanges.set(sourceId, next)
		if (run !== undefined) this.lastChangeRuns.set(sourceId, run)
		else this.lastChangeRuns.delete(sourceId)
		this.emit("last-change", sourceId, next, run)
	}

	private emitStateChanged(sourceId: string): void {
		const state = this.tunerStates.get(sourceId)
		if (!state) return
		this.emit("state-changed", sourceId, this.cloneState(state))
	}

	private cloneState(state: TunerState): TunerState {
		const {
			unknownFields: _stale,
			declaredOnlyFields: _staleDeclared,
			measuredFields: _staleMeasured,
			proof: _staleProof,
			...fields
		} = state
		const { unknownFields, declaredOnlyFields } = this.fieldProof(
			state.sourceId,
		)
		const ratePolicy = this.ratePolicyRecordFor?.(state.sourceId)
		const bandGain = this.confirmedBandGain(state, unknownFields)
		const measured =
			unknownFields.includes("sampleRate") &&
			this.measuredRates.get(state.sourceId) === state.sampleRate
		const lastChange = this.lastChanges.get(state.sourceId)
		const proof = this.proofOf(state)
		return {
			...fields,
			...this.tuneStatus?.(state.sourceId),
			...(lastChange
				? { lastChange: { ...lastChange, fields: [...lastChange.fields] } }
				: {}),
			...(ratePolicy ? { ratePolicy } : {}),
			tunerIfGain: state.tunerIfGain
				? { ...state.tunerIfGain }
				: state.tunerIfGain,
			...(unknownFields.length > 0 ? { unknownFields } : {}),
			...(declaredOnlyFields.length > 0 ? { declaredOnlyFields } : {}),
			...(measured ? { measuredFields: ["sampleRate" as const] } : {}),
			...(bandGain ? { bandGain } : {}),
			...(proof ? { proof } : {}),
		}
	}

	/**
	 * `unknownFields`: fields backed by nothing: not commanded through the API, not
	 * seen in a relay client's command (both tracked as accepted desired fields), and
	 * for frequency/sampleRate not declared by config or the source caps; plus a
	 * frequency/sampleRate whose last relay value was ignored (WG5).
	 * `declaredOnlyFields` (WG5): frequency/sampleRate known only from that declared
	 * baseline, never written by WaveKit or seen from a relay client since the start or
	 * the last reset reconnect, so the receiver may be elsewhere.
	 */
	private fieldProof(sourceId: string): {
		unknownFields: TunerStateField[]
		declaredOnlyFields: TunerStateField[]
	} {
		const accepted: ReadonlyMap<string, number> | undefined =
			this.desiredFields.get(sourceId)
		const inferred = this.inferredFields.get(sourceId)
		const ignored = this.ignoredRelayFields.get(sourceId)
		const unverified = this.unverifiedFields.get(sourceId)
		const baseline = this.baselineCaps.get(sourceId)
		const declared = new Set<TunerStateField>()
		if (
			this.config.defaultFrequency !== undefined ||
			baseline?.centerFreq !== undefined
		)
			declared.add("frequency")
		if (
			this.config.defaultSampleRate !== undefined ||
			baseline?.sampleRate !== undefined
		)
			declared.add("sampleRate")
		const configWritten = this.configProvenFields.get(sourceId)
		const proven = (field: TunerStateField): boolean =>
			accepted?.has(field) === true ||
			inferred?.has(field) === true ||
			configWritten?.has(field) === true
		// Centre and rate say where the shown value comes from, as for every field: known when a
		// frame of it stands on the live connection (the tuning ledger: proven, settling or
		// waiting to leave) or it was accepted or written; declared-only when only the declared
		// baseline backs it; unknown when it is a placeholder. Whether the live connection proves
		// it is `proof` and tuningWrittenOnConnection (the ledger), not these lists.
		const state = this.tunerStates.get(sourceId)
		const live = state ? this.ledger().position(sourceId) !== null : false
		const fields = state && live ? this.ledgerFields(sourceId) : null
		const gated = (
			field: TunerStateField,
		): "known" | "declared" | "unknown" => {
			if (field !== "frequency" && field !== "sampleRate") return "known"
			if (ignored?.has(field) === true || unverified?.has(field) === true)
				return "unknown"
			const fs = fields?.[field]
			if (fs && (fs.queued !== null || fs.state !== "unverified"))
				return "known"
			if (proven(field)) return "known"
			return declared.has(field) ? "declared" : "unknown"
		}
		return {
			unknownFields: STATE_FIELDS.filter(field =>
				field === "frequency" || field === "sampleRate"
					? gated(field) === "unknown"
					: ignored?.has(field) === true ||
						unverified?.has(field) === true ||
						(!declared.has(field) && !proven(field)),
			),
			declaredOnlyFields: STATE_FIELDS.filter(field =>
				field === "frequency" || field === "sampleRate"
					? gated(field) === "declared"
					: declared.has(field) &&
						!proven(field) &&
						ignored?.has(field) !== true &&
						unverified?.has(field) !== true,
			),
		}
	}

	/** Declared only or unknown: a value equal to it is still written. */
	private isUnproven(sourceId: string, field: TunerStateField): boolean {
		const proof = this.fieldProof(sourceId)
		return (
			proof.unknownFields.includes(field) ||
			proof.declaredOnlyFields.includes(field)
		)
	}

	private isSameTunerIfGain(
		left: TunerState["tunerIfGain"],
		right: TunerState["tunerIfGain"],
	): boolean {
		if (left === right) return true
		if (!left || !right) return false
		return left.stage === right.stage && left.gain === right.gain
	}
}

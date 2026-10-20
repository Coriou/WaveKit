/**
 * Scanner-owned ephemeral decoders that confirm tracks (spec § 6.5).
 * Admission (max probes per transport, CPU budget, host CPU guard), the
 * offset transport with IQ pre-roll, epoch binding (H5, P17), mode
 * stepping per the § 6.4 map, recordings and start latency. A probe reads
 * one engine stream: a `"stream"` event of its source ends it (sample indices
 * restart there).
 */
import { EventEmitter } from "node:events"
import { mkdir } from "node:fs/promises"
import { join } from "node:path"
import { PassThrough, type Readable } from "node:stream"
import { z } from "zod"
import {
	PROBE_UNAVAILABLE_MEMO_MS,
	type ScannerProbeDecoderType,
} from "@wavekit/api-types"
import type { DsdFmeLinkLine } from "../../../decoders/builtin/dsd-fme-link.js"
import type { DecoderManager } from "../../../decoders/manager.js"
import type { DecoderConfig } from "../../../decoders/types.js"
import { WaveKitError } from "../../../utils/errors.js"
import { createComponentLogger, type Logger } from "../../../utils/logger.js"
import type {
	DigitalVoiceService,
	VoiceCallSource,
} from "../../digital-voice.js"
import { probeId as buildProbeId, shortId } from "../ids.js"
import { IQ_CAPTURE_RATE_HZ } from "../iq-capture-contract.js"
import { CPU_COST, probeCores } from "../plan/cost.js"
import { bytesPerSample } from "../../spectrum/frame-source.js"
import { ConstructorListenerRegistration } from "../channel/consumer-lifecycle.js"
import {
	USABLE_FRACTION,
	type EngineEpoch,
	type EngineStreamReason,
	type SpectrumEngine,
	type SpectrumEngineEvents,
} from "../../spectrum/spectrum-engine.js"
import type {
	DecodeEvidence,
	ScannerClass,
	ScannerProtocol,
	ScannerSettings,
} from "../types.js"
import {
	createInterpreterState,
	type DecoderOutputLike,
	type InterpreterState,
} from "./confirm/double-match.js"
import { interpretDirewolf } from "./confirm/direwolf.js"
import {
	interpretDsdFme,
	toDsdFmeScannerEvent,
	type DsdFmeScannerEvent,
} from "./confirm/dsd-fme.js"
import { interpretMultimon } from "./confirm/multimon.js"
import { interpretRtl433 } from "./confirm/rtl433.js"

/** WG11 req 6.5: `replay` feeds the decoder an IQ capture (lane IQ). */
export type ProbeTransport = "offset" | "channel" | "replay"
export type ProbeState = "starting" | "confirming" | "following" | "stopping"
export type ProbeDecoderType = "dsd-fme" | "multimon-ng" | "direwolf" | "rtl433"

export interface ProbeRequest {
	jobId: string
	priority: number
	sourceId: string
	trackId: string
	observationId: string
	discoveryId: string | null
	targetHz: number
	epoch: number
	cls: ScannerClass
	protocols: ScannerProtocol[]
	preRollFromSample: number | null
	holdMs: number
	record: boolean
	admission: {
		kind: "protocol-target" | "undecoded" | "reconfirm"
		snrDb: number
	}
	/** Identify (Task 35a): run exactly these modes instead of probeModesFor(cls, protocols). */
	modes?: ProbeMode[]
	/**
	 * WG11 req 6.5: feed the decoder this IQ capture (replay transport) instead of the live stream. Such a
	 * request is epoch-independent: its evidence carries `epoch`, the capture's own.
	 */
	replay?: { captureId: string }
}

/** WG11 req 6.4: queue-driven replay probes run just below identify and above every job's passive probes. */
export const REPLAY_PROBE_PRIORITY = 100
/** Settling time after a replay decoder exited cleanly, so its last output lines still count. */
export const REPLAY_END_GRACE_MS = 250
/**
 * Safety: replay evidence held per probe until its clean end. A DMR capture of at most 4 s
 * carries a few dozen decode lines at most (one per 60 ms superframe is 67 in 4 s; H2 needs 2), so
 * 64 bounds a genuine replay; one more ends the probe cancelled (no verdict, no miss). Held entries
 * are small evidence objects: 64 per probe, IQ_REPLAY_MAX_PROBES = 1 at a time.
 */
export const REPLAY_HELD_EVIDENCE_MAX = 64

export interface ProbeMode {
	decoderType: ProbeDecoderType
	protocol: ScannerProtocol
	covers: ScannerProtocol[]
	options: Record<string, unknown>
	holdMs: number
}

/** `on`/`off` carry the engine's `"stream"` event: ring sample indices restart at each stream. */
export type ProbeEngineView = Pick<
	SpectrumEngine,
	"sourceId" | "format" | "currentEpoch" | "liveEdge" | "readRing" | "tap"
> & {
	on(event: "stream", listener: SpectrumEngineEvents["stream"]): unknown
	off(event: "stream", listener: SpectrumEngineEvents["stream"]): unknown
}

export interface TransportContext {
	req: ProbeRequest
	epoch: EngineEpoch
	format: string
	sampleRateHz: number
}

export interface TransportStrategy {
	readonly kind: ProbeTransport
	/** Feed the decoder a scanner input: IQ ring pre-roll, then the live tap. */
	readonly preRoll: boolean
	maxProbes(s: ScannerSettings): number
	cores(decoderType: ProbeDecoderType): number
	supports(mode: ProbeMode, ctx: TransportContext): boolean
	configure(base: DecoderConfig, ctx: TransportContext): DecoderConfig
	/**
	 * WG11 req 6.5: the decoder's input when it is not the live stream (replay). Null: the input is gone and
	 * the probe ends without a verdict. Absent: the live tap feeds the decoder.
	 */
	openInput?(mode: ProbeMode, ctx: TransportContext): Readable | null
}

export interface ProbePoolDeps {
	decoders: Pick<
		DecoderManager,
		| "createEphemeralDecoder"
		| "removeEphemeralDecoder"
		| "getDecoder"
		| "on"
		| "off"
	>
	digitalVoice: Pick<
		DigitalVoiceService,
		"addChannel" | "removeChannel" | "ensureStarted" | "attachDecoder"
	> | null
	engines: (sourceId: string) => ProbeEngineView | undefined
	settings: () => ScannerSettings
	transports: readonly TransportStrategy[]
	cpu: { readonly normalisedPercent: number | null }
	engineCount: () => number
	storageDir: string
	allocatePort: () => Promise<number>
	logger: Logger
	now?: () => number
	/** Own the exact remover before the sole external constructor listener effect. */
	ownConstructorListener?: (removeExact: () => void) => boolean
}

export interface ProbeStatus {
	probeId: string
	decoderId: string
	jobId: string
	sourceId: string
	trackId: string
	observationId: string
	discoveryId: string | null
	targetHz: number
	epoch: number
	protocol: ScannerProtocol
	decoderType: ProbeDecoderType
	transport: ProbeTransport
	state: ProbeState
	startedAt: number
	cores: number
}

export interface ProbeCall {
	callId: string
	startedAt: number
	endedAt: number
	talkgroup?: string
	source?: string
	encrypted: boolean
}

export interface ProbeRecordings {
	probeId: string
	jobId: string
	req: ProbeRequest
	probeDir: string
	calls: ProbeCall[]
	epochEndedAt: number | null
}

type Deferral =
	| "budget"
	| "max-probes"
	| "cpu"
	| "no-transport"
	| "format"
	| "stale-epoch"
type StopReason =
	| "released"
	| "epoch"
	| "stream"
	| "preempted"
	| "job-ended"
	| "shutdown"
	| "error"
	/** WG9 req 5.4: the probe's decoder program could not run. */
	| "unavailable"
	/** WG11: a replay decoder exited (clean end of its input, or a failure). */
	| "replay-ended"

interface ProbeRecord {
	/** WG11: the replay input failed; the run ends cancelled whatever the decoder says. */
	replayInputFailed?: boolean
	/** The replay input reached its EOF (a clean end needs it). */
	replayInputEnded?: boolean
	/** Replay evidence held until the clean end (emitted then), dropped otherwise (re-review 2 #1). */
	heldEvidence?: DecodeEvidence[]
	probeId: string
	decoderId: string
	req: ProbeRequest
	mode: ProbeMode
	modeIndex: number
	modes: ProbeMode[]
	transport: TransportStrategy
	epoch: number
	centreHz: number
	state: ProbeState
	startedAt: number
	firstOutputAt: number | null
	epochEndedAt: number | null
	cores: number
	confirmed: boolean
	interp: InterpreterState
	input: PassThrough | null
	untap: (() => void) | null
	recordDir: string | null
	dvChannel: boolean
	calls: ProbeCall[]
	detach: (() => void)[]
	modeTimer: NodeJS.Timeout | null
	droppedBytes: number
	/** Set by teardown; a stop that arrives during it awaits this. */
	teardownDone: Promise<void> | null
	/** Sticky outcome of this original resource owner, never replaced by a missing-map retry. */
	cleanupState: "pending" | "settled" | "unknown"
	/** A mode step is tearing this record down; a stop clears it to cancel the step. */
	stepping: boolean
	/** multimon only: acceptance memory per capcode, bounded by the mode's hold (§ 6.4). */
	capcodes: CapcodeWindows | null
	/** The original launch remains owned until every awaiting allocation/create returns. */
	launchDone: Promise<void>
	launchSettled: boolean
	accepting: boolean
	decoderAttempted: boolean
	dvAttempted: boolean
	allocatedPorts: number[]
	/** WG11 1.8: covers of this probe's modes that ran their full mode hold unconfirmed (carried across steps). */
	fullHoldCovers: ScannerProtocol[]
}

/** Stream events of one engine, watched once a request names its source. */
interface StreamWatch {
	engine: ProbeEngineView
	/** Newest stream the engine announced; null until the first event. */
	latest: number | null
	stopped: boolean
	off: () => void
}

const PROBE_INPUT_HWM = 1024 * 1024
const PROBE_INPUT_MAX_QUEUED = 8 * 1024 * 1024
/** Pre-roll is clamped to this, so pre-roll plus the first live bytes stay under PROBE_INPUT_MAX_QUEUED. */
const PRE_ROLL_MAX_BYTES = PROBE_INPUT_MAX_QUEUED - 2 * PROBE_INPUT_HWM
const DEFAULT_START_LATENCY_MS = 400
/** WG9 req 5.4: `/bin/sh -c` exit statuses for a command that is not executable (126) or not found (127). */
const SHELL_UNAVAILABLE_EXIT_CODES: ReadonlySet<number> = new Set([126, 127])
/** WG9 req 5.4: spawn errno codes meaning the program itself cannot run. */
const SPAWN_UNAVAILABLE_ERRNO: ReadonlySet<string> = new Set([
	"ENOENT",
	"EACCES",
])

/**
 * WG9 req 5.4: true only for a launch failure whose cause is a spawn errno of a
 * missing or non-executable program. Anything else (unknown, wrapped otherwise,
 * other errno) is not "unavailable".
 */
export function isSpawnUnavailableError(err: unknown): boolean {
	if (!(err instanceof WaveKitError) || err.code !== "DECODER_SPAWN_ERROR")
		return false
	const cause: unknown = err.cause
	if (!(cause instanceof Error)) return false
	const errno = (cause as NodeJS.ErrnoException).code
	return typeof errno === "string" && SPAWN_UNAVAILABLE_ERRNO.has(errno)
}

/** WG9 req 5.4: only a numeric 126/127 exit status qualifies; signals and unknown codes never do. */
export function isUnavailableExit(code: unknown, signal: unknown): boolean {
	return (
		signal === null &&
		typeof code === "number" &&
		SHELL_UNAVAILABLE_EXIT_CODES.has(code)
	)
}

/**
 * WG12 R 4.5: the decoder program itself could not run, and nothing it printed
 * was seen. A spawn ENOENT/EACCES, or a shell 126/127 with no signal. Any
 * output, any other exit, or any other error stays on today's path.
 */
export function isDecoderUnavailableExit(exit: {
	code: number | null
	signal: NodeJS.Signals | null
	outputSeen: boolean
	spawnError?: unknown
}): boolean {
	if (exit.outputSeen) return false
	if (exit.spawnError !== undefined)
		return isSpawnUnavailableError(exit.spawnError)
	return isUnavailableExit(exit.code, exit.signal)
}

/**
 * Fail closed: a missing or non-string signal is not "no signal". Unknown exit
 * info therefore never matches 126/127.
 */
function decoderExitView(
	code: unknown,
	signal: unknown,
	outputSeen: boolean,
): {
	code: number | null
	signal: NodeJS.Signals | null
	outputSeen: boolean
} {
	const exitSignal =
		signal === null
			? null
			: typeof signal === "string"
				? (signal as NodeJS.Signals)
				: "SIGKILL"
	return {
		code: typeof code === "number" ? code : null,
		signal: exitSignal,
		outputSeen,
	}
}

/** Terminal `probe-state` payload when the decoder program could not run. No `undecodedReason`. */
export interface ProbeUnavailableStop {
	outcome: "unsupported"
	reason: "decoder-unavailable"
}
/** Slack around a capcode's pairing window (§ 6.4 "within the hold", ± 2 s). */
export const PAIRING_GAP_MS = 2000
/** Hold of the multimon-ng POCSAG/FLEX mode (§ 6.4); also the ambient pairing window. */
export const MULTIMON_HOLD_MS = 4000
const MAX_CAPCODE_WINDOWS = 1024
const LATENCY_ALPHA = 0.3
const ADMISSION_RANK = {
	"protocol-target": 0,
	undecoded: 1,
	reconfirm: 2,
} as const
/**
 * Hold of the dsd-fme `auto` mode that decodes DMR: the DMR late entry (1337 + 360 + 100 ms,
 * `DEFAULT_CONFIRM_HOLD_MS["tdma-ms"]`, identify's `IDENTIFY_MIN_HOLD_MS`). WG11 req 1.4: it was
 * 600 ms, so a `tdma-ms` request (class hold 1800 ms) left the DMR mode max(600, 1800 − 2000 for
 * the nxdn step) = 600 ms, too short for any DMR sync.
 */
export const DSD_AUTO_HOLD_MS = 1800
const DSD_AUTO_COVERS: ScannerProtocol[] = [
	"dmr",
	"p25p1",
	"p25p2",
	"ysf",
	"dstar",
]

function dsd(
	mode: string,
	protocol: ScannerProtocol,
	covers: ScannerProtocol[],
	holdMs: number,
): ProbeMode {
	return { decoderType: "dsd-fme", protocol, covers, options: { mode }, holdMs }
}

function keepRequested(
	modes: ProbeMode[],
	protocols: ScannerProtocol[],
): ProbeMode[] {
	if (protocols.length === 0) return modes
	return modes.filter(mode => mode.covers.some(p => protocols.includes(p)))
}

/** Identify (Task 35a) runs several explicit-mode probes on one track: each mode list is its own request. */
function explicitModesKey(req: ProbeRequest): string {
	return (
		(req.modes
			?.map(m => `${m.decoderType}:${JSON.stringify(m.options)}`)
			.join("|") ?? "") + (req.replay ? `#${req.replay.captureId}` : "")
	)
}

/** § 6.4 confirmation map (pre-channelizer slice). */
export function probeModesFor(
	cls: ScannerClass,
	protocols: ScannerProtocol[],
): ProbeMode[] {
	let modes: ProbeMode[]
	switch (cls) {
		case "tdma-ms":
		case "fsk4-12k5":
			modes = [
				dsd("auto", "dmr", DSD_AUTO_COVERS, DSD_AUTO_HOLD_MS),
				dsd("nxdn", "nxdn96", ["nxdn96"], 2000),
			]
			break
		case "fsk4-6k25":
			modes = [
				dsd("nxdn48", "nxdn48", ["nxdn48"], 2000),
				dsd("dpmr", "dpmr", ["dpmr"], 2000),
			]
			break
		case "gmsk-narrow":
			modes = [dsd("auto", "dstar", ["dstar"], 2000)]
			break
		case "fsk2-wide":
			modes = [
				{
					decoderType: "multimon-ng",
					protocol: "pocsag",
					covers: ["pocsag", "flex"],
					options: { modes: ["POCSAG512", "POCSAG1200", "POCSAG2400", "FLEX"] },
					holdMs: MULTIMON_HOLD_MS,
				},
			]
			break
		case "afsk-fm":
			modes = [
				{
					decoderType: "direwolf",
					protocol: "aprs",
					covers: ["aprs"],
					options: {},
					holdMs: 3000,
				},
			]
			break
		case "analog-fm":
			// No analog decoder: a short dsd-fme probe that finds no sync keeps it analog (§ 6.4).
			modes = [dsd("auto", "digital-unknown", DSD_AUTO_COVERS, 1500)]
			break
		case "ook-burst":
			// ISM confirmation is ambient-only before the channelizer (§ 6.4, § 14.1).
			return []
		case "carrier":
		case "wideband":
		case "unknown":
			return []
	}
	return keepRequested(modes, protocols)
}

/** Pre-channelizer transport: csdr front-end shift by `offsetHz` (§ 6.5). */
export const offsetTransport: TransportStrategy = {
	kind: "offset",
	preRoll: true,
	maxProbes: s => s.maxProbes.offset,
	cores: decoderType => probeCores("offset", decoderType),
	supports: (mode, ctx) =>
		ctx.format === "U8_IQ" &&
		mode.decoderType !== "rtl433" &&
		Math.abs(ctx.req.targetHz - ctx.epoch.centreHz) <=
			(ctx.sampleRateHz * USABLE_FRACTION) / 2,
	configure: (base, ctx) => ({
		...base,
		options: {
			...base.options,
			offsetHz: ctx.req.targetHz - ctx.epoch.centreHz,
		},
	}),
}

export function buildProbeConfig(input: {
	probeId: string
	req: ProbeRequest
	mode: ProbeMode
	transport: TransportStrategy
	ctx: TransportContext
	recordDir: string | null
	ports: { kiss: number; agw: number } | null
}): DecoderConfig {
	const options: Record<string, unknown> = { ...input.mode.options }
	if (input.mode.decoderType === "dsd-fme") {
		// `output` stays unset: DigitalVoiceService.addChannel only rewrites unset/udp outputs.
		if (input.recordDir) {
			options["enablePerCallRecording"] = true
			options["perCallRecordingDir"] = input.recordDir
			options["perCallRecordingPrune"] = false
		}
	}
	if (input.mode.decoderType === "direwolf" && input.ports) {
		options["kissPort"] = input.ports.kiss
		options["agwPort"] = input.ports.agw
	}
	const base: DecoderConfig = {
		id: input.probeId,
		type: input.mode.decoderType,
		enabled: true,
		sourceId: input.req.sourceId,
		options,
	}
	return input.transport.configure(base, input.ctx)
}

const CallEndSchema = z
	.object({
		callId: z.string(),
		startedAt: z.string(),
		endedAt: z.string().optional(),
		talkgroup: z.number().nullable().optional(),
		source: z.number().nullable().optional(),
		encrypted: z.boolean().optional(),
		flags: z
			.object({
				encrypted: z.boolean().optional(),
				wavFileUpdate: z.boolean().optional(),
			})
			.partial()
			.optional(),
	})
	.passthrough()

/** Capcode of a multimon-ng pager output (light parse; interpretMultimon validates the rest). */
function multimonCapcode(out: DecoderOutputLike): string | null {
	if (
		out.type !== "message" ||
		typeof out.data !== "object" ||
		out.data === null
	)
		return null
	const d = out.data as { address?: unknown; capcode?: unknown }
	if (typeof d.address === "number") return `pocsag:${d.address}`
	if (typeof d.capcode === "string" && d.capcode.trim() !== "")
		return `flex:${d.capcode.trim()}`
	return null
}

/**
 * multimon pairing windows, one per capcode (§ 6.4 "two decodes with the same
 * capcode within the hold"): a capcode's first decode opens
 * `[start − 2 s, start + holdMs + 2 s]`; a decode inside it shares that
 * capcode's interpreter state, a decode outside it starts a fresh state and
 * window. Other capcodes never touch a capcode's window. Once a capcode is
 * accepted its state is kept for the instance's life (one probe, or one
 * ambient decoder epoch), so every later decode is evidence again
 * (confirm/multimon.ts).
 */
export class CapcodeWindows {
	private readonly windows = new Map<
		string,
		{ interp: InterpreterState; windowStart: number }
	>()
	/** Accepted capcodes and their states, oldest first. */
	private readonly accepted = new Map<string, InterpreterState>()

	constructor(
		private readonly holdMs: number,
		private readonly create: () => InterpreterState,
	) {}

	/** Evidence of one multimon output decoded at `at` (none when it names no capcode). */
	interpret(out: DecoderOutputLike, at: number): DecodeEvidence[] {
		const key = multimonCapcode(out)
		if (key === null) return []
		const kept = this.accepted.get(key)
		if (kept) return interpretMultimon(out, kept)
		const state = this.windowState(key, at)
		const evs = interpretMultimon(out, state)
		if (evs.some(ev => ev.identity !== undefined)) {
			this.windows.delete(key)
			this.accepted.set(key, state)
			if (this.accepted.size > MAX_CAPCODE_WINDOWS) {
				const oldest = this.accepted.keys().next()
				if (oldest.done !== true) this.accepted.delete(oldest.value)
			}
		}
		return evs
	}

	private windowState(key: string, at: number): InterpreterState {
		let w = this.windows.get(key)
		if (
			w &&
			at >= w.windowStart - PAIRING_GAP_MS &&
			at <= w.windowStart + this.holdMs + PAIRING_GAP_MS
		) {
			return w.interp
		}
		// Re-inserted on renewal, so the map stays ordered by windowStart: the first entry is the oldest.
		this.windows.delete(key)
		w = { interp: this.create(), windowStart: at }
		this.windows.set(key, w)
		if (this.windows.size > MAX_CAPCODE_WINDOWS) {
			const oldest = this.windows.keys().next()
			if (oldest.done !== true) this.windows.delete(oldest.value)
		}
		return w.interp
	}
}

function protocolShort(p: ScannerProtocol): string {
	return p.replace(/[^a-z0-9]/g, "").slice(0, 8)
}

/**
 * WG11 batch review R1 2: a replay request reads its capture (cf32 at the capture rate, centred on its
 * target, in the capture's epoch), not the live stream, so its context needs no live spectrum engine: the
 * passive CPU guard closing the source's last engine leaves queued captures replayable.
 */
function replayContext(req: ProbeRequest): TransportContext {
	return {
		req,
		epoch: {
			stream: 0,
			epoch: req.epoch,
			startSample: null,
			centreHz: req.targetHz,
			sampleRateHz: IQ_CAPTURE_RATE_HZ,
			gainKey: "",
			tuningTrust: "relay",
			settleMode: null,
		},
		format: "CF32",
		sampleRateHz: IQ_CAPTURE_RATE_HZ,
	}
}

export class ProbePool extends EventEmitter {
	private readonly log: Logger
	private readonly now: () => number
	private readonly records = new Map<string, ProbeRecord>()
	private readonly byDecoder = new Map<string, ProbeRecord>()
	private readonly queue: ProbeRequest[] = []
	private readonly latency = new Map<string, number>()
	/** WG10 req 3.5: decoder type -> time it last reported unavailable. At most one entry per type. */
	private readonly unavailableAt = new Map<ScannerProbeDecoderType, number>()
	private readonly watches = new Map<string, StreamWatch>()
	/** Engines whose "stop" the pool saw: never watched again (S1-B final review, finding 9). */
	private readonly stoppedEngines = new WeakSet<ProbeEngineView>()
	private seq = 0
	private readonly retainedCleanup = new Set<ProbeRecord>()
	private cleanupFailed = false
	private destroyed = false
	/** Cores held by reserveExternal, counted in estimatedCores. */
	private externalCores = 0
	private readonly outputRegistration: ConstructorListenerRegistration

	constructor(private readonly deps: ProbePoolDeps) {
		super()
		this.log = createComponentLogger(deps.logger, "ProbePool")
		this.now = deps.now ?? Date.now
		const emitter = deps.decoders
		const listener = this.onOutput
		this.outputRegistration = new ConstructorListenerRegistration(
			() => {
				emitter.on("decoder:output", listener)
			},
			() => {
				emitter.off("decoder:output", listener)
			},
			() =>
				emitter instanceof EventEmitter &&
				!emitter.listeners("decoder:output").includes(listener),
		)
		try {
			this.outputRegistration.register(deps.ownConstructorListener)
		} catch (err: unknown) {
			try {
				this.outputRegistration.remove()
			} catch (cleanupError: unknown) {
				this.log.warn(
					{ err: cleanupError },
					"Partial probe constructor subscription retained",
				)
			}
			throw err
		}
	}

	request(req: ProbeRequest): { started: string } | { deferred: Deferral } {
		if (this.destroyed) return { deferred: "no-transport" }
		const existing = [...this.records.values()].find(
			r =>
				(r.state !== "stopping" || r.stepping) &&
				r.req.trackId === req.trackId &&
				r.req.jobId === req.jobId &&
				explicitModesKey(r.req) === explicitModesKey(req),
		)
		if (existing) return { started: existing.probeId }
		let ctx: TransportContext
		if (req.replay !== undefined) ctx = replayContext(req)
		else {
			const engine = this.deps.engines(req.sourceId)
			if (!engine) return { deferred: "no-transport" }
			const epoch = engine.currentEpoch()
			if (
				epoch.epoch !== req.epoch ||
				!this.streamCurrent(req.sourceId, engine, epoch)
			) {
				return { deferred: "stale-epoch" }
			}
			if (
				engine.format !== "U8_IQ" &&
				!this.deps.transports.some(t => t.kind !== "offset")
			) {
				return { deferred: "format" }
			}
			ctx = {
				req,
				epoch,
				format: engine.format,
				sampleRateHz: epoch.sampleRateHz,
			}
		}
		const modes = req.modes ?? probeModesFor(req.cls, req.protocols)
		const first = modes[0]
		if (!first) return { deferred: "no-transport" }
		const pick = this.pickTransport(first, ctx)
		if ("deferred" in pick) {
			if (
				pick.deferred === "max-probes" ||
				pick.deferred === "budget" ||
				pick.deferred === "cpu"
			) {
				this.enqueue(req)
				// Under the CPU guard only identify (priority above every job's 0–100, Task 35a) preempts: a stopped
				// decoder is the CPU the guard is waiting for. pump() retries the queue every service tick.
				if (pick.deferred !== "cpu" || req.priority > 100)
					this.preemptFor(
						req,
						pick.deferred === "max-probes" ? this.fullKinds(first, ctx) : null,
					)
			}
			return pick
		}
		if (this.destroyed) return { deferred: "no-transport" }
		return { started: this.start(req, modes, 0, pick.transport, ctx, null) }
	}

	follow(probeId: string, follow: boolean): void {
		const rec = this.records.get(probeId)
		if (!rec || this.isStopping(rec) || rec.state === "starting") return
		rec.state = follow ? "following" : "confirming"
		this.emit("probe-state", probeId, rec.state, rec.req)
	}

	async release(probeId: string): Promise<void> {
		const rec = this.records.get(probeId)
		if (rec) await this.stopProbe(rec, "released")
	}

	async releaseJob(jobId: string): Promise<void> {
		this.dropQueued(r => r.jobId === jobId)
		await Promise.all(
			[...this.records.values()]
				.filter(r => r.req.jobId === jobId)
				.map(r => this.stopProbe(r, "job-ended")),
		)
	}

	trackClosed(trackId: string): void {
		this.dropQueued(r => r.trackId === trackId)
	}

	/** Drops one queued request (identify gives up on a run that never got a slot, Task 35a). */
	dequeue(req: ProbeRequest): boolean {
		const before = this.queue.length
		this.dropQueued(r => r === req)
		return this.queue.length < before
	}

	async onEpoch(
		sourceId: string,
		epoch: number,
		centreHz: number,
	): Promise<void> {
		const at = this.now()
		// A replay probe reads a capture, not the live stream: an epoch change leaves it running.
		this.dropQueued(
			r => r.sourceId === sourceId && r.epoch !== epoch && !r.replay,
		)
		const stale = [...this.records.values()].filter(
			r => r.req.sourceId === sourceId && r.epoch !== epoch && !r.req.replay,
		)
		for (const rec of stale) {
			rec.epochEndedAt = at
			this.fence(rec)
		}
		await Promise.all(stale.map(rec => this.stopProbe(rec, "epoch")))
		for (const rec of stale) {
			// Identify (priority above every job's 0–100, Task 35a) re-plans on its own: a re-request would only
			// spawn a decoder it gives back, and preempt a lower-priority probe for nothing.
			if (rec.req.priority > 100) continue
			const engine = this.deps.engines(sourceId)
			if (!engine) continue
			const halfSpan =
				(engine.currentEpoch().sampleRateHz * USABLE_FRACTION) / 2
			if (Math.abs(rec.req.targetHz - centreHz) > halfSpan) continue
			this.request({ ...rec.req, epoch, preRollFromSample: null })
		}
	}

	status(): ProbeStatus[] {
		return [...this.records.values()].map(r => ({
			probeId: r.probeId,
			decoderId: r.decoderId,
			jobId: r.req.jobId,
			sourceId: r.req.sourceId,
			trackId: r.req.trackId,
			observationId: r.req.observationId,
			discoveryId: r.req.discoveryId,
			targetHz: r.req.targetHz,
			epoch: r.epoch,
			protocol: r.mode.protocol,
			decoderType: r.mode.decoderType,
			transport: r.transport.kind,
			state: r.state,
			startedAt: r.startedAt,
			cores: r.cores,
		}))
	}

	/**
	 * WG11 req 1.8: the protocols covered by the probe's modes that ran their full mode hold without
	 * a confirmation (the mode timer fired while confirming). Unknown probe: none.
	 */
	fullHoldCovers(probeId: string): readonly ScannerProtocol[] {
		return this.records.get(probeId)?.fullHoldCovers ?? []
	}

	startLatencyMs(
		decoderType: ProbeDecoderType,
		transport: ProbeTransport,
	): number {
		return Math.round(
			this.latency.get(`${decoderType}:${transport}`) ??
				DEFAULT_START_LATENCY_MS,
		)
	}

	/** Internal direct-admission gate: terminal status rows do not erase unknown offset residue. */
	get channelBaselineKnown(): boolean {
		return (
			!this.destroyed && !this.cleanupFailed && this.retainedCleanup.size === 0
		)
	}

	/** Synchronous gate used before API/operator drain; no new tick/queue/create may escape. */
	sealAdmission(): void {
		this.destroyed = true
		this.queue.length = 0
		// Fence every original capability before any cleanup callback can reenter.
		const records = [...this.records.values()]
		for (const rec of records) this.fence(rec)
		for (const rec of records) {
			void this.stopProbe(rec, "shutdown").catch((err: unknown) => {
				this.cleanupFailed = true
				this.retainedCleanup.add(rec)
				this.log.warn(
					{ err, probeId: rec.probeId },
					"Sealed probe cleanup failed",
				)
			})
		}
	}

	async destroy(): Promise<void> {
		this.sealAdmission()
		try {
			this.outputRegistration.remove()
		} catch (err: unknown) {
			this.cleanupFailed = true
			this.log.warn({ err }, "Probe output subscription cleanup failed")
		}
		for (const [sourceId, watch] of this.watches) {
			try {
				watch.off()
				this.watches.delete(sourceId)
			} catch (err: unknown) {
				this.cleanupFailed = true
				this.log.warn(
					{ err, sourceId },
					"Probe stream subscription cleanup failed",
				)
			}
		}
		const outcomes = await Promise.allSettled(
			[...this.records.values()].map(record =>
				this.stopProbe(record, "shutdown"),
			),
		)
		if (
			outcomes.some(outcome => outcome.status === "rejected") ||
			this.cleanupFailed
		)
			throw new WaveKitError(
				"Scanner probe cleanup failed",
				"SCANNER_PROBE_CLEANUP_FAILED",
			)
	}

	// === streams ===

	/**
	 * Subscribes to the engine's `"stream"` events from its open, so the lag guard
	 * knows every boundary (ScannerService calls it at engine open, Task 35; again
	 * after Task 37a's engine re-plumbing). Idempotent; a new engine instance for the
	 * source replaces the old subscription. Without it the pool subscribes on first use.
	 */
	watchEngine(sourceId: string, engine: ProbeEngineView): void {
		if (this.destroyed || this.stoppedEngines.has(engine)) return
		this.watch(sourceId, engine)
	}

	/** `replaced`: this call ended the watch of another engine instance for the source. */
	private watch(
		sourceId: string,
		engine: ProbeEngineView,
	): { watch: StreamWatch; replaced: boolean } {
		let watch = this.watches.get(sourceId)
		if (watch?.engine === engine) return { watch, replaced: false }
		const replaced = watch !== undefined
		if (watch) {
			// Its probes read the replaced engine's ring, and its "stop" may never reach us now.
			this.endSourceProbes(sourceId)
			try {
				watch.off()
			} catch (err: unknown) {
				this.cleanupFailed = true
				this.sealAdmission()
				throw err
			}
		}
		const onStream = (stream: number, reason: EngineStreamReason): void =>
			this.onStream(sourceId, stream, reason)
		const registration = new ConstructorListenerRegistration(
			() => {
				engine.on("stream", onStream)
			},
			() => {
				engine.off("stream", onStream)
			},
			() =>
				engine instanceof EventEmitter &&
				!engine.listeners("stream").includes(onStream),
		)
		watch = {
			engine,
			latest: null,
			stopped: false,
			off: () => registration.remove(),
		}
		this.watches.set(sourceId, watch)
		try {
			registration.register()
			if (this.destroyed) {
				registration.remove()
				this.watches.delete(sourceId)
			}
		} catch (err: unknown) {
			this.sealAdmission()
			try {
				registration.remove()
				this.watches.delete(sourceId)
			} catch (cleanupError: unknown) {
				this.cleanupFailed = true
				this.log.warn(
					{ err: cleanupError, sourceId },
					"Partial probe stream subscription retained",
				)
			}
			throw err
		}
		return { watch, replaced }
	}

	/**
	 * Lag guard. On a thread host `currentEpoch().stream` lags the ring right after a
	 * reconnect boundary: a stream newer than the epoch's means the epoch's sample
	 * indices no longer address the ring. Subscribes on first use when watchEngine
	 * was not called.
	 */
	private streamCurrent(
		sourceId: string,
		engine: ProbeEngineView,
		epoch: EngineEpoch,
	): boolean {
		if (this.stoppedEngines.has(engine)) return false
		const { watch, replaced } = this.watch(sourceId, engine)
		// A request in hand was built against the replaced engine: its epoch and sample indices are another engine's.
		if (replaced) return false
		return (
			!watch.stopped && (watch.latest === null || watch.latest <= epoch.stream)
		)
	}

	/** A new stream (or the engine's stop): every probe of the source read the old ring. */
	private onStream(
		sourceId: string,
		stream: number,
		reason: EngineStreamReason,
	): void {
		if (this.destroyed) return
		const watch = this.watches.get(sourceId)
		if (watch) {
			watch.latest = stream
			watch.stopped = reason === "stop"
			if (watch.stopped) {
				// Finding 9: the stopped engine (and its IQ ring) is not kept referenced until the next open.
				this.stoppedEngines.add(watch.engine)
				this.endSourceProbes(sourceId)
				try {
					watch.off()
					this.watches.delete(sourceId)
				} catch (err: unknown) {
					this.cleanupFailed = true
					this.sealAdmission()
					this.log.warn(
						{ err, sourceId },
						"Stopped engine subscription cleanup failed",
					)
				}
				return
			}
		}
		this.endSourceProbes(sourceId)
	}

	/** Ends every probe and queued request of a source whose ring they no longer address. */
	private endSourceProbes(sourceId: string): void {
		const at = this.now()
		this.dropQueued(r => r.sourceId === sourceId)
		const records = [...this.records.values()].filter(
			rec => rec.req.sourceId === sourceId,
		)
		for (const rec of records) {
			rec.epochEndedAt ??= at
			this.fence(rec)
		}
		for (const rec of records) {
			// Teardown invokes each currently owned untap synchronously before its first await.
			void this.stopProbe(rec, "stream").catch((err: unknown) => {
				this.cleanupFailed = true
				this.retainedCleanup.add(rec)
				this.sealAdmission()
				this.log.warn(
					{ err, probeId: rec.probeId },
					"Stream-ended probe cleanup failed",
				)
			})
		}
	}

	// === admission ===

	/**
	 * Hold `cores` against the same budget probe admission uses. Null when
	 * the pool is destroyed, `cores` is not a finite non-negative number,
	 * `settings()` throws or has a non-finite budget, or the reservation
	 * would exceed `cpuBudgetCores`. Zero returns a no-op release. Release is
	 * idempotent and never drives the counter negative.
	 */
	reserveExternal(cores: number): (() => void) | null {
		if (this.destroyed) return null
		if (!Number.isFinite(cores) || cores < 0) return null
		if (cores === 0) return () => {}
		let budget: number
		try {
			budget = this.deps.settings().cpuBudgetCores
		} catch {
			return null
		}
		if (!Number.isFinite(budget)) return null
		if (this.estimatedCores() + cores > budget + 1e-9) return null
		this.externalCores += cores
		let released = false
		return () => {
			if (released) return
			released = true
			this.externalCores = Math.max(0, this.externalCores - cores)
		}
	}

	private estimatedCores(): number {
		let cores = this.deps.engineCount() * CPU_COST.engine + this.externalCores
		for (const r of this.records.values()) cores += r.cores
		return cores
	}

	private pickTransport(
		mode: ProbeMode,
		ctx: TransportContext,
	): { transport: TransportStrategy } | { deferred: Deferral } {
		const s = this.deps.settings()
		let reason: Deferral | null = null
		// A replay request runs on the replay transport only; a live one never on it.
		const replaying = ctx.req.replay !== undefined
		for (const transport of this.deps.transports) {
			if ((transport.kind === "replay") !== replaying) continue
			if (!transport.supports(mode, ctx)) continue
			const running = [...this.records.values()].filter(
				r => r.transport.kind === transport.kind,
			).length
			if (running >= transport.maxProbes(s)) {
				reason ??= "max-probes"
				continue
			}
			if (
				this.estimatedCores() + transport.cores(mode.decoderType) >
				s.cpuBudgetCores + 1e-9
			) {
				reason ??= "budget"
				continue
			}
			const cpu = this.deps.cpu.normalisedPercent
			if (cpu !== null && cpu > s.cpuGuardPercent) {
				reason ??= "cpu"
				continue
			}
			return { transport }
		}
		if (reason) return { deferred: reason }
		return {
			deferred: ctx.format === "U8_IQ" || replaying ? "no-transport" : "format",
		}
	}

	/** WG11 review M1: the live transports supporting the mode whose probe slots are all taken. */
	private fullKinds(
		mode: ProbeMode,
		ctx: TransportContext,
	): Set<TransportStrategy["kind"]> {
		const s = this.deps.settings()
		const kinds = new Set<TransportStrategy["kind"]>()
		for (const transport of this.deps.transports) {
			if (transport.kind === "replay" || !transport.supports(mode, ctx))
				continue
			const running = [...this.records.values()].filter(
				r => r.transport.kind === transport.kind,
			).length
			if (running >= transport.maxProbes(s)) kinds.add(transport.kind)
		}
		return kinds
	}

	private enqueue(req: ProbeRequest): void {
		this.dropQueued(
			r =>
				r.trackId === req.trackId &&
				r.jobId === req.jobId &&
				explicitModesKey(r) === explicitModesKey(req),
		)
		this.queue.push(req)
		this.queue.sort(
			(a, b) =>
				b.priority - a.priority ||
				ADMISSION_RANK[a.admission.kind] - ADMISSION_RANK[b.admission.kind] ||
				b.admission.snrDb - a.admission.snrDb,
		)
	}

	private dropQueued(match: (r: ProbeRequest) => boolean): void {
		for (let i = this.queue.length - 1; i >= 0; i--)
			if (match(this.queue[i]!)) this.queue.splice(i, 1)
	}

	/**
	 * WG11 review M1: a replay request never preempts (its single slot is held by another replay, which
	 * ends by itself faster than real time), and a live request never preempts a replay probe (a lost
	 * replay trial would cascade back into the queue's retries). Live requests preempt live probes only.
	 */
	private preemptFor(
		req: ProbeRequest,
		kinds: ReadonlySet<TransportStrategy["kind"]> | null,
	): void {
		if (req.replay !== undefined) return
		let victim: ProbeRecord | null = null
		for (const r of this.records.values()) {
			if (r.state === "stopping" || r.req.priority >= req.priority) continue
			if (r.req.replay !== undefined) continue
			// A max-probes deferral frees a slot only on a full transport the request could use.
			if (kinds && !kinds.has(r.transport.kind)) continue
			if (!victim || r.req.priority < victim.req.priority) victim = r
		}
		if (victim) {
			const original = victim
			void this.stopProbe(original, "preempted").catch((err: unknown) => {
				this.cleanupFailed = true
				this.retainedCleanup.add(original)
				this.sealAdmission()
				this.log.warn(
					{ err, probeId: original.probeId },
					"Preempted probe cleanup failed",
				)
			})
		}
	}

	/** A queued request's context now: a replay's from its capture, a live one's from its current engine. */
	private liveOrReplayContext(req: ProbeRequest): TransportContext | null {
		if (req.replay !== undefined) return replayContext(req)
		const engine = this.deps.engines(req.sourceId)
		if (!engine) return null
		const epoch = engine.currentEpoch()
		if (
			epoch.epoch !== req.epoch ||
			!this.streamCurrent(req.sourceId, engine, epoch)
		)
			return null
		return {
			req,
			epoch,
			format: engine.format,
			sampleRateHz: epoch.sampleRateHz,
		}
	}

	/**
	 * Starts queued requests that now fit. Runs after every probe stop and from `ScannerService.tick` (Task 35), so a
	 * cpu- or budget-deferred request starts once the meter drops even when no probe stops.
	 */
	pump(): void {
		if (this.destroyed) return
		for (const req of [...this.queue]) {
			if (this.destroyed) return
			// Dropped by an earlier iteration (an engine replacement ends its source's queue).
			if (!this.queue.includes(req)) continue
			const ctx = this.liveOrReplayContext(req)
			if (!ctx) {
				this.dropQueued(r => r === req)
				continue
			}
			const modes = req.modes ?? probeModesFor(req.cls, req.protocols)
			const first = modes[0]
			if (!first) {
				this.dropQueued(r => r === req)
				continue
			}
			const pick = this.pickTransport(first, ctx)
			if ("deferred" in pick) continue
			if (this.destroyed) return
			this.dropQueued(r => r === req)
			this.start(req, modes, 0, pick.transport, ctx, null)
		}
	}

	// === lifecycle ===

	private start(
		req: ProbeRequest,
		modes: ProbeMode[],
		modeIndex: number,
		transport: TransportStrategy,
		ctx: TransportContext,
		probeIdOverride: string | null,
		carry: {
			calls: ProbeCall[]
			recordDir: string | null
			fullHoldCovers?: ScannerProtocol[]
		} | null = null,
	): string {
		const mode = modes[modeIndex]!
		this.seq += 1
		const decoderId = buildProbeId(
			shortId(req.jobId),
			protocolShort(mode.protocol),
			this.seq,
		)
		const probeId = probeIdOverride ?? decoderId
		let finishLaunch!: () => void
		const launchDone = new Promise<void>(resolve => {
			finishLaunch = resolve
		})
		const rec: ProbeRecord = {
			probeId,
			decoderId,
			req,
			mode,
			modeIndex,
			modes,
			transport,
			epoch: req.epoch,
			centreHz: ctx.epoch.centreHz,
			state: "starting",
			startedAt: this.now(),
			firstOutputAt: null,
			epochEndedAt: null,
			cores: transport.cores(mode.decoderType),
			confirmed: false,
			interp: createInterpreterState({
				epoch: req.epoch,
				origin: "probe",
				probeId,
				decoderId,
				nxdn: mode.options["mode"] === "nxdn48" ? "nxdn48" : "nxdn96",
			}),
			input: null,
			untap: null,
			recordDir: carry?.recordDir ?? null,
			dvChannel: false,
			calls: carry?.calls ?? [],
			detach: [],
			modeTimer: null,
			droppedBytes: 0,
			teardownDone: null,
			cleanupState: "pending",
			stepping: false,
			capcodes: null,
			launchDone,
			launchSettled: false,
			accepting: true,
			decoderAttempted: false,
			dvAttempted: false,
			allocatedPorts: [],
			fullHoldCovers: carry?.fullHoldCovers ?? [],
		}
		if (mode.decoderType === "multimon-ng") {
			rec.capcodes = new CapcodeWindows(mode.holdMs, () =>
				createInterpreterState({
					epoch: req.epoch,
					origin: "probe",
					probeId,
					decoderId,
				}),
			)
		}
		this.records.set(probeId, rec)
		this.byDecoder.set(decoderId, rec)
		try {
			this.emit("probe-state", probeId, "starting", req)
		} catch (err: unknown) {
			rec.launchSettled = true
			finishLaunch()
			void this.stopProbe(rec, "error").catch((cleanupError: unknown) => {
				this.cleanupFailed = true
				this.retainedCleanup.add(rec)
				this.log.warn(
					{ err: cleanupError, probeId },
					"Probe registration cleanup failed",
				)
			})
			throw err
		}
		void this.launch(rec, ctx, modeIndex === 0).then(
			() => {
				rec.launchSettled = true
				finishLaunch()
			},
			(err: unknown) => {
				rec.launchSettled = true
				finishLaunch()
				// The pool stopped it while it started (createEphemeralDecoder rejects with PROBE_REMOVED): not a failure.
				if (this.isStopping(rec)) {
					this.log.debug(
						{ probeId, decoderType: mode.decoderType },
						"Probe stopped during its start",
					)
					return
				}
				const removed =
					err instanceof WaveKitError && err.code === "PROBE_REMOVED"
				this.log[removed ? "debug" : "warn"](
					{ err, probeId, decoderType: mode.decoderType },
					removed ? "Probe removed during its start" : "Probe failed to start",
				)
				const unavailable = isDecoderUnavailableExit({
					code: null,
					signal: null,
					outputSeen: rec.firstOutputAt !== null,
					spawnError: err,
				})
				if (unavailable) this.reportUnavailable(rec)
				void this.stopProbe(rec, unavailable ? "unavailable" : "error").catch(
					(cleanupError: unknown) => {
						this.cleanupFailed = true
						this.retainedCleanup.add(rec)
						this.log.warn(
							{ err: cleanupError, probeId },
							"Failed probe cleanup failed",
						)
					},
				)
			},
		)
		return probeId
	}

	/**
	 * WG10 req 3.5: probe decoder types that reported unavailable less than PROBE_UNAVAILABLE_MEMO_MS
	 * before `now`. The bound is exclusive: an entry exactly PROBE_UNAVAILABLE_MEMO_MS old has expired.
	 * A successful start of the type clears it. Bounded by the number of decoder types.
	 */
	unavailableTypes(now: number): ReadonlySet<ScannerProbeDecoderType> {
		const out = new Set<ScannerProbeDecoderType>()
		for (const [type, at] of this.unavailableAt)
			if (now - at < PROBE_UNAVAILABLE_MEMO_MS) out.add(type)
		return out
	}

	/**
	 * stopProbe can run while launch awaits. A method call, not an inline `rec.state === "stopping"`: TypeScript keeps
	 * the first inline check's narrowing across the awaits and rejects the second one (TS2367).
	 */
	private isStopping(rec: ProbeRecord): boolean {
		return (
			this.destroyed ||
			!rec.accepting ||
			rec.state === "stopping" ||
			this.records.get(rec.probeId) !== rec
		)
	}

	private fence(rec: ProbeRecord): void {
		rec.accepting = false
		rec.state = "stopping"
		rec.stepping = false
		if (rec.modeTimer) clearTimeout(rec.modeTimer)
		rec.modeTimer = null
		if (this.byDecoder.get(rec.decoderId) === rec)
			this.byDecoder.delete(rec.decoderId)
	}

	private async launch(
		rec: ProbeRecord,
		ctx: TransportContext,
		withPreRoll: boolean,
	): Promise<void> {
		const { req, mode, transport } = rec
		if (this.isStopping(rec)) return
		// Initial composition is DIRECT-TAP ONLY. Deny the selected observed decoder
		// route before ports/DV/directory/tap/constructor effects, without offset retry.
		if (transport.kind === "channel")
			throw new WaveKitError(
				"Observed scanner decoder route is unavailable",
				"SCANNER_CHANNEL_DECODER_UNAVAILABLE",
			)
		let ports: { kiss: number; agw: number } | null = null
		if (mode.decoderType === "direwolf") {
			const kiss = await this.deps.allocatePort()
			rec.allocatedPorts.push(kiss)
			if (this.isStopping(rec)) return
			const agw = await this.deps.allocatePort()
			rec.allocatedPorts.push(agw)
			if (this.isStopping(rec)) return
			ports = { kiss, agw }
		}
		if (this.isStopping(rec)) return
		if (mode.decoderType === "dsd-fme" && req.record) {
			// A mode step keeps the probe id, so earlier modes' calls share the directory.
			rec.recordDir ??= join(
				this.deps.storageDir,
				"recordings",
				"dv",
				`probe-${rec.probeId}`,
			)
			await mkdir(rec.recordDir, { recursive: true })
		}
		if (this.isStopping(rec)) return
		let config = buildProbeConfig({
			probeId: rec.decoderId,
			req,
			mode,
			transport,
			ctx,
			recordDir: rec.recordDir,
			ports,
		})
		if (this.isStopping(rec)) return
		const dv = this.deps.digitalVoice
		if (mode.decoderType === "dsd-fme" && dv) {
			rec.dvAttempted = true
			config = await dv.addChannel(config)
			rec.dvChannel = config.options["output"] === "udp"
			// Late returned channels remain in the original record for teardown after launch settles.
			if (this.isStopping(rec)) return
			if (rec.dvChannel) await dv.ensureStarted()
		}
		if (this.isStopping(rec)) return
		if (transport.preRoll) {
			const engine = this.deps.engines(req.sourceId)
			// A "stream" event since the request stopped this probe (isStopping above). A replaced engine has
			// its own ring and stream counter.
			if (!engine || engine !== this.watches.get(req.sourceId)?.engine) {
				throw new WaveKitError(
					`Spectrum engine for ${req.sourceId} is gone`,
					"SCANNER_ENGINE_GONE",
				)
			}
			const input = new PassThrough({ highWaterMark: PROBE_INPUT_HWM })
			rec.input = input
			input.on("error", (err: Error) =>
				this.log.debug({ err, probeId: rec.probeId }, "Probe input error"),
			)
			// Pre-roll and tap in one synchronous block: no sample lost or repeated.
			const edge = engine.liveEdge()
			if (this.isStopping(rec)) return
			const maxPreRollSamples = Math.floor(
				PRE_ROLL_MAX_BYTES / bytesPerSample(engine.format),
			)
			const from =
				withPreRoll && req.preRollFromSample !== null
					? Math.max(req.preRollFromSample, edge - maxPreRollSamples)
					: edge
			const pre = engine.readRing(from, edge)
			if (this.isStopping(rec)) return
			if (pre && pre.bytes.length > 0) input.write(Buffer.from(pre.bytes))
			if (this.isStopping(rec)) return
			rec.untap = engine.tap((_start, bytes) => {
				if (this.isStopping(rec)) return
				if (input.writableLength > PROBE_INPUT_MAX_QUEUED) {
					rec.droppedBytes += bytes.length
					return
				}
				input.write(Buffer.from(bytes))
			})
			if (this.isStopping(rec)) return
		}
		if (!transport.preRoll && transport.openInput) {
			// Replay: the transport's own stream (a capture), ended by its EOF. No capture: no probe, no verdict.
			const source = transport.openInput(mode, ctx)
			if (!source)
				throw new WaveKitError(
					"Replay input is unavailable",
					"SCANNER_REPLAY_INPUT_GONE",
				)
			const input = new PassThrough({ highWaterMark: PROBE_INPUT_HWM })
			rec.input = input
			rec.detach.push(() => source.destroy())
			input.on("error", (err: Error) =>
				this.log.debug({ err, probeId: rec.probeId }, "Replay input error"),
			)
			source.on("error", (err: Error) => {
				this.log.debug({ err, probeId: rec.probeId }, "Replay source error")
				rec.replayInputFailed = true
				input.end()
			})
			source.once("end", () => {
				rec.replayInputEnded = true
			})
			source.pipe(input)
		}
		if (this.isStopping(rec)) return
		rec.decoderAttempted = true
		const decoder = await this.deps.decoders.createEphemeralDecoder(config, {
			owner: "scanner",
			jobId: req.jobId,
			...(rec.input ? { input: rec.input } : {}),
		})
		// WG10 req 3.5: the program spawned, so the type is no longer unavailable. A later 126/127 exit
		// (a later macrotask) records it again.
		this.unavailableAt.delete(rec.mode.decoderType)
		if (this.isStopping(rec)) return
		const emitter = decoder as unknown as EventEmitter
		// WG9 req 5.4: attached in the same task as the spawn resolved, so an exit
		// event (a later macrotask) cannot be missed. Only a 126/127 exit before any
		// output stops the probe as "decoder unavailable"; every other exit keeps
		// today's path (the hold runs out).
		const onExit = (code: unknown, signal: unknown): void => {
			if (this.isStopping(rec)) return
			const unavailable = isDecoderUnavailableExit(
				decoderExitView(code, signal, rec.firstOutputAt !== null),
			)
			// A missing program before output is unavailable on replay too. Every
			// other replay exit keeps today's replay-end path.
			if (rec.transport.kind === "replay" && !unavailable) {
				this.onReplayExit(rec, code === 0 && signal === null)
				return
			}
			if (!unavailable) return
			this.reportUnavailable(rec)
			void this.stopProbe(rec, "unavailable").catch((err: unknown) => {
				this.cleanupFailed = true
				this.retainedCleanup.add(rec)
				this.log.warn(
					{ err, probeId: rec.probeId },
					"Unavailable probe cleanup failed",
				)
			})
		}
		rec.detach.push(() => {
			emitter.off("exit", onExit)
			if (emitter.listeners("exit").includes(onExit))
				throw new WaveKitError(
					"Probe exit listener removal is unverified",
					"SCANNER_PROBE_CLEANUP_UNKNOWN",
				)
		})
		emitter.on("exit", onExit)
		if (rec.dvChannel && dv)
			dv.attachDecoder(rec.decoderId, emitter as unknown as VoiceCallSource)
		if (this.isStopping(rec)) return
		if (mode.decoderType === "dsd-fme") {
			const onLink = (line: DsdFmeLinkLine): void => {
				if (this.isStopping(rec)) return
				this.markOutput(rec)
				if (this.isStopping(rec)) return
				this.deliver(rec, interpretDsdFme({ kind: "link", line }, rec.interp))
			}
			rec.detach.push(() => {
				emitter.off("link", onLink)
				if (emitter.listeners("link").includes(onLink))
					throw new WaveKitError(
						"Probe link listener removal is unverified",
						"SCANNER_PROBE_CLEANUP_UNKNOWN",
					)
			})
			emitter.on("link", onLink)
			if (this.isStopping(rec)) return
		}
		rec.state = "confirming"
		this.emit("probe-state", rec.probeId, "confirming", req)
		if (this.isStopping(rec)) return
		// req.holdMs is the class total: leave the later modes their own holds inside it (§ 6.4).
		const laterHoldMs = rec.modes.slice(1).reduce((sum, m) => sum + m.holdMs, 0)
		const holdMs =
			rec.modeIndex === 0
				? Math.max(mode.holdMs, req.holdMs - laterHoldMs)
				: mode.holdMs
		rec.modeTimer = setTimeout(() => {
			rec.modeTimer = null
			void this.onModeTimeout(rec).catch((err: unknown) => {
				this.log.warn(
					{ err, probeId: rec.probeId },
					"Probe mode cleanup failed",
				)
			})
		}, holdMs)
		rec.modeTimer.unref()
	}

	private async onModeTimeout(rec: ProbeRecord): Promise<void> {
		if (this.isStopping(rec) || rec.confirmed || rec.state !== "confirming")
			return
		for (const p of rec.mode.covers)
			if (!rec.fullHoldCovers.includes(p)) rec.fullHoldCovers.push(p)
		const next = rec.modeIndex + 1
		if (next >= rec.modes.length) return
		let ctx: TransportContext
		if (rec.req.replay !== undefined) ctx = replayContext(rec.req)
		else {
			const engine = this.deps.engines(rec.req.sourceId)
			if (!engine) return
			const epoch = engine.currentEpoch()
			if (epoch.epoch !== rec.epoch) return
			ctx = {
				req: rec.req,
				epoch,
				format: engine.format,
				sampleRateHz: epoch.sampleRateHz,
			}
		}
		const nextMode = rec.modes[next]!
		if (!rec.transport.supports(nextMode, ctx)) return
		rec.stepping = true
		await this.teardown(rec)
		// A stop during the teardown cancelled the step and finishes the probe itself.
		if (this.destroyed || !rec.stepping) return
		rec.stepping = false
		this.records.delete(rec.probeId)
		this.start(rec.req, rec.modes, next, rec.transport, ctx, rec.probeId, {
			calls: rec.calls,
			recordDir: rec.recordDir,
			fullHoldCovers: rec.fullHoldCovers,
		})
	}

	private teardown(rec: ProbeRecord): Promise<void> {
		if (rec.teardownDone) return rec.teardownDone
		let resolve!: () => void
		let reject!: (cause: unknown) => void
		rec.teardownDone = new Promise<void>((yes, no) => {
			resolve = yes
			reject = no
		})
		void rec.teardownDone.catch(() => undefined)
		// Untap/removal callbacks may synchronously request this same teardown again.
		void this.runTeardown(rec).then(resolve, reject)
		return rec.teardownDone
	}

	private async runTeardown(rec: ProbeRecord): Promise<void> {
		rec.accepting = false
		rec.state = "stopping"
		if (rec.modeTimer) clearTimeout(rec.modeTimer)
		rec.modeTimer = null
		this.byDecoder.delete(rec.decoderId)
		const attempt = async (
			action: () => unknown | Promise<unknown>,
		): Promise<boolean> => {
			try {
				await action()
				return true
			} catch (err) {
				rec.cleanupState = "unknown"
				this.cleanupFailed = true
				this.retainedCleanup.add(rec)
				this.sealAdmission()
				this.log.warn(
					{ err, probeId: rec.probeId },
					"Probe component cleanup failed",
				)
				return false
			}
		}
		const untap = rec.untap
		const detach = rec.detach.splice(0)
		const initialUntap = attempt(() => {
			untap?.()
		}).then(ok => {
			if (ok && rec.untap === untap) rec.untap = null
		})
		const initialDetach = detach.map(off =>
			attempt(() => {
				off()
			}).then(ok => {
				if (!ok) rec.detach.push(off)
			}),
		)
		const initialInput = attempt(() => rec.input?.end())
		// Cancel an already-invoked manager create now; it may return a late resource only afterward.
		// Launch never awaits teardown, so waiting for original launch settlement cannot self-await.
		const earlyDecoderRemoval =
			rec.decoderAttempted && !rec.launchSettled
				? attempt(() =>
						this.deps.decoders.removeEphemeralDecoder(rec.decoderId),
					)
				: Promise.resolve(true)
		const earlyDvRemoval =
			rec.dvChannel && !rec.launchSettled && this.deps.digitalVoice
				? attempt(() => this.deps.digitalVoice!.removeChannel(rec.decoderId))
				: Promise.resolve(true)
		await Promise.all([
			rec.launchDone,
			earlyDecoderRemoval,
			earlyDvRemoval,
			initialUntap,
			initialInput,
			...initialDetach,
		])
		// A callback may have sealed during tap/link installation, before its return was captured.
		const lateUntap = rec.untap
		const lateDetach = rec.detach.splice(0)
		await Promise.all([
			attempt(() => {
				lateUntap?.()
			}).then(ok => {
				if (ok && rec.untap === lateUntap) rec.untap = null
			}),
			...lateDetach.map(off =>
				attempt(() => {
					off()
				}).then(ok => {
					if (!ok) rec.detach.push(off)
				}),
			),
			attempt(() => rec.input?.end()),
			rec.decoderAttempted
				? attempt(() =>
						this.deps.decoders.removeEphemeralDecoder(rec.decoderId),
					)
				: Promise.resolve(true),
			rec.dvAttempted && this.deps.digitalVoice
				? attempt(() => this.deps.digitalVoice!.removeChannel(rec.decoderId))
				: Promise.resolve(true),
			attempt(() => rec.input?.destroy()).then(ok => {
				if (ok) rec.input = null
			}),
		])
		// allocatePort resolves after its allocator has closed the temporary server.
		// Numbers are retained through that original settlement; there is no live port lease to release.
		rec.allocatedPorts.length = 0
		if (rec.cleanupState === "unknown")
			throw new WaveKitError(
				"Scanner original probe cleanup is unknown",
				"SCANNER_PROBE_CLEANUP_FAILED",
			)
		rec.cleanupState = "settled"
	}

	private async stopProbe(rec: ProbeRecord, reason: StopReason): Promise<void> {
		if (rec.state === "stopping") {
			// Another stop owns it: resolve once the decoder and channel are gone.
			if (!rec.stepping && rec.teardownDone) return rec.teardownDone
			rec.stepping = false
		}
		await this.teardown(rec)
		// A mode step reuses the probe id: never drop its successor.
		if (this.records.get(rec.probeId) !== rec) return
		this.records.delete(rec.probeId)
		this.log.debug({ probeId: rec.probeId, reason }, "Probe stopped")
		const notificationFailures: unknown[] = []
		const notify = (action: () => void): void => {
			try {
				action()
			} catch (err: unknown) {
				notificationFailures.push(err)
				this.cleanupFailed = true
				this.retainedCleanup.add(rec)
				this.sealAdmission()
			}
		}
		notify(() => {
			if (reason === "unavailable") {
				const terminal: ProbeUnavailableStop = {
					outcome: "unsupported",
					reason: "decoder-unavailable",
				}
				this.emit("probe-state", rec.probeId, "stopped", rec.req, terminal)
				return
			}
			this.emit("probe-state", rec.probeId, "stopped", rec.req)
		})
		// Settlement of pre-seal owned DV artifacts is cleanup, not reopened decoder intake.
		if (rec.recordDir && rec.cleanupState === "settled") {
			const result: ProbeRecordings = {
				probeId: rec.probeId,
				jobId: rec.req.jobId,
				req: rec.req,
				probeDir: rec.recordDir,
				calls: rec.calls,
				epochEndedAt: rec.epochEndedAt,
			}
			notify(() => {
				this.emit("recordings", result)
			})
		}
		if (notificationFailures.length > 0) throw notificationFailures[0]
		this.pump()
	}

	/**
	 * WG11 req 6.5: a replay decoder exited. A clean exit after its input ended (or any exit after output) is
	 * the end of the capture: listeners get "replay-end" before the "stopped" state and read the verdict from
	 * the evidence. A failing exit with no output ends the probe without it, so the run is cancelled, no verdict.
	 */
	private onReplayExit(rec: ProbeRecord, clean: boolean): void {
		// A failed input is never a verdict: the decoder saw part of the capture at most.
		const timer = setTimeout(() => {
			if (this.isStopping(rec)) return
			// Decided at emission: a clean end needs the input's own EOF
			// without an error AND a clean decoder exit; anything else is cancelled, no verdict.
			const complete =
				clean && rec.replayInputEnded === true && rec.replayInputFailed !== true
			const held = rec.heldEvidence ?? []
			rec.heldEvidence = []
			if (complete) {
				try {
					// The held evidence lands only now, right before the verdict.
					for (const ev of held) this.emit("evidence", rec.probeId, rec.req, ev)
					this.emit("replay-end", rec.probeId, rec.req)
				} catch (err: unknown) {
					this.log.warn(
						{ err, probeId: rec.probeId },
						"Replay-end listener failed",
					)
				}
			}
			void this.stopProbe(rec, complete ? "replay-ended" : "error").catch(
				(err: unknown) => {
					this.cleanupFailed = true
					this.retainedCleanup.add(rec)
					this.log.warn(
						{ err, probeId: rec.probeId },
						"Replay probe cleanup failed",
					)
				},
			)
		}, REPLAY_END_GRACE_MS)
		rec.detach.push(() => clearTimeout(timer))
	}

	/**
	 * WG9 req 5.4: tells listeners (identify) that this probe's decoder program
	 * cannot run, before the probe's "stopped" state. Carries no decoder text or
	 * paths; a listener failure is logged and never blocks the stop.
	 */
	private reportUnavailable(rec: ProbeRecord): void {
		this.unavailableAt.set(rec.mode.decoderType, this.now())
		this.log.warn(
			{ probeId: rec.probeId, decoderType: rec.mode.decoderType },
			"Probe decoder unavailable",
		)
		try {
			this.emit("decoder-unavailable", rec.probeId, rec.req)
		} catch (err: unknown) {
			this.log.warn(
				{ err, probeId: rec.probeId },
				"Decoder-unavailable listener failed",
			)
		}
	}

	// === output ===

	private readonly onOutput = (
		decoderId: string,
		out: DecoderOutputLike,
	): void => {
		const rec = this.byDecoder.get(decoderId)
		if (!rec || this.isStopping(rec)) return
		this.markOutput(rec)
		if (this.isStopping(rec)) return
		switch (rec.mode.decoderType) {
			case "dsd-fme": {
				const ev = toDsdFmeScannerEvent(out)
				if (!ev) return
				this.trackCall(rec, ev, out)
				this.deliver(rec, interpretDsdFme(ev, rec.interp))
				return
			}
			case "multimon-ng": {
				if (rec.capcodes)
					this.deliver(rec, rec.capcodes.interpret(out, this.now()))
				return
			}
			case "direwolf":
				this.deliver(rec, interpretDirewolf(out, rec.interp))
				return
			case "rtl433":
				this.deliver(rec, interpretRtl433(out, rec.interp))
				return
		}
	}

	private markOutput(rec: ProbeRecord): void {
		if (this.isStopping(rec)) return
		if (rec.firstOutputAt !== null) return
		const at = this.now()
		if (this.isStopping(rec)) return
		rec.firstOutputAt = at
		const key = `${rec.mode.decoderType}:${rec.transport.kind}`
		const sample = rec.firstOutputAt - rec.startedAt
		const prev = this.latency.get(key)
		this.latency.set(
			key,
			prev === undefined ? sample : prev + LATENCY_ALPHA * (sample - prev),
		)
	}

	private trackCall(
		rec: ProbeRecord,
		ev: DsdFmeScannerEvent,
		out: DecoderOutputLike,
	): void {
		if (this.isStopping(rec)) return
		if (ev.kind !== "call_end") return
		const parsed = CallEndSchema.safeParse(out.data)
		if (!parsed.success || parsed.data.flags?.wavFileUpdate) return
		const d = parsed.data
		const call: ProbeCall = {
			callId: d.callId,
			startedAt: Date.parse(d.startedAt),
			endedAt: d.endedAt ? Date.parse(d.endedAt) : out.timestamp.getTime(),
			...(d.talkgroup != null ? { talkgroup: String(d.talkgroup) } : {}),
			...(d.source != null ? { source: String(d.source) } : {}),
			encrypted: d.encrypted === true || d.flags?.encrypted === true,
		}
		if (this.isStopping(rec)) return
		rec.calls.push(call)
	}

	/** P17: only evidence of the probe's epoch, stamped before that epoch ended. */
	private deliver(rec: ProbeRecord, evs: DecodeEvidence[]): void {
		for (const ev of evs) {
			if (this.isStopping(rec)) return
			if (ev.epoch !== rec.epoch) continue
			if (rec.epochEndedAt !== null && ev.at >= rec.epochEndedAt) continue
			if (ev.identity || ev.encrypted !== undefined) rec.confirmed = true
			if (rec.transport.kind === "replay") {
				// Re-review 2 #1: held until the replay's clean end (dropped when it never comes).
				const held = (rec.heldEvidence ??= [])
				if (held.length >= REPLAY_HELD_EVIDENCE_MAX) {
					// r7 B3: past the bound the replay is no verdict: dropped, the probe ends cancelled.
					rec.replayInputFailed = true
					rec.heldEvidence = []
					void this.stopProbe(rec, "error").catch((err: unknown) => {
						this.cleanupFailed = true
						this.retainedCleanup.add(rec)
						this.log.warn(
							{ err, probeId: rec.probeId },
							"Replay probe cleanup failed",
						)
					})
					return
				}
				held.push(ev)
				continue
			}
			this.emit("evidence", rec.probeId, rec.req, ev)
		}
	}
}

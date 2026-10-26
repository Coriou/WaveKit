/**
 * Evidence from configured, always-on decoders (spec § 6.4 "Ambient
 * evidence"): the same interpreters with origin "ambient", stamped with the
 * current engine epoch of the decoder's source. A decoder's acceptance memory
 * lasts one epoch; multimon capcodes pair only within a per-capcode window of
 * the multimon hold ± 2 s (§ 6.4 "two decodes … within the hold"), so a
 * 30–60 s ISM sensor still double-matches within its epoch. Matching to observations by
 * frequency and time is done by ScannerService.
 */
import { EventEmitter } from "node:events"
import { z } from "zod"
import {
	SCANNER_AMBIENT_DECODER_PROTOCOL,
	type ScannerAmbientDecoderType,
} from "@wavekit/api-types"
import type { DsdFmeLinkLine } from "../../../decoders/builtin/dsd-fme-link.js"
import type { DecoderManager } from "../../../decoders/manager.js"
import { createComponentLogger, type Logger } from "../../../utils/logger.js"
import type { TuningTrust } from "../../spectrum/types.js"
import { isTrusted } from "./ambient-trust.js"
export {
	ambientTrustFromBinding,
	type AmbientTrustBinding,
} from "./ambient-trust.js"
import type { DecodeEvidence, ScannerProtocol } from "../types.js"
import { parseAcars } from "./confirm/acars.js"
import { parseAis } from "./confirm/ais.js"
import {
	acceptAmbient,
	type AmbientInterpretCtx,
	type AmbientParsed,
} from "./confirm/ambient-decode.js"
import {
	createInterpreterState,
	type SharedConfirm,
	type SharedConfirmMemory,
	type DecoderOutputLike,
	type InterpreterState,
} from "./confirm/double-match.js"
import { interpretDirewolf } from "./confirm/direwolf.js"
import {
	interpretDsdFme,
	toDsdFmeScannerEvent,
	type DsdFmeScannerEvent,
} from "./confirm/dsd-fme.js"
import { parseMeshtastic } from "./confirm/meshtastic.js"
import { interpretRtl433 } from "./confirm/rtl433.js"
import {
	channelPassbandOf,
	rtl433FreqHz,
	windowPassbandOf,
	type ChannelPassband,
} from "./ambient-channel.js"
import { parseVdl2 } from "./confirm/vdl2.js"
import { CapcodeWindows, MULTIMON_HOLD_MS } from "./probe-pool.js"

/** The manager's placement binding on an output (sourceId, channel or null for centre reach). */
const PlacedBindingSchema = z.object({
	sourceId: z.string().min(1),
	channelHz: z.number().finite().positive().nullable(),
})

/** Channel states kept per placed decoder (its activity slots are at most a few channels). */
export const AMBIENT_PLACED_STATES_MAX = 8

function placedKey(decoderId: string, channelHz: number | string): string {
	return `${decoderId}\u0000${channelHz}`
}

/** A dsd-fme event carrying its output's placement binding (validated in `handle`). */
function withBinding(
	ev: DsdFmeScannerEvent,
	binding: unknown,
): DsdFmeScannerEvent & { provenanceBinding?: unknown } {
	return binding === undefined ? ev : { ...ev, provenanceBinding: binding }
}

export interface AmbientTarget {
	sourceId: string
	hz: number
	/** NXDN flavour of a dsd-fme decoder (its `options.mode`); unset means NXDN96. */
	nxdn?: "nxdn48" | "nxdn96"
	/** Every target frequency (WG7); `hz` is `targetsHz[0]`. */
	targetsHz: readonly number[]
	/** The decoder reads its own device (input kind `external`), not a WaveKit source. */
	external: boolean
}

/** A running config-owned ambient-only decoder whose target lies at a frequency (WG7). */
export interface AmbientCoverage {
	decoderId: string
	type: ScannerAmbientDecoderType
	protocol: ScannerProtocol
}

export interface AmbientEvidenceEvent {
	decoderId: string
	sourceId: string
	hz: number
	ev: DecodeEvidence
	/**
	 * A channel decoder (rtl433) names its whole channel: `hz` is the channel
	 * centre and the decode belongs to one observation inside this passband.
	 */
	passband?: ChannelPassband
	/** rtl_433's own usable frequency estimate inside the passband (Hz). */
	freqHz?: number
}

/** Where an ambient decode lies, for the shared confirm pairing. */
export interface AmbientPairContext {
	sourceId: string
	hz: number
	/** Decode time (ms). */
	at: number
	passband?: ChannelPassband
	freqHz?: number
	/** The decode's protocol when known before interpretation (the WG7 ambient-only types). */
	protocol?: ScannerProtocol
}

export interface AmbientDeps {
	decoders: Pick<DecoderManager, "on" | "off" | "getDecoder" | "getAllStatus"> &
		Partial<Pick<DecoderManager, "getStatus">>
	/** Configured target of a decoder (config frequencies, or caps centre + offsetHz). */
	targetOf: (decoderId: string) => AmbientTarget | null
	/** Current engine epoch of a source; null when no engine runs there. */
	epochOf: (sourceId: string) => number | null
	logger: Logger
	now?: () => number
	/** Capture sample rate of a source (its caps); the channel request's input. */
	sampleRateOf?: (sourceId: string) => number | undefined
	/** Capture centre of a source (its caps); the window reach passband. */
	centreOf?: (sourceId: string) => number | undefined
	/**
	 * Reception trust of a decoder at a frequency on the source its target names (WG7 req 1.3);
	 * absent → no new-type evidence.
	 */
	tuningTrustOf?: (
		decoderId: string,
		hz: number,
		sourceId: string,
	) => TuningTrust | undefined
	/**
	 * shared per-discovery acceptance (ConfirmMemory) and the scope (discovery)
	 * a decode lies on; null scope or absent: the decoder's own memory decides.
	 */
	confirm?: {
		memory: SharedConfirmMemory
		scopeOf: (ctx: AmbientPairContext) => string | null
	}
}

/** Acceptance memory of one decoder for one epoch; multimon keeps it per capcode (interp null). */
interface AmbientState {
	epoch: number
	interp: InterpreterState | null
	capcodes: CapcodeWindows | null
	/** Where the decode being interpreted lies; set only while it is interpreted. */
	pairCtx: AmbientPairContext | null
}

type AmbientParser = (
	out: DecoderOutputLike,
	ctx: AmbientInterpretCtx,
) => AmbientParsed | null

/** WG7 ambient-only types: trust-gated, emitted at the decode's own frequency. */
const NEW_INTERPRETERS: ReadonlyMap<string, AmbientParser> = new Map<
	ScannerAmbientDecoderType,
	AmbientParser
>([
	["ais-catcher", parseAis],
	["acarsdec", parseAcars],
	["dumpvdl2", parseVdl2],
	["lora-meshtastic", parseMeshtastic],
])

const AMBIENT_TYPES = new Set([
	"dsd-fme",
	"multimon-ng",
	"direwolf",
	"rtl433",
	...NEW_INTERPRETERS.keys(),
])

export class AmbientEvidence extends EventEmitter {
	private readonly log: Logger
	private readonly now: () => number
	private readonly states = new Map<string, AmbientState>()
	private readonly types = new Map<string, string>()
	/** Per watched dsd-fme decoder: removes its `link` listener. */
	private readonly detach = new Map<string, () => void>()
	private running = false
	/** New-type decodes dropped because trust was not commanded/relay or its lookup threw. */
	private trustDrops = 0
	private readonly trustErrorLogged = new Set<string>()

	constructor(private readonly deps: AmbientDeps) {
		super()
		this.log = createComponentLogger(deps.logger, "AmbientEvidence")
		this.now = deps.now ?? Date.now
	}

	start(): void {
		if (this.running) return
		this.running = true
		for (const status of this.deps.decoders.getAllStatus()) this.watch(status)
		this.deps.decoders.on("decoder:output", this.onOutput)
		this.deps.decoders.on("decoder:placed-link", this.onPlacedLink)
		// Decoders created or removed after start (API, config reload) join or leave the watched set.
		this.deps.decoders.on("decoder:created", this.onCreated)
		this.deps.decoders.on("decoder:removed", this.onRemoved)
		this.log.info(
			{ decoders: [...this.types.keys()] },
			"Ambient evidence attached",
		)
	}

	stop(): void {
		if (!this.running) return
		this.running = false
		this.deps.decoders.off("decoder:output", this.onOutput)
		this.deps.decoders.off("decoder:placed-link", this.onPlacedLink)
		this.deps.decoders.off("decoder:created", this.onCreated)
		this.deps.decoders.off("decoder:removed", this.onRemoved)
		for (const off of this.detach.values()) off()
		this.detach.clear()
		this.states.clear()
		this.types.clear()
		this.trustErrorLogged.clear()
	}

	/** Ids of the decoders watched now (for tests and stats). */
	get watchedDecoderIds(): readonly string[] {
		return [...this.types.keys()]
	}

	/**
	 * Watches one config-owned ambient decoder: its type, and for dsd-fme its `link` lines. A
	 * decoder already watched under this id is unwatched first, so a re-created id never keeps
	 * the former instance's listener. The set is bounded by the manager's own decoders.
	 */
	private watch(status: {
		id: string
		type: string
		owner?: string | undefined
	}): void {
		this.unwatch(status.id)
		if (status.owner === "scanner" || !AMBIENT_TYPES.has(status.type)) return
		this.types.set(status.id, status.type)
		if (status.type !== "dsd-fme") return
		const decoder = this.deps.decoders.getDecoder(status.id) as unknown as
			| EventEmitter
			| undefined
		if (!decoder) return
		const id = status.id
		// A placed decoder's line carries its binding (set by the manager), like its outputs.
		const onLink = (line: DsdFmeLinkLine): void =>
			this.handle(
				id,
				withBinding(
					{ kind: "link", line },
					(line as { provenanceBinding?: unknown }).provenanceBinding,
				),
			)
		decoder.on("link", onLink)
		this.detach.set(id, () => decoder.off("link", onLink))
	}

	private unwatch(decoderId: string): void {
		const off = this.detach.get(decoderId)
		this.detach.delete(decoderId)
		off?.()
		this.types.delete(decoderId)
		this.states.delete(decoderId)
		const prefix = placedKey(decoderId, "")
		for (const key of [...this.states.keys()])
			if (key.startsWith(prefix)) this.states.delete(key)
		this.trustErrorLogged.delete(decoderId)
	}

	/** At most AMBIENT_PLACED_STATES_MAX channel states per decoder; the least recently heard go. */
	private boundPlaced(decoderId: string, added: string): void {
		const prefix = placedKey(decoderId, "")
		const mine = [...this.states.keys()].filter(k => k.startsWith(prefix))
		for (const key of mine.slice(
			0,
			Math.max(0, mine.length - AMBIENT_PLACED_STATES_MAX),
		))
			if (key !== added) this.states.delete(key)
	}

	private readonly onCreated = (decoderId: unknown): void => {
		if (!this.running || typeof decoderId !== "string") return
		try {
			const getStatus = this.deps.decoders.getStatus
			const status = getStatus
				? getStatus.call(this.deps.decoders, decoderId)
				: this.deps.decoders.getAllStatus().find(s => s.id === decoderId)
			if (status) this.watch(status)
			else this.unwatch(decoderId)
		} catch {
			// A failing status read watches nothing (fail closed).
			this.unwatch(decoderId)
		}
	}

	private readonly onRemoved = (decoderId: unknown): void => {
		if (!this.running || typeof decoderId !== "string") return
		this.unwatch(decoderId)
	}

	/** Dropped new-type decodes (untrusted, unknown trust or throwing lookup); for tests and stats. */
	get trustDropCount(): number {
		return this.trustDrops
	}

	/**
	 * WG7: running config-owned ambient-only decoders on `sourceId` with a target within
	 * `toleranceHz` of `hz`, sorted by decoder id. Status is read now; [] when not started.
	 */
	coverageAt(
		sourceId: string,
		hz: number,
		toleranceHz: number,
	): readonly AmbientCoverage[] {
		if (!this.running) return []
		const out: AmbientCoverage[] = []
		for (const [decoderId, type] of this.types) {
			if (!NEW_INTERPRETERS.has(type)) continue
			let target: AmbientTarget | null
			try {
				target = this.deps.targetOf(decoderId)
			} catch {
				continue
			}
			if (!target || target.external !== false || target.sourceId !== sourceId)
				continue
			if (!target.targetsHz?.some(t => Math.abs(t - hz) <= toleranceHz))
				continue
			if (!this.eligible(decoderId)) continue
			const ambientType = type as ScannerAmbientDecoderType
			out.push({
				decoderId,
				type: ambientType,
				protocol: SCANNER_AMBIENT_DECODER_PROTOCOL[ambientType],
			})
		}
		return out.sort((a, b) =>
			a.decoderId < b.decoderId ? -1 : a.decoderId > b.decoderId ? 1 : 0,
		)
	}

	/**
	 * Decoder part of the trust rule (req 1.3): running, healthy, not suspended and positively
	 * config-owned (a missing owner is not eligible; fail closed). New types only.
	 */
	private eligible(decoderId: string): boolean {
		const getStatus = this.deps.decoders.getStatus
		if (!getStatus) return false
		let status: ReturnType<DecoderManager["getStatus"]>
		try {
			status = getStatus.call(this.deps.decoders, decoderId)
		} catch {
			return false
		}
		return (
			status !== undefined &&
			status.running &&
			(status.health === "running" || status.health === "idle") &&
			status.suspended !== true &&
			status.owner === "config"
		)
	}

	/** Trust at `hz`; any failure is undefined (fail closed), logged once per decoder without values. */
	private trustAt(
		decoderId: string,
		hz: number,
		sourceId: string,
	): TuningTrust | undefined {
		const of = this.deps.tuningTrustOf
		if (!of) return undefined
		try {
			return of(decoderId, hz, sourceId)
		} catch {
			if (!this.trustErrorLogged.has(decoderId)) {
				this.trustErrorLogged.add(decoderId)
				this.log.warn({ decoderId }, "Ambient tuning trust lookup failed")
			}
			return undefined
		}
	}

	/** The shared pairing of `entry`'s interpreter states: asked with the decode in hand. */
	private pairing(entry: AmbientState): { shared?: SharedConfirm } {
		const confirm = this.deps.confirm
		if (!confirm) return {}
		return {
			shared: {
				memory: confirm.memory,
				scope: () => {
					const ctx = entry.pairCtx
					return ctx === null ? null : confirm.scopeOf(ctx)
				},
			},
		}
	}

	private handleNew(
		decoderId: string,
		parse: AmbientParser,
		out: DecoderOutputLike,
	): void {
		if (!this.running) return
		const target = this.deps.targetOf(decoderId)
		if (!target || target.external !== false) return
		const targetsHz = target.targetsHz
		// Still checked at run time: a target is external data from the config (fail closed).
		if (!Array.isArray(targetsHz) || targetsHz.length === 0) return
		const epoch = this.deps.epochOf(target.sourceId)
		if (epoch === null) return
		if (!this.eligible(decoderId)) return
		// Parse against every target, then one trust lookup at the decode's own frequency BEFORE
		// acceptance memory is touched: an untrusted decode never primes the H2 match.
		const parsed = parse(out, { targetsHz })
		if (parsed === null) return
		if (!isTrusted(this.trustAt(decoderId, parsed.hz, target.sourceId))) {
			this.trustDrops++
			return
		}
		let entry = this.states.get(decoderId)
		if (!entry || entry.epoch !== epoch) {
			const fresh: AmbientState = {
				epoch,
				interp: null,
				capcodes: null,
				pairCtx: null,
			}
			fresh.interp = createInterpreterState({
				epoch,
				origin: "ambient",
				decoderId,
				...this.pairing(fresh),
			})
			entry = fresh
			this.states.set(decoderId, entry)
		}
		if (entry.interp === null) return
		const at = parsed.timestamp.getTime()
		let decodes: ReturnType<typeof acceptAmbient>
		entry.pairCtx = {
			sourceId: target.sourceId,
			hz: parsed.hz,
			at,
			protocol: parsed.protocol,
		}
		try {
			decodes = acceptAmbient(entry.interp, parsed)
		} finally {
			entry.pairCtx = null
		}
		for (const decode of decodes) {
			const { hz, ...ev } = decode
			const event: AmbientEvidenceEvent = {
				decoderId,
				sourceId: target.sourceId,
				hz,
				ev,
			}
			this.emit("evidence", event)
		}
	}

	/**
	 * The passband of the channel that produced `out`: its placement binding and
	 * the decoder's channel request for the capture it reads. Any failure is
	 * null; the caller then drops the decode.
	 */
	private channelPassband(
		decoderId: string,
		out: DecoderOutputLike,
		sourceId: string,
	): ReturnType<typeof channelPassbandOf> {
		try {
			const binding = out.provenanceBinding
			const channelHz =
				binding && typeof binding === "object"
					? (binding as { channelHz?: unknown }).channelHz
					: undefined
			const sampleRateHz = this.deps.sampleRateOf?.(sourceId)
			// Window reach (no channel): the whole capture.
			if (channelHz === null)
				return windowPassbandOf(binding, {
					centreHz: this.deps.centreOf?.(sourceId),
					sampleRateHz,
				})
			if (typeof channelHz !== "number") return null
			if (
				typeof sampleRateHz !== "number" ||
				!Number.isFinite(sampleRateHz) ||
				sampleRateHz <= 0
			)
				return null
			const request = this.deps.decoders
				.getDecoder(decoderId)
				?.getChannelRequest?.({ sampleRateHz, centerHz: channelHz })
			if (!request || "invalid" in request) return null
			return channelPassbandOf(binding, request.bandwidthHz)
		} catch {
			return null
		}
	}

	private readonly onOutput = (
		decoderId: string,
		out: DecoderOutputLike,
	): void => {
		const type = this.types.get(decoderId)
		if (!type) return
		const interpret = NEW_INTERPRETERS.get(type)
		if (interpret) {
			try {
				this.handleNew(decoderId, interpret, out)
			} catch {
				// Anything throwing is no evidence (req 1.3).
			}
			return
		}
		if (type === "dsd-fme") {
			const ev = toDsdFmeScannerEvent(out)
			// A placed channel's call keeps its binding, so it lands on that channel.
			if (ev) this.handle(decoderId, withBinding(ev, out.provenanceBinding))
			return
		}
		this.handle(decoderId, out)
	}

	/** A placed dsd-fme channel's link line (the manager forwards it with the binding). */
	private readonly onPlacedLink = (
		decoderId: unknown,
		line: unknown,
		binding: unknown,
	): void => {
		if (typeof decoderId !== "string") return
		if (this.types.get(decoderId) !== "dsd-fme") return
		if (binding === undefined || line === null || typeof line !== "object")
			return
		this.handle(
			decoderId,
			withBinding({ kind: "link", line: line as DsdFmeLinkLine }, binding),
		)
	}

	private handle(
		decoderId: string,
		input: Parameters<typeof interpretDsdFme>[0] | DecoderOutputLike,
	): void {
		if (!this.running) return
		const target = this.deps.targetOf(decoderId)
		if (!target) return
		const epoch = this.deps.epochOf(target.sourceId)
		if (epoch === null) return
		const type = this.types.get(decoderId)
		// A placed point decoder (a multimon-ng or dsd-fme channel the planner put on a band-plan
		// channel) hears its own channel, not the parent's target: its binding names it. A binding
		// on another source drops the output (fail closed); a centre-reach binding keeps the target.
		const raw =
			type !== "rtl433"
				? (input as DecoderOutputLike).provenanceBinding
				: undefined
		const binding =
			raw === undefined ? undefined : PlacedBindingSchema.safeParse(raw)
		if (binding !== undefined && !binding.success) return
		if (
			binding?.data.sourceId !== undefined &&
			binding.data.sourceId !== target.sourceId
		)
			return
		const placedHz = binding?.data.channelHz ?? undefined
		// Each placed channel keeps its own acceptance memory: a colour code or capcode heard on
		// one channel never confirms a decode on another.
		const key =
			placedHz === undefined ? decoderId : placedKey(decoderId, placedHz)
		let entry = this.states.get(key)
		if (!entry || entry.epoch !== epoch) {
			const fresh: AmbientState = {
				epoch,
				interp: null,
				capcodes: null,
				pairCtx: null,
			}
			const create = (): InterpreterState =>
				createInterpreterState({
					epoch,
					origin: "ambient",
					decoderId,
					...(target.nxdn !== undefined ? { nxdn: target.nxdn } : {}),
					...this.pairing(fresh),
				})
			if (type === "multimon-ng")
				fresh.capcodes = new CapcodeWindows(MULTIMON_HOLD_MS, create)
			else fresh.interp = create()
			entry = fresh
			this.states.set(key, entry)
			if (placedHz !== undefined) this.boundPlaced(decoderId, key)
		} else if (placedHz !== undefined) {
			// most recently used last: the bound evicts the channel heard longest ago
			this.states.delete(key)
			this.states.set(key, entry)
		}
		// A placed rtl433 output (it carries a binding) names its channel; an
		// invalid binding, another source or an unusable channel request drops
		// the output BEFORE the interpreter sees it, so a dropped output never
		// primes acceptance. Only an unplaced instance keeps the point target.
		const placed =
			type === "rtl433" &&
			(input as DecoderOutputLike).provenanceBinding !== undefined
		const passband = placed
			? this.channelPassband(
					decoderId,
					input as DecoderOutputLike,
					target.sourceId,
				)
			: null
		const onSource = passband?.sourceId === target.sourceId ? passband : null
		if (placed && !onSource) return
		const state = entry.interp
		const freqHz = onSource
			? rtl433FreqHz((input as DecoderOutputLike).data, onSource)
			: undefined
		const at = decodeTime(input, this.now())
		entry.pairCtx = {
			sourceId: target.sourceId,
			hz: onSource ? onSource.centreHz : (placedHz ?? target.hz),
			at,
			...(onSource
				? {
						passband: { centreHz: onSource.centreHz, halfHz: onSource.halfHz },
						...(freqHz !== undefined ? { freqHz } : {}),
					}
				: {}),
		}
		let evs: DecodeEvidence[] = []
		try {
			if (entry.capcodes)
				evs = entry.capcodes.interpret(input as DecoderOutputLike, this.now())
			else if (state === null) return
			else if (type === "dsd-fme")
				evs = interpretDsdFme(
					input as Parameters<typeof interpretDsdFme>[0],
					state,
				)
			else if (type === "direwolf")
				evs = interpretDirewolf(input as DecoderOutputLike, state)
			else if (type === "rtl433")
				evs = interpretRtl433(input as DecoderOutputLike, state)
		} finally {
			entry.pairCtx = null
		}
		for (const ev of evs) {
			const event: AmbientEvidenceEvent = {
				decoderId,
				sourceId: target.sourceId,
				hz: onSource ? onSource.centreHz : (placedHz ?? target.hz),
				ev,
				...(onSource
					? {
							passband: {
								centreHz: onSource.centreHz,
								halfHz: onSource.halfHz,
							},
							...(freqHz !== undefined ? { freqHz } : {}),
						}
					: {}),
			}
			this.emit("evidence", event)
		}
	}
}

/** The decode time of an ambient output (ms): its own timestamp when valid, else `fallback`. */
function decodeTime(input: unknown, fallback: number): number {
	const ts =
		typeof input === "object" && input !== null
			? (input as { timestamp?: unknown; at?: unknown })
			: {}
	if (ts.timestamp instanceof Date) {
		const t = ts.timestamp.getTime()
		if (Number.isFinite(t)) return t
	}
	if (typeof ts.at === "number" && Number.isFinite(ts.at)) return ts.at
	return fallback
}

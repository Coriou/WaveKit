/**
 * Evidence from configured, always-on decoders (spec § 6.4 "Ambient
 * evidence"): the same interpreters with origin "ambient", stamped with the
 * current engine epoch of the decoder's source. A decoder's acceptance memory
 * lasts one epoch; multimon capcodes pair only within a per-capcode window of
 * the multimon hold ± 2 s (§ 6.4 "two decodes … within the hold"), so a
 * 30–60 s ISM sensor still double-matches within its epoch. Matching to observations by
 * frequency and time is done by ScannerService.
 */
import { ConfirmMemory } from "./confirm/confirm-memory.js"
import { createHash } from "node:crypto"
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
	guardDsdFmeEvidence,
	toDsdFmeScannerEvent,
	type DsdFmeScannerEvent,
} from "./confirm/dsd-fme.js"
import { parseMeshtastic } from "./confirm/meshtastic.js"
import { parseReadsb, ReadsbStateMemory } from "./confirm/readsb.js"
import { interpretRtl433 } from "./confirm/rtl433.js"
import {
	channelPassbandOf,
	rtl433FreqHz,
	windowPassbandOf,
	type ChannelPassband,
} from "./ambient-channel.js"
import { parseVdl2 } from "./confirm/vdl2.js"
import { PLACED_CHANNELS_PER_DECODER_MAX } from "../../../decoders/enablement/contract.js"
import { CapcodeWindows, MULTIMON_HOLD_MS } from "./probe-pool.js"

/** The manager's placement binding on an output (sourceId, channel or null for centre reach). */
const PlacedBindingSchema = z.object({
	sourceId: z.string().min(1),
	channelHz: z.number().finite().positive().nullable(),
})

/** Channel states kept per placed decoder (its activity slots are at most a few channels). */
/**
 * Channel states kept per placed decoder: the most channel placements one decoder can hold
 * (PLACED_CHANNELS_PER_DECODER_MAX = 49, see its arithmetic), so every placed channel keeps its
 * memory however many run. Each state is one interpreter's acceptance memory (DoubleMatch: at
 * most 256 values per key and 4 096 accepted values; a multimon state holds up to 1 024 capcode
 * windows), as one decoder held before per-channel states. States of channels that are no longer
 * placed are dropped first, so the count follows the decoder's live placements; the bound is the
 * backstop when placements cannot be read.
 */
export const AMBIENT_PLACED_STATES_MAX = PLACED_CHANNELS_PER_DECODER_MAX

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
	/** Shared by all evidence items from one decoder output, for debug-log deduplication. */
	decodeToken?: object
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
	message?: string | undefined
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
		placement?: { sourceId: string; channelHz: number | null },
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
	/** ADS-B: the last raw frame per address (an exact repeat is not a second message). */
	frames?: Map<string, string>
	readsbStates?: ReadsbStateMemory
}

/**
 * Addresses whose last raw frame one readsb state remembers: the DoubleMatch accepted-value
 * bound (4 096), far above the few hundred aircraft one receiver hears. Least recent go first;
 * each entry is a 6-digit address and a frame of at most 28 hex digits (under 100 B).
 */
export const ADSB_FRAMES_MAX = 4096

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
	["readsb", parseReadsb],
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

	/**
	 * After a new channel state: drop the decoder's states whose channel has no placement any
	 * more (when its placements can be read), then, beyond AMBIENT_PLACED_STATES_MAX, the least
	 * recently heard. The state just added is never dropped.
	 */
	private boundPlaced(decoderId: string, added: string): void {
		const prefix = placedKey(decoderId, "")
		let mine = [...this.states.keys()].filter(k => k.startsWith(prefix))
		const placed = this.placedChannels(decoderId)
		if (placed !== null) {
			for (const key of mine)
				if (key !== added && !placed.has(key.slice(prefix.length)))
					this.states.delete(key)
			mine = mine.filter(k => this.states.has(k))
		}
		const over = mine.length - AMBIENT_PLACED_STATES_MAX
		if (over <= 0) return
		for (const key of mine.filter(k => k !== added).slice(0, over))
			this.states.delete(key)
	}

	/** The decoder's placed channel frequencies (as key suffixes); null when unknown. */
	private placedChannels(decoderId: string): Set<string> | null {
		try {
			const getStatus = this.deps.decoders.getStatus
			const status = getStatus
				? getStatus.call(this.deps.decoders, decoderId)
				: this.deps.decoders.getAllStatus().find(s => s.id === decoderId)
			const placements: unknown = (
				status as { placements?: unknown } | undefined
			)?.placements
			if (!Array.isArray(placements)) return null
			const out = new Set<string>()
			for (const p of placements) {
				const hz: unknown = (p as { channelHz?: unknown } | null)?.channelHz
				if (typeof hz === "number" && Number.isFinite(hz)) out.add(String(hz))
			}
			return out
		} catch {
			return null
		}
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
		placement?: { sourceId: string; channelHz: number | null },
	): TuningTrust | undefined {
		const of = this.deps.tuningTrustOf
		if (!of) return undefined
		try {
			return of(decoderId, hz, sourceId, placement)
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
		if (!confirm)
			return {
				shared: {
					memory: new ConfirmMemory(this.now),
					message: () => entry.pairCtx?.message ?? null,
					scope: () => {
						const ctx = entry.pairCtx
						return ctx ? `${ctx.sourceId}:${ctx.hz}` : null
					},
				},
			}
		return {
			shared: {
				memory: confirm.memory,
				requireScope: true,
				message: () => entry.pairCtx?.message ?? null,
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
		// Parse against every target, then one trust lookup at the placed channel BEFORE
		// acceptance memory is touched: an untrusted decode never primes the H2 match.
		const rawBinding = out.provenanceBinding
		const binding =
			rawBinding === undefined
				? undefined
				: PlacedBindingSchema.safeParse(rawBinding)
		if (
			binding &&
			(!binding.success || binding.data.sourceId !== target.sourceId)
		)
			return
		const placement = binding?.data
		const channelHz =
			placement?.channelHz ??
			(!placement && targetsHz.length === 1 ? targetsHz[0] : undefined)
		const passband = placement
			? this.channelPassband(decoderId, out, target.sourceId)
			: null
		if (placement && !passband) return
		const parsed = parse(out, {
			targetsHz:
				channelHz === undefined ? targetsHz : [...targetsHz, channelHz],
			...(channelHz !== undefined ? { channelHz } : {}),
		})
		if (
			parsed &&
			passband &&
			Math.abs(parsed.hz - passband.centreHz) > passband.halfHz
		)
			return
		if (parsed === null) return
		if (
			!isTrusted(
				this.trustAt(
					decoderId,
					placement?.channelHz ?? parsed.hz,
					target.sourceId,
					placement
						? { sourceId: placement.sourceId, channelHz: placement.channelHz }
						: undefined,
				),
			)
		) {
			this.trustDrops++
			return
		}
		const adsb = parsed.protocol === "adsb"
		const stateKey = placedKey(decoderId, parsed.hz)
		let entry = this.states.get(stateKey)
		if (!entry || entry.epoch !== epoch) {
			const fresh: AmbientState = {
				epoch,
				interp: null,
				capcodes: null,
				pairCtx: null,
			}
			// ADS-B keeps decoder-local confirmation: distinct CRC-proven Beast frames or
			// advancing aircraft state records (with their own 2 s separation gate below).
			// Every other type shares the discovery's pairing.
			fresh.interp = createInterpreterState({
				epoch,
				origin: "ambient",
				requirePair: true,
				decoderId,
				...(adsb ? {} : this.pairing(fresh)),
			})
			if (adsb) {
				fresh.frames = new Map()
				fresh.readsbStates = new ReadsbStateMemory()
			}
			entry = fresh
			this.states.set(stateKey, entry)
			this.boundPlaced(decoderId, stateKey)
		}
		if (entry.interp === null) return
		if (parsed.readsbState) {
			const address = parsed.identity.value
			if (address === undefined || !entry.readsbStates?.accept(parsed)) return
			// The state rule has independently paired two advancing records. Do not pair a
			// first state with a Beast frame or a record from another decoder.
			entry.interp.match.markAccepted(parsed.identity.key, address)
		}
		const frames = entry.frames
		const address = parsed.identity.value
		if (frames && parsed.frame !== undefined && address !== undefined) {
			if (frames.get(address) === parsed.frame) return
			frames.delete(address)
			frames.set(address, parsed.frame)
			while (frames.size > ADSB_FRAMES_MAX) {
				const oldest = frames.keys().next()
				if (oldest.done === true) break
				frames.delete(oldest.value)
			}
		}
		const at = parsed.timestamp.getTime()
		let decodes: ReturnType<typeof acceptAmbient>
		let message: string | null | undefined = null
		const decoderType = adsb ? "" : (this.types.get(decoderId) ?? "")
		entry.pairCtx = adsb
			? null
			: {
					sourceId: target.sourceId,
					hz: parsed.hz,
					at,
					protocol: parsed.protocol,
					get message() {
						if (message === null) message = messageOf(decoderType, out.data)
						return message
					},
				}
		try {
			decodes = acceptAmbient(entry.interp, parsed)
		} finally {
			entry.pairCtx = null
		}
		const decodeToken = {}
		for (const decode of decodes) {
			// readsb hears every aircraft in range continuously: an unpaired Mode S message is no
			// evidence (no observation, discovery or activity from it); only an accepted ICAO is.
			if (parsed.protocol === "adsb" && !decode.identity) continue
			const { hz, ...ev } = decode
			const event: AmbientEvidenceEvent = {
				decoderId,
				sourceId: target.sourceId,
				hz,
				ev,
			}
			Object.defineProperty(event, "decodeToken", { value: decodeToken })
			this.emit("evidence", event)
		}
	}

	// The passband of the channel that produced `out`: its placement binding and
	// the decoder's channel request for the capture it reads. Any failure is
	// null; the caller then drops the decode.
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
		if (type === undefined) return
		// A placed point decoder (a multimon-ng or dsd-fme channel the planner put on a band-plan
		// channel) hears its own channel, not the parent's target: its binding names it. A binding
		// on another source drops the output (fail closed); a centre-reach binding keeps the target.
		const raw = (input as DecoderOutputLike).provenanceBinding
		const binding =
			raw === undefined ? undefined : PlacedBindingSchema.safeParse(raw)
		if (binding !== undefined && !binding.success) return
		if (
			binding?.data.sourceId !== undefined &&
			binding.data.sourceId !== target.sourceId
		)
			return
		const placedHz = binding?.data.channelHz ?? undefined
		// Every ambient decoder proves receiver provenance before acceptance is touched.
		if (
			target.external !== false ||
			!this.eligible(decoderId) ||
			!isTrusted(
				this.trustAt(
					decoderId,
					placedHz ?? target.hz,
					target.sourceId,
					binding?.data,
				),
			)
		) {
			this.trustDrops++
			return
		}
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
					requirePair: true,
					decoderId,
					...(target.nxdn !== undefined ? { nxdn: target.nxdn } : {}),
					...this.pairing(fresh),
				})
			if (type === "multimon-ng")
				fresh.capcodes = new CapcodeWindows(MULTIMON_HOLD_MS, create)
			fresh.interp = create()
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
		const protocol = pointProtocol(type, input, target.nxdn)
		let message: string | null | undefined = null
		entry.pairCtx = {
			...(protocol ? { protocol } : {}),
			sourceId: target.sourceId,
			hz: onSource ? onSource.centreHz : (placedHz ?? target.hz),
			at,
			get message() {
				if (message === null)
					message = messageOf(
						type,
						(input as DecoderOutputLike).data ??
							(input as { line?: unknown }).line ??
							input,
					)
				return message
			},
			...(onSource
				? {
						passband: { centreHz: onSource.centreHz, halfHz: onSource.halfHz },
						...(freqHz !== undefined ? { freqHz } : {}),
					}
				: {}),
		}
		let evs: DecodeEvidence[] = []
		try {
			if (
				type === "multimon-ng" &&
				(input as DecoderOutputLike).type === "decode" &&
				state
			) {
				const data = (input as DecoderOutputLike).data
				if (
					data &&
					typeof data === "object" &&
					(data as { protocol?: unknown }).protocol === "AFSK1200"
				)
					evs = interpretDirewolf(
						{
							...(input as DecoderOutputLike),
							type: "aprs",
							data: { source: (data as { from?: unknown }).from },
						},
						state,
					)
			} else if (entry.capcodes)
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
		const decodeToken = {}
		for (const raw of evs) {
			const ev = guardDsdFmeEvidence(
				raw,
				placedHz ?? target.hz,
				this.deps.centreOf?.(target.sourceId),
			)
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
			Object.defineProperty(event, "decodeToken", { value: decodeToken })
			this.emit("evidence", event)
		}
	}
}

/** The decode time of an ambient output (ms): its own timestamp when valid, else `fallback`. */
function decodeTime(input: unknown, fallback: number): number {
	const ts =
		typeof input === "object" && input !== null
			? (input as {
					timestamp?: unknown
					at?: unknown
					kind?: unknown
					line?: { at?: unknown }
				})
			: {}
	if (ts.timestamp instanceof Date) {
		const t = ts.timestamp.getTime()
		if (Number.isFinite(t)) return t
	}
	if (typeof ts.at === "number" && Number.isFinite(ts.at)) return ts.at
	if (ts.kind === "link") {
		const parsed = z.number().finite().safeParse(ts.line?.at)
		if (parsed.success) return parsed.data
	}
	return fallback
}

/** Reception metadata never creates a second logical message. */
const MESSAGE_METADATA =
	/^(?:level|noise|noise_?floor|(?:rx_?)?rssi|(?:rx_?)?snr|error|errorknown|crcerr|fecerrs|lastseen|mod|modulation|frequency|frequencymalformed|freq|freq1|freq2|channel|at|time|.*time.*|mic)$/i

/** Protocol content identity, or undefined when the DTO has no message content. */
function messageOf(type: string, data: unknown): string | undefined {
	if (!data || typeof data !== "object") return undefined
	const record = data as Record<string, unknown>
	let content: unknown = data
	if (type === "acarsdec") {
		// Blocks share a logical message number; block ID, text and reception differ.
		if (typeof record["msgno"] === "string" && record["msgno"] !== "")
			content = {
				tail: record["tail"],
				flight: record["flight"],
				// acarsdec joins the three-character number and block letter;
				// dumpvdl2 already supplies the three-character msg_num unchanged.
				msgno: record["msgno"].replace(/^(.{3})[A-Z]$/i, "$1"),
			}
		else if (typeof record["text"] !== "string" || record["text"] === "")
			return undefined
		else
			content = {
				tail: record["tail"],
				flight: record["flight"],
				text: record["text"],
				label: record["label"],
			}
	} else if (type === "dumpvdl2") {
		const acars = record["acars"]
		const message =
			acars && typeof acars === "object"
				? messageOf("acarsdec", acars)
				: typeof record["text"] === "string" && record["text"] !== ""
					? record["text"]
					: undefined
		if (!message) return undefined
		content = {
			fromaddr: record["fromaddr"],
			toaddr: record["toaddr"],
			message,
		}
	} else if (type === "ais-catcher") {
		content = fields(record, [
			"mmsi",
			"name",
			"callsign",
			"imo",
			"shipType",
			"lat",
			"lon",
			"cog",
			"sog",
			"heading",
			"navStatus",
			"destination",
			"eta",
			"draught",
			"messageType",
			"altitudeM",
			"aidType",
			"virtualAid",
			"offPosition",
		])
	} else if (type === "lora-meshtastic") {
		content = fields(record, ["from", "to", "id", "portnum", "payloadB64"])
	} else if (type === "dsd-fme") {
		// Checked DMR control bursts are independent transmissions once the shared
		// spacing guard passes, even when CC/slot (or printed CSBK content) repeats.
		// The parser only verifies checked burst types; sync/CC hints cannot prime H2.
		// Keep voice LC and any TG/SRC-bearing evidence on the content-aware rule.
		if (
			record["protocol"] === "dmr" &&
			record["verified"] === true &&
			record["crcErr"] === false &&
			(record["fecErrs"] === undefined || record["fecErrs"] === 0) &&
			record["voiceLc"] !== true &&
			record["tg"] === undefined &&
			record["src"] === undefined
		)
			return undefined
		content = fields(record, [
			"protocol",
			"cc",
			"tg",
			"src",
			"slot",
			"nac",
			"ran",
			"dgid",
			"callsign",
			"encrypted",
			"callId",
			"talkgroup",
			"source",
		])
	} else if (type === "multimon-ng" && record["protocol"] === "AFSK1200") {
		// The adapter exposes only addresses, not the APRS information field.
		return undefined
	} else if (type === "multimon-ng") {
		if (typeof record["message"] !== "string" || record["message"] === "")
			return undefined
		content = fields(record, [
			"protocol",
			"address",
			"capcode",
			"function",
			"messageType",
			"message",
		])
	} else if (type === "direwolf") {
		// The adapter's raw field is the information field. Also accept a full
		// TNC2 packet, stripping its source/destination/digipeater header only.
		const raw = record["raw"]
		const info =
			typeof record["info"] === "string"
				? record["info"]
				: typeof raw === "string"
					? raw.replace(/^[A-Z0-9-]+>[A-Z0-9-]+(?:,[A-Z0-9*-]+)*:/i, "")
					: undefined
		if (!info) return undefined
		content = {
			source: record["source"],
			destination: record["destination"],
			info,
		}
	}
	// AIS: vessel content; Meshtastic: packet ID/payload; paging: capcode/function/text;
	// DSD: protocol/link content; rtl_433: model/device ID and decoded sensor fields.
	return createHash("sha256")
		.update(
			JSON.stringify(content, (key, value: unknown) => {
				if (MESSAGE_METADATA.test(key)) return undefined
				if (value && typeof value === "object" && !Array.isArray(value))
					return Object.fromEntries(
						Object.entries(value).sort(([a], [b]) => a.localeCompare(b)),
					)
				return value
			}) ?? "",
		)
		.digest("hex")
}

/** Keep only protocol content carried by the adapter DTO. */
function fields(
	record: Record<string, unknown>,
	keys: readonly string[],
): Record<string, unknown> {
	return Object.fromEntries(
		keys
			.filter(key => record[key] !== undefined)
			.map(key => [key, record[key]]),
	)
}

/** Choose the same channel reach before pairing as the interpreter will emit afterward. */
function pointProtocol(
	type: string,
	input: unknown,
	nxdn?: "nxdn48" | "nxdn96",
): ScannerProtocol | undefined {
	if (type === "direwolf") return "aprs"
	if (type === "rtl433") return "ism"
	if (!input || typeof input !== "object") return undefined
	const record = input as {
		kind?: unknown
		line?: { protocol?: unknown }
		data?: { protocol?: unknown }
	}
	const raw =
		record.kind === "link" ? record.line?.protocol : record.data?.protocol
	if (type === "multimon-ng") {
		if (raw === "AFSK1200") return "aprs"
		if (typeof raw === "string" && raw.startsWith("POCSAG")) return "pocsag"
		if (raw === "FLEX") return "flex"
	}
	if (type === "dsd-fme") {
		if (raw === "p25") return "p25p1"
		if (raw === "nxdn") return nxdn ?? "nxdn96"
		if (raw === "dmr" || raw === "dpmr" || raw === "ysf" || raw === "dstar")
			return raw
	}
	return undefined
}

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
	type DecoderOutputLike,
	type InterpreterState,
} from "./confirm/double-match.js"
import { interpretDirewolf } from "./confirm/direwolf.js"
import { interpretDsdFme, toDsdFmeScannerEvent } from "./confirm/dsd-fme.js"
import { parseMeshtastic } from "./confirm/meshtastic.js"
import { interpretRtl433 } from "./confirm/rtl433.js"
import { channelPassbandOf, type ChannelPassband } from "./ambient-channel.js"
import { parseVdl2 } from "./confirm/vdl2.js"
import { CapcodeWindows, MULTIMON_HOLD_MS } from "./probe-pool.js"

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
	/**
	 * Reception trust of a decoder at a frequency on the source its target names (WG7 req 1.3);
	 * absent → no new-type evidence.
	 */
	tuningTrustOf?: (
		decoderId: string,
		hz: number,
		sourceId: string,
	) => TuningTrust | undefined
}

/** Acceptance memory of one decoder for one epoch; multimon keeps it per capcode (interp null). */
interface AmbientState {
	epoch: number
	interp: InterpreterState | null
	capcodes: CapcodeWindows | null
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
		const onLink = (line: DsdFmeLinkLine): void =>
			this.handle(id, { kind: "link", line })
		decoder.on("link", onLink)
		this.detach.set(id, () => decoder.off("link", onLink))
	}

	private unwatch(decoderId: string): void {
		const off = this.detach.get(decoderId)
		this.detach.delete(decoderId)
		off?.()
		this.types.delete(decoderId)
		this.states.delete(decoderId)
		this.trustErrorLogged.delete(decoderId)
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
			entry = {
				epoch,
				interp: createInterpreterState({
					epoch,
					origin: "ambient",
					decoderId,
				}),
				capcodes: null,
			}
			this.states.set(decoderId, entry)
		}
		if (entry.interp === null) return
		for (const decode of acceptAmbient(entry.interp, parsed)) {
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
	 * the decoder's channel bandwidth. Any failure is no passband (the decode
	 * then keeps the decoder's target frequency, as before).
	 */
	private channelPassband(
		decoderId: string,
		out: DecoderOutputLike,
	): ReturnType<typeof channelPassbandOf> {
		try {
			const binding = out.provenanceBinding
			const channelHz =
				binding && typeof binding === "object"
					? (binding as { channelHz?: unknown }).channelHz
					: undefined
			if (typeof channelHz !== "number") return null
			const request = this.deps.decoders
				.getDecoder(decoderId)
				?.getChannelRequest?.({ sampleRateHz: channelHz, centerHz: channelHz })
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
			if (ev) this.handle(decoderId, ev)
			return
		}
		this.handle(decoderId, out)
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
		let entry = this.states.get(decoderId)
		if (!entry || entry.epoch !== epoch) {
			const create = (): InterpreterState =>
				createInterpreterState({
					epoch,
					origin: "ambient",
					decoderId,
					...(target.nxdn !== undefined ? { nxdn: target.nxdn } : {}),
				})
			const multimon = type === "multimon-ng"
			entry = {
				epoch,
				interp: multimon ? null : create(),
				capcodes: multimon
					? new CapcodeWindows(MULTIMON_HOLD_MS, create)
					: null,
			}
			this.states.set(decoderId, entry)
		}
		const state = entry.interp
		let evs: DecodeEvidence[] = []
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
		const passband =
			type === "rtl433" && evs.length > 0
				? this.channelPassband(decoderId, input as DecoderOutputLike)
				: null
		const onSource = passband?.sourceId === target.sourceId ? passband : null
		for (const ev of evs) {
			const event: AmbientEvidenceEvent = {
				decoderId,
				sourceId: target.sourceId,
				hz: onSource ? onSource.centreHz : target.hz,
				ev,
				...(onSource
					? {
							passband: {
								centreHz: onSource.centreHz,
								halfHz: onSource.halfHz,
							},
						}
					: {}),
			}
			this.emit("evidence", event)
		}
	}
}

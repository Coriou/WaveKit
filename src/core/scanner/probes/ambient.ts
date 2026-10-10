/**
 * Evidence from configured, always-on decoders (spec § 6.4 "Ambient
 * evidence"): the same interpreters with origin "ambient", stamped with the
 * current engine epoch of the decoder's source. A decoder's acceptance memory
 * lasts one epoch and pairs only outputs at most 2 s apart (the § 6.4 ± 2 s
 * span). Matching to observations by frequency and time is done by
 * ScannerService.
 */
import { EventEmitter } from "node:events"
import type { DsdFmeLinkLine } from "../../../decoders/builtin/dsd-fme-link.js"
import type { DecoderManager } from "../../../decoders/manager.js"
import { createComponentLogger, type Logger } from "../../../utils/logger.js"
import type { DecodeEvidence } from "../types.js"
import {
	createInterpreterState,
	type DecoderOutputLike,
	type InterpreterState,
} from "./confirm/double-match.js"
import { interpretDirewolf } from "./confirm/direwolf.js"
import { interpretDsdFme, toDsdFmeScannerEvent } from "./confirm/dsd-fme.js"
import { interpretMultimon } from "./confirm/multimon.js"
import { interpretRtl433 } from "./confirm/rtl433.js"
import { PAIRING_GAP_MS } from "./probe-pool.js"

export interface AmbientTarget {
	sourceId: string
	hz: number
	/** NXDN flavour of a dsd-fme decoder (its `options.mode`); unset means NXDN96. */
	nxdn?: "nxdn48" | "nxdn96"
}

export interface AmbientEvidenceEvent {
	decoderId: string
	sourceId: string
	hz: number
	ev: DecodeEvidence
}

export interface AmbientDeps {
	decoders: Pick<DecoderManager, "on" | "off" | "getDecoder" | "getAllStatus">
	/** Configured target of a decoder (config frequencies, or caps centre + offsetHz). */
	targetOf: (decoderId: string) => AmbientTarget | null
	/** Current engine epoch of a source; null when no engine runs there. */
	epochOf: (sourceId: string) => number | null
	logger: Logger
	now?: () => number
}

/** Acceptance memory of one decoder: recreated on a new epoch or after a pairing gap. */
interface AmbientState {
	interp: InterpreterState
	lastAt: number
}

const AMBIENT_TYPES = new Set(["dsd-fme", "multimon-ng", "direwolf", "rtl433"])

export class AmbientEvidence extends EventEmitter {
	private readonly log: Logger
	private readonly now: () => number
	private readonly states = new Map<string, AmbientState>()
	private readonly types = new Map<string, string>()
	private readonly detach: (() => void)[] = []
	private running = false

	constructor(private readonly deps: AmbientDeps) {
		super()
		this.log = createComponentLogger(deps.logger, "AmbientEvidence")
		this.now = deps.now ?? Date.now
	}

	start(): void {
		if (this.running) return
		this.running = true
		for (const status of this.deps.decoders.getAllStatus()) {
			if (status.owner === "scanner" || !AMBIENT_TYPES.has(status.type))
				continue
			this.types.set(status.id, status.type)
			if (status.type !== "dsd-fme") continue
			const decoder = this.deps.decoders.getDecoder(status.id) as unknown as
				| EventEmitter
				| undefined
			if (!decoder) continue
			const onLink = (line: DsdFmeLinkLine): void =>
				this.handle(status.id, { kind: "link", line })
			decoder.on("link", onLink)
			this.detach.push(() => decoder.off("link", onLink))
		}
		this.deps.decoders.on("decoder:output", this.onOutput)
		this.log.info(
			{ decoders: [...this.types.keys()] },
			"Ambient evidence attached",
		)
	}

	stop(): void {
		if (!this.running) return
		this.running = false
		this.deps.decoders.off("decoder:output", this.onOutput)
		for (const off of this.detach.splice(0)) off()
		this.states.clear()
		this.types.clear()
	}

	private readonly onOutput = (
		decoderId: string,
		out: DecoderOutputLike,
	): void => {
		const type = this.types.get(decoderId)
		if (!type) return
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
		const now = this.now()
		let entry = this.states.get(decoderId)
		if (
			!entry ||
			entry.interp.epoch !== epoch ||
			now - entry.lastAt > PAIRING_GAP_MS
		) {
			entry = {
				interp: createInterpreterState({
					epoch,
					origin: "ambient",
					decoderId,
					...(target.nxdn !== undefined ? { nxdn: target.nxdn } : {}),
				}),
				lastAt: now,
			}
			this.states.set(decoderId, entry)
		}
		entry.lastAt = now
		const state = entry.interp
		const type = this.types.get(decoderId)
		let evs: DecodeEvidence[] = []
		if (type === "dsd-fme")
			evs = interpretDsdFme(
				input as Parameters<typeof interpretDsdFme>[0],
				state,
			)
		else if (type === "multimon-ng")
			evs = interpretMultimon(input as DecoderOutputLike, state)
		else if (type === "direwolf")
			evs = interpretDirewolf(input as DecoderOutputLike, state)
		else if (type === "rtl433")
			evs = interpretRtl433(input as DecoderOutputLike, state)
		for (const ev of evs) {
			const event: AmbientEvidenceEvent = {
				decoderId,
				sourceId: target.sourceId,
				hz: target.hz,
				ev,
			}
			this.emit("evidence", event)
		}
	}
}

import type {
	ActivityDecoderBinding,
	ActivityProvenanceLookup,
} from "../core/activity/types.js"
import type { TunerControlMode, TunerState } from "@wavekit/api-types"
import type { DecoderStatus } from "./types.js"

/** The DecoderManager surface the provenance index reads (structural, for tests). */
export interface ProvenanceDecoderSource {
	on(
		event: "decoder:created" | "decoder:removed",
		fn: (id: string) => void,
	): unknown
	off(
		event: "decoder:created" | "decoder:removed",
		fn: (id: string) => void,
	): unknown
	getAllDecoders(): ReadonlyArray<{ id: string }>
	getStatus(
		id: string,
	): Pick<DecoderStatus, "sourceId" | "targetFrequenciesHz"> | undefined
	getDecoder(id: string): { caps: { input: string } } | undefined
}

/**
 * WG5 (web-gaps-5 req 6): the tuner fields the trust rule reads. Structural so tests can
 * fake it; `TunerController` satisfies `ProvenanceTunerSource`.
 */
export type ProvenanceTunerState = Pick<
	TunerState,
	"frequency" | "sampleRate" | "controlMode" | "unknownFields"
>

/**
 * WG5: the tuner surface the provenance index reads. The index seeds a per-source
 * snapshot with `getState` (which clones, so never on the reception path) and refreshes
 * it on `state-changed` and `control-mode-changed`.
 */
export interface ProvenanceTunerSource {
	getState(sourceId: string): ProvenanceTunerState | undefined
	on(
		event: "state-changed",
		fn: (sourceId: string, state: ProvenanceTunerState) => void,
	): unknown
	on(
		event: "control-mode-changed",
		fn: (sourceId: string, mode: TunerControlMode) => void,
	): unknown
	off(
		event: "state-changed",
		fn: (sourceId: string, state: ProvenanceTunerState) => void,
	): unknown
	off(
		event: "control-mode-changed",
		fn: (sourceId: string, mode: TunerControlMode) => void,
	): unknown
}

interface Entry {
	/** Configured source; undefined means the default source; null means own device. */
	configured: string | null | undefined
	targets: readonly number[]
	binding: ActivityDecoderBinding
}

export interface DecoderProvenanceIndex {
	lookup: ActivityProvenanceLookup
	dispose(): void
}

/**
 * WG3 req 5.2: one binding per decoder instance (config and scanner probes alike), built
 * when the manager creates the decoder and dropped when it removes it, so a lookup is one
 * Map read with no Zod or status call on the reception path. Target frequencies come from
 * `resolveDecoderTargetFrequencies` through the manager status; a decoder without its own
 * `sourceId` reads the default source, resolved at lookup time; an external-input decoder
 * owns its device (sourceId null). `tuningTrust` is `unverified` for every decoder (Main
 * decision on req 5.3: no WG3 decoder hears a tuning WaveKit itself commands and verifies).
 */
export function createDecoderProvenanceIndex(
	decoders: ProvenanceDecoderSource,
	defaultSourceId: () => string | undefined,
): DecoderProvenanceIndex {
	const entries = new Map<string, Entry>()
	const bind = (id: string): void => {
		const status = decoders.getStatus(id)
		if (!status) {
			entries.delete(id)
			return
		}
		const external = decoders.getDecoder(id)?.caps.input === "external"
		const configured = external ? null : status.sourceId
		const targets = Object.freeze([...(status.targetFrequenciesHz ?? [])])
		const sourceId =
			configured === undefined ? (defaultSourceId() ?? null) : configured
		entries.set(id, {
			configured,
			targets,
			binding: Object.freeze({
				sourceId,
				targetFrequenciesHz: targets,
				tuningTrust: "unverified",
			}),
		})
	}
	const unbind = (id: string): void => {
		entries.delete(id)
	}
	decoders.on("decoder:created", bind)
	decoders.on("decoder:removed", unbind)
	for (const decoder of decoders.getAllDecoders()) bind(decoder.id)
	return {
		lookup: id => {
			const entry = entries.get(id)
			if (!entry) return null
			if (entry.configured === undefined) {
				const sourceId = defaultSourceId() ?? null
				if (sourceId !== entry.binding.sourceId)
					entry.binding = Object.freeze({
						sourceId,
						targetFrequenciesHz: entry.targets,
						tuningTrust: "unverified",
					})
			}
			return entry.binding
		},
		dispose: () => {
			decoders.off("decoder:created", bind)
			decoders.off("decoder:removed", unbind)
			entries.clear()
		},
	}
}

import type {
	ActivityDecoderBinding,
	ActivityProvenanceLookup,
} from "../core/activity/types.js"
import type { TunerControlMode, TunerState } from "@wavekit/api-types"
import type { DecoderStatus } from "./types.js"

type ProvenanceDecoderEvent =
	| "decoder:created"
	| "decoder:started"
	| "decoder:removed"

/** The DecoderManager surface the provenance index reads (structural, for tests). */
export interface ProvenanceDecoderSource {
	on(event: ProvenanceDecoderEvent, fn: (id: string) => void): unknown
	off(event: ProvenanceDecoderEvent, fn: (id: string) => void): unknown
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
	| "frequency"
	| "sampleRate"
	| "controlMode"
	| "directSampling"
	| "unknownFields"
	| "declaredOnlyFields"
>

/**
 * WG5: the tuner surface the provenance index reads. The index seeds a per-source
 * snapshot with `getState` (which clones, so never on the reception path), refreshes
 * it on `state-changed` and `control-mode-changed`, and drops it on `source-removed`.
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
	on(event: "source-removed", fn: (sourceId: string) => void): unknown
	off(
		event: "state-changed",
		fn: (sourceId: string, state: ProvenanceTunerState) => void,
	): unknown
	off(
		event: "control-mode-changed",
		fn: (sourceId: string, mode: TunerControlMode) => void,
	): unknown
	off(event: "source-removed", fn: (sourceId: string) => void): unknown
}

type TuningTrust = ActivityDecoderBinding["tuningTrust"]

/** The tuner fields the rule reads, validated once per tuner event. */
interface Snapshot {
	/**
	 * False when a field is missing, non-finite, unknown or only declared by the config
	 * baseline, the rate is not positive, or direct sampling is on (the centre then is
	 * not the R820T tuner's).
	 */
	usable: boolean
	/**
	 * The centre is the one decoders were configured with: finite and not unknown
	 * (a declared-only centre counts, since source caps carry it). A bind captures it.
	 */
	bindable: boolean
	frequency: number
	/** 0.45 × sample rate: the usable 90 % of the IQ bandwidth around the centre. */
	reach: number
	/** Observed sample rate (Hz), finite and positive when `usable`. */
	sampleRate: number
	relay: boolean
}

interface Entry {
	/** Configured source; undefined means the default source; null means own device. */
	configured: string | null | undefined
	targets: readonly number[]
	/** Source and centre captured on `decoder:created` / `decoder:started` (WG5 req 6.3). */
	bindSourceId: string | null
	bindCentre: number | undefined
	/** Source the cached bindings carry; one frozen binding per trust value. */
	cacheSourceId: string | null
	/** Input rate the cached bindings carry (undefined: unknown). */
	cacheRate?: number | undefined
	cache: Partial<Record<TuningTrust, ActivityDecoderBinding>>
}

export interface DecoderProvenanceIndex {
	lookup: ActivityProvenanceLookup
	dispose(): void
}

const MARGIN = 0.45

function snapshotOf(state: unknown): Snapshot | undefined {
	if (typeof state !== "object" || state === null) return undefined
	const {
		frequency,
		sampleRate,
		controlMode,
		directSampling,
		unknownFields,
		declaredOnlyFields,
	} = state as Partial<Record<keyof ProvenanceTunerState, unknown>>
	if (typeof frequency !== "number" || typeof sampleRate !== "number")
		return undefined
	const lists = (value: unknown, field: string): boolean =>
		value !== undefined && (!Array.isArray(value) || value.includes(field))
	const frequencyKnown =
		!lists(unknownFields, "frequency") && Number.isFinite(frequency)
	const unproven =
		lists(unknownFields, "sampleRate") ||
		lists(declaredOnlyFields, "frequency") ||
		lists(declaredOnlyFields, "sampleRate")
	return {
		usable:
			frequencyKnown &&
			!unproven &&
			directSampling === "off" &&
			Number.isFinite(sampleRate) &&
			sampleRate > 0,
		bindable: frequencyKnown,
		frequency,
		reach: MARGIN * sampleRate,
		sampleRate,
		relay: controlMode === "external",
	}
}

/**
 * WG3 req 5.2: one binding per decoder instance (config and scanner probes alike), built
 * when the manager creates the decoder and dropped when it removes it, so a lookup is one
 * Map read with no Zod or status call on the reception path. Target frequencies come from
 * `resolveDecoderTargetFrequencies` through the manager status; a decoder without its own
 * `sourceId` reads the default source, resolved at lookup time; an external-input decoder
 * owns its device (sourceId null).
 *
 * WG5 req 6 (supersedes the WG3 "unverified for every decoder" decision): with a tuner
 * source, `tuningTrust` is `commanded` (internal control) or `relay` (external control)
 * when the observed tuner state proves the decoder hears its targets: the source centre
 * still equals the centre captured when the decoder was last created or started, the
 * centre and rate were written by WaveKit or seen from a relay client (a value only
 * declared by the config baseline, or a relay value the controller ignored, proves
 * nothing), the rate is positive, direct sampling is off, and every target lies within
 * 0.45 × rate of the centre. Anything else, including no tuner source, is `unverified`. Snapshots are refreshed on
 * tuner events only (`getState` clones, so it never runs inside a lookup); a removed
 * source drops its snapshot (`source-removed`). A retune that
 * bypasses WaveKit and the relay is not observed.
 */
export function createDecoderProvenanceIndex(
	decoders: ProvenanceDecoderSource,
	defaultSourceId: () => string | undefined,
	tuner?: ProvenanceTunerSource,
): DecoderProvenanceIndex {
	const entries = new Map<string, Entry>()
	const snapshots = new Map<string, Snapshot>()
	const store = (sourceId: string, state: () => unknown): void => {
		let snapshot: Snapshot | undefined
		try {
			snapshot = snapshotOf(state())
		} catch {
			snapshot = undefined
		}
		if (snapshot) snapshots.set(sourceId, snapshot)
		else snapshots.delete(sourceId)
	}
	const read = (sourceId: string): void => {
		store(sourceId, () => tuner?.getState(sourceId))
	}
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
		let bindCentre: number | undefined
		if (tuner && sourceId !== null) {
			// Operator rate: re-read so a start also refreshes a stale snapshot.
			read(sourceId)
			const snapshot = snapshots.get(sourceId)
			if (snapshot?.bindable) bindCentre = snapshot.frequency
		}
		entries.set(id, {
			configured,
			targets,
			bindSourceId: sourceId,
			bindCentre,
			cacheSourceId: sourceId,
			cache: {},
		})
	}
	const unbind = (id: string): void => {
		entries.delete(id)
	}
	const onState = (sourceId: string, state: ProvenanceTunerState): void => {
		store(sourceId, () => state)
	}
	const onMode = (sourceId: string): void => {
		read(sourceId)
	}
	// A removed source has no observed state: its receptions are unverified until a
	// re-added source reports state again (initializeSource emits state-changed).
	const onRemoved = (sourceId: string): void => {
		snapshots.delete(sourceId)
	}
	const trustOf = (entry: Entry, sourceId: string | null): TuningTrust => {
		if (sourceId === null) return "unverified"
		const snapshot = snapshots.get(sourceId)
		if (
			!snapshot?.usable ||
			entry.targets.length === 0 ||
			entry.bindSourceId !== sourceId ||
			entry.bindCentre !== snapshot.frequency
		)
			return "unverified"
		for (const target of entry.targets)
			if (Math.abs(target - snapshot.frequency) > snapshot.reach)
				return "unverified"
		return snapshot.relay ? "relay" : "commanded"
	}
	decoders.on("decoder:created", bind)
	decoders.on("decoder:removed", unbind)
	if (tuner) {
		decoders.on("decoder:started", bind)
		tuner.on("state-changed", onState)
		tuner.on("control-mode-changed", onMode)
		tuner.on("source-removed", onRemoved)
	}
	for (const decoder of decoders.getAllDecoders()) bind(decoder.id)
	return {
		lookup: (id, context) => {
			let entry = entries.get(id)
			if (!entry) return null
			if (context) {
				entry = {
					...entry,
					configured: context.sourceId,
					targets:
						context.channelHz === null ? entry.targets : [context.channelHz],
					cache: {},
				}
			}
			const sourceId =
				entry.configured === undefined
					? (defaultSourceId() ?? null)
					: entry.configured
			const trust = tuner ? trustOf(entry, sourceId) : "unverified"
			// The decoder hears the source capture around its single target only without a
			// channel context; then the observed tuner rate is its input rate.
			const snap = sourceId !== null ? snapshots.get(sourceId) : undefined
			const rate =
				context === undefined && snap?.usable === true
					? snap.sampleRate
					: undefined
			if (sourceId !== entry.cacheSourceId || rate !== entry.cacheRate) {
				entry.cacheSourceId = sourceId
				entry.cacheRate = rate
				entry.cache = {}
			}
			let binding = entry.cache[trust]
			if (!binding) {
				binding = Object.freeze({
					sourceId,
					targetFrequenciesHz: entry.targets,
					tuningTrust: trust,
					...(rate !== undefined ? { inputSampleRateHz: rate } : {}),
				})
				entry.cache[trust] = binding
			}
			return binding
		},
		dispose: () => {
			decoders.off("decoder:created", bind)
			decoders.off("decoder:removed", unbind)
			if (tuner) {
				decoders.off("decoder:started", bind)
				tuner.off("state-changed", onState)
				tuner.off("control-mode-changed", onMode)
				tuner.off("source-removed", onRemoved)
			}
			entries.clear()
			snapshots.clear()
		},
	}
}

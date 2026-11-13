import type {
	ActivityDecoderBinding,
	ActivityProvenanceLookup,
} from "../core/activity/types.js"
import type { TunerControlMode, TunerState } from "@wavekit/api-types"
import { placementKey } from "./enablement/contract.js"
import { readExtraArgsOption } from "./option-values.js"
import type { DecoderBandDeclaration, DecoderStatus } from "./types.js"
import type { TrustVerdict, TuningLedger } from "../core/tuning-ledger.js"

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
	):
		| (Pick<DecoderStatus, "sourceId" | "targetFrequenciesHz"> &
				Partial<Pick<DecoderStatus, "type">>)
		| undefined
	getDecoder(id: string): ProvenanceDecoder | undefined
}

/** The decoder fields the provenance index reads. */
interface ProvenanceDecoder {
	caps: { input: string }
	getBandDeclaration?(): DecoderBandDeclaration
	/** The options this instance runs with (BaseDecoder keeps them current). */
	config?: { options?: Record<string, unknown> }
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
	 * False when a field is missing, non-finite or unknown, the rate is not positive, or
	 * direct sampling is on (the centre then is not the R820T tuner's). Proof is the
	 * tuning ledger's (`trustNow`), never these fields.
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
}

interface Entry {
	/** Configured source; undefined means the default source; null means own device. */
	configured: string | null | undefined
	targets: readonly number[]
	/** Source and centre captured on `decoder:created` / `decoder:started` (WG5 req 6.3). */
	bindSourceId: string | null
	bindCentre: number | undefined
	/** The operator's `-f` in rtl_433's extraArgs replaces the bound centre as its reference. */
	operatorCentre: boolean
	/** Source the cached bindings carry; one frozen binding per trust value. */
	cacheSourceId: string | null
	/** Input rate the cached bindings carry (undefined: unknown). */
	cacheRate?: number | undefined
	/** Capture centre the cached bindings carry (undefined: unknown, or retuned since the bind). */
	cacheCentre?: number | undefined
	cache: Partial<Record<TuningTrust, ActivityDecoderBinding>>
}

export interface DecoderProvenanceIndex {
	lookup: ActivityProvenanceLookup
	dispose(): void
}

const MARGIN = 0.45

function snapshotOf(state: unknown): Snapshot | undefined {
	if (typeof state !== "object" || state === null) return undefined
	const { frequency, sampleRate, directSampling, unknownFields } =
		state as Partial<Record<keyof ProvenanceTunerState, unknown>>
	if (typeof frequency !== "number" || typeof sampleRate !== "number")
		return undefined
	const lists = (value: unknown, field: string): boolean =>
		value !== undefined && (!Array.isArray(value) || value.includes(field))
	const frequencyKnown =
		!lists(unknownFields, "frequency") && Number.isFinite(frequency)
	return {
		usable:
			frequencyKnown &&
			!lists(unknownFields, "sampleRate") &&
			directSampling === "off" &&
			Number.isFinite(sampleRate) &&
			sampleRate > 0,
		bindable: frequencyKnown,
		frequency,
		reach: MARGIN * sampleRate,
		sampleRate,
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
 * `tuningTrust` is the tuning ledger's label of the source's live edge (`trustNow`):
 * `commanded` or `relay` (a relay client's frame) only while the ledger proves the centre
 * and the rate on the live session, the proven centre is the tuner's and still the one
 * captured when the decoder was last created or started, direct sampling is off, and
 * every target lies within 0.45 × the proven rate of the proven centre. Anything else,
 * including no tuner source, no ledger or a throwing lookup, is `unverified`. Snapshots are
 * refreshed on tuner events only (`getState` clones, so it never runs inside a lookup); a
 * removed source drops its snapshot (`source-removed`). A retune that bypasses WaveKit and
 * the relay is invisible to the ledger until a detector raises a doubt.
 */
export function createDecoderProvenanceIndex(
	decoders: ProvenanceDecoderSource,
	defaultSourceId: () => string | undefined,
	tuner?: ProvenanceTunerSource,
	ledger?: Pick<TuningLedger, "trustNow"> | null,
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
		const decoder = decoders.getDecoder(id)
		const external = decoder?.caps.input === "external"
		const configured = external ? null : status.sourceId
		// Raw readsb placements have no channel and status deliberately omits built-in
		// defaults. Its protocol declaration supplies 1090 MHz; this is only a target,
		// never tuning proof. trustOf still requires observed source centre/rate.
		const declaration = decoder?.getBandDeclaration?.()
		const intrinsic =
			status.type === "readsb" &&
			!external &&
			!declaration?.ownSource &&
			!declaration?.ownTuning &&
			declaration?.intrinsic?.basis === "protocol"
				? declaration?.intrinsic?.targetsHz
				: undefined
		const targets = Object.freeze([
			...(status.targetFrequenciesHz ?? intrinsic ?? []),
		])
		const sourceId =
			configured === undefined ? (defaultSourceId() ?? null) : configured
		let bindCentre: number | undefined
		if (tuner && sourceId !== null) {
			// Operator rate: re-read so a start also refreshes a stale snapshot.
			read(sourceId)
			const snapshot = snapshots.get(sourceId)
			if (snapshot?.bindable) bindCentre = snapshot.frequency
		}
		// The same read and the same test the adapter uses to leave its own `-f` out.
		const operatorCentre =
			status.type === "rtl433" &&
			(readExtraArgsOption(
				decoder?.config?.options?.["extraArgs"],
				() => {},
			)?.some(arg => arg.startsWith("-f")) ??
				false)
		entries.set(id, {
			configured,
			targets,
			bindSourceId: sourceId,
			bindCentre,
			operatorCentre,
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
	/** The ledger's live proof of the snapshot's centre, or null (fail closed). */
	const proofOf = (
		sourceId: string | null,
	): Pick<TrustVerdict, "trust" | "frequency" | "sampleRate"> | null => {
		if (sourceId === null || !ledger) return null
		const snapshot = snapshots.get(sourceId)
		if (!snapshot?.usable) return null
		try {
			const verdict = ledger.trustNow(sourceId)
			if (
				verdict.trust === "unverified" ||
				verdict.frequency !== snapshot.frequency ||
				typeof verdict.sampleRate !== "number" ||
				!(verdict.sampleRate > 0)
			)
				return null
			return verdict
		} catch {
			return null
		}
	}
	const trustOf = (
		entry: Entry,
		sourceId: string | null,
		proof: Pick<TrustVerdict, "trust" | "frequency" | "sampleRate"> | null,
	): TuningTrust => {
		if (sourceId === null || proof === null) return "unverified"
		if (
			entry.targets.length === 0 ||
			entry.bindSourceId !== sourceId ||
			entry.bindCentre !== proof.frequency
		)
			return "unverified"
		const centre = proof.frequency!
		const reach = MARGIN * proof.sampleRate!
		for (const target of entry.targets)
			if (
				!Number.isFinite(target) ||
				target <= 0 ||
				Math.abs(target - centre) > reach
			)
				return "unverified"
		return proof.trust
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
			const proof = tuner ? proofOf(sourceId) : null
			const trust = trustOf(entry, sourceId, proof)
			// The decoder hears the source capture unless a channel context says otherwise; then the
			// observed tuner rate is its input rate. The process that holds `-f` is the one whose start
			// counts: a secondary raw placement's own worker, else the decoder itself, which runs its
			// primary placement (the source check below refuses it for any other source).
			const snap = sourceId !== null ? snapshots.get(sourceId) : undefined
			const started =
				context === undefined
					? entry
					: context.channelHz === null
						? (entries.get(placementKey(id, context.sourceId, "raw", null)) ??
							entry)
						: undefined
			// The input rate only while the ledger proves it (and it is still the tuner's).
			const rate =
				(context === undefined || context.channelHz === null) &&
				snap?.usable === true &&
				proof !== null &&
				proof.sampleRate === snap.sampleRate
					? snap.sampleRate
					: undefined
			// The centre the decoder started on, only while the tuner is still there: rtl_433's `-f` is
			// frozen at its start, so after a retune with no restart its estimate has no known reference.
			// An operator's `-f` is not the capture centre, so that estimate has none either.
			const centre =
				rate !== undefined &&
				started?.operatorCentre === false &&
				started.bindSourceId === sourceId &&
				started.bindCentre === snap?.frequency
					? started.bindCentre
					: undefined
			if (
				sourceId !== entry.cacheSourceId ||
				rate !== entry.cacheRate ||
				centre !== entry.cacheCentre
			) {
				entry.cacheSourceId = sourceId
				entry.cacheRate = rate
				entry.cacheCentre = centre
				entry.cache = {}
			}
			let binding = entry.cache[trust]
			if (!binding) {
				binding = Object.freeze({
					sourceId,
					targetFrequenciesHz: entry.targets,
					tuningTrust: trust,
					...(rate !== undefined ? { inputSampleRateHz: rate } : {}),
					...(centre !== undefined ? { captureCentreHz: centre } : {}),
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

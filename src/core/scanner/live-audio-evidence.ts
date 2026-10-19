/**
 * WG12 req 6.3: a closed live-audio transmission on a commanded or relay
 * frequency attaches analog evidence to the nearest discovery's overlapping
 * observation. No discovery is created. The record lives only in the store's
 * in-memory evidence sink (A12).
 */
import {
	DCS_STANDARD_CODES,
	DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
} from "@wavekit/api-types"
import { CTCSS_HZ } from "../audio-tones/ctcss.js"
import { safeErrorFields } from "../../decoders/safe-error-fields.js"
import { createComponentLogger, type Logger } from "../../utils/logger.js"
import type { AnalogEvidenceTransmission } from "./identify-analog-contract.js"
import {
	ANALOG_EVIDENCE_MAX_ID_LENGTH,
	type AnalogEvidenceLog,
} from "./analog-evidence.js"
import type {
	AnalogTrialMode,
	DiscoveryNearQuery,
	ObservationEvidenceSink,
	ProofAnalogInput,
} from "./scanner-redesign-contract.js"
import type { DiscoveryStore } from "./store/discovery-store.js"
import type { Observation } from "./types.js"
import type { TuningTrust } from "../spectrum/types.js"

export interface LiveAudioEvidence {
	start(): void
	stop(): void
}

export interface LiveAudioEvidenceDeps {
	store: DiscoveryNearQuery &
		Pick<ObservationEvidenceSink, "recordAnalog"> &
		Pick<DiscoveryStore, "observations">
	analogLog: AnalogEvidenceLog
	trust: (sourceId: string) => TuningTrust
	logger: Logger
}

const CTCSS: ReadonlySet<number> = new Set(CTCSS_HZ)
const DCS: ReadonlySet<string> = new Set(DCS_STANDARD_CODES)
/** One observations page. The store returns newest first. */
const OBSERVATION_PAGE = 64

export function createLiveAudioEvidence(
	deps: LiveAudioEvidenceDeps,
): LiveAudioEvidence {
	const log = createComponentLogger(deps.logger, "LiveAudioEvidence")
	let unsubscribe: (() => void) | null = null
	let storeFaultLogged = false
	let subscriptionFaultLogged = false

	const noteStoreFault = (err: unknown): void => {
		if (storeFaultLogged) return
		storeFaultLogged = true
		log.warn(
			{ err: safeErrorFields(err) },
			"Live audio evidence was not recorded",
		)
	}

	const noteSubscriptionFault = (err: unknown): void => {
		if (subscriptionFaultLogged) return
		subscriptionFaultLogged = true
		log.warn(
			{ err: safeErrorFields(err) },
			"Live audio evidence subscription failed",
		)
	}

	const onClosed = (tx: AnalogEvidenceTransmission): void => {
		try {
			if (unsubscribe === null) return
			if (tx.endedAtMs === null) return
			if (!Number.isFinite(tx.hz) || tx.hz <= 0) return
			if (!trusted(tx.tuningTrust)) return
			let trust: unknown
			try {
				trust = deps.trust(tx.sourceId)
			} catch {
				return
			}
			if (!trusted(trust)) return
			attach(tx)
		} catch (err: unknown) {
			noteStoreFault(err)
		}
	}

	const attach = (tx: AnalogEvidenceTransmission): void => {
		const mode = analogMode(tx.modulation)
		if (mode === null) return
		const endedAt = tx.endedAtMs
		if (endedAt === null) return
		let found: ReturnType<DiscoveryNearQuery["near"]>
		try {
			found = deps.store.near(
				tx.hz,
				DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ,
				tx.sourceId,
			)
		} catch (err: unknown) {
			noteStoreFault(err)
			return
		}
		if (!Array.isArray(found) || found.length === 0) return
		const nearest = found[0]
		if (
			nearest === undefined ||
			!Number.isFinite(nearest.frequencyHz) ||
			Math.abs(nearest.frequencyHz - tx.hz) >
				DISCOVERY_NEAR_DEFAULT_TOLERANCE_HZ ||
			!Array.isArray(nearest.sourceIds) ||
			!nearest.sourceIds.includes(tx.sourceId)
		)
			return
		let page: { items: readonly Observation[] }
		try {
			page = deps.store.observations(nearest.id, null, OBSERVATION_PAGE)
		} catch (err: unknown) {
			noteStoreFault(err)
			return
		}
		if (page === null || typeof page !== "object" || !Array.isArray(page.items))
			return
		const now = Date.now()
		let observationId: string | null = null
		const items = page.items
		const limit = Math.min(items.length, OBSERVATION_PAGE)
		for (let i = 0; i < limit; i++) {
			const id = observationIdOf(
				items[i],
				nearest.id,
				tx.sourceId,
				tx.startedAtMs,
				endedAt,
				now,
			)
			if (id !== null) {
				observationId = id
				break
			}
		}
		if (observationId === null) return
		const tone = standardTone(tx)
		const analog: ProofAnalogInput = {
			outcome: tone.ctcssHz !== null || tone.dcs !== null ? "decoded" : "heard",
			mode,
			voice: true,
			tone,
			transport: "live",
			at: endedAt,
		}
		try {
			deps.store.recordAnalog(observationId, analog)
		} catch (err: unknown) {
			noteStoreFault(err)
		}
	}

	return {
		start() {
			if (unsubscribe !== null) return
			let returned: unknown
			try {
				returned = deps.analogLog.subscribe(onClosed)
			} catch (err: unknown) {
				noteSubscriptionFault(err)
				return
			}
			if (!isUnsubscribe(returned)) {
				noteSubscriptionFault(new TypeError("subscribe"))
				return
			}
			unsubscribe = returned
		},
		stop() {
			const current = unsubscribe
			unsubscribe = null
			if (current === null) return
			try {
				current()
			} catch (err: unknown) {
				noteSubscriptionFault(err)
			}
		},
	}
}

function isUnsubscribe(value: unknown): value is () => void {
	return typeof value === "function"
}

function trusted(trust: unknown): trust is "commanded" | "relay" {
	return trust === "commanded" || trust === "relay"
}

/** nfm/wfm and am/dsb only, matching identify's analog validation. */
function analogMode(modulation: unknown): AnalogTrialMode | null {
	if (modulation === "nfm" || modulation === "wfm") return "nfm"
	if (modulation === "am" || modulation === "dsb") return "am"
	return null
}

function standardTone(
	tx: AnalogEvidenceTransmission,
): ProofAnalogInput["tone"] {
	const ctcssHz =
		typeof tx.ctcssHz === "number" && CTCSS.has(tx.ctcssHz) ? tx.ctcssHz : null
	const dcs = tx.dcs
	if (
		dcs === null ||
		typeof dcs.code !== "string" ||
		!DCS.has(dcs.code) ||
		(dcs.polarity !== "normal" && dcs.polarity !== "inverted")
	)
		return { ctcssHz, dcs: null }
	return { ctcssHz, dcs: { code: dcs.code, polarity: dcs.polarity } }
}

/**
 * The first-page row this transmission may prove. Time overlap alone is not
 * enough: a discovery can list several sources, and a page can carry a row
 * from somewhere else. Skip a row that is not this discovery, not this
 * source, has no usable id, or has no well-formed overlapping interval.
 */
function observationIdOf(
	item: unknown,
	discoveryId: string,
	sourceId: string,
	txStart: number,
	txEnd: number,
	now: number,
): string | null {
	if (item === null || typeof item !== "object") return null
	const observation = item as Observation
	if (!validId(observation.id)) return null
	if (observation.discoveryId !== discoveryId) return null
	if (observation.sourceId !== sourceId) return null
	if (!overlaps(observation, txStart, txEnd, now)) return null
	return observation.id
}

function validId(id: unknown): id is string {
	return (
		typeof id === "string" &&
		id.length > 0 &&
		id.length <= ANALOG_EVIDENCE_MAX_ID_LENGTH
	)
}

function overlaps(
	observation: Pick<Observation, "startedAt" | "endedAt">,
	txStart: number,
	txEnd: number,
	now: number,
): boolean {
	if (typeof observation.startedAt !== "string") return false
	const start = Date.parse(observation.startedAt)
	if (!Number.isFinite(start)) return false
	let end: number
	if (observation.endedAt === undefined) {
		end = now
	} else {
		if (typeof observation.endedAt !== "string") return false
		end = Date.parse(observation.endedAt)
		if (!Number.isFinite(end)) return false
	}
	if (end < start) return false
	return start <= txEnd && txStart <= end
}

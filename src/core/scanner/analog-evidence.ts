/**
 * WG10 req 3.1: the analog evidence log identify reads (IdentifyAnalogEvidence). It keeps the latest
 * IDENTIFY_ANALOG_MAX_TRANSMISSIONS live-audio transmissions by id (an open event inserts, its closed
 * event replaces it; the oldest is dropped), copying only the fields identify needs from the
 * transmission tracker's events. Malformed events are dropped; nothing here throws for the caller.
 * Imports stay minimal (types, the api-types constants and the pure CTCSS table) so that src/index.ts
 * can import it without pulling runtime modules into the protected runtime bundle.
 */
import type {
	AnalogTransmissionEventData,
	TuningTrust,
} from "@wavekit/api-types"
import {
	DCS_STANDARD_CODES,
	IDENTIFY_ANALOG_MAX_TRANSMISSIONS,
} from "@wavekit/api-types"
import type { Logger } from "../../utils/logger.js"
import { CTCSS_HZ } from "../audio-tones/ctcss.js"
import type { LiveDemodStatus } from "../live-demodulator.js"
import type {
	AnalogEvidenceTransmission,
	IdentifyAnalogEvidence,
} from "./identify-analog-contract.js"

/** At most one "monitoring unavailable" warning per this interval. */
export const ANALOG_EVIDENCE_WARN_INTERVAL_MS = 60_000
/** Longest transmission or source id kept (longer ids are malformed: the event is dropped). */
export const ANALOG_EVIDENCE_MAX_ID_LENGTH = 128

export interface AnalogEvidenceLog extends IdentifyAnalogEvidence {
	/**
	 * Records one tracker event; a malformed event is dropped. Never throws. A closed
	 * event with `data: true` (detection quality R4) is kept with the core-only flag.
	 */
	record(event: AnalogTransmissionEventData & { data?: boolean }): void
	/** WG10 R2: binds the tracker's pending opening (late: the tracker is built after the log). */
	setPending(pending: (() => AnalogTransmissionEventData | null) | null): void
	pendingNear(
		sourceId: string,
		hz: number,
		toleranceHz: number,
	): readonly AnalogEvidenceTransmission[]
	/**
	 * Closed transmissions, after they are kept. Returns unsubscribe.
	 * A throwing listener does not break the log or later listeners.
	 */
	subscribe(
		listener: (transmission: AnalogEvidenceTransmission) => void,
	): () => void
}

export interface AnalogEvidenceLogOptions {
	now?: () => number
	monitoring: (sourceId: string, hz: number, toleranceHz: number) => boolean
	/** WG10 R2: the tracker's held, not yet published opening (`AnalogTransmissionTracker.pending`). */
	pending?: () => AnalogTransmissionEventData | null
	logger?: Logger
}

const TRUSTS: ReadonlySet<string> = new Set<TuningTrust>([
	"commanded",
	"relay",
	"unverified",
])
const MODULATIONS: ReadonlySet<string> = new Set<
	AnalogEvidenceTransmission["modulation"]
>(["nfm", "wfm", "am", "usb", "lsb", "dsb", "cw", "raw"])
const CTCSS: ReadonlySet<number> = new Set(CTCSS_HZ)
const DCS_CODES: ReadonlySet<string> = new Set(DCS_STANDARD_CODES)

function isRecord(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null
}

function idOf(v: unknown): string | null {
	return typeof v === "string" &&
		v.length > 0 &&
		v.length <= ANALOG_EVIDENCE_MAX_ID_LENGTH
		? v
		: null
}

function timeOf(v: unknown): number | null {
	if (typeof v !== "string") return null
	const ms = Date.parse(v)
	return Number.isFinite(ms) ? ms : null
}

/** The validated contract copy of one tracker event, or null when anything is malformed. */
export function evidenceOf(event: unknown): AnalogEvidenceTransmission | null {
	if (!isRecord(event)) return null
	const transmissionId = idOf(event["transmissionId"])
	const sourceId = idOf(event["sourceId"])
	const state = event["state"]
	const startedAtMs = timeOf(event["startedAt"])
	const frequency = event["frequency"]
	const modulation = event["modulation"]
	if (
		transmissionId === null ||
		sourceId === null ||
		(state !== "open" && state !== "closed") ||
		startedAtMs === null ||
		!isRecord(frequency) ||
		typeof frequency["hz"] !== "number" ||
		!Number.isFinite(frequency["hz"]) ||
		frequency["hz"] <= 0 ||
		typeof frequency["tuningTrust"] !== "string" ||
		!TRUSTS.has(frequency["tuningTrust"]) ||
		typeof modulation !== "string" ||
		!MODULATIONS.has(modulation)
	)
		return null
	let endedAtMs: number | null = null
	let ctcssHz: number | null = null
	let dcs: AnalogEvidenceTransmission["dcs"] = null
	if (state === "closed") {
		endedAtMs = timeOf(event["endedAt"])
		if (endedAtMs === null || endedAtMs < startedAtMs) return null
		const tone = event["tone"]
		if (tone !== undefined) {
			if (!isRecord(tone)) return null
			const c = tone["ctcssHz"]
			if (c !== null && c !== undefined) {
				if (typeof c !== "number" || !CTCSS.has(c)) return null
				ctcssHz = c
			}
			const d = tone["dcs"]
			if (d !== null && d !== undefined) {
				if (
					!isRecord(d) ||
					typeof d["code"] !== "string" ||
					!DCS_CODES.has(d["code"]) ||
					(d["polarity"] !== "normal" && d["polarity"] !== "inverted")
				)
					return null
				dcs = { code: d["code"], polarity: d["polarity"] }
			}
		}
	}
	return {
		transmissionId,
		sourceId,
		startedAtMs,
		endedAtMs,
		hz: frequency["hz"],
		tuningTrust: frequency["tuningTrust"] as TuningTrust,
		modulation: modulation as AnalogEvidenceTransmission["modulation"],
		ctcssHz,
		dcs,
		...(state === "closed" && event["data"] === true
			? { data: true as const }
			: {}),
	}
}

function copyOf(t: AnalogEvidenceTransmission): AnalogEvidenceTransmission {
	return { ...t, dcs: t.dcs ? { ...t.dcs } : null }
}

export function createAnalogEvidenceLog(
	options: AnalogEvidenceLogOptions,
): AnalogEvidenceLog {
	const now = options.now ?? Date.now
	/** Insertion order = age: the first entry is the oldest. */
	const ring = new Map<string, AnalogEvidenceTransmission>()
	const listeners = new Set<
		(transmission: AnalogEvidenceTransmission) => void
	>()
	let lastWarnAt = Number.NEGATIVE_INFINITY
	let pending = options.pending ?? null
	const notify = (t: AnalogEvidenceTransmission): void => {
		for (const listener of [...listeners]) {
			try {
				listener(copyOf(t))
			} catch {
				// A listener must not break the log or the other listeners.
			}
		}
	}
	return {
		setPending(next) {
			pending = next
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
		pendingNear(sourceId, hz, toleranceHz) {
			try {
				if (
					pending === null ||
					!Number.isFinite(hz) ||
					!Number.isFinite(toleranceHz) ||
					toleranceHz < 0
				)
					return []
				const t = evidenceOf(pending())
				if (
					t === null ||
					t.endedAtMs !== null ||
					t.sourceId !== sourceId ||
					!(Math.abs(t.hz - hz) <= toleranceHz)
				)
					return []
				return [t]
			} catch {
				// A failing tracker is no pending evidence.
				return []
			}
		},
		record(event: AnalogTransmissionEventData & { data?: boolean }): void {
			try {
				const t = evidenceOf(event)
				if (!t) return
				const known = ring.get(t.transmissionId)
				if (known) {
					// A closed event replaces its open one in place; anything else about an id already kept is ignored.
					if (known.endedAtMs !== null || t.endedAtMs === null) return
					if (known.sourceId !== t.sourceId) return
					ring.set(t.transmissionId, t)
					notify(t)
					return
				}
				ring.set(t.transmissionId, t)
				while (ring.size > IDENTIFY_ANALOG_MAX_TRANSMISSIONS) {
					const oldest = ring.keys().next().value
					if (oldest === undefined) break
					ring.delete(oldest)
				}
				if (t.endedAtMs !== null) notify(t)
			} catch {
				// A hostile getter on the event: dropped.
			}
		},
		transmissionsNear(sourceId, hz, toleranceHz, sinceMs) {
			const out: AnalogEvidenceTransmission[] = []
			if (
				!Number.isFinite(hz) ||
				!Number.isFinite(toleranceHz) ||
				toleranceHz < 0 ||
				Number.isNaN(sinceMs)
			)
				return out
			for (const t of ring.values()) {
				if (
					t.data !== true &&
					t.sourceId === sourceId &&
					Math.abs(t.hz - hz) <= toleranceHz &&
					(t.endedAtMs === null || t.endedAtMs >= sinceMs)
				)
					out.push(copyOf(t))
			}
			// Newest first: by start time, ties by arrival.
			return out
				.map((t, i) => ({ t, i }))
				.sort((a, b) => b.t.startedAtMs - a.t.startedAtMs || b.i - a.i)
				.map(x => x.t)
		},
		monitoring(sourceId, hz, toleranceHz) {
			try {
				return options.monitoring(sourceId, hz, toleranceHz) === true
			} catch {
				const at = now()
				if (
					!(at - lastWarnAt < ANALOG_EVIDENCE_WARN_INTERVAL_MS) ||
					at < lastWarnAt
				) {
					lastWarnAt = at
					options.logger?.warn(
						"Live audio monitoring state unavailable; identify treats it as not monitoring",
					)
				}
				return false
			}
		},
	}
}

/**
 * WG10 req 3.2 (pure, for Main's `monitoring` callback): live audio is running on `sourceId` with
 * its channel (tuner centre + offset) known and within `toleranceHz` of `hz`. Anything unknown is false.
 * `sourceId` (the identify target's source) should always be passed: live audio on another source is
 * then not monitoring even when `tunerHz` happens to match.
 */
export function liveAudioMonitoring(
	status: LiveDemodStatus,
	tunerHz: number | null,
	hz: number,
	toleranceHz: number,
	sourceId?: string,
): boolean {
	try {
		if (
			status.running !== true ||
			status.sourceConnected !== true ||
			typeof status.sourceId !== "string" ||
			(sourceId !== undefined && status.sourceId !== sourceId) ||
			typeof tunerHz !== "number" ||
			!Number.isFinite(tunerHz) ||
			!Number.isFinite(hz) ||
			!Number.isFinite(toleranceHz) ||
			toleranceHz < 0
		)
			return false
		const offset = status.config.offsetHz ?? 0
		if (typeof offset !== "number" || !Number.isFinite(offset)) return false
		return Math.abs(tunerHz + offset - hz) <= toleranceHz
	} catch {
		return false
	}
}

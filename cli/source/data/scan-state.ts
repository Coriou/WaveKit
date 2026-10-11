import type {
	SpectrumFrameEventData,
	SpectrumProfileEventData,
} from "@wavekit/api-types"
import type { ScanRead, ScanValues } from "./scanner-guards.js"

export const SCAN_HISTORY_ROWS = 64
export const SCAN_PENDING_KEYS = 256
export const SCAN_JOBS = 200
export interface ScanLane<T> {
	value: T | null
	error: string | null
	at: number | null
}
export interface ScanDemand {
	sourceId: string
	cursor: string | null
	detail: { kind: "job" | "discovery"; id: string } | null
}
export interface ScanState {
	sourceId: string | null
	profile: SpectrumProfileEventData | null
	rows: {
		frame: SpectrumFrameEventData
		bins: Uint8Array
		receivedAt: number
	}[]
	phase: "not-requested" | "negotiating" | "waiting" | "removed" | "error"
	error: string | null
	invalidFrames: number
	omittedJobs: number
	lanes: { [K in ScanRead]: ScanLane<ScanValues[K]> }
}
const lane = <T>(): ScanLane<T> => ({ value: null, error: null, at: null })
export function initialScan(): ScanState {
	return {
		sourceId: null,
		profile: null,
		rows: [],
		phase: "not-requested",
		error: null,
		invalidFrames: 0,
		omittedJobs: 0,
		lanes: {
			status: lane(),
			spectrum: lane(),
			jobs: lane(),
			discoveries: lane(),
			job: lane(),
			discovery: lane(),
			observations: lane(),
		},
	}
}
export function selectScan(s: ScanState, sourceId: string | null): ScanState {
	return {
		...initialScan(),
		sourceId,
		phase: sourceId ? "negotiating" : "not-requested",
		invalidFrames: s.invalidFrames,
	}
}
export function resetScan(s: ScanState): ScanState {
	return {
		...s,
		rows: [],
		profile: null,
		phase: s.sourceId ? "negotiating" : "not-requested",
		error: null,
	}
}
export function scanProfile(
	s: ScanState,
	p: SpectrumProfileEventData,
): ScanState {
	if (!s.sourceId) return s
	return {
		...s,
		rows: [],
		profile: p,
		phase:
			p.outcome === "removed"
				? "removed"
				: p.outcome === "rejected"
					? "error"
					: "waiting",
		error: p.code ?? p.message ?? null,
	}
}
export function scanFrame(
	s: ScanState,
	frame: SpectrumFrameEventData,
	at: number,
): ScanState {
	const p = s.profile
	if (
		!p ||
		p.selection !== "source" ||
		p.sourceId !== s.sourceId ||
		frame.sourceId !== s.sourceId ||
		frame.profile !== p.profile?.key ||
		s.phase === "removed"
	)
		return s
	const prev = s.rows[s.rows.length - 1]?.frame
	const same =
		prev &&
		prev.sourceId === frame.sourceId &&
		prev.epoch === frame.epoch &&
		prev.profile === frame.profile &&
		prev.binCount === frame.binCount &&
		prev.sampleRateHz === frame.sampleRateHz &&
		prev.nativeBinHz === frame.nativeBinHz &&
		prev.binHz === frame.binHz &&
		prev.startHz === frame.startHz
	return {
		...s,
		phase: "waiting",
		rows: [
			...(same ? s.rows : []),
			{
				frame: { ...frame, bins: "" },
				bins: Buffer.from(frame.bins, "base64"),
				receivedAt: at,
			},
		].slice(-SCAN_HISTORY_ROWS),
	}
}
export function scanRead<K extends ScanRead>(
	s: ScanState,
	key: K,
	value: ScanValues[K] | null,
	error: string | null,
	at: number,
): ScanState {
	let next = { ...s, lanes: { ...s.lanes, [key]: { value, error, at } } }
	if (key === "jobs" && value) {
		const jobs = value as ScanValues["jobs"]
		next = {
			...next,
			omittedJobs: Math.max(0, jobs.length - SCAN_JOBS),
			lanes: {
				...next.lanes,
				jobs: { value: jobs.slice(0, SCAN_JOBS), error, at },
			},
		}
	}
	if (key === "spectrum" && value) {
		const status = (value as ScanValues["spectrum"]).sources.find(
			x => x.sourceId === s.sourceId,
		)
		if (status?.engine === "error" || status?.reason === "source-removed")
			next = {
				...next,
				rows: [],
				profile: null,
				phase: status.reason === "source-removed" ? "removed" : "error",
				error: status.lastError ?? status.reason ?? "spectrum engine error",
			}
	}
	if (key === "status" && value) {
		const engine = (value as ScanValues["status"]).engines.find(
			x => x.sourceId === s.sourceId,
		)
		if (engine?.state === "error")
			next = {
				...next,
				rows: [],
				profile: null,
				phase: "error",
				error: engine.lastError ?? "scanner engine error",
			}
	}
	return next
}
export function sameDemand(
	a: ScanDemand | null,
	b: ScanDemand | null,
): boolean {
	return (
		a?.sourceId === b?.sourceId &&
		a?.cursor === b?.cursor &&
		a?.detail?.kind === b?.detail?.kind &&
		a?.detail?.id === b?.detail?.id
	)
}

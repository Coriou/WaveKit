/**
 * The last automatic refusal per source, for `GET /api/scanner`. A refusal an operator asked for
 * answers the request; these are the ones only a log line used to tell.
 */
import type { ScannerLeaseRefusal } from "@wavekit/api-types"
import { ScannerApiError } from "./errors.js"

/**
 * Sources remembered. One entry per source, replaced by the next refusal; a process has few
 * sources, so this only stops ids that come and go: 64 × about 150 B ≈ 10 KB at most.
 */
export const LAST_REASON_SOURCES_MAX = 64

/**
 * Every code a passive start, a boot resume, an arbitration or a hand-back can raise: the job
 * driver's transitions, then what its actions call (arbiter, tuner, spectrum service and engine).
 * A test compares this list with those sources, so a new code there has to be added here.
 */
export const LAST_REASON_CODES = [
	"SCANNER_JOB_NOT_FOUND",
	"SCANNER_INVALID_TRANSITION",
	"SCANNER_TAKEOVER_REQUIRED",
	"SCANNER_SOURCE_BUSY",
	"SCANNER_SOURCE_DOWN",
	"SCANNER_NO_TUNER_CONTROL",
	"SCANNER_RESUME_HELD",
	"SCANNER_ENGINE_MISSING",
	"SCANNER_TUNER_WRITE",
	"SCANNER_LEASE_LOST",
	"SCANNER_ENGINE_FAILED",
	"SCANNER_SOURCE_NOT_IQ",
	"SCANNER_PIPELINE_ERROR",
	"SCANNER_PIPELINE_CLOSED",
	"SCANNER_WORKER_MISSING",
	"SCANNER_WORKER_EXIT",
	"SCANNER_WORKER_TIMEOUT",
	"SCANNER_WORKER_PROTOCOL",
	"SCANNER_WORKER_ERROR",
	"SPECTRUM_STOPPED",
	"SPECTRUM_OPTIONS_INVALID",
	"SPECTRUM_SOURCE_NOT_FOUND",
	"SPECTRUM_SOURCE_REMOVED",
	"SPECTRUM_SOURCE_NOT_IQ",
	"SPECTRUM_ENGINE_ERROR",
	"TUNER_SOURCE_NOT_FOUND",
	"TUNER_CONTROL_EXTERNAL",
	"TUNER_VALIDATION_ERROR",
	"TUNER_RESTORE_FAILED",
	"ACCESS_UNAVAILABLE",
] as const

const KNOWN_CODES: ReadonlySet<string> = new Set(LAST_REASON_CODES)
const SAFE_JOB_ID = /^[\w.:-]{1,64}$/

/**
 * The error's code when it is on the closed list, never its message: a message can carry a path,
 * an address or a value from outside, and so can a code set by other code. All else reads `UNKNOWN`.
 */
export function safeReasonCode(err: unknown): string {
	const code = (err as { code?: unknown } | null | undefined)?.code
	return typeof code === "string" && KNOWN_CODES.has(code) ? code : "UNKNOWN"
}

export function leaseRefusal(
	kind: ScannerLeaseRefusal["kind"],
	err: unknown,
	now: number,
): ScannerLeaseRefusal {
	const holder =
		err instanceof ScannerApiError ? err.details?.["holderJobId"] : undefined
	return {
		kind,
		code: safeReasonCode(err),
		at: new Date(now).toISOString(),
		...(typeof holder === "string" && SAFE_JOB_ID.test(holder)
			? { holderJobId: holder }
			: {}),
	}
}

/** One value per source, the oldest source dropped past the bound. */
export class LastReasons<T> {
	private readonly entries = new Map<string, T>()

	set(sourceId: string, value: T): void {
		this.entries.delete(sourceId)
		this.entries.set(sourceId, value)
		if (this.entries.size <= LAST_REASON_SOURCES_MAX) return
		for (const oldest of this.entries.keys()) {
			this.entries.delete(oldest)
			return
		}
	}

	get(sourceId: string): T | undefined {
		return this.entries.get(sourceId)
	}

	delete(sourceId: string): void {
		this.entries.delete(sourceId)
	}
}

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

const SAFE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const SAFE_JOB_ID = /^[\w.:-]{1,64}$/

/**
 * The error's closed code, never its message: a message can carry a path, an address or a value
 * from outside. Anything that is not a plain code reads `UNKNOWN`.
 */
export function safeReasonCode(err: unknown): string {
	const code = (err as { code?: unknown } | null | undefined)?.code
	return typeof code === "string" && SAFE_CODE.test(code) ? code : "UNKNOWN"
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

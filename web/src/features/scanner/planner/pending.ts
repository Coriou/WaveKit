/**
 * Running-mode edits, pure: range on/off, protocols and skips change mid-run and wait behind "N changes waiting ·
 * Discard · Apply"; Apply sends PATCH /api/scanner/jobs/:id with the full range list (edges, rasters, OBW and plan
 * id untouched: the core locks them) and the full exclusion list. The core applies the edit at the next hop.
 */
import type {
	ScanExclusion,
	ScanJob,
	ScanJobSpec,
	ScannerProtocol,
} from "@wavekit/api-types"

export interface RunDraft {
	/** By the job's range index. */
	readonly enabled: readonly boolean[]
	readonly protocols: readonly (readonly ScannerProtocol[])[]
	readonly exclusions: readonly ScanExclusion[]
}

type JobView = Pick<ScanJob, "spec">

/** The job's own live values (the draft with no change). */
export function draftOf(job: JobView): RunDraft {
	return {
		enabled: job.spec.ranges.map(r => r.enabled !== false),
		protocols: job.spec.ranges.map(r => r.protocols ?? []),
		exclusions: job.spec.exclusions,
	}
}

const sameSet = <T>(a: readonly T[], b: readonly T[]) =>
	a.length === b.length && a.every(x => b.includes(x))

const exclKey = (x: ScanExclusion) => `${x.startHz}:${x.endHz}`

export interface RunChange {
	/** The job's range index, or null for a job-level change (a skip). */
	readonly index: number | null
	readonly kind: "enabled" | "protocols" | "skip-added" | "skip-removed"
}

/** What the draft changes against the job (one entry per changed field). */
export function runChanges(job: JobView, draft: RunDraft): RunChange[] {
	const out: RunChange[] = []
	job.spec.ranges.forEach((r, i) => {
		if ((draft.enabled[i] ?? true) !== (r.enabled !== false))
			out.push({ index: i, kind: "enabled" })
		if (!sameSet(draft.protocols[i] ?? [], r.protocols ?? []))
			out.push({ index: i, kind: "protocols" })
	})
	const have = new Set(job.spec.exclusions.map(exclKey))
	const want = new Set(draft.exclusions.map(exclKey))
	for (const x of draft.exclusions)
		if (!have.has(exclKey(x))) out.push({ index: null, kind: "skip-added" })
	for (const x of job.spec.exclusions)
		if (!want.has(exclKey(x))) out.push({ index: null, kind: "skip-removed" })
	return out
}

/** Range indices with a change waiting (the row's amber dot). */
export function changedRanges(job: JobView, draft: RunDraft): Set<number> {
	return new Set(
		runChanges(job, draft)
			.map(c => c.index)
			.filter((i): i is number => i !== null),
	)
}

/** "1 change waiting", "3 changes waiting". */
export function pendingText(n: number): string {
	return n === 1 ? "1 change waiting" : `${n} changes waiting`
}

/** The PATCH body for the draft: every range with its locked fields as the job has them. */
export function patchSpec(job: JobView, draft: RunDraft): ScanJobSpec {
	return {
		ranges: job.spec.ranges.map((r, i) => ({
			...r,
			enabled: draft.enabled[i] ?? r.enabled !== false,
			protocols: [...(draft.protocols[i] ?? r.protocols ?? [])],
		})),
		exclusions: draft.exclusions.map(x => ({ ...x })),
	}
}

/** Drops a draft that no longer fits the job (its ranges changed under it). */
export function draftFits(job: JobView, draft: RunDraft): boolean {
	return (
		draft.enabled.length === job.spec.ranges.length &&
		draft.protocols.length === job.spec.ranges.length
	)
}

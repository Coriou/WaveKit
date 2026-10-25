/** Types for scripts/check-docs.mjs, so TypeScript tests can import it. */
export interface DocMapEntry {
	code: string[]
	docs: string[]
}

export interface DocMap {
	entries: DocMapEntry[]
}

export interface StalePage {
	docs: string[]
	code: string[]
}

export function userDocs(repo?: string): string[]
export function linkTargets(text: string): string[]
export function brokenLinks(file: string, repo?: string): string[]
/** One commit of a `git log` range: its `Docs:` trailers and the files it touched. */
export interface CommitDocs {
	trailers: string[]
	files: string[]
}

export function stalePages(
	changed: string[],
	map: DocMap,
	commits?: CommitDocs[],
): StalePage[]
export function splitZ(out: string): string[]
export function parseTrailers(out: string): string[]

/** A commit of the checked range; a merge lists only its own changes: files that conflicted and files that differ from the automatic merge of its parents. */
export interface RangeCommit extends CommitDocs {
	sha: string
	merge: boolean
}

export function commitsInRange(base: string, repo?: string): RangeCommit[]

export const EMPTY_TREE: string
export function mergeOwnFiles(
	sha: string,
	parents: string[],
	repo?: string,
): string[]

export type BaseResult =
	| { base: string; via: string; warning?: string; reason?: undefined }
	| { base?: undefined; via?: undefined; reason: string }

export function resolveBase(
	since: string,
	repo?: string,
	fallback?: string,
): BaseResult

export interface FreshnessResult {
	stale: StalePage[]
	skipped?: string
	base?: string
	via?: string
	warning?: string
}

export function checkFreshness(
	since: string,
	map: DocMap,
	repo?: string,
	fallback?: string,
): FreshnessResult

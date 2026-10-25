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
export function parseCommits(log: string): CommitDocs[]

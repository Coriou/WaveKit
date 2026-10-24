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
export function stalePages(
	changed: string[],
	map: DocMap,
	trailers?: string[],
): StalePage[]

/** Types for scripts/remote-check-lib.mjs: the exports TypeScript tests import. */
export interface Change {
	path: string
	status: string
	binary: boolean
	size: number
}
export interface AddedLine {
	line: number
	text: string
}
export interface Hit {
	file: string
	line: number
	label: string
}
export type Denylist =
	| { patterns: RegExp[]; missing?: boolean }
	| { error: string }
export interface Failure {
	test: string
	message: string
}
export interface FileResult {
	ok: boolean
	seconds: number
	failures: Failure[]
}
export interface Entry {
	file: string
	test: string
	message: string
}
export interface ShardVerdict {
	ok: boolean
	seconds: number
	steps: Record<string, number>
	failed: Entry[]
	flaky: Entry[]
	testSeconds?: number
	durations?: Record<string, number>
	tail?: Record<string, string[]>
}

export const SUMMARY_LINES: number
export const TAIL_LINES: number
export function tailLines(
	output: string,
	lines?: number,
	max?: number,
): string[]
export const FILE_OVERHEAD_S: number
export function parseDenylist(read: () => string | undefined): Denylist
export function addedLines(patch: string): Map<string, AddedLine[]>
export function scanHygiene(input: {
	changes: Change[]
	added: Map<string, AddedLine[]>
	denylist: Denylist
	inBase?: (token: string, find: (text: string) => string[]) => boolean
}): Hit[]
export function untrackedRefusals(
	untracked: { path: string; size: number }[],
	rootFileInBase: (path: string) => boolean,
): Hit[]
export function untrackedLine(paths: string[]): string
export function refusal(why: string, hits: Hit[]): string
export function commitMessage(paths: string[]): string
export function packShards(
	files: string[],
	weights: Record<string, number>,
	bins?: number,
): { files: string[]; weight: number; cost: number }[]
export function trimMessage(
	message: unknown,
	max?: number,
	lines?: number,
): string
export function parseVitestReport(
	report: unknown,
	root: string,
): Map<string, FileResult>
export function classifyShard(
	first: Map<string, Omit<FileResult, "seconds">>,
	reruns?: Map<string, Omit<FileResult, "seconds"> | undefined>,
): { failed: Entry[]; flaky: Entry[] }
export function artifactName(job: string): string
export function exitCode(input: {
	verdicts: Map<string, { ok: boolean }>
	expected: string[]
}): number
export function durationTable(
	durations: Record<string, number>[],
	previous?: Record<string, number>,
): Record<string, number>
export function formatSummary(s: {
	code: 0 | 1 | 2
	tree: string
	base: string
	seconds: number
	static?:
		| {
				ok: boolean
				seconds: number
				steps: Record<string, number>
				tail?: Record<string, string[]>
		  }
		| undefined
	root: (ShardVerdict | undefined)[]
	others?: {
		name: string
		ok: boolean
		seconds: number
		steps: Record<string, number>
		tail?: Record<string, string[]>
	}[]
	missing: string[]
	url: string
	runNote: string
	notes?: string[]
}): string
export function repoSlug(url: string): string
export function collectChanges(
	git: (args: string[]) => string,
	from: string,
	to: string,
): { changes: Change[]; added: Map<string, AddedLine[]> }
export function sweep(input: {
	git: (args: string[]) => string
	gh: (args: string[]) => string
	remote: string
	runs: { databaseId: number; headBranch: string; createdAt: string }[]
	now: number
	maxAgeMs: number
}): { branches: string[]; runs: number[] }

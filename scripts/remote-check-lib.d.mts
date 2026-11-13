/** Types for scripts/remote-check-lib.mjs, so TypeScript tests can import it. */
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
}

export const SHARDS: number
export const WORKERS: number
export const MESSAGE_CHARS: number
export const SUMMARY_LINES: number
export const BIG_FILE_BYTES: number
export const BRANCH_RE: RegExp
export const DENYLIST_PATH: string
export const UNTRACKED_DIRS: string[]
export const RUN_FIELDS: string
export const VIEW_FIELDS: string
export const NO_HITS: Hit[]
export function isLanIpv4(a: number, b: number): boolean
export function parseDenylist(read: () => string | undefined): Denylist
export function addedLines(patch: string): Map<string, AddedLine[]>
export function scanHygiene(input: {
	changes: Change[]
	added: Map<string, AddedLine[]>
	denylist: Denylist
	inBase?: (token: string) => boolean
}): Hit[]
export function untrackedRefusals(
	untracked: { path: string; size: number }[],
	rootFileInBase: (path: string) => boolean,
): Hit[]
export function untrackedLine(paths: string[]): string
export function refusal(why: string, hits: Hit[]): string
export function commitMessage(paths: string[]): string
export function docsProblem(text: string): string
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
	verdicts: Map<string, { ok: boolean; flaky?: unknown[] }>
	expected: string[]
	docsOk: boolean
}): number
export function shardSpread(seconds: number[]): number
export function durationTable(
	durations: Record<string, number>[],
	previous?: Record<string, number>,
): Record<string, number>
export function mmss(seconds: number): string
export function formatSummary(s: {
	code: 0 | 1 | 2 | 3
	tree: string
	base: string
	seconds: number
	static?:
		| { ok: boolean; seconds: number; steps: Record<string, number> }
		| undefined
	docsOk: boolean
	root: (ShardVerdict | undefined)[]
	others?: {
		name: string
		ok: boolean
		seconds: number
		steps: Record<string, number>
	}[]
	missing: string[]
	url: string
	runNote: string
	notes?: string[]
}): string
export function sweepTargets(input: {
	branches: { name: string; time: number }[]
	runs: { id: number; branch: string; createdAt: number }[]
	now: number
	maxAgeMs: number
}): { branches: string[]; runs: number[] }
export function repoSlug(url: string): string
export function collectChanges(
	git: (args: string[]) => string,
	from: string,
	to: string,
): { changes: Change[]; added: Map<string, AddedLine[]> }

export type Git = (
	args: string[],
	o?: { env?: Record<string, string> },
) => string
export function quiet<T>(f: () => T): T | undefined
export function ok(f: () => unknown): boolean
export function listUntracked(
	git: Git,
	root: string,
): { path: string; size: number }[]
export function writeTree(git: Git): string
export function refusals(input: {
	git: Git
	mb: string
	tree: string
	untracked: { path: string; size: number }[]
	denylist: Denylist
}): { hits: Hit[]; paths: string[] }
export function sweep(input: {
	git: Git
	gh: (args: string[]) => string
	remote: string
	runs: { databaseId: number; headBranch: string; createdAt: string }[]
	now: number
	maxAgeMs: number
}): { branches: string[]; runs: number[] }
export function verdictOf(r: {
	dl: string
	expected: string[]
	docs: { ok: boolean; text: string }
	notes: string[]
	view: { url: string; createdAt: string; updatedAt: string }
	tree12: string
	mb: string
	root: string
	out: string
	home: string
	now: number
}): { code: 0 | 1 | 2 | 3; text: string }

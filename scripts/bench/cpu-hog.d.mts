/** Types for scripts/bench/cpu-hog.mjs, so TypeScript tests can import it. */
export interface HogExitState {
	expectedParent: number
	currentParent: number
	startMs: number
	nowMs: number
	maxMs: number
}

export function hogExitReason(s: HogExitState): "parent" | "lifetime" | null
export function parseHogArgs(
	argv: readonly string[],
	ppid: number,
): { expectedParent: number; maxMs: number } | null

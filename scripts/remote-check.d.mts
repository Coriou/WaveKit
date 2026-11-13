/** Types for scripts/remote-check.mjs, so TypeScript tests can drive it with fake processes. */
export interface RunOpts {
	cwd?: string
	env?: Record<string, string>
}
export interface Deps {
	git: (args: string[], o?: RunOpts) => string
	gh: (args: string[]) => string
	sleep: (ms: number) => Promise<unknown>
	now: () => number
	home: string
}
export const defaultDeps: Deps
export function remoteCheck(
	d: Deps,
	argv: string[],
): Promise<{ text: string; code: number }>

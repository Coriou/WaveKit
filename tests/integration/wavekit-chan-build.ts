/**
 * Capability probe for integration tests that build native/wavekit-chan with
 * `cargo build --offline`. Having cargo is not enough: an offline build also
 * needs every locked crate already in the local cargo cache, which a fresh CI
 * runner does not have. Only a recognised cache miss skips; any other probe
 * failure throws, and a build that then fails is a real failure.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

export const CHAN_CACHE_MISS =
	"wavekit-chan crates are not in the local cargo cache (offline build impossible)"

// Cargo's offline cache-miss reports: an unresolved crate (no cached index
// entry) or a locked crate whose source was never downloaded.
const CACHE_MISS = [
	/no matching package named `[^`]+` found[\s\S]*offline mode \(via `--offline`\)/,
	/attempting to make an HTTP request, but --offline was specified/,
]

/**
 * Classifies `cargo fetch --offline --locked`: undefined when the offline build
 * can run, the cache-miss reason when the crates are simply not cached, and a
 * thrown error (stderr included) for anything else, such as an invalid
 * manifest, a stale lockfile or a permission error, so those never skip.
 */
export function classifyChanFetch(
	status: number | null,
	stderr: string,
): string | undefined {
	if (status === 0) return undefined
	if (CACHE_MISS.some(pattern => pattern.test(stderr))) return CHAN_CACHE_MISS
	throw new Error(
		`cargo fetch --offline --locked failed (status ${String(status)}): ${stderr.slice(0, 2048)}`,
	)
}

export function wavekitChanBuildUnavailable(crate: string): string | undefined {
	const cargo = spawnSync("cargo", ["--version"], { stdio: "ignore" })
	if (cargo.error !== undefined) return "cargo is not installed"
	const fetch = spawnSync("cargo", ["fetch", "--offline", "--locked"], {
		cwd: crate,
		encoding: "utf8",
		stdio: ["ignore", "ignore", "pipe"],
	})
	if (fetch.error !== undefined)
		throw new Error(`cargo fetch could not run: ${String(fetch.error)}`)
	return classifyChanFetch(fetch.status, fetch.stderr)
}

/**
 * Builds the release binary into `target` without blocking the event loop
 * (a synchronous multi-minute build starves vitest's worker RPC) and returns
 * its path. Any build failure throws.
 */
export async function buildWavekitChan(
	crate: string,
	target: string,
): Promise<string> {
	const status = await new Promise<number | null>(done => {
		const child = spawn(
			"cargo",
			["build", "--release", "--offline", "--bin", "wavekit-chan"],
			{
				cwd: crate,
				env: { ...process.env, CARGO_TARGET_DIR: target },
				stdio: "ignore",
			},
		)
		child.once("error", () => done(null))
		child.once("close", code => done(code))
	})
	const binary = join(target, "release", "wavekit-chan")
	if (status !== 0 || !existsSync(binary))
		throw new Error("wavekit-chan build failed")
	return binary
}

/**
 * Capability probe for integration tests that build native/wavekit-chan with
 * `cargo build --offline`. Having cargo is not enough: an offline build also
 * needs every locked crate already in the local cargo cache, which a fresh CI
 * runner does not have. Returns the reason the build cannot run here, or
 * undefined when it can; a build that then fails is a real failure.
 */
import { spawn, spawnSync } from "node:child_process"
import { existsSync } from "node:fs"
import { join } from "node:path"

export function wavekitChanBuildUnavailable(crate: string): string | undefined {
	const cargo = spawnSync("cargo", ["--version"], { stdio: "ignore" })
	if (cargo.error !== undefined) return "cargo is not installed"
	const fetch = spawnSync("cargo", ["fetch", "--offline", "--locked"], {
		cwd: crate,
		stdio: "ignore",
	})
	if (fetch.error !== undefined || fetch.status !== 0)
		return "wavekit-chan crates are not in the local cargo cache (offline build impossible)"
	return undefined
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

import { createHash } from "node:crypto"
import {
	accessSync,
	chmodSync,
	constants,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Test executables (command shims, fake programs) without the first-exec cost.
 *
 * macOS assesses every newly written executable on its first exec. Measured on
 * the dev Mac: ~0.6-0.7 s per fresh script versus ~25 ms for a repeat exec,
 * growing with host load. Tests that wrote fresh shims per test spent most of
 * their time (and timed out under load) in that assessment. Each distinct
 * script body is therefore written once per machine, keyed by content hash,
 * and per-test paths are symlinks to it: `$0` keeps the link name (so a shared
 * shim can still dispatch on its own name) and the link costs no assessment.
 */
// Per-user and private: on Linux tmpdir() is a shared /tmp.
const CACHE_DIR = join(
	tmpdir(),
	`wavekit-test-executables-${process.getuid?.() ?? "user"}`,
)

function cachedExecutable(body: string): string {
	const hash = createHash("sha256").update(body).digest("hex").slice(0, 32)
	const target = join(CACHE_DIR, hash)
	try {
		if (readFileSync(target, "utf8") === body) {
			accessSync(target, constants.X_OK)
			return target
		}
	} catch {
		// Not cached yet; write it below.
	}
	mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 })
	// Concurrent workers may race: write privately, then rename atomically.
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}`
	try {
		writeFileSync(temporary, body, { mode: 0o755 })
		chmodSync(temporary, 0o755)
		renameSync(temporary, target)
	} finally {
		rmSync(temporary, { force: true })
	}
	return target
}

/** Creates `path` as an executable running `body` (a script with a shebang). */
export function writeExecutable(path: string, body: string): void {
	symlinkSync(cachedExecutable(body), path)
}

// The source digest of a wasm kernel crate (native/wavekit-frame, native/wavekit-nfm).
//
// The crate's build.sh computes the same digest and stores it in the artefact (a custom section,
// KERNEL_DIGEST_SECTION); build-file.mjs bundles the digest of the sources the JS was built with,
// and the loaders refuse an artefact whose digest differs, so a kernel left over from older
// sources falls back to JS instead of running.
//
// Digest: sha256 (hex) of a manifest with one line per file, "<sha256 hex>  <path>\n", for
// build.sh, Cargo.toml, Cargo.lock and every file under src/, paths relative to the crate and
// sorted bytewise (LC_ALL=C sort).
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { fileURLToPath } from "node:url"

/** Name of the custom section build.sh appends (64 hex characters). */
export const KERNEL_DIGEST_SECTION = "wavekit.source-digest"

const root = fileURLToPath(new URL("../", import.meta.url))

/** The crates, by kernel. */
export const KERNEL_CRATES = {
	frame: join(root, "native", "wavekit-frame"),
	nfm: join(root, "native", "wavekit-nfm"),
}

function filesUnder(dir) {
	const out = []
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name)
		if (entry.isDirectory()) out.push(...filesUnder(path))
		else if (entry.isFile()) out.push(path)
	}
	return out
}

/** `dir` and every directory below it: esbuild's directory watches are not recursive. */
function dirsUnder(dir) {
	const out = [dir]
	for (const entry of readdirSync(dir, { withFileTypes: true }))
		if (entry.isDirectory()) out.push(...dirsUnder(join(dir, entry.name)))
	return out
}

function sha256(bytes) {
	return createHash("sha256").update(bytes).digest("hex")
}

/** The digest of one crate and the files it covers (absolute paths). Throws if the crate is missing. */
export function kernelSourceDigest(crateDir) {
	const files = [
		join(crateDir, "build.sh"),
		join(crateDir, "Cargo.toml"),
		join(crateDir, "Cargo.lock"),
		...filesUnder(join(crateDir, "src")),
	]
	const rel = files.map(f => ({
		file: f,
		path: relative(crateDir, f).split(sep).join("/"),
	}))
	// Bytewise order, as LC_ALL=C sort (paths are ASCII in these crates; Buffer.compare is exact).
	rel.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)))
	const manifest = rel
		.map(({ file, path }) => `${sha256(readFileSync(file))}  ${path}\n`)
		.join("")
	return { digest: sha256(manifest), files: rel.map(r => r.file) }
}

const DIGEST_MODULE = /[\\/]src[\\/]core[\\/]spectrum[\\/]kernel-digest\.ts$/

/**
 * esbuild plugin: replaces src/core/spectrum/kernel-digest.ts (null digests, for unbundled runs)
 * with the digests of the crates as they are now. In watch mode a change to a crate's sources
 * rebuilds the bundle with the new digests.
 */
export function kernelDigestPlugin() {
	return {
		name: "wavekit-kernel-digest",
		setup(build) {
			build.onLoad({ filter: DIGEST_MODULE }, () => {
				const frame = kernelSourceDigest(KERNEL_CRATES.frame)
				const nfm = kernelSourceDigest(KERNEL_CRATES.nfm)
				return {
					contents:
						`export const FRAME_SOURCE_DIGEST = ${JSON.stringify(frame.digest)}\n` +
						`export const NFM_SOURCE_DIGEST = ${JSON.stringify(nfm.digest)}\n`,
					loader: "ts",
					watchFiles: [...frame.files, ...nfm.files],
					watchDirs: [
						...dirsUnder(join(KERNEL_CRATES.frame, "src")),
						...dirsUnder(join(KERNEL_CRATES.nfm, "src")),
					],
				}
			})
		},
	}
}

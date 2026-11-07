/** Types for scripts/kernel-digest.mjs, so TypeScript tests can import it. */
export const KERNEL_DIGEST_SECTION: string
export const KERNEL_CRATES: { frame: string; nfm: string }
export function kernelSourceDigest(crateDir: string): {
	digest: string
	files: string[]
}
export function kernelDigestPlugin(): {
	name: string
	setup: (build: unknown) => void
}

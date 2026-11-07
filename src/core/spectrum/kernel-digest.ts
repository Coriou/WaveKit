/**
 * The source digests of the wasm kernels' crates (native/wavekit-frame, native/wavekit-nfm) that
 * this bundle was built with. scripts/build-file.mjs replaces this module at bundle time
 * (scripts/kernel-digest.mjs); unbundled (vitest, tsx) both stay null and the loaders skip the
 * check. A loader refuses an artefact whose embedded digest differs: it is older than its sources.
 */
export const FRAME_SOURCE_DIGEST: string | null = null
export const NFM_SOURCE_DIGEST: string | null = null

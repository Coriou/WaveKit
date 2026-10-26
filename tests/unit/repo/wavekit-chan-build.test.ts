import { describe, expect, it } from "vitest"
import {
	CHAN_CACHE_MISS,
	classifyChanFetch,
} from "../../integration/wavekit-chan-build.js"

// `cargo fetch --offline --locked` stderr. UNRESOLVED, INVALID_MANIFEST and
// STALE_LOCK were captured against native/wavekit-chan (empty CARGO_HOME,
// broken manifest, stale lock); UNDOWNLOADED and PERMISSION follow cargo's
// format for a cached index without the crate source and an unreadable file.
const UNRESOLVED = `error: no matching package named \`serde\` found
location searched: crates.io index
required by package \`wavekit-chan v0.1.0 (/work/native/wavekit-chan)\`
note: offline mode (via \`--offline\`) can sometimes cause surprising resolution failures
help: if this error is too confusing you may wish to retry without \`--offline\`
`
const UNDOWNLOADED = `error: failed to download \`serde v1.0.228\`

Caused by:
  attempting to make an HTTP request, but --offline was specified
`
const INVALID_MANIFEST = `error: key with no value, expected \`=\`
  --> Cargo.toml:23:6
   |
23 | this is = = broken
   |      ^
`
const STALE_LOCK = `error: cannot update the lock file /work/native/wavekit-chan/Cargo.lock because --locked was passed to prevent this
help: to generate the lock file without accessing the network, remove the --locked flag and use --offline instead.
`
const PERMISSION = `error: failed to open: /work/native/wavekit-chan/Cargo.lock

Caused by:
  Permission denied (os error 13)
`

describe("wavekit-chan offline build probe", () => {
	it("runs the build when the fetch succeeds", () => {
		expect(classifyChanFetch(0, "")).toBeUndefined()
	})

	it.each([
		["an unresolved crate", UNRESOLVED],
		["a locked crate never downloaded", UNDOWNLOADED],
	])("skips with the cache-miss reason for %s", (_name, stderr) => {
		expect(classifyChanFetch(101, stderr)).toBe(CHAN_CACHE_MISS)
	})

	it.each([
		["an invalid manifest", INVALID_MANIFEST, "key with no value"],
		["a stale lockfile", STALE_LOCK, "cannot update the lock file"],
		["a permission error", PERMISSION, "Permission denied"],
		["a signal-killed fetch", "", "status null"],
	])("throws with stderr for %s", (_name, stderr, quoted) => {
		const status = stderr ? 101 : null
		expect(() => classifyChanFetch(status, stderr)).toThrow(quoted)
	})
})

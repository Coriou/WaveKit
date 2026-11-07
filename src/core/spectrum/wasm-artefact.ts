/**
 * Reading and compiling a wasm kernel artefact (frame-wasm.ts, scanner/channel/wideband-nfm-wasm.ts),
 * with a reason for every way it can fail, so the "path js" log line says what actually happened:
 *
 * - the default file is missing (dev builds have none), or a configured path is missing (the path
 *   is operator-supplied: logged as given, quoted and length-capped);
 * - the file cannot be read (the error code);
 * - the bytes do not validate (and, only if a minimal SIMD module does not validate either, that
 *   this host has no wasm SIMD), or do not compile;
 * - the artefact is older than its sources: build.sh embeds the crate's source digest
 *   (scripts/kernel-digest.mjs) and the bundle carries the digest of the sources it was built
 *   with (kernel-digest.ts); a missing or different digest is refused. Unbundled (digest null) the
 *   check is skipped.
 *
 * Instantiation failures and ABI mismatches are reported by each kernel's `create`.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/** The custom section build.sh appends: 64 lower-case hex characters. */
export const KERNEL_DIGEST_SECTION = "wavekit.source-digest"
/** Longest configured path quoted in a reason. */
export const MAX_REASON_PATH = 160

interface WasmModuleCtor {
	new (bytes: Uint8Array): object
	customSections(module: object, name: string): ArrayBuffer[]
}
interface WasmLoadApi {
	validate(bytes: Uint8Array): boolean
	Module: WasmModuleCtor
}

function wasmLoadApi(): WasmLoadApi | null {
	const w = (globalThis as { WebAssembly?: WasmLoadApi }).WebAssembly
	return w ?? null
}

/**
 * The smallest module that needs wasm SIMD: one function returning `v128.const 0`. It validates
 * wherever SIMD does; if the artefact fails and this passes, the artefact itself is bad.
 */
const SIMD_PROBE = Uint8Array.from([
	0x00,
	0x61,
	0x73,
	0x6d,
	0x01,
	0x00,
	0x00,
	0x00,
	// type: () -> v128
	0x01,
	0x05,
	0x01,
	0x60,
	0x00,
	0x01,
	0x7b,
	// function 0 of type 0
	0x03,
	0x02,
	0x01,
	0x00,
	// code: no locals, v128.const 0 (16 bytes), end
	0x0a,
	0x16,
	0x01,
	0x14,
	0x00,
	0xfd,
	0x0c,
	...Array.from({ length: 16 }, () => 0),
	0x0b,
])

/** True when this runtime validates wasm SIMD. */
export function wasmSimdSupported(): boolean {
	const api = wasmLoadApi()
	return api !== null && api.validate(SIMD_PROBE)
}

export interface WasmArtefactOptions {
	/** The artefact's file name (reasons for the default location). */
	file: string
	/** The crate, for the rebuild hint ("native/wavekit-frame"). */
	crate: string
	/** The env var the location came from; absent: the default location. */
	configuredBy?: string
	/** The bundled source digest; null: unbundled, not checked. */
	digest: string | null
}

export type WasmArtefactLoad =
	| { ok: true; module: object }
	| { ok: false; reason: string }

/** An operator-supplied path as it may appear in a reason: as given, quoted, at most MAX_REASON_PATH. */
export function reasonPath(location: string | URL): string {
	let s: string
	if (typeof location === "string") s = location
	else {
		try {
			s = fileURLToPath(location)
		} catch {
			s = location.href
		}
	}
	const capped =
		s.length > MAX_REASON_PATH ? `${s.slice(0, MAX_REASON_PATH - 1)}…` : s
	return JSON.stringify(capped)
}

function errorName(err: unknown): string {
	return err instanceof Error ? err.name : "unknown"
}

/** Reads, validates, compiles and digest-checks an artefact. Throws nothing. */
export function loadWasmArtefact(
	location: string | URL,
	opts: WasmArtefactOptions,
): WasmArtefactLoad {
	const where =
		opts.configuredBy === undefined
			? opts.file
			: `configured path ${reasonPath(location)} (${opts.configuredBy})`
	let bytes: Uint8Array
	try {
		bytes = readFileSync(location)
	} catch (err) {
		const code = (err as { code?: unknown }).code
		return {
			ok: false,
			reason:
				code === "ENOENT"
					? `${where} not found`
					: `cannot read ${where}: ${typeof code === "string" ? code : errorName(err)}`,
		}
	}
	return compileWasmArtefact(bytes, opts)
}

/** Validates, compiles and digest-checks artefact bytes. Throws nothing. */
export function compileWasmArtefact(
	bytes: Uint8Array,
	opts: Pick<WasmArtefactOptions, "file" | "crate" | "digest">,
): WasmArtefactLoad {
	const api = wasmLoadApi()
	if (!api) return { ok: false, reason: "no WebAssembly in this runtime" }
	if (!api.validate(bytes))
		return {
			ok: false,
			reason: wasmSimdSupported()
				? `${opts.file} does not validate`
				: `${opts.file} does not validate (no wasm SIMD on this host)`,
		}
	let module: object
	try {
		module = new api.Module(bytes)
	} catch (err) {
		return {
			ok: false,
			reason: `${opts.file} does not compile: ${errorName(err)}`,
		}
	}
	if (opts.digest !== null) {
		const embedded = embeddedDigest(api, module)
		if (embedded !== opts.digest)
			return {
				ok: false,
				reason:
					embedded === null
						? `artefact older than its sources: ${opts.file} carries no source digest (rebuild with ${opts.crate}/build.sh)`
						: `source digest differs: kernel ${embedded.slice(0, 12)}, bundle ${opts.digest.slice(0, 12)}; rebuild the stale side (${opts.crate}/build.sh for the kernel, pnpm run build for the bundle)`,
			}
	}
	return { ok: true, module }
}

/** The artefact's embedded source digest; null when absent, repeated or malformed. */
function embeddedDigest(api: WasmLoadApi, module: object): string | null {
	const sections = api.Module.customSections(module, KERNEL_DIGEST_SECTION)
	if (sections.length !== 1) return null
	const text = new TextDecoder().decode(sections[0])
	return /^[0-9a-f]{64}$/.test(text) ? text : null
}

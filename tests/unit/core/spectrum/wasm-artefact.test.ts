/**
 * The kernel loaders' reasons (frame-wasm.ts, wideband-nfm-wasm.ts over wasm-artefact.ts): every
 * way an artefact fails says what happened, and an artefact built from other sources than the
 * bundle's is refused (scripts/kernel-digest.mjs, the crates' build.sh).
 */
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { build } from "esbuild"
import { afterAll, describe, expect, it, vi } from "vitest"
import {
	compileFrameWasm,
	FRAME_WASM_FILE,
	loadFrameWasm,
} from "../../../../src/core/spectrum/frame-wasm.js"
import {
	compileNfmWasm,
	loadNfmWasm,
	NFM_WASM_FILE,
} from "../../../../src/core/scanner/channel/wideband-nfm-wasm.js"
import {
	WidebandNfmRuntime,
	widebandNfmChainPath,
} from "../../../../src/core/scanner/channel/wideband-nfm.js"
import {
	MAX_REASON_PATH,
	reasonPath,
	wasmSimdSupported,
} from "../../../../src/core/spectrum/wasm-artefact.js"
import {
	KERNEL_CRATES,
	kernelDigestPlugin,
	kernelSourceDigest,
} from "../../../../scripts/kernel-digest.mjs"
import { recordingLog } from "../scanner/channel/nfm-wasm-harness.js"
import { Harness } from "./pipeline-harness.js"
import { wasmModule } from "./wasm-module-bytes.js"

const dir = mkdtempSync(path.join(os.tmpdir(), "wk-wasm-artefact-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

/** The WebAssembly global (the es2024 lib declares no value for it). */
const wasmGlobal = (
	globalThis as unknown as {
		WebAssembly: { validate: (bytes: Uint8Array) => boolean }
	}
).WebAssembly

const A = "a".repeat(64)
const B = "b".repeat(64)

const FRAME_EXPORTS = (abi: number) => [
	{ name: "fp_abi", params: 0, value: abi },
	{ name: "fp_ctl_bytes", params: 0, value: 0 },
	{ name: "fp_init", params: 1, value: 0 },
	{ name: "fp_run", params: 1, value: 0 },
]
const NFM_EXPORTS = (abi: number) => [
	{ name: "nfm_abi", params: 0, value: abi },
	{ name: "nfm_check", params: 1, value: 0 },
	{ name: "nfm_run", params: 1, value: 0 },
]

function file(name: string, bytes: Uint8Array): string {
	const p = path.join(dir, name)
	writeFileSync(p, bytes)
	return p
}

/** Both loaders, so every case runs on each. */
const LOADERS = [
	{
		kernel: "frame",
		file: FRAME_WASM_FILE,
		env: "WAVEKIT_SPECTRUM_FRAME_WASM",
		load: loadFrameWasm,
		compile: compileFrameWasm,
		exports: FRAME_EXPORTS,
	},
	{
		kernel: "nfm",
		file: NFM_WASM_FILE,
		env: "WAVEKIT_RECORDER_DSP_WASM",
		load: loadNfmWasm,
		compile: compileNfmWasm,
		exports: NFM_EXPORTS,
	},
] as const

describe.each(LOADERS)("$kernel artefact reasons", l => {
	it("a missing default file names the file", () => {
		expect(l.load(path.join(dir, "absent", l.file))).toEqual({
			ok: false,
			reason: `${l.file} not found`,
		})
	})

	it("a missing configured path names the path as given, quoted, and the variable", () => {
		const given = path.join(dir, "absent", "custom.wasm")
		expect(l.load(given, { configuredBy: l.env })).toEqual({
			ok: false,
			reason: `configured path ${JSON.stringify(given)} (${l.env}) not found`,
		})
	})

	it("a long or hostile configured path is capped and escaped", () => {
		const given = `/x\n${"y".repeat(500)}`
		const r = l.load(given, { configuredBy: l.env })
		expect(r.ok).toBe(false)
		const reason = r.ok ? "" : r.reason
		expect(reason).not.toContain("\n")
		expect(reason).toContain(reasonPath(given))
		expect(JSON.parse(reasonPath(given))).toHaveLength(MAX_REASON_PATH)
		expect(reason.length).toBeLessThan(MAX_REASON_PATH + 100)
	})

	it("an unreadable path gives the error code", () => {
		const sub = path.join(dir, `${l.kernel}-a-directory`)
		mkdirSync(sub, { recursive: true })
		expect(l.load(sub)).toEqual({
			ok: false,
			reason: `cannot read ${l.file}: EISDIR`,
		})
	})

	it("bytes that do not validate say so; no SIMD is blamed while SIMD validates", () => {
		expect(wasmSimdSupported()).toBe(true)
		expect(
			l.load(file(`${l.kernel}-junk.wasm`, Uint8Array.from([1, 2, 3]))),
		).toEqual({
			ok: false,
			reason: `${l.file} does not validate`,
		})
	})

	it("on a host where the SIMD probe does not validate either, the reason says so", () => {
		const spy = vi.spyOn(wasmGlobal, "validate").mockReturnValue(false)
		try {
			expect(wasmSimdSupported()).toBe(false)
			expect(l.compile(Uint8Array.from([1, 2, 3]))).toEqual({
				ok: false,
				reason: `${l.file} does not validate (no wasm SIMD on this host)`,
			})
		} finally {
			spy.mockRestore()
		}
	})

	it("bytes that validate but do not compile say so", () => {
		const spy = vi.spyOn(wasmGlobal, "validate").mockReturnValue(true)
		try {
			expect(l.compile(Uint8Array.from([1, 2, 3]))).toEqual({
				ok: false,
				reason: `${l.file} does not compile: CompileError`,
			})
		} finally {
			spy.mockRestore()
		}
	})

	it("an artefact without a source digest is older than its sources", () => {
		const r = l.compile(wasmModule({ exports: l.exports(1) }), { digest: A })
		expect(r.ok).toBe(false)
		expect(!r.ok && r.reason).toBe(
			`artefact older than its sources: ${l.file} carries no source digest (rebuild with native/wavekit-${l.kernel}/build.sh)`,
		)
	})

	it("an artefact with another digest names both digests and both rebuilds", () => {
		const r = l.compile(wasmModule({ exports: l.exports(1), digest: B }), {
			digest: A,
		})
		expect(!r.ok && r.reason).toBe(
			`source digest differs: kernel bbbbbbbbbbbb, bundle aaaaaaaaaaaa; rebuild the stale side (native/wavekit-${l.kernel}/build.sh for the kernel, pnpm run build for the bundle)`,
		)
		// a malformed digest is no digest
		const bad = l.compile(
			wasmModule({ exports: l.exports(1), digest: "A".repeat(64) }),
			{ digest: A },
		)
		expect(!bad.ok && bad.reason).toMatch(/carries no source digest/)
	})

	it("the same digest loads; unbundled (null, the default under vitest) is not checked", () => {
		expect(
			l.compile(wasmModule({ exports: l.exports(1), digest: A }), { digest: A })
				.ok,
		).toBe(true)
		expect(l.compile(wasmModule({ exports: l.exports(1) })).ok).toBe(true)
		expect(
			l.compile(wasmModule({ exports: l.exports(1) }), { digest: null }).ok,
		).toBe(true)
	})
})

describe("instantiation reasons", () => {
	it("frame: an ABI mismatch and a failed instantiation say which", () => {
		const abi = compileFrameWasm(wasmModule({ exports: FRAME_EXPORTS(2) }))
		expect(abi.ok).toBe(true)
		const h = new Harness({}, { frameWasm: abi.ok ? abi.module : null })
		expect(h.pipeline.framePath).toEqual({
			path: "js",
			reason: "ABI mismatch: frame kernel ABI 2, expected 1",
		})
		const link = compileFrameWasm(
			wasmModule({ imports: ["absent_import"], exports: FRAME_EXPORTS(1) }),
		)
		expect(link.ok).toBe(true)
		const h2 = new Harness({}, { frameWasm: link.ok ? link.module : null })
		expect(h2.pipeline.framePath).toEqual({
			path: "js",
			reason: "instantiate failed: LinkError",
		})
	})

	it("nfm: an ABI mismatch and a failed instantiation say which", () => {
		const cases = [
			{
				bytes: wasmModule({ exports: NFM_EXPORTS(2) }),
				reason: "ABI mismatch: NFM kernel ABI 2, expected 1",
			},
			{
				bytes: wasmModule({
					imports: ["absent_import"],
					exports: NFM_EXPORTS(1),
				}),
				reason: "instantiate failed: LinkError",
			},
		]
		for (const [i, c] of cases.entries()) {
			const log = recordingLog()
			const runtime = new WidebandNfmRuntime({
				choice: "auto",
				location: file(`nfm-instance-${i}.wasm`, c.bytes),
				log,
				digest: null,
			})
			const chain = runtime.chain({ inputRateHz: 1_024_000, offsetHz: 50_000 })
			expect(widebandNfmChainPath(chain)).toBe("js")
			expect(log.lines.at(-1)?.obj).toEqual({ path: "js", reason: c.reason })
		}
	})
})

describe("source digests", () => {
	it.each(["frame", "nfm"] as const)(
		"%s: build.sh --digest computes what scripts/kernel-digest.mjs computes",
		kernel => {
			const crate = KERNEL_CRATES[kernel]
			const sh = execFileSync(
				"sh",
				[path.join(crate, "build.sh"), "--digest"],
				{
					encoding: "utf8",
				},
			).trim()
			expect(sh).toMatch(/^[0-9a-f]{64}$/)
			expect(sh).toBe(kernelSourceDigest(crate).digest)
		},
	)

	it("a change to any covered file changes the digest", () => {
		const crate = path.join(dir, "crate")
		mkdirSync(path.join(crate, "src", "nested"), { recursive: true })
		for (const f of ["build.sh", "Cargo.toml", "Cargo.lock", "src/lib.rs"])
			writeFileSync(path.join(crate, f), f)
		const before = kernelSourceDigest(crate)
		expect(before.files).toHaveLength(4)
		writeFileSync(path.join(crate, "src", "nested", "more.rs"), "x")
		const added = kernelSourceDigest(crate)
		expect(added.digest).not.toBe(before.digest)
		writeFileSync(path.join(crate, "Cargo.lock"), "changed")
		expect(kernelSourceDigest(crate).digest).not.toBe(added.digest)
	})

	it("the bundle carries the digests of the crates as they are now", async () => {
		const out = await build({
			entryPoints: [
				path.resolve(
					import.meta.dirname,
					"../../../../src/core/spectrum/kernel-digest.ts",
				),
			],
			bundle: true,
			write: false,
			format: "esm",
			platform: "node",
			plugins: [kernelDigestPlugin()],
			logLevel: "silent",
		})
		const text = out.outputFiles[0]?.text ?? ""
		expect(text).toContain(
			JSON.stringify(kernelSourceDigest(KERNEL_CRATES.frame).digest),
		)
		expect(text).toContain(
			JSON.stringify(kernelSourceDigest(KERNEL_CRATES.nfm).digest),
		)
	})
})

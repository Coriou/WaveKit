import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const bake = readFileSync("docker/bake.hcl", "utf8")
const dockerfile = readFileSync("Dockerfile", "utf8")
const dockerignore = readFileSync(".dockerignore", "utf8").split("\n")
const target = (name: string) =>
	bake.slice(
		bake.indexOf(`target "${name}" {`),
		bake.indexOf("\n}\n", bake.indexOf(`target "${name}" {`)),
	)

describe("wavekit-chan image integration (addendum §10)", () => {
	it("caches chan-build only in the final and final-core chains", () => {
		expect(target("final")).toContain('cache("chan-build")')
		expect(target("final-core")).toContain('cache("chan-build")')
		expect(target("final-sdrpp")).not.toContain("chan-build")
		expect(target("final-demod")).not.toContain("chan-build")
	})
	it("builds from a version- and digest-pinned Rust bookworm image with --locked and verifies the binary", () => {
		const image =
			/ARG RUST_IMAGE=rust:1\.(\d+)\.\d+-slim-bookworm@sha256:[0-9a-f]{64}\n/.exec(
				dockerfile,
			)
		expect(image).not.toBeNull()
		// native/wavekit-chan/Cargo.toml declares rust-version = "1.88"
		expect(Number(image?.[1])).toBeGreaterThanOrEqual(88)
		expect(dockerfile).toMatch(/FROM \$\{RUST_IMAGE\} AS chan-build/)
		expect(dockerfile).toContain("cargo build --release --locked")
		expect(dockerfile).toContain(
			"COPY --from=chan-build /usr/local/bin/wavekit-chan /usr/local/bin/",
		)
		expect(dockerfile).toContain("wavekit-chan --version")
		expect(dockerfile).toContain("ldd /usr/local/bin/wavekit-chan")
	})
	it("never reuses another build's binary from the shared target cache, and refuses one without recenter", () => {
		const stage = dockerfile.slice(
			dockerfile.indexOf("AS chan-build"),
			dockerfile.indexOf("AS final-base"),
		)
		const touch = stage.indexOf("find src -type f -exec touch {} +")
		const build = stage.indexOf("cargo build --release --locked")
		expect(touch).toBeGreaterThan(-1)
		expect(touch).toBeLessThan(build)
		const check = stage.indexOf(`grep -q '"recenter":true'`)
		expect(check).toBeGreaterThan(stage.indexOf("install -m 0755"))
		// A binary without the line fails the RUN; the check is not a `;` away from being ignored.
		expect(stage.slice(check)).toMatch(
			/^grep -q '"recenter":true' \|\| \{ echo [^;]+; exit 1; \}/,
		)
	})
	it("adds wavekit-chan to final-base only, so final-sdrpp and final-demod stay unchanged", () => {
		const stage = (name: string) => {
			const start = dockerfile.search(new RegExp(`^FROM \\S+ AS ${name}$`, "m"))
			expect(start).toBeGreaterThanOrEqual(0)
			const rest = dockerfile.slice(start + 1)
			const next = rest.search(/^FROM /m)
			return next === -1 ? rest : rest.slice(0, next)
		}
		expect(stage("final-base")).toContain("COPY --from=chan-build")
		expect(stage("final-sdrpp")).not.toContain("chan-build")
		expect(stage("final-demod")).not.toContain("chan-build")
	})
	it("ships the third-party notices next to the binary (final review infra M8)", () => {
		// Explicit re-include after `*.md`, so a later widening (e.g. `**/*.md`) cannot drop the notices.
		const reinclude = dockerignore.indexOf("!native/wavekit-chan/LICENSES.md")
		expect(reinclude).toBeGreaterThan(dockerignore.indexOf("*.md"))
		expect(dockerfile).toContain(
			"COPY native/wavekit-chan/LICENSES.md /usr/share/doc/wavekit-chan/LICENSES.md",
		)
		const notices = readFileSync("native/wavekit-chan/LICENSES.md", "utf8")
		for (const crate of [
			"serde",
			"serde_core",
			"serde_json",
			"itoa",
			"memchr",
			"zmij",
		])
			expect(notices).toMatch(new RegExp(`^\\| ${crate} +\\|`, "m"))
	})
})

describe("wasm kernels in the image", () => {
	const finalBase = () => {
		const start = dockerfile.search(/^FROM \S+ AS final-base$/m)
		const rest = dockerfile.slice(start + 1)
		return rest.slice(0, rest.search(/^FROM /m))
	}
	it("final-base refuses a kernel that does not validate or whose source digest is not the bundle's", () => {
		const stage = finalBase()
		const check = stage.indexOf("RUN node -e")
		expect(check).toBeGreaterThan(-1)
		for (const wasm of ["spectrum-frame.wasm", "wideband-nfm.wasm"]) {
			expect(
				stage.indexOf(`COPY --from=frame-wasm /out/${wasm} /app/dist/${wasm}`),
			).toBeLessThan(check)
			expect(stage.slice(check)).toContain(`"${wasm}"`)
		}
		expect(
			stage.indexOf("COPY --from=node-build /app/dist /app/dist"),
		).toBeLessThan(check)
		const line = stage.slice(check, stage.indexOf("\n", check))
		expect(line).toContain("WebAssembly.validate(x)")
		expect(line).toContain('"wavekit.source-digest"')
		expect(line).toContain('"spectrum-worker.js", "FRAME"')
		expect(line).toContain('"index.js", "NFM"')
		// each refusal exits non-zero; readFileSync throws (non-zero) on a missing file
		expect(line.match(/process\.exit\(1\)/g)).toHaveLength(2)
		expect(line).toContain("readFileSync(f)")
		// no node flags: the check sees the runtime's default wasm features (SIMD)
		expect(line.startsWith("RUN node -e '")).toBe(true)
	})
	it("the frame-wasm stage builds from exactly the digest's inputs (build.sh, Cargo.toml, Cargo.lock, src)", () => {
		for (const crate of ["wavekit-frame", "wavekit-nfm"]) {
			expect(dockerfile).toContain(
				`COPY native/${crate}/Cargo.toml native/${crate}/Cargo.lock native/${crate}/build.sh ./`,
			)
			expect(dockerfile).toContain(`COPY native/${crate}/src ./src`)
		}
	})
	it("keeps the kernels' target dirs out of the context and their notices in", () => {
		for (const crate of ["wavekit-frame", "wavekit-nfm"]) {
			expect(dockerignore).toContain(`native/${crate}/target`)
			const reinclude = dockerignore.indexOf(`!native/${crate}/LICENSES.md`)
			expect(reinclude).toBeGreaterThan(dockerignore.indexOf("*.md"))
			expect(dockerfile).toContain(
				`COPY native/${crate}/LICENSES.md /usr/share/doc/${crate}/LICENSES.md`,
			)
		}
	})
})

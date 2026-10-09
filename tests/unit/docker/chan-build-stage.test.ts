import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const bake = readFileSync("docker/bake.hcl", "utf8")
const dockerfile = readFileSync("Dockerfile", "utf8")
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
})

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
const stage = (name: string) => {
	const start = dockerfile.search(new RegExp(`^FROM \\S+ AS ${name}$`, "m"))
	expect(start).toBeGreaterThanOrEqual(0)
	const rest = dockerfile.slice(start + 1)
	const next = rest.search(/^FROM /m)
	return next === -1 ? rest : rest.slice(0, next)
}

describe("wavekit-iqhub image integration (RX-S3 MAIN-NEEDED 1)", () => {
	it("caches hub-build only in the final and final-core chains", () => {
		expect(target("final")).toContain('cache("hub-build")')
		expect(target("final-core")).toContain('cache("hub-build")')
		expect(target("final-sdrpp")).not.toContain("hub-build")
		expect(target("final-demod")).not.toContain("hub-build")
	})
	it("builds with --locked from the pinned toolchain, rebuilds the crate and refuses a binary without front sinks", () => {
		const hub = stage("hub-build")
		expect(dockerfile).toMatch(/FROM \$\{RUST_IMAGE\} AS hub-build/)
		const touch = hub.indexOf("find src -type f -exec touch {} +")
		const build = hub.indexOf("cargo build --release --locked")
		expect(touch).toBeGreaterThan(-1)
		expect(touch).toBeLessThan(build)
		const check = hub.indexOf(`grep -q '"front"'`)
		expect(check).toBeGreaterThan(hub.indexOf("install -m 0755"))
		expect(hub.slice(check)).toMatch(
			/^grep -q '"front"' \|\| \{ echo [^;]+; exit 1; \}/,
		)
	})
	it("installs it at the default WAVEKIT_IQHUB_BIN path in final-base, verified with --version and ldd", () => {
		expect(stage("final-base")).toContain(
			"COPY --from=hub-build /usr/local/bin/wavekit-iqhub /usr/local/bin/",
		)
		expect(dockerfile).toContain("wavekit-iqhub --version")
		expect(dockerfile).toContain("ldd /usr/local/bin/wavekit-iqhub")
		expect(stage("final-sdrpp")).not.toContain("hub-build")
	})
	it("keeps the crate's target dir out of the build context and its notices in", () => {
		expect(dockerignore).toContain("native/wavekit-iqhub/target")
		expect(dockerignore).toContain("!native/wavekit-iqhub/LICENSES.md")
	})
})

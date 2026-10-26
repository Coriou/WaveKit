import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as {
	version: string
}

export default defineConfig({
	define: { __WAVEKIT_VERSION__: JSON.stringify(pkg.version) },
	test: {
		// Absolute, so workspace packages that reuse this config (sdr-host) resolve it too.
		globalSetup: [
			fileURLToPath(new URL("./tests/global-setup.ts", import.meta.url)),
		],
		globals: true,
		environment: "node",
		include: ["tests/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "json", "html"],
			include: ["src/**/*.ts"],
			exclude: ["src/index.ts", "src/bootstrap.ts"],
		},
	},
})

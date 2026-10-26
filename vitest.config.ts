import { readFileSync } from "node:fs"
import { defineConfig } from "vitest/config"

const pkg = JSON.parse(readFileSync("./package.json", "utf8")) as {
	version: string
}

export default defineConfig({
	define: { __WAVEKIT_VERSION__: JSON.stringify(pkg.version) },
	test: {
		globalSetup: ["./tests/global-setup.ts"],
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

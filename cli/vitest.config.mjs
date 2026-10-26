import { defineConfig } from "vitest/config"

export default defineConfig({
	esbuild: { jsx: "automatic" },
	test: {
		globalSetup: ["../tests/global-setup.ts"],
		include: ["source/**/*.test.tsx"],
		environment: "node",
		env: { TZ: "UTC", FORCE_COLOR: "0" },
		testTimeout: 20000,
	},
})

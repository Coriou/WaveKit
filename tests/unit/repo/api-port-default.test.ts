/**
 * The API port is 9000 everywhere: the schema default, config/default.yaml, the image's
 * EXPOSE and healthcheck default, and every compose service that publishes the API maps
 * host 9000 to the same container port.
 */
import { readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { parse } from "yaml"
import { describe, expect, it } from "vitest"
import { ApiConfigSchema, ConfigSchema } from "../../../src/config.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const read = (path: string): string => readFileSync(join(root, path), "utf8")

interface ComposeFile {
	services: Record<
		string,
		{
			ports?: string[]
			healthcheck?: { test?: string[] }
			environment?: Record<string, string>
		}
	>
}

describe("API port default", () => {
	it("the schema defaults api.port to 9000", () => {
		expect(ApiConfigSchema.parse({}).port).toBe(9000)
		expect(ConfigSchema.parse({}).api.port).toBe(9000)
	})

	it("config/default.yaml binds 9000", () => {
		const config = ConfigSchema.parse(parse(read("config/default.yaml")))
		expect(config.api.port).toBe(9000)
	})

	it("the image exposes 9000 and its healthcheck defaults to 9000", () => {
		expect(read("Dockerfile")).toMatch(/^EXPOSE .*\b9000\b/m)
		expect(read("docker/scripts/healthcheck.sh")).toContain(
			'API_PORT="${WAVEKIT_API_PORT:-9000}"',
		)
	})

	it("compose maps the API without translating 9000 to another container port", () => {
		const compose = parse(read("compose.yaml")) as ComposeFile
		const apiServices = Object.entries(compose.services).filter(([, s]) =>
			(s.ports ?? []).some(p => /(^|:)9000:/.test(p)),
		)
		expect(apiServices.length).toBeGreaterThan(0)
		for (const [name, service] of apiServices) {
			const mapping = (service.ports ?? []).find(p => /(^|:)9000:/.test(p))
			expect(mapping, name).toMatch(/:9000:9000$|^9000:9000$/)
			const probe = service.healthcheck?.test?.join(" ") ?? ""
			if (probe.includes("/health")) expect(probe, name).toContain(":9000/")
		}
	})
})

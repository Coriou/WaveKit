/**
 * Every container the shipped compose files start rotates its logs (docs/DOCKER-SETUP.md, "Container
 * logs"): Docker's default json-file driver is unbounded unless the daemon sets limits.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { parse } from "yaml"

const root = join(import.meta.dirname, "../../..")

interface Service {
	image?: string
	build?: unknown
	logging?: { driver?: string; options?: Record<string, string> }
}

const FILES = [
	"compose.yaml",
	"compose.usb.yaml",
	"packages/sdr-host/docker-compose.yml",
]

describe("shipped compose files", () => {
	for (const file of FILES) {
		it(`${file}: every service rotates its logs`, () => {
			const compose = parse(readFileSync(join(root, file), "utf8")) as {
				services: Record<string, Service>
			}
			// overrides of a service defined in another file have no image or build
			const defined = Object.entries(compose.services).filter(
				([, s]) => s.image !== undefined || s.build !== undefined,
			)
			expect(defined.length).toBeGreaterThan(0)
			for (const [name, service] of defined) {
				expect({ name, driver: service.logging?.driver }).toMatchObject({
					name,
					driver: expect.stringMatching(/^(local|json-file)$/) as unknown,
				})
				expect(service.logging?.options?.["max-size"], name).toBe("10m")
				expect(service.logging?.options?.["max-file"], name).toBe("3")
			}
		})
	}
})

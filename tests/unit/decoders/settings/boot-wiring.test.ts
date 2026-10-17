import { readdirSync, readFileSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "yaml"
import { afterEach, describe, expect, it } from "vitest"
import { DECODER_SETTINGS_FILE_NAME } from "@wavekit/api-types"
import { ConfigSchema } from "../../../../src/config.js"
import { openDecoderSettingsService } from "../../../../src/decoders/settings/service.js"
import type { DecoderConfig } from "../../../../src/decoders/types.js"
import { effectiveDecoderConfigs } from "../../../../src/index.js"
import { makeTmp, removeTmp, stubLogger } from "../../core/station/helpers.js"

const dirs: string[] = []

afterEach(async () => {
	for (const dir of dirs.splice(0)) await removeTmp(dir)
})

async function stateDir(): Promise<string> {
	const dir = await makeTmp()
	dirs.push(dir)
	return dir
}

// WG8 req 1.5 (Main wiring): src/index.ts creates decoders from
// effectiveDecoderConfigs(settings, config.decoders), before digital-voice preparation.
describe("boot decoder configs with the settings store", () => {
	it("equals config.decoders byte for byte with no settings file", async () => {
		const raw: unknown = parse(
			readFileSync(join(process.cwd(), "config", "default.yaml"), "utf8"),
		)
		const config = ConfigSchema.parse(raw)
		const decoders = config.decoders as DecoderConfig[]
		const before = JSON.stringify(decoders)
		const dir = await stateDir()
		const service = await openDecoderSettingsService({
			configs: decoders,
			stateDir: dir,
			logger: stubLogger().logger,
		})
		try {
			const effective = effectiveDecoderConfigs(service, decoders)
			expect(effective).toStrictEqual(decoders)
			expect(JSON.stringify(effective)).toBe(before)
			expect(JSON.stringify(decoders)).toBe(before)
			expect(readdirSync(dir)).toEqual([])
		} finally {
			await service.close()
		}
	})

	it("applies a stored override (enabled and a patchable option) at boot", async () => {
		const ism: DecoderConfig = {
			id: "ism",
			type: "rtl433",
			enabled: true,
			options: { frequency: 433_920_000, extraArgs: ["-M", "level"] },
		}
		const other: DecoderConfig = {
			id: "pager",
			type: "multimon-ng",
			enabled: true,
			options: {},
		}
		const dir = await stateDir()
		await writeFile(
			join(dir, DECODER_SETTINGS_FILE_NAME),
			JSON.stringify({
				schemaVersion: 1,
				revision: 3,
				decoders: {
					ism: {
						type: "rtl433",
						enabled: false,
						options: { frequency: 868_000_000 },
						updatedAt: "2026-10-16T12:00:00.000Z",
					},
				},
			}),
		)
		const service = await openDecoderSettingsService({
			configs: [ism, other],
			stateDir: dir,
			logger: stubLogger().logger,
		})
		try {
			const [first, second] = effectiveDecoderConfigs(service, [ism, other])
			expect(first).toEqual({
				id: "ism",
				type: "rtl433",
				enabled: false,
				options: { frequency: 868_000_000, extraArgs: ["-M", "level"] },
			})
			expect(second).toStrictEqual(other)
			// The configured entry is never mutated
			expect(ism.enabled).toBe(true)
			expect(ism.options["frequency"]).toBe(433_920_000)
		} finally {
			await service.close()
		}
	})

	it("feeds the effective configs into digital-voice preparation in src/index.ts", () => {
		const source = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8")
		const effective = source.indexOf(
			"const effectiveDecoders = effectiveDecoderConfigs(",
		)
		const prepare = source.indexOf(
			"digitalVoice.prepareDecoderConfigs(effectiveDecoders)",
		)
		expect(effective).toBeGreaterThan(0)
		expect(prepare).toBeGreaterThan(effective)
		expect(source).not.toContain(
			"digitalVoice.prepareDecoderConfigs(config.decoders)",
		)
	})
})

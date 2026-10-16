import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "yaml"
import { afterAll, describe, expect, it } from "vitest"
import { ConfigSchema } from "../../../../src/config.js"
import { openDecoderSettingsService } from "../../../../src/decoders/settings/service.js"
import type { DecoderConfig } from "../../../../src/decoders/types.js"
import { makeTmp, removeTmp, stubLogger } from "../../core/station/helpers.js"

const CONFIG_DIR = join(process.cwd(), "config")

/** Every shipped config/*.yaml that passes ConfigSchema, with its decoders. */
function shippedConfigs(): Array<{ file: string; decoders: DecoderConfig[] }> {
	const out: Array<{ file: string; decoders: DecoderConfig[] }> = []
	for (const file of readdirSync(CONFIG_DIR).filter(f => f.endsWith(".yaml"))) {
		const raw: unknown = parse(readFileSync(join(CONFIG_DIR, file), "utf8"))
		if (typeof raw !== "object" || raw === null) continue
		const parsed = ConfigSchema.safeParse(raw)
		if (!parsed.success) continue
		out.push({ file, decoders: parsed.data.decoders as DecoderConfig[] })
	}
	return out
}

const CONFIGS = shippedConfigs()
const dirs: string[] = []

afterAll(async () => {
	for (const dir of dirs) await removeTmp(dir)
})

describe("decoder settings defaults (no override file)", () => {
	it("finds shipped configs with decoders", () => {
		expect(CONFIGS.some(c => c.file === "default.yaml")).toBe(true)
		expect(CONFIGS.flatMap(c => c.decoders).length).toBeGreaterThan(0)
	})

	it.each(CONFIGS.map(c => [c.file, c] as const))(
		"%s: effectiveConfig equals the configured entry",
		async (_file, { decoders }) => {
			const stateDir = await makeTmp()
			dirs.push(stateDir)
			const before = structuredClone(decoders)
			const { logger, warn } = stubLogger()
			const service = await openDecoderSettingsService({
				configs: decoders,
				stateDir,
				logger,
			})
			expect(service.revision()).toBe(0)
			expect(service.ignored()).toEqual({ orphans: 0, retyped: 0 })
			for (const config of decoders) {
				const effective = service.effectiveConfig(config)
				expect(effective).toEqual(config)
				expect(effective).not.toBe(config)
			}
			expect(decoders).toEqual(before)
			expect(warn).not.toHaveBeenCalled()
			expect(readdirSync(stateDir)).toEqual([])
			await service.close()
		},
	)
})

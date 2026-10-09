/**
 * Health config wiring: `health.idleTimeout` / `health.checkInterval` reach the
 * DecoderManager, so DecoderStatus.idleTimeoutMs reports the configured value.
 */

import { afterEach, describe, expect, it } from "vitest"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import pino from "pino"
import { HealthConfigSchema, loadConfig } from "../../../src/config.js"
import { createDecoderManagerOptions } from "../../../src/decoders/manager-options.js"
import { DecoderManager } from "../../../src/decoders/manager.js"
import { DecoderRegistry } from "../../../src/decoders/registry.js"
import { FanoutManager } from "../../../src/core/fanout-manager.js"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import type { Decoder, DecoderCaps } from "../../../src/decoders/types.js"

const logger = pino({ level: "silent" })
const caps: DecoderCaps = {
	input: "external",
	output: "text",
	integrationPattern: "external_sdr",
}

function createStub(id: string): Decoder {
	const output = new PassThrough({ objectMode: true })
	return Object.assign(new EventEmitter(), {
		id,
		type: "stub",
		caps,
		start: async () => {},
		stop: async () => {},
		restart: async () => {},
		attachInput: () => {},
		detachInput: () => {},
		updateOptions: () => {},
		getOutput: () => output,
		getAudioOutput: () => null,
		getHealth: () => "running" as const,
		getStatus: () => ({
			id,
			type: "stub",
			running: false,
			health: "running" as const,
			uptime: 0,
			stats: { bytesIn: 0, eventsOut: 0, errors: 0 },
			restartCount: 0,
		}),
	})
}
const cleanups: Array<() => Promise<void> | void> = []

afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup()
})

describe("createDecoderManagerOptions", () => {
	it("keeps the unlimited-restart policy and manager defaults without a health section", () => {
		expect(createDecoderManagerOptions(undefined)).toEqual({
			restartDelay: 2000,
			maxRestartDelay: 30000,
			maxRestarts: 0,
		})
	})

	it("passes health.idleTimeout and health.checkInterval through", () => {
		expect(
			createDecoderManagerOptions({
				idleTimeout: 120_000,
				checkInterval: 2000,
			}),
		).toMatchObject({ idleTimeout: 120_000, healthCheckInterval: 2000 })
	})

	it("passes health.faultAfterFailures through only when configured", () => {
		expect(
			createDecoderManagerOptions(
				HealthConfigSchema.parse({ faultAfterFailures: 3 }),
			),
		).toMatchObject({ faultAfterFailures: 3 })
		expect(
			createDecoderManagerOptions(HealthConfigSchema.parse({})),
		).not.toHaveProperty("faultAfterFailures")
		expect(() => HealthConfigSchema.parse({ faultAfterFailures: 0 })).toThrow()
	})

	it("passes health.bandSuspension through only when configured", () => {
		expect(
			createDecoderManagerOptions(
				HealthConfigSchema.parse({ bandSuspension: false }),
			),
		).toMatchObject({ bandSuspension: false })
		expect(
			createDecoderManagerOptions(HealthConfigSchema.parse({})),
		).not.toHaveProperty("bandSuspension")
	})

	it("reports a YAML-configured idle timeout as DecoderStatus.idleTimeoutMs", async () => {
		const dir = mkdtempSync(join(tmpdir(), "wavekit-health-"))
		cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
		const path = join(dir, "config.yaml")
		writeFileSync(
			path,
			[
				"sources: []",
				"decoders: []",
				"health:",
				"  idleTimeout: 120000",
				"  checkInterval: 2000",
			].join("\n"),
		)
		const config = loadConfig(path)
		const registry = new DecoderRegistry()
		registry.register("stub", config => createStub(config.id), caps)
		const fanout = new FanoutManager(logger)
		const manager = new DecoderManager(
			registry,
			fanout,
			logger,
			createDecoderManagerOptions(config.health),
		)
		cleanups.push(async () => {
			await manager.destroy()
			fanout.destroy()
		})
		manager.createDecoder({
			id: "x",
			type: "stub",
			enabled: false,
			options: {},
		})
		expect(manager.getStatus("x")?.idleTimeoutMs).toBe(120_000)
	})
})

describe("documented health keys in config/default.yaml", () => {
	it("only uses keys the health schema accepts (no stale degradedTimeout)", () => {
		const yaml = readFileSync(resolve("config/default.yaml"), "utf8")
		const lines = yaml.split("\n")
		const blocks: Record<string, number>[] = []
		lines.forEach((line, index) => {
			if (!/^#\s*health:\s*$/.test(line)) return
			const block: Record<string, number> = {}
			for (const next of lines.slice(index + 1)) {
				const match = /^#\s{2,}(\w+):\s*(\d+)\s*$/.exec(next)
				if (!match) break
				block[match[1]!] = Number(match[2])
			}
			blocks.push(block)
		})
		expect(blocks.length).toBeGreaterThan(0)
		for (const block of blocks) {
			expect(Object.keys(block).length).toBeGreaterThan(0)
			expect(HealthConfigSchema.strict().safeParse(block).success).toBe(true)
		}
		expect(yaml).not.toContain("degradedTimeout")
	})
})

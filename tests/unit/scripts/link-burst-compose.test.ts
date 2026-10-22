import { spawnSync } from "node:child_process"
import { accessSync, constants, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parse } from "yaml"
import { expect, it } from "vitest"
import { ConfigSchema } from "../../../src/config.js"
import { rtl433OptionsSchema } from "../../../src/decoders/options/rtl433.js"

it("isolates the scratch project and validates the slow sink", () => {
	const composeText = readFileSync("scripts/link-burst/compose.yaml", "utf8")
	const configText = readFileSync("scripts/link-burst/config.yaml", "utf8")
	const compose = parse(composeText)
	const config = parse(configText)
	const text = composeText + configText
	expect(text).not.toContain("host.docker.internal")
	for (const ip of text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? [])
		expect(ip).toBe("127.0.0.1")
	expect(compose.networks.default.internal).toBe(true)
	expect(Object.keys(compose.services).sort()).toEqual(["core", "fake"])
	expect(compose.services.fake.ports).toBeUndefined()
	expect(compose.services.core.ports).toEqual(["127.0.0.1::3000"])
	expect(compose.services.core.volumes).toContain(
		"./slow-sink:/opt/link-burst/bin:ro",
	)
	expect(compose.services.core.environment.PATH).toMatch(
		/^\/opt\/link-burst\/bin:/,
	)
	expect(ConfigSchema.safeParse(config).success).toBe(true)
	expect(config.sources[0].host).toBe("fake")
	expect(config.sources[0].burstAbsorber.seconds).toBe(2)
	expect(config.tunerRelay.enabled).toBe(false)
	expect(config.audio.monitoring).toBe(false)
	const sinks = config.decoders.filter(
		(d: { options: { extraArgs?: string[] } }) =>
			d.options.extraArgs?.includes("link-burst-slow-sink"),
	)
	expect(sinks).toHaveLength(1)
	expect(sinks[0]).toMatchObject({
		type: "rtl433",
		enabled: true,
		useChannelizer: false,
	})
	expect(sinks[0]).not.toHaveProperty("mode")
	expect(rtl433OptionsSchema.safeParse(sinks[0].options).success).toBe(true)
	expect(readFileSync("src/index.ts", "utf8")).toContain(
		'decoderRegistry.register("rtl433"',
	)
	accessSync("scripts/link-burst/slow-sink/rtl_433", constants.X_OK)
})

it.each([
	["scripts/link-burst/run_acceptance.py", "--help"],
	["tests/unit/scripts/test_link_burst_slow_sink.py"],
])(
	"runs Python checks: %s",
	(...args) => {
		const result = spawnSync("python3", [resolve(args[0]!), ...args.slice(1)], {
			encoding: "utf8",
			timeout: 30000,
			env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" },
		})
		expect(result.status, result.stdout + result.stderr).toBe(0)
	},
	35000,
)

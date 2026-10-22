import { spawnSync } from "node:child_process"
import { accessSync, constants, readFileSync } from "node:fs"
import { resolve } from "node:path"
import { parse } from "yaml"
import { expect, it } from "vitest"
import { ConfigSchema } from "../../../src/config.js"
import { rtl433OptionsSchema } from "../../../src/decoders/options/rtl433.js"

type Decoder = {
	id: string
	options: { extraArgs?: string[] }
}

it("isolates the scratch project and validates the slow sink", () => {
	const composeText = readFileSync("scripts/link-burst/compose.yaml", "utf8")
	const configText = readFileSync("scripts/link-burst/config.yaml", "utf8")
	const compose = parse(composeText)
	const config = parse(configText)
	const text = composeText + configText
	expect(text).not.toContain("host.docker.internal")
	for (const ip of text.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? [])
		expect(ip).toBe("127.0.0.1")
	expect(Object.keys(compose.services).sort()).toEqual(["api", "core", "fake"])
	// Core and fake stay on the internal network only; the forwarder alone
	// joins a second network to publish the API on an ephemeral loopback port.
	expect(compose.networks.default.internal).toBe(true)
	expect(compose.networks.edge?.internal).not.toBe(true)
	expect(compose.services.core.networks).toBeUndefined()
	expect(compose.services.fake.networks).toBeUndefined()
	expect([...compose.services.api.networks].sort()).toEqual(["default", "edge"])
	expect(compose.services.fake.ports).toBeUndefined()
	expect(compose.services.core.cpuset).toBe("${LINK_BURST_CORE_CPUS:-}")
	expect(compose.services.fake.cpuset).toBe("${LINK_BURST_FAKE_CPUS:-}")
	expect(compose.services.core.ports).toBeUndefined()
	expect(compose.services.api.ports).toEqual(["127.0.0.1::3000"])
	expect(compose.services.api.volumes).toContain(
		"./api_proxy.py:/opt/api_proxy.py:ro",
	)
	expect(readFileSync("scripts/link-burst/api_proxy.py", "utf8")).toContain(
		'open_connection("core", 3000)',
	)
	expect(compose.services.fake.command).toContain("--loop")
	expect(compose.services.fake.command).toContain("${LINK_BURST_SCHEDULE:-}")
	expect(compose.services.fake.volumes).toContain(
		"./fake_host_status.py:/opt/fake_host_status.py:ro",
	)
	expect(compose.services.core.volumes).toContain(
		"./slow-sink:/opt/link-burst/bin:ro",
	)
	expect(compose.services.core.environment.PATH).toMatch(
		/^\/opt\/link-burst\/bin:/,
	)
	expect(ConfigSchema.safeParse(config).success).toBe(true)
	expect(config.sources[0].host).toBe("fake")
	expect(config.sources[0].burstAbsorber.seconds).toBe(2)
	expect(config.sources[0].sdrHost.apiUrl).toBe("http://fake:1235")
	expect(config.tunerRelay.enabled).toBe(false)
	expect(config.audio.monitoring).toBe(false)
	const decoders: Decoder[] = config.decoders
	const sinks = decoders.filter(d =>
		d.options.extraArgs?.includes("link-burst-slow-sink"),
	)
	expect(sinks).toHaveLength(1)
	expect(sinks[0]).toMatchObject({
		type: "rtl433",
		enabled: true,
		useChannelizer: false,
	})
	expect(sinks[0]).not.toHaveProperty("mode")
	expect(rtl433OptionsSchema.safeParse(sinks[0]!.options).success).toBe(true)
	// The always-on sibling is unmarked, so the shim runs the real decoder.
	const sibling = decoders.find(d => d.id === "link-burst-sibling")
	expect(sibling).toMatchObject({
		type: "rtl433",
		enabled: true,
		sourceId: "link-burst-fake",
		useChannelizer: false,
	})
	expect(sibling?.options.extraArgs ?? []).not.toContain("link-burst-slow-sink")
	expect(rtl433OptionsSchema.safeParse(sibling?.options).success).toBe(true)
	const index = decoders.findIndex(d => d.id === "link-burst-sibling")
	expect(
		compose.services.core.environment[
			`WAVEKIT_DECODERS_${index}_OPTIONS__INPUT_SAMPLE_RATE`
		],
	).toBe("${LINK_BURST_RATE:-2048000}")
	expect(readFileSync("src/index.ts", "utf8")).toContain(
		'decoderRegistry.register("rtl433"',
	)
	accessSync("scripts/link-burst/slow-sink/rtl_433", constants.X_OK)
})

it.each([
	["scripts/link-burst/run_acceptance.py", "--help"],
	["tests/unit/scripts/test_link_burst_slow_sink.py"],
	["tests/unit/scripts/test_link_burst_driver.py"],
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

import fc from "fast-check"
import { describe, expect, it } from "vitest"
import {
	AccessRuntimeConfigSchema,
	containerExposureWarning,
	validateProtectedRuntimeMapping,
} from "../../../src/access/runtime-config.js"
import type { ProtectedRuntimeAccessConfig } from "../../../src/access/runtime-config.js"
import { validateConfigSafe } from "../../../src/config.js"

const ports = { analog: 7101, digital: 7102 }
const wildcardApi = { host: "0.0.0.0", port: 7100 }

function container(hostname = "127.0.0.1"): ProtectedRuntimeAccessConfig {
	return {
		mode: "protected",
		listenerScheme: "http",
		exposure: "container-loopback",
		allowedAuthorities: [`${hostname}:7100`],
		allowedOrigins: [`http://${hostname}:7100`],
		audio: {
			analog: { allowedAuthorities: [`${hostname}:7101`], bindHost: "0.0.0.0" },
			digital: {
				allowedAuthorities: [`${hostname}:7102`],
				bindHost: "0.0.0.0",
			},
		},
		publicOrigins: {
			api: `http://${hostname}:7100`,
			analogAudio: `http://${hostname}:7101`,
			digitalAudio: `http://${hostname}:7102`,
		},
		healthProbe: { target: "http://127.0.0.1:7100", host: `${hostname}:7100` },
	}
}

function local(): ProtectedRuntimeAccessConfig {
	return {
		...container(),
		exposure: "local-http",
		audio: {
			analog: { allowedAuthorities: ["127.0.0.1:7101"], bindHost: "127.0.0.1" },
			digital: {
				allowedAuthorities: ["127.0.0.1:7102"],
				bindHost: "127.0.0.1",
			},
		},
	}
}

function tls(): ProtectedRuntimeAccessConfig {
	return {
		...local(),
		listenerScheme: "https",
		exposure: "tls-termination",
		allowedAuthorities: ["receiver.local:8443", "127.0.0.1:7100"],
		allowedOrigins: ["https://receiver.local:8443"],
		audio: {
			analog: {
				allowedAuthorities: ["receiver.local:8444"],
				bindHost: "127.0.0.1",
			},
			digital: {
				allowedAuthorities: ["receiver.local:8445"],
				bindHost: "127.0.0.1",
			},
		},
		publicOrigins: {
			api: "https://receiver.local:8443",
			analogAudio: "https://receiver.local:8444",
			digitalAudio: "https://receiver.local:8445",
		},
		healthProbe: { target: "http://127.0.0.1:7100", host: "127.0.0.1:7100" },
	}
}

function bind(
	access: ProtectedRuntimeAccessConfig,
	analog: string,
	digital = analog,
): ProtectedRuntimeAccessConfig {
	return AccessRuntimeConfigSchema.parse({
		...access,
		audio: {
			analog: { ...access.audio.analog, bindHost: analog },
			digital: { ...access.audio.digital, bindHost: digital },
		},
	}) as ProtectedRuntimeAccessConfig
}

function accepts(
	access: ProtectedRuntimeAccessConfig,
	api: { host: string; port: number },
): boolean {
	try {
		validateProtectedRuntimeMapping(access, api, ports)
		return true
	} catch (error) {
		expect(error).toMatchObject({ code: "ACCESS_CONFIG_INVALID" })
		return false
	}
}

describe("container-loopback exposure validation", () => {
	it("accepts the wildcard binding with 127.0.0.1 or localhost public origins", () => {
		expect(accepts(container(), wildcardApi)).toBe(true)
		expect(accepts(container("localhost"), wildcardApi)).toBe(true)
		const plan = validateProtectedRuntimeMapping(
			container(),
			wildcardApi,
			ports,
		)
		expect(plan).toMatchObject({
			mode: "protected",
			allowedAuthorities: ["127.0.0.1:7100"],
		})
	})

	const table: Array<
		[string, ProtectedRuntimeAccessConfig, { host: string; port: number }]
	> = [
		["local-http with api 0.0.0.0", local(), wildcardApi],
		[
			"local-http with audio bindHost 0.0.0.0",
			bind(local(), "0.0.0.0"),
			{ host: "127.0.0.1", port: 7100 },
		],
		[
			"local-http with one audio bindHost 0.0.0.0",
			bind(local(), "127.0.0.1", "0.0.0.0"),
			{ host: "127.0.0.1", port: 7100 },
		],
		[
			"tls-termination with audio bindHost 0.0.0.0",
			bind(tls(), "0.0.0.0"),
			{ host: "127.0.0.1", port: 7100 },
		],
		["tls-termination with api 0.0.0.0", tls(), wildcardApi],
		["container api ::", container(), { host: "::", port: 7100 }],
		["container api 127.0.0.1", container(), { host: "127.0.0.1", port: 7100 }],
		[
			"container api interface address",
			container(),
			{ host: "172.17.0.2", port: 7100 },
		],
		["container api hostname", container(), { host: "wavekit", port: 7100 }],
		[
			"container mixed bindHosts",
			bind(container(), "0.0.0.0", "127.0.0.1"),
			wildcardApi,
		],
		[
			"container loopback bindHosts",
			bind(container(), "127.0.0.1"),
			wildcardApi,
		],
		["container [::1] public origins", container("[::1]"), wildcardApi],
		[
			"container non-loopback public origins",
			container("receiver.local"),
			wildcardApi,
		],
		[
			"container with https",
			{ ...container(), listenerScheme: "https" },
			wildcardApi,
		],
		[
			"container probe target 0.0.0.0",
			{
				...container(),
				healthProbe: { target: "http://0.0.0.0:7100", host: "127.0.0.1:7100" },
			},
			wildcardApi,
		],
		[
			"container probe target localhost",
			{
				...container(),
				healthProbe: {
					target: "http://localhost:7100",
					host: "127.0.0.1:7100",
				},
			},
			wildcardApi,
		],
		[
			"container probe target wrong port",
			{
				...container(),
				healthProbe: {
					target: "http://127.0.0.1:7199",
					host: "127.0.0.1:7100",
				},
			},
			wildcardApi,
		],
		[
			"container probe Host non-loopback",
			{
				...container(),
				allowedAuthorities: ["127.0.0.1:7100", "wavekit:7100"],
				healthProbe: { target: "http://127.0.0.1:7100", host: "wavekit:7100" },
			},
			wildcardApi,
		],
		[
			"container probe Host other loopback name",
			{
				...container(),
				allowedAuthorities: ["127.0.0.1:7100", "localhost:7100"],
				healthProbe: {
					target: "http://127.0.0.1:7100",
					host: "localhost:7100",
				},
			},
			wildcardApi,
		],
		[
			"container extra allowed authority",
			{
				...container(),
				allowedAuthorities: ["127.0.0.1:7100", "wavekit:7100"],
			},
			wildcardApi,
		],
		[
			"container api port mismatch",
			container(),
			{ host: "0.0.0.0", port: 7200 },
		],
		[
			"container mixed origin hostnames",
			{
				...container(),
				allowedOrigins: ["http://127.0.0.1:7100", "http://localhost:7100"],
			},
			wildcardApi,
		],
		[
			"container duplicate audio origins",
			{
				...container(),
				publicOrigins: {
					...container().publicOrigins,
					digitalAudio: "http://127.0.0.1:7101",
				},
			},
			wildcardApi,
		],
		[
			"container audio authority mismatch",
			{
				...container(),
				audio: {
					...container().audio,
					digital: {
						allowedAuthorities: ["127.0.0.1:7109"],
						bindHost: "0.0.0.0",
					},
				},
			},
			wildcardApi,
		],
	]
	it.each(table)("rejects %s", (_name, access, api) => {
		expect(accepts(access, api)).toBe(false)
	})

	it("rejects audio port mismatch under container-loopback", () => {
		expect(() =>
			validateProtectedRuntimeMapping(container(), wildcardApi, {
				analog: 7101,
				digital: 7105,
			}),
		).toThrow(expect.objectContaining({ code: "ACCESS_CONFIG_INVALID" }))
	})

	it("rejects bindHost :: and hostnames at the schema", () => {
		for (const bindHost of ["::", "localhost", "172.17.0.2"])
			expect(() => bind(container(), bindHost)).toThrow()
	})

	it("is never inferred: existing local-http and tls fixtures still validate", () => {
		expect(accepts(local(), { host: "127.0.0.1", port: 7100 })).toBe(true)
		expect(accepts(tls(), { host: "127.0.0.1", port: 7100 })).toBe(true)
	})

	it("fails closed in the full config schema before any listener", () => {
		const base = {
			api: wildcardApi,
			liveDemod: { httpPort: 7101 },
			digitalVoice: { httpPort: 7102 },
		}
		expect(validateConfigSafe({ ...base, access: container() }).success).toBe(
			true,
		)
		expect(
			validateConfigSafe({
				...base,
				access: { ...container(), exposure: "local-http" },
			}).success,
		).toBe(false)
	})

	// Feature: container-exposure, Property 1: only the exact wildcard binding validates
	// Validates: Requirements 1.2, 1.5
	it("accepts container-loopback only when api and both audio binds are 0.0.0.0", () => {
		const hosts = fc.constantFrom("0.0.0.0", "127.0.0.1", "::1")
		fc.assert(
			fc.property(
				fc.constantFrom("0.0.0.0", "127.0.0.1", "::1", "::", "10.0.0.5"),
				hosts,
				hosts,
				(apiHost, analog, digital) => {
					const ok = accepts(bind(container(), analog, digital), {
						host: apiHost,
						port: 7100,
					})
					expect(ok).toBe(
						apiHost === "0.0.0.0" &&
							analog === "0.0.0.0" &&
							digital === "0.0.0.0",
					)
				},
			),
			{ numRuns: 100 },
		)
	})

	// Feature: container-exposure, Property 2: existing exposures reject the wildcard
	// Validates: Requirements 1.1, 1.2
	it("never accepts 0.0.0.0 anywhere under local-http or tls-termination", () => {
		const hosts = fc.constantFrom("0.0.0.0", "127.0.0.1")
		fc.assert(
			fc.property(
				fc.constantFrom(local, tls),
				hosts,
				hosts,
				hosts,
				(make, apiHost, analog, digital) => {
					const ok = accepts(bind(make(), analog, digital), {
						host: apiHost,
						port: 7100,
					})
					if ([apiHost, analog, digital].includes("0.0.0.0"))
						expect(ok).toBe(false)
					else expect(ok).toBe(true)
				},
			),
			{ numRuns: 100 },
		)
	})
})

describe("container exposure startup warning", () => {
	it("returns fixed text only under container-loopback", () => {
		const warning = containerExposureWarning(container())
		expect(warning).toMatch(/every container interface/)
		expect(warning).toMatch(/127\.0\.0\.1 only/)
		expect(warning).not.toMatch(/7100|7101|7102/)
		expect(containerExposureWarning(local())).toBeNull()
		expect(containerExposureWarning(tls())).toBeNull()
		expect(containerExposureWarning({ mode: "legacy" })).toBeNull()
	})
})

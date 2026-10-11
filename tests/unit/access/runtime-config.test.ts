import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
	AccessRuntimeConfigSchema,
	validateProtectedRuntimeMapping,
} from "../../../src/access/runtime-config.js"
import type { ProtectedRuntimeAccessConfig } from "../../../src/access/runtime-config.js"
import {
	ConfigSchema,
	loadConfig,
	validateConfig,
	validateConfigSafe,
} from "../../../src/config.js"

function localAccess(): ProtectedRuntimeAccessConfig {
	return {
		mode: "protected",
		listenerScheme: "http",
		exposure: "local-http",
		allowedAuthorities: ["127.0.0.1:8080"],
		allowedOrigins: ["http://127.0.0.1:8080"],
		audio: {
			analog: { allowedAuthorities: ["127.0.0.1:8081"], bindHost: "127.0.0.1" },
			digital: {
				allowedAuthorities: ["127.0.0.1:8082"],
				bindHost: "127.0.0.1",
			},
		},
		publicOrigins: {
			api: "http://127.0.0.1:8080",
			analogAudio: "http://127.0.0.1:8081",
			digitalAudio: "http://127.0.0.1:8082",
		},
		healthProbe: { target: "http://127.0.0.1:8080", host: "127.0.0.1:8080" },
	}
}

function runtimeConfig(access: unknown = localAccess()) {
	return {
		access,
		api: { host: "127.0.0.1", port: 8080 },
		liveDemod: { httpPort: 8081 },
		digitalVoice: { httpPort: 8082 },
	}
}

function proxyAccess(): ProtectedRuntimeAccessConfig {
	return {
		...localAccess(),
		listenerScheme: "https",
		exposure: "tls-termination",
		allowedAuthorities: ["receiver.local:8443", "127.0.0.1:8080"],
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
	}
}

describe("protected runtime deployment mapping", () => {
	it("defaults to legacy and preserves explicit legacy without deployment inputs", () => {
		expect(AccessRuntimeConfigSchema.parse(undefined)).toEqual({
			mode: "legacy",
		})
		expect(ConfigSchema.parse({}).access).toEqual({ mode: "legacy" })
		expect(validateConfig({ access: { mode: "legacy" } }).access).toEqual({
			mode: "legacy",
		})
	})

	it.each(["local", "proxy"] as const)(
		"accepts explicit %s bindings and named public destinations",
		kind => {
			const access = kind === "local" ? localAccess() : proxyAccess()
			const config = validateConfig(runtimeConfig(access))
			expect(config.access).toEqual(access)
			const plan = validateProtectedRuntimeMapping(access, config.api, {
				analog: 8081,
				digital: 8082,
			})
			expect(plan.externalAudioOrigins).toEqual([
				access.publicOrigins.analogAudio,
				access.publicOrigins.digitalAudio,
			])
			expect(plan.allowedAuthorities).toEqual(access.allowedAuthorities)
			expect(plan.allowedAuthorities).not.toContain(
				access.audio.analog.allowedAuthorities[0],
			)
			expect(plan.allowedAuthorities).not.toContain(
				access.audio.digital.allowedAuthorities[0],
			)
		},
	)

	it("accepts explicit IPv6 loopback mapping independently of advertised hostname", () => {
		const access = proxyAccess()
		access.healthProbe = { target: "http://[::1]:8080", host: "[::1]:8080" }
		access.allowedAuthorities = ["receiver.local:8443", "[::1]:8080"]
		access.audio.analog.bindHost = "::1"
		access.audio.digital.bindHost = "::1"
		expect(
			validateConfig({
				...runtimeConfig(access),
				api: { host: "::1", port: 8080 },
			}).access,
		).toEqual(access)
	})

	it.each([
		[
			"analog accepts digital authority",
			(a: ProtectedRuntimeAccessConfig) => {
				a.audio.analog.allowedAuthorities = [
					...a.audio.digital.allowedAuthorities,
				]
			},
		],
		[
			"digital accepts analog authority",
			(a: ProtectedRuntimeAccessConfig) => {
				a.audio.digital.allowedAuthorities = [
					...a.audio.analog.allowedAuthorities,
				]
			},
		],
		[
			"audio accepts API authority",
			(a: ProtectedRuntimeAccessConfig) => {
				a.audio.analog.allowedAuthorities = [...a.allowedAuthorities]
			},
		],
		[
			"API accepts audio authority",
			(a: ProtectedRuntimeAccessConfig) => {
				a.allowedAuthorities.push(...a.audio.analog.allowedAuthorities)
			},
		],
		[
			"duplicate physical audio authority",
			(a: ProtectedRuntimeAccessConfig) => {
				a.audio.analog.allowedAuthorities.push(
					...a.audio.analog.allowedAuthorities,
				)
			},
		],
		[
			"undeclared probe authority",
			(a: ProtectedRuntimeAccessConfig) => {
				a.healthProbe.host = "localhost:8080"
			},
		],
		[
			"wrong analog port",
			(a: ProtectedRuntimeAccessConfig) => {
				a.publicOrigins.analogAudio = "http://127.0.0.1:9091"
				a.audio.analog.allowedAuthorities = ["127.0.0.1:9091"]
			},
		],
		[
			"wrong digital port",
			(a: ProtectedRuntimeAccessConfig) => {
				a.publicOrigins.digitalAudio = "http://127.0.0.1:9092"
				a.audio.digital.allowedAuthorities = ["127.0.0.1:9092"]
			},
		],
		[
			"wrong public API port",
			(a: ProtectedRuntimeAccessConfig) => {
				a.publicOrigins.api = "http://127.0.0.1:9090"
				a.allowedAuthorities.push("127.0.0.1:9090")
			},
		],
		[
			"hostname mismatch",
			(a: ProtectedRuntimeAccessConfig) => {
				a.publicOrigins.analogAudio = "http://localhost:8081"
			},
		],
		[
			"browser hostname mismatch",
			(a: ProtectedRuntimeAccessConfig) => {
				a.allowedOrigins = ["http://localhost:8080"]
			},
		],
		[
			"scheme mismatch",
			(a: ProtectedRuntimeAccessConfig) => {
				a.publicOrigins.digitalAudio = "https://127.0.0.1:8082"
			},
		],
		[
			"probe wrong backend port",
			(a: ProtectedRuntimeAccessConfig) => {
				a.healthProbe.target = "http://127.0.0.1:8081"
			},
		],
		[
			"probe non-loopback host",
			(a: ProtectedRuntimeAccessConfig) => {
				a.healthProbe.target = "http://receiver.local:8080"
			},
		],
		[
			"probe TLS scheme",
			(a: ProtectedRuntimeAccessConfig) => {
				a.healthProbe.target = "https://127.0.0.1:8080"
			},
		],
		[
			"equal public destinations",
			(a: ProtectedRuntimeAccessConfig) => {
				a.publicOrigins.digitalAudio = a.publicOrigins.analogAudio
			},
		],
		[
			"origin path",
			(a: ProtectedRuntimeAccessConfig) => {
				a.publicOrigins.api += "/api"
			},
		],
		[
			"HTTP proxy declaration",
			(a: ProtectedRuntimeAccessConfig) => {
				a.exposure = "tls-termination"
			},
		],
	] as const)("rejects %s", (_label, mutate) => {
		const access = localAccess()
		mutate(access)
		expect(ConfigSchema.safeParse(runtimeConfig(access)).success).toBe(false)
	})

	it.each([
		["127.0.0.1", "::1"],
		["[::1]", "127.0.0.1"],
	] as const)(
		"rejects direct public literal %s bound to the other address family %s",
		(publicHost, bindHost) => {
			const access = localAccess()
			access.publicOrigins = {
				api: `http://${publicHost}:8080`,
				analogAudio: `http://${publicHost}:8081`,
				digitalAudio: `http://${publicHost}:8082`,
			}
			access.allowedOrigins = [access.publicOrigins.api]
			access.allowedAuthorities = [
				`${publicHost}:8080`,
				`${bindHost === "::1" ? "[::1]" : bindHost}:8080`,
			]
			access.audio.analog = {
				allowedAuthorities: [`${publicHost}:8081`],
				bindHost,
			}
			access.audio.digital = {
				allowedAuthorities: [`${publicHost}:8082`],
				bindHost,
			}
			access.healthProbe = {
				target: `http://${bindHost === "::1" ? "[::1]" : bindHost}:8080`,
				host: `${bindHost === "::1" ? "[::1]" : bindHost}:8080`,
			}
			expect(
				ConfigSchema.safeParse({
					...runtimeConfig(access),
					api: { host: bindHost, port: 8080 },
				}).success,
			).toBe(false)
		},
	)

	it.each(["analog", "digital"] as const)(
		"rejects a direct %s audio listener bound to the other family",
		name => {
			const access = localAccess()
			access.audio[name].bindHost = "::1"
			expect(ConfigSchema.safeParse(runtimeConfig(access)).success).toBe(false)
		},
	)

	it("permits localhost direct origins only with explicit IPv4 API and audio bindings", () => {
		const access = localAccess()
		access.publicOrigins = {
			api: "http://localhost:8080",
			analogAudio: "http://localhost:8081",
			digitalAudio: "http://localhost:8082",
		}
		access.allowedOrigins = [access.publicOrigins.api]
		access.allowedAuthorities = ["localhost:8080", "127.0.0.1:8080"]
		access.audio.analog.allowedAuthorities = ["localhost:8081"]
		access.audio.digital.allowedAuthorities = ["localhost:8082"]
		expect(validateConfig(runtimeConfig(access)).access).toEqual(access)
		access.healthProbe = { target: "http://[::1]:8080", host: "[::1]:8080" }
		access.allowedAuthorities = ["localhost:8080", "[::1]:8080"]
		access.audio.analog.bindHost = "::1"
		access.audio.digital.bindHost = "::1"
		expect(
			ConfigSchema.safeParse({
				...runtimeConfig(access),
				api: { host: "::1", port: 8080 },
			}).success,
		).toBe(false)
	})

	it("keeps TLS-proxy API and audio backend families independent", () => {
		const access = proxyAccess()
		access.audio.analog.bindHost = "::1"
		expect(validateConfig(runtimeConfig(access)).access).toEqual(access)
	})

	it("rejects plaintext LAN origins and HTTPS without explicit TLS termination", () => {
		const lan = proxyAccess()
		lan.listenerScheme = "http"
		lan.exposure = "local-http"
		lan.allowedAuthorities = ["receiver.local:8443", "127.0.0.1:8080"]
		lan.allowedOrigins = ["http://receiver.local:8443"]
		lan.publicOrigins = {
			api: "http://receiver.local:8443",
			analogAudio: "http://receiver.local:8444",
			digitalAudio: "http://receiver.local:8445",
		}
		expect(ConfigSchema.safeParse(runtimeConfig(lan)).success).toBe(false)
		const https = proxyAccess()
		https.exposure = "local-http"
		expect(ConfigSchema.safeParse(runtimeConfig(https)).success).toBe(false)
	})

	it.each(["0.0.0.0", "::", "receiver.local"])(
		"rejects plaintext backend binding %s",
		host => {
			expect(
				ConfigSchema.safeParse({
					...runtimeConfig(),
					api: { host, port: 8080 },
				}).success,
			).toBe(false)
			const access = localAccess()
			expect(
				ConfigSchema.safeParse(
					runtimeConfig({
						...access,
						audio: {
							...access.audio,
							analog: { ...access.audio.analog, bindHost: host },
						},
					}),
				).success,
			).toBe(false)
		},
	)

	it("rejects conflicting actual backend listener ports", () => {
		expect(
			ConfigSchema.safeParse({
				...runtimeConfig(proxyAccess()),
				digitalVoice: { httpPort: 8081 },
			}).success,
		).toBe(false)
	})

	it.each(["privateDirectory", "machineToken", "sessionCookie", "csrfToken"])(
		"rejects serializable private field %s with sanitized validation errors",
		field => {
			const input = runtimeConfig({
				...localAccess(),
				[field]: "SECRET-private-runtime-value",
			})
			expect(ConfigSchema.safeParse(input).success).toBe(false)
			expect(validateConfigSafe(input)).toEqual({
				success: false,
				errors: ["access: Invalid access configuration"],
			})
			expect(() => validateConfig(input)).toThrow(
				"Invalid access configuration",
			)
			try {
				validateConfig(input)
			} catch (error) {
				expect(error).toMatchObject({
					code: "ACCESS_CONFIG_INVALID",
					message: "Invalid access configuration",
				})
				expect(String(error)).not.toContain(field)
				expect(String(error)).not.toContain("SECRET")
			}
		},
	)

	it("sanitizes deployment strings and private keys from actual config-load errors", () => {
		const directory = mkdtempSync(join(tmpdir(), "wavekit-access-config-"))
		const file = join(directory, "config.yaml")
		try {
			const input = runtimeConfig({
				...localAccess(),
				privateKey: "SECRET-private-key",
				publicOrigins: {
					...localAccess().publicOrigins,
					api: "http://SECRET-user:SECRET-password@127.0.0.1:8080",
				},
			})
			writeFileSync(file, JSON.stringify(input))
			expect(() => loadConfig(file)).toThrow("Invalid access configuration")
			try {
				loadConfig(file)
			} catch (error) {
				expect(error).toMatchObject({ code: "ACCESS_CONFIG_INVALID" })
				expect(String(error)).not.toContain("SECRET")
				expect(String(error)).not.toContain("privateKey")
			}
		} finally {
			rmSync(directory, { recursive: true, force: true })
		}
	})
})

import { describe, expect, it } from "vitest"
import { randomBytes } from "node:crypto"
import * as fc from "fast-check"
import { stringify } from "yaml"
import { z } from "zod"
import { CONFIG_EXPORT_REDACTED } from "@wavekit/api-types"
import { ConfigSchema } from "../../../../src/config.js"
import type { Config } from "../../../../src/config.js"
import {
	ConfigExportTooLargeError,
	exportConfig,
	redactConfig,
	redactWithSchema,
} from "../../../../src/core/config-export/export.js"

const R = CONFIG_EXPORT_REDACTED
const META = { version: "1.2.3", generatedAt: "2026-10-16T00:00:00.000Z" }

function token(): string {
	return `t${randomBytes(12).toString("hex")}`
}

/** Every encoding of `secret` the body must not contain. */
function encodings(secret: string): string[] {
	const out = new Set<string>([
		secret,
		JSON.stringify(secret).slice(1, -1),
		stringify(secret).trim(),
	])
	for (let offset = 0; offset < 3; offset += 1) {
		const b64 = Buffer.from("x".repeat(offset) + secret).toString("base64")
		// Drop the prefix-affected and padding-affected characters.
		out.add(b64.slice(Math.ceil((offset * 4) / 3) + 1, -4))
	}
	return [...out].filter(e => e.length >= 8)
}

function expectAbsent(body: string, secrets: readonly string[]): void {
	for (const secret of secrets)
		for (const enc of encodings(secret)) expect(body).not.toContain(enc)
}

function protectedAccess(host: string) {
	return {
		mode: "protected",
		listenerScheme: "https",
		exposure: "tls-termination",
		allowedAuthorities: [`${host}:8443`, "127.0.0.1:8080"],
		allowedOrigins: [`https://${host}:8443`],
		audio: {
			analog: { allowedAuthorities: [`${host}:8444`], bindHost: "127.0.0.1" },
			digital: {
				allowedAuthorities: [`${host}:8445`],
				bindHost: "127.0.0.1",
			},
		},
		publicOrigins: {
			api: `https://${host}:8443`,
			analogAudio: `https://${host}:8444`,
			digitalAudio: `https://${host}:8445`,
		},
		healthProbe: { target: "http://127.0.0.1:8080", host: "127.0.0.1:8080" },
	}
}

interface Fixture {
	config: Config
	secrets: string[]
	numericSecrets: number[]
}

function everySecretFixture(decoderCount = 2, sourceCount = 1): Fixture {
	const secrets: string[] = []
	const t = () => {
		const v = token()
		secrets.push(v)
		return v
	}
	const accessHost = `h${randomBytes(6).toString("hex")}.example`
	secrets.push(accessHost)
	const lat = 47.123456789
	const lon = 8.987654321
	const altM = 431.517
	const numericKey = 918273645
	const sources: Record<string, unknown>[] = Array.from(
		{ length: sourceCount },
		(_, i) => ({
			id: `src${i}`,
			type: "rtl_tcp",
			host: t(),
			port: 1234,
			caps: { kind: "iq", sampleRate: 2_048_000, format: "U8_IQ" },
			sdrHost: {
				apiUrl: `http://${t()}:${t()}@${t()}.example:8080/?token=${t()}`,
				rtlmuxStatsUrl: `http://${t()}.example:5556/stats.json?k=${t()}`,
			},
		}),
	)
	sources.push({
		id: "rec",
		type: "recording",
		filePath: `/data/${t()}.iq`,
		caps: { kind: "iq", sampleRate: 2_048_000, format: "U8_IQ" },
	})
	const decoders: Record<string, unknown>[] = []
	for (let i = 0; i < decoderCount; i += 1) {
		decoders.push(
			{
				id: `mesh${i}`,
				type: "lora-meshtastic",
				enabled: true,
				sourceId: "src0",
				options: {
					region: "EU_868",
					preset: "LongFast",
					channelKey: Buffer.from(t()).toString("base64"),
					numericKey,
					nested: { psk: t(), deeper: [{ label: t() }, t()], ok: 3 },
				},
			},
			{
				id: `dsd${i}`,
				type: "dsd-fme",
				enabled: true,
				options: {
					mode: "dmr",
					output: "udp",
					udpHost: t(),
					udpPort: 7355,
					wavDir: `/srv/${t()}`,
					perCallRecordingDir: `/srv/${t()}`,
					extraArgs: ["-H", t()],
					privacyKey: t(),
					keys: [t(), t()],
				},
				deviceSerial: t(),
				outputHost: t(),
				outputPort: 30005,
				outputProtocol: "tcp",
				minVersion: t(),
			},
		)
	}
	const config = ConfigSchema.parse({
		sources,
		decoders,
		api: { host: "127.0.0.1", port: 8080 },
		liveDemod: { httpPort: 8081 },
		digitalVoice: { httpPort: 8082 },
		access: protectedAccess(accessHost),
		logging: { level: "debug", dir: `/var/${t()}` },
		channelizer: { binaryPath: `/opt/${t()}`, socketDir: `/run/${t()}` },
		station: { name: t(), callsign: t(), lat, lon, altM, country: "CH" },
		stateDir: `/state/${t()}`,
		region: "eu",
	})
	return { config, secrets, numericSecrets: [lat, lon, altM, numericKey] }
}

describe("config export redaction", () => {
	it("leaks no secret of the every-secret fixture in any encoding (req 7.4)", () => {
		const { config, secrets, numericSecrets } = everySecretFixture()
		const body = exportConfig(config, {
			...META,
			secretOptionKeys: type => (type === "dsd-fme" ? ["extraArgs"] : []),
		})
		expectAbsent(body, secrets)
		for (const n of numericSecrets) expect(body).not.toContain(String(n))
	})

	it("writes the exact header line", () => {
		const { config } = everySecretFixture()
		const body = exportConfig(config, META)
		expect(body.split("\n")[0]).toBe(
			`# WaveKit 1.2.3 redacted configuration export 2026-10-16T00:00:00.000Z: secrets, hosts, paths, names and the station position are replaced by "<redacted>"`,
		)
	})

	it("sanitizes header fields against newline injection", () => {
		const { config } = everySecretFixture()
		const body = exportConfig(config, {
			version: "1\nsecret: x",
			generatedAt: `${"z".repeat(100)}\r `,
		})
		const first = body.split("\n")[0]!
		expect(first).toContain("1secret: x")
		expect(first).toContain("z".repeat(64))
		expect(first).not.toContain("z".repeat(65))
		expect(body.split("\n")[1]).not.toContain("secret: x")
	})

	it("keeps ids, types, sourceIds, region, country, enums, numbers and booleans", () => {
		const { config } = everySecretFixture()
		const r = redactConfig(config) as {
			sources: Record<string, unknown>[]
			decoders: Record<string, unknown>[]
			access: unknown
			region: unknown
			station: Record<string, unknown>
			logging: Record<string, unknown>
			channelizer: Record<string, unknown>
			stateDir: unknown
		}
		expect(r.access).toEqual({ mode: "protected" })
		expect(r.region).toBe("EU")
		expect(r.station).toMatchObject({
			country: "CH",
			name: R,
			callsign: R,
			lat: R,
			lon: R,
			altM: R,
		})
		expect(r.sources[0]).toMatchObject({
			id: "src0",
			type: "rtl_tcp",
			host: R,
			port: 1234,
			loop: false,
			caps: { kind: "iq", format: "U8_IQ", sampleRate: 2_048_000 },
			sdrHost: { apiUrl: R, rtlmuxStatsUrl: R },
		})
		expect(r.sources[1]).toMatchObject({ id: "rec", filePath: R })
		expect(r.decoders[0]).toMatchObject({
			id: "mesh0",
			type: "lora-meshtastic",
			enabled: true,
			sourceId: "src0",
			useChannelizer: false,
			options: {
				region: "EU_868",
				preset: "LongFast",
				channelKey: R,
				numericKey: R,
				nested: { psk: R, deeper: [{ label: R }, R], ok: 3 },
			},
		})
		expect(r.decoders[1]).toMatchObject({
			outputProtocol: "tcp",
			outputPort: 30005,
			outputHost: R,
			deviceSerial: R,
			minVersion: R,
			options: { mode: "dmr", output: R, udpPort: 7355, keys: R },
		})
		expect(r.logging).toEqual({ level: "debug", dir: R })
		expect(r.channelizer).toMatchObject({
			enabled: false,
			binaryPath: R,
			socketDir: R,
		})
		expect(r.stateDir).toBe(R)
	})

	it("redacts secretOptionKeys entries whatever their type", () => {
		const { config } = everySecretFixture(1)
		const r = redactConfig(config, {
			secretOptionKeys: () => ["udpPort", "region"],
		}) as { decoders: { options: Record<string, unknown> }[] }
		expect(r.decoders[0]!.options["region"]).toBe(R)
		expect(r.decoders[1]!.options["udpPort"]).toBe(R)
		expect(r.decoders[1]!.options["mode"]).toBe("dmr")
	})

	it("fails closed when secretOptionKeys throws or returns a non-array", () => {
		const { config } = everySecretFixture(1)
		const throwing = redactConfig(config, {
			secretOptionKeys: () => {
				throw new Error("boom")
			},
		}) as { decoders: { options: unknown }[] }
		expect(throwing.decoders.every(d => d.options === R)).toBe(true)
		const bad = redactConfig(config, {
			secretOptionKeys: (() => "region") as unknown as (
				type: string,
			) => readonly string[],
		}) as { decoders: { options: unknown }[] }
		expect(bad.decoders.every(d => d.options === R)).toBe(true)
	})

	it("redacts strings under a record of unknown and under unknown keys, and renames their keys", () => {
		const schema = z.object({ m: z.record(z.unknown()), id: z.string() })
		const out = redactWithSchema(
			{ m: { "my.host.example": "secret-value", n: 2 }, id: "x", extra: "y" },
			schema,
		)
		expect(out).toEqual({
			m: { "<redacted-1>": R, "<redacted-2>": 2 },
			id: R,
			"<redacted-3>": R,
		})
		const { config } = everySecretFixture(1)
		const withUnknown = { ...config, surprise: { host: "leak" } } as Config
		const r = redactConfig(withUnknown)
		expect(JSON.stringify(r)).not.toContain("leak")
		expect(JSON.stringify(r)).not.toContain("surprise")
	})

	it("renames non-identifier option keys", () => {
		const { config } = everySecretFixture(1)
		config.decoders[0]!.options = { "10.0.0.1:80": 5, gain: 3 }
		const r = redactConfig(config) as { decoders: { options: unknown }[] }
		expect(r.decoders[0]!.options).toEqual({ "<redacted-1>": 5, gain: 3 })
	})

	it("keeps closed-set strings only when the value is a member", () => {
		const schema = z.object({
			e: z.enum(["a", "b"]),
			n: z.nativeEnum({ X: "x" }),
			u: z.union([z.literal("p"), z.literal("q")]),
			o: z.enum(["a"]).optional().default("a"),
			f: z.string().refine(() => true),
		})
		expect(
			redactWithSchema({ e: "a", n: "x", u: "q", o: "zz", f: "free" }, schema),
		).toEqual({ e: "a", n: "x", u: "q", o: R, f: R })
	})

	it("fails closed on ambiguous unions that disagree", () => {
		const schema = z.object({ v: z.union([z.literal("a"), z.string()]) })
		expect(redactWithSchema({ v: "a" }, schema)).toEqual({ v: R })
	})

	it("redacts non-plain values and bounds depth", () => {
		const schema = z.object({}).passthrough()
		const out = redactWithSchema(
			{ d: new Date(0), b: Buffer.from("x"), big: 1n, fn: () => 1 },
			schema,
		) as Record<string, unknown>
		expect(Object.values(out)).toEqual([R, R, R, R])
		let deep: unknown = 1
		for (let i = 0; i < 100; i += 1) deep = [deep]
		expect(JSON.stringify(redactWithSchema(deep, undefined))).toContain(R)
	})

	it("passes at exactly maxBytes and throws one byte below without content", () => {
		const { config, secrets } = everySecretFixture()
		const body = exportConfig(config, META)
		const size = Buffer.byteLength(body, "utf8")
		expect(exportConfig(config, { ...META, maxBytes: size })).toBe(body)
		let error: unknown
		try {
			exportConfig(config, { ...META, maxBytes: size - 1 })
		} catch (e) {
			error = e
		}
		expect(error).toBeInstanceOf(ConfigExportTooLargeError)
		const message = (error as Error).message
		expect(message).not.toContain("src0")
		expectAbsent(message, secrets)
	})

	// Feature: web-gaps-6, Property 14: No secret in export
	// Validates: Requirements 7.3, 7.4
	it("property: no seeded secret appears in the export", () => {
		const hex = fc
			.uint8Array({ minLength: 10, maxLength: 10 })
			.map(b => `s${Buffer.from(b).toString("hex")}`)
		fc.assert(
			fc.property(
				fc.record({
					host: hex,
					path: hex,
					name: hex,
					optionString: hex,
					optionKey: fc.constantFrom("channelKey", "psk", "token", "x"),
					nestedSecret: hex,
					urlUser: hex,
					serial: hex,
					lat: fc.double({ min: -89, max: 89, noNaN: true }),
					withAccess: fc.boolean(),
					decoders: fc.integer({ min: 1, max: 4 }),
				}),
				s => {
					const accessHost = `${s.host}.example`
					const config = ConfigSchema.parse({
						sources: [
							{
								id: "a",
								type: "rtl_tcp",
								host: s.host,
								caps: { kind: "iq", sampleRate: 1, format: "U8_IQ" },
								sdrHost: { apiUrl: `http://${s.urlUser}@x.example/` },
							},
						],
						decoders: Array.from({ length: s.decoders }, (_, i) => ({
							id: `d${i}`,
							type: "t",
							enabled: i % 2 === 0,
							deviceSerial: s.serial,
							options: {
								[s.optionKey]: s.optionString,
								list: [s.optionString, { inner: [s.nestedSecret] }],
								obj: { token: 1234567, free: s.nestedSecret },
							},
						})),
						...(s.withAccess
							? {
									api: { host: "127.0.0.1", port: 8080 },
									liveDemod: { httpPort: 8081 },
									digitalVoice: { httpPort: 8082 },
									access: protectedAccess(accessHost),
								}
							: {}),
						logging: { dir: s.path },
						station: { name: s.name, lat: s.lat },
						stateDir: s.path,
					})
					const body = exportConfig(config, META)
					expectAbsent(body, [
						s.host,
						s.path,
						s.name,
						s.optionString,
						s.nestedSecret,
						s.urlUser,
						s.serial,
					])
					expect(body).not.toContain("1234567")
					if (!Number.isInteger(s.lat))
						expect(body).not.toContain(String(s.lat))
				},
			),
			{ numRuns: 150 },
		)
	})
})

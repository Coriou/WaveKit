/**
 * Static invariants for the opt-in protected TLS reference profile.
 * Decision 5: Caddy internal CA, shared network namespace, loopback backends.
 */
import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import * as fc from "fast-check"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { parse } from "yaml"
import { loadConfig } from "../../../src/config.js"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const HOST_TOKEN = "${WAVEKIT_PUBLIC_HOST:-receiver.example}"
const DEFAULT_HOST = "receiver.example"
const TLS = { api: 9443, analog: 9444, digital: 9445 } as const
const BACKEND = { api: 9000, analog: 8081, digital: 8082 } as const
const UNPUBLISHED = [8080, 9000, 8081, 8082, 1234, 4713, 5259, 7355]

interface ComposeService {
	profiles?: string[]
	image?: string
	build?: { target?: string }
	environment?: Record<string, string | number | boolean>
	ports?: string[]
	networks?: string[] | Record<string, unknown>
	extra_hosts?: string[]
	volumes?: string[]
	network_mode?: string
	depends_on?: string[] | Record<string, unknown>
	entrypoint?: string[]
	command?: string[] | string
	healthcheck?: { test?: string[] }
}

interface ComposeFile {
	name?: string
	services: Record<string, ComposeService>
	networks?: Record<string, unknown>
	volumes?: Record<string, unknown>
}

interface Mount {
	source: string
	target: string
	readOnly: boolean
}

interface CaddySite {
	port: number
	body: string
}

const read = (path: string) => readFileSync(join(root, path), "utf8")

function composeFile(): ComposeFile {
	return parse(read("compose.yaml")) as ComposeFile
}

function stringifyEnv(
	environment: Record<string, string | number | boolean> | undefined,
): Record<string, string> {
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(environment ?? {})) {
		out[key] = String(value)
	}
	return out
}

function substituteHost(value: string, host: string): string {
	if (value.includes("$") && !value.includes(HOST_TOKEN)) {
		throw new Error(`unexpected interpolation: ${value}`)
	}
	return value.split(HOST_TOKEN).join(host)
}

function referenceEnv(host: string): Record<string, string> {
	const environment = stringifyEnv(
		composeFile().services["wavekit-protected"]?.environment,
	)
	const out: Record<string, string> = {}
	for (const [key, value] of Object.entries(environment)) {
		out[key] = substituteHost(value, host)
	}
	return out
}

function applyEnv(values: Record<string, string>): void {
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("WAVEKIT_")) delete process.env[key]
	}
	for (const [key, value] of Object.entries(values)) {
		process.env[key] = value
	}
}

function parseMount(spec: string): Mount {
	const readOnly = spec.endsWith(":ro")
	const body = readOnly ? spec.slice(0, -3) : spec
	const index = body.indexOf(":")
	if (index <= 0) throw new Error(`unparsed mount: ${spec}`)
	return {
		source: body.slice(0, index),
		target: body.slice(index + 1),
		readOnly,
	}
}

function publishedContainerPort(spec: string): number {
	const parts = spec.split(":")
	const container = parts[parts.length - 1]
	if (!container || !/^\d+$/.test(container)) {
		throw new Error(`unparsed port: ${spec}`)
	}
	return Number(container)
}

function caddySites(text: string): { preamble: string; sites: CaddySite[] } {
	const sites: CaddySite[] = []
	const header = /^https:\/\/\{\$WAVEKIT_PUBLIC_HOST\}:(\d+) \{$/gm
	const matches = [...text.matchAll(header)]
	if (matches.length === 0) throw new Error("Caddyfile has no TLS sites")
	const first = matches[0]
	if (first?.index === undefined) throw new Error("missing site index")
	matches.forEach((match, index) => {
		const start = match.index
		if (start === undefined) throw new Error("missing site index")
		const next = matches[index + 1]?.index ?? text.length
		const body = text.slice(start, next)
		let depth = 0
		for (const char of body) {
			if (char === "{") depth += 1
			if (char === "}") depth -= 1
		}
		if (depth !== 0) throw new Error(`unbalanced site ${match[1] ?? ""}`)
		sites.push({ port: Number(match[1]), body })
	})
	return { preamble: text.slice(0, first.index), sites }
}

const label = fc
	.array(
		fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz0123456789".split(""), "-"),
		{ minLength: 1, maxLength: 12 },
	)
	.map(chars => chars.join(""))
	.filter(value => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(value))

const letterLabel = fc
	.array(fc.constantFrom(..."abcdefghijklmnopqrstuvwxyz".split("")), {
		minLength: 1,
		maxLength: 12,
	})
	.map(chars => chars.join(""))

// The final label is letters. A numeric final label is not a URL hostname
// (`https://example.2` does not parse), so it is outside this deployment.
const hostname = fc
	.tuple(fc.array(label, { minLength: 0, maxLength: 3 }), letterLabel)
	.map(([prefix, tld]) => [...prefix, tld].join("."))
	.filter(host => {
		try {
			return new URL(`https://${host}:9443`).hostname === host
		} catch {
			return false
		}
	})

describe("protected compose profile", () => {
	let originalEnv: NodeJS.ProcessEnv

	beforeEach(() => {
		originalEnv = { ...process.env }
	})

	afterEach(() => {
		process.env = originalEnv
	})

	it("publishes only the three TLS ports on the core service", () => {
		const current = composeFile()
		const core = current.services["wavekit-protected"]
		const caddy = current.services["wavekit-protected-caddy"]
		expect(core?.profiles).toEqual(["protected"])
		expect(caddy?.profiles).toEqual(["protected"])
		expect(core?.build?.target).toBe("final-core")
		expect(core?.image).toBe("${WAVEKIT_APP_IMAGE:-wavekit:local-core}")
		expect(caddy?.image).toBe("caddy:2")
		expect(caddy?.network_mode).toBe("service:wavekit-protected")
		expect(caddy?.ports).toBeUndefined()
		expect(caddy?.networks).toBeUndefined()
		expect(caddy?.depends_on).toEqual(["wavekit-protected"])
		const published = (core?.ports ?? []).map(publishedContainerPort)
		expect(published).toEqual([TLS.api, TLS.analog, TLS.digital])
		for (const spec of core?.ports ?? []) {
			expect(spec.startsWith("127.0.0.1:")).toBe(false)
		}
		for (const port of UNPUBLISHED) {
			expect(published).not.toContain(port)
		}
		for (const service of Object.values(current.services)) {
			if (service.profiles?.includes("protected") && service !== core) {
				expect(service.ports ?? []).toEqual([])
			}
		}
	})

	it("sets no daemon-rejected options on services sharing a network namespace", () => {
		const raw = parse(read("compose.yaml")) as {
			services: Record<string, Record<string, unknown>>
		}
		const shared = Object.entries(raw.services).filter(([, service]) =>
			String(service["network_mode"] ?? "").startsWith("service:"),
		)
		expect(shared.map(([name]) => name)).toContain("wavekit-protected-caddy")
		for (const [, service] of shared) {
			for (const key of [
				"extra_hosts",
				"ports",
				"expose",
				"dns",
				"dns_search",
				"hostname",
				"mac_address",
				"links",
				"networks",
			]) {
				expect(service[key]).toBeUndefined()
			}
		}
	})

	it("keeps backends on loopback and the private volume dedicated", () => {
		const core = composeFile().services["wavekit-protected"]
		const caddy = composeFile().services["wavekit-protected-caddy"]
		const env = stringifyEnv(core?.environment)
		expect(env["WAVEKIT_API__HOST"]).toBe("127.0.0.1")
		expect(env["WAVEKIT_API__PORT"]).toBe(String(BACKEND.api))
		expect(env["WAVEKIT_LIVE_DEMOD__HTTP_PORT"]).toBe(String(BACKEND.analog))
		expect(env["WAVEKIT_DIGITAL_VOICE__HTTP_PORT"]).toBe(
			String(BACKEND.digital),
		)
		expect(env["WAVEKIT_TUNER_RELAY__ENABLED"]).toBe("false")
		expect(env["WAVEKIT_ACCESS__MODE"]).toBe("protected")
		expect(env["WAVEKIT_ACCESS__LISTENER_SCHEME"]).toBe("https")
		expect(env["WAVEKIT_ACCESS__EXPOSURE"]).toBe("tls-termination")
		expect(env["WAVEKIT_ACCESS__AUDIO__ANALOG__BIND_HOST"]).toBe("127.0.0.1")
		expect(env["WAVEKIT_ACCESS__AUDIO__DIGITAL__BIND_HOST"]).toBe("127.0.0.1")
		expect(env["WAVEKIT_ACCESS__HEALTH_PROBE__TARGET"]).toBe(
			"http://127.0.0.1:9000",
		)
		expect(env["WAVEKIT_ACCESS__HEALTH_PROBE__HOST"]).toBe(
			`${HOST_TOKEN}:${TLS.api}`,
		)
		expect(env["WAVEKIT_ACCESS_PRIVATE_DIRECTORY"]).toBe(
			"/var/lib/wavekit/access",
		)
		expect(core?.healthcheck?.test).toEqual([
			"CMD",
			"/etc/s6-overlay/scripts/healthcheck.sh",
		])
		expect(core?.extra_hosts).toEqual([`${HOST_TOKEN}:127.0.0.1`])
		expect(caddy?.extra_hosts).toBeUndefined()
		expect(stringifyEnv(caddy?.environment)["WAVEKIT_PUBLIC_HOST"]).toBe(
			HOST_TOKEN,
		)

		const coreMounts = (core?.volumes ?? []).map(parseMount)
		const caddyMounts = (caddy?.volumes ?? []).map(parseMount)
		const access = coreMounts.find(
			mount => mount.source === "wavekit-protected-access",
		)
		expect(access).toEqual({
			source: "wavekit-protected-access",
			target: "/var/lib/wavekit/access",
			readOnly: false,
		})
		expect(
			caddyMounts.some(mount => mount.source === "wavekit-protected-access"),
		).toBe(false)
		expect(
			coreMounts.some(mount => mount.source === "wavekit-protected-caddy"),
		).toBe(false)
		expect(
			caddyMounts.find(mount => mount.source === "wavekit-protected-caddy"),
		).toEqual({
			source: "wavekit-protected-caddy",
			target: "/data",
			readOnly: false,
		})
		expect(
			coreMounts.find(mount => mount.source === "wavekit-protected-state"),
		).toMatchObject({ target: "/app/data", readOnly: false })
		const names = [
			"wavekit-protected-access",
			"wavekit-protected-state",
			"wavekit-protected-caddy",
			"wavekit-protected-trust",
		]
		expect(new Set(names).size).toBe(names.length)
		for (const name of names) {
			expect(composeFile().volumes).toHaveProperty(name)
		}
	})

	it("gives the core the public root and not the Caddy data volume", () => {
		const current = composeFile()
		const core = current.services["wavekit-protected"]
		const caddy = current.services["wavekit-protected-caddy"]
		const coreMounts = (core?.volumes ?? []).map(parseMount)
		const caddyMounts = (caddy?.volumes ?? []).map(parseMount)
		expect(
			coreMounts.some(mount => mount.source === "wavekit-protected-caddy"),
		).toBe(false)
		expect(
			coreMounts.some(
				mount => mount.target === "/data" || mount.target === "/caddy-data",
			),
		).toBe(false)
		for (const mount of [...coreMounts, ...caddyMounts]) {
			expect(mount.source.endsWith(".key")).toBe(false)
			expect(mount.target.endsWith(".key")).toBe(false)
		}
		expect(
			coreMounts.find(mount => mount.source === "wavekit-protected-trust"),
		).toEqual({
			source: "wavekit-protected-trust",
			target: "/caddy-trust",
			readOnly: true,
		})
		expect(
			caddyMounts.find(mount => mount.source === "wavekit-protected-trust"),
		).toEqual({
			source: "wavekit-protected-trust",
			target: "/trust",
			readOnly: false,
		})
		expect(
			caddyMounts.some(mount => mount.source === "wavekit-protected-access"),
		).toBe(false)
		expect(caddy?.entrypoint).toEqual(["/bin/sh", "/etc/caddy/export-trust.sh"])
		expect(caddy?.command).toEqual(["export-trust"])
		const exporter = read("docker/caddy/export-trust.sh")
		expect(exporter).toContain("/data/caddy/pki/authorities/local/root.crt")
		expect(exporter).toContain("trust_dir=/trust")
		expect(exporter).toContain('cert_dst="$trust_dir/root.crt"')
		expect(exporter).not.toContain("root.key")
		expect(exporter).not.toContain("intermediate.key")
		expect(exporter).toContain("PRIVATE KEY")
		expect(current.volumes).toHaveProperty("wavekit-protected-trust")

		const doc = read("docs/DOCKER-SETUP.md")
		expect(doc).toContain("CA key material")
		expect(doc).not.toContain("/caddy-data")
		expect(doc).toContain("NODE_EXTRA_CA_CERTS=/caddy-trust/root.crt")
		expect(doc).toContain("one shared loopback bucket")
		expect(doc).toContain("trusted-proxy address source")
		expect(doc).toContain("devices list")
		expect(doc).toContain("devices revoke DEVICE_ID")
		expect(doc).toContain("devices revoke-all --yes")
		expect(doc).toContain("rotate-credential")
		expect(doc).toContain("--keep-sessions")
		expect(doc).toContain("removes remembered browser")
	})

	it("agrees on origins across the runtime file, env, probe and Caddyfile", () => {
		expect(readdirSync(join(root, "docker/caddy")).sort()).toEqual([
			"Caddyfile",
			"export-trust.sh",
			"protected-runtime.yaml",
		])
		const caddy = read("docker/caddy/Caddyfile")
		const parsed = caddySites(caddy)
		expect(parsed.preamble).toContain("WebSocket upgrades")
		expect(parsed.preamble).toContain("admin off")
		expect(parsed.preamble).toContain("auto_https disable_redirects")
		expect(parsed.preamble).toContain("protocols h1 h2")
		expect(parsed.sites.map(site => site.port)).toEqual([
			TLS.api,
			TLS.analog,
			TLS.digital,
		])
		const upstreams = [BACKEND.api, BACKEND.analog, BACKEND.digital]
		parsed.sites.forEach((site, index) => {
			expect(site.body).toContain("bind 0.0.0.0")
			expect(site.body).toContain("tls internal")
			expect(site.body).toContain(
				`reverse_proxy 127.0.0.1:${upstreams[index] ?? ""}`,
			)
			expect(site.body).toContain("header_up Host {http.request.hostport}")
			expect(site.body.match(/header_up /g)).toHaveLength(1)
			expect(site.body).not.toContain("trusted_proxies")
		})
		expect(caddy).not.toContain("trusted_proxies")
		expect(caddy).not.toContain("acme")

		const env = referenceEnv(DEFAULT_HOST)
		expect(env["WAVEKIT_ACCESS__PUBLIC_ORIGINS__API"]).toBe(
			`https://${DEFAULT_HOST}:${TLS.api}`,
		)
		expect(env["WAVEKIT_ACCESS__PUBLIC_ORIGINS__ANALOG_AUDIO"]).toBe(
			`https://${DEFAULT_HOST}:${TLS.analog}`,
		)
		expect(env["WAVEKIT_ACCESS__PUBLIC_ORIGINS__DIGITAL_AUDIO"]).toBe(
			`https://${DEFAULT_HOST}:${TLS.digital}`,
		)
		expect(env["WAVEKIT_ACCESS__ALLOWED_AUTHORITIES__0"]).toBe(
			`${DEFAULT_HOST}:${TLS.api}`,
		)
		expect(env["WAVEKIT_ACCESS__HEALTH_PROBE__HOST"]).toBe(
			`${DEFAULT_HOST}:${TLS.api}`,
		)

		applyEnv({})
		const fromFile = loadConfig(
			join(root, "docker/caddy/protected-runtime.yaml"),
		)
		applyEnv(env)
		const fromEnv = loadConfig(
			join(root, "docker/caddy/protected-runtime.yaml"),
		)
		expect(fromEnv.access).toEqual(fromFile.access)
		expect(fromEnv.api).toEqual(fromFile.api)
		expect(fromEnv.stateDir).toBe("/app/data")
		expect(fromEnv.access.mode).toBe("protected")
		if (fromEnv.access.mode !== "protected") return
		expect(fromEnv.api).toMatchObject({ host: "127.0.0.1", port: BACKEND.api })
		expect(fromEnv.access.exposure).toBe("tls-termination")
		expect(fromEnv.access.listenerScheme).toBe("https")
		expect(fromEnv.access.publicOrigins).toEqual({
			api: `https://${DEFAULT_HOST}:${TLS.api}`,
			analogAudio: `https://${DEFAULT_HOST}:${TLS.analog}`,
			digitalAudio: `https://${DEFAULT_HOST}:${TLS.digital}`,
		})
		expect(fromEnv.access.healthProbe).toEqual({
			target: `http://127.0.0.1:${BACKEND.api}`,
			host: `${DEFAULT_HOST}:${TLS.api}`,
		})
		expect(fromEnv.access.audio.analog.bindHost).toBe("127.0.0.1")
		expect(fromEnv.access.audio.digital.bindHost).toBe("127.0.0.1")
		expect(fromEnv.tunerRelay.enabled).toBe(false)

		const doc = read("docs/DOCKER-SETUP.md")
		expect(doc).toContain("wavekit-protected-access")
		expect(doc).toContain("/var/lib/wavekit/access")
		expect(doc).toContain("network_mode: service:wavekit-protected")
		expect(doc).toContain("header_up Host {http.request.hostport}")
		expect(doc).toContain("access-command.js setup")
		expect(doc).toContain("access-command.js pair")
		expect(doc).toContain("root.crt")
	})

	it("keeps one https hostname across generated public hosts", () => {
		// Feature: browser-access-batch1, Property 1: reference TLS origins share one hostname
		// Validates: Requirements Decision 5
		fc.assert(
			fc.property(hostname, host => {
				applyEnv(referenceEnv(host))
				const config = loadConfig(
					join(root, "docker/caddy/protected-runtime.yaml"),
				)
				expect(config.access.mode).toBe("protected")
				if (config.access.mode !== "protected") return
				const origins = [
					config.access.publicOrigins.api,
					config.access.publicOrigins.analogAudio,
					config.access.publicOrigins.digitalAudio,
				]
				expect(new Set(origins).size).toBe(3)
				expect(config.access.allowedOrigins).toEqual([origins[0]])
				for (const origin of origins) {
					const url = new URL(origin)
					expect(url.protocol).toBe("https:")
					expect(url.hostname).toBe(host)
				}
				expect(config.access.healthProbe.target).toBe("http://127.0.0.1:9000")
				expect(config.access.healthProbe.host).toBe(`${host}:${TLS.api}`)
				expect(config.api).toMatchObject({
					host: "127.0.0.1",
					port: BACKEND.api,
				})
				expect(config.access.audio.analog.allowedAuthorities).toEqual([
					`${host}:${TLS.analog}`,
				])
				expect(config.access.audio.digital.allowedAuthorities).toEqual([
					`${host}:${TLS.digital}`,
				])
			}),
			{ numRuns: 100 },
		)
	})
})

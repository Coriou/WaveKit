import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const script = fileURLToPath(
	new URL("../../../docker/scripts/healthcheck.sh", import.meta.url),
)
const directories: string[] = []

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map(path => rm(path, { recursive: true, force: true })),
	)
})

async function probe(
	env: Record<string, string> = {},
	status = "200",
	curlExit = "0",
) {
	const directory = await mkdtemp(join(tmpdir(), "wavekit-health-probe-"))
	directories.push(directory)
	const calls = join(directory, "calls")
	await writeFile(join(directory, "timeout"), '#!/bin/sh\nshift\nexec "$@"\n', {
		mode: 0o700,
	})
	await writeFile(
		join(directory, "curl"),
		'#!/bin/sh\nprintf "%s\\n" "$@" >> "$HEALTH_TEST_CALLS"\nprintf "%s" "$HEALTH_TEST_STATUS"\nexit "$HEALTH_TEST_CURL_EXIT"\n',
		{ mode: 0o700 },
	)
	await writeFile(join(directory, "s6-svstat"), "#!/bin/sh\nexit 0\n", {
		mode: 0o700,
	})
	const result = await new Promise<{ exit: number | null; output: string }>(
		(resolve, reject) => {
			let output = ""
			const child = spawn("/bin/sh", [script], {
				env: {
					PATH: directory,
					WAVEKIT_API_HOST: "localhost",
					WAVEKIT_API_PORT: "9000",
					HEALTH_TEST_CALLS: calls,
					HEALTH_TEST_STATUS: status,
					HEALTH_TEST_CURL_EXIT: curlExit,
					...env,
				},
				stdio: ["ignore", "pipe", "pipe"],
			})
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString()
			})
			child.stderr.on("data", (chunk: Buffer) => {
				output += chunk.toString()
			})
			child.once("error", reject)
			child.once("close", exit => resolve({ exit, output }))
		},
	)
	let argumentsSent: string[] = []
	try {
		argumentsSent = (await readFile(calls, "utf8")).trim().split("\n")
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!("code" in error) ||
			error.code !== "ENOENT"
		)
			throw error
	}
	return { ...result, argumentsSent }
}

// Feature: core-access-policy
// Validates: Requirements 6.3, 6.4
describe("credential-free container health probe", () => {
	it.each([
		{ status: "200", curlExit: "0", expected: 0 },
		{ status: "503", curlExit: "0", expected: 1 },
		{ status: "", curlExit: "7", expected: 1 },
		{ status: "", curlExit: "124", expected: 1 },
	])(
		"preserves exact legacy public-health arguments for $status/$curlExit",
		async ({ status, curlExit, expected }) => {
			const result = await probe({}, status, curlExit)
			expect(result.exit).toBe(expected)
			expect(result.argumentsSent).toEqual([
				"-sf",
				"-w",
				"%{http_code}",
				"-o",
				"/dev/null",
				"http://localhost:9000/health",
			])
		},
	)

	it.each([
		["http://127.0.0.1:9000", "receiver.local:8443"],
		["http://127.0.0.1", "127.0.0.1"],
		["http://[::1]", "[::1]"],
		["http://[::1]:9000", "[::1]:9000"],
	])(
		"uses explicit protected target %s and Host %s for only public health",
		async (target, host) => {
			const result = await probe({
				WAVEKIT_ACCESS__MODE: "protected",
				WAVEKIT_ACCESS__HEALTH_PROBE__TARGET: target,
				WAVEKIT_ACCESS__HEALTH_PROBE__HOST: host,
				WAVEKIT_API_HOST: "untrusted-legacy-host",
				WAVEKIT_API_PORT: "9999",
			})
			expect(result.exit).toBe(0)
			expect(result.argumentsSent).toEqual([
				"-sf",
				"-w",
				"%{http_code}",
				"-o",
				"/dev/null",
				"-H",
				`Host: ${host}`,
				`${target}/health`,
			])
			expect(result.argumentsSent.join(" ")).not.toContain("/api/status")
			expect(result.argumentsSent.join(" ")).not.toMatch(
				/Authorization|Cookie|Bearer/,
			)
		},
	)

	it.each([
		["both missing", "", ""],
		[
			"path on default-port IPv4 target",
			"http://127.0.0.1/health",
			"127.0.0.1",
		],
		["path on default-port IPv6 target", "http://[::1]/health", "[::1]"],
		[
			"query on default-port target",
			"http://127.0.0.1?SECRET-query",
			"127.0.0.1",
		],
		[
			"userinfo on default-port target",
			"http://127.0.0.1@remote.local",
			"127.0.0.1",
		],
		["target missing", "", "receiver.local:8443"],
		["Host missing", "http://127.0.0.1:9000", ""],
		["remote target", "http://receiver.local:9000", "receiver.local:8443"],
		["wildcard target", "http://0.0.0.0:9000", "receiver.local:8443"],
		["HTTPS backend", "https://127.0.0.1:9000", "receiver.local:8443"],
		["port zero", "http://127.0.0.1:0", "receiver.local:8443"],
		["port out of range", "http://127.0.0.1:65536", "receiver.local:8443"],
		["non-numeric port", "http://127.0.0.1:SECRET-port", "receiver.local:8443"],
		[
			"path on target",
			"http://127.0.0.1:9000/SECRET-path",
			"receiver.local:8443",
		],
		[
			"query on target",
			"http://127.0.0.1:9000?SECRET-query",
			"receiver.local:8443",
		],
		[
			"fragment on target",
			"http://127.0.0.1:9000#SECRET-fragment",
			"receiver.local:8443",
		],
		[
			"colon in target path",
			"http://127.0.0.1:9000/SECRET-path:9000",
			"receiver.local:8443",
		],
		[
			"colon in target query",
			"http://127.0.0.1:9000?SECRET-query:9000",
			"receiver.local:8443",
		],
		[
			"target userinfo",
			"http://127.0.0.1:SECRET-password@remote.local:9000",
			"receiver.local:8443",
		],
		[
			"Host header newline",
			"http://127.0.0.1:9000",
			"receiver.local:8443\nAuthorization: SECRET",
		],
		[
			"Host header carriage return",
			"http://127.0.0.1:9000",
			"receiver.local:8443\rSECRET",
		],
		["Host header spaces", "http://127.0.0.1:9000", "receiver.local SECRET"],
		["Host header URL", "http://127.0.0.1:9000", "http://receiver.local:8443"],
	])(
		"rejects %s before curl without echoing configuration",
		async (_label, target, host) => {
			const result = await probe({
				WAVEKIT_ACCESS__MODE: "protected",
				WAVEKIT_ACCESS__HEALTH_PROBE__TARGET: target,
				WAVEKIT_ACCESS__HEALTH_PROBE__HOST: host,
			})
			expect(result.exit).toBe(1)
			expect(result.argumentsSent).toEqual([])
			expect(result.output).toContain("API health probe configuration invalid")
			expect(result.output).not.toContain("SECRET")
		},
	)
})

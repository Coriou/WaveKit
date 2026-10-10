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

// Feature: core-access-policy
// Validates: Requirements 6.3, 6.4
describe("credential-free container health probe", () => {
	it.each([
		{ status: "200", curlExit: "0", expected: 0 },
		{ status: "503", curlExit: "0", expected: 1 },
		{ status: "", curlExit: "7", expected: 1 },
		{ status: "", curlExit: "124", expected: 1 },
	])(
		"uses only public health for $status/$curlExit",
		async ({ status, curlExit, expected }) => {
			const directory = await mkdtemp(join(tmpdir(), "wavekit-health-probe-"))
			directories.push(directory)
			const calls = join(directory, "calls")
			await writeFile(
				join(directory, "timeout"),
				'#!/bin/sh\nshift\nexec "$@"\n',
				{ mode: 0o700 },
			)
			await writeFile(
				join(directory, "curl"),
				'#!/bin/sh\nprintf "%s\\n" "$@" >> "$HEALTH_TEST_CALLS"\nprintf "%s" "$HEALTH_TEST_STATUS"\nexit "$HEALTH_TEST_CURL_EXIT"\n',
				{ mode: 0o700 },
			)
			await writeFile(join(directory, "s6-svstat"), "#!/bin/sh\nexit 0\n", {
				mode: 0o700,
			})
			const exit = await new Promise<number | null>((resolve, reject) => {
				const child = spawn("/bin/sh", [script], {
					env: {
						PATH: directory,
						WAVEKIT_API_HOST: "localhost",
						WAVEKIT_API_PORT: "9000",
						HEALTH_TEST_CALLS: calls,
						HEALTH_TEST_STATUS: status,
						HEALTH_TEST_CURL_EXIT: curlExit,
					},
					stdio: "ignore",
				})
				child.once("error", reject)
				child.once("close", resolve)
			})
			expect(exit).toBe(expected)
			const argumentsSent = (await readFile(calls, "utf8")).trim().split("\n")
			expect(argumentsSent).toEqual([
				"-sf",
				"-w",
				"%{http_code}",
				"-o",
				"/dev/null",
				"http://localhost:9000/health",
			])
		},
	)
})

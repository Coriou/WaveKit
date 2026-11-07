import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"

const finish = fileURLToPath(
	new URL(
		"../../../docker/overlay/s6-overlay/s6-rc.d/wavekit-api/finish",
		import.meta.url,
	),
)
const directories: string[] = []

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map(path => rm(path, { recursive: true, force: true })),
	)
})

/** Runs the finish script with its cleanup helper and `sleep` stubbed, and says what it slept. */
async function sleepsAfter(exitCode: string, signal = "0"): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "wavekit-api-finish-"))
	directories.push(directory)
	const slept = join(directory, "slept")
	await writeFile(slept, "")
	await writeFile(
		join(directory, "sleep"),
		`#!/bin/sh\necho "$1" >> "${slept}"\n`,
		{ mode: 0o700 },
	)
	const helper = "/usr/local/bin/finish-api.sh"
	const source = await readFile(finish, "utf8")
	expect(source).toContain(helper)
	const script = join(directory, "finish")
	await writeFile(script, source.replace(helper, ":"), { mode: 0o700 })
	const code = await new Promise<number | null>((resolve, reject) => {
		const child = spawn("/bin/sh", [script, exitCode, signal], {
			env: { PATH: `${directory}:/usr/bin:/bin` },
			stdio: "ignore",
		})
		child.once("error", reject)
		child.once("close", resolve)
	})
	expect(code).toBe(0)
	return (await readFile(slept, "utf8")).trim()
}

describe("wavekit-api finish script", () => {
	it.each(["1", "2", "137"])(
		"holds a failed exit (%s) back: a refused start cannot loop every second",
		async exitCode => {
			expect(await sleepsAfter(exitCode)).toBe("4")
		},
	)

	it.each([
		["a clean exit", "0", "0"],
		["a signal, as s6 reports it", "256", "15"],
	])("waits for nothing after %s", async (_name, exitCode, signal) => {
		expect(await sleepsAfter(exitCode, signal)).toBe("")
	})

	it("stays within s6-supervise's default 5 s limit for a finish script", async () => {
		const seconds = Number(await sleepsAfter("1"))
		expect(seconds).toBeLessThan(5)
	})
})

import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"

describe("generated Pi first-boot bootstrap", () => {
	let temp: string
	let boot: string
	let home: string
	let state: string
	let log: string
	let script: string
	let bin: string
	let calls: string

	beforeEach(() => {
		temp = mkdtempSync(join(tmpdir(), "wavekit-firstboot-"))
		boot = join(temp, "boot", "firmware")
		home = join(temp, "home", "ben")
		state = join(temp, "state")
		log = join(temp, "log", "wavekit-firstboot.log")
		bin = join(temp, "bin")
		calls = join(temp, "calls")
		for (const path of [boot, home, bin, join(temp, "log")])
			mkdirSync(path, { recursive: true })
		script = join(temp, "firstboot.sh")
		const generated = spawnSync(
			process.execPath,
			[
				resolve("packages/sdr-host/scripts/stage-pi-boot.mjs"),
				"--bootstrap-out",
				script,
				"--user",
				"ben",
			],
			{ encoding: "utf8" },
		)
		expect(generated.status, generated.stderr).toBe(0)
		// Redirect every mutable system path before executing the real generated
		// script. Privilege/account commands are mocks; setup is a local fixture.
		writeFileSync(
			script,
			readFileSync(script, "utf8")
				.replaceAll("/boot", join(temp, "boot"))
				.replaceAll("/var/lib/wavekit", state)
				.replaceAll("/var/log/wavekit-firstboot.log", log),
		)
		const shim = `#!/usr/bin/env bash
printf '%s %s\\n' "\${0##*/}" "$*" >> "$MOCK_CALLS"
case "\${0##*/}" in
  id)
    case "$1" in
      -u) if [ "\${2:-}" = ben ]; then echo 1000; else echo "$MOCK_UID"; fi ;;
      -gn) echo ben ;;
      ben) [ "\${MOCK_USER_MISSING:-0}" = 0 ] ;;
      *) exit 1 ;;
    esac ;;
  getent) printf 'ben:x:1000:1000:Ben:%s:/bin/bash\\n' "$MOCK_HOME" ;;
  chown) exit 0 ;;
  sudo) echo 'fixture sudo requires a password' >&2; exit 1 ;;
esac
`
		for (const command of ["id", "getent", "chown", "sudo"]) {
			writeFileSync(join(bin, command), shim)
			chmodSync(join(bin, command), 0o755)
		}
		mkdirSync(join(boot, "wavekit-pi-bundle"))
		writeFileSync(
			join(boot, "wavekit-pi-bundle", "setup.sh"),
			`#!/usr/bin/env bash
printf '%s|%s|%s\\n' "$(id -u)" "$*" "$PWD" >> "$MOCK_SETUP_CALLS"
cat "$MOCK_BOOT_STATUS" > "$MOCK_RUNNING_STATUS"
echo fixture-setup-output
exit "\${MOCK_SETUP_EXIT:-0}"
`,
		)
	})

	afterEach(() => rmSync(temp, { recursive: true, force: true }))

	function run(overrides: Record<string, string> = {}) {
		return spawnSync("bash", [script], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${bin}${delimiter}${process.env["PATH"]}`,
				MOCK_CALLS: calls,
				MOCK_SETUP_CALLS: join(temp, "setup-calls"),
				MOCK_BOOT_STATUS: join(boot, "wavekit-setup.status"),
				MOCK_RUNNING_STATUS: join(temp, "running-status"),
				MOCK_HOME: home,
				MOCK_UID: "0",
				...overrides,
			},
		})
	}

	function status() {
		return readFileSync(join(boot, "wavekit-setup.status"), "utf8")
	}

	it("runs setup as root for the normal account despite password-protected sudo", () => {
		const result = run()
		expect(result.status, result.stderr).toBe(0)
		expect(readFileSync(join(temp, "setup-calls"), "utf8")).toBe(
			`0|--target-user ben|${home}/wavekit-pi-bundle\n`,
		)
		expect(readFileSync(calls, "utf8")).not.toMatch(/^sudo /m)
		expect(readFileSync(join(temp, "running-status"), "utf8")).toMatch(
			/^\S+ running\n$/,
		)
		expect(status()).toMatch(/^\S+ complete\n$/)
		expect(existsSync(join(state, "firstboot.done"))).toBe(true)
		expect(readFileSync(log, "utf8")).toContain("fixture-setup-output")
		expect(readFileSync(join(boot, "wavekit-setup.log"), "utf8")).toBe(
			readFileSync(log, "utf8"),
		)
	})

	it("records setup failure and permits a successful retry", () => {
		expect(run({ MOCK_SETUP_EXIT: "23" }).status).toBe(23)
		expect(status()).toMatch(/^\S+ failed\n$/)
		expect(existsSync(join(state, "firstboot.done"))).toBe(false)
		const failedLog = readFileSync(join(boot, "wavekit-setup.log"), "utf8")
		expect(failedLog).toContain("fixture-setup-output")
		expect(failedLog).toContain("failed (exit 23)")
		expect(run().status).toBe(0)
		expect(status()).toMatch(/^\S+ complete\n$/)
		expect(
			readFileSync(join(temp, "setup-calls"), "utf8").trim().split("\n"),
		).toHaveLength(2)
	})

	it("skips completed setup on rerun and preserves local settings", () => {
		expect(run().status).toBe(0)
		const settings = join(home, "wavekit-pi-bundle", ".env")
		writeFileSync(settings, "fixture-custom-settings\n")
		expect(run({ MOCK_SETUP_EXIT: "23" }).status).toBe(0)
		expect(
			readFileSync(join(temp, "setup-calls"), "utf8").trim().split("\n"),
		).toHaveLength(1)
		expect(readFileSync(settings, "utf8")).toBe("fixture-custom-settings\n")
		expect(status()).toMatch(/^\S+ complete\n$/)
	})

	it("rejects a non-root launch before writing system state", () => {
		expect(run({ MOCK_UID: "1000" }).status).toBe(1)
		expect(existsSync(state)).toBe(false)
		expect(existsSync(log)).toBe(false)
	})

	it("reports a missing normal account without running setup", () => {
		expect(run({ MOCK_USER_MISSING: "1" }).status).toBe(1)
		expect(status()).toMatch(/^\S+ failed\n$/)
		expect(readFileSync(join(boot, "wavekit-setup.log"), "utf8")).toContain(
			"normal user does not exist",
		)
		expect(existsSync(join(temp, "setup-calls"))).toBe(false)
	})

	it("fails safely when the bundle is missing", () => {
		rmSync(join(boot, "wavekit-pi-bundle"), { recursive: true })
		expect(run().status).toBe(1)
		expect(readFileSync(log, "utf8")).toContain("bundle missing")
		expect(status()).toMatch(/^\S+ failed\n$/)
		expect(readFileSync(join(boot, "wavekit-setup.log"), "utf8")).toBe(
			readFileSync(log, "utf8"),
		)
		expect(existsSync(join(state, "firstboot.done"))).toBe(false)
		expect(existsSync(join(temp, "setup-calls"))).toBe(false)
	})
})

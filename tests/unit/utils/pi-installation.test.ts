import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { gzipSync } from "node:zlib"
import { writeExecutable } from "../../mocks/executables.js"

// Every test spawns real subprocesses (node/bash); their wall time scales with
// host load and suite parallelism, so allow headroom beyond the 5 s default.
describe("Pi installation privilege modes", { timeout: 15000 }, () => {
	let temp: string
	let bin: string
	let calls: string

	beforeEach(() => {
		temp = mkdtempSync(join(tmpdir(), "wavekit-pi-install-"))
		bin = join(temp, "bin")
		mkdirSync(bin)
		calls = join(temp, "calls.tsv")
		writeFileSync(calls, "")
		const shim = `#!/usr/bin/env bash
mock_name="\${0##*/}"
printf '%s\\t%s\\t%s\\n' "$mock_name" "$*" "\${WAVEKIT_SDR_HOST_IMAGE:-}" >> "$MOCK_CALLS"
case "$mock_name" in
  uname) if [ "$1" = -s ]; then echo Linux; else echo aarch64; fi ;;
  dpkg) if [ "$1" = --print-architecture ]; then echo arm64; fi ;;
  id)
    case "$1" in
      -u) case "\${2:-}" in ben) echo 1000 ;; root) echo 0 ;; *) echo "$MOCK_UID" ;; esac ;;
      -un) if [ "$MOCK_UID" = 0 ]; then echo root; else echo ben; fi ;;
      -nG) echo 'ben sudo' ;;
      -gn) echo ben ;;
      ben) exit 0 ;;
      *) exit 1 ;;
    esac ;;
  sudo) export MOCK_SUDO=1; "$@"; exit "$?" ;;
  docker)
    if [ "$1" = --version ]; then echo 'Docker fixture'
    elif [ "$1" = info ]; then [ "$MOCK_UID" = 0 ] || [ "\${MOCK_SUDO:-}" = 1 ]
    fi ;;
esac
`
		for (const name of [
			"docker",
			"uname",
			"dpkg",
			"id",
			"sudo",
			"systemctl",
			"usermod",
			"chown",
		]) {
			writeExecutable(join(bin, name), shim)
		}
	})

	afterEach(() => rmSync(temp, { recursive: true, force: true }))

	function environment(uid: string) {
		return {
			...process.env,
			PATH: `${bin}${delimiter}${process.env["PATH"]}`,
			MOCK_CALLS: calls,
			MOCK_UID: uid,
		}
	}

	function recordedCalls(): Array<{
		name: string
		args: string[]
		image: string | undefined
	}> {
		return readFileSync(calls, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map(line => {
				const [name, args, image] = line.split("\t")
				return { name: name ?? "", args: args ? args.split(" ") : [], image }
			})
	}

	function installerFixture() {
		const release = join(temp, "os-release")
		const daemon = join(temp, "daemon.json")
		writeFileSync(release, "ID=debian\nVERSION_ID=12\n")
		writeFileSync(daemon, "{}\n")
		const path = join(temp, "install.sh")
		writeFileSync(
			path,
			readFileSync(
				resolve("packages/sdr-host/scripts/install-docker.sh"),
				"utf8",
			)
				.replaceAll("/etc/os-release", release)
				.replaceAll("/etc/docker/daemon.json", daemon),
		)
		return path
	}

	it.each(["0", "1000"])(
		"installs for ben with UID %s without changing sudo policy",
		uid => {
			const args = uid === "0" ? ["--target-user", "ben"] : []
			const result = spawnSync(
				"bash",
				[installerFixture(), "--yes", "--no-blacklist", ...args],
				{ env: environment(uid), encoding: "utf8" },
			)
			expect(result.status, result.stderr).toBe(0)
			const records = recordedCalls()
			expect(
				records.filter(call => call.name === "usermod").map(call => call.args),
			).toEqual([["-aG", "docker", "ben"]])
			expect(records.some(call => call.name === "sudo")).toBe(uid !== "0")
			expect(
				records.some(call => call.args.some(arg => arg.includes("sudoers"))),
			).toBe(false)
		},
		15000,
	)

	it("requires a normal target user when root launches the installer", () => {
		const result = spawnSync("bash", [installerFixture(), "--yes"], {
			env: environment("0"),
			encoding: "utf8",
		})
		expect(result.status).toBe(1)
		expect(result.stderr).toContain("--target-user")
		expect(recordedCalls().some(call => call.name === "usermod")).toBe(false)
	})

	it.each(["0", "1000"])(
		"loads the bundle with UID %s and retains settings on rerun",
		uid => {
			const bundle = join(temp, "bundle")
			mkdirSync(bundle)
			writeFileSync(
				join(bundle, "setup.sh"),
				readFileSync(resolve("packages/sdr-host/scripts/pi-bundle-setup.sh")),
			)
			writeFileSync(join(bundle, "IMAGE.txt"), "wavekit-sdr-host:pi-local\n")
			writeFileSync(
				join(bundle, "wavekit-sdr-host-image.tar.gz"),
				gzipSync("fixture image"),
			)
			writeFileSync(join(bundle, "docker-compose.yml"), "fixture compose")
			writeFileSync(join(bundle, ".env.example"), "fixture env")
			const installLog = join(temp, "install-args")
			writeFileSync(
				join(bundle, "install-docker.sh"),
				`#!/bin/bash\nprintf '%s\\n' "$*" >> '${installLog}'\n`,
			)
			const payload = [
				"IMAGE.txt",
				"wavekit-sdr-host-image.tar.gz",
				"docker-compose.yml",
				"install-docker.sh",
				"setup.sh",
				".env.example",
			]
			writeFileSync(
				join(bundle, "SHA256SUMS"),
				payload
					.map(
						name =>
							`${createHash("sha256")
								.update(readFileSync(join(bundle, name)))
								.digest("hex")}  ${name}\n`,
					)
					.join(""),
			)
			const args = uid === "0" ? ["--target-user", "ben"] : []
			for (let i = 0; i < 2; i++) {
				const result = spawnSync("bash", [join(bundle, "setup.sh"), ...args], {
					env: environment(uid),
					encoding: "utf8",
				})
				expect(result.status, result.stderr).toBe(0)
				if (i === 0)
					writeFileSync(join(bundle, ".env"), "SDR_HOST_RTL_TCP__GAIN=42\n")
			}
			expect(readFileSync(installLog, "utf8")).toBe(
				uid === "0" ? "--yes --target-user ben\n" : "--yes\n",
			)
			expect(readFileSync(join(bundle, ".env"), "utf8")).toBe(
				"SDR_HOST_RTL_TCP__GAIN=42\n",
			)
			const starts = recordedCalls().filter(
				call => call.name === "docker" && call.args.includes("up"),
			)
			expect(starts).toHaveLength(2)
			for (const call of starts) {
				expect(call.args).toContain("never")
				expect(call.image).toBe("wavekit-sdr-host:pi-local")
			}
			if (uid === "0")
				expect(recordedCalls().some(call => call.name === "sudo")).toBe(false)

			// A damaged script must fail before any new Docker operation.
			const dockerCalls = recordedCalls().filter(
				call => call.name === "docker",
			).length
			writeFileSync(join(bundle, "install-docker.sh"), "corrupted payload\n")
			const damaged = spawnSync("bash", [join(bundle, "setup.sh"), ...args], {
				env: environment(uid),
				encoding: "utf8",
			})
			expect(damaged.status).not.toBe(0)
			expect(
				recordedCalls().filter(call => call.name === "docker"),
			).toHaveLength(dockerCalls)
		},
		15000,
	)
})

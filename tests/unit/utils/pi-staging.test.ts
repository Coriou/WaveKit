import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	mkdirSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parse } from "yaml"

const script = resolve("packages/sdr-host/scripts/stage-pi-boot.mjs")
const fixture = `#cloud-config
# Imager settings must survive staging.
hostname: wavekit-pi
users:
  - name: ben
    sudo: ["ALL=(ALL) ALL"]
    passwd: fixture-login-secret
    ssh_authorized_keys: [fixture-public-key]
network:
  version: 2
  wifis:
    wlan0:
      dhcp4: true
      access-points:
        fixture-ssid:
          password: fixture-wifi-secret
write_files:
  - path: /etc/fixture-network
    content: fixture-existing-content
runcmd:
  - [echo, existing-command]
`

describe("Pi boot staging", () => {
	let temp: string
	let boot: string
	let bundle: string

	beforeEach(() => {
		temp = mkdtempSync(join(tmpdir(), "wavekit-pi-staging-"))
		boot = join(temp, "bootfs")
		bundle = join(temp, "bundle")
		mkdirSync(boot)
		mkdirSync(bundle)
		for (const name of ["config.txt", "cmdline.txt"])
			writeFileSync(join(boot, name), "fixture\n")
		writeFileSync(join(boot, "user-data"), fixture)
		for (const name of [
			"IMAGE.txt",
			"wavekit-sdr-host-image.tar.gz",
			"docker-compose.yml",
			"install-docker.sh",
			"setup.sh",
			".env.example",
		])
			writeFileSync(join(bundle, name), "fixture\n")
	})

	afterEach(() => rmSync(temp, { recursive: true, force: true }))

	function stage(...args: string[]) {
		return spawnSync(
			process.execPath,
			[script, "--boot", boot, "--bundle", bundle, ...args],
			{ encoding: "utf8" },
		)
	}

	function publicKey() {
		const path = join(temp, "identity")
		const generated = spawnSync("ssh-keygen", [
			"-q",
			"-t",
			"ed25519",
			"-N",
			"",
			"-C",
			"private-local-comment",
			"-f",
			path,
		])
		expect(generated.status).toBe(0)
		return `${path}.pub`
	}

	it("adds a validated public key once, preserves account policy and excludes its comment", () => {
		const path = publicKey()
		for (let i = 0; i < 2; i++)
			expect(stage("--ssh-public-key", path).status).toBe(0)
		const staged = parse(readFileSync(join(boot, "user-data"), "utf8"))
		const key = readFileSync(path, "utf8")
			.trim()
			.split(" ")
			.slice(0, 2)
			.join(" ")
		expect(staged.users[0]).toEqual({
			...parse(fixture).users[0],
			ssh_authorized_keys: ["fixture-public-key", key],
		})
		expect(staged.network).toEqual(parse(fixture).network)
		expect(staged.ssh_pwauth).toBeUndefined()
		expect(readFileSync(join(boot, "user-data"), "utf8")).not.toContain(
			"private-local-comment",
		)
	})

	it("validates public-key staging without modifying the card in dry-run mode", () => {
		expect(stage("--ssh-public-key", publicKey(), "--dry-run").status).toBe(0)
		expect(readFileSync(join(boot, "user-data"), "utf8")).toBe(fixture)
		expect(existsSync(join(boot, "wavekit-pi-bundle"))).toBe(false)
	})

	it("rejects private keys without printing or staging them", () => {
		const path = publicKey().replace(/\.pub$/, "")
		const result = stage("--ssh-public-key", path)
		expect(result.status).toBe(1)
		expect(result.stderr).not.toContain("BEGIN OPENSSH PRIVATE KEY")
		expect(readFileSync(join(boot, "user-data"), "utf8")).toBe(fixture)
		expect(existsSync(join(boot, "wavekit-pi-bundle"))).toBe(false)
	})

	it.each([
		"ssh-ed25519 ZmFrZQ==",
		"command=evil ssh-ed25519 ZmFrZQ==",
		"ssh-ed25519 ZmFrZQ==\nssh-ed25519 ZmFrZQ==",
	])("rejects malformed or ambiguous key input %s", key => {
		const path = join(temp, "bad.pub")
		writeFileSync(path, key)
		expect(stage("--ssh-public-key", path).status).toBe(1)
		expect(readFileSync(join(boot, "user-data"), "utf8")).toBe(fixture)
	})

	it("refuses to attach a key to an unresolved default account", () => {
		const config = "#cloud-config\nusers: [default]\n"
		writeFileSync(join(boot, "user-data"), config)
		expect(stage("--user", "ben", "--ssh-public-key", publicKey()).status).toBe(
			1,
		)
		expect(readFileSync(join(boot, "user-data"), "utf8")).toBe(config)
	})

	it("preserves Imager login/Wi-Fi and existing commands while adding a valid bootstrap", () => {
		const result = stage()
		expect(result.status).toBe(0)
		expect(result.stdout + result.stderr).not.toMatch(
			/fixture-login-secret|fixture-wifi-secret/,
		)
		const content = readFileSync(join(boot, "user-data"), "utf8")
		expect(content).toContain("# Imager settings must survive staging.")
		const original = parse(fixture)
		const staged = parse(content)
		for (const name of ["hostname", "users", "network"])
			expect(staged[name]).toEqual(original[name])
		expect(staged.write_files[0]).toEqual(original.write_files[0])
		expect(staged.runcmd[0]).toEqual(original.runcmd[0])
		expect(staged.runcmd[1]).toEqual(["/usr/local/sbin/wavekit-firstboot"])
		expect(existsSync(join(boot, "wavekit-pi-bundle", "setup.sh"))).toBe(true)
		const bootstrap = staged.write_files[1].content
		expect(bootstrap).toContain("TASK_USER='ben'")
		expect(bootstrap).toContain('bash ./setup.sh --target-user "$TASK_USER"')
		expect(bootstrap).not.toContain("sudo -n")
		const bootstrapFile = join(temp, "bootstrap.sh")
		writeFileSync(bootstrapFile, bootstrap)
		expect(spawnSync("bash", ["-n", bootstrapFile]).status).toBe(0)
	})

	it("stages idempotently without adding a second file or command", () => {
		expect(stage().status).toBe(0)
		expect(stage().status).toBe(0)
		const staged = parse(readFileSync(join(boot, "user-data"), "utf8"))
		expect(staged.write_files).toHaveLength(2)
		expect(staged.runcmd).toHaveLength(2)
	})

	it("generates the same root bootstrap for recovery without writing boot metadata", () => {
		const output = join(temp, "recovery.sh")
		const result = spawnSync(
			process.execPath,
			[script, "--bootstrap-out", output, "--user", "ben"],
			{ encoding: "utf8" },
		)
		expect(result.status).toBe(0)
		expect(readFileSync(output, "utf8")).toContain(
			'bash ./setup.sh --target-user "$TASK_USER"',
		)
		expect(spawnSync("bash", ["-n", output]).status).toBe(0)
		expect(readFileSync(join(boot, "user-data"), "utf8")).toBe(fixture)
	})

	it("makes no changes in dry-run mode", () => {
		expect(stage("--dry-run").status).toBe(0)
		expect(readFileSync(join(boot, "user-data"), "utf8")).toBe(fixture)
		expect(existsSync(join(boot, "wavekit-pi-bundle"))).toBe(false)
	})

	it("requires an explicit user when multiple normal users exist", () => {
		writeFileSync(
			join(boot, "user-data"),
			"#cloud-config\nusers:\n  - name: ben\n  - name: another\n",
		)
		expect(stage().status).toBe(1)
		expect(stage("--user", "ben").status).toBe(0)
	})

	it("never guesses the name of an unresolved default user", () => {
		writeFileSync(join(boot, "user-data"), "#cloud-config\nusers: [default]\n")
		expect(stage().status).toBe(1)
		expect(stage("--user", "ben").status).toBe(0)
	})

	it("resolves an explicitly named cloud-init default user", () => {
		writeFileSync(
			join(boot, "user-data"),
			"#cloud-config\nusers: [default]\nsystem_info:\n  default_user:\n    name: ben\n",
		)
		expect(stage().status).toBe(0)
	})

	it("rejects root and a user inconsistent with Imager settings", () => {
		expect(stage("--user", "root").status).toBe(1)
		expect(stage("--user", "somebody").status).toBe(1)
		expect(readFileSync(join(boot, "user-data"), "utf8")).toBe(fixture)
	})

	it("rejects malformed YAML without printing its secret content", () => {
		const malformed = "#cloud-config\nnetwork: [fixture-wifi-secret\n"
		writeFileSync(join(boot, "user-data"), malformed)
		const result = stage()
		expect(result.status).toBe(1)
		expect(result.stdout + result.stderr).not.toContain("fixture-wifi-secret")
		expect(readFileSync(join(boot, "user-data"), "utf8")).toBe(malformed)
	})

	it("rejects an unrecognized boot directory before copying anything", () => {
		rmSync(join(boot, "config.txt"))
		expect(stage().status).toBe(1)
		expect(existsSync(join(boot, "wavekit-pi-bundle"))).toBe(false)
	})
})

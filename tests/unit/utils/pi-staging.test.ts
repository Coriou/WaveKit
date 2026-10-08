import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { spawnSync } from "node:child_process"
import { createHash, generateKeyPairSync } from "node:crypto"
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
	mkdirSync,
	symlinkSync,
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

// Every test spawns real subprocesses (node/bash); their wall time scales with
// host load and suite parallelism, so allow headroom beyond the 5 s default.
describe("Pi boot staging", { timeout: 15000 }, () => {
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
		const files = [
			"IMAGE.txt",
			"wavekit-sdr-host-image.tar.gz",
			"docker-compose.yml",
			"install-docker.sh",
			"setup.sh",
			".env.example",
		]
		for (const name of files) writeFileSync(join(bundle, name), "fixture\n")
		writeFileSync(
			join(bundle, "SHA256SUMS"),
			files
				.map(
					name =>
						`${createHash("sha256").update("fixture\n").digest("hex")}  ${name}\n`,
				)
				.join(""),
		)
	})

	afterEach(() => rmSync(temp, { recursive: true, force: true }))

	function stage(...args: string[]) {
		return spawnSync(
			process.execPath,
			[script, "--boot", boot, "--bundle", bundle, ...args],
			{ encoding: "utf8" },
		)
	}

	it("rejects corrupted payload before touching the card", () => {
		writeFileSync(join(bundle, "setup.sh"), "corrupted")
		const result = stage()
		expect(result.status).toBe(1)
		expect(result.stderr).toContain("checksum mismatch: setup.sh")
		expect(readFileSync(join(boot, "user-data"), "utf8")).toBe(fixture)
		expect(existsSync(join(boot, "wavekit-pi-bundle"))).toBe(false)
	})

	it("requires checksums for every payload file", () => {
		writeFileSync(join(bundle, "SHA256SUMS"), "")
		expect(stage("--dry-run").status).toBe(1)
		expect(existsSync(join(boot, "wavekit-pi-bundle"))).toBe(false)
	})

	function publicKey(
		kind: "ed25519" | "rsa" | "nistp256" | "nistp384" | "nistp521" = "ed25519",
	) {
		const path = join(temp, "identity")
		const pair =
			kind === "ed25519"
				? generateKeyPairSync("ed25519")
				: kind === "rsa"
					? generateKeyPairSync("rsa", { modulusLength: 2048 })
					: generateKeyPairSync("ec", {
							namedCurve: {
								nistp256: "prime256v1",
								nistp384: "secp384r1",
								nistp521: "secp521r1",
							}[kind],
						})
		const jwk = pair.publicKey.export({ format: "jwk" })
		const field = (value: Buffer) => {
			const size = Buffer.alloc(4)
			size.writeUInt32BE(value.length)
			return Buffer.concat([size, value])
		}
		const type =
			kind === "ed25519"
				? "ssh-ed25519"
				: kind === "rsa"
					? "ssh-rsa"
					: `ecdsa-sha2-${kind}`
		const positive = (encoded: string) => {
			const value = Buffer.from(encoded, "base64url")
			return field(
				value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value,
			)
		}
		const fields =
			kind === "ed25519"
				? [field(Buffer.from(jwk.x!, "base64url"))]
				: kind === "rsa"
					? [positive(jwk.e!), positive(jwk.n!)]
					: [
							field(Buffer.from(kind)),
							field(
								Buffer.concat([
									Buffer.from([4]),
									Buffer.from(jwk.x!, "base64url"),
									Buffer.from(jwk.y!, "base64url"),
								]),
							),
						]
		const blob = Buffer.concat([field(Buffer.from(type)), ...fields])
		writeFileSync(
			`${path}.pub`,
			`${type} ${blob.toString("base64")} private-local-comment\n`,
		)
		writeFileSync(
			path,
			pair.privateKey.export({ format: "pem", type: "pkcs8" }),
		)
		return `${path}.pub`
	}

	it.each(["rsa", "nistp256", "nistp384", "nistp521"] as const)(
		"validates %s public keys",
		kind => {
			expect(stage("--ssh-public-key", publicKey(kind)).status).toBe(0)
		},
	)

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

	it("replaces payload symlinks safely and preserves existing bundle settings", () => {
		expect(stage().status).toBe(0)
		const destination = join(boot, "wavekit-pi-bundle")
		const outside = join(temp, "outside.sh")
		writeFileSync(outside, "must survive\n")
		rmSync(join(destination, "setup.sh"))
		symlinkSync(outside, join(destination, "setup.sh"))
		writeFileSync(join(destination, ".env"), "CUSTOM_SETTING=42\n")
		expect(stage().status).toBe(0)
		expect(readFileSync(outside, "utf8")).toBe("must survive\n")
		expect(readFileSync(join(destination, "setup.sh"), "utf8")).toBe(
			"fixture\n",
		)
		expect(readFileSync(join(destination, ".env"), "utf8")).toBe(
			"CUSTOM_SETTING=42\n",
		)
	})

	it("ignores a preexisting predictable temporary symlink", () => {
		const outside = join(temp, "outside")
		writeFileSync(outside, "must survive\n")
		symlinkSync(outside, join(boot, ".wavekit-user-data.tmp"))
		expect(stage().status).toBe(0)
		expect(readFileSync(outside, "utf8")).toBe("must survive\n")
	})

	it("materializes source payload symlinks so the staged card is self-contained", () => {
		const archive = join(bundle, "wavekit-sdr-host-image.tar.gz")
		const outside = join(temp, "archive")
		writeFileSync(outside, "fixture\n")
		rmSync(archive)
		symlinkSync(outside, archive)
		const result = stage()
		expect(result.status, result.stderr).toBe(0)
		rmSync(outside)
		expect(
			readFileSync(
				join(boot, "wavekit-pi-bundle", "wavekit-sdr-host-image.tar.gz"),
				"utf8",
			),
		).toBe("fixture\n")
	})

	it("rejects a symlink bundle destination even in dry-run", () => {
		symlinkSync(bundle, join(boot, "wavekit-pi-bundle"))
		expect(stage("--dry-run").status).toBe(1)
		expect(readFileSync(join(boot, "user-data"), "utf8")).toBe(fixture)
	})

	it("keeps the staged bundle and Imager config intact when preparing a replacement fails", () => {
		expect(stage().status).toBe(0)
		const content = readFileSync(join(boot, "user-data"), "utf8")
		const destination = join(boot, "wavekit-pi-bundle")
		writeFileSync(join(destination, ".env"), "CUSTOM_SETTING=42\n")
		// An invalid optional documentation file fails during preparation.
		mkdirSync(join(bundle, "README.txt"))
		expect(stage().status).toBe(1)
		expect(readFileSync(join(boot, "user-data"), "utf8")).toBe(content)
		expect(readFileSync(join(destination, "setup.sh"), "utf8")).toBe(
			"fixture\n",
		)
		expect(readFileSync(join(destination, ".env"), "utf8")).toBe(
			"CUSTOM_SETTING=42\n",
		)
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

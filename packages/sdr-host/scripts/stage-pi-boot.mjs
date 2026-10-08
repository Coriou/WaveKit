#!/usr/bin/env node
// Add WaveKit installation to Imager's cloud-config without changing login/Wi-Fi.
import {
	cpSync,
	createReadStream,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { createHash, createPublicKey } from "node:crypto"
import { isMap, isSeq, parseDocument } from "yaml"

const bootstrapPath = "/usr/local/sbin/wavekit-firstboot"
const bootstrapMarker = "# WaveKit first-boot installer"
const bundleFiles = [
	"IMAGE.txt",
	"wavekit-sdr-host-image.tar.gz",
	"docker-compose.yml",
	"install-docker.sh",
	"setup.sh",
	".env.example",
]

async function verifyBundle(bundle) {
	const manifestPath = join(bundle, "SHA256SUMS")
	if (!existsSync(manifestPath))
		fail("Bundle checksum manifest missing; rebuild with make sdr-host-bundle.")
	const entries = readFileSync(manifestPath, "utf8").trim().split(/\r?\n/)
	const expected = new Map()
	for (const line of entries) {
		const match = /^([a-f0-9]{64})  (.+)$/.exec(line)
		if (!match || !bundleFiles.includes(match[2]) || expected.has(match[2]))
			fail("Invalid bundle checksum manifest; rebuild the bundle.")
		expected.set(match[2], match[1])
	}
	for (const name of bundleFiles) {
		const hash = createHash("sha256")
		for await (const chunk of createReadStream(join(bundle, name)))
			hash.update(chunk)
		const digest = hash.digest("hex")
		if (expected.get(name) !== digest)
			fail(`Bundle checksum mismatch: ${name}; rebuild the bundle.`)
	}
}

function fail(message) {
	throw new Error(message)
}

function resolveUser(config, requestedUser) {
	const candidates = new Set()
	function add(user) {
		if (typeof user === "string" && user !== "default") candidates.add(user)
		else if (
			user &&
			typeof user === "object" &&
			!user.system &&
			typeof user.name === "string"
		)
			candidates.add(user.name)
	}
	if (Array.isArray(config.users)) config.users.forEach(add)
	add(config.user)
	if (
		(Array.isArray(config.users) && config.users.includes("default")) ||
		config.user === "default"
	)
		add(config.system_info?.default_user)
	candidates.delete("root")
	let selected = requestedUser
	if (!selected) {
		if (candidates.size !== 1)
			fail(
				"Cannot determine one configured normal user. Supply --user with the username chosen in Imager.",
			)
		selected = [...candidates][0]
	} else if (candidates.size && !candidates.has(selected)) {
		fail("--user does not match a configured normal user in user-data.")
	}
	if (
		!/^[a-z_][a-z0-9_-]{0,31}$/.test(selected) ||
		["root", "default"].includes(selected)
	)
		fail("Use a valid normal Linux username, not root/default.")
	return selected
}

function bootstrap(user) {
	return `#!/usr/bin/env bash
${bootstrapMarker}
set -euo pipefail
TASK_USER='${user}'
if [ "$(id -u)" -ne 0 ]; then
  echo "Run the first-boot bootstrap as root; manual setup.sh can also run as your normal user."
  exit 1
fi
LOG=/var/log/wavekit-firstboot.log
mkdir -p /var/lib/wavekit
exec >> "$LOG" 2>&1
BOOT=''
for candidate in /boot/firmware /boot; do
  if [ -d "$candidate/wavekit-pi-bundle" ]; then BOOT="$candidate"; break; fi
done
if [ -z "$BOOT" ]; then
  echo "WaveKit bundle missing from boot partition; copy it and run setup.sh manually."
  exit 1
fi
write_status() { printf '%s %s\\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" > "$BOOT/wavekit-setup.status"; }
failed() {
  code="$1"
  trap - ERR
  echo "WaveKit first-boot setup failed (exit $code); see /var/log/wavekit-firstboot.log."
  write_status failed || true
  cp "$LOG" "$BOOT/wavekit-setup.log" || true
  exit "$code"
}
trap 'failed "$?"' ERR
if [ -f /var/lib/wavekit/firstboot.done ]; then write_status complete; exit 0; fi
write_status running
echo "Starting WaveKit first-boot setup."
if ! id "$TASK_USER" >/dev/null 2>&1 || [ "$(id -u "$TASK_USER")" -eq 0 ]; then
  echo "Configured normal user does not exist; verify Imager user settings."
  failed 1
fi
TASK_HOME="$(getent passwd "$TASK_USER" | cut -d: -f6)"
if [ -z "$TASK_HOME" ] || [ "$TASK_HOME" = / ] || [ "$TASK_HOME" = /root ] || [[ "$TASK_HOME" != /* ]]; then
  echo "Configured user has an unsuitable home directory."
  failed 1
fi
DEST="$TASK_HOME/wavekit-pi-bundle"
mkdir -p "$DEST"
cp -a "$BOOT/wavekit-pi-bundle/." "$DEST/"
chown -R "$TASK_USER:$(id -gn "$TASK_USER")" "$DEST"
# cloud-init already runs as root; preserve the user's existing sudo policy.
(cd "$DEST"; bash ./setup.sh --target-user "$TASK_USER")
touch /var/lib/wavekit/firstboot.done
echo "WaveKit first-boot setup complete; verify /health with the dongle attached."
write_status complete
cp "$LOG" "$BOOT/wavekit-setup.log"
`
}

function sequence(doc, name) {
	let node = doc.get(name, true)
	if (!node) {
		node = doc.createNode([])
		doc.set(name, node)
	}
	if (!isSeq(node))
		fail(
			`${name} must be a YAML sequence; staging stopped without changing user-data.`,
		)
	return node
}

function addPublicKey(doc, user, path) {
	if (!statSync(path).isFile() || statSync(path).size > 16384)
		fail("--ssh-public-key must be a small OpenSSH public-key file.")
	const text = readFileSync(path, "utf8").trim()
	if (
		!/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: [^\r\n]*)?$/.test(
			text,
		)
	)
		fail(
			"Supply one OpenSSH public key, never a private key or authorized_keys options.",
		)
	try {
		const [type, encoded] = text.split(" ")
		const blob = Buffer.from(encoded, "base64")
		let offset = 0
		const field = () => {
			const length = blob.readUInt32BE(offset)
			offset += 4
			if (length > blob.length - offset) throw new Error("Truncated key")
			const value = blob.subarray(offset, offset + length)
			offset += length
			return value
		}
		if (field().toString() !== type) throw new Error("Key type mismatch")
		let jwk
		if (type === "ssh-ed25519") {
			const key = field()
			if (key.length !== 32) throw new Error("Invalid Ed25519 key")
			jwk = { kty: "OKP", crv: "Ed25519", x: key.toString("base64url") }
		} else if (type === "ssh-rsa") {
			const integer = () => {
				let bytes = field()
				if (!bytes.length || bytes[0] & 0x80)
					throw new Error("Invalid RSA integer")
				while (bytes.length > 1 && bytes[0] === 0) bytes = bytes.subarray(1)
				if (bytes.length === 1 && bytes[0] === 0)
					throw new Error("Zero RSA integer")
				return bytes.toString("base64url")
			}
			jwk = { kty: "RSA", e: integer(), n: integer() }
		} else {
			const curve = field().toString()
			const curves = {
				nistp256: ["P-256", 32],
				nistp384: ["P-384", 48],
				nistp521: ["P-521", 66],
			}
			const spec = curves[curve]
			if (!spec || type !== `ecdsa-sha2-${curve}`)
				throw new Error("Invalid curve")
			const point = field(),
				[crv, size] = spec
			if (point[0] !== 4 || point.length !== 1 + size * 2)
				throw new Error("Invalid EC point")
			jwk = {
				kty: "EC",
				crv,
				x: point.subarray(1, 1 + size).toString("base64url"),
				y: point.subarray(1 + size).toString("base64url"),
			}
		}
		if (offset !== blob.length) throw new Error("Trailing key data")
		createPublicKey({ key: jwk, format: "jwk" })
	} catch {
		fail("Invalid OpenSSH public-key data.")
	}
	// Strip the optional local username/hostname comment from the staged key.
	const key = text.split(" ").slice(0, 2).join(" ")
	const users = doc.get("users", true)
	let target = isSeq(users)
		? users.items.find(node => isMap(node) && node.get("name") === user)
		: undefined
	const single = doc.get("user", true)
	if (!target && isMap(single) && single.get("name") === user) target = single
	if (!target)
		fail(
			"Key staging needs an explicit user mapping in Imager user-data; configure SSH public-key access in Imager instead.",
		)
	let keys = target.get("ssh_authorized_keys", true)
	if (!keys) {
		keys = doc.createNode([])
		target.set("ssh_authorized_keys", keys)
	}
	if (!isSeq(keys)) fail("ssh_authorized_keys must be a YAML sequence.")
	if (
		!keys.items.some(
			node =>
				typeof node?.value === "string" &&
				node.value.trim().split(/\s+/).slice(0, 2).join(" ") === key,
		)
	)
		keys.add(key)
}

async function main() {
	const args = process.argv.slice(2)
	let bootPath,
		user,
		publicKeyPath,
		bootstrapOutput,
		dryRun = false
	let bundle = fileURLToPath(
		new URL("../../../output/pi-bundle", import.meta.url),
	)
	for (let i = 0; i < args.length; i++) {
		const arg = args[i]
		if (arg === "--help" || arg === "-h") {
			console.log(
				"Usage: node packages/sdr-host/scripts/stage-pi-boot.mjs --boot <mounted-bootfs> [--bundle <dir>] [--user <Imager-user>] [--ssh-public-key <file.pub>] [--dry-run]\nOr: --bootstrap-out <file> --user <Imager-user> to generate the bootstrap for an existing Pi.\nCopies the bundle and appends a cloud-init first-boot installer. Never erases or flashes a disk.",
			)
			return
		}
		if (arg === "--dry-run") {
			dryRun = true
			continue
		}
		if (
			![
				"--boot",
				"--bundle",
				"--user",
				"--bootstrap-out",
				"--ssh-public-key",
			].includes(arg) ||
			!args[i + 1] ||
			args[i + 1].startsWith("--")
		)
			fail(
				"Supply explicit --boot and valid option values; use --help for usage.",
			)
		const value = args[++i]
		if (arg === "--boot") bootPath = value
		else if (arg === "--bundle") bundle = value
		else if (arg === "--bootstrap-out") bootstrapOutput = value
		else if (arg === "--ssh-public-key") publicKeyPath = value
		else user = value
	}
	if (bootstrapOutput) {
		if (!user || bootPath || dryRun || publicKeyPath)
			fail(
				"Bootstrap generation requires --user and cannot be combined with --boot/--dry-run.",
			)
		writeFileSync(bootstrapOutput, bootstrap(resolveUser({}, user)), {
			mode: 0o755,
		})
		console.log(
			`[wavekit] Bootstrap generated at ${bootstrapOutput}; run it as root on the configured Pi.`,
		)
		return
	}
	if (!bootPath)
		fail("--boot is required; the helper never guesses a disk or boot mount.")
	const boot = realpathSync(bootPath)
	for (const name of ["config.txt", "cmdline.txt", "user-data"]) {
		if (!existsSync(join(boot, name)) || !lstatSync(join(boot, name)).isFile())
			fail(`Expected Raspberry Pi boot file missing: ${name}`)
	}
	const destination = join(boot, "wavekit-pi-bundle")
	const destinationStat = lstatSync(destination, { throwIfNoEntry: false })
	const existingBundle = Boolean(destinationStat)
	if (existingBundle && !destinationStat.isDirectory())
		fail(
			"Existing wavekit-pi-bundle must be a directory, not a symlink or file.",
		)
	for (const name of bundleFiles) {
		if (
			!existsSync(join(bundle, name)) ||
			!statSync(join(bundle, name)).isFile()
		)
			fail(
				`Bundle incomplete: ${name}; create it with make sdr-host-bundle first.`,
			)
	}
	await verifyBundle(bundle)
	const configPath = join(boot, "user-data")
	const content = readFileSync(configPath, "utf8")
	if (!/^#cloud-config\s*(?:\r?\n|$)/.test(content))
		fail(
			"user-data must begin with #cloud-config; this helper requires Imager cloudinit-rpi output.",
		)
	const doc = parseDocument(content)
	if (doc.errors.length || !isMap(doc.contents))
		fail(
			"user-data is not valid cloud-config YAML; staging stopped without printing its contents.",
		)
	const selectedUser = resolveUser(doc.toJS(), user)
	if (publicKeyPath)
		addPublicKey(doc, selectedUser, realpathSync(publicKeyPath))
	const files = sequence(doc, "write_files")
	const oldFile = files.items.find(
		node => isMap(node) && node.get("path") === bootstrapPath,
	)
	if (
		oldFile &&
		!String(oldFile.get("content") || "").includes(bootstrapMarker)
	)
		fail(
			"A different installer already occupies the bootstrap path; staging stopped.",
		)
	if (oldFile) files.items.splice(files.items.indexOf(oldFile), 1)
	files.add(
		doc.createNode({
			path: bootstrapPath,
			owner: "root:root",
			permissions: "0755",
			content: bootstrap(selectedUser),
		}),
	)
	const commands = sequence(doc, "runcmd")
	if (
		!commands.items.some(
			node =>
				isSeq(node) &&
				node.items.length === 1 &&
				node.items[0]?.value === bootstrapPath,
		)
	)
		commands.add(doc.createNode([bootstrapPath]))
	if (!dryRun) {
		// Prepare and verify away from the live files. Never follow an existing
		// payload symlink when replacing files, or reuse a predictable temp file.
		const staging = mkdtempSync(join(boot, ".wavekit-stage-"))
		const replacement = join(staging, "bundle")
		const previous = join(staging, "previous")
		let savedPrevious = false
		let installedReplacement = false
		let cleanStaging = true
		try {
			const managedFiles = [...bundleFiles, "SHA256SUMS", "README.txt"]
			mkdirSync(replacement)
			if (existingBundle) {
				for (const name of readdirSync(destination)) {
					if (managedFiles.includes(name)) continue
					cpSync(join(destination, name), join(replacement, name), {
						recursive: true,
					})
				}
			}
			// Copy each payload once, including the large image archive. Source
			// symlinks are materialized so the card is independent of the builder.
			for (const name of managedFiles) {
				if (!existsSync(join(bundle, name))) continue
				cpSync(realpathSync(join(bundle, name)), join(replacement, name), {
					dereference: true,
				})
			}
			await verifyBundle(replacement)
			const temporary = join(staging, "user-data")
			writeFileSync(temporary, String(doc), { mode: 0o600, flag: "wx" })
			if (existingBundle) {
				renameSync(destination, previous)
				savedPrevious = true
			}
			renameSync(replacement, destination)
			installedReplacement = true
			renameSync(temporary, configPath)
		} catch (error) {
			// If rollback itself fails, retain the backup for manual recovery.
			cleanStaging = false
			if (installedReplacement)
				rmSync(destination, { recursive: true, force: true })
			if (savedPrevious) renameSync(previous, destination)
			cleanStaging = true
			throw error
		} finally {
			if (cleanStaging) rmSync(staging, { recursive: true, force: true })
		}
	}
	console.log(
		`[wavekit] ${dryRun ? "Validated staging" : "Staged first-boot installation"} for ${selectedUser} at ${boot}.`,
	)
	console.log(
		"[wavekit] Imager login and network settings retained. Boot status: wavekit-setup.status; log: wavekit-setup.log.",
	)
}

try {
	await main()
} catch (error) {
	console.error(`[wavekit] ${error.message}`)
	process.exitCode = 1
}

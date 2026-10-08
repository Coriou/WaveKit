#!/usr/bin/env node
// Launch the dedicated WaveKit catalog; Imager owns device selection and writing.
import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { homedir } from "node:os"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
let manifest
let dryRun = false
let executable
try {
	const args = process.argv.slice(2)
	while (args.length) {
		const arg = args.shift()
		if (arg === "--manifest" && args[0] && !args[0].startsWith("--"))
			manifest = resolve(args.shift())
		else if (arg === "--executable" && args[0] && !args[0].startsWith("--"))
			executable = resolve(args.shift())
		else if (arg === "--dry-run") dryRun = true
		else if (arg === "--help" || arg === "-h") {
			console.log(
				"Usage: node packages/sdr-host/scripts/open-pi-imager.mjs [--manifest PATH] [--executable PATH] [--dry-run]",
			)
			process.exit(0)
		} else throw new Error(`Unknown or incomplete argument: ${arg}`)
	}
	if (!manifest) {
		const pointer = resolve(root, "output/pi-image-current.json")
		if (existsSync(pointer)) {
			const current = JSON.parse(readFileSync(pointer, "utf8"))
			if (typeof current.manifest !== "string" || !current.manifest.trim())
				throw new Error("Current WaveKit image selection is invalid.")
			manifest = resolve(dirname(pointer), current.manifest)
		} else manifest = resolve(root, "output/pi-image/os-list.json")
	}
	if (!existsSync(manifest))
		throw new Error(
			"WaveKit image catalog is missing. Build the SD image first with make sdr-host-image, or pass --manifest PATH to a downloaded catalog.",
		)
	const catalog = JSON.parse(readFileSync(manifest, "utf8"))
	if (!Array.isArray(catalog.os_list) || catalog.os_list.length !== 1)
		throw new Error(
			"Expected a dedicated catalog containing exactly one WaveKit image.",
		)
	const entry = catalog.os_list[0]
	if (
		!/^WaveKit\b/i.test(entry.name ?? "") ||
		entry.init_format !== "cloudinit-rpi"
	)
		throw new Error(
			"Catalog must identify WaveKit and retain cloudinit-rpi customization.",
		)
	const imageUrl = new URL(entry.url)
	if (imageUrl.protocol === "file:") {
		if (!existsSync(fileURLToPath(imageUrl)))
			throw new Error("The catalog's local image file is missing.")
	} else if (imageUrl.protocol !== "https:") {
		throw new Error("Image URL must use HTTPS or a local file URL.")
	}
	if (!/^[a-f0-9]{64}$/i.test(entry.extract_sha256 ?? ""))
		throw new Error("Catalog is missing the image verification checksum.")
	// Run Imager itself so startup errors and crashes reach the terminal.
	// LaunchServices accepting an `open` request does not prove a window opened.
	const command =
		executable ??
		(process.platform === "darwin"
			? [
					"/Applications/Raspberry Pi Imager.app/Contents/MacOS/rpi-imager",
					resolve(
						homedir(),
						"Applications/Raspberry Pi Imager.app/Contents/MacOS/rpi-imager",
					),
				].find(existsSync)
			: "rpi-imager")
	if (!command)
		throw new Error(
			"Raspberry Pi Imager was not found. Install Imager 2 or pass --executable PATH.",
		)
	// Imager expects a filesystem path for local catalogs, not a file:// URL.
	const launchArgs = ["--repo", manifest]
	if (dryRun) {
		console.log(JSON.stringify({ command, args: launchArgs }))
	} else {
		console.log(
			"Starting Imager with the WaveKit catalog; startup diagnostics appear here. Keep this terminal open until Imager closes. A process start does not confirm a visible window or a verified SD write.",
		)
		const child = spawn(command, launchArgs, { stdio: "inherit" })
		child.on("error", error => {
			console.error(
				`Cannot launch Raspberry Pi Imager: ${error.message}. Install Imager and retry.`,
			)
			process.exitCode = 1
		})
		child.on("spawn", () => {
			console.log(
				`Imager process started (PID ${child.pid}). Confirm the window shows WaveKit and offers Wi-Fi/account/SSH customization before writing.`,
			)
		})
		child.on("exit", (code, signal) => {
			if (signal || code !== 0)
				console.error(
					`Imager failed (${signal ? `signal ${signal}` : `exit ${code}`}). Check the diagnostics above; GUI launch and SD acceptance are unverified.`,
				)
			else
				console.log(
					"Imager exited. This exit status does not verify a window appeared or an SD write completed.",
				)
			process.exitCode = signal ? 1 : (code ?? 1)
		})
	}
} catch (error) {
	console.error(`[wavekit] ${error.message}`)
	process.exitCode = 1
}

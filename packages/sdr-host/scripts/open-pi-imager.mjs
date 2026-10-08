#!/usr/bin/env node
// Launch the dedicated WaveKit catalog; Imager owns device selection and writing.
import { readFileSync, existsSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { spawn } from "node:child_process"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
let manifest = resolve(root, "output/pi-image/os-list.json")
let dryRun = false
try {
	const args = process.argv.slice(2)
	while (args.length) {
		const arg = args.shift()
		if (arg === "--manifest" && args[0] && !args[0].startsWith("--"))
			manifest = resolve(args.shift())
		else if (arg === "--dry-run") dryRun = true
		else if (arg === "--help" || arg === "-h") {
			console.log(
				"Usage: node packages/sdr-host/scripts/open-pi-imager.mjs [--manifest PATH] [--dry-run]",
			)
			process.exit(0)
		} else throw new Error(`Unknown or incomplete argument: ${arg}`)
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
	const repoUrl = pathToFileURL(manifest).href
	const command = process.platform === "darwin" ? "open" : "rpi-imager"
	const launchArgs =
		process.platform === "darwin"
			? ["-n", "-a", "Raspberry Pi Imager", "--args", "--repo", repoUrl]
			: ["--repo", repoUrl]
	if (dryRun) {
		console.log(JSON.stringify({ command, args: launchArgs }))
	} else {
		console.log(
			"Opening the WaveKit installer. Choose your Pi, SD card, Wi-Fi and SSH settings in Imager.",
		)
		const child = spawn(command, launchArgs, { stdio: "inherit" })
		child.on("error", error => {
			console.error(
				`Cannot launch Raspberry Pi Imager: ${error.message}. Install Imager and retry.`,
			)
			process.exitCode = 1
		})
		child.on("exit", code => {
			process.exitCode = code ?? 1
		})
	}
} catch (error) {
	console.error(`[wavekit] ${error.message}`)
	process.exitCode = 1
}

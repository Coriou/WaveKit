#!/usr/bin/env node
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, join } from "node:path"

function executable(name) {
	for (const directory of (process.env.PATH || "").split(delimiter)) {
		const candidate = join(directory || ".", name)
		try {
			accessSync(candidate, constants.X_OK)
			if (statSync(candidate).isFile()) return candidate
		} catch {
			// Continue searching PATH.
		}
	}
	return null
}

const requirements = {
	"Local API and dashboard": ["pnpm"],
	"USB RTL-SDR source": ["rtl_tcp"],
	"Live audio (FM/AM/SSB)": ["csdr"],
	"ISM sensors (rtl433, full-rate)": ["rtl_433"],
	"ISM sensors (rtl433, decimated)": ["csdr", "rtl_433"],
	"Pagers (multimon-ng)": ["csdr", "sox", "multimon-ng"],
	"Digital voice (dsd-fme)": ["csdr", "sox", "dsd-fme"],
	"ADS-B (readsb)": ["readsb"],
	"ACARS (acarsdec)": ["csdr", "sox", "acarsdec"],
	"VDL2 (dumpvdl2)": ["csdr", "dumpvdl2"],
	"AIS (AIS-catcher)": ["csdr", "AIS-catcher"],
	"APRS (direwolf)": ["csdr", "sox", "direwolf"],
	"LoRa/Meshtastic": ["csdr", "python3"],
}
const binaries = Object.fromEntries(
	[...new Set(Object.values(requirements).flat())].map(name => [
		name,
		executable(name),
	]),
)
const report = {
	platform: `${process.platform}/${process.arch}`,
	node: process.version,
	config:
		process.env.WAVEKIT_CONFIG || "config/default.yaml + config/custom.yaml",
	binaries,
	capabilities: Object.fromEntries(
		Object.entries(requirements).map(([name, required]) => [
			name,
			{ required, missing: required.filter(binary => !binaries[binary]) },
		]),
	),
}
if (process.argv.includes("--json")) {
	console.log(JSON.stringify(report, null, 2))
} else {
	console.log(`WaveKit on ${report.platform}, Node ${report.node}`)
	console.log(`Config: ${report.config}\n`)
	for (const [name, capability] of Object.entries(report.capabilities)) {
		console.log(
			`${name}: ${capability.missing.length ? `missing ${capability.missing.join(", ")}` : "binaries found"}`,
		)
	}
	console.log(
		"\nChecks locate executables only; hardware, versions, and Python/GNU Radio dependencies still need validation.",
	)
	console.log(
		"Full-rate rtl433 needs matching source, inputSampleRate, and targetSampleRate settings; see docs/LOCAL-SETUP.md.",
	)
	console.log(
		"Hardware-free startup: pnpm start:local. See docs/LOCAL-SETUP.md for local and Pi setup.",
	)
}

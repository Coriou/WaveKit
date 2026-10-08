#!/usr/bin/env node
import { spawn } from "node:child_process"

if (process.argv.includes("--help")) {
	console.log(`Launch native rtl_tcp on 127.0.0.1:1234 (USB RTL-SDR required).
Environment overrides:
  RTL_TCP_PORT         default 1234 (also update your source config)
  RTL_TCP_SAMPLE_RATE  default 2048000 (also update source caps)
  RTL_TCP_FREQUENCY    default 446524920 Hz
  RTL_TCP_GAIN         default 0 (automatic); manual gain in dB
  RTL_TCP_PPM          default 0
  RTL_TCP_DEVICE       default 0 (index or serial)
  RTL_TCP_BIN          default rtl_tcp (path to the executable)
Run pnpm start:rtl in another terminal. Ctrl-C stops rtl_tcp.`)
	process.exit(0)
}

function numberEnv(name, fallback, min, max, integer = true) {
	const raw = process.env[name] ?? String(fallback)
	const value = Number(raw)
	if (
		raw.trim() === "" ||
		!Number.isFinite(value) ||
		value < min ||
		value > max ||
		(integer && !Number.isInteger(value))
	) {
		console.error(
			`${name} must be ${integer ? "an integer" : "a number"} between ${min} and ${max}`,
		)
		process.exit(1)
	}
	return String(value)
}

const port = numberEnv("RTL_TCP_PORT", 1234, 1, 65535)
const args = [
	"-a",
	"127.0.0.1",
	"-p",
	port,
	"-s",
	numberEnv("RTL_TCP_SAMPLE_RATE", 2048000, 1, 3200000),
	"-f",
	numberEnv("RTL_TCP_FREQUENCY", 446524920, 1, 4294967295),
	"-g",
	numberEnv("RTL_TCP_GAIN", 0, 0, 100, false),
	"-P",
	numberEnv("RTL_TCP_PPM", 0, -200, 200),
	"-d",
	process.env.RTL_TCP_DEVICE || "0",
]
console.log(
	`[wavekit] Starting rtl_tcp on 127.0.0.1:${port}; connect with pnpm start:rtl`,
)
const child = spawn(process.env.RTL_TCP_BIN || "rtl_tcp", args, {
	stdio: "inherit",
})
child.on("error", error => {
	console.error(
		`Could not start rtl_tcp: ${error.message}. On macOS install it with brew install librtlsdr.`,
	)
	process.exitCode = 1
})
for (const signal of ["SIGINT", "SIGTERM"]) {
	process.on(signal, () => child.kill(signal))
}
child.on("exit", (code, signal) => {
	process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1)
})

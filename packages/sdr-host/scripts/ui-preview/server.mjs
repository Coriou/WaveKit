#!/usr/bin/env node
// Local preview of the Pi operator pages over simulated receivers. Serves ui/
// unchanged under /<scenario>/ with synthetic /api/status, /api/host and
// /api/setup payloads shaped like a real Pi's, so every page state can be
// opened and screenshotted without a Pi. Never deploys or contacts a Pi.
//
//   node packages/sdr-host/scripts/ui-preview.mjs [--port 8090]
//   open http://127.0.0.1:8090/            (index of scenarios)
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"

const UI = fileURLToPath(new URL("../ui/", import.meta.url))
const portArg = process.argv.indexOf("--port")
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 8090
const TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
}
const MB = 1_000_000
const startedAt = Date.now()

/** Receiver scenarios: overrides on a healthy, configured-rate receiver. */
const STATUS = {
	streaming: { label: "Sampling at the configured rate, one client, Wi-Fi" },
	"client-rate": {
		label: "A client set the rate (rate derived from bytes), recent dips",
		rate: 4.32 * MB,
		expected: null,
		dipEverySec: 31,
		dipsTotal: 865,
		serviceSec: 27_440,
		gapSec: 120,
	},
	low: {
		label: "Below rate, under-voltage now, a client dropping, warm SoC",
		rate: 2.6 * MB,
		rateStatus: "low",
		uvNow: true,
		dipEverySec: 9,
		dipsTotal: 41,
		temp: 72.4,
		cpu: 64,
		clients: [{ address: "192.168.1.20:53812", dropping: true }],
	},
	stalled: {
		label: "Samples stopped with dongle and processes present",
		sampling: "stale",
		stalledSec: 45,
	},
	"no-dongle": {
		label: "Dongle unplugged: rtl_tcp exits and restarts",
		sampling: "disconnected",
		reason: "rtl_tcp is not running",
		dongle: false,
		rtlTcp: false,
		stalledSec: 140,
		clients: [],
	},
	"zero-clients": { label: "Sampling, nobody connected", clients: [] },
	"multi-clients": {
		label: "Three clients, one falling behind",
		clients: [
			{ address: "192.168.1.20:53812" },
			{ address: "192.168.1.31:40122", dropping: true },
			{ address: "[fd00::5]:51000", minutes: 2 },
		],
	},
	ethernet: { label: "Wired link, no Wi-Fi", net: "ethernet" },
	"weak-wifi": { label: "Weak Wi-Fi signal", dbm: -78 },
	"fresh-start": {
		label: "Receiver service started 80 s ago (partial history)",
		serviceSec: 80,
		dipsTotal: 0,
	},
	setup: {
		label: "First-boot setup still installing; no samples yet",
		sampling: "stale",
		stalledSec: null,
		clients: [],
		setup: { state: "running", phase: "install", ageMs: 140_000 },
		serviceSec: 40,
	},
	"setup-failed": {
		label: "First-boot setup failed",
		sampling: "stale",
		stalledSec: null,
		clients: [],
		setup: { state: "failed", phase: "install", ageMs: 600_000, exitCode: 23 },
		serviceSec: 600,
	},
	"unexpected-reboot": {
		label:
			"Pi restarted without a shutdown 5 min ago, under-voltage at power-on",
		serviceSec: 260,
		hostSec: 300,
		reboot: "unexpected",
	},
	"old-receiver": {
		label: "Receiver without host history or boot report",
		noHistory: true,
	},
	unreachable: { label: "The Pi never answers", fail: "always" },
	lost: { label: "Contact lost after the first reading", fail: "after-first" },
}

const SETUP = {
	"boot-waiting": { label: "No progress record yet", record: null },
	"boot-cloud-init": {
		label: "Applying Imager settings",
		record: ["running", "cloud-init", 40],
	},
	"boot-install": {
		label: "Installing the receiver",
		record: ["running", "install", 89],
	},
	"boot-publish": { label: "Finishing", record: ["running", "publish", 12] },
	"boot-complete": {
		label: "Complete, status page not up yet",
		record: ["complete", "done", 30],
	},
	"boot-failed": {
		label: "Failed, stage unknown",
		record: ["failed", null, 200, 23],
	},
	"boot-failed-install": {
		label: "Failed during install",
		record: ["failed", "install", 200, 1],
	},
	"boot-interrupted": {
		label: "Interrupted by a restart",
		record: ["interrupted", "install", 900],
	},
	"boot-unavailable": {
		label: "Progress record unreadable",
		record: "unavailable",
	},
	"boot-lost": {
		label: "Contact lost after the first reading",
		record: ["running", "install", 60],
		fail: "after-first",
	},
}

const wave = (t, period, phase = 0) =>
	Math.sin((t / period) * 2 * Math.PI + phase)
const jitter = (t, salt) => {
	const x = Math.sin(t * 12.9898 + salt * 78.233) * 43758.5453
	return x - Math.floor(x)
}

function scenario(name) {
	return {
		rate: 4.096 * MB,
		expected: 4.096 * MB,
		rateStatus: "nominal",
		sampling: "streaming",
		reason: null,
		dongle: true,
		rtlTcp: true,
		uvNow: false,
		dipEverySec: null,
		dipsTotal: 0,
		temp: 51.3,
		cpu: 22,
		net: "wireless",
		dbm: -52,
		serviceSec: 9_000,
		clients: [{ address: "192.168.1.20:53812" }],
		setup: { state: "complete", phase: "done", ageMs: 86_400_000 },
		...STATUS[name],
	}
}

/** One history point per 2 s poll over five minutes, but never before the service started. */
function* ages(serviceSec) {
	for (let age = 0; age <= 300_000 && age / 1000 <= serviceSec; age += 2000)
		yield age
}

function status(name, now) {
	const s = scenario(name)
	const t = (now - startedAt) / 1000
	const service = s.serviceSec + t
	const flowing = s.sampling === "streaming"
	const upstream = flowing ? s.rate * (1 + 0.004 * wave(t, 7)) : 0
	const points = [...ages(service)].map(age => {
		const at = t - age / 1000
		const stalled = s.stalledSec != null && age / 1000 < s.stalledSec
		const missing = s.gapSec != null && Math.abs(age / 1000 - s.gapSec - 3) < 3
		const low = s.rateStatus === "low" ? 0.85 + 0.15 * wave(at, 40) : 1
		const v =
			s.stalledSec === null || stalled
				? 0
				: s.rate * low * (0.985 + 0.03 * jitter(Math.round(at / 2), 1))
		return [age, missing ? null : Math.round(v)]
	})
	const clients = s.clients.map((c, i) => {
		const rate = flowing ? upstream * (c.dropping ? 0.8 : 1) : 0
		const minutes = c.minutes ?? 58 - i * 7
		return {
			key: `63|${c.address}`,
			address: c.address,
			connectedAt: new Date(now - minutes * 60_000).toISOString(),
			queuedBytes: Math.round(rate * minutes * 60),
			queuedBytesPerSec: Math.round(rate),
			droppedBytes: c.dropping ? 37_748_736 : 0,
			droppedChunks: c.dropping ? 144 : 0,
			droppedBytesLast60s: c.dropping ? 2_097_152 : 0,
			commandBytes: s.expected === null && i === 0 ? 30 : 0,
		}
	})
	const out = clients.reduce((sum, c) => sum + (c.queuedBytesPerSec ?? 0), 0)
	const dropping = clients.some(c => c.droppedBytesLast60s > 0)
	return {
		version: "1.0.0",
		uptime: Math.round(service),
		dongle: {
			present: s.dongle,
			product: s.dongle ? "RTLSDRBlog Blog V4" : null,
			serial: null,
			usb: s.dongle ? { vid: "0bda", pid: "2838", bus: 1, device: 4 } : null,
			driverConflict: false,
			conflictingDriver: null,
		},
		rtlTcp: {
			running: s.rtlTcp,
			pid: s.rtlTcp ? 58 : null,
			restartCount: s.rtlTcp ? 0 : 3,
			lastRestartAt: s.rtlTcp ? null : new Date(now - 4000).toISOString(),
			config: {
				sampleRate: 2_048_000,
				frequency: 446_524_920,
				buffer: 15,
				agc: false,
				gain: 49,
				ppm: 0,
			},
		},
		rtlmux: {
			running: true,
			pid: 63,
			restartCount: 0,
			lastRestartAt: null,
			endpoint: "tcp://wavekit-pi.local:5555",
			statsUrl: "http://wavekit-pi.local:5556/stats.json",
		},
		sampling: {
			state: s.sampling,
			reason: s.reason,
			timeoutMs: 10_000,
			lastSampleAt:
				s.stalledSec === null
					? null
					: new Date(now - (s.stalledSec ?? 0.1) * 1000).toISOString(),
			sampleAgeMs: s.stalledSec === null ? null : (s.stalledSec ?? 0.1) * 1000,
			upstream: {
				bytesTotal: flowing ? Math.round(s.rate * service) : 9_400_000_000,
				bytesPerSec: flowing ? Math.round(upstream) : 0,
				windowMs: 10_000,
				expectedBytesPerSec: s.expected,
				rateBasis: s.expected === null ? "client-controlled" : "configured",
				rateStatus: s.expected === null ? "unknown" : s.rateStatus,
			},
			epoch: {
				rtlmuxPid: 63,
				rtlTcpPid: s.rtlTcp ? 58 : null,
				startedAt: new Date(now - service * 1000).toISOString(),
				resets: 0,
				lastResetReason: null,
			},
			stats: {
				state: "ok",
				observedAt: new Date(now).toISOString(),
				ageMs: 120,
				lastError: null,
			},
		},
		delivery: {
			state:
				clients.length === 0 ? "idle" : dropping ? "dropping" : "delivering",
			clients,
			queuedBytesPerSec: clients.length === 0 ? null : Math.round(out),
			droppedBytesLast60s: dropping ? 2_097_152 : 0,
			droppedChunksLast60s: dropping ? 8 : 0,
			droppedBytesSinceMonitorStart: dropping ? 37_748_736 : 8_306_688,
			monitorStartedAt: new Date(now - service * 1000).toISOString(),
		},
		samplingHistory: { pollIntervalMs: 2000, windowMs: 300_000, points },
		warnings: [],
		errors: s.rtlTcp ? [] : ["rtl_tcp: usb_claim_interface error -6"],
	}
}

function reading(value, now, scope = "host", reason = null) {
	return value === null
		? {
				state: "unavailable",
				scope,
				observedAt: null,
				ageMs: null,
				value: null,
				reason,
			}
		: {
				state: "ok",
				scope,
				observedAt: new Date(now - 400).toISOString(),
				ageMs: 400,
				value,
				reason: null,
			}
}

function host(name, now) {
	const s = scenario(name)
	const t = (now - startedAt) / 1000
	const service = s.serviceSec + t
	const cpuAt = at =>
		Math.max(2, s.cpu + 6 * wave(at, 50) + 8 * jitter(Math.round(at / 2), 2))
	const memAt = at => 29.5 + 0.4 * wave(at, 200)
	const tempAt = at => s.temp + 1.2 * wave(at, 120)
	const dipsAt = at =>
		s.dipEverySec && Math.floor(at / 2) % Math.round(s.dipEverySec / 2) === 0
			? 1
			: 0
	const lastDipAge = s.dipEverySec ? ((t % s.dipEverySec) + 1) * 1000 : null
	const points = [...ages(service)].map(age => {
		const at = t - age / 1000
		const r = v => Math.round(v * 10) / 10
		return [
			age,
			r(cpuAt(at)),
			r(memAt(at)),
			r(tempAt(at)),
			s.uvNow && age < 20_000 ? 1 : dipsAt(at),
		]
	})
	const iface = (n, kind, up, extra) => ({
		name: n,
		kind,
		operstate: up ? "up" : "down",
		addresses: up ? ["192.168.1.23"] : [],
		rxBytesPerSec: up ? 15_490 : 0,
		txBytesPerSec: up
			? s.sampling === "streaming"
				? Math.round(s.rate * s.clients.length * 1.03) + 4000
				: 4000
			: 0,
		wireless: null,
		...extra,
	})
	const network =
		s.net === "ethernet"
			? [iface("eth0", "ethernet", true), iface("wlan0", "wireless", false)]
			: [
					iface("eth0", "ethernet", false),
					iface("wlan0", "wireless", true, {
						wireless: { linkQuality: 63, signalDbm: s.dbm },
					}),
				]
	const dips = s.dipsTotal + (s.dipEverySec ? Math.floor(t / s.dipEverySec) : 0)
	const setup = s.setup && {
		state: s.setup.state,
		phase: s.setup.phase,
		updatedAt: new Date(now - s.setup.ageMs).toISOString(),
		updatedAgeMs: s.setup.ageMs + t * 1000,
		exitCode: s.setup.exitCode ?? (s.setup.state === "complete" ? 0 : null),
	}
	const hostUp = (s.hostSec ?? s.serviceSec + 60) + t
	const body = {
		generatedAt: new Date(now).toISOString(),
		uptime: reading(
			{
				hostSec: Math.round(hostUp),
				hostBootedAt: new Date(now - hostUp * 1000).toISOString(),
				containerSec: Math.round(service + 10),
				serviceSec: Math.round(service),
			},
			now,
		),
		cpu: reading(
			{
				busyPercent: Math.round(cpuAt(t) * 10) / 10,
				cores: 4,
				windowMs: 10_000,
			},
			now,
		),
		load: reading({ one: 0.71, five: 0.65, fifteen: 0.59 }, now),
		memory: reading(
			{
				totalBytes: 949_006_336,
				availableBytes: Math.round(949_006_336 * (1 - memAt(t) / 100)),
				swapTotalBytes: 0,
				swapFreeBytes: 0,
			},
			now,
		),
		container: reading(
			null,
			now,
			"container",
			"container memory accounting not visible",
		),
		disk: reading(
			{
				totalBytes: 30_805_991_424,
				usedBytes: 4_300_791_808,
				availableBytes: 25_209_004_032,
			},
			now,
			"docker-storage",
		),
		temperature: reading(
			{ celsius: Math.round(tempAt(t) * 10) / 10, zone: "cpu-thermal" },
			now,
		),
		power: {
			undervoltageNow: reading(s.uvNow, now),
			undervoltageObserved: reading(
				{
					events: dips,
					lastAt:
						lastDipAge === null
							? null
							: new Date(now - lastDipAge).toISOString(),
					since: new Date(now - service * 1000).toISOString(),
					lastAgeMs: s.uvNow ? 0 : lastDipAge,
					coveredMs: Math.round(service * 1000),
				},
				now,
				"service",
			),
			throttling: reading(
				null,
				now,
				"host",
				"firmware throttle flags need /dev/vcio or vcgencmd, which are not granted",
			),
		},
		network: reading(network, now),
		setup: reading(setup, now),
		// How the previous boot ended: a requested reboot unless the scenario says otherwise.
		lastBoot: reading(
			{
				previous: {
					lastEntryAt: new Date(now - (hostUp + 20) * 1000).toISOString(),
					lastEntryAgeMs: Math.round((hostUp + 20) * 1000),
					cleanShutdown: s.reboot !== "unexpected",
				},
				undervoltageSinceBoot: s.reboot === "unexpected",
				throttledSinceBoot: false,
				watchdogReset: null,
			},
			now,
		),
		history: { intervalMs: 2000, windowMs: 300_000, points },
	}
	if (s.noHistory) {
		delete body.history
		delete body.lastBoot
	}
	return body
}

function setupRecord(name, now) {
	const { record } = SETUP[name]
	if (!Array.isArray(record))
		return {
			state: record === null ? "waiting" : "unavailable",
			phase: null,
			updatedAt: null,
			updatedAgeMs: null,
			exitCode: null,
			receiverPageReady: false,
		}
	const [state, phase, ageSec, exitCode = null] = record
	const age = ageSec * 1000 + (now - startedAt)
	return {
		state,
		phase,
		updatedAt: new Date(now - age).toISOString(),
		updatedAgeMs: age,
		exitCode,
		receiverPageReady: false,
	}
}

const served = new Map()
function failing(name, spec) {
	if (spec.fail === "always") return true
	if (spec.fail !== "after-first") return false
	const count = served.get(name) ?? 0
	served.set(name, count + 1)
	return count >= 2
}

function index() {
	const link = (name, spec, page = "") =>
		`<li><a href="/${name}/${page}">${name}</a> · ${spec.label}</li>`
	return `<!doctype html><meta charset="utf-8"><title>Pi page preview</title><style>body{font:16px/1.5 system-ui;margin:2rem;max-width:48rem}</style><h1>Pi operator page preview</h1><h2>Receiver status</h2><ul>${Object.entries(
		STATUS,
	)
		.map(([n, s]) => link(n, s))
		.join("")}</ul><h2>First-boot setup</h2><ul>${Object.entries(SETUP)
		.map(([n, s]) => link(n, s, "boot.html"))
		.join("")}</ul>`
}

createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://preview")
	const [, name = "", ...rest] = url.pathname.split("/")
	const file = rest.join("/") || "index.html"
	const send = (code, type, body) => {
		res.writeHead(code, { "content-type": type, "cache-control": "no-store" })
		res.end(body)
	}
	if (!name) return send(200, TYPES[".html"], index())
	const spec = STATUS[name] ?? SETUP[name]
	if (!spec) return send(404, "text/plain", "unknown scenario")
	if (file.startsWith("api/")) {
		if (failing(name, spec)) return send(503, "text/plain", "unavailable")
		const now = Date.now()
		const body =
			file === "api/status" && STATUS[name]
				? status(name, now)
				: file === "api/host" && STATUS[name]
					? host(name, now)
					: file === "api/setup" && SETUP[name]
						? setupRecord(name, now)
						: null
		return body
			? send(200, "application/json", JSON.stringify(body))
			: send(404, "text/plain", "")
	}
	const path = normalize(join(UI, file))
	if (!path.startsWith(UI)) return send(404, "text/plain", "")
	try {
		send(
			200,
			TYPES[extname(path)] ?? "application/octet-stream",
			await readFile(path),
		)
	} catch {
		send(404, "text/plain", "")
	}
}).listen(PORT, "127.0.0.1", () => {
	process.stdout.write(`Pi page preview on http://127.0.0.1:${PORT}/\n`)
})

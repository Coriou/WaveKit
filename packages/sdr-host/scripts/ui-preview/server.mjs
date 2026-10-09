#!/usr/bin/env node
// Local dev server for the Pi operator pages over simulated receivers. Serves
// ui/ unchanged under /<scenario>/ with synthetic /api/status, /api/host and
// /api/setup payloads shaped like a real Pi's, under the Pi's own CSP. Edits
// in ui/ reload the open pages (CSS swaps in place); edits to this script
// restart the server and reload them too. Never deploys or contacts a Pi.
//
//   pnpm dev:pi-ui                     (from the repo root)
//   node --watch packages/sdr-host/scripts/ui-preview/server.mjs [--port 8090] [--host 127.0.0.1]
//   open http://127.0.0.1:8090/        (index of scenarios; /live/ loops through them)
import { watch } from "node:fs"
import { readFile } from "node:fs/promises"
import { createServer } from "node:http"
import { extname, join, normalize } from "node:path"
import { fileURLToPath } from "node:url"
import { CONTENT_SECURITY_POLICY } from "../../src/api/routes/ui.ts"

const UI = fileURLToPath(new URL("../../ui/", import.meta.url))
const CLIENT = fileURLToPath(new URL("./", import.meta.url))
const arg = (flag, fallback) => {
	const i = process.argv.indexOf(flag)
	return i > 0 ? process.argv[i + 1] : fallback
}
const PORT = Number(arg("--port", 8090))
const HOST = arg("--host", "127.0.0.1")
const TYPES = {
	".html": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".svg": "image/svg+xml",
	".woff2": "font/woff2",
}
const MB = 1_000_000
const startedAt = Date.now()

const A = { address: "192.168.1.20:53812" }
const B = { address: "192.168.1.31:40122" }
const C = { address: "192.168.1.44:61207" }

/**
 * The receiver tour: a realistic sequence of states, looped (about 4 min, so
 * the five-minute scope always holds a whole cycle). Each step overrides the
 * healthy defaults; history points read the step that was current at their
 * time, so stalls, dips and rate changes scroll across the scope.
 */
const TOUR = [
	{
		sec: 35,
		label: "Sampling at the configured rate, one client",
		clients: [A],
	},
	{ sec: 30, label: "A second client joins", clients: [A, B] },
	{
		sec: 10,
		label: "Under-voltage now, below rate",
		rate: 3.1 * MB,
		rateStatus: "low",
		uvNow: true,
		temp: 63,
		cpu: 52,
		clients: [A, { ...B, dropping: true }],
	},
	{
		sec: 20,
		label: "Power dips continue, a client falls behind",
		rate: 3.4 * MB,
		rateStatus: "low",
		dipEverySec: 6,
		temp: 61,
		cpu: 47,
		clients: [A, { ...B, dropping: true }],
	},
	{
		sec: 20,
		label: "Samples stop with the dongle present",
		sampling: "stale",
		clients: [A, B],
	},
	{
		sec: 20,
		label: "Dongle unplugged, rtl_tcp restarting",
		sampling: "disconnected",
		reason: "rtl_tcp is not running",
		dongle: false,
		rtlTcp: false,
		clients: [],
	},
	{ sec: 30, label: "Back up, nobody connected", clients: [] },
	{
		sec: 40,
		label: "A client tunes and sets its own rate",
		rate: 4.8 * MB,
		expected: null,
		clients: [C],
	},
	{
		sec: 35,
		label: "Weak Wi-Fi, warm SoC",
		rate: 4.8 * MB,
		expected: null,
		dbm: -79,
		temp: 69,
		cpu: 34,
		clients: [C],
	},
]
const TOUR_SEC = TOUR.reduce((sum, step) => sum + step.sec, 0)

/** Receiver scenarios: overrides on a healthy, configured-rate receiver. */
const STATUS = {
	live: {
		label: `Tour: loops through receiver states every ${TOUR_SEC} s`,
		tour: true,
	},
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
		clients: [{ ...A, dropping: true }],
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
			A,
			{ ...B, dropping: true },
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

/** First-boot setup tour: every running stage in order, then complete, looped. */
const BOOT_TOUR = [
	{ sec: 8, label: "No progress record yet", record: null },
	{
		sec: 20,
		label: "Applying Imager settings",
		record: ["running", "cloud-init"],
	},
	{ sec: 40, label: "Installing the receiver", record: ["running", "install"] },
	{ sec: 12, label: "Finishing", record: ["running", "publish"] },
	{
		sec: 15,
		label: "Complete, status page not up yet",
		record: ["complete", "done"],
	},
]
const BOOT_TOUR_SEC = BOOT_TOUR.reduce((sum, step) => sum + step.sec, 0)

const SETUP = {
	"boot-live": {
		label: `Tour: loops through setup stages every ${BOOT_TOUR_SEC} s`,
		tour: true,
	},
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

/** The tour step current at preview time `at` (seconds, may be negative), and how far into it. */
function stepAt(steps, cycleSec, at) {
	let into = ((at % cycleSec) + cycleSec) % cycleSec
	for (const [index, step] of steps.entries()) {
		if (into < step.sec) return { index, step, into }
		into -= step.sec
	}
	const index = steps.length - 1
	return { index, step: steps[index], into: steps[index].sec }
}

/** Seconds that `holds` has been true for over contiguous tour steps ending at `at`. */
function heldFor(at, holds) {
	const { index, step, into } = stepAt(TOUR, TOUR_SEC, at)
	if (!holds(step)) return 0
	let sec = into
	for (let back = 1; back < TOUR.length; back++) {
		const prev = TOUR[(index - back + TOUR.length) % TOUR.length]
		if (!holds(prev)) break
		sec += prev.sec
	}
	return sec
}

const DEFAULTS = {
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
	clients: [A],
	setup: { state: "complete", phase: "done", ageMs: 86_400_000 },
}

/** Scenario parameters at preview time `at`; only tours vary with time. */
function scenarioAt(name, at) {
	const spec = STATUS[name]
	if (!spec.tour) return { ...DEFAULTS, ...spec }
	return { ...DEFAULTS, dipsTotal: 240, ...stepAt(TOUR, TOUR_SEC, at).step }
}

/** One history point per 2 s poll over five minutes, but never before the service started. */
function* ages(serviceSec) {
	for (let age = 0; age <= 300_000 && age / 1000 <= serviceSec; age += 2000)
		yield age
}

/** Whether samples were arriving at preview time `at`, given the scenario now. */
function flowingAt(name, s, t, at) {
	if (STATUS[name].tour) return scenarioAt(name, at).sampling === "streaming"
	if (s.stalledSec === null) return false
	return s.stalledSec == null || t - at >= s.stalledSec
}

function status(name, now) {
	const t = (now - startedAt) / 1000
	const tour = STATUS[name].tour === true
	const s = scenarioAt(name, t)
	const service = s.serviceSec + t
	const flowing = s.sampling === "streaming"
	const stalledSec = tour
		? flowing
			? undefined
			: heldFor(t, step => (step.sampling ?? "streaming") !== "streaming")
		: s.stalledSec
	const upstream = flowing ? s.rate * (1 + 0.004 * wave(t, 7)) : 0
	const points = [...ages(service)].map(age => {
		const at = t - age / 1000
		const p = tour ? scenarioAt(name, at) : s
		const missing = s.gapSec != null && Math.abs(age / 1000 - s.gapSec - 3) < 3
		// A starved dongle sags unevenly: slow drift, uneven sags, the odd drop.
		const low =
			p.rateStatus === "low"
				? 0.94 +
					0.04 * wave(at, 53) +
					0.03 * wave(at, 17, 1.1) -
					0.2 * Math.max(0, wave(at, 31, 0.6)) ** 4 -
					(jitter(Math.round(at / 2), 3) > 0.9 ? 0.12 : 0)
				: 1
		const v = flowingAt(name, s, t, at)
			? p.rate * low * (0.985 + 0.03 * jitter(Math.round(at / 2), 1))
			: 0
		return [age, missing ? null : Math.round(v)]
	})
	const clients = s.clients.map((c, i) => {
		const rate = flowing ? upstream * (c.dropping ? 0.8 : 1) : 0
		const minutes = tour
			? heldFor(t, step =>
					step.clients.some(other => other.address === c.address),
				) / 60
			: (c.minutes ?? 58 - i * 7)
		const connectedSec = minutes * 60
		return {
			key: `63|${c.address}`,
			address: c.address,
			connectedAt: new Date(now - connectedSec * 1000).toISOString(),
			queuedBytes: Math.round(rate * connectedSec),
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
				stalledSec === null
					? null
					: new Date(now - (stalledSec ?? 0.1) * 1000).toISOString(),
			sampleAgeMs: stalledSec === null ? null : (stalledSec ?? 0.1) * 1000,
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

/** Whether the tour logs an under-voltage event on the 2 s poll at `at`. */
function tourDipAt(at) {
	const p = scenarioAt("live", at)
	if (p.uvNow) return true
	return (
		p.dipEverySec !== null &&
		Math.floor(at / 2) % Math.round(p.dipEverySec / 2) === 0
	)
}

/** Tour dip events on top of `earlier` ones from before the window, and the newest one's age. */
function tourDips(t, earlier) {
	let events = earlier
	let lastAgeMs = null
	for (let tick = Math.floor(t / 2); tick >= -150; tick--) {
		if (!tourDipAt(tick * 2)) continue
		events += 1
		lastAgeMs ??= Math.round((t - tick * 2) * 1000)
	}
	return { events, lastAgeMs }
}

function host(name, now) {
	const t = (now - startedAt) / 1000
	const tour = STATUS[name].tour === true
	const s = scenarioAt(name, t)
	const at = time => (tour ? scenarioAt(name, time) : s)
	const service = s.serviceSec + t
	const cpuAt = time =>
		Math.max(
			2,
			at(time).cpu + 6 * wave(time, 50) + 8 * jitter(Math.round(time / 2), 2),
		)
	const memAt = time => 29.5 + 0.4 * wave(time, 200)
	// The SoC warms and cools over about 40 s rather than stepping with the load.
	const settledTemp = time =>
		tour
			? Array.from({ length: 8 }, (_, k) => at(time - k * 5).temp).reduce(
					(sum, v) => sum + v,
				) / 8
			: s.temp
	const tempAt = time => settledTemp(time) + 1.2 * wave(time, 120)
	const dipsAt = time =>
		tour
			? tourDipAt(Math.floor(time / 2) * 2)
				? 1
				: 0
			: s.dipEverySec &&
				  Math.floor(time / 2) % Math.round(s.dipEverySec / 2) === 0
				? 1
				: 0
	const dipStats = tour
		? tourDips(t, s.dipsTotal)
		: {
				events:
					s.dipsTotal + (s.dipEverySec ? Math.floor(t / s.dipEverySec) : 0),
				lastAgeMs: s.dipEverySec ? ((t % s.dipEverySec) + 1) * 1000 : null,
			}
	const lastDipAgeMs = s.uvNow ? 0 : dipStats.lastAgeMs
	const points = [...ages(service)].map(age => {
		const time = t - age / 1000
		const r = v => Math.round(v * 10) / 10
		return [
			age,
			r(cpuAt(time)),
			r(memAt(time)),
			r(tempAt(time)),
			!tour && s.uvNow && age < 20_000 ? 1 : dipsAt(time),
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
					events: dipStats.events,
					lastAt:
						lastDipAgeMs === null
							? null
							: new Date(now - lastDipAgeMs).toISOString(),
					since: new Date(now - service * 1000).toISOString(),
					lastAgeMs: lastDipAgeMs,
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
	const elapsed = now - startedAt
	let record
	let ageMs
	if (SETUP[name].tour) {
		const { step, into } = stepAt(BOOT_TOUR, BOOT_TOUR_SEC, elapsed / 1000)
		record = step.record
		ageMs = into * 1000
	} else {
		record = SETUP[name].record
		ageMs = Array.isArray(record) ? record[2] * 1000 + elapsed : null
	}
	if (!Array.isArray(record))
		return {
			state: record === null ? "waiting" : "unavailable",
			phase: null,
			updatedAt: null,
			updatedAgeMs: null,
			exitCode: null,
			receiverPageReady: false,
		}
	const [state, phase, , exitCode = null] = record
	return {
		state,
		phase,
		updatedAt: new Date(now - ageMs).toISOString(),
		updatedAgeMs: ageMs,
		exitCode,
		receiverPageReady: false,
	}
}

/** What a scenario shows right now: tours name their current step. */
function currentLabel(name, now) {
	const t = (now - startedAt) / 1000
	if (STATUS[name]?.tour) return stepAt(TOUR, TOUR_SEC, t).step.label
	if (SETUP[name]?.tour) return stepAt(BOOT_TOUR, BOOT_TOUR_SEC, t).step.label
	return (STATUS[name] ?? SETUP[name])?.label ?? null
}

const served = new Map()
function failing(name, spec) {
	if (spec.fail === "always") return true
	if (spec.fail !== "after-first") return false
	const count = served.get(name) ?? 0
	served.set(name, count + 1)
	return count >= 2
}

const escapeHtml = text =>
	text.replace(
		/[&<>"]/g,
		c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
	)

function index() {
	const link = (name, spec, page = "") =>
		`<li><a href="/${name}/${page}">${name}</a> · ${escapeHtml(spec.label)}</li>`
	const list = (specs, page) =>
		Object.entries(specs)
			.map(([n, s]) => link(n, s, page))
			.join("")
	return `<!doctype html><meta charset="utf-8"><title>Pi page preview</title><link rel="stylesheet" href="/__dev/index.css"><h1>Pi operator page preview</h1><p>Edits in <code>packages/sdr-host/ui/</code> reload open pages; CSS swaps in place. The <code>live</code> tours loop through realistic states. Pages run under the Pi's CSP.</p><h2>Receiver status</h2><ul>${list(STATUS, "")}</ul><h2>First-boot setup</h2><ul>${list(SETUP, "boot.html")}</ul>`
}

// Live reload: one server-sent event per burst of saves in ui/.
const listeners = new Set()
let changed = new Set()
let flush = null
watch(UI, { recursive: true }, (_event, file) => {
	if (!file || !TYPES[extname(file)]) return
	changed.add(file.split("\\").join("/"))
	clearTimeout(flush)
	flush = setTimeout(() => {
		const data = `data: ${JSON.stringify([...changed])}\n\n`
		changed = new Set()
		for (const res of listeners) res.write(data)
	}, 60)
})

function events(req, res) {
	res.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-store",
		connection: "keep-alive",
	})
	res.write("retry: 500\n\n")
	listeners.add(res)
	req.on("close", () => listeners.delete(res))
}

const INJECT = `<script type="module" src="/__dev/client.js"></script>\n\t</body>`

createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", "http://preview")
	const [, name = "", ...rest] = url.pathname.split("/")
	const file = rest.join("/") || "index.html"
	const send = (code, type, body, headers = {}) => {
		res.writeHead(code, {
			"content-type": type,
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			...headers,
		})
		res.end(body)
	}
	const html = { "content-security-policy": CONTENT_SECURITY_POLICY }
	if (!name) return send(200, TYPES[".html"], index(), html)
	if (name === "__dev") {
		if (file === "events") return events(req, res)
		if (file === "scenarios") {
			const current = url.searchParams.get("current") ?? ""
			const entries = specs =>
				Object.entries(specs).map(([n, s]) => ({ name: n, label: s.label }))
			return send(
				200,
				"application/json",
				JSON.stringify({
					receiver: entries(STATUS),
					setup: entries(SETUP),
					now: currentLabel(current, Date.now()),
				}),
			)
		}
		if (!["client.js", "client.css", "index.css"].includes(file))
			return send(404, "text/plain", "")
		return send(200, TYPES[extname(file)], await readFile(join(CLIENT, file)))
	}
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
		const body = await readFile(path)
		if (extname(path) !== ".html")
			return send(200, TYPES[extname(path)] ?? "application/octet-stream", body)
		// Each page load gets its own first readings before contact is lost.
		served.delete(name)
		send(
			200,
			TYPES[".html"],
			body.toString("utf8").replace("</body>", INJECT),
			html,
		)
	} catch {
		send(404, "text/plain", "")
	}
}).listen(PORT, HOST, () => {
	process.stdout.write(`Pi page preview on http://${HOST}:${PORT}/\n`)
})

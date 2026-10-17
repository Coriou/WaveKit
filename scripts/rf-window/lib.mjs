// Pure helpers of the RF-window scripts (no I/O): argument parsing, statistics, PCM
// analysis, tone matching, restore plans and retune sequences. Unit-tested in
// tests/unit/scripts/rf-window.test.ts. Shapes follow the frozen WG7 contract
// (packages/api-types/src/live-audio.ts): squelchMode, noiseQuietingDb, toneSquelch.

export const DEFAULT_API_PORT = 9000

/** The 50 standard CTCSS tones in Hz (src/core/audio-tones/ctcss.ts CTCSS_HZ). */
export const CTCSS_HZ = Object.freeze([
	67, 69.3, 71.9, 74.4, 77, 79.7, 82.5, 85.4, 88.5, 91.5, 94.8, 97.4, 100,
	103.5, 107.2, 110.9, 114.8, 118.8, 123, 127.3, 131.8, 136.5, 141.3, 146.2,
	151.4, 156.7, 159.8, 162.2, 165.5, 167.9, 171.3, 173.8, 177.3, 179.9, 183.5,
	186.2, 189.9, 192.8, 196.6, 199.5, 203.5, 206.5, 210.7, 218.1, 225.7, 229.1,
	233.6, 241.8, 250.3, 254.1,
])

/** Squelch modes of the frozen contract (LIVE_AUDIO_SQUELCH_MODES). */
export const SQUELCH_MODES = Object.freeze(["manual", "auto", "noise"])

export class UsageError extends Error {
	constructor(message) {
		super(message)
		this.name = "UsageError"
	}
}

/**
 * Parses `--name value` / `--name=value` / `--flag` arguments against a spec
 * `{ name: { type: "string" | "number" | "boolean", default?, min?, max?, int? } }`.
 * `--host` is always required unless `--help`. Unknown options throw UsageError.
 */
export function parseArgs(argv, spec) {
	const full = {
		host: { type: "string" },
		apply: { type: "boolean", default: false },
		run: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
		json: { type: "boolean", default: false },
		...spec,
	}
	const out = {}
	for (const [name, def] of Object.entries(full))
		if (def.default !== undefined) out[name] = def.default
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]
		if (!arg.startsWith("--"))
			throw new UsageError(`Unexpected argument ${arg}`)
		const eq = arg.indexOf("=")
		const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq)
		const def = Object.hasOwn(full, name) ? full[name] : undefined
		if (def === undefined) throw new UsageError(`Unknown option --${name}`)
		if (def.type === "boolean") {
			if (eq !== -1) throw new UsageError(`--${name} takes no value`)
			out[name] = true
			continue
		}
		let raw
		if (eq !== -1) raw = arg.slice(eq + 1)
		else {
			raw = argv[i + 1]
			i++
		}
		if (raw === undefined || raw === "")
			throw new UsageError(`--${name} needs a value`)
		if (def.type === "number") {
			const value = Number(raw)
			if (!Number.isFinite(value))
				throw new UsageError(`--${name} must be a number`)
			if (def.int === true && !Number.isInteger(value))
				throw new UsageError(`--${name} must be an integer`)
			if (def.min !== undefined && value < def.min)
				throw new UsageError(`--${name} must be at least ${def.min}`)
			if (def.max !== undefined && value > def.max)
				throw new UsageError(`--${name} must be at most ${def.max}`)
			out[name] = value
		} else out[name] = raw
	}
	if (out.help !== true && out.host === undefined)
		throw new UsageError("--host is required (for example --host 192.168.1.20)")
	// --apply implies a measured run; without either the script only prints its plan.
	out.mode = out.apply === true ? "apply" : out.run === true ? "run" : "dry-run"
	return out
}

/** `pi.local` → http://pi.local:9000; `host:port` and http(s) URLs are kept (no path). */
export function apiBaseUrl(host) {
	const trimmed = String(host).trim()
	if (trimmed === "") throw new UsageError("--host is empty")
	const withScheme = /^https?:\/\//i.test(trimmed)
		? trimmed
		: `http://${trimmed}`
	let url
	try {
		url = new URL(withScheme)
	} catch {
		throw new UsageError(`--host is not a host or URL: ${trimmed}`)
	}
	if (url.username !== "" || url.password !== "")
		throw new UsageError("--host must not carry credentials")
	if (url.pathname !== "/" || url.search !== "" || url.hash !== "")
		throw new UsageError("--host must not carry a path, query or fragment")
	if (url.port === "") url.port = String(DEFAULT_API_PORT)
	return url.origin
}

/** ws(s) URL of the API's /ws endpoint. */
export function wsUrl(apiBase) {
	const url = new URL("/ws", apiBase)
	url.protocol = url.protocol === "https:" ? "wss:" : "ws:"
	return url.href
}

/**
 * The live audio raw stream URL on the API host: `status.config.httpPort` on the same
 * hostname (the status `httpUrl` names the server's own view, often localhost).
 */
export function audioStreamUrl(apiBase, httpPort) {
	const url = new URL(apiBase)
	url.port = String(httpPort)
	url.pathname = "/stream"
	return url.href
}

/** Nearest-rank percentile of an ascending-sorted array; null when empty. */
export function percentile(sorted, p) {
	if (sorted.length === 0) return null
	const rank = Math.ceil((p / 100) * sorted.length)
	return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

/** count, min, p50, p90, p99, max, mean of finite values (non-finite ignored). */
export function summarize(values) {
	const sorted = values.filter(v => Number.isFinite(v)).sort((a, b) => a - b)
	if (sorted.length === 0)
		return {
			count: 0,
			min: null,
			p50: null,
			p90: null,
			p99: null,
			max: null,
			mean: null,
		}
	const sum = sorted.reduce((a, b) => a + b, 0)
	return {
		count: sorted.length,
		min: sorted[0],
		p50: percentile(sorted, 50),
		p90: percentile(sorted, 90),
		p99: percentile(sorted, 99),
		max: sorted[sorted.length - 1],
		mean: sum / sorted.length,
	}
}

/** Mono PCM (s16le or f32le, little-endian) → Float32Array in [-1, 1]. */
export function decodePcm(buffer, format) {
	if (format === "s16le") {
		const n = Math.floor(buffer.length / 2)
		const out = new Float32Array(n)
		for (let i = 0; i < n; i++) out[i] = buffer.readInt16LE(i * 2) / 32768
		return out
	}
	if (format === "f32le") {
		const n = Math.floor(buffer.length / 4)
		const out = new Float32Array(n)
		for (let i = 0; i < n; i++) out[i] = buffer.readFloatLE(i * 4)
		return out
	}
	throw new UsageError(`Unsupported audio format ${format}`)
}

export const TAIL_DEFAULTS = Object.freeze({
	blockMs: 10,
	/** |x| at or below this is a muted (zero) sample; above one s16 LSB / 2. */
	zeroEps: 1 / 65536,
	/** Block RMS at or above this can be noise. */
	minNoiseRms: 0.02,
	/** rms(diff) / rms at or above this is broadband (white noise ≈ 1.41, voice < 0.5). */
	minHfRatio: 0.9,
	/** A mute run this long ends a transmission (shorter zero runs are ignored). */
	minMutedBlocks: 20,
})

/** Per-block class: "muted" (all zero), "noise" (loud and broadband) or "audio". */
export function classifyBlocks(samples, sampleRate, options = {}) {
	const o = { ...TAIL_DEFAULTS, ...options }
	const size = Math.max(1, Math.round((sampleRate * o.blockMs) / 1000))
	const classes = []
	for (let start = 0; start + size <= samples.length; start += size) {
		let muted = true
		let energy = 0
		let diffEnergy = 0
		for (let i = start; i < start + size; i++) {
			const x = samples[i]
			if (Math.abs(x) > o.zeroEps) muted = false
			energy += x * x
			if (i > start) {
				const d = x - samples[i - 1]
				diffEnergy += d * d
			}
		}
		if (muted) {
			classes.push("muted")
			continue
		}
		const rms = Math.sqrt(energy / size)
		const hf = energy > 0 ? Math.sqrt(diffEnergy / (size - 1)) / rms : 0
		classes.push(rms >= o.minNoiseRms && hf >= o.minHfRatio ? "noise" : "audio")
	}
	return { blockSize: size, blockMs: (size * 1000) / sampleRate, classes }
}

/**
 * Noise tails: at each start of a mute run of at least `minMutedBlocks`, the run of noise
 * blocks just before it. `after` says what preceded the noise: "audio" (a carrier with
 * quieted audio, the PTT-release case), "muted" (the squelch opened on noise alone) or
 * "start" (the recording began inside it). A mute run reached directly from audio has
 * tailMs 0.
 */
export function findNoiseTails(samples, sampleRate, options = {}) {
	const o = { ...TAIL_DEFAULTS, ...options }
	const { classes, blockMs } = classifyBlocks(samples, sampleRate, o)
	const tails = []
	let i = 0
	while (i < classes.length) {
		if (classes[i] !== "muted") {
			i++
			continue
		}
		let end = i
		while (end < classes.length && classes[end] === "muted") end++
		const runBlocks = end - i
		if (runBlocks >= o.minMutedBlocks && i > 0) {
			let k = i - 1
			while (k >= 0 && classes[k] === "noise") k--
			const noiseBlocks = i - 1 - k
			if (noiseBlocks > 0 || classes[i - 1] === "audio")
				tails.push({
					atSec: (i * blockMs) / 1000,
					tailMs: noiseBlocks * blockMs,
					after: k < 0 ? "start" : classes[k] === "audio" ? "audio" : "muted",
				})
		}
		i = end
	}
	return tails
}

/** Tail bound of WG7 req 4.1: hang (250 ms) + one 10 ms block + the measured back-chain. */
export function tailBoundMs(backChainMs, hangMs = 250, blockMs = 10) {
	return hangMs + blockMs + backChainMs
}

function golayWord(code) {
	const data = (code & 0x1ff) | (0b100 << 9)
	let r = data << 11
	for (let i = 22; i >= 11; i--) if (r & (1 << i)) r ^= 0xc75 << (i - 11)
	return ((data << 11) | r) & 0x7fffff
}

function rotations(word) {
	const out = new Set()
	for (let k = 0; k < 23; k++)
		out.add(((word >>> k) | (word << (23 - k))) & 0x7fffff)
	return out
}

/**
 * True when two DCS readings are the same bit stream: equal, or inverted twins (one word's
 * complement is a rotation of the other's, polarity flipped; 023N = 047I).
 */
export function dcsSameStream(a, b) {
	if (!/^[0-7]{3}$/.test(a.code) || !/^[0-7]{3}$/.test(b.code)) return false
	const wa = golayWord(Number.parseInt(a.code, 8))
	const wb = golayWord(Number.parseInt(b.code, 8))
	if (a.polarity === b.polarity) return rotations(wa).has(wb)
	return rotations(wa).has(~wb & 0x7fffff)
}

/**
 * `ctcss:100.0` / `ctcss:1000t` (tenths) → `{ kind: "ctcss", frequencyTenthsHz }`;
 * `dcs:023N` / `dcs:023I` / `dcs:023` (normal) → `{ kind: "dcs", code, polarity }`;
 * `none` → `{ kind: "none" }`. The result is a frozen-contract LiveAudioToneSquelch.
 */
export function parseTone(text) {
	const value = String(text).trim()
	if (value === "none") return { kind: "none" }
	const ctcss = /^ctcss:(\d{2,3}(?:\.\d)?)$/i.exec(value)
	if (ctcss) {
		const tenths = Math.round(Number(ctcss[1]) * 10)
		if (!CTCSS_HZ.some(hz => Math.round(hz * 10) === tenths))
			throw new UsageError(`${ctcss[1]} Hz is not a standard CTCSS tone`)
		return { kind: "ctcss", frequencyTenthsHz: tenths }
	}
	const dcs = /^dcs:([0-7]{3})([NI]?)$/i.exec(value)
	if (dcs)
		return {
			kind: "dcs",
			code: dcs[1],
			polarity: dcs[2].toUpperCase() === "I" ? "inverted" : "normal",
		}
	throw new UsageError(
		`Tone must be ctcss:<Hz>, dcs:<octal>[N|I] or none (got ${value})`,
	)
}

export function formatTone(tone) {
	if (tone === undefined || tone === null || tone.kind === "none") return "none"
	if (tone.kind === "ctcss")
		return `ctcss:${(tone.frequencyTenthsHz / 10).toFixed(1)}`
	return `dcs:${tone.code}${tone.polarity === "inverted" ? "I" : "N"}`
}

/**
 * Compares a closed transmission's `tone` (AnalogTransmissionTone) with the expected tone:
 * "match", "wrong" (another tone or code), "none" (nothing qualified) or "no-tone-field".
 */
export function classifyTone(expected, tone) {
	if (tone === undefined || tone === null) return "no-tone-field"
	if (expected.kind === "ctcss") {
		if (tone.ctcssHz === null || tone.ctcssHz === undefined) return "none"
		return Math.round(tone.ctcssHz * 10) === expected.frequencyTenthsHz
			? "match"
			: "wrong"
	}
	if (expected.kind === "dcs") {
		if (tone.dcs === null || tone.dcs === undefined) return "none"
		return dcsSameStream(expected, tone.dcs) ? "match" : "wrong"
	}
	return tone.ctcssHz == null && tone.dcs == null ? "match" : "wrong"
}

/** Counts of classifyTone results and the distinct wrong readings seen. */
export function summarizeTones(expected, closedEvents) {
	const counts = { match: 0, wrong: 0, none: 0, "no-tone-field": 0 }
	const wrong = new Map()
	for (const event of closedEvents) {
		const result = classifyTone(expected, event.tone)
		counts[result]++
		if (result === "wrong") {
			const key =
				expected.kind === "ctcss"
					? `ctcss:${event.tone.ctcssHz}`
					: event.tone.dcs
						? formatTone({ kind: "dcs", ...event.tone.dcs })
						: `ctcss:${event.tone.ctcssHz}`
			wrong.set(key, (wrong.get(key) ?? 0) + 1)
		}
	}
	const total = closedEvents.length
	return {
		total,
		...counts,
		matchRate: total === 0 ? null : counts.match / total,
		wrongReadings: Object.fromEntries(wrong),
	}
}

/**
 * Defaults a PATCH restores when the previous config lacked the key (absent = the default:
 * manual squelch, noise quieting 6 dB, no tone gate).
 */
export const LIVE_AUDIO_ABSENT_DEFAULTS = Object.freeze({
	squelchMode: "manual",
	noiseQuietingDb: 6,
	toneSquelch: Object.freeze({ kind: "none" }),
})

/**
 * The PATCH body that puts back every key of `applied` as `previous` had it; a key absent
 * from `previous` gets its absent-equivalent default (LIVE_AUDIO_ABSENT_DEFAULTS), or is
 * left out when it has none (reported in `unrestorable`).
 */
export function restorePatch(previous, applied) {
	const body = {}
	const unrestorable = []
	for (const key of Object.keys(applied)) {
		if (previous[key] !== undefined) body[key] = structuredClone(previous[key])
		else if (Object.hasOwn(LIVE_AUDIO_ABSENT_DEFAULTS, key))
			body[key] = structuredClone(LIVE_AUDIO_ABSENT_DEFAULTS[key])
		else unrestorable.push(key)
	}
	return { body, unrestorable }
}

/** Refusals a squelch-mode or tone PATCH would get (frozen config rules), or []. */
export function liveAudioPatchProblems(config, patch) {
	const problems = []
	const modulation = patch.modulation ?? config.modulation
	const mode = patch.squelchMode ?? config.squelchMode ?? "manual"
	if (!SQUELCH_MODES.includes(mode))
		problems.push(`unknown squelchMode ${mode}`)
	if (mode === "noise" && modulation !== "nfm" && modulation !== "wfm")
		problems.push(
			`noise squelch needs nfm or wfm (live audio is ${modulation})`,
		)
	const tone = patch.toneSquelch ?? config.toneSquelch
	if (tone !== undefined && tone.kind !== "none" && modulation !== "nfm")
		problems.push(`tone squelch needs nfm (live audio is ${modulation})`)
	return problems
}

/**
 * Retune targets for the latency test: alternately centre + step and centre - step, so
 * every command moves the tuner by at least one step and stays within ± step of the start.
 */
export function retuneTargets(centerHz, stepHz, count) {
	const targets = []
	for (let i = 0; i < count; i++)
		targets.push(centerHz + (i % 2 === 0 ? stepHz : -stepHz))
	return targets
}

/** True for a spectrum:frame of `sourceId` whose centre is `targetHz` (snapshots excluded). */
export function frameAtCentre(frame, sourceId, targetHz) {
	return (
		frame !== null &&
		typeof frame === "object" &&
		frame.sourceId === sourceId &&
		frame.centerHz === targetHz &&
		frame.snapshot !== true
	)
}

/** JSON-safe one-line record for logs. */
export function logLine(kind, data) {
	return JSON.stringify({ at: new Date().toISOString(), kind, ...data })
}

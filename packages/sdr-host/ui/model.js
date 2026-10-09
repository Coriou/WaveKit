// Pure presentation logic for the operator page. No DOM access here, so the
// rules that decide what the operator is told are unit-tested in Node.
// Payload shapes: @wavekit/api-types (SdrHostSampling, SdrHostTelemetry, ...).

/** A snapshot older than this (client clock) is never shown as current. */
export const SNAPSHOT_STALE_MS = 10_000
export const POLL_INTERVAL_MS = 3_000
export const REQUEST_TIMEOUT_MS = 4_000
export const MAX_BACKOFF_MS = 30_000

const MB = 1_000_000

export function formatRate(bytesPerSecond) {
	if (bytesPerSecond == null || !Number.isFinite(bytesPerSecond))
		return { value: "—", unit: "MB/s" }
	if (bytesPerSecond === 0 || bytesPerSecond >= 0.1 * MB)
		return { value: (bytesPerSecond / MB).toFixed(2), unit: "MB/s" }
	if (bytesPerSecond >= 1000)
		return { value: (bytesPerSecond / 1000).toFixed(0), unit: "kB/s" }
	return { value: Math.round(bytesPerSecond).toString(), unit: "B/s" }
}

export function formatRateText(bytesPerSecond) {
	const { value, unit } = formatRate(bytesPerSecond)
	return value === "—" ? "—" : `${value} ${unit}`
}

export function formatBytes(bytes) {
	if (bytes == null || !Number.isFinite(bytes)) return "—"
	const units = ["B", "kB", "MB", "GB", "TB"]
	let value = bytes
	let index = 0
	while (value >= 1000 && index < units.length - 1) {
		value /= 1000
		index += 1
	}
	const digits = index === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2
	return `${value.toFixed(digits)} ${units[index]}`
}

export function formatDuration(seconds) {
	if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—"
	const s = Math.floor(seconds)
	if (s < 60) return `${s} s`
	const m = Math.floor(s / 60)
	if (m < 60) return `${m} min`
	const h = Math.floor(m / 60)
	if (h < 48) return m % 60 === 0 ? `${h} h` : `${h} h ${m % 60} min`
	const d = Math.floor(h / 24)
	return h % 24 === 0 ? `${d} d` : `${d} d ${h % 24} h`
}

/** Second-precise age for the plot marker, e.g. "1 min 24 s ago". */
export function formatAgePrecise(ms) {
	if (ms == null || !Number.isFinite(ms)) return "—"
	const s = Math.round(ms / 1000)
	if (s < 2) return "now"
	if (s < 60) return `${s} s ago`
	return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s ago`
}

export function formatAge(ms) {
	if (ms == null || !Number.isFinite(ms)) return "never"
	if (ms < 1500) return "just now"
	return `${formatDuration(ms / 1000)} ago`
}

/** Exponential backoff after consecutive failures, bounded. */
export function nextDelay(consecutiveFailures) {
	if (consecutiveFailures <= 0) return POLL_INTERVAL_MS
	return Math.min(
		MAX_BACKOFF_MS,
		POLL_INTERVAL_MS * 2 ** Math.min(consecutiveFailures, 4),
	)
}

/** The page's own connection to the Pi. Never "live" on old data. */
export function linkState({ lastSuccessAt, consecutiveFailures, now, hidden }) {
	if (lastSuccessAt == null) {
		return consecutiveFailures > 0
			? { state: "offline", text: "Pi unreachable" }
			: { state: "connecting", text: "Connecting" }
	}
	const age = now - lastSuccessAt
	if (hidden) return { state: "stale", text: "Paused" }
	if (consecutiveFailures > 0) {
		return age > SNAPSHOT_STALE_MS
			? { state: "offline", text: `Lost · ${formatAge(age)}` }
			: { state: "reconnecting", text: "Reconnecting" }
	}
	if (age > SNAPSHOT_STALE_MS)
		return { state: "stale", text: `Stale · ${formatAge(age)}` }
	return { state: "live", text: "Live" }
}

/**
 * The one answer the page leads with: is IQ really flowing from the dongle?
 * Built only from upstream evidence; USB presence and processes are context.
 */
export function verdict({ status, host, fresh, failures = 0 }) {
	if (!status) {
		return failures > 0
			? {
					state: "fault",
					title: "No answer from the Pi",
					detail:
						"The receiver's status service is not responding. The page keeps retrying.",
				}
			: {
					state: "unknown",
					title: "Waiting for the Pi",
					detail: "No reading yet.",
				}
	}
	const sampling = status.sampling
	if (!sampling) {
		return {
			state: "unknown",
			title: "Flow not reported",
			detail: "This receiver version reports processes only, not sample flow.",
		}
	}
	if (!fresh) {
		return {
			state: "unknown",
			title: "No current reading",
			detail:
				"The page lost contact with the Pi; the last reading is not shown as current.",
		}
	}
	const cause = likelyCause(status, host)
	const upstream = sampling.upstream ?? {}
	// During first boot no samples are expected yet: lead with setup, not a fault.
	const setup = host?.setup?.state === "unavailable" ? null : host?.setup?.value
	if (sampling.state !== "streaming" && setup) {
		if (setup.state === "running") {
			return {
				state: "unknown",
				title: "Setting up",
				detail: `${capitalize(phaseLabel(setup.phase))}${forDuration(setup.updatedAgeMs)}. Samples start when setup finishes.`,
			}
		}
		if (setup.state === "failed" || setup.state === "interrupted") {
			return {
				state: "fault",
				title: "Setup did not finish",
				detail: setupLine(host.setup).text,
			}
		}
	}
	switch (sampling.state) {
		case "streaming": {
			if (upstream.rateStatus === "low") {
				const percent = upstream.expectedBytesPerSec
					? Math.round(
							(upstream.bytesPerSec / upstream.expectedBytesPerSec) * 100,
						)
					: null
				return {
					state: "warn",
					title: "Sampling, below rate",
					detail: `${percent === null ? "Below the expected rate." : `${percent}% of the expected rate.`} The dongle is delivering fewer samples than configured.${cause ? ` ${cause}` : ""}`,
				}
			}
			const undervoltage =
				host?.power?.undervoltageNow?.value === true
					? " The Pi reports under-voltage right now; watch for drops."
					: ""
			return {
				state: "ok",
				title: "Sampling",
				detail: `Fresh samples are arriving from the dongle.${undervoltage}`,
			}
		}
		case "waiting":
			return {
				state: "unknown",
				title: "Waiting for samples",
				detail: "The receiver started recently; evidence needs a few seconds.",
			}
		case "stale":
			return {
				state: "fault",
				title: "Samples stopped",
				detail: `${sampling.lastSampleAt === null ? "No samples since the receiver started." : `Last sample ${formatAge(sampling.sampleAgeMs)}.`}${cause ? ` ${cause}` : ""}`,
			}
		case "disconnected":
			return {
				state: "fault",
				title: "Receiver stopped",
				detail: `${sampling.reason ? `The receiver reports: ${sampling.reason}.` : "A receiver process is not running."}${cause ? ` ${cause}` : ""}`,
			}
		default:
			return {
				state: "unknown",
				title: "Flow unknown",
				detail:
					"The fan-out's byte counters cannot be read, so sampling cannot be confirmed.",
			}
	}
}

function likelyCause(status, host) {
	if (status.dongle && status.dongle.present === false)
		return "No dongle is detected on USB."
	if (status.dongle?.driverConflict)
		return `The ${status.dongle.conflictingDriver} driver has claimed the dongle.`
	if (host?.power?.undervoltageNow?.value === true)
		return "The Pi reports under-voltage right now."
	if (
		status.sampling?.state === "stale" &&
		status.dongle?.present &&
		status.rtlTcp?.running &&
		status.rtlmux?.running
	)
		return "The dongle and receiver processes are present, but rtl_tcp is not delivering samples."
	return ""
}

function capitalize(text) {
	return text.charAt(0).toUpperCase() + text.slice(1)
}

/** rtl_tcp sends 2 bytes (U8 I + Q) per sample, so bytes/s fix the sample rate. */
const BYTES_PER_SAMPLE = 2

function formatSampleRate(samplesPerSec, digits = 3) {
	return `${(samplesPerSec / 1e6).toFixed(digits)}\u00a0MS/s`
}

function formatFrequency(hz) {
	return `${(hz / 1e6).toFixed(3)}\u00a0MHz`
}

/**
 * The headline rate and what it means as a sample rate. A configured rate is
 * quoted as configured; once a client has set its own rate, the sample rate
 * is derived from the measured bytes and labelled as such.
 */
export function flowRate(status, fresh) {
	const upstream = status?.sampling?.upstream
	const measured = fresh ? (upstream?.bytesPerSec ?? null) : null
	const expected = upstream?.expectedBytesPerSec ?? null
	let sub = "No current reading"
	if (measured !== null && expected)
		sub = `${formatSampleRate(expected / BYTES_PER_SAMPLE)} · ${Math.round((measured / expected) * 100)}% of expected`
	else if (measured !== null && upstream?.rateBasis === "client-controlled")
		sub =
			measured > 0
				? `≈${formatSampleRate(measured / BYTES_PER_SAMPLE, 2)} derived · set by a client`
				: "Rate set by a client"
	else if (measured !== null) sub = "No expected rate"
	return { ...formatRate(measured), sub }
}

/** The IQ stream WaveKit connects to: where, from which dongle, tuned how, to whom. */
export function stream(status, piNow = null) {
	if (!status) return null
	const dongle = status.dongle ?? {}
	const restarts = status.rtlTcp?.restartCount ?? 0
	const config = status.rtlTcp?.config
	const tuned = config
		? [
				formatFrequency(config.frequency),
				formatSampleRate(config.sampleRate),
				config.agc ? "AGC" : `gain\u00a0${config.gain}\u00a0dB`,
			].join(" · ")
		: null
	const delivery = status.delivery
	return {
		endpoint: status.rtlmux?.endpoint ?? null,
		dongle: !dongle.present
			? {
					state: "fault",
					text: "Not detected",
					sub: "Check the USB connection",
				}
			: dongle.driverConflict
				? {
						state: "fault",
						text: "Claimed by another driver",
						sub: `${dongle.conflictingDriver ?? "A kernel driver"} holds the device`,
					}
				: {
						state: "ok",
						text: dongle.product ?? "RTL-SDR",
						sub:
							restarts > 0
								? `IQ server restarted ${restarts} time${restarts === 1 ? "" : "s"}`
								: "",
					},
		tuning:
			status.sampling?.upstream?.rateBasis === "client-controlled"
				? { text: "Set by a client", sub: tuned ? `Started at ${tuned}` : "" }
				: { text: tuned ?? "Not reported", sub: "" },
		clientsKnown: delivery != null && delivery.state !== "unknown",
		clients: (delivery?.clients ?? []).map(c => {
			const behind = c.droppedBytesLast60s > 0
			const since =
				piNow && c.connectedAt
					? Date.parse(piNow) - Date.parse(c.connectedAt)
					: Number.NaN
			// Connected but receiving nothing is not healthy delivery.
			const flowing = (c.queuedBytesPerSec ?? 0) > 0
			return {
				address: c.address,
				state: behind ? "warn" : flowing ? "ok" : "unknown",
				rate:
					c.queuedBytesPerSec === null
						? "Measuring"
						: formatRateText(c.queuedBytesPerSec),
				health: behind
					? `Falling behind · ${formatBytes(c.droppedBytesLast60s)} dropped in the last minute`
					: flowing
						? "keeping up"
						: "",
				since: Number.isFinite(since)
					? `for ${formatDuration(Math.max(0, since) / 1000)}`
					: "",
			}
		}),
	}
}

/** Host trends by channel, as [ageMs, value | null] points. */
export function trends(host) {
	const history = host?.history
	if (!history) return null
	const pick = index => history.points.map(point => [point[0], point[index]])
	return {
		windowMs: history.windowMs,
		cpu: pick(1),
		memory: pick(2),
		temperature: pick(3),
		dips: pick(4),
	}
}

/** Dips counted in the trend window, or null when none were measurable. */
export function recentDips(host) {
	const measured = (host?.history?.points ?? []).filter(p => p[4] !== null)
	if (measured.length === 0) return null
	return {
		count: measured.reduce((sum, p) => sum + p[4], 0),
		spanMs: Math.max(...measured.map(p => p[0])) + host.history.intervalMs,
	}
}

/**
 * Power as one fact: is the supply holding right now, and how often has it
 * dipped. Throttling cannot be read from the container; it stays in
 * diagnostics rather than taking a row of its own.
 */
export function power(host) {
	const now = host?.power?.undervoltageNow
	if (!now || now.state === "unavailable")
		return {
			state: "unknown",
			text: "Not measurable",
			sub: now?.reason ?? "not reported",
		}
	const observed = host.power.undervoltageObserved?.value
	const recent = recentDips(host)
	const stale = staleSuffix(now)
	const dips = n => `${n} ${n === 1 ? "dip" : "dips"}`
	const lately =
		recent && recent.count > 0
			? `${dips(recent.count)} in the last ${formatDuration(recent.spanMs / 1000)}`
			: null
	const total = observed
		? `${dips(observed.events)} since the receiver started ${formatDuration(observed.coveredMs / 1000)} ago`
		: null
	if (now.value)
		return {
			state: "fault",
			text: `Under-voltage now${stale}`,
			sub: lately ?? total ?? "",
		}
	if (lately)
		return {
			state: "warn",
			text: `Fine now${stale}`,
			sub: `${lately}${observed ? `, ${observed.events} since the receiver started` : ""}`,
		}
	return {
		state: "ok",
		text: `Fine${stale}`,
		sub: !observed
			? ""
			: observed.events === 0
				? `No dips in ${formatDuration(observed.coveredMs / 1000)}`
				: `${total}; last ${formatAge(observed.lastAgeMs)}`,
	}
}

/**
 * Wi-Fi signal as bars, after common Wi-Fi survey guidance: −67 dBm is the
 * usual floor for reliable streaming, and the IQ stream needs ~4 MB/s.
 *   ≥ −55 dBm  4 bars  Excellent
 *   ≥ −67 dBm  3 bars  Good
 *   ≥ −75 dBm  2 bars  Fair (warn)
 *   below      1 bar   Weak (warn)
 */
export function wifiBars(dbm) {
	if (dbm >= -55) return { bars: 4, word: "Excellent", warn: false }
	if (dbm >= -67) return { bars: 3, word: "Good", warn: false }
	if (dbm >= -75) return { bars: 2, word: "Fair", warn: true }
	return { bars: 1, word: "Weak", warn: true }
}

function unavailable(reading) {
	return {
		state: "unavailable",
		value: "Unavailable",
		sub: reading?.reason ?? "not reported",
	}
}

function staleSuffix(reading) {
	return reading.state === "stale" ? ` · ${formatAge(reading.ageMs)} old` : ""
}

/** Host readouts; every value carries its freshness. */
export function readouts(host) {
	if (!host) return null
	const out = {}
	const { cpu, load, memory, disk, temperature, network, uptime } = host
	const tone = (reading, warn, fault = false) =>
		reading.state === "stale" ? "stale" : fault ? "fault" : warn ? "warn" : "ok"

	if (!cpu?.value) out.cpu = unavailable(cpu)
	else {
		const busy = cpu.value.busyPercent
		out.cpu = {
			state: tone(cpu, busy >= 90),
			value: `${Math.round(busy)}%`,
			sub: `${load?.value ? `load ${load.value.one.toFixed(2)} · ` : ""}${cpu.value.cores} cores${staleSuffix(cpu)}`,
		}
	}

	if (!memory?.value) out.memory = unavailable(memory)
	else {
		const { totalBytes, availableBytes } = memory.value
		out.memory = {
			state: tone(memory, availableBytes / totalBytes < 0.1),
			value: `${Math.round(((totalBytes - availableBytes) / totalBytes) * 100)}%`,
			sub: `${formatBytes(availableBytes)} free of ${formatBytes(totalBytes)}${staleSuffix(memory)}`,
		}
	}

	if (!temperature?.value) out.temperature = unavailable(temperature)
	else {
		const celsius = temperature.value.celsius
		out.temperature = {
			state: tone(temperature, celsius >= 70, celsius >= 80),
			value: `${celsius.toFixed(1)} °C`,
			sub: `${celsius >= 80 ? "hot enough to throttle" : "throttles near 80 °C"}${staleSuffix(temperature)}`,
		}
	}

	if (!disk?.value) out.disk = unavailable(disk)
	else
		out.disk = {
			state: tone(disk, disk.value.availableBytes < 1e9),
			value: `${formatBytes(disk.value.availableBytes)} free`,
			sub: `${Math.round((disk.value.usedBytes / disk.value.totalBytes) * 100)}% of ${formatBytes(disk.value.totalBytes)} used${staleSuffix(disk)}`,
		}

	const link = primaryInterface(network)
	if (!link)
		out.network = unavailable(
			network?.state === "ok" ? { reason: "no connected interface" } : network,
		)
	else {
		const signal = link.wireless?.signalDbm
		const wifi = signal === undefined ? null : wifiBars(signal)
		const facts = [
			signal === undefined
				? null
				: `${String(signal).replace("-", "\u2212")} dBm`,
			link.txBytesPerSec === null
				? null
				: `${formatRateText(link.txBytesPerSec)} out`,
			link.addresses[0] ?? link.name,
		]
		out.network = {
			state: tone(network, wifi?.warn ?? false),
			value:
				link.kind === "wireless"
					? `Wi-Fi${wifi ? ` · ${wifi.word}` : ""}`
					: link.kind === "ethernet"
						? "Ethernet"
						: link.name,
			sub: `${facts.filter(Boolean).join(" · ")}${staleSuffix(network)}`,
			bars: wifi?.bars ?? null,
		}
	}

	if (!uptime?.value) out.uptime = unavailable(uptime)
	else {
		// An unexpected restart is news for the first day, then just history.
		const boot = lastBoot(host)
		out.uptime = {
			state: tone(uptime, boot.unexpected && uptime.value.hostSec < 24 * 3600),
			value: formatDuration(uptime.value.hostSec),
			sub: boot.unexpected
				? boot.text
				: `receiver service ${formatDuration(uptime.value.serviceSec)}`,
		}
	}
	return out
}

/**
 * How the previous boot ended, from the image's boot report: a clean shutdown
 * is a requested reboot or power-off; anything else is unexpected (power loss
 * or crash; the record cannot say which, but under-voltage since this boot and
 * a watchdog reset are named when the firmware reports them).
 */
export function lastBoot(host) {
	const reading = host?.lastBoot
	if (!reading?.value)
		return {
			unexpected: false,
			text: `Not recorded: ${reading?.reason ?? "not reported"}`,
		}
	const { previous, undervoltageSinceBoot, watchdogReset } = reading.value
	if (!previous)
		return { unexpected: false, text: "No earlier boot in the journal" }
	const last =
		previous.lastEntryAgeMs === null
			? ""
			: ` · last log before it ${formatAge(previous.lastEntryAgeMs)}`
	if (previous.cleanShutdown)
		return { unexpected: false, text: `Requested reboot or power-off${last}` }
	const signs = [
		undervoltageSinceBoot ? "under-voltage since this boot" : null,
		watchdogReset ? "watchdog reset" : null,
	].filter(Boolean)
	return {
		unexpected: true,
		text: `Unexpected restart${last}${signs.length ? ` · ${signs.join(" · ")}` : ""}`,
	}
}

/** The interface carrying traffic: up, addressed, busiest first. */
export function primaryInterface(network) {
	if (!network?.value?.length) return null
	const ranked = [...network.value]
		.filter(i => i.operstate === "up" || i.addresses.length > 0)
		.sort(
			(a, b) =>
				(b.txBytesPerSec ?? 0) - (a.txBytesPerSec ?? 0) ||
				b.addresses.length - a.addresses.length,
		)
	return ranked[0] ?? null
}

export function setupLine(reading) {
	if (!reading || reading.state === "unavailable") {
		return {
			state: "unknown",
			text: `Not reported: ${reading?.reason ?? "unavailable"}`,
		}
	}
	const v = reading.value
	// Ages are measured on the Pi, so a browser on another clock cannot skew them.
	const ago = v.updatedAgeMs == null ? "" : ` ${formatAge(v.updatedAgeMs)}`
	switch (v.state) {
		case "complete":
			return { state: "ok", text: `Complete · finished${ago}` }
		case "running":
			return {
				state: "ok",
				text: `In progress · ${phaseLabel(v.phase)}${forDuration(v.updatedAgeMs)}`,
			}
		case "interrupted":
			return {
				state: "fault",
				text: `Interrupted by a restart during ${phaseLabel(v.phase)}. Restart wavekit-firstboot to retry.`,
			}
		default:
			return {
				state: "fault",
				text: `Failed${v.exitCode ? ` (exit ${v.exitCode})` : ""}${ago}. Details: wavekit-setup.log on the boot partition.`,
			}
	}
}

function forDuration(ms) {
	return ms == null ? "" : ` for ${formatDuration(ms / 1000)}`
}

function phaseLabel(phase) {
	return (
		{
			"cloud-init": "waiting for system setup",
			install: "installing the receiver",
			publish: "finishing up",
			done: "done",
		}[phase] ?? "setup"
	)
}

/**
 * SVG path for the rate trace from server history points [ageMs, bytesPerSec|null].
 * Null points break the line so gaps remain visibly missing.
 */
export function tracePath(points, { windowMs, width, height, max }) {
	let d = ""
	let area = ""
	let pen = false
	let runX = null
	let lastX = null
	const base = height.toFixed(1)
	const close = () => {
		if (runX !== null) area += `L${lastX} ${base}L${runX} ${base}Z`
		runX = null
	}
	// Oldest first.
	const ordered = [...points].sort((a, b) => b[0] - a[0])
	for (const [age, value] of ordered) {
		if (age > windowMs) continue
		const x = width - (age / windowMs) * width
		if (value === null) {
			pen = false
			close()
			continue
		}
		const y = height - Math.min(1, Math.max(0, value / max)) * height
		const at = `${x.toFixed(1)} ${y.toFixed(1)}`
		d += `${pen ? "L" : "M"}${at}`
		if (runX === null) {
			runX = x.toFixed(1)
			area += `M${runX} ${base}`
		}
		area += `L${at}`
		lastX = x.toFixed(1)
		pen = true
	}
	close()
	return { d, area }
}

/**
 * Trailing mean over the server's own rate window, so the trace reads the same
 * quantity as the headline figure. Per-poll counts arrive in whole rtlmux
 * chunks, which makes single samples saw-tooth around the true rate. Averages
 * never reach across a missing sample: gaps stay gaps.
 */
const TRACE_AVERAGE_MS = 10_000
export function smoothTrace(points, spanMs = TRACE_AVERAGE_MS) {
	const ordered = [...points].sort((a, b) => b[0] - a[0])
	const out = []
	let run = []
	for (const [age, value] of ordered) {
		if (value === null) {
			run = []
			out.push([age, null])
			continue
		}
		run.push([age, value])
		run = run.filter(([older]) => older - age < spanMs)
		out.push([age, run.reduce((sum, [, v]) => sum + v, 0) / run.length])
	}
	return out
}

/** Full scale: a round figure with headroom over the expected rate and the peak. */
export function plotMax(expected, points) {
	const peak = points.reduce((m, [, v]) => (v !== null && v > m ? v : m), 0)
	const top = Math.max(expected ?? 0, peak) * 1.1
	if (!(top > 0)) return 1
	const decade = 10 ** Math.floor(Math.log10(top))
	const step = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10].find(m => m * decade >= top)
	return (step ?? 10) * decade
}

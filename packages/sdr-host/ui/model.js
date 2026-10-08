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
	if (bytesPerSecond >= 0.1 * MB)
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
export function verdict({ status, host, fresh }) {
	if (!status) {
		return {
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
					detail: `${percent === null ? "Below the expected rate." : `${percent}% of the expected rate.`} Samples are being lost before rtlmux.${cause ? ` ${cause}` : ""}`,
				}
			}
			return {
				state: "ok",
				title: "Sampling",
				detail:
					upstream.rateBasis === "client-controlled"
						? "Fresh samples from the dongle. A client changed the receiver settings, so the expected rate is unknown."
						: "Fresh samples are arriving from the dongle.",
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
				detail: `${capitalize(sampling.reason ?? "A receiver process is not running")}.${cause ? ` ${cause}` : ""}`,
			}
		default:
			return {
				state: "unknown",
				title: "Flow unknown",
				detail:
					"rtlmux counters cannot be read, so sampling cannot be confirmed.",
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

/** Receiver chain: presence of each stage, separate from the flow verdict. */
export function stages(status) {
	if (!status) return null
	const dongle = status.dongle ?? {}
	const restarts = n => (n > 0 ? ` · ${n} restart${n === 1 ? "" : "s"}` : "")
	const process = p =>
		p?.running
			? {
					state: "ok",
					word: "Running",
					fact: `pid ${p.pid}${restarts(p.restartCount)}`,
				}
			: {
					state: "fault",
					word: "Stopped",
					fact: p
						? `${p.restartCount} restart${p.restartCount === 1 ? "" : "s"}`
						: "",
				}
	const delivery = status.delivery
	let clients = {
		state: "unknown",
		word: "Unknown",
		fact: "counters unavailable",
	}
	if (delivery?.state === "idle")
		clients = { state: "idle", word: "None", fact: "delivery idle" }
	else if (delivery?.state === "delivering")
		clients = {
			// Connected but nothing flowing out is not healthy delivery.
			state: delivery.queuedBytesPerSec ? "ok" : "idle",
			word: `${delivery.clients.length} connected`,
			fact:
				delivery.queuedBytesPerSec === null
					? "measuring"
					: `${formatRateText(delivery.queuedBytesPerSec)} out`,
		}
	else if (delivery?.state === "dropping")
		clients = {
			state: "warn",
			word: "Dropping",
			fact: `${formatBytes(delivery.droppedBytesLast60s)} in 60 s`,
		}
	return {
		dongle: !dongle.present
			? { state: "fault", word: "Not detected", fact: "check USB" }
			: dongle.driverConflict
				? {
						state: "fault",
						word: "Driver conflict",
						fact: dongle.conflictingDriver ?? "",
					}
				: { state: "ok", word: "Present", fact: dongle.product ?? "RTL-SDR" },
		rtltcp: process(status.rtlTcp),
		rtlmux: process(status.rtlmux),
		clients,
	}
}

/** Power windows: active now, observed history, and what cannot be measured. */
export function power(host) {
	const now = host?.power?.undervoltageNow
	const observed = host?.power?.undervoltageObserved
	const throttling = host?.power?.throttling
	const windows = []
	windows.push(
		now?.state === "unavailable" || !now
			? {
					key: "now",
					label: "Under-voltage",
					state: "unknown",
					text: "Not measurable",
				}
			: now.value
				? {
						key: "now",
						label: "Under-voltage",
						state: "active",
						text: now.state === "stale" ? "Active · stale" : "Active now",
					}
				: {
						key: "now",
						label: "Under-voltage",
						state: "clear",
						text: now.state === "stale" ? "Clear · stale" : "Clear now",
					},
	)
	if (observed?.value && observed.value.events > 0) {
		windows.push({
			key: "history",
			label: "Earlier dips",
			state: "latched",
			text: `${observed.value.events} ${observed.value.events === 1 ? "dip" : "dips"} · ${observed.value.events === 1 ? "" : "last "}${formatAge(observed.value.lastAgeMs)}`,
		})
	} else {
		windows.push({
			key: "history",
			label: "Earlier dips",
			state: observed?.value ? "clear" : "unknown",
			text: observed?.value ? "None seen" : "Not measurable",
		})
	}
	windows.push({
		key: "throttling",
		label: "Throttling",
		state: throttling?.value
			? throttling.value.throttled
				? "active"
				: "clear"
			: "unknown",
		text: throttling?.value
			? throttling.value.throttled
				? "Active now"
				: "Clear now"
			: "Not measurable",
	})
	const notes = []
	if (observed?.value) {
		notes.push(
			`History covers the last ${formatDuration(observed.value.coveredMs / 1000)} (since the receiver service started), not since boot.`,
		)
	}
	if (throttling?.state === "unavailable")
		notes.push(
			"Throttle flags need firmware access the container does not have.",
		)
	if (now?.state === "unavailable" && now.reason)
		notes.push(`Under-voltage: ${now.reason}.`)
	return { windows, note: notes.join(" ") }
}

function freshness(reading) {
	if (!reading || reading.state === "unavailable") return "unavailable"
	return reading.state === "stale" ? "stale" : "ok"
}

function unavailable(reading) {
	return {
		state: "unavailable",
		value: "Unavailable",
		sub: reading?.reason ?? "not reported",
		fill: null,
	}
}

function staleSuffix(reading) {
	return reading.state === "stale" ? ` · ${formatAge(reading.ageMs)} old` : ""
}

/** Host readouts in display order; every value carries its freshness. */
export function readouts(host) {
	if (!host) return null
	const out = {}
	const { cpu, load, memory, disk, temperature, network, uptime } = host

	if (freshness(cpu) === "unavailable") out.cpu = unavailable(cpu)
	else {
		const busy = cpu.value.busyPercent
		out.cpu = {
			state: cpu.state === "stale" ? "stale" : busy >= 90 ? "warn" : "ok",
			value: `${Math.round(busy)}%`,
			sub: `${load?.value ? `load ${load.value.one.toFixed(2)} · ` : ""}${cpu.value.cores} cores${staleSuffix(cpu)}`,
			fill: busy,
		}
	}

	if (freshness(memory) === "unavailable") out.memory = unavailable(memory)
	else {
		const used = memory.value.totalBytes - memory.value.availableBytes
		const percent = (used / memory.value.totalBytes) * 100
		out.memory = {
			state:
				memory.state === "stale"
					? "stale"
					: memory.value.availableBytes / memory.value.totalBytes < 0.1
						? "warn"
						: "ok",
			value: `${Math.round(percent)}%`,
			sub: `${formatBytes(memory.value.availableBytes)} free of ${formatBytes(memory.value.totalBytes)}${staleSuffix(memory)}`,
			fill: percent,
		}
	}

	if (freshness(disk) === "unavailable") out.disk = unavailable(disk)
	else {
		const percent = (disk.value.usedBytes / disk.value.totalBytes) * 100
		out.disk = {
			state:
				disk.state === "stale"
					? "stale"
					: disk.value.availableBytes < 1e9
						? "warn"
						: "ok",
			value: `${Math.round(percent)}%`,
			sub: `${formatBytes(disk.value.availableBytes)} free · Docker storage${staleSuffix(disk)}`,
			fill: percent,
		}
	}

	if (freshness(temperature) === "unavailable")
		out.temperature = unavailable(temperature)
	else {
		const celsius = temperature.value.celsius
		out.temperature = {
			state:
				temperature.state === "stale"
					? "stale"
					: celsius >= 80
						? "fault"
						: celsius >= 70
							? "warn"
							: "ok",
			value: `${celsius.toFixed(1)} °C`,
			sub:
				celsius >= 80
					? `throttling expected at this temperature${staleSuffix(temperature)}`
					: `throttling expected near 80 °C${staleSuffix(temperature)}`,
			// Scale 20–85 °C.
			fill: Math.max(0, Math.min(100, ((celsius - 20) / 65) * 100)),
		}
	}

	const link = primaryInterface(network)
	if (!link)
		out.network = unavailable(
			network?.state === "ok" ? { reason: "no connected interface" } : network,
		)
	else {
		const signal = link.wireless?.signalDbm
		out.network = {
			state:
				network.state === "stale"
					? "stale"
					: signal !== undefined && signal < -70
						? "warn"
						: "ok",
			value:
				link.kind === "wireless"
					? signal !== undefined
						? `Wi-Fi ${String(signal).replace("-", "\u2212")} dBm`
						: "Wi-Fi"
					: link.kind === "ethernet"
						? "Ethernet"
						: link.name,
			sub: `${link.addresses[0] ?? link.name}${link.txBytesPerSec !== null ? ` · ${formatRateText(link.txBytesPerSec)} out` : ""}${staleSuffix(network)}`,
			fill: null,
		}
	}

	if (freshness(uptime) === "unavailable") out.uptime = unavailable(uptime)
	else
		out.uptime = {
			state: uptime.state === "stale" ? "stale" : "ok",
			value: formatDuration(uptime.value.hostSec),
			sub: `receiver service ${formatDuration(uptime.value.serviceSec)}`,
			fill: null,
		}
	return out
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
				state: "warn",
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
	let pen = false
	const gaps = []
	let gapStart = null
	// Oldest first.
	const ordered = [...points].sort((a, b) => b[0] - a[0])
	for (const [age, value] of ordered) {
		if (age > windowMs) continue
		const x = width - (age / windowMs) * width
		if (value === null) {
			pen = false
			gapStart ??= x
			continue
		}
		if (gapStart !== null) {
			gaps.push([gapStart, x])
			gapStart = null
		}
		const y = height - Math.min(1, Math.max(0, value / max)) * height
		d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`
		pen = true
	}
	if (gapStart !== null) gaps.push([gapStart, width])
	return { d, gaps }
}

/** Full-scale for the plot: room above the expected line and any peak. */
export function plotMax(expected, points) {
	const peak = points.reduce((m, [, v]) => (v !== null && v > m ? v : m), 0)
	const base = expected && expected > 0 ? expected * 1.25 : peak * 1.25
	return Math.max(base, peak * 1.1, 1)
}

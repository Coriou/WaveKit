// Operator page: polls the Pi's own API (same origin), one request pair in
// flight at a time, paused while the tab is hidden, backing off on failure.
import {
	REQUEST_TIMEOUT_MS,
	TRACE_AVERAGE_MS,
	formatAge,
	formatAgePrecise,
	formatBytes,
	formatRate,
	formatRateText,
	linkState,
	nextDelay,
	plotMax,
	power,
	readouts,
	setupLine,
	smoothTrace,
	stages,
	tracePath,
	verdict,
} from "./model.js"

const PLOT_W = 600
const PLOT_H = 200
const $ = id => document.getElementById(id)

const state = {
	status: null,
	host: null,
	/** performance.now() of the last successful snapshot. */
	receivedAt: null,
	failures: 0,
	timer: null,
	controller: null,
	marker: null,
}

async function getJson(url, signal) {
	const response = await fetch(url, {
		signal,
		cache: "no-store",
		headers: { accept: "application/json" },
	})
	if (!response.ok) throw new Error(`${url} ${response.status}`)
	return response.json()
}

async function poll() {
	clearTimeout(state.timer)
	if (document.hidden) {
		renderLink()
		return
	}
	state.controller?.abort()
	const controller = new AbortController()
	state.controller = controller
	const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
	try {
		const [status, host] = await Promise.all([
			getJson("api/status", controller.signal),
			getJson("api/host", controller.signal),
		])
		state.status = status
		state.host = host
		state.receivedAt = performance.now()
		state.failures = 0
	} catch {
		if (state.controller !== controller) return
		state.failures += 1
	} finally {
		clearTimeout(timeout)
	}
	if (state.controller !== controller) return
	state.controller = null
	render()
	state.timer = setTimeout(poll, nextDelay(state.failures))
}

function isFresh() {
	const link = linkState(linkInput())
	return link.state === "live" || link.state === "reconnecting"
}

function linkInput() {
	return {
		lastSuccessAt: state.receivedAt,
		consecutiveFailures: state.failures,
		now: performance.now(),
		hidden: document.hidden,
	}
}

function render() {
	renderLink()
	renderScreen()
	renderChain()
	renderPower()
	renderReadouts()
	renderSetup()
	renderDiagnostics()
}

function renderLink() {
	const link = linkState(linkInput())
	$("link").dataset.state = link.state
	$("link-text").textContent = link.text
}

let lastVerdictTitle = ""
function renderScreen() {
	const v = verdict({
		status: state.status,
		host: state.host,
		fresh: isFresh(),
	})
	$("screen").dataset.state = v.state
	// Only state changes are announced; numbers update silently.
	if (v.title !== lastVerdictTitle) {
		$("verdict").textContent = v.title
		lastVerdictTitle = v.title
	}
	$("verdict-detail").textContent = v.detail

	const sampling = state.status?.sampling
	const upstream = sampling?.upstream
	const rate = formatRate(isFresh() ? upstream?.bytesPerSec : null)
	$("rate-value").textContent = rate.value
	$("rate-unit").textContent = rate.value === "—" ? "" : rate.unit
	$("screen").dataset.fresh = String(isFresh())
	const expected = upstream?.expectedBytesPerSec
	// The expected figure is printed on its line in the plot; here only the ratio.
	if (expected && upstream?.bytesPerSec != null && isFresh()) {
		$("rate-expected").textContent =
			`${Math.round((upstream.bytesPerSec / expected) * 100)}% of expected`
	} else if (expected) {
		// The expected rate stays labelled on its line in the plot.
		$("rate-expected").textContent = "No current reading"
	} else {
		$("rate-expected").textContent =
			upstream?.rateBasis === "client-controlled"
				? "Rate set by a client"
				: "No expected rate"
	}
	renderPlot()
}

function renderPlot() {
	const history = state.status?.samplingHistory
	const points = history?.points ?? []
	const windowMs = history?.windowMs ?? 300_000
	const expected = state.status?.sampling?.upstream?.expectedBytesPerSec ?? null
	const max = plotMax(expected, points)
	// Age the snapshot by the time since it arrived so the trace keeps scrolling honestly.
	const drift =
		state.receivedAt == null ? 0 : performance.now() - state.receivedAt
	const aged = smoothTrace(points).map(([age, value]) => [age + drift, value])
	const trace = tracePath(aged, {
		windowMs,
		width: PLOT_W,
		height: PLOT_H,
		max,
	})
	$("plot-trace").setAttribute("d", trace.d)
	$("plot-area").setAttribute("d", trace.area)
	$("plot-gaps").setAttribute(
		"d",
		trace.gaps
			.map(
				([a, b]) =>
					`M${a.toFixed(1)} 0H${b.toFixed(1)}V${PLOT_H}H${a.toFixed(1)}Z`,
			)
			.join(""),
	)
	const y = expected ? PLOT_H - (expected / max) * PLOT_H : -10
	$("plot-expected").setAttribute("y1", y.toFixed(1))
	$("plot-expected").setAttribute("y2", y.toFixed(1))
	// Label the dashed line where it is drawn, instead of a key below the plot.
	const label = $("plot-label-expected")
	label.hidden = !expected
	label.textContent = expected ? `Expected ${formatRateText(expected)}` : ""
	label.style.top = `${((y / PLOT_H) * 100).toFixed(2)}%`
	$("plot-scale").textContent = [
		`${Math.round(windowMs / 10 / 1000)} s/div`,
		`${Math.round(TRACE_AVERAGE_MS / 1000)} s average`,
		...(expected ? [] : [`full scale ${formatRateText(max)}`]),
	].join(" · ")
	state.plot = { points: aged, windowMs, max }
	if (state.marker !== null) placeMarker(state.marker)
}

function drawGraticule() {
	const g = $("graticule")
	const ns = "http://www.w3.org/2000/svg"
	for (let i = 0; i <= 10; i++) {
		const line = document.createElementNS(ns, "line")
		const x = (PLOT_W / 10) * i
		line.setAttribute("x1", x)
		line.setAttribute("x2", x)
		line.setAttribute("y1", 0)
		line.setAttribute("y2", PLOT_H)
		if (i === 0 || i === 10) line.setAttribute("class", "major")
		g.append(line)
	}
	// Five divisions: the expected rate lands on the fourth (see plotMax).
	for (let i = 0; i <= 5; i++) {
		const line = document.createElementNS(ns, "line")
		const yy = (PLOT_H / 5) * i
		line.setAttribute("x1", 0)
		line.setAttribute("x2", PLOT_W)
		line.setAttribute("y1", yy)
		line.setAttribute("y2", yy)
		if (i === 5) line.setAttribute("class", "major")
		g.append(line)
	}
}

/** Marker: read time and rate off the real samples; gaps read as "no data". */
function placeMarker(fraction) {
	const plot = state.plot
	if (!plot) return
	state.marker = Math.max(0, Math.min(1, fraction))
	const ageAtMarker = (1 - state.marker) * plot.windowMs
	let nearest = null
	for (const point of plot.points) {
		if (
			nearest === null ||
			Math.abs(point[0] - ageAtMarker) < Math.abs(nearest[0] - ageAtMarker)
		)
			nearest = point
	}
	const near =
		nearest && Math.abs(nearest[0] - ageAtMarker) < 6000 ? nearest : null
	const x = near
		? PLOT_W - (near[0] / plot.windowMs) * PLOT_W
		: state.marker * PLOT_W
	const value = near?.[1] ?? null
	const yy =
		value === null ? PLOT_H : PLOT_H - Math.min(1, value / plot.max) * PLOT_H
	$("marker-line").setAttribute("x1", x)
	$("marker-line").setAttribute("x2", x)
	$("marker-dot").setAttribute("cx", x)
	$("marker-dot").setAttribute("cy", yy)
	$("marker-dot").style.display = value === null ? "none" : ""
	// SVG elements have no `hidden` property; toggle the attribute itself.
	$("plot-marker").removeAttribute("hidden")
	$("plot-frame").dataset.marker = "on"
	const readout = $("marker-readout")
	readout.hidden = false
	const ago = formatAgePrecise(near ? near[0] : ageAtMarker)
	readout.textContent = `${ago} · ${value === null ? "no data" : formatRateText(value)}`
	const svg = $("plot")
	const box = svg.getBoundingClientRect()
	const px = (x / PLOT_W) * box.width
	readout.style.left = `${Math.min(Math.max(0, px - readout.offsetWidth / 2), box.width - readout.offsetWidth)}px`
}

function hideMarker() {
	state.marker = null
	$("plot-marker").setAttribute("hidden", "")
	$("marker-readout").hidden = true
	delete $("plot-frame").dataset.marker
}

function bindPlot() {
	const svg = $("plot")
	const fractionOf = event => {
		const box = svg.getBoundingClientRect()
		return (event.clientX - box.left) / box.width
	}
	svg.addEventListener("pointermove", event => placeMarker(fractionOf(event)))
	svg.addEventListener("pointerdown", event => placeMarker(fractionOf(event)))
	svg.addEventListener("pointerleave", event => {
		if (event.pointerType === "mouse") hideMarker()
	})
	svg.addEventListener("keydown", event => {
		const step = event.shiftKey ? 0.1 : 0.02
		if (event.key === "ArrowLeft") placeMarker((state.marker ?? 1) - step)
		else if (event.key === "ArrowRight") placeMarker((state.marker ?? 1) + step)
		else if (event.key === "Escape") hideMarker()
		else return
		event.preventDefault()
	})
	svg.addEventListener("blur", hideMarker)
}

function renderChain() {
	const chain = stages(state.status)
	const fresh = isFresh()
	for (const [key, id] of [
		["dongle", "stage-dongle"],
		["rtltcp", "stage-rtltcp"],
		["rtlmux", "stage-rtlmux"],
		["clients", "stage-clients"],
	]) {
		const el = $(id)
		const stage = chain?.[key]
		el.dataset.state = stage && fresh ? stage.state : "unknown"
		el.querySelector(".stage__word").textContent = stage ? stage.word : "—"
		el.querySelector(".stage__fact").textContent = stage
			? fresh
				? stage.fact
				: "last known"
			: ""
	}
}

function renderPower() {
	const p = power(state.host)
	for (const window of p.windows) {
		const el = document.querySelector(`.annunciator[data-key="${window.key}"]`)
		if (!el) continue
		el.dataset.state = isFresh() ? window.state : "unknown"
		el.querySelector("small").textContent = isFresh()
			? window.text
			: "No current reading"
	}
	$("power-note").textContent = p.note
}

function renderReadouts() {
	const values = readouts(state.host)
	const fresh = isFresh()
	for (const el of document.querySelectorAll(".readout")) {
		const r = values?.[el.dataset.key]
		el.dataset.state = !r ? "unavailable" : fresh ? r.state : "stale"
		el.querySelector(".readout__value").textContent = r ? r.value : "—"
		el.querySelector(".readout__sub").textContent = r
			? fresh
				? r.sub
				: `last known · ${r.sub}`
			: ""
		const meter = el.querySelector(".meter > span")
		if (meter)
			meter.style.setProperty(
				"--fill",
				r?.fill == null
					? "0"
					: String(Math.max(0, Math.min(100, r.fill)) / 100),
			)
	}
}

function renderSetup() {
	const line = setupLine(state.host?.setup)
	const fresh = isFresh()
	// A finished (or unreported) setup is history: it moves to diagnostics.
	const setup = state.host?.setup
	$("setup-section").hidden =
		!setup?.value ||
		setup.state === "unavailable" ||
		setup.value.state === "complete"
	$("setup").dataset.state = fresh ? line.state : "unknown"
	$("setup-text").textContent =
		fresh || !state.host ? line.text : `Last known: ${line.text}`
}

function renderDiagnostics() {
	const status = state.status
	if (!status) return
	const tbody = $("clients")
	const clients = status.delivery?.clients ?? []
	tbody.replaceChildren(
		...(clients.length === 0
			? [
					row(
						[
							"No downstream clients. rtlmux keeps reading the dongle; WaveKit connects here.",
							"",
							"",
						],
						true,
					),
				]
			: clients.map(c =>
					row([
						c.address,
						c.queuedBytesPerSec === null
							? "measuring"
							: formatRateText(c.queuedBytesPerSec),
						c.droppedBytes > 0
							? `${formatBytes(c.droppedBytes)} (${formatBytes(c.droppedBytesLast60s)} / 60 s)`
							: "none",
					]),
				)),
	)
	const s = status.sampling
	const pid = (name, p) => (p?.pid == null ? null : `${name} ${p.pid}`)
	const pids = [pid("rtl_tcp", status.rtlTcp), pid("rtlmux", status.rtlmux)]
		.filter(Boolean)
		.join(" · ")
	facts($("facts-receiver"), [
		["IQ endpoint", status.rtlmux?.endpoint],
		["Process ids", pids || null],
		["First-boot setup", state.host ? setupLine(state.host.setup).text : null],
		[
			"Configured rate",
			status.rtlTcp?.config
				? `${(status.rtlTcp.config.sampleRate / 1e6).toFixed(3)} MS/s`
				: null,
		],
		[
			"Initial frequency",
			status.rtlTcp?.config
				? `${(status.rtlTcp.config.frequency / 1e6).toFixed(4)} MHz`
				: null,
		],
		[
			"Gain",
			status.rtlTcp?.config
				? status.rtlTcp.config.agc
					? "AGC"
					: `${status.rtlTcp.config.gain} dB`
				: null,
		],
		[
			"Read from dongle",
			s?.upstream?.bytesTotal != null
				? formatBytes(s.upstream.bytesTotal)
				: null,
		],
		["Last sample", s?.lastSampleAt ? formatAge(s.sampleAgeMs) : "none yet"],
		[
			"Counter resets",
			s?.epoch
				? `${s.epoch.resets}${s.epoch.lastResetReason ? ` · ${s.epoch.lastResetReason}` : ""}`
				: null,
		],
		[
			"Drops since start",
			status.delivery
				? formatBytes(status.delivery.droppedBytesSinceMonitorStart)
				: null,
		],
		[
			"rtlmux counters",
			s
				? `${s.stats.state}${s.stats.lastError ? ` · ${s.stats.lastError}` : ""}`
				: null,
		],
	])
	const h = state.host
	if (!h) return
	const describe = reading =>
		reading.state === "unavailable"
			? `unavailable · ${reading.reason}`
			: `${scopeLabel(reading.scope)} · ${reading.state === "stale" ? `stale, ${formatAge(reading.ageMs)} old` : "fresh"}`
	facts($("facts-sources"), [
		["CPU, load, memory", describe(h.cpu)],
		[
			"Temperature",
			h.temperature.value
				? `${describe(h.temperature)} · ${h.temperature.value.zone}`
				: describe(h.temperature),
		],
		["Storage", describe(h.disk)],
		["Network", describe(h.network)],
		["Under-voltage", describe(h.power.undervoltageNow)],
		["Throttling", describe(h.power.throttling)],
		[
			"Receiver container",
			h.container.value
				? `${formatBytes(h.container.value.memoryBytes)} memory${h.container.value.cpuPercent === null ? "" : ` · ${h.container.value.cpuPercent}% CPU`}`
				: describe(h.container),
		],
	])
}

function scopeLabel(scope) {
	return (
		{
			host: "Pi host",
			container: "receiver container",
			"docker-storage": "Docker storage filesystem",
			service: "receiver service",
		}[scope] ?? scope
	)
}

function row(cells, wide = false) {
	const tr = document.createElement("tr")
	if (wide) {
		const td = document.createElement("td")
		td.colSpan = 3
		td.textContent = cells[0]
		tr.append(td)
		return tr
	}
	for (const cell of cells) {
		const td = document.createElement("td")
		td.textContent = cell
		tr.append(td)
	}
	return tr
}

function facts(dl, entries) {
	dl.replaceChildren(
		...entries
			.filter(([, value]) => value != null)
			.flatMap(([term, value]) => {
				const dt = document.createElement("dt")
				dt.textContent = term
				const dd = document.createElement("dd")
				dd.textContent = value
				return [dt, dd]
			}),
	)
}

document.addEventListener("visibilitychange", () => {
	if (document.hidden) {
		state.controller?.abort()
		state.controller = null
		clearTimeout(state.timer)
		renderLink()
	} else {
		void poll()
	}
})
window.addEventListener("pagehide", () => {
	state.controller?.abort()
	clearTimeout(state.timer)
})

$("host-name").textContent = location.hostname || "This Pi"
drawGraticule()
bindPlot()
// Keep ages, freshness and the scrolling trace honest between polls. When the
// page's own freshness changes (e.g. contact lost), every section re-renders so
// no lamp stays green on old data.
let lastLink = ""
setInterval(() => {
	if (document.hidden || !state.status) return
	const link = linkState(linkInput()).state
	if (link !== lastLink) {
		lastLink = link
		render()
	} else {
		renderLink()
		renderScreen()
	}
}, 1000)
void poll()

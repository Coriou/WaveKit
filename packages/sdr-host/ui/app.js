// Operator page: polls the Pi's own API (same origin), one request pair in
// flight at a time, paused while the tab is hidden, backing off on failure.
import {
	REQUEST_TIMEOUT_MS,
	flowRate,
	formatAge,
	formatAgePrecise,
	formatBytes,
	formatDuration,
	formatRate,
	formatRateText,
	lastBoot,
	linkState,
	nextDelay,
	plotMax,
	power,
	readouts,
	recentDips,
	setupLine,
	smoothTrace,
	stream,
	tracePath,
	trends,
	verdict,
} from "./model.js"

const PLOT_W = 600
/** SoC temperature strip spans 20–90 °C. */
const TEMP_MIN = 20
const TEMP_SPAN = 70
const $ = id => document.getElementById(id)
const channel = key => document.querySelector(`.channel[data-key="${key}"]`)

const state = {
	status: null,
	host: null,
	/** performance.now() of the last successful snapshot. */
	receivedAt: null,
	failures: 0,
	timer: null,
	controller: null,
	marker: null,
	series: null,
	flow: [],
	flowMax: 1,
	trends: null,
	values: null,
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
		// Derived once per reading; the one-second tick only scrolls them.
		state.flow = smoothTrace(status.samplingHistory?.points ?? [])
		state.flowMax = plotMax(
			status.sampling?.upstream?.expectedBytesPerSec ?? null,
			state.flow,
		)
		state.trends = trends(host)
		state.values = readouts(host)
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
	renderStream()
	renderHost()
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
	const fresh = isFresh()
	const v = verdict({
		status: state.status,
		host: state.host,
		fresh,
		failures: state.failures,
	})
	// Until a first reading arrives, the screen's verdict is the whole page.
	document.body.dataset.empty = String(!state.status)
	$("screen").dataset.state = v.state
	$("screen").dataset.fresh = String(fresh)
	// Only state changes are announced; numbers update silently.
	if (v.title !== lastVerdictTitle) {
		$("verdict").textContent = v.title
		lastVerdictTitle = v.title
	}
	$("verdict-detail").textContent = v.detail
	const rate = flowRate(state.status, fresh)
	$("rate-value").textContent = rate.value
	$("rate-unit").textContent = rate.value === "—" ? "" : rate.unit
	$("rate-sub").textContent = rate.sub
	// Without a current figure the verdict already says so; no lone dash.
	document.querySelector(".screen__rate").hidden = rate.value === "—"
	renderScope(fresh)
}

/** Time since the snapshot arrived; ages grow by it so traces keep scrolling. */
function drift() {
	return state.receivedAt == null ? 0 : performance.now() - state.receivedAt
}

function aged(points, by) {
	return points.map(([age, value]) => [age + by, value])
}

/** Draw a channel's trace, scaled to its own SVG viewBox height. */
function draw(el, points, { windowMs, max, area = false }) {
	const height = el.querySelector("svg").viewBox.baseVal.height
	const trace = tracePath(points, { windowMs, width: PLOT_W, height, max })
	el.querySelector(".plot__trace").setAttribute("d", trace.d)
	if (area) el.querySelector(".plot__area").setAttribute("d", trace.area)
	return height
}

/** Host channels: [key, offset, full scale]. */
const HOST_CHANNELS = [
	["cpu", 0, 100],
	["memory", 0, 100],
	["temperature", TEMP_MIN, TEMP_SPAN],
]

function renderScope(fresh) {
	const windowMs = state.status?.samplingHistory?.windowMs ?? 300_000
	const expected = state.status?.sampling?.upstream?.expectedBytesPerSec ?? null
	const shift = drift()
	const flow = aged(state.flow, shift)
	const max = state.flowMax
	const flowEl = channel("flow")
	const height = draw(flowEl, flow, { windowMs, max, area: true })
	const scale = formatRate(max)
	flowEl.querySelector(".channel__value").textContent = state.status
		? `0–${Number(scale.value)} ${scale.unit}`
		: ""

	// The expected rate is labelled where its line is drawn.
	const line = flowEl.querySelector(".plot__expected")
	const label = flowEl.querySelector(".plot__label--expected")
	const y = expected ? height - (expected / max) * height : 0
	line.style.display = expected ? "" : "none"
	line.setAttribute("y1", y.toFixed(1))
	line.setAttribute("y2", y.toFixed(1))
	label.hidden = !expected
	label.textContent = expected ? `Expected ${formatRateText(expected)}` : ""
	label.style.top = `${((y / height) * 100).toFixed(2)}%`

	// Before the receiver started there is no history to show; say so.
	const runningMs =
		state.status?.uptime == null ? null : state.status.uptime * 1000 + shift
	const started = runningMs !== null && runningMs < windowMs
	const startX = started ? PLOT_W - (runningMs / windowMs) * PLOT_W : 0
	const start = flowEl.querySelector(".plot__start")
	start.style.display = started ? "" : "none"
	start.setAttribute("x1", startX.toFixed(1))
	start.setAttribute("x2", startX.toFixed(1))
	const startLabel = flowEl.querySelector(".plot__label--start")
	startLabel.hidden = !started
	startLabel.textContent = started
		? `Receiver started ${formatAge(runningMs)}`
		: ""
	startLabel.style.left = `${((startX / PLOT_W) * 100).toFixed(2)}%`
	flowEl.dataset.start = !started
		? "none"
		: startX > PLOT_W * 0.6
			? "late"
			: "early"

	// Every channel shares the flow's time base.
	const t = state.trends
	const series = { windowMs, flow }
	for (const [key, offset, span] of HOST_CHANNELS) {
		series[key] = aged(t?.[key] ?? [], shift)
		const el = channel(key)
		draw(
			el,
			series[key].map(([age, v]) => [age, v === null ? null : v - offset]),
			{ windowMs, max: span },
		)
		const r = state.values?.[key]
		el.dataset.state = !r ? "unavailable" : fresh ? r.state : "stale"
		el.querySelector(".channel__value").textContent = r ? r.value : "—"
	}

	series.dips = aged(t?.dips ?? [], shift)
	const lane = channel("dips")
	lane.hidden = !t
	lane.querySelector(".lane__ticks").setAttribute(
		"d",
		series.dips
			.filter(([age, n]) => n > 0 && age <= windowMs)
			.map(
				([age]) => `M${(PLOT_W - (age / windowMs) * PLOT_W).toFixed(1)} 1V15`,
			)
			.join(""),
	)
	const recent = recentDips(state.host)
	lane.dataset.state = !recent
		? "unavailable"
		: fresh
			? power(state.host).state
			: "stale"
	lane.querySelector(".channel__value").textContent = !recent
		? "—"
		: recent.count === 0
			? "None"
			: `${recent.count}`

	state.series = series
	if (state.marker !== null) placeMarker(state.marker)
}

function drawGraticules() {
	const ns = "http://www.w3.org/2000/svg"
	for (const g of document.querySelectorAll(".graticule")) {
		const height = Number(
			g.closest("svg").getAttribute("viewBox").split(" ")[3],
		)
		const rows = Number(g.dataset.rows)
		const line = (x1, y1, x2, y2, major) => {
			const el = document.createElementNS(ns, "line")
			el.setAttribute("x1", x1)
			el.setAttribute("y1", y1)
			el.setAttribute("x2", x2)
			el.setAttribute("y2", y2)
			if (major) el.setAttribute("class", "major")
			g.append(el)
		}
		// One vertical per 30 s; the shared time base of every channel.
		for (let i = 0; i <= 10; i++)
			line((PLOT_W / 10) * i, 0, (PLOT_W / 10) * i, height, false)
		for (let i = 0; i <= rows; i++)
			line(0, (height / rows) * i, PLOT_W, (height / rows) * i, i === rows)
	}
}

function nearest(points, age) {
	let best = null
	for (const point of points)
		if (best === null || Math.abs(point[0] - age) < Math.abs(best[0] - age))
			best = point
	return best && Math.abs(best[0] - age) < 6000 ? best : null
}

/** Marker: one cursor across every channel, reading the real samples. */
function placeMarker(fraction) {
	const series = state.series
	if (!series) return
	state.marker = Math.max(0, Math.min(1, fraction))
	const age = (1 - state.marker) * series.windowMs
	const at = nearest(series.flow, age)
	const reading = (points, format) => {
		const point = nearest(points, age)
		return point?.[1] == null ? "no data" : format(point[1])
	}
	const scope = $("scope")
	const box = scope.getBoundingClientRect()
	const plots = [...scope.querySelectorAll(".channel:not([hidden]) svg")]
	const top = plots[0].getBoundingClientRect()
	const bottom = plots[plots.length - 1].getBoundingClientRect()
	const x = top.left - box.left + state.marker * top.width
	const marker = $("marker")
	marker.hidden = false
	marker.style.left = `${x}px`
	marker.style.top = `${top.top - box.top}px`
	marker.style.height = `${bottom.bottom - top.top}px`
	const readout = $("marker-readout")
	readout.hidden = false
	const lines = [
		formatAgePrecise(at ? at[0] : age),
		`Flow ${reading(series.flow, formatRateText)}`,
	]
	if (series.cpu.length > 0)
		lines.push(
			`CPU ${reading(series.cpu, v => `${Math.round(v)}%`)}`,
			`Memory ${reading(series.memory, v => `${Math.round(v)}%`)}`,
			`SoC ${reading(series.temperature, v => `${v.toFixed(1)} °C`)}`,
			`Dips ${reading(series.dips, v => String(v))}`,
		)
	readout.replaceChildren(
		...lines.map(text => {
			const span = document.createElement("span")
			span.textContent = text
			return span
		}),
	)
	const width = readout.offsetWidth
	const left = x + 12 + width > box.width ? x - 12 - width : x + 12
	readout.style.left = `${Math.max(0, left)}px`
	readout.style.top = `${top.top - box.top + 6}px`
}

/** Latest pointer position awaiting a frame; cleared when the cursor hides. */
let pointerAt = null

function hideMarker() {
	pointerAt = null
	state.marker = null
	$("marker").hidden = true
	$("marker-readout").hidden = true
}

function bindScope() {
	const scope = $("scope")
	const fractionOf = event => {
		const box = channel("flow").querySelector("svg").getBoundingClientRect()
		return (event.clientX - box.left) / box.width
	}
	// Pointer moves outpace the screen; place the cursor once per frame.
	let frame = 0
	const follow = event => {
		pointerAt = fractionOf(event)
		frame ||= requestAnimationFrame(() => {
			frame = 0
			if (pointerAt !== null) placeMarker(pointerAt)
		})
	}
	scope.addEventListener("pointermove", follow)
	scope.addEventListener("pointerdown", follow)
	scope.addEventListener("pointerleave", event => {
		if (event.pointerType === "mouse") hideMarker()
	})
	scope.addEventListener("keydown", event => {
		const step = event.shiftKey ? 0.1 : 0.02
		if (event.key === "ArrowLeft") placeMarker((state.marker ?? 1) - step)
		else if (event.key === "ArrowRight") placeMarker((state.marker ?? 1) + step)
		else if (event.key === "Escape") hideMarker()
		else return
		event.preventDefault()
	})
	scope.addEventListener("blur", hideMarker)
}

/** Fill a row: lamp state, value text and sub-line, dimmed when not current. */
function setRow(el, row, fresh) {
	el.dataset.state = !row ? "unknown" : fresh ? (row.state ?? "ok") : "stale"
	el.querySelector(".row__text").textContent = row
		? (row.text ?? row.value)
		: "—"
	const sub = row?.sub ?? ""
	el.querySelector(".row__sub").textContent =
		row && !fresh ? `Last known${sub ? ` · ${sub}` : ""}` : sub
}

function renderStream() {
	const s = stream(state.status, state.host?.generatedAt ?? null)
	const fresh = isFresh()
	$("endpoint").textContent = s?.endpoint ?? "—"
	$("endpoint-copy").hidden = !s?.endpoint
	setRow($("row-dongle"), s?.dongle, fresh)
	setRow($("row-tuning"), s?.tuning, fresh)
	const list = $("clients")
	if (!s || !s.clientsKnown) {
		list.replaceChildren(item("Unknown", "Delivery counters unavailable"))
		return
	}
	list.replaceChildren(
		...(s.clients.length === 0
			? [
					item(
						"None connected",
						"The Pi keeps reading the dongle; point WaveKit at the address above.",
					),
				]
			: s.clients.map(c =>
					item(
						c.address,
						fresh
							? c.state === "warn"
								? `${c.health}. ${[c.rate, c.since].join(" · ")}`
								: [c.rate, c.health, c.since].filter(Boolean).join(" · ")
							: "Last known",
						fresh ? c.state : "stale",
					),
				)),
	)
}

function item(text, sub, tone = "") {
	const li = document.createElement("li")
	li.className = "client"
	if (tone) li.dataset.state = tone
	const lamp = document.createElement("span")
	lamp.className = "lamp"
	lamp.setAttribute("aria-hidden", "true")
	const name = document.createElement("span")
	name.className = "client__address"
	name.textContent = text
	const detail = document.createElement("span")
	detail.className = "client__sub"
	detail.textContent = sub
	if (tone) li.append(lamp)
	li.append(name, detail)
	return li
}

function renderHost() {
	const fresh = isFresh()
	setRow($("row-power"), state.host ? power(state.host) : null, fresh)
	for (const el of document.querySelectorAll(".row[data-key]")) {
		const r = state.values?.[el.dataset.key]
		setRow(el, r ?? null, fresh)
		if (el.dataset.key === "network") el.dataset.bars = String(r?.bars ?? 0)
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
	const s = status.sampling
	const proc = (name, p) =>
		p
			? `${name} ${p.running ? `pid ${p.pid ?? "?"}` : "stopped"}${p.restartCount ? ` · ${p.restartCount} restarts` : ""}`
			: null
	const h = state.host
	facts($("facts-receiver"), [
		[
			"Processes",
			[proc("rtl_tcp", status.rtlTcp), proc("rtlmux", status.rtlmux)]
				.filter(Boolean)
				.join(" · ") || null,
		],
		[
			"Read from dongle",
			s?.upstream?.bytesTotal != null
				? formatBytes(s.upstream.bytesTotal)
				: null,
		],
		["Last sample", s?.lastSampleAt ? formatAge(s.sampleAgeMs) : "none yet"],
		[
			"Dropped for clients",
			status.delivery
				? `${formatBytes(status.delivery.droppedBytesSinceMonitorStart)} since the fan-out started`
				: null,
		],
		[
			"Counter resets",
			s?.epoch
				? `${s.epoch.resets}${s.epoch.lastResetReason ? ` · ${s.epoch.lastResetReason}` : ""}`
				: null,
		],
		[
			"Fan-out counters",
			s
				? `${s.stats.state}${s.stats.lastError ? ` · ${s.stats.lastError}` : ""}`
				: null,
		],
		["First-boot setup", h ? setupLine(h.setup).text : null],
		["Last reboot", h ? lastBoot(h).text : null],
		[
			"Throttling",
			h?.power.throttling.value
				? h.power.throttling.value.throttled
					? "active"
					: "clear"
				: h
					? `not measurable · ${h.power.throttling.reason}`
					: null,
		],
	])
	if (!h) return
	const describe = reading =>
		reading.state === "unavailable"
			? `unavailable · ${reading.reason}`
			: `${scopeLabel(reading.scope)} · ${reading.state === "stale" ? `stale, ${formatAge(reading.ageMs)} old` : "fresh"}`
	facts($("facts-sources"), [
		["CPU", `${state.values?.cpu.sub ?? ""} · ${describe(h.cpu)}`],
		["Memory", `${state.values?.memory.sub ?? ""} · ${describe(h.memory)}`],
		[
			"Temperature",
			h.temperature.value
				? `${describe(h.temperature)} · ${h.temperature.value.zone}`
				: describe(h.temperature),
		],
		["Storage", describe(h.disk)],
		["Network", describe(h.network)],
		["Under-voltage", describe(h.power.undervoltageNow)],
		[
			"Receiver container",
			h.container.value
				? `${formatBytes(h.container.value.memoryBytes)} memory${h.container.value.cpuPercent === null ? "" : ` · ${h.container.value.cpuPercent}% CPU`}`
				: describe(h.container),
		],
		[
			"Host uptime",
			h.uptime.value
				? `${formatDuration(h.uptime.value.hostSec)} · ${describe(h.uptime)}`
				: describe(h.uptime),
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

/** Clipboard needs a secure context; plain http on the LAN falls back to a selection copy. */
async function copyEndpoint() {
	const text = $("endpoint").textContent ?? ""
	let copied = false
	try {
		await navigator.clipboard.writeText(text)
		copied = true
	} catch {
		const range = document.createRange()
		range.selectNodeContents($("endpoint"))
		const selection = window.getSelection()
		selection?.removeAllRanges()
		selection?.addRange(range)
		copied = document.execCommand("copy")
	}
	const button = $("endpoint-copy")
	button.textContent = copied ? "Copied" : "Select to copy"
	setTimeout(() => {
		button.textContent = "Copy"
	}, 1600)
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
$("endpoint-copy").addEventListener("click", () => void copyEndpoint())
drawGraticules()
bindScope()
// Keep ages, freshness and the scrolling traces honest between polls. When the
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

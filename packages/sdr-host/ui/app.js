// Operator page: polls the Pi's own API (same origin), one request pair in
// flight at a time, paused while the tab is hidden, backing off on failure.
//
// Every block of the page exists from the first paint. Renders only swap
// text, attributes and drawn paths inside boxes of fixed size, so the page
// never moves as readings arrive, change or go stale (see DESIGN.md, "The
// Still Page Rule"). The one exception is the client list, which grows and
// shrinks as clients join and leave.
import {
	CLIENT_SLOTS,
	REQUEST_TIMEOUT_MS,
	clientSlots,
	diagnostics,
	flowRate,
	formatAge,
	formatAgePrecise,
	formatRate,
	formatRateText,
	linkState,
	nextDelay,
	plotMax,
	power,
	readouts,
	recentDips,
	setupRow,
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
/** Client sparklines cover the last two minutes this page has seen. */
const SPARK_MS = 120_000
const SPARK_W = 64
const SPARK_H = 16
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
	/** Per-client delivered rate seen by this page: key -> [[at, bytesPerSec]]. */
	spark: new Map(),
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
		recordSparks(status)
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
	renderDiagnostics()
}

/** Set text only when it changed, with the full text as a tooltip for ellipsis. */
function setText(el, text, title = false) {
	if (el.textContent !== text) el.textContent = text
	if (title) el.title = text
}

/** Prose that may name a log file: the hyphenated name never breaks a line. */
function setProse(el, text) {
	if (el.textContent === text) return
	el.replaceChildren(
		...text.split(/(\S+\.log)/).map((part, i) => {
			if (i % 2 === 0) return part
			const name = document.createElement("span")
			name.className = "file"
			name.textContent = part
			return name
		}),
	)
}

function renderLink() {
	const link = linkState(linkInput())
	$("link").dataset.state = link.state
	setText($("link-text"), link.text)
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
	$("screen").dataset.state = v.state
	$("screen").dataset.fresh = String(fresh && state.status !== null)
	// Only state changes are announced; numbers update silently.
	if (v.title !== lastVerdictTitle) {
		$("verdict").textContent = v.title
		lastVerdictTitle = v.title
	}
	setProse($("verdict-detail"), v.detail)
	// The figure keeps its place: without a current reading it reads "—".
	const rate = flowRate(state.status, fresh)
	setText($("rate-value"), rate.value)
	setText($("rate-unit"), rate.unit)
	setText($("rate-sub"), rate.sub, true)
	setText($("rate-basis"), rate.basis, true)
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
	setText(
		flowEl.querySelector(".channel__value"),
		state.status ? `0–${Number(scale.value)} ${scale.unit}` : "—",
	)

	// The expected rate is labelled where its line is drawn.
	const line = flowEl.querySelector(".plot__expected")
	const label = flowEl.querySelector(".plot__label--expected")
	const y = expected ? height - (expected / max) * height : 0
	line.style.display = expected ? "" : "none"
	line.setAttribute("y1", y.toFixed(1))
	line.setAttribute("y2", y.toFixed(1))
	label.hidden = !expected
	setText(label, expected ? `Expected ${formatRateText(expected)}` : "")
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
	setText(startLabel, started ? `Receiver started ${formatAge(runningMs)}` : "")
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
		setText(el.querySelector(".channel__value"), r ? r.value : "—")
	}

	series.dips = aged(t?.dips ?? [], shift)
	const lane = channel("dips")
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
	setText(
		lane.querySelector(".channel__value"),
		!recent ? "—" : recent.count === 0 ? "None" : `${recent.count}`,
	)

	state.series = series
	if (state.marker !== null) placeMarker(state.marker)
}

/**
 * The graticule keeps only lines that carry meaning: one each minute, shared
 * by every channel so the eye can run down the scope, and each channel's zero.
 * The flow plot also marks its full scale, which its value slot names.
 */
function drawGraticules() {
	const ns = "http://www.w3.org/2000/svg"
	for (const g of document.querySelectorAll(".graticule")) {
		const height = g.closest("svg").viewBox.baseVal.height
		const line = (x1, y1, x2, y2, major) => {
			const el = document.createElementNS(ns, "line")
			el.setAttribute("x1", x1)
			el.setAttribute("y1", y1)
			el.setAttribute("x2", x2)
			el.setAttribute("y2", y2)
			if (major) el.setAttribute("class", "major")
			g.append(el)
		}
		for (let minute = 1; minute < 5; minute++)
			line((PLOT_W / 5) * minute, 0, (PLOT_W / 5) * minute, height, false)
		if (g.dataset.top === "true") line(0, 0.5, PLOT_W, 0.5, false)
		line(0, height - 0.5, PLOT_W, height - 0.5, true)
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
	const plots = [...scope.querySelectorAll(".channel svg")]
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
	el.dataset.empty = String(!row)
	setText(
		el.querySelector(".row__text"),
		row ? (row.text ?? row.value) : "—",
		true,
	)
	const sub = row?.sub ?? ""
	setText(
		el.querySelector(".row__subtext") ?? el.querySelector(".row__sub"),
		row && !fresh ? `Last known${sub ? ` · ${sub}` : ""}` : sub,
		true,
	)
}

/** Remember each client's delivered rate, to draw what this page has seen. */
function recordSparks(status) {
	const now = performance.now()
	const seen = new Set()
	for (const c of status.delivery?.clients ?? []) {
		seen.add(c.key)
		const points = state.spark.get(c.key) ?? []
		points.push([now, c.queuedBytesPerSec])
		while (points.length > 0 && now - points[0][0] > SPARK_MS) points.shift()
		state.spark.set(c.key, points)
	}
	for (const key of state.spark.keys())
		if (!seen.has(key)) state.spark.delete(key)
}

/** Sparkline path on the flow's full scale; a missing reading breaks the line. */
function sparkPath(points, max) {
	const now = performance.now()
	let d = ""
	let pen = false
	for (const [at, value] of points) {
		if (value === null) {
			pen = false
			continue
		}
		const x = SPARK_W - ((now - at) / SPARK_MS) * SPARK_W
		const y = SPARK_H - 1 - Math.min(1, value / max) * (SPARK_H - 2)
		d += `${pen ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`
		pen = true
	}
	return d
}

function renderStream() {
	const s = stream(state.status, state.host?.generatedAt ?? null)
	const fresh = isFresh()
	setText($("endpoint"), s?.endpoint ?? "—", true)
	$("endpoint-copy").disabled = !s?.endpoint
	setRow($("row-dongle"), s?.dongle, fresh)
	setRow($("row-tuning"), s?.tuning, fresh)
	setRow($("row-clients"), s?.clientsRow, fresh)

	const { shown, more } = clientSlots(s?.clients ?? [], CLIENT_SLOTS)
	const slots = [...$("clients").querySelectorAll(".client")]
	slots.forEach((slot, i) => {
		const c = shown[i]
		const last = i === slots.length - 1
		slot.classList.toggle("client--more", last && more !== null)
		if (last && more) {
			fillSlot(slot, {
				state: fresh ? more.state : "stale",
				address: more.text,
				rate: "",
				detail: more.detail,
				spark: "",
			})
			return
		}
		if (!c) {
			slot.hidden = true
			return
		}
		fillSlot(slot, {
			state: fresh ? c.state : "stale",
			address: c.address,
			rate: fresh ? c.rate : "—",
			detail: fresh ? c.detail : `Last known · ${c.detail}`,
			spark: sparkPath(state.spark.get(c.key) ?? [], state.flowMax),
		})
	})
	// With nobody connected, one hint stands in for the list.
	$("clients-empty").hidden = !s || shown.length > 0
}

function fillSlot(slot, { state: tone, address, rate, detail, spark }) {
	slot.hidden = false
	slot.dataset.state = tone
	setText(slot.querySelector(".client__address"), address, true)
	setText(slot.querySelector(".client__rate"), rate)
	setText(slot.querySelector(".client__detail"), detail, true)
	slot.querySelector(".spark__trace").setAttribute("d", spark)
}

function renderHost() {
	const fresh = isFresh()
	setRow($("row-power"), state.host ? power(state.host) : null, fresh)
	for (const el of document.querySelectorAll(".row[data-key]")) {
		const r = state.values?.[el.dataset.key]
		setRow(el, r ?? null, fresh)
		if (el.dataset.key === "network") el.dataset.bars = String(r?.bars ?? 0)
		if (el.dataset.key === "disk")
			el.querySelector(".meter__fill").style.transform =
				`scaleX(${r?.meter ?? 0})`
	}
	setRow($("row-setup"), state.host ? setupRow(state.host.setup) : null, fresh)
}

/**
 * Diagnostics keep one shape from the first paint: the same groups and terms
 * every time, "—" until a value is known. Static explanations are gathered
 * into notes after the groups, the only place text may wrap.
 */
function renderDiagnostics() {
	const groups = diagnostics({
		status: state.status,
		host: state.host,
		fresh: isFresh(),
	})
	const root = $("diagnostics")
	if (root.childElementCount === 0) buildDiagnostics(root, groups)
	const notes = []
	for (const group of groups) {
		const facts = root.querySelectorAll(
			`.diag-group[data-key="${group.key}"] .fact`,
		)
		group.facts.forEach((fact, i) => {
			const el = facts[i]
			if (!el) return
			if (fact.tone) el.dataset.tone = fact.tone
			el.dataset.empty = String(fact.value === "—")
			setText(el.querySelector(".fact__value"), fact.value, true)
			const word = el.querySelector(".fact__word span:last-child")
			if (word) setText(word, fact.word ?? "")
			if (fact.note) notes.push(`${fact.term}: ${fact.note}.`)
		})
	}
	const list = root.querySelector(".diagnostics__notes")
	if (list.textContent !== notes.join(""))
		list.replaceChildren(
			...notes.map(text => {
				const li = document.createElement("li")
				li.textContent = text
				return li
			}),
		)
}

function buildDiagnostics(root, groups) {
	const el = (tag, className, text = "") => {
		const node = document.createElement(tag)
		if (className) node.className = className
		if (text) node.textContent = text
		return node
	}
	for (const group of groups) {
		const section = el("section", "diag-group")
		section.dataset.key = group.key
		const title = el("h3", "diag-group__title", group.title)
		const list = el("dl", "facts")
		for (const fact of group.facts) {
			const row = el("div", "fact")
			row.append(el("dt", "", fact.term), el("dd", "fact__value"))
			if (fact.word !== undefined) {
				const word = el("dd", "fact__word")
				const lamp = el("span", "lamp")
				lamp.setAttribute("aria-hidden", "true")
				word.append(lamp, el("span"))
				row.append(word)
			}
			list.append(row)
		}
		section.append(title, list)
		root.append(section)
	}
	root.append(el("ul", "diagnostics__notes"))
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
	// Both words fit the button's fixed width.
	const button = $("endpoint-copy")
	button.textContent = copied ? "Copied" : "Selected"
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
render()
// Keep ages, freshness and the scrolling traces honest between polls. When the
// page's own freshness changes (e.g. contact lost), every section re-renders so
// no lamp stays green on old data.
let lastLink = ""
setInterval(() => {
	if (document.hidden) return
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

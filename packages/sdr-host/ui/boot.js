const title = document.getElementById("setup-title")
const detail = document.getElementById("setup-detail")
const screen = document.getElementById("setup-screen")
const clock = document.getElementById("setup-clock")
const age = document.getElementById("setup-age")
const note = document.getElementById("setup-note")
const contact = document.getElementById("contact")
const contactText = document.getElementById("contact-text")
const link = document.getElementById("receiver-link")
// Once setup completes and the receiver answers, this same address serves the
// status page. While setup failed or was cut off, port 80 keeps this page, so
// the link reaches the receiver directly on its own port.
const home = new URL("/", window.location.href)
const receiverUrl = new URL(home)
receiverUrl.port = "8080"
link.href = receiverUrl.href
document.getElementById("host-name").textContent =
	window.location.hostname || "This Pi"

const phases = ["cloud-init", "install", "publish", "done"]
const copy = {
	"cloud-init": [
		"Applying Pi settings",
		"Applying the account and network settings chosen in Imager.",
	],
	install: [
		"Installing the receiver",
		"Installing packages, loading the bundled receiver and starting its services.",
	],
	publish: [
		"Finishing setup",
		"Saving the receiver configuration for your account.",
	],
}
// What the elapsed figure counts from, per state.
const since = {
	running: "in this stage",
	complete: "since setup finished",
	failed: "since setup stopped",
	interrupted: "since the last update",
}

/** Pi-measured age at the last poll, advanced locally until the next one. */
let elapsed = null

function formatClock(ms) {
	const s = Math.floor(ms / 1000)
	const pad = n => String(n).padStart(2, "0")
	const h = Math.floor(s / 3600)
	const m = Math.floor((s % 3600) / 60)
	return h > 0 ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`
}

// The clock line is always drawn; without an age it reads "—" and says why.
function tick() {
	const text = elapsed ? formatClock(elapsed.ms + Date.now() - elapsed.at) : "—"
	if (clock.textContent !== text) clock.textContent = text
}

/** Same rule as the status page: a hyphenated log name never breaks a line. */
function setDetail(text) {
	if (detail.textContent === text) return
	detail.replaceChildren(
		...text.split(/(\S+\.log)/).map((part, i) => {
			if (i % 2 === 0) return part
			const name = document.createElement("span")
			name.className = "file"
			name.textContent = part
			return name
		}),
	)
}

/** Same rule as the status page: after 10 s without contact, say how long. */
const CONTACT_STALE_MS = 10_000
let lastContact = null

function contactLost() {
	const lost = lastContact === null ? null : Date.now() - lastContact
	if (lost === null || lost <= CONTACT_STALE_MS) {
		contact.dataset.state = lastContact === null ? "offline" : "reconnecting"
		contactText.textContent =
			lastContact === null ? "Pi unreachable" : "Reconnecting"
		return
	}
	const s = Math.floor(lost / 1000)
	contact.dataset.state = "offline"
	contactText.textContent = `Lost · ${s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`} ago`
}

function render(record) {
	lastContact = Date.now()
	contact.dataset.state = "live"
	contactText.textContent = "Live"
	let tone = "unknown"
	let words = [
		"Preparing the Pi",
		"Raspberry Pi OS is applying the settings chosen in Imager. Installing the receiver starts after that.",
	]
	if (record.state === "running") {
		// Progress is healthy: a lit lamp that blinks, not the amber of a fault.
		tone = "ok"
		words = copy[record.phase] ?? [
			"Setup in progress",
			"Waiting for the next installation stage.",
		]
	}
	if (record.state === "complete") {
		tone = "ok"
		words = [
			"Setup complete",
			record.receiverPageReady
				? "Opening receiver status…"
				: "Waiting for the receiver status page to start. Finishing setup does not confirm radio reception.",
		]
	}
	if (record.state === "failed") {
		tone = "fault"
		words = [
			"Setup needs attention",
			`Installation stopped${record.exitCode ? ` (exit ${record.exitCode})` : ""}. Check wavekit-setup.log on the boot partition, then retry setup.`,
		]
	}
	if (record.state === "interrupted") {
		tone = "warn"
		words = [
			"Setup was interrupted",
			"The Pi restarted before setup finished. Waiting for installation to resume.",
		]
	}
	if (record.state === "unavailable")
		words = [
			"Setup status unavailable",
			"The progress record could not be read. The Pi is reachable; installation status is unknown.",
		]
	screen.dataset.state = tone
	title.textContent = words[0]
	setDetail(words[1])
	elapsed =
		record.updatedAgeMs === null || !since[record.state]
			? null
			: { ms: record.updatedAgeMs, at: Date.now() }
	tick()
	age.textContent = elapsed
		? since[record.state]
		: record.updatedAt
			? "Stage time unavailable"
			: "No progress yet"
	note.hidden = !["running", "waiting", "interrupted"].includes(record.state)

	// Before the first record, the OS is applying Imager settings: stage one.
	const waiting = record.state === "waiting"
	const running = record.state === "running" || waiting
	const current = phases.indexOf(waiting ? "cloud-init" : record.phase)
	const known =
		running || ["complete", "failed", "interrupted"].includes(record.state)
	for (const item of document.querySelectorAll("[data-phase]")) {
		const index = phases.indexOf(item.dataset.phase)
		const done =
			record.state === "complete" || (known && current >= 0 && index < current)
		const here = known && !done && index === current
		let [state, word] = done ? ["ok", "Done"] : ["unknown", "Waiting"]
		if (here && running) [state, word] = ["ok", "In progress"]
		if (here && record.state === "failed") [state, word] = ["fault", "Stopped"]
		if (here && record.state === "interrupted")
			[state, word] = ["warn", "Interrupted"]
		// A failure record does not name its stage; unfinished stages are unknown.
		if (
			record.state === "unavailable" ||
			(record.state === "failed" && current < 0)
		)
			word = "Unknown"
		item.dataset.state = state
		if (here && running) item.setAttribute("aria-current", "step")
		else item.removeAttribute("aria-current")
		item.querySelector(".step__word").textContent = word
	}
	document.getElementById("receiver-link-wrap").hidden =
		!record.receiverPageReady
	if (record.state === "complete" && record.receiverPageReady)
		window.location.replace(home.href)
}

async function poll() {
	try {
		const response = await fetch("api/setup", {
			cache: "no-store",
			signal: AbortSignal.timeout(3000),
		})
		if (!response.ok) throw new Error("Unavailable")
		render(await response.json())
	} catch {
		contactLost()
		screen.dataset.state = "unknown"
		title.textContent = "Contact lost"
		setDetail(
			"The Pi may be restarting or the network may have changed. Reconnecting automatically.",
		)
		elapsed = null
		tick()
		age.textContent = "No current reading"
		note.hidden = true
		document.getElementById("receiver-link-wrap").hidden = true
		for (const item of document.querySelectorAll("[data-phase]")) {
			item.dataset.state = "unknown"
			item.querySelector(".step__word").textContent = "Unknown"
			item.removeAttribute("aria-current")
		}
	}
	window.setTimeout(poll, 2000)
}

window.setInterval(tick, 1000)
poll()

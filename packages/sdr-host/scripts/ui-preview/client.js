// Injected by the preview server into every page; never shipped to the Pi.
// Reloads on edits in ui/ (CSS swaps in place) and after a server restart,
// and floats a scenario switcher in a shadow root so app.css can't reach it.

const swapStylesheets = () => {
	for (const old of document.querySelectorAll('link[rel="stylesheet"]')) {
		const next = old.cloneNode()
		const url = new URL(old.href)
		url.searchParams.set("v", Date.now().toString())
		next.href = url.href
		next.addEventListener("load", () => old.remove(), { once: true })
		old.after(next)
	}
}

const events = new EventSource("/__dev/events")
let dropped = false
events.addEventListener("error", () => {
	dropped = true
})
events.addEventListener("open", () => {
	if (dropped) location.reload()
})
events.addEventListener("message", event => {
	const files = JSON.parse(event.data)
	if (files.every(file => file.endsWith(".css"))) swapStylesheets()
	else location.reload()
})

const current = location.pathname.split("/")[1] ?? ""
const COLLAPSED = "wavekit-preview-collapsed"

const host = document.createElement("wavekit-preview")
const root = host.attachShadow({ mode: "open" })
const sheet = document.createElement("link")
sheet.rel = "stylesheet"
sheet.href = "/__dev/client.css"
const bar = document.createElement("div")
bar.className = "bar"
const toggle = document.createElement("button")
toggle.type = "button"
toggle.className = "toggle"
toggle.textContent = "Preview"
const select = document.createElement("select")
select.setAttribute("aria-label", "Scenario")
const now = document.createElement("span")
now.className = "now"
bar.append(toggle, select, now)
root.append(sheet, bar)
document.body.append(host)

const setCollapsed = collapsed => {
	bar.classList.toggle("collapsed", collapsed)
	toggle.setAttribute("aria-expanded", String(!collapsed))
	localStorage.setItem(COLLAPSED, collapsed ? "1" : "")
}
setCollapsed(localStorage.getItem(COLLAPSED) === "1")
toggle.addEventListener("click", () =>
	setCollapsed(!bar.classList.contains("collapsed")),
)

select.addEventListener("change", () => {
	const option = select.selectedOptions[0]
	if (option) location.href = `/${option.value}/${option.dataset.page ?? ""}`
})

const fill = ({ receiver, setup }) => {
	const group = (label, entries, page) => {
		const optgroup = document.createElement("optgroup")
		optgroup.label = label
		for (const { name } of entries) {
			const option = new Option(name, name, false, name === current)
			option.dataset.page = page
			optgroup.append(option)
		}
		select.append(optgroup)
	}
	group("Receiver status", receiver, "")
	group("First-boot setup", setup, "boot.html")
}

const refresh = async () => {
	try {
		const response = await fetch(
			`/__dev/scenarios?current=${encodeURIComponent(current)}`,
			{ cache: "no-store" },
		)
		const body = await response.json()
		if (select.options.length === 0) fill(body)
		now.textContent = body.now ?? ""
	} catch {
		// The server is restarting; the event stream reloads the page when it is back.
	}
}
void refresh()
setInterval(() => void refresh(), 2000)

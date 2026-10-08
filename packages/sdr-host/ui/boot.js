const title = document.getElementById("setup-title")
const detail = document.getElementById("setup-detail")
const age = document.getElementById("setup-age")
const contact = document.getElementById("contact")
const contactText = document.getElementById("contact-text")
const link = document.getElementById("receiver-link")
const receiverUrl = new URL(window.location.href)
receiverUrl.port = "8080"
receiverUrl.pathname = "/"
receiverUrl.search = ""
receiverUrl.hash = ""
link.href = receiverUrl.href

const phases = ["cloud-init", "install", "publish", "done"]
const copy = {
	"cloud-init": [
		"Configuring the Pi",
		"Applying the account and network settings selected in Imager.",
	],
	install: [
		"Installing the receiver",
		"Installing required packages, loading the bundled receiver and starting its services. This may take several minutes.",
	],
	publish: [
		"Finishing setup",
		"Saving the receiver configuration for your account.",
	],
}

function render(record) {
	contact.dataset.state = "live"
	contactText.textContent = "Connected"
	let words = [
		"Waiting for Pi setup",
		"The operating system is preparing your Pi. Receiver installation begins after this completes.",
	]
	if (record.state === "running")
		words = copy[record.phase] ?? [
			"Setup in progress",
			"Waiting for the next installation stage.",
		]
	if (record.state === "complete")
		words = [
			"Setup complete",
			record.receiverPageReady
				? "Opening receiver status…"
				: "Waiting for the receiver status page to start. Installation completion does not confirm radio reception.",
		]
	if (record.state === "failed")
		words = [
			"Setup needs attention",
			`Installation stopped${record.exitCode ? ` (exit ${record.exitCode})` : ""}. Check wavekit-setup.log on the boot partition or the firstboot service log over SSH, then retry setup.`,
		]
	if (record.state === "interrupted")
		words = [
			"Setup was interrupted",
			"The Pi restarted before setup finished. Waiting for installation to resume.",
		]
	if (record.state === "unavailable")
		words = [
			"Setup status unavailable",
			"The progress record could not be read. The Pi is reachable; installation status is unknown.",
		]
	title.textContent = words[0]
	detail.textContent = words[1]
	age.textContent =
		record.updatedAgeMs === null
			? record.updatedAt
				? "Stage update time unavailable"
				: "No progress update yet"
			: `Last stage update ${Math.floor(record.updatedAgeMs / 1000)} s ago`
	const current = phases.indexOf(record.phase)
	for (const item of document.querySelectorAll("[data-phase]")) {
		const index = phases.indexOf(item.dataset.phase)
		const active = record.state === "running" && index === current
		if (active) item.setAttribute("aria-current", "step")
		else item.removeAttribute("aria-current")
		item.querySelector("small").textContent =
			record.state === "complete" ||
			(record.state === "running" && index < current)
				? "Done"
				: active
					? "In progress"
					: "Waiting"
	}
	document.getElementById("receiver-link-wrap").hidden =
		!record.receiverPageReady
	if (record.state === "complete" && record.receiverPageReady)
		window.location.replace(receiverUrl.href)
}

async function poll() {
	try {
		const response = await fetch("/api/setup", {
			cache: "no-store",
			signal: AbortSignal.timeout(3000),
		})
		if (!response.ok) throw new Error("Unavailable")
		render(await response.json())
	} catch {
		contact.dataset.state = "reconnecting"
		contactText.textContent = "Reconnecting"
		title.textContent = "Contact lost"
		detail.textContent =
			"The Pi may be restarting or the network may have changed. Reconnecting automatically; setup progress is unknown until contact returns."
		age.textContent = "Previous status is no longer current"
		document.getElementById("receiver-link-wrap").hidden = true
		for (const item of document.querySelectorAll("[data-phase]")) {
			item.querySelector("small").textContent = "Unknown"
		}
		for (const item of document.querySelectorAll("[aria-current]"))
			item.removeAttribute("aria-current")
	}
	window.setTimeout(poll, 2000)
}

poll()

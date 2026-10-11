// tests/integration/fixtures/collect-outputs.mjs
// Runs INSIDE the container (Node 22: global fetch + WebSocket). Usage:
//   node collect-outputs.mjs <apiPort> <seconds> <decoderId>
// Prints {"kind":"output",...} lines for that decoder, then one {"kind":"status",...}.
// Exits 2 when the app never comes up, 3 when the WebSocket errors or closes before the window ends.
const [port, seconds, decoderId] = process.argv.slice(2)
const base = `http://127.0.0.1:${port}`
const deadline = Date.now() + Number(seconds) * 1000
const sleep = ms => new Promise(r => setTimeout(r, ms))

for (;;) {
	if (Date.now() > deadline) {
		process.stderr.write("app HTTP never came up\n")
		process.exit(2)
	}
	// Liveness, not /health: /health is 503 while the only decoder is down (e.g. suspended),
	// and the status fetch below must still capture that suspension.
	try {
		if ((await fetch(`${base}/health/live`)).ok) break
	} catch {
		// not up yet
	}
	await sleep(100)
}
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
// The server drops slow clients; a socket that ends before the window would leave a truncated set behind a 0 exit.
let windowOver = false
const lostSocket = what => {
	if (windowOver) return
	process.stderr.write(`WebSocket ${what} before the window ended\n`)
	process.exit(3)
}
ws.addEventListener("error", () => lostSocket("error"))
ws.addEventListener("close", event =>
	lostSocket(`closed (code ${event.code} ${event.reason})`),
)
ws.addEventListener("open", () =>
	ws.send(JSON.stringify({ type: "subscribe", channels: ["decoders"] })),
)
ws.addEventListener("message", event => {
	const msg = JSON.parse(String(event.data))
	if (msg.type === "decoder:output" && msg.data?.decoderId === decoderId) {
		process.stdout.write(
			`${JSON.stringify({ kind: "output", output: msg.data.output })}\n`,
		)
	}
})
await sleep(Math.max(0, deadline - Date.now()))
windowOver = true
const status = await (
	await fetch(`${base}/api/decoders/${encodeURIComponent(decoderId)}`)
).json()
process.stdout.write(`${JSON.stringify({ kind: "status", status })}\n`)
ws.close()
process.exit(0)

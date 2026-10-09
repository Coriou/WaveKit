// tests/integration/fixtures/collect-outputs.mjs
// Runs INSIDE the container (Node 22: global fetch + WebSocket). Usage:
//   node collect-outputs.mjs <apiPort> <seconds> <decoderId>
// Prints {"kind":"output",...} lines for that decoder, then one {"kind":"status",...}.
const [port, seconds, decoderId] = process.argv.slice(2)
const base = `http://127.0.0.1:${port}`
const deadline = Date.now() + Number(seconds) * 1000
const sleep = ms => new Promise(r => setTimeout(r, ms))

for (;;) {
	if (Date.now() > deadline) {
		process.stderr.write("app never became healthy\n")
		process.exit(2)
	}
	try {
		if ((await fetch(`${base}/health`)).ok) break
	} catch {
		// not up yet
	}
	await sleep(100)
}
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
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
const status = await (
	await fetch(`${base}/api/decoders/${encodeURIComponent(decoderId)}`)
).json()
process.stdout.write(`${JSON.stringify({ kind: "status", status })}\n`)
ws.close()
process.exit(0)

// Protocol-faithful stand-in for wavekit-chan (A1: control on fd 3). Behaviour via env:
// FAKE_CHAN_MODE = normal | no-ready | crash-after-open | garbage | stall-input | ignore-shutdown
// stall-input: stdin is not read until FAKE_CHAN_STALL_MS (default 1500) after the first channel opens, then resumes,
// so the fanout branch really drops and then really drains (Task 21). Anchoring to `opened` keeps slow spawns out of the window.
// ignore-shutdown: `shutdown`, control EOF and input EOF are all ignored, so only a signal ends it (stop escalation).
// Channels are identity pass-through, so a discontinuity's output sampleIndex equals the input sample index.
// Like runtime.rs, `shutdown` and control EOF close every channel with reason "requested" and exit 0; every exit
// waits for stdout to flush so no event line is lost, and the first of shutdown / control EOF / input EOF wins.
export const FAKE_WAVEKIT_CHAN = `#!/usr/bin/env node
const fs = require("node:fs"), net = require("node:net"), path = require("node:path"), readline = require("node:readline")
const argv = process.argv.slice(2); const arg = k => argv[argv.indexOf("--" + k) + 1]
if (argv[0] === "--version") { process.stdout.write("wavekit-chan 0.0.0-fake protocol 1\\n"); process.exit(0) }
const generation = Number(arg("generation")), dir = arg("socket-dir"), mode = process.env.FAKE_CHAN_MODE || "normal"
const emit = e => process.stdout.write(JSON.stringify({ v: 1, generation, ...e }) + "\\n")
const channels = new Set(), clients = new Map(); let inputBytes = 0, stallTimer = null, exiting = false
const quit = code => process.stdout.write("", () => process.exit(code))
const shutdown = () => { if (exiting || mode === "ignore-shutdown") return; exiting = true; for (const id of channels) { clients.get(id)?.end(); emit({ type: "closed", id, reason: "requested" }) } quit(0) }
if (mode === "ignore-shutdown") setInterval(() => {}, 1 << 30)
if (mode === "garbage") process.stdout.write("not json\\n")
if (mode !== "no-ready") emit({ type: "ready", pid: process.pid })
readline.createInterface({ input: new net.Socket({ fd: 3, readable: true, writable: false }) }).on("line", line => {
  let r; try { r = JSON.parse(line) } catch { return emit({ type: "rejected", id: "", reasonCode: "channel-request-invalid", detail: "json" }) }
  if (r.type === "open") {
    if (r.centerHz > 1e12) return emit({ type: "rejected", id: r.id, reasonCode: "channel-outside-capture", detail: "fake" })
    const sock = path.join(dir, r.id + ".sock"); try { fs.unlinkSync(sock) } catch {}
    const server = net.createServer(c => { clients.set(r.id, c); server.close() }); server.listen(sock, () => {
      channels.add(r.id); emit({ type: "opened", id: r.id, socket: sock, outputRateHz: r.outputRateHz, format: r.format, filterTaps: 11, groupDelaySamples: 5 })
      if (mode === "crash-after-open") setTimeout(() => process.exit(1), 50)
      if (mode === "stall-input" && !stallTimer) stallTimer = setTimeout(() => process.stdin.resume(), Number(process.env.FAKE_CHAN_STALL_MS || 1500))
    })
  } else if (r.type === "close") { clients.get(r.id)?.end(); clients.delete(r.id); channels.delete(r.id); emit({ type: "closed", id: r.id, reason: "requested" }) }
  else if (r.type === "mark-gap") { for (const id of channels) emit({ type: "discontinuity", id, sampleIndex: Math.floor((r.atInputByte ?? inputBytes) / 2), droppedSamples: Math.floor((r.droppedInputBytes ?? 0) / 2), cause: "input-gap" }); emit({ type: "stats", inputSamples: Math.floor(inputBytes / 2), channels: [] }) }
  else if (r.type === "shutdown") shutdown()
}).on("close", shutdown)
process.stdin.on("data", b => { inputBytes += b.length; for (const c of clients.values()) c.write(b) })
if (mode === "stall-input") process.stdin.pause() // resumed by the timer armed on the first \`opened\`
process.stdin.on("end", () => { if (exiting || mode === "ignore-shutdown") return; exiting = true; emit({ type: "input-eof", inputSamples: Math.floor(inputBytes / 2), discardedBytes: inputBytes % 2 }); for (const c of clients.values()) c.end(); setTimeout(() => quit(0), 20) })
process.on("SIGTERM", () => process.exit(143))
`

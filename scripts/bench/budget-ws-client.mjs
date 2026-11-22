#!/usr/bin/env node
// budget-ws-client.mjs URL TOKEN OUTDIR [--spectrum] [--source ID] [--name NAME]
// budget-ws-client.mjs audio URL TOKEN OUTDIR [--name NAME]
//
// A web-like WebSocket client for the main-thread budget harness (standalone, Node 24 global
// WebSocket, no dependencies). URL is the core's ws://host:port/ws; TOKEN a bearer token, or `-`
// for none (legacy access mode). It subscribes like a web app tab: the events socket takes the
// status and fleet channels plus the activity feed (web/src/data/events-client.ts and the
// stores), and with --spectrum a second socket subscribes to the spectrum channel as the spectrum
// worker does (web/src/spectrum/socket.ts: sourceId, 25 Hz, 1024 bins, 10 s backfill).
//
// It counts messages and bytes per socket and message type (binary frames as `binary`) and
// writes the cumulative counters to OUTDIR/<name>.jsonl every 10 s, on SIGUSR2 (a `mark` line),
// and at exit (SIGTERM or SIGINT). A dropped socket reconnects after 2 s.
//
// `audio` mode is one listener of an HTTP audio stream (the `/auto` route of the live-demod
// server): it GETs URL with the bearer token, counts the body bytes, and writes the same
// cumulative lines (bytes, chunks, status, reconnects) on the same triggers. A failed or ended
// response retries after 2 s.
//
// It refuses any host but loopback and the shared ports (toolTargetRefusal in
// budget-preload.mjs, which sits next to this file in both tiers).
import { appendFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import { toolTargetRefusal } from "./budget-preload.mjs"

function refusalOf(url) {
	let target
	try {
		target = new URL(url)
	} catch {
		target = null
	}
	const schemes = process.argv[2] === "audio" ? ["http:"] : ["ws:", "wss:"]
	if (target === null || !schemes.includes(target.protocol))
		return `refused URL ${url}`
	return toolTargetRefusal(
		target.hostname,
		target.port === ""
			? target.protocol === "wss:"
				? 443
				: 80
			: Number(target.port),
	)
}

async function runAudio(args) {
	const [url, token, outDir] = args
	if (!url || !token || !outDir) {
		process.stderr.write(
			"usage: budget-ws-client.mjs audio URL TOKEN OUTDIR [--name NAME]\n",
		)
		process.exit(1)
	}
	const refusal = refusalOf(url)
	if (refusal !== null) {
		process.stderr.write(`budget-ws-client: ${refusal}\n`)
		process.exit(1)
	}
	const i = args.indexOf("--name")
	const name = i >= 0 ? (args[i + 1] ?? "audio") : "audio"
	mkdirSync(outDir, { recursive: true })
	const file = join(outDir, `${name}.jsonl`)
	const counts = {
		messages: 0,
		bytes: 0,
		opens: 0,
		closes: 0,
		status: null,
		byType: {},
	}
	const write = ev => {
		try {
			appendFileSync(
				file,
				`${JSON.stringify({ t: new Date().toISOString(), ms: Date.now(), ev, ...counts })}\n`,
			)
		} catch {
			// best effort
		}
	}
	let stopping = false
	let controller = null
	setInterval(() => write("tick"), 10_000)
	process.on("SIGUSR2", () => write("mark"))
	for (const sig of ["SIGTERM", "SIGINT"])
		process.on(sig, () => {
			stopping = true
			write("exit")
			controller?.abort()
			process.exit(0)
		})
	const headers = token === "-" ? {} : { Authorization: `Bearer ${token}` }
	while (!stopping) {
		controller = new AbortController()
		try {
			const res = await fetch(url, { headers, signal: controller.signal })
			counts.status = res.status
			if (res.ok && res.body) {
				counts.opens++
				for await (const chunk of res.body) {
					counts.messages++
					counts.bytes += chunk.byteLength
					const e = (counts.byType["audio:binary"] ??= {
						messages: 0,
						bytes: 0,
					})
					e.messages++
					e.bytes += chunk.byteLength
				}
				counts.closes++
			}
		} catch {
			// retried below
		}
		if (!stopping) await new Promise(r => setTimeout(r, 2000))
	}
}

function runWs(args) {
	const [url, token, outDir] = args
	if (!url || !token || !outDir) {
		process.stderr.write(
			"usage: budget-ws-client.mjs URL TOKEN OUTDIR [--spectrum] [--source ID] [--name NAME]\n",
		)
		process.exit(1)
	}
	const refusal = refusalOf(url)
	if (refusal !== null) {
		process.stderr.write(`budget-ws-client: ${refusal}\n`)
		process.exit(1)
	}
	const opt = name => {
		const i = args.indexOf(`--${name}`)
		return i >= 0 ? args[i + 1] : undefined
	}
	const SPECTRUM = args.includes("--spectrum")
	const SOURCE = opt("source")
	const NAME = opt("name") ?? "client"
	if (SPECTRUM && !SOURCE) {
		process.stderr.write("--spectrum needs --source ID\n")
		process.exit(1)
	}
	mkdirSync(outDir, { recursive: true })
	const file = join(outDir, `${NAME}.jsonl`)

	/** What a web app tab subscribes to on the events socket. */
	const CHANNELS = [
		"decoders",
		"resources",
		"scanner",
		"bandplans",
		"tuner",
		"sources",
		"live-audio",
		"digital-voice",
		"operator-data",
		"recordings",
		"aircraft",
		"vessels",
		"aprs",
		"mesh",
	]

	const counts = { messages: 0, bytes: 0, opens: 0, closes: 0, byType: {} }
	const count = (socket, type, bytes) => {
		counts.messages++
		counts.bytes += bytes
		const key = `${socket}:${type}`
		const e = (counts.byType[key] ??= { messages: 0, bytes: 0 })
		e.messages++
		e.bytes += bytes
	}
	const write = ev => {
		try {
			appendFileSync(
				file,
				`${JSON.stringify({ t: new Date().toISOString(), ms: Date.now(), ev, ...counts })}\n`,
			)
		} catch {
			// best effort
		}
	}

	const headers = token === "-" ? {} : { Authorization: `Bearer ${token}` }
	const live = new Set()
	let stopping = false

	function connect(tag, onOpen) {
		if (stopping) return
		const ws = new WebSocket(url, { headers })
		ws.binaryType = "arraybuffer"
		live.add(ws)
		ws.addEventListener("open", () => {
			counts.opens++
			onOpen(msg => ws.send(JSON.stringify(msg)))
		})
		ws.addEventListener("message", ev => {
			if (typeof ev.data === "string") {
				let type = "unparsed"
				try {
					const m = JSON.parse(ev.data)
					type = typeof m?.type === "string" ? m.type : "unknown"
				} catch {
					type = "unparsed"
				}
				count(tag, type, Buffer.byteLength(ev.data))
			} else {
				const n =
					ev.data instanceof ArrayBuffer
						? ev.data.byteLength
						: (ev.data?.size ?? 0)
				count(tag, "binary", n)
			}
		})
		ws.addEventListener("error", () => undefined)
		ws.addEventListener("close", () => {
			live.delete(ws)
			counts.closes++
			if (!stopping) setTimeout(() => connect(tag, onOpen), 2000)
		})
	}

	connect("events", send => {
		send({ type: "subscribe", channels: CHANNELS })
		send({ type: "activity:subscribe", id: "feed", query: {} })
	})
	if (SPECTRUM)
		connect("spectrum", send => {
			send({
				type: "subscribe",
				channels: ["spectrum"],
				options: {
					spectrum: {
						sourceId: SOURCE,
						hz: 25,
						bins: 1024,
						backfillMs: 10_000,
					},
				},
			})
		})

	setInterval(() => write("tick"), 10_000)
	process.on("SIGUSR2", () => write("mark"))
	for (const sig of ["SIGTERM", "SIGINT"])
		process.on(sig, () => {
			stopping = true
			write("exit")
			for (const ws of live) ws.close()
			process.exit(0)
		})
}

const argv = process.argv.slice(2)
if (argv[0] === "audio") await runAudio(argv.slice(1))
else runWs(argv)

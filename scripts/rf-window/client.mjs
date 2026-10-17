// I/O helpers of the RF-window scripts: REST calls, the /ws socket, the live audio stream,
// and Ctrl-C handling. Pure parts live in lib.mjs. Node 24 globals (fetch, WebSocket).
import { UsageError, logLine } from "./lib.mjs"

/** Optional bearer for protected mode: the env var named by WAVEKIT_RF_BEARER_ENV. */
function authHeaders() {
	const name = process.env["WAVEKIT_RF_BEARER_ENV"]
	const token = name ? process.env[name] : undefined
	return token ? { authorization: `Bearer ${token}` } : {}
}

export async function api(base, method, path, body) {
	const response = await fetch(new URL(path, base), {
		method,
		headers: {
			...authHeaders(),
			...(body !== undefined ? { "content-type": "application/json" } : {}),
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout(10_000),
	})
	const text = await response.text()
	let json = null
	try {
		json = text === "" ? null : JSON.parse(text)
	} catch {
		json = { raw: text.slice(0, 200) }
	}
	if (!response.ok) {
		const err = new Error(
			`${method} ${path} answered ${response.status}: ${JSON.stringify(json)}`,
		)
		err.status = response.status
		throw err
	}
	return json
}

/**
 * Opens /ws, subscribes, and calls `onMessage(msg, receivedAtMs)` for each JSON frame.
 * Resolves with `{ close() }` once the socket is open.
 */
export function openSocket(url, subscribe, onMessage) {
	return new Promise((resolve, reject) => {
		const headers = authHeaders()
		const ws =
			Object.keys(headers).length > 0
				? new WebSocket(url, { headers })
				: new WebSocket(url)
		const fail = () => reject(new Error(`WebSocket ${url} failed to open`))
		ws.addEventListener("error", fail, { once: true })
		ws.addEventListener("open", () => {
			ws.removeEventListener("error", fail)
			ws.send(JSON.stringify(subscribe))
			resolve({ close: () => ws.close() })
		})
		ws.addEventListener("message", event => {
			const at = performance.now()
			try {
				onMessage(JSON.parse(String(event.data)), at)
			} catch {
				// Not JSON or a handler bug: ignored, the run goes on.
			}
		})
	})
}

/** Streams raw live audio for `seconds`; resolves with `{ format, sampleRate, chunks }`. */
export async function recordAudio(url, seconds, signal) {
	const controller = new AbortController()
	const stop = () => controller.abort()
	signal.addEventListener("abort", stop, { once: true })
	const timer = setTimeout(stop, seconds * 1000)
	const chunks = []
	try {
		const response = await fetch(url, {
			headers: authHeaders(),
			signal: controller.signal,
		})
		if (!response.ok || response.body === null)
			throw new Error(`GET ${url} answered ${response.status}`)
		const format = response.headers.get("x-audio-format") ?? "s16le"
		const sampleRate = Number(response.headers.get("x-sample-rate"))
		if (!Number.isFinite(sampleRate) || sampleRate <= 0)
			throw new Error("The audio stream sent no usable X-Sample-Rate")
		try {
			for await (const chunk of response.body) chunks.push(Buffer.from(chunk))
		} catch (err) {
			if (!controller.signal.aborted) throw err
		}
		return { format, sampleRate, data: Buffer.concat(chunks) }
	} finally {
		clearTimeout(timer)
		signal.removeEventListener("abort", stop)
	}
}

/** An AbortSignal that fires on the first Ctrl-C (a second one exits at once). */
export function interruptSignal() {
	const controller = new AbortController()
	process.on("SIGINT", () => {
		if (controller.signal.aborted) process.exit(130)
		process.stderr.write(
			"\nInterrupted: restoring and stopping (Ctrl-C again to force)\n",
		)
		controller.abort()
	})
	return controller.signal
}

export function sleep(ms, signal) {
	return new Promise(resolve => {
		const timer = setTimeout(resolve, ms)
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer)
				resolve()
			},
			{ once: true },
		)
	})
}

export function emit(kind, data) {
	process.stdout.write(`${logLine(kind, data)}\n`)
}

/** Runs `main(args)`; UsageError → usage on stderr and exit 2, other errors exit 1. */
export function runMain(usage, parse, main) {
	let args
	try {
		args = parse(process.argv.slice(2))
	} catch (err) {
		if (err instanceof UsageError) {
			process.stderr.write(`${err.message}\n\n${usage}\n`)
			process.exit(2)
		}
		throw err
	}
	if (args.help === true) {
		process.stdout.write(`${usage}\n`)
		return
	}
	main(args).then(
		code => process.exit(code ?? 0),
		err => {
			process.stderr.write(
				`${err instanceof Error ? err.message : String(err)}\n`,
			)
			process.exit(1)
		},
	)
}

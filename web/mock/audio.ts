/**
 * Synthetic live audio on its own HTTP port, like the core's live demodulator: `/stream.wav`
 * (streaming WAV header, s16le mono) and `/stream` (raw PCM with X-Audio-Format and
 * X-Sample-Rate). A tone while the tuned frequency sits on a keyed mock signal, else soft noise.
 */
import { createServer } from "node:http"
import type { IncomingMessage, Server, ServerResponse } from "node:http"
import { signalActive, signalAt } from "./data.ts"

export interface AudioSource {
	/** Null while live audio is stopped. */
	sampleRate(): number | null
	tunedHz(): number
	onClient(delta: number, bytes: number): void
}

const CHUNK_MS = 20

/** RIFF/WAVE header with unknown (maximum) sizes, as streaming servers send it. */
export function wavHeader(sampleRate: number): Buffer {
	const header = Buffer.alloc(44)
	header.write("RIFF", 0, "ascii")
	header.writeUInt32LE(0xffffffff, 4)
	header.write("WAVE", 8, "ascii")
	header.write("fmt ", 12, "ascii")
	header.writeUInt32LE(16, 16)
	header.writeUInt16LE(1, 20) // PCM
	header.writeUInt16LE(1, 22) // mono
	header.writeUInt32LE(sampleRate, 24)
	header.writeUInt32LE(sampleRate * 2, 28)
	header.writeUInt16LE(2, 32)
	header.writeUInt16LE(16, 34)
	header.write("data", 36, "ascii")
	header.writeUInt32LE(0xffffffff, 40)
	return header
}

function stream(
	source: AudioSource,
	req: IncomingMessage,
	res: ServerResponse,
	wav: boolean,
): void {
	const rate = source.sampleRate()
	if (rate === null) {
		// The core's audio server only listens while live audio runs: the client sees a refused or
		// dropped connection (fetch rejects), never an HTTP error.
		req.socket.destroy()
		return
	}
	// As a legacy core (src/core/audio-stream-server.ts, WG7 req 8.1): `Access-Control-Allow-Origin: *`
	// on every answer (set in createAudioServer), so a page on another origin fetch()es it directly.
	res.writeHead(200, {
		"Content-Type": wav ? "audio/wav" : "application/octet-stream",
		"Cache-Control": "no-cache, no-store",
		"X-Audio-Format": "s16le",
		"X-Sample-Rate": String(rate),
		"X-Channels": "1",
		"Access-Control-Expose-Headers":
			"X-Audio-Format, X-Sample-Rate, X-Channels, Retry-After",
	})
	if (wav) res.write(wavHeader(rate))
	source.onClient(1, 0)
	const samples = Math.round((rate * CHUNK_MS) / 1000)
	let phase = 0
	const timer = setInterval(() => {
		if (source.sampleRate() !== rate) {
			res.end()
			return
		}
		const hz = source.tunedHz()
		const signal = signalAt(hz)
		const keyed = signal !== null && signalActive(signal, Date.now() / 1000)
		const toneHz = signal ? 500 + (Math.round(signal.hz / 1000) % 400) : 0
		const buf = Buffer.alloc(samples * 2)
		const step = (2 * Math.PI * toneHz) / rate
		for (let i = 0; i < samples; i++) {
			let v: number
			if (keyed) {
				v = Math.sin(phase) * 0.25 + (Math.random() - 0.5) * 0.02
				phase += step
			} else v = (Math.random() - 0.5) * 0.06
			buf.writeInt16LE(Math.round(v * 32767), i * 2)
		}
		if (phase > 1e6) phase %= 2 * Math.PI
		res.write(buf)
		source.onClient(0, buf.length)
	}, CHUNK_MS)
	let stopped = false
	const stop = () => {
		if (stopped) return
		stopped = true
		clearInterval(timer)
		source.onClient(-1, 0)
	}
	req.on("close", stop)
	res.on("error", stop)
}

export function createAudioServer(source: AudioSource): Server {
	return createServer((req, res) => {
		const path = (req.url ?? "/").split("?")[0]
		const known = path === "/stream" || path === "/stream.wav"
		res.setHeader("Access-Control-Allow-Origin", "*")
		// WG7 req 8.2: a legacy core answers a preflight on a stream path, 404 elsewhere
		if (req.method === "OPTIONS" && known) {
			res.writeHead(204, {
				"Access-Control-Allow-Methods": "GET, OPTIONS",
				"Access-Control-Allow-Headers": "Range",
				"Access-Control-Max-Age": "600",
			})
			res.end()
			return
		}
		if (req.method === "GET" && path === "/stream.wav")
			return stream(source, req, res, true)
		if (req.method === "GET" && path === "/stream")
			return stream(source, req, res, false)
		res.writeHead(404, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: "Not Found" }))
	})
}

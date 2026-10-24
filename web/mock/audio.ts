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
	/**
	 * Decoded digital voice on `/voice` and `/voice.wav` (the core serves it on its own port): the rate
	 * while the stream runs, else null; `talking()` says when a call plays (else silence).
	 */
	voice?: { sampleRate(): number | null; talking(): boolean }
	/** `/auto` (auto-listen-route): 48 kHz while live audio runs; plays the voice warble while a call talks. */
	auto?: { onClient(delta: number): void }
}

type StreamKind = "analog" | "voice" | "auto"
const AUTO_RATE = 48_000

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
	kind: StreamKind = "analog",
): void {
	const auto = kind === "auto"
	const rateOf = () =>
		kind === "voice"
			? (source.voice?.sampleRate() ?? null)
			: auto
				? source.sampleRate() === null
					? null
					: AUTO_RATE
				: source.sampleRate()
	const rate = rateOf()
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
	if (kind === "analog") source.onClient(1, 0)
	if (auto) source.auto?.onClient(1)
	const samples = Math.round((rate * CHUNK_MS) / 1000)
	let phase = 0
	const timer = setInterval(() => {
		if (rateOf() !== rate) {
			res.end()
			return
		}
		const hz = source.tunedHz()
		const signal = signalAt(hz)
		// /auto plays the decoded call while one talks, else the analog channel
		const voice =
			kind === "voice" ||
			(auto && source.voice?.sampleRate() != null && source.voice.talking())
		const keyed = voice
			? source.voice?.talking() === true
			: signal !== null && signalActive(signal, Date.now() / 1000)
		// decoded voice: a warbling tone with no hiss, so it sounds unlike the analog channel
		const toneHz = voice
			? 400 + 120 * Math.sin(Date.now() / 160)
			: signal
				? 500 + (Math.round(signal.hz / 1000) % 400)
				: 0
		const buf = Buffer.alloc(samples * 2)
		const step = (2 * Math.PI * toneHz) / rate
		for (let i = 0; i < samples; i++) {
			let v: number
			if (voice && !keyed) v = 0
			else if (keyed) {
				v = Math.sin(phase) * 0.25 + (Math.random() - 0.5) * 0.02
				phase += step
			} else v = (Math.random() - 0.5) * 0.06
			buf.writeInt16LE(Math.round(v * 32767), i * 2)
		}
		if (phase > 1e6) phase %= 2 * Math.PI
		res.write(buf)
		if (kind === "analog") source.onClient(0, buf.length)
	}, CHUNK_MS)
	let stopped = false
	const stop = () => {
		if (stopped) return
		stopped = true
		clearInterval(timer)
		if (kind === "analog") source.onClient(-1, 0)
		if (auto) source.auto?.onClient(-1)
	}
	req.on("close", stop)
	res.on("error", stop)
}

export function createAudioServer(source: AudioSource): Server {
	return createServer((req, res) => {
		const path = (req.url ?? "/").split("?")[0]
		const known =
			path === "/stream" ||
			path === "/stream.wav" ||
			path === "/voice" ||
			path === "/voice.wav" ||
			path === "/auto" ||
			path === "/auto.wav"
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
		if (req.method === "GET" && path === "/voice.wav")
			return stream(source, req, res, true, "voice")
		if (req.method === "GET" && path === "/voice")
			return stream(source, req, res, false, "voice")
		if (req.method === "GET" && path === "/auto.wav")
			return stream(source, req, res, true, "auto")
		if (req.method === "GET" && path === "/auto")
			return stream(source, req, res, false, "auto")
		res.writeHead(404, { "Content-Type": "application/json" })
		res.end(JSON.stringify({ error: "Not Found" }))
	})
}

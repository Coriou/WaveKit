/**
 * Replays dsd-fme UDP voice captured on 2026-10-09 (pinned dsd-fme, YSF IQ
 * fixture fed in real time, `-fa -o udp`) into the digital voice stream over
 * real loopback UDP, and reads the stream back over HTTP.
 */

import * as dgram from "node:dgram"
import * as http from "node:http"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { afterEach, describe, expect, it } from "vitest"
import { createLogger } from "../../src/utils/logger.js"
import { DigitalVoiceConfigSchema } from "../../src/config.js"
import { DigitalVoiceService } from "../../src/core/digital-voice.js"
import { downmixDsdFmeDatagram } from "../../src/core/dsd-fme-voice-format.js"

const dir = new URL("../mocks/fixtures/dsd-fme/", import.meta.url)
const timeline = readFileSync(
	fileURLToPath(new URL("udp-ysf-auto-stereo.txt", dir)),
	"utf8",
)
	.split("\n")
	.filter(line => line && !line.startsWith("#"))
	.map(line => {
		const [us, bytes] = line.split("\t")
		return { atMs: Number(us) / 1000, bytes: Number(bytes) }
	})
const payload = readFileSync(
	fileURLToPath(new URL("udp-ysf-auto-stereo.bin", dir)),
)

async function freePort(): Promise<number> {
	for (;;) {
		const candidate = 20_000 + Math.floor(Math.random() * 25_000)
		const free = await new Promise<boolean>(resolve => {
			const server = http.createServer()
			server.once("error", () => resolve(false))
			server.listen(candidate, "0.0.0.0", () =>
				server.close(() => resolve(true)),
			)
		})
		if (free) return candidate
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}

describe("digital voice UDP replay", () => {
	let service: DigitalVoiceService | undefined
	afterEach(async () => {
		await service?.destroy()
	})

	it("turns the captured bursty datagrams into one continuous 8 kHz stream containing the voice in order", async () => {
		const port = await freePort()
		service = new DigitalVoiceService(
			createLogger({ level: "fatal" }),
			// A wide jitter target keeps this test stable on a loaded machine.
			DigitalVoiceConfigSchema.parse({
				httpPort: port,
				jitterBufferMs: 500,
				maxBufferMs: 2000,
			}),
		)
		const [prepared] = await service.prepareDecoderConfigs([
			{
				id: "dsd-fme",
				type: "dsd-fme",
				enabled: true,
				options: { mode: "auto" },
			},
		])
		const udpPort = prepared!.options["udpPort"] as number
		await service.start()

		const body: Buffer[] = []
		const response = await new Promise<http.IncomingMessage>(
			(resolve, reject) => {
				const req = http.get(
					{ host: "127.0.0.1", port, path: "/stream.wav" },
					resolve,
				)
				req.on("error", reject)
			},
		)
		expect(response.headers["x-sample-rate"]).toBe("8000")
		response.on("data", (chunk: Buffer) => body.push(chunk))
		const startedAt = Date.now()

		// Replay with the captured timing.
		const sender = dgram.createSocket("udp4")
		await sleep(300)
		const replayStart = Date.now()
		let offset = 0
		for (const { atMs, bytes } of timeline) {
			const wait = replayStart + atMs - Date.now()
			if (wait > 0) await sleep(wait)
			const datagram = payload.subarray(offset, offset + bytes)
			offset += bytes
			await new Promise<void>((resolve, reject) =>
				sender.send(datagram, udpPort, "127.0.0.1", err =>
					err ? reject(err) : resolve(),
				),
			)
		}
		sender.close()
		await sleep(1200)
		const elapsedMs = Date.now() - startedAt
		response.destroy()

		const all = Buffer.concat(body)
		expect(all.subarray(0, 4).toString("ascii")).toBe("RIFF")
		const pcm = all.subarray(44)

		// Constant rate: about 16 000 bytes per second of wall clock, whatever
		// the burst pattern (allow for timer slack on a loaded host).
		const expectedBytes = (elapsedMs / 1000) * 16_000
		expect(pcm.length).toBeGreaterThan(expectedBytes * 0.85)
		expect(pcm.length).toBeLessThan(expectedBytes * 1.05)

		// The voice arrives intact, contiguous and in order.
		const voice = Buffer.concat(
			timeline.map(
				(_entry, i) =>
					downmixDsdFmeDatagram(payload.subarray(i * 640, (i + 1) * 640), 2)!,
			),
		)
		const firstSound = voice.findIndex(byte => byte !== 0)
		const audible = voice.subarray(firstSound - (firstSound % 2))
		expect(pcm.indexOf(audible)).toBeGreaterThan(0)

		// Exact silence before the call and after it.
		const at = pcm.indexOf(audible)
		expect(pcm.subarray(0, 4000).every(byte => byte === 0)).toBe(true)
		expect(pcm.subarray(at + audible.length).every(byte => byte === 0)).toBe(
			true,
		)
		expect(at % 2).toBe(0)

		const status = service.getStatus().decoders[0]!
		expect(status.datagramsReceived).toBe(timeline.length)
		expect(status.datagramsRejected).toBe(0)
		expect(status.droppedSamples).toBe(0)
	}, 15_000)
})

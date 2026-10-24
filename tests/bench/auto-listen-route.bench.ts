/**
 * Auto listen route desktop figures (docs/specs/auto-listen-route/design.md, Budgets).
 * Not collected by the root suite (only `tests/**\/*.test.ts`); run with
 * `pnpm exec vitest bench --run tests/bench/auto-listen-route.bench.ts`.
 *
 * Each "1 s" bench processes one second of audio (50 chunks of 20 ms and 50 pacer ticks with one
 * `/auto` client), so its mean in ms divided by 1 000 is the core fraction.
 */
import { EventEmitter } from "node:events"
import type * as http from "node:http"
import { bench, describe } from "vitest"
import { AUTO_ROUTE_STREAM } from "../../src/core/auto-listen/contract.js"
import type {
	AutoRouteClock,
	VoiceCoverage,
	VoiceCoveragePort,
	VoiceTap,
	VoiceTapCall,
	VoiceTapSource,
} from "../../src/core/auto-listen/contract.js"
import { PreRollShadow } from "../../src/core/auto-listen/preroll-shadow.js"
import {
	PolyphaseResampler,
	rationalRate,
} from "../../src/core/auto-listen/resampler.js"
import { AutoListenRouter } from "../../src/core/auto-listen/router.js"
import type { StreamFormat } from "../../src/core/audio-stream-server.js"
import { createLogger } from "../../src/utils/logger.js"

const logger = createLogger({ level: "fatal" })

class Clock implements AutoRouteClock {
	t = 0
	fn: (() => void) | null = null
	now(): number {
		return this.t
	}
	setInterval(fn: () => void): unknown {
		this.fn = fn
		return 1
	}
	clearInterval(): void {
		this.fn = null
	}
}

class Sink extends EventEmitter {
	writableEnded = false
	destroyed = false
	write(): boolean {
		return true
	}
	end(): void {}
	destroy(): void {}
}

class Voice implements VoiceTapSource {
	tap: VoiceTap | null = null
	readonly voiceSampleRate = 8_000
	addVoiceTap(tap: VoiceTap): () => void {
		this.tap = tap
		return () => {
			this.tap = null
		}
	}
}

class Coverage implements VoiceCoveragePort {
	generation = 0
	covers(): VoiceCoverage {
		return "yes"
	}
}

const CALL: VoiceTapCall = {
	callId: "c1",
	active: true,
	encrypted: false,
	protocol: "DMR",
	slot: 1,
}

function setup(withVoice: boolean): {
	router: AutoListenRouter
	clock: Clock
	voice: Voice
	coverage: Coverage
} {
	const clock = new Clock()
	const router = new AutoListenRouter(logger, { clock })
	const voice = new Voice()
	const coverage = new Coverage()
	if (withVoice) router.attachVoice(voice, coverage)
	router.registry.register(
		new Sink() as unknown as http.ServerResponse,
		"127.0.0.1",
		AUTO_ROUTE_STREAM,
	)
	return { router, clock, voice, coverage }
}

function analogChunk(rate: number, format: "s16le" | "f32le"): Buffer {
	// 20 ms of samples (rounded for a fractional rate; the bench measures cost, not timing).
	const n = Math.round(rate / 50)
	if (format === "s16le") {
		const a = Int16Array.from({ length: n }, (_, i) =>
			Math.round(10_000 * Math.sin(i * 0.05)),
		)
		return Buffer.from(a.buffer)
	}
	const f = Float32Array.from({ length: n }, (_, i) => 0.3 * Math.sin(i * 0.05))
	return Buffer.from(f.buffer)
}

const voiceFrame = Buffer.from(
	Int16Array.from({ length: 160 }, (_, i) =>
		Math.round(8_000 * Math.sin(i * 0.3)),
	).buffer,
)

function analogSecond(rate: number, format: "s16le" | "f32le") {
	const { router, clock } = setup(false)
	const chunk = analogChunk(rate, format)
	const stream: StreamFormat = { rate, format }
	return () => {
		for (let i = 0; i < 50; i++) {
			router.pushAnalog(chunk, 0, chunk.length, true, stream)
			clock.t += 20
			clock.fn?.()
		}
	}
}

function resampleSecond(rate: number, format: "s16le" | "f32le") {
	const res = new PolyphaseResampler(rationalRate(rate) ?? rate, 48_000)
	const chunk = analogChunk(rate, format)
	const view =
		format === "s16le"
			? new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2)
			: new Float32Array(chunk.buffer, chunk.byteOffset, chunk.length / 4)
	const out = new Int16Array(4_096)
	const flags = new Uint8Array(4_096)
	return () => {
		for (let k = 0; k < 50; k++) {
			let i = 0
			while (i < view.length) {
				res.process(view, i, view.length, out, 0, out.length, 1, flags)
				i += res.consumed
			}
		}
	}
}

describe("resampler alone, 1 s of audio per iteration (mean ms / 1 000 = core)", () => {
	bench("resample 8 000 Hz voice → 48 kHz", resampleSecond(8_000, "s16le"))
	bench("resample 25 600 Hz s16le → 48 kHz", resampleSecond(25_600, "s16le"))
	bench("resample 25 000 Hz s16le → 48 kHz", resampleSecond(25_000, "s16le"))
	bench(
		"resample 24 975.61 Hz s16le (1 024 000 / 41) → 48 kHz",
		resampleSecond(1_024_000 / 41, "s16le"),
	)
	bench("resample 200 000 Hz f32le → 48 kHz", resampleSecond(200_000, "f32le"))
})

describe("auto listen route, 1 s of audio per iteration (mean ms / 1 000 = core)", () => {
	bench(
		"analog NFM 25 600 Hz s16le (2.048 Msps)",
		analogSecond(25_600, "s16le"),
	)
	bench("analog NFM 25 000 Hz s16le (2.4 Msps)", analogSecond(25_000, "s16le"))
	bench(
		"analog NFM 24 975.61 Hz s16le (1.024 Msps / 41)",
		analogSecond(1_024_000 / 41, "s16le"),
	)
	bench("analog 200 000 Hz f32le (worst case)", analogSecond(200_000, "f32le"))

	{
		const { router, clock, voice } = setup(true)
		const chunk = analogChunk(25_000, "s16le")
		const stream: StreamFormat = { rate: 25_000, format: "s16le" }
		bench("NFM 25 kHz + one DMR decoder (digital selected)", () => {
			for (let i = 0; i < 50; i++) {
				router.pushAnalog(chunk, 0, chunk.length, true, stream)
				voice.tap?.frame("dmr", voiceFrame, CALL)
				clock.t += 20
				clock.fn?.()
			}
		})
	}

	{
		const { router, clock, voice } = setup(true)
		const chunk = analogChunk(200_000, "f32le")
		const stream: StreamFormat = { rate: 200_000, format: "f32le" }
		bench("200 kHz f32le + two decoders (worst case total)", () => {
			for (let i = 0; i < 50; i++) {
				router.pushAnalog(chunk, 0, chunk.length, true, stream)
				voice.tap?.frame("dmr-a", voiceFrame, CALL)
				voice.tap?.frame("dmr-b", voiceFrame, CALL)
				clock.t += 20
				clock.fn?.()
			}
		})
	}

	{
		const { router, clock, voice, coverage } = setup(true)
		const chunk = analogChunk(25_000, "s16le")
		const stream: StreamFormat = { rate: 25_000, format: "s16le" }
		bench(
			"NFM 25 kHz + decoder, 10 coverage generations and 20 status() per s",
			() => {
				for (let i = 0; i < 50; i++) {
					router.pushAnalog(chunk, 0, chunk.length, true, stream)
					voice.tap?.frame("dmr", voiceFrame, CALL)
					if (i % 5 === 0) coverage.generation++
					clock.t += 20
					clock.fn?.()
					if (i % 5 < 2) router.status({ httpUrl: "h", wavUrl: "w" })
				}
			},
		)
	}

	{
		// No `/auto` client: the shadow's tag bookkeeping, two calls per 10 ms slice.
		const shadow = new PreRollShadow({ rate: 25_000, format: "s16le" })
		const bytes = 250 * 2
		let k = 0
		bench("pre-roll shadow alone, 25 kHz s16le (no client)", () => {
			for (let i = 0; i < 100; i++) {
				k++
				const tag = k % 200 < 120 ? "pass" : k % 200 < 160 ? "pending" : "drop"
				shadow.process(bytes / 2, tag)
				shadow.process(bytes / 2, tag)
				if (k % 200 === 159) shadow.latch()
				void shadow.sync(shadow.delaySamples)
			}
		})
	}
})

describe("auto listen route, single call (requirement 8.2: under 1 ms at 200 kHz)", () => {
	const { router, clock } = setup(false)
	const chunk = analogChunk(200_000, "f32le")
	const stream: StreamFormat = { rate: 200_000, format: "f32le" }
	bench("one 20 ms 200 kHz f32le chunk plus its tick", () => {
		router.pushAnalog(chunk, 0, chunk.length, true, stream)
		clock.t += 20
		clock.fn?.()
	})
	const t = setup(false)
	const c25 = analogChunk(25_000, "s16le")
	const s25: StreamFormat = { rate: 25_000, format: "s16le" }
	bench("one pacer tick emitting 5 blocks (catch-up maximum)", () => {
		for (let i = 0; i < 5; i++)
			t.router.pushAnalog(c25, 0, c25.length, true, s25)
		t.clock.t += 100
		t.clock.fn?.()
	})
})

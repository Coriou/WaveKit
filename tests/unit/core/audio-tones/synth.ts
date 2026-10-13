/** Test-only PCM synthesis. Not a fixture file; every sample is computed here. */

export interface TonePcm {
	rate: number
	format: "s16le" | "f32le"
	samples: Float64Array
	pcm: Buffer
}

export function mulberry32(seed: number): () => number {
	let state = seed >>> 0
	return () => {
		state = (state + 0x6d2b79f5) | 0
		let t = Math.imul(state ^ (state >>> 15), 1 | state)
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

export function gaussian(rand: () => number): number {
	const u = Math.max(rand(), 1e-12)
	const v = rand()
	return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
}

/** σ for a sine of amplitude A so that tone power / noise power is `snrDb`. */
export function noiseStdForSnr(amplitude: number, snrDb: number): number {
	return amplitude / Math.sqrt(2 * 10 ** (snrDb / 10))
}

export function renderPcm(
	samples: Float64Array,
	rate: number,
	format: "s16le" | "f32le" = "f32le",
): TonePcm {
	const pcm =
		format === "f32le"
			? Buffer.alloc(samples.length * 4)
			: Buffer.alloc(samples.length * 2)
	for (let i = 0; i < samples.length; i++) {
		const sample = samples[i] ?? 0
		if (format === "f32le") pcm.writeFloatLE(sample, i * 4)
		else {
			const clipped = Math.max(-1, Math.min(1, sample))
			pcm.writeInt16LE(Math.round(clipped * 32_767), i * 2)
		}
	}
	return { rate, format, samples, pcm }
}

export function sine(options: {
	hz: number
	seconds: number
	rate: number
	amplitude: number
	noiseStd?: number
	seed?: number
	format?: "s16le" | "f32le"
	extraHz?: number
	extraAmplitude?: number
}): TonePcm {
	const n = Math.round(options.seconds * options.rate)
	const samples = new Float64Array(n)
	const rand = mulberry32(options.seed ?? 1)
	const noise = options.noiseStd ?? 0
	for (let i = 0; i < n; i++) {
		const t = i / options.rate
		let sample = options.amplitude * Math.sin(2 * Math.PI * options.hz * t)
		if (options.extraHz !== undefined) {
			sample +=
				(options.extraAmplitude ?? options.amplitude) *
				Math.sin(2 * Math.PI * options.extraHz * t)
		}
		if (noise > 0) sample += noise * gaussian(rand)
		samples[i] = sample
	}
	return renderPcm(samples, options.rate, options.format ?? "f32le")
}

const ROWS = [697, 770, 852, 941] as const
const COLS = [1209, 1336, 1477, 1633] as const
const GRID = "123A456B789C*0#D"

export function dtmfFreqs(symbol: string): { row: number; col: number } {
	const index = GRID.indexOf(symbol)
	if (index < 0) throw new Error(`bad dtmf symbol ${symbol}`)
	return { row: ROWS[Math.floor(index / 4)] ?? 0, col: COLS[index % 4] ?? 0 }
}

export function dtmfString(options: {
	symbols: string
	rate: number
	onSeconds: number
	offSeconds: number
	amplitude: number
	twistDb?: number
	format?: "s16le" | "f32le"
}): TonePcm {
	const on = Math.round(options.onSeconds * options.rate)
	const off = Math.round(options.offSeconds * options.rate)
	const twist = options.twistDb ?? 0
	const colScale = 10 ** (twist / 20)
	const samples = new Float64Array(options.symbols.length * (on + off))
	let at = 0
	for (const symbol of options.symbols) {
		const { row, col } = dtmfFreqs(symbol)
		for (let i = 0; i < on; i++) {
			const t = i / options.rate
			samples[at + i] =
				options.amplitude * Math.sin(2 * Math.PI * row * t) +
				options.amplitude * colScale * Math.sin(2 * Math.PI * col * t)
		}
		at += on + off
	}
	return renderPcm(samples, options.rate, options.format ?? "f32le")
}

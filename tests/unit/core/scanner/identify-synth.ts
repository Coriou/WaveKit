import { ToneDetector } from "../../../../src/core/audio-tones/tone-detector.js"

const RATE = 48_000

/** Independent 48 kHz complex FM generator and reference quadrature discriminator. */
export function syntheticTone(opts: {
	kind: "ctcss" | "dcs" | "fsk4"
	deviation: number
	snr: number
	seed: number
	inverted?: boolean
	baud?: number
	offset?: number
}) {
	let seed = opts.seed | 0
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) | 0
		return ((seed >>> 0) + 1) / 4294967297
	}
	const gaussian = () =>
		Math.sqrt(-2 * Math.log(random())) * Math.cos(2 * Math.PI * random())
	const sigma = Math.sqrt(0.5 * 10 ** (-opts.snr / 10))
	const seconds = opts.kind === "dcs" ? 1.2 : 0.8
	const count = RATE * seconds
	const iq = new Float32Array(count * 2)
	const data = 0o25 | (0b100 << 9)
	let remainder = data << 11
	for (let i = 22; i >= 11; i--)
		if (remainder & (1 << i)) remainder ^= 0xc75 << (i - 11)
	const bits = [
		...Array.from({ length: 12 }, (_, i) => (data >>> i) & 1),
		...Array.from({ length: 11 }, (_, i) => (remainder >>> i) & 1),
	]
	const baud = opts.baud ?? 2400
	const symbols = Array.from(
		{ length: Math.ceil(seconds * baud) + 10 },
		() => [-1, -1 / 3, 1 / 3, 1][Math.floor(random() * 4)] ?? 1,
	)
	let phase = 0
	for (let i = 0; i < count; i++) {
		const t = i / RATE
		let modulation: number
		if (opts.kind === "ctcss")
			modulation = 0.15 * Math.sin(2 * Math.PI * 74.4 * t)
		else if (opts.kind === "dcs")
			modulation =
				0.15 *
				((bits[Math.floor(t * 134.4) % 23] ?? 0) * 2 - 1) *
				(opts.inverted ? -1 : 1)
		else {
			// Raised-cosine transitions retain the four deviation plateaux.
			const position = t * baud
			const symbol = Math.floor(position)
			const blend = Math.min(1, (position - symbol) / 0.2)
			const weight = (1 - Math.cos(Math.PI * blend)) / 2
			modulation =
				(symbols[symbol] ?? 0) * weight +
				(symbols[Math.max(0, symbol - 1)] ?? 0) * (1 - weight)
		}
		phase +=
			(2 * Math.PI * ((opts.offset ?? 0) + opts.deviation * modulation)) / RATE
		iq[2 * i] = Math.cos(phase) + sigma * gaussian()
		iq[2 * i + 1] = Math.sin(phase) + sigma * gaussian()
	}
	const pcm = Buffer.alloc((count / 6) * 4)
	const disc: number[] = []
	let previousI = iq[0] ?? 0
	let previousQ = iq[1] ?? 0
	let sum = 0
	for (let i = 0; i < count; i++) {
		const re = iq[2 * i] ?? 0
		const im = iq[2 * i + 1] ?? 0
		const frequency =
			(Math.atan2(
				im * previousI - re * previousQ,
				re * previousI + im * previousQ,
			) *
				RATE) /
				(2 * Math.PI) -
			(opts.offset ?? 0)
		previousI = re
		previousQ = im
		sum += frequency
		if (i % 6 === 5) {
			const value = sum / 6
			disc.push(value)
			pcm.writeFloatLE(value / 5000, Math.floor(i / 6) * 4)
			sum = 0
		}
	}
	const detector = new ToneDetector()
	detector.push(pcm, { rate: 8000, format: "f32le" })
	const tone = detector.result()
	return {
		tones: {
			ctcssHz: tone.ctcssHz,
			dcs: tone.dcs ?? null,
			audioSeconds: seconds,
		},
		disc,
	}
}

/** Reference statistics from discriminator audio; no native process or receiver. */
export function referenceStats(disc: readonly number[]) {
	const frames = []
	const envelope: number[] = []
	for (let start = 0; start + 400 <= disc.length; start += 400) {
		const values = disc.slice(start, start + 400)
		// Sample 80 evenly spaced values for clustering; envelope power below
		// still uses every sample in the full 50 ms frame.
		const clustered = values.filter((_, i) => i % 5 === 0)
		const sorted = [...clustered].sort((a, b) => a - b)
		let centroids = [0.125, 0.375, 0.625, 0.875].map(
			q => sorted[Math.floor(q * sorted.length)] ?? 0,
		)
		for (let iteration = 0; iteration < 8; iteration++) {
			const sums = [0, 0, 0, 0]
			const counts = [0, 0, 0, 0]
			for (const value of clustered) {
				let nearest = 0
				for (let i = 1; i < 4; i++)
					if (
						Math.abs(value - (centroids[i] ?? 0)) <
						Math.abs(value - (centroids[nearest] ?? 0))
					)
						nearest = i
				sums[nearest] = (sums[nearest] ?? 0) + value
				counts[nearest] = (counts[nearest] ?? 0) + 1
			}
			centroids = centroids.map((value, i) =>
				(counts[i] ?? 0) > 0 ? (sums[i] ?? 0) / (counts[i] ?? 1) : value,
			)
		}
		centroids.sort((a, b) => a - b)
		const spacing = Math.min(
			...centroids.slice(1).map((value, i) => value - (centroids[i] ?? 0)),
		)
		const cluster =
			clustered.filter(value =>
				centroids.some(c => Math.abs(c - value) <= spacing * 0.15),
			).length / clustered.length
		const mean =
			values.reduce((sum, value) => sum + value * value, 0) / values.length
		envelope.push(mean)
		if (envelope.length > 20) envelope.shift()
		// Measure the 2–10 Hz envelope at 20 Hz, as analyze does. Variation
		// between 10 ms blocks measures random data/noise, not syllables.
		const alpha = Math.exp((-2 * Math.PI * 2) / 20)
		let previous = envelope[0] ?? 0
		let highPassed = 0
		let energy = 0
		let total = 0
		for (const power of envelope) {
			highPassed = alpha * (highPassed + power - previous)
			previous = power
			energy += highPassed * highPassed
			total += power
		}
		const syllabic =
			Math.sqrt(energy / envelope.length) /
			Math.max(total / envelope.length, 1e-12)
		frames.push({
			carrierDb: -10,
			hfNoiseDb: -12,
			audioDb: 10 * Math.log10(Math.max(1e-12, mean / 25_000_000)),
			syllabic,
			cluster,
		})
	}
	return { mode: "nfm" as const, floorDb: -60, gapSamples: 0, frames }
}

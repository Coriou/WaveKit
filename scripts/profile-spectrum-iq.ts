/**
 * Seeded synthetic CU8 for the spectrum profile harnesses: Gaussian noise (3.5 LSB
 * RMS per rail), three CW carriers, one NFM carrier and Mode-S-like PPM bursts
 * (400 per second). Offsets are relative to the tuned centre; no real allocation.
 */
function xorshift(seed: number): () => number {
	let x = seed >>> 0 || 1
	return () => {
		x ^= x << 13
		x >>>= 0
		x ^= x >>> 17
		x ^= x << 5
		x >>>= 0
		return x / 4_294_967_296
	}
}

function gaussian(rnd: () => number): () => number {
	let spare: number | null = null
	return () => {
		if (spare !== null) {
			const s = spare
			spare = null
			return s
		}
		const u = Math.max(1e-12, rnd())
		const v = rnd()
		const r = Math.sqrt(-2 * Math.log(u))
		spare = r * Math.sin(2 * Math.PI * v)
		return r * Math.cos(2 * Math.PI * v)
	}
}

/** Float I/Q around 0 (LSB units), quantised to CU8 at the end. */
export function synthesizeCu8(rate: number, seconds: number): Uint8Array {
	const n = Math.round(rate * seconds)
	const re = new Float32Array(n)
	const im = new Float32Array(n)
	const rnd = xorshift(0x2545f491)
	const g = gaussian(rnd)
	for (let i = 0; i < n; i++) {
		re[i] = 3.5 * g()
		im[i] = 3.5 * g()
	}
	const tone = (offsetHz: number, amp: number, fmHz = 0, devHz = 0): void => {
		let ph = 0
		for (let i = 0; i < n; i++) {
			const f =
				offsetHz +
				(devHz > 0 ? devHz * Math.sin((2 * Math.PI * fmHz * i) / rate) : 0)
			ph += (2 * Math.PI * f) / rate
			re[i] = (re[i] ?? 0) + amp * Math.cos(ph)
			im[i] = (im[i] ?? 0) + amp * Math.sin(ph)
		}
	}
	tone(-700_000, 4)
	tone(350_000, 9)
	tone(820_000, 18)
	tone(-310_000, 12, 900, 3000)
	// Mode-S-like PPM bursts: 8 µs preamble (pulses at 0, 1, 3.5, 4.5 µs) then
	// 56 or 112 bits of 1 µs, a 0.5 µs pulse in the first or second half.
	const brnd = xorshift(0x9e3779b9)
	const perSecond = 400
	const bursts = Math.round(perSecond * seconds)
	const us = rate / 1e6
	for (let b = 0; b < bursts; b++) {
		const start = Math.floor(brnd() * (n - 130 * us))
		const amp = 15 + brnd() * 95
		const phase = 2 * Math.PI * brnd()
		const offsetHz = (brnd() - 0.5) * 200_000
		const pulse = (atUs: number): void => {
			const a = start + Math.round(atUs * us)
			const e = a + Math.max(1, Math.round(0.5 * us))
			for (let i = a; i < e && i < n; i++) {
				const ph = phase + (2 * Math.PI * offsetHz * i) / rate
				re[i] = (re[i] ?? 0) + amp * Math.cos(ph)
				im[i] = (im[i] ?? 0) + amp * Math.sin(ph)
			}
		}
		for (const p of [0, 1, 3.5, 4.5]) pulse(p)
		const bits = brnd() < 0.5 ? 56 : 112
		for (let k = 0; k < bits; k++) pulse(8 + k + (brnd() < 0.5 ? 0 : 0.5))
	}
	const out = new Uint8Array(2 * n)
	for (let i = 0; i < n; i++) {
		out[2 * i] = Math.max(0, Math.min(255, Math.round(127.5 + (re[i] ?? 0))))
		out[2 * i + 1] = Math.max(
			0,
			Math.min(255, Math.round(127.5 + (im[i] ?? 0))),
		)
	}
	return out
}

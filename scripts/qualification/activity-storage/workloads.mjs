// Disposable synthetic input only. No work runs when this module is imported.
export const WORKLOAD_VERSION = 1
export const SEED = 42
export const MAX_VIRTUAL_SECONDS = 900

export function* offers(scenario, seconds, seed = SEED) {
	if (
		!["steady", "burst", "overload", "micro"].includes(scenario) ||
		!Number.isInteger(seconds) ||
		seconds < 1 ||
		seconds > MAX_VIRTUAL_SECONDS ||
		seed !== SEED
	) {
		throw new Error("Invalid bounded workload")
	}
	let id = 0
	let state = seed
	for (let second = 0; second < seconds; second++) {
		const rate =
			scenario === "overload"
				? 500
				: scenario === "burst"
					? second % 60 < 58
						? 80
						: 500
					: scenario === "micro"
						? 10
						: 100
		for (let slot = 0; slot < rate; slot++) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0
			yield {
				id: ++id,
				producer: slot % 10,
				timeMs: second * 1000 + (slot * 1000) / rate,
				payload: `synthetic seed42 ${state} `.padEnd(2560, "x"),
			}
		}
	}
}

// Streaming token buckets; retained state is ten producer buckets and one global bucket.
export function admissionCounts(input) {
	let global = 1000
	let previous = 0
	const tokens = Array(10).fill(200)
	const last = Array(10).fill(0)
	const result = {
		offered: 0,
		admitted: 0,
		rejected: 0,
		globalRejected: 0,
		producerRejected: 0,
	}
	for (const event of input) {
		const p = event.producer
		if (
			!Number.isInteger(p) ||
			p < 0 ||
			p > 9 ||
			!Number.isFinite(event.timeMs) ||
			event.timeMs < previous
		) {
			throw new Error("Invalid offer ordering")
		}
		global = Math.min(1000, global + (event.timeMs - previous) / 10)
		tokens[p] = Math.min(200, tokens[p] + (event.timeMs - last[p]) / 20)
		previous = event.timeMs
		last[p] = event.timeMs
		result.offered++
		if (tokens[p] + 1e-9 < 1) result.producerRejected++
		else if (global + 1e-9 < 1) result.globalRejected++
		else {
			global -= 1
			tokens[p] -= 1
			result.admitted++
			continue
		}
		result.rejected++
	}
	return result
}

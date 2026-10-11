// Disposable synthetic input only. No work runs when this module is imported.
export const WORKLOAD_VERSION = 2
export const SEED = 42
export const MAX_VIRTUAL_SECONDS = 900

function rateAt(scenario, second) {
	return scenario === "overload"
		? 500
		: scenario === "burst"
			? second % 60 < 58
				? 80
				: 500
			: scenario === "micro"
				? 10
				: 100
}
function validate(scenario, seconds, seed) {
	if (
		!["steady", "burst", "overload", "micro"].includes(scenario) ||
		!Number.isInteger(seconds) ||
		seconds < 1 ||
		seconds > MAX_VIRTUAL_SECONDS ||
		seed !== SEED
	)
		throw new Error("Invalid bounded workload")
}
// Integer microseconds are authoritative; timeMs is retained for micro consumers.
export function* offers(scenario, seconds, seed = SEED) {
	validate(scenario, seconds, seed)
	let id = 0
	let state = seed
	for (let second = 0; second < seconds; second++) {
		const rate = rateAt(scenario, second)
		for (let slot = 0; slot < rate; slot++) {
			state = (Math.imul(state, 1664525) + 1013904223) >>> 0
			const timeUs = second * 1000000 + Math.floor((slot * 1000000) / rate)
			yield {
				id: ++id,
				producer: slot % 10,
				timeUs,
				timeMs: timeUs / 1000,
				payload: `synthetic seed42 ${state} `.padEnd(2560, "x"),
			}
		}
	}
}

// Token units are 1/1,000,000 token: no epsilon or wall-time refill.
export function tokenBuckets() {
	let global = 1000 * 1000000
	let previous = 0
	const tokens = Array(10).fill(200 * 1000000)
	const last = Array(10).fill(0)
	return {
		decide(producer, timeUs, admit = true) {
			if (
				!Number.isInteger(producer) ||
				producer < 0 ||
				producer > 9 ||
				!Number.isSafeInteger(timeUs) ||
				timeUs < previous
			)
				throw new Error("Invalid offer ordering")
			global = Math.min(1000 * 1000000, global + (timeUs - previous) * 100)
			tokens[producer] = Math.min(
				200 * 1000000,
				tokens[producer] + (timeUs - last[producer]) * 50,
			)
			previous = timeUs
			last[producer] = timeUs
			const reason =
				tokens[producer] < 1000000
					? "producerRejected"
					: global < 1000000
						? "globalRejected"
						: null
			if (!reason && admit) {
				global -= 1000000
				tokens[producer] -= 1000000
			}
			return reason
		},
	}
}

// Independent streaming token-only reference. Intentionally does not call the
// observed bucket implementation; virtual results cannot qualify runtime latency.
export function admissionCounts(input) {
	let global = 1000000000
	let previous = 0
	const producers = Array(10).fill(200000000)
	const clocks = Array(10).fill(0)
	const result = {
		offered: 0,
		admitted: 0,
		rejected: 0,
		globalRejected: 0,
		producerRejected: 0,
	}
	for (const event of input) {
		const p = event.producer
		const t = event.timeUs ?? event.timeMs * 1000
		if (
			!Number.isInteger(p) ||
			p < 0 ||
			p > 9 ||
			!Number.isSafeInteger(t) ||
			t < previous
		)
			throw new Error("Invalid offer ordering")
		global = Math.min(1000000000, global + (t - previous) * 100)
		producers[p] = Math.min(200000000, producers[p] + (t - clocks[p]) * 50)
		previous = t
		clocks[p] = t
		result.offered++
		if (producers[p] < 1000000) result.producerRejected++
		else if (global < 1000000) result.globalRejected++
		else {
			global -= 1000000
			producers[p] -= 1000000
			result.admitted++
			continue
		}
		result.rejected++
	}
	return result
}

// Streaming cursor: seeking discards stale slots by second arithmetic, never by
// materializing payloads or iterating over a stalled 450,000-offer backlog.
export function offerSchedule(scenario, seconds, seed = SEED) {
	validate(scenario, seconds, seed)
	let second = 0
	let slot = 0
	let id = 0
	let state = seed
	const advance = count => {
		let multiplier = 1664525
		let increment = 1013904223
		while (count > 0) {
			if (count % 2) state = (Math.imul(state, multiplier) + increment) >>> 0
			increment = Math.imul(increment, multiplier + 1) >>> 0
			multiplier = Math.imul(multiplier, multiplier) >>> 0
			count = Math.floor(count / 2)
		}
	}
	const prefix = second => {
		if (scenario !== "burst") return second * rateAt(scenario, 0)
		const minutes = Math.floor(second / 60)
		const tail = second % 60
		return (
			minutes * 5640 + Math.min(tail, 58) * 80 + Math.max(0, tail - 58) * 500
		)
	}
	const time = () =>
		second * 1000000 + Math.floor((slot * 1000000) / rateAt(scenario, second))
	return {
		skipBefore(cutoffUs) {
			if (!Number.isSafeInteger(cutoffUs))
				throw new Error("Invalid schedule cutoff")
			let skipped = 0
			const endSecond = Math.min(
				seconds,
				Math.max(second, Math.floor(cutoffUs / 1000000)),
			)
			if (endSecond > second) {
				const count = prefix(endSecond) - prefix(second) - slot
				skipped += count
				id += count
				second = endSecond
				slot = 0
			}
			if (second < seconds) {
				const rate = rateAt(scenario, second)
				// ceil handles the floored integer schedule and strict lateness.
				const end = Math.min(
					rate,
					Math.max(
						slot,
						Math.ceil(((cutoffUs - second * 1000000) * rate) / 1000000),
					),
				)
				const count = end - slot
				skipped += count
				id += count
				slot = end
				if (slot === rate) {
					second++
					slot = 0
				}
			}
			advance(skipped)
			return skipped
		},
		nextDue(nowUs) {
			if (!Number.isSafeInteger(nowUs) || nowUs < 0)
				throw new Error("Invalid schedule clock")
			if (second >= seconds || time() > nowUs) return null
			const timeUs = time()
			advance(1)
			const row = {
				id: ++id,
				producer: slot % 10,
				timeUs,
				timeMs: timeUs / 1000,
				payload: `synthetic seed42 ${state} `.padEnd(2560, "x"),
			}
			slot++
			if (slot === rateAt(scenario, second)) {
				second++
				slot = 0
			}
			return row
		},
		get done() {
			return second >= seconds
		},
	}
}

export const QUERY_CLASSES = Object.freeze([
	"frequency/keyset",
	"kind/keyset",
	"producer/keyset",
	"FTS-common",
	"FTS-rare",
	"FTS-empty",
	"combined-filter/keyset",
	"filtered-empty-page",
])
export function* queryOffers(seconds = 900) {
	if (!Number.isInteger(seconds) || seconds < 1 || seconds > 900)
		throw new Error("Invalid query duration")
	for (let second = 0; second < seconds; second++)
		for (let client = 0; client < 8; client++)
			yield {
				id: second * 8 + client,
				client,
				timeUs: second * 1000000 + client * 125000,
				queryClass: (second + client) % 8,
			}
}

// Closed tiny fixture. These values are not production DTOs or long seed support.
export function tinyRows(count = 24) {
	if (![20, 24, 25].includes(count))
		throw new Error("Invalid tiny fixture size")
	return Array.from({ length: count }, (_, index) => {
		const sequence = index + 1
		return {
			sequence,
			eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
			producer: sequence % 3,
			ingressUs: sequence * 1000,
			kind: sequence % 2 ? "message" : "call",
			frequency: 100 + (sequence % 3),
			text: `synthetic common ${sequence % 7 === 0 ? "rare" : "ordinary"}`,
			payload: `fixture:${sequence}`,
		}
	})
}
export function tinyQuery(queryClass) {
	if (!Number.isInteger(queryClass) || queryClass < 0 || queryClass > 7)
		throw new Error("Invalid tiny query class")
	return [
		["frequency=101", []],
		["kind='call'", []],
		["producer=1", []],
		[
			"sequence IN (SELECT rowid FROM search WHERE search MATCH ?)",
			['"common"'],
		],
		["sequence IN (SELECT rowid FROM search WHERE search MATCH ?)", ['"rare"']],
		[
			"sequence IN (SELECT rowid FROM search WHERE search MATCH ?)",
			['"absent"'],
		],
		["kind='message' AND producer=1", []],
		["frequency=999", []],
	][queryClass]
}
// Independent expected membership: no SQL predicates, FTS or query implementation.
// Four examined sequence positions/page, including filtered misses and holes.
export function tinyExpectedPage(
	rows,
	cursor,
	current = { generation: 1, lower: 0 },
) {
	if (cursor.contract !== `tiny-v1:ascending:${cursor.queryClass}`)
		return { reset: "filter-contract" }
	if (cursor.generation !== current.generation) return { reset: "generation" }
	if (cursor.lower !== current.lower) return { reset: "retention" }
	const end = Math.min(cursor.high, cursor.after + 4)
	const matches = row =>
		[
			row.frequency === 101,
			row.kind === "call",
			row.producer === 1,
			row.text.split(" ").includes("common"),
			row.text.split(" ").includes("rare"),
			false,
			row.kind === "message" && row.producer === 1,
			false,
		][cursor.queryClass]
	return {
		sequences: rows
			.filter(
				row =>
					row.sequence > cursor.after && row.sequence <= end && matches(row),
			)
			.map(row => row.sequence),
		scannedThrough: end,
		high: cursor.high,
		lower: cursor.lower,
		generation: cursor.generation,
		done: end === cursor.high,
	}
}

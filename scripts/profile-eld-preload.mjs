// Preload for a scratch core under profile-spectrum-main (node --import).
// The first SIGUSR2 starts a main-thread window (event-loop delay at a 1 ms
// timer, utilisation, process CPU); the second writes it as JSON to
// PROFILE_ELD_OUT. Without the second signal the window is written on exit.
// PROFILE_COUNT_CLONES=1 also wraps globalThis.structuredClone: every call in the
// window is counted, and every PROFILE_CLONE_SAMPLE-th call (default 32) records its
// caller stack (5 frames) and JSON size, reported per stack as `clones`.
import { writeFileSync } from "node:fs"
import { monitorEventLoopDelay, performance } from "node:perf_hooks"
import process from "node:process"

const out = process.env.PROFILE_ELD_OUT

if (out) {
	const h = monitorEventLoopDelay({ resolution: 1 })
	let elu0 = performance.eventLoopUtilization()
	let cpu0 = process.cpuUsage()
	let startedAt = Date.now()
	let state = "idle"
	const clones = { calls: 0, sampled: new Map() }
	if (process.env.PROFILE_COUNT_CLONES === "1") {
		const every = Number(process.env.PROFILE_CLONE_SAMPLE) || 32
		const original = globalThis.structuredClone
		globalThis.structuredClone = function structuredClone(value, options) {
			if (state === "open" && clones.calls++ % every === 0) {
				const frames = (new Error().stack ?? "")
					.split("\n")
					.slice(2, 7)
					.map(f =>
						f
							.trim()
							.replace(/^at /, "")
							.replace(/\(file:\/\/[^)]*\//, "("),
					)
				const key = frames.join(" < ")
				let bytes = 0
				try {
					bytes =
						value instanceof ArrayBuffer
							? value.byteLength
							: (JSON.stringify(value)?.length ?? 0)
				} catch {
					bytes = -1
				}
				const e = clones.sampled.get(key) ?? { n: 0, bytes: 0, maxBytes: 0 }
				e.n++
				e.bytes += Math.max(0, bytes)
				e.maxBytes = Math.max(e.maxBytes, bytes)
				clones.sampled.set(key, e)
			}
			return original(value, options)
		}
	}
	const write = () => {
		h.disable()
		const elu = performance.eventLoopUtilization(elu0)
		const ms = v => v / 1e6
		const cpu = process.cpuUsage(cpu0)
		const windowMs = Date.now() - startedAt
		writeFileSync(
			out,
			JSON.stringify({
				windowMs,
				elu: elu.utilization,
				activeMs: elu.active,
				/** All threads of the core (main + workers), share of one core. */
				processCpu: (cpu.user + cpu.system) / 1000 / windowMs,
				delayMs: {
					p50: ms(h.percentile(50)),
					p90: ms(h.percentile(90)),
					p99: ms(h.percentile(99)),
					p999: ms(h.percentile(99.9)),
					max: ms(h.max),
					mean: ms(h.mean),
				},
				clones: {
					calls: clones.calls,
					sampleEvery: Number(process.env.PROFILE_CLONE_SAMPLE) || 32,
					byStack: [...clones.sampled.entries()]
						.sort((a, b) => b[1].n - a[1].n)
						.slice(0, 12)
						.map(([stack, e]) => ({
							stack,
							sampled: e.n,
							meanJsonBytes: Math.round(e.bytes / e.n),
							maxJsonBytes: e.maxBytes,
						})),
				},
			}),
		)
		state = "done"
	}
	process.on("SIGUSR2", () => {
		if (state === "idle") {
			h.reset()
			h.enable()
			elu0 = performance.eventLoopUtilization()
			cpu0 = process.cpuUsage()
			startedAt = Date.now()
			state = "open"
		} else if (state === "open") write()
	})
	process.on("exit", () => {
		if (state === "open") write()
	})
}

// Preload for a scratch core under profile-spectrum-main (node --import).
// The first SIGUSR2 starts a main-thread window (event-loop delay at a 1 ms
// timer, utilisation, process CPU); the second writes it as JSON to
// PROFILE_ELD_OUT. Without the second signal the window is written on exit.
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

/**
 * WG15 DQ 8.2: the guard measures only from worker ELU samples (never the whole-life average).
 * `meteredCheck` gives a service's engine cumulative ELU counters in which the interval since the
 * previous check ran at the engine's current `utilization()` (what the test just set), then runs
 * the guard at `now`.
 */
import type { SpectrumEngine } from "../../../../src/core/spectrum/spectrum-engine.js"

interface Meter {
	last: number
	idle: number
	active: number
}

interface ServiceLike {
	spectrum: {
		engine(sourceId: string): SpectrumEngine | undefined
		openedAt(sourceId: string): number | null
	}
}

export function meteredCheck(
	service: ServiceLike,
	sourceId = "rtl",
): (now: number) => Promise<void> {
	const meters = new WeakMap<SpectrumEngine, Meter>()
	const internals = service as unknown as {
		checkPassiveCost(now: number): Promise<void>
	}
	return async (now: number) => {
		const engine = service.spectrum.engine(sourceId)
		if (engine !== undefined) {
			let m = meters.get(engine)
			if (m === undefined) {
				m = {
					last: service.spectrum.openedAt(sourceId) ?? now,
					idle: 0,
					active: 0,
				}
				meters.set(engine, m)
				const meter = m
				engine.eluSample = () => ({
					generation: 1,
					elu: { idle: meter.idle, active: meter.active, utilization: 0 },
				})
			}
			const rate = engine.utilization() ?? 0
			const dt = Math.max(0, now - m.last)
			m.active += rate * dt
			m.idle += (1 - rate) * dt
			m.last = now
		}
		await internals.checkPassiveCost(now)
	}
}

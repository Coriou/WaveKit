import { z } from "zod"
import type { BandPlanService } from "../../core/bandplans/contract.js"
import type { Bandplan } from "../../core/scanner/bandplan/index.js"
import type {
	BandplanChannelLookup,
	BandplanRangeLookup,
	PlannerVfo,
	VfoChangeOrigin,
} from "./contract.js"
import { VFO_SETTLE_MS } from "./contract.js"

type ResolvedBandPlanView = ReturnType<BandPlanService["resolved"]>

const frequency = z.number().finite().positive()
const vfoSchema = z.object({
	sourceId: z.string().min(1),
	frequencyHz: frequency,
})

function safeVfo(value: unknown): PlannerVfo | null {
	try {
		const parsed = vfoSchema.safeParse(value)
		return parsed.success ? parsed.data : null
	} catch {
		return null
	}
}

export function vfoFromLiveDemod(port: {
	sourceId(): string | null
	offsetHz(): number
	centreHz(sourceId: string): number | null
}): PlannerVfo | null {
	try {
		const sourceId = port.sourceId()
		if (typeof sourceId !== "string" || !sourceId) return null
		const centre = port.centreHz(sourceId)
		const offset = port.offsetHz()
		if (!frequency.safeParse(centre).success || !Number.isFinite(offset))
			return null
		return safeVfo({ sourceId, frequencyHz: centre! + offset })
	} catch {
		return null
	}
}

export function createVfoTracker(deps: {
	now: () => number
	setTimer: (fn: () => void, ms: number) => { cancel(): void }
	/** With the origin of the latest change that moved the VFO there. */
	onSettled: (vfo: PlannerVfo | null, origin: VfoChangeOrigin) => void
}): {
	/** `origin` defaults to "other": an unknown origin is never the user's. */
	update(vfo: PlannerVfo | null, origin?: VfoChangeOrigin): void
	current(): PlannerVfo | null
	dispose(): void
} {
	let settled: PlannerVfo | null = null
	let pending: PlannerVfo | null = null
	let timer: { cancel(): void } | undefined
	let generation = 0
	let disposed = false
	const equal = (a: PlannerVfo | null, b: PlannerVfo | null) =>
		a?.sourceId === b?.sourceId && a?.frequencyHz === b?.frequencyHz
	return {
		update(value, origin = "other") {
			if (disposed) return
			const next = safeVfo(value)
			if (equal(next, pending)) return
			pending = next
			// The latest change decides: one that only repeats the pending
			// value above keeps the origin of the change that set it.
			const changeOrigin: VfoChangeOrigin = origin === "user" ? "user" : "other"
			timer?.cancel()
			const token = ++generation
			if (equal(next, settled)) return
			const started = deps.now()
			const settle = () => {
				if (disposed || token !== generation) return
				const elapsed = deps.now() - started
				if (!Number.isFinite(elapsed) || elapsed < 0) return
				if (elapsed < VFO_SETTLE_MS) {
					timer = deps.setTimer(settle, VFO_SETTLE_MS - elapsed)
					return
				}
				settled = next
				timer = undefined
				deps.onSettled(settled === null ? null : { ...settled }, changeOrigin)
			}
			timer = deps.setTimer(settle, VFO_SETTLE_MS)
		},
		current: () => (settled === null ? null : { ...settled }),
		dispose() {
			disposed = true
			generation++
			timer?.cancel()
		},
	}
}

const windowSchema = z
	.object({
		sourceId: z.string().min(1),
		minHz: z.number().finite(),
		maxHz: frequency,
	})
	.refine(value => value.minHz <= value.maxHz)
const bandsSchema = z.array(
	z
		.object({
			startHz: frequency,
			endHz: frequency,
			channels: z.array(z.object({ frequencyHz: frequency })),
		})
		// Edits may leave channels outside the band edges; the visible-segment
		// filter drops those, so they must not invalidate the whole view.
		.refine(band => band.startHz < band.endHz),
)
const resolvedSchema = z.object({
	bands: z.array(
		z
			.object({
				band: bandsSchema.element,
				segments: z
					.array(
						z
							.object({
								startHz: frequency,
								endHz: frequency,
							})
							.refine(segment => segment.startHz <= segment.endHz),
					)
					.min(1),
			})
			.refine(({ band, segments }) =>
				segments.every(
					(segment, index) =>
						segment.startHz >= band.startHz &&
						segment.endHz <= band.endHz &&
						(index === 0 || segment.startHz > segments[index - 1]!.endHz),
				),
			),
	),
})
const plansSchema = z.array(
	z.object({
		ranges: z.array(
			z
				.object({
					startHz: frequency,
					endHz: frequency,
					protocols: z.array(z.string()).optional(),
					enabled: z.boolean().optional(),
				})
				.refine(range => range.startHz <= range.endHz),
		),
	}),
)

/** Reads effective channels within the resolved bands' inclusive visible segments.
 * The resolver omits disabled, hidden and fully shadowed bands.
 * Missing/throwing views yield no channels even if scannerPlans has a fallback.
 */
export function createBandplanChannelLookup(deps: {
	getResolved: () => ResolvedBandPlanView | undefined
	scannerPlans: () => readonly Bandplan[]
}): BandplanChannelLookup {
	return (window, protocols) => {
		try {
			const bounds = windowSchema.safeParse(window)
			const wanted = z.array(z.string().min(1)).safeParse(protocols)
			const view = deps.getResolved()
			if (!bounds.success || !wanted.success || !view) return []
			const resolved = resolvedSchema.safeParse(view)
			const plans = plansSchema.safeParse(deps.scannerPlans())
			if (!resolved.success || !plans.success) return []
			const ranges = plans.data
				.flatMap(plan => plan.ranges)
				.filter(
					range =>
						range.enabled !== false &&
						range.protocols?.some(p => wanted.data.includes(p)),
				)
			return [
				...new Set(
					resolved.data.bands.flatMap(({ band, segments }) =>
						band.channels
							.filter(channel =>
								segments.some(
									segment =>
										channel.frequencyHz >= segment.startHz &&
										channel.frequencyHz <= segment.endHz,
								),
							)
							.map(channel => channel.frequencyHz),
					),
				),
			]
				.filter(
					hz =>
						hz >= bounds.data.minHz &&
						hz <= bounds.data.maxHz &&
						ranges.some(range => hz >= range.startHz && hz <= range.endHz),
				)
				.sort((a, b) => a - b)
		} catch {
			return []
		}
	}
}

/** Reads scanner-range eligibility independently of listed channels. */
export function createBandplanRangeLookup(deps: {
	scannerPlans: () => readonly Bandplan[]
}): BandplanRangeLookup {
	return (_sourceId, hz, protocols) => {
		try {
			const wanted = z.array(z.string().min(1)).safeParse(protocols)
			if (!frequency.safeParse(hz).success || !wanted.success) return false
			const plans = plansSchema.safeParse(deps.scannerPlans())
			if (!plans.success) return false
			return plans.data.some(plan =>
				plan.ranges.some(
					range =>
						range.enabled !== false &&
						hz >= range.startHz &&
						hz <= range.endHz &&
						range.protocols?.some(protocol => wanted.data.includes(protocol)),
				),
			)
		} catch {
			return false
		}
	}
}

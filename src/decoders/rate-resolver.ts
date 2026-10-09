import { z } from "zod"
import { ConfigValidationError } from "../utils/errors.js"
import type {
	DecoderInputType,
	DecoderRateAssessment,
	DecoderRateRequirements,
	DecoderRateSet,
} from "@wavekit/api-types"

const rate = z.number().finite().positive()
const inputKind = z.enum(["iq", "audio_pcm", "external"])
const rateSet = z.discriminatedUnion("kind", [
	z.object({ kind: z.literal("discrete"), valuesHz: z.array(rate).nonempty() }),
	z.object({
		kind: z.literal("range"),
		minHz: rate,
		maxHz: rate.optional(),
		stepHz: rate.optional(),
	}),
])
const acceptedRates = z.array(rateSet).nonempty()
const requirementsSchema = z.object({
	version: z.literal(1),
	sourceKind: inputKind,
	capture: z
		.object({
			accepted: acceptedRates,
			preferredHz: z.array(rate),
			minimum: z
				.object({
					hz: rate,
					basis: z.enum(["implementation", "verified-rf"]),
					evidence: z.string().trim().min(1),
				})
				.optional(),
		})
		.optional(),
	frontendIq: z
		.object({ preferredHz: rate, accepted: acceptedRates })
		.optional(),
	decoderInput: z.object({
		kind: inputKind,
		format: z.string().min(1).optional(),
		preferredHz: rate.optional(),
		accepted: acceptedRates.optional(),
	}),
})

/** What a decoder's stdin pipeline actually delivers for one source rate. */
export interface DecoderRateAdapter {
	/** Source-domain rate conversion, before any IQ-to-audio demodulation. */
	adaptation: "none" | "integer-decimation" | "resample"
	frontendRateHz?: number
	decoderInputKind: DecoderInputType
	decoderInputRateHz?: number
	decoderInputFormat?: string
}

/** Actual adapter output supplied by the caller, not a requested target rate. */
export interface DecoderRateContext {
	source?: { kind: DecoderInputType; rateHz?: number }
	adapter?: DecoderRateAdapter
}

const contextSchema = z.object({
	source: z.object({ kind: inputKind, rateHz: rate.optional() }).optional(),
	adapter: z
		.object({
			adaptation: z.enum(["none", "integer-decimation", "resample"]),
			frontendRateHz: rate.optional(),
			decoderInputKind: inputKind,
			decoderInputRateHz: rate.optional(),
			decoderInputFormat: z.string().min(1).optional(),
		})
		.optional(),
})

function accepts(sets: DecoderRateSet[], hz: number): boolean {
	return sets.some(set => {
		if (set.kind === "discrete") return set.valuesHz.includes(hz)
		if (hz < set.minHz || (set.maxHz !== undefined && hz > set.maxHz))
			return false
		if (set.stepHz === undefined) return true
		const steps = (hz - set.minHz) / set.stepHz
		return (
			Math.abs(steps - Math.round(steps)) <=
			Number.EPSILON * Math.max(1, Math.abs(steps)) * 4
		)
	})
}

/** Reject malformed declarations explicitly instead of inventing eligibility. */
export function validateDecoderRateRequirements(
	value: unknown,
): DecoderRateRequirements {
	const parsed = requirementsSchema.parse(value) as DecoderRateRequirements
	const domains = [
		parsed.capture,
		parsed.frontendIq && {
			...parsed.frontendIq,
			preferredHz: [parsed.frontendIq.preferredHz],
		},
		parsed.decoderInput.accepted && {
			accepted: parsed.decoderInput.accepted,
			preferredHz:
				parsed.decoderInput.preferredHz === undefined
					? []
					: [parsed.decoderInput.preferredHz],
		},
	]
	for (const domain of domains) {
		if (!domain) continue
		for (const set of domain.accepted) {
			if (
				set.kind === "range" &&
				set.maxHz !== undefined &&
				set.maxHz < set.minHz
			) {
				throw new Error("Rate range maximum must not be below its minimum")
			}
		}
		if (domain.preferredHz.some(hz => !accepts(domain.accepted, hz))) {
			throw new Error(
				"Preferred rates must belong to their domain's accepted rates",
			)
		}
	}
	if (
		parsed.capture?.minimum &&
		parsed.capture.preferredHz.some(hz => hz < parsed.capture!.minimum!.hz)
	) {
		throw new Error(
			"Preferred capture rate must not be below its declared minimum",
		)
	}
	if (parsed.frontendIq && parsed.sourceKind !== "iq") {
		throw new Error("An IQ frontend requires an IQ source")
	}
	if (parsed.sourceKind === "audio_pcm" && parsed.decoderInput.kind === "iq") {
		throw new Error("PCM audio cannot supply a captured IQ input")
	}
	if (
		(parsed.sourceKind === "external") !==
			(parsed.decoderInput.kind === "external") ||
		(parsed.sourceKind === "external" && parsed.capture)
	) {
		throw new Error(
			"External input must not declare a core capture or stdin adapter",
		)
	}
	return parsed
}

/**
 * Validates a declaration supplied by a registry entry or decoder instance and
 * reports any failure as a ConfigValidationError naming `label`.
 */
export function validateDeclaredRateRequirements(
	value: unknown,
	label: string,
): DecoderRateRequirements {
	try {
		return validateDecoderRateRequirements(value)
	} catch (err) {
		if (err instanceof z.ZodError) {
			throw new ConfigValidationError(
				new z.ZodError(
					err.issues.map(issue => ({ ...issue, path: [label, ...issue.path] })),
				),
			)
		}
		throw new ConfigValidationError(
			new z.ZodError([
				{
					code: "custom",
					path: [label],
					message: err instanceof Error ? err.message : String(err),
				},
			]),
		)
	}
}

/** Pure reporting: unknown custom requirements never become a hard failure. */
export function assessDecoderRate(
	requirements: DecoderRateRequirements | undefined,
	context: DecoderRateContext = {},
): DecoderRateAssessment {
	contextSchema.parse(context)
	const { source, adapter } = context
	const observed = {
		...(source ? { sourceKind: source.kind } : {}),
		...(source?.rateHz !== undefined ? { sourceRateHz: source.rateHz } : {}),
		...(adapter
			? {
					adaptation: adapter.adaptation,
					decoderInputKind: adapter.decoderInputKind,
				}
			: {}),
		...(adapter?.frontendRateHz !== undefined
			? { frontendRateHz: adapter.frontendRateHz }
			: {}),
		...(adapter?.decoderInputRateHz !== undefined
			? { decoderInputRateHz: adapter.decoderInputRateHz }
			: {}),
	}
	const result = (
		verdict: DecoderRateAssessment["verdict"],
		reasonCode?: DecoderRateAssessment["reasonCode"],
	): DecoderRateAssessment => ({
		...observed,
		verdict,
		...(reasonCode ? { reasonCode } : {}),
	})
	if (!requirements) return result("unknown", "unknown-requirements")
	const req = validateDecoderRateRequirements(requirements)
	if (req.sourceKind === "external") return result("unknown", "external-input")
	if (source && adapter?.adaptation === "none" && source.rateHz !== undefined) {
		if (
			(adapter.frontendRateHz !== undefined &&
				adapter.frontendRateHz !== source.rateHz) ||
			(adapter.decoderInputKind === source.kind &&
				adapter.decoderInputRateHz !== undefined &&
				adapter.decoderInputRateHz !== source.rateHz)
		) {
			throw new Error(
				"Adaptation 'none' cannot change the rate within a sample domain",
			)
		}
	}
	if (source && source.kind !== req.sourceKind)
		return result("unusable", "unsupported-input-kind")
	if (source?.rateHz === undefined)
		return result("unknown", "source-rate-unknown")
	if (!req.capture && req.sourceKind === "iq")
		return result("unknown", "unknown-requirements")
	if (req.capture?.minimum && source.rateHz < req.capture.minimum.hz) {
		return {
			...result("unusable", "insufficient-sample-rate"),
			requiredMinimumHz: req.capture.minimum.hz,
			requirementBasis: req.capture.minimum.basis,
		}
	}
	if (req.capture && !accepts(req.capture.accepted, source.rateHz))
		return result("unusable", "unsupported-sample-rate")
	if (!adapter) return result("unknown", "adaptation-unknown")
	if (adapter.decoderInputKind !== req.decoderInput.kind)
		return result("unusable", "unsupported-input-kind")
	if (req.decoderInput.format && !adapter.decoderInputFormat)
		return result("unknown", "adaptation-unknown")
	if (
		req.decoderInput.format &&
		adapter.decoderInputFormat !== req.decoderInput.format
	) {
		return result("unusable", "unsupported-input-format")
	}
	if (req.frontendIq) {
		if (adapter.frontendRateHz === undefined)
			return result("unknown", "adaptation-unknown")
		if (!accepts(req.frontendIq.accepted, adapter.frontendRateHz))
			return result("unusable", "unsupported-frontend-rate")
	}
	if (!req.decoderInput.accepted)
		return result("unknown", "unknown-requirements")
	if (adapter.decoderInputRateHz === undefined)
		return result("unknown", "adaptation-unknown")
	if (!accepts(req.decoderInput.accepted, adapter.decoderInputRateHz))
		return result("unusable", "unsupported-decoder-input-rate")
	const preferred =
		(req.capture
			? req.capture.preferredHz.includes(source.rateHz)
			: req.decoderInput.preferredHz !== undefined) &&
		(!req.frontendIq ||
			adapter.frontendRateHz === req.frontendIq.preferredHz) &&
		(req.decoderInput.preferredHz === undefined ||
			adapter.decoderInputRateHz === req.decoderInput.preferredHz)
	return result(preferred ? "best" : "acceptable")
}

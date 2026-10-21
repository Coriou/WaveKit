import type {
	LinkAdvisory,
	TunerRatePolicy,
	TunerRatePolicyEventData,
} from "@wavekit/api-types"
import { createComponentLogger, type Logger } from "../utils/logger.js"
import { safeErrorFields } from "../decoders/safe-error-fields.js"
import type { TunerWriteOptions } from "./tuner-controller.js"
import {
	ADSB_FREQUENCY_HZ,
	READSB_REACH_HZ,
	READSB_SAMPLE_RATE,
	type RatePolicy,
	type RatePolicyPort,
	type LinkAdvisor,
	type LinkAdvisoryInput,
} from "./rate-policy-contract.js"

export interface RatePolicyDeps {
	port: RatePolicyPort
	tuner: {
		sampleRateOf(sourceId: string): number | null
		controlModeOf(sourceId: string): "internal" | "external" | null
		setSampleRate(
			sourceId: string,
			hz: number,
			opts: TunerWriteOptions,
		): Promise<void>
	}
	link: LinkAdvisor | null
	linkInput(sourceId: string): LinkAdvisoryInput | null
	upstreamDropsOf(sourceId: string): number | null
	reportLink(sourceId: string, advisory: LinkAdvisory): void
	setTimer(fn: () => void, ms: number): { cancel(): void }
	emit(event: TunerRatePolicyEventData): void
	now: () => Date
	log: Logger
	enabled: boolean
}

export function createRatePolicy(deps: RatePolicyDeps): RatePolicy {
	const records = new Map<string, TunerRatePolicy>()
	const advised = new Set<string>()
	const generations = new Map<string, number>()
	const invalidate = (sourceId: string) => {
		generations.set(sourceId, (generations.get(sourceId) ?? 0) + 1)
	}
	const log = createComponentLogger(deps.log, "RatePolicy")
	const inReach = (hz: number) =>
		Math.abs(hz - ADSB_FREQUENCY_HZ) <= READSB_REACH_HZ
	const advisory = (
		sourceId: string,
		rate: number,
	): LinkAdvisory | undefined => {
		try {
			const input = deps.linkInput(sourceId)
			return deps.link && input
				? deps.link.classify(
						{ ...input, sampleRateHz: rate },
						deps.upstreamDropsOf(sourceId),
					)
				: undefined
		} catch (err) {
			log.warn(
				{ sourceId, err: safeErrorFields(err) },
				"Link advisory unavailable",
			)
			return undefined
		}
	}
	const emit = (event: TunerRatePolicyEventData) => {
		log.info(
			{
				decoderId: "readsb",
				sourceId: event.sourceId,
				action: event.action,
				fromHz: event.fromHz,
				toHz: event.toHz,
				reason: event.skipped ?? event.reason,
			},
			"Decoder rate policy",
		)
		deps.emit(event)
	}
	return {
		async beforeOperatorRetune(sourceId, hz) {
			if (deps.tuner.controlModeOf(sourceId) !== "internal") return
			advised.delete(sourceId)
			if (!deps.enabled) return
			const facts = deps.port.readsbOn(sourceId)
			const record = records.get(sourceId)
			const rate = deps.tuner.sampleRateOf(sourceId)
			if (rate === null || !Number.isFinite(rate)) return
			const restore =
				record !== undefined && (!inReach(hz) || facts?.mode === "off")
			if (
				!restore &&
				(!inReach(hz) ||
					!facts ||
					facts.mode === "off" ||
					facts.ownDevice ||
					record)
			)
				return
			const target = restore ? record.raisedFromHz : READSB_SAMPLE_RATE
			if (!restore && rate === target) return
			if (!restore && rate > target) {
				const link = advisory(sourceId, rate)
				emit({
					...(link ? { link } : {}),
					sourceId,
					action: "skipped",
					reason: "adsb-1090",
					fromHz: rate,
					toHz: target,
					skipped: "rate-above",
				})
				return
			}
			const generation = generations.get(sourceId) ?? 0
			generations.set(sourceId, generation)
			try {
				await deps.tuner.setSampleRate(sourceId, target, {
					origin: "decoder-rate",
				})
			} catch (err) {
				const link = advisory(sourceId, target)
				emit({
					...(link ? { link } : {}),
					sourceId,
					action: "skipped",
					reason: "adsb-1090",
					fromHz: rate,
					toHz: target,
					skipped: "write-failed",
				})
				throw err
			}
			if (generations.get(sourceId) !== generation) return
			if (restore) records.delete(sourceId)
			else
				records.set(sourceId, {
					raisedFromHz: rate,
					since: deps.now().toISOString(),
				})
			const link = advisory(sourceId, target)
			emit({
				sourceId,
				action: restore ? "restored" : "raised",
				reason: "adsb-1090",
				fromHz: rate,
				toHz: target,
				...(link ? { link } : {}),
			})
			if (!restore && link) {
				try {
					deps.reportLink(sourceId, link)
				} catch (err) {
					log.warn(
						{ sourceId, err: safeErrorFields(err) },
						"Link advisory report failed",
					)
				}
			}
		},
		onOperatorSampleRate(sourceId) {
			invalidate(sourceId)
			records.delete(sourceId)
		},
		onRelayRetune(sourceId, hz) {
			if (!inReach(hz) || deps.tuner.controlModeOf(sourceId) === "internal") {
				advised.delete(sourceId)
				return
			}
			if (
				!deps.enabled ||
				deps.tuner.controlModeOf(sourceId) !== "external" ||
				advised.has(sourceId)
			)
				return
			const facts = deps.port.readsbOn(sourceId)
			const rate = deps.tuner.sampleRateOf(sourceId)
			if (
				!facts ||
				facts.mode === "off" ||
				facts.ownDevice ||
				rate === null ||
				!Number.isFinite(rate) ||
				rate === READSB_SAMPLE_RATE
			)
				return
			advised.add(sourceId)
			const link = advisory(sourceId, READSB_SAMPLE_RATE)
			emit({
				sourceId,
				action: "skipped",
				reason: "adsb-1090",
				fromHz: rate,
				toHz: READSB_SAMPLE_RATE,
				skipped: rate > READSB_SAMPLE_RATE ? "rate-above" : "external-control",
				...(link ? { link } : {}),
			})
		},
		recordFor(sourceId) {
			const record = records.get(sourceId)
			return record ? { ...record } : undefined
		},
		reset(sourceId) {
			invalidate(sourceId)
			records.delete(sourceId)
			advised.delete(sourceId)
		},
		dispose() {
			for (const sourceId of generations.keys()) invalidate(sourceId)
			records.clear()
			advised.clear()
		},
	}
}

import { it, expect } from "vitest"
import type { LinkAdvisory } from "@wavekit/api-types"
import { createRatePolicy } from "../../../src/core/rate-policy.js"
import type { LinkAdvisor } from "../../../src/core/rate-policy-contract.js"
import { createLogger } from "../../../src/utils/logger.js"

const base = {
	transport: "network" as const,
	payloadBytesPerSecond: 4_800_000,
	sustainedBytesPerSecond: null,
	shortfallPercent: 2,
	upstreamDropBytesPerSecond: null,
}

it("re-check reports once per level and lossReason change", async () => {
	let rate = 1_024_000
	let next: LinkAdvisory = { ...base, level: "unproven" }
	const timers: Array<() => void> = []
	const reports: LinkAdvisory[] = []
	const link: LinkAdvisor = {
		observe: () => undefined,
		classify: () => next,
		reset: () => undefined,
	}
	const policy = createRatePolicy({
		port: { readsbOn: () => ({ mode: "auto", ownDevice: false }) },
		tuner: {
			sampleRateOf: () => rate,
			controlModeOf: () => "internal",
			setSampleRate: (_id, hz) => {
				rate = hz
				return Promise.resolve()
			},
		},
		link,
		linkInput: sourceId => ({
			sourceId,
			host: "private.invalid",
			sampleRateHz: rate,
		}),
		upstreamDropsOf: () => 0,
		reportLink: (_id, advisory) => reports.push(advisory),
		setTimer(fn) {
			timers.push(fn)
			return { cancel: () => undefined }
		},
		emit: () => undefined,
		now: () => new Date(0),
		log: createLogger({ level: "fatal" }),
		enabled: true,
	})
	await policy.beforeOperatorRetune("s", 1_090_000_000, { origin: "rest" })
	const tick = (advisory: LinkAdvisory) => {
		next = advisory
		timers.shift()?.()
	}
	const count = reports.length
	tick({ ...base, level: "dropping", lossReason: "source" })
	tick({ ...base, level: "dropping", lossReason: "source" })
	tick({ ...base, level: "dropping", lossReason: "core-busy" })
	tick({ ...base, level: "dropping", lossReason: "core-busy" })
	expect(reports.slice(count).map(r => [r.level, r.lossReason])).toEqual([
		["dropping", "source"],
		["dropping", "core-busy"],
	])
	policy.dispose()
})

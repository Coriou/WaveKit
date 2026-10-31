import { it, expect } from "vitest"
import type { ResourceAlert } from "@wavekit/api-types"
import { ResourceAggregator } from "../../../src/core/resource-aggregator.js"
import { createLinkAdvisor } from "../../../src/core/link-advisory.js"
import { createLogger } from "../../../src/utils/logger.js"

it("aggregator emits warning for unproven, critical for dropping, nothing for none", () => {
	const aggregator = new ResourceAggregator(createLogger({ level: "fatal" }), {
		autoBroadcast: false,
	})
	const alerts: ResourceAlert[] = []
	aggregator.on("alert", (alert: ResourceAlert) => alerts.push(alert))
	const advisor = createLinkAdvisor({ now: () => 0 })
	const input = {
		sourceId: "s",
		host: "secret.invalid",
		sampleRateHz: 2_400_000,
	}
	aggregator.reportLinkAdvisory("s", advisor.classify(input, null))
	aggregator.reportLinkAdvisory("s", advisor.classify(input, 10001))
	aggregator.reportLinkAdvisory(
		"s",
		advisor.classify({ ...input, host: "localhost" }, null),
	)
	expect(alerts.map(alert => [alert.type, alert.severity])).toEqual([
		["link-capacity", "warning"],
		["link-capacity", "critical"],
	])
})
it("alert carries the advisory's lossReason, and has no key when the advisory has none", () => {
	const aggregator = new ResourceAggregator(createLogger({ level: "fatal" }), {
		autoBroadcast: false,
	})
	const alerts: ResourceAlert[] = []
	aggregator.on("alert", (alert: ResourceAlert) => alerts.push(alert))
	const base = {
		transport: "network" as const,
		payloadBytesPerSecond: 4_800_000,
		sustainedBytesPerSecond: null,
		shortfallPercent: null,
		upstreamDropBytesPerSecond: null,
	}
	aggregator.reportLinkAdvisory("s", {
		...base,
		level: "dropping",
		lossReason: "source",
	})
	aggregator.reportLinkAdvisory("s", {
		...base,
		level: "unproven",
		lossReason: "branch-congestion",
	})
	aggregator.reportLinkAdvisory("s", { ...base, level: "unproven" })
	aggregator.reportLinkAdvisory("s", {
		...base,
		level: "none",
		lossReason: "branch-congestion",
	})
	expect(alerts.map(a => [a.severity, a.lossReason])).toEqual([
		["critical", "source"],
		["warning", "branch-congestion"],
		["warning", undefined],
	])
	expect("lossReason" in (alerts[2] ?? {})).toBe(false)
})
it("advisory and alert contain no host string", () => {
	const host = "secret.invalid"
	const advisory = createLinkAdvisor({ now: () => 0 }).classify(
		{ sourceId: "s", host, sampleRateHz: 2_400_000 },
		null,
	)
	const aggregator = new ResourceAggregator(createLogger({ level: "fatal" }), {
		autoBroadcast: false,
	})
	aggregator.on("alert", (alert: ResourceAlert) =>
		expect(JSON.stringify(alert)).not.toContain(host),
	)
	aggregator.reportLinkAdvisory("s", advisory)
	expect(JSON.stringify(advisory)).not.toContain(host)
})
it("without reports snapshots retain their existing shape", () => {
	const aggregator = new ResourceAggregator(createLogger({ level: "fatal" }), {
		autoBroadcast: false,
	})
	expect(Object.keys(aggregator.getSnapshot())).toEqual([
		"timestamp",
		"container",
		"sdrHosts",
		"sourceBackpressure",
	])
})

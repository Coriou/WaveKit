/**
 * Manual micro-measurement, with no timing assertions or external connections.
 * Bundle with esbuild --bundle --platform=node --format=esm to a scratch .mjs,
 * then run with Node. Compare identical bundles against the before/after ranker.
 * Retains 512 segments; measures one live track and all 512 live tracks separately.
 */
import { loadavg } from "node:os"
import {
	createChannelActivityRanker,
	type ActivityBlock,
} from "../../../src/core/scanner/channel-activity.js"

const ranker = createChannelActivityRanker({ monoNow: () => 1_000 })
const tracks = Array.from({ length: 512 }, (_, i) => ({
	trackId: `t${i}`,
	startHz: 1_000_000 + i * 6_250 - 100,
	endHz: 1_000_000 + i * 6_250 + 100,
	flags: { iqImage: false },
	gate: "passed" as const,
}))
const block: ActivityBlock = {
	epoch: 1,
	centreHz: 1_000_000,
	sampleRateHz: 4_000_000,
	overload: false,
	tracks,
}
ranker.ingestBlock("fake", "engine", block)
for (const count of [1, 512]) {
	block.tracks = tracks.slice(0, count)
	for (let i = 0; i < 10_000; i++) ranker.ingestBlock("fake", "engine", block)
	const samples: number[] = []
	for (let run = 0; run < 7; run++) {
		const start = process.hrtime.bigint()
		for (let i = 0; i < 10_000; i++) ranker.ingestBlock("fake", "engine", block)
		samples.push(Number(process.hrtime.bigint() - start) / 10_000)
	}
	samples.sort((a, b) => a - b)
	process.stdout.write(
		`${JSON.stringify({
			tracks: count,
			retained: 512,
			medianNsPerBlock: Math.round(samples[3]!),
			loadavg: loadavg(),
			samples,
		})}\n`,
	)
}
ranker.dispose()

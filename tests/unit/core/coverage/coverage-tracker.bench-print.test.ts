import { describe, expect, it } from "vitest"
import { CoverageTracker } from "../../../../src/core/coverage/coverage-tracker.js"

// Reported, not asserted: WAVEKIT_BENCH=1 pnpm exec vitest run tests/unit/core/coverage/coverage-tracker.bench-print.test.ts
describe.skipIf(process.env["WAVEKIT_BENCH"] === undefined)(
	"CoverageTracker observe benchmark",
	() => {
		it("measures mean ns per observe over 1e6 mixed calls", () => {
			const n = 1_000_000
			const lats = new Float64Array(n)
			const lons = new Float64Array(n)
			let seed = 12345
			const rnd = (): number => {
				seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648
				return seed / 2_147_483_648
			}
			for (let i = 0; i < n; i++) {
				lats[i] = 51.5 + (rnd() - 0.5) * 10
				lons[i] = -0.12 + (rnd() - 0.5) * 14
				if (i % 50 === 0) lats[i] = 0
			}
			const t = new CoverageTracker({ lat: 51.5, lon: -0.12 })
			const t0 = Date.UTC(2026, 9, 16)
			for (let i = 0; i < 100_000; i++)
				t.observe("adsb", lats[i]!, lons[i]!, t0, t0)
			let accepted = 0
			const start = process.hrtime.bigint()
			for (let i = 0; i < n; i++) {
				const now = t0 + i * 200
				if (
					t.observe(
						i & 1 ? "ais" : "adsb",
						lats[i]!,
						lons[i]!,
						now - 1_000,
						now,
					)
				)
					accepted++
			}
			const ns = Number(process.hrtime.bigint() - start) / n
			process.stdout.write(
				`coverage observe: ${ns.toFixed(1)} ns/call mean, ${accepted}/${n} accepted\n`,
			)
			expect(accepted).toBeGreaterThan(0)
		})
	},
)

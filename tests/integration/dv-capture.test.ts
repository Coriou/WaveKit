/**
 * Digital voice capture, decoder tier (dv-capture.ts): whole transmissions of
 * a transmission plan through wavekit-chan, sox and dsd-fme at real time, and
 * the adapter's calls scored per over (key-up to first checked frame, head
 * cut, end error, frames checked, calls per over, splits, merges). A
 * measurement, not a regression test: it runs only with WAVEKIT_DVCAP=1 and
 * WAVEKIT_SYNTH_IMAGE=<core image>, writes a markdown table to
 * WAVEKIT_DVCAP_OUT (default: a file in the OS tmp dir) and prints it.
 *
 *   WAVEKIT_DVCAP=1 WAVEKIT_SYNTH_IMAGE=<core image> \
 *     pnpm exec vitest run --maxWorkers=1 tests/integration/dv-capture.test.ts
 *
 * WAVEKIT_DVCAP_QUICK=1: the DMR direct and repeater scenes at 20 dB, 0 Hz,
 * phase 0: 11 points, 226.6 s of scenes fed at real time plus 11 x 10.1 s of
 * lead and overhead, about 340 s (gridSeconds; budget 600 s). The full grid
 * is every scene (dv-plan.mjs DV_SCENES) at CNR 10, 15, 20, 30 dB, error 0
 * and +-600 Hz and 4 clock phases: 21 scenes x 48 points, about 9.8 h. Narrower runs:
 * WAVEKIT_DVCAP_SCENES, _CNR, _ERROR_HZ, _PHASES (comma-separated).
 * WAVEKIT_DVCAP_VARIANT=settle-replay runs experiment 4b instead of the
 * baseline. WAVEKIT_DVCAP_LINES=<dir> also writes each point's lines and
 * overs in the truth scorecard's seed format (dv-latency-*.json). The host
 * builds wavekit-chan from native/ unless WAVEKIT_CHAN_BIN is set.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
	dvTable,
	type DvPoint,
} from "../../scripts/bench/scanner-quality/dv-metrics.js"
import { MARGIN_CAPTURE, MARGIN_CENTRE_HZ } from "./dsd-fme-margin.js"
import {
	DVCAP_VARIANTS,
	dvGrid,
	gridSeconds,
	measureDvPoint,
	recordedSceneName,
	recordedSeed,
	type DvChannelize,
	type DvVariant,
} from "./dv-capture.js"
import { SYNTH_IMAGE, channelize } from "./synthetic-chain.js"
import {
	buildWavekitChan,
	wavekitChanBuildUnavailable,
} from "./wavekit-chan-build.js"

const ENABLED = process.env["WAVEKIT_DVCAP"] === "1" && SYNTH_IMAGE !== ""
const list = (name: string) =>
	process.env[name]
		?.split(",")
		.map(s => s.trim())
		.filter(s => s !== "")
const numbers = (name: string) => list(name)?.map(Number)
const VARIANT = (process.env["WAVEKIT_DVCAP_VARIANT"] ??
	"baseline") as DvVariant

const CRATE = resolve(__dirname, "../../native/wavekit-chan")
let CHAN = process.env["WAVEKIT_CHAN_BIN"] ?? ""
let TARGET = ""
const chanUnavailable =
	ENABLED && CHAN === "" ? wavekitChanBuildUnavailable(CRATE) : undefined

describe.skipIf(!ENABLED || chanUnavailable !== undefined)(
	"digital voice capture, decoder tier",
	() => {
		beforeAll(async () => {
			if (CHAN === "") {
				TARGET = mkdtempSync(join(tmpdir(), "wavekit-chan-target-"))
				CHAN = await buildWavekitChan(CRATE, TARGET)
			}
		}, 600_000)
		afterAll(() => {
			if (TARGET) rmSync(TARGET, { recursive: true, force: true })
		})

		it("measures every over of every scene of the grid", async () => {
			expect(DVCAP_VARIANTS).toContain(VARIANT)
			const scenes = list("WAVEKIT_DVCAP_SCENES")
			const cnrDb = numbers("WAVEKIT_DVCAP_CNR")
			const errorsHz = numbers("WAVEKIT_DVCAP_ERROR_HZ")
			const phases = numbers("WAVEKIT_DVCAP_PHASES")
			const grid = dvGrid({
				quick: process.env["WAVEKIT_DVCAP_QUICK"] === "1",
				variant: VARIANT,
				...(scenes === undefined ? {} : { scenes }),
				...(cnrDb === undefined ? {} : { cnrDb }),
				...(errorsHz === undefined ? {} : { errorsHz }),
				...(phases === undefined ? {} : { phases }),
			})
			process.stdout.write(
				`\n${grid.length} points, about ${Math.round(gridSeconds(grid))} s\n`,
			)
			const chan: DvChannelize = async (iq, request) => {
				const delays: number[] = []
				const [cf32] = await channelize(
					CHAN,
					iq,
					{ rateHz: MARGIN_CAPTURE.rateHz, centerHz: MARGIN_CENTRE_HZ },
					[request],
					delays,
				)
				return { cf32: cf32!, groupDelaySamples: delays[0] ?? 0 }
			}
			const linesDir = process.env["WAVEKIT_DVCAP_LINES"]
			if (linesDir !== undefined) mkdirSync(linesDir, { recursive: true })
			const points: DvPoint[] = []
			for (const spec of grid) {
				const r = await measureDvPoint(spec, { channelize: chan })
				points.push({
					scene: spec.scene.name,
					variant: spec.variant,
					cnrDb: spec.cnrDb,
					errorHz: spec.errorHz,
					phase: spec.phase,
					rows: r.rows,
				})
				if (linesDir !== undefined)
					writeFileSync(
						join(linesDir, `dv-latency-${recordedSceneName(spec)}.json`),
						`${JSON.stringify(recordedSeed(r, MARGIN_CENTRE_HZ + MARGIN_CAPTURE.offsetHz), null, "\t")}\n`,
					)
			}
			const table = dvTable(points)
			const out =
				process.env["WAVEKIT_DVCAP_OUT"] ??
				join(tmpdir(), `dv-capture-${Date.now()}.md`)
			writeFileSync(
				out,
				`${table}\n\n<!--\n${JSON.stringify(points, null, 1)}\n-->\n`,
			)
			process.stdout.write(`\n${table}\n\nwritten to ${out}\n`)
			expect(points.length).toBeGreaterThan(0)
		}, 36_000_000)
	},
)

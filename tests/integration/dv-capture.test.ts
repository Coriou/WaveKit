/**
 * Digital voice capture, decoder tier (dv-capture.ts): whole transmissions of
 * a transmission plan through wavekit-chan, sox and dsd-fme at real time, and
 * the adapter's calls scored per over (key-up to first checked frame, head
 * cut, end error, frames checked, calls per over, splits, merges). A
 * measurement, not a regression test: it runs only with WAVEKIT_DVCAP=1 and
 * WAVEKIT_SYNTH_IMAGE=<core image>, rewrites a markdown table and the points
 * as JSON to WAVEKIT_DVCAP_OUT (default: a file in the OS tmp dir) after
 * every point, and prints it at the end. A point that fails is a row with
 * its error; the test fails at the end if any did.
 *
 *   WAVEKIT_DVCAP=1 WAVEKIT_SYNTH_IMAGE=<core image> \
 *     pnpm exec vitest run --maxWorkers=1 tests/integration/dv-capture.test.ts
 *
 * WAVEKIT_DVCAP_QUICK=1: the DMR direct and repeater scenes at 20 dB, 0 Hz,
 * phase 0: 12 points, 236.1 s of scenes plus 12 x 0.1 s of lead (237.3 s of
 * IQ) fed at real time, plus 12 x 5 s fixed and 0.35 s per IQ second of
 * overhead: 237.3 x 1.35 + 60 = about 380 s (gridSeconds; budget 600 s). The
 * full grid is every scene (dv-plan.mjs DV_SCENES) at CNR 10, 12, 15, 20 and
 * 30 dB, error 0 and +-600 Hz and 4 clock phases: 22 scenes x 60 points,
 * about 13.7 h. The test's timeout is twice the estimate plus 600 s
 * (gridTimeoutMs). Narrower runs: WAVEKIT_DVCAP_SCENES, _CNR, _ERROR_HZ,
 * _PHASES (comma-separated).
 * WAVEKIT_DVCAP_VARIANT=settle-replay runs experiment 4b instead of the
 * baseline. WAVEKIT_DVCAP_LINES=<dir> also writes each point's lines and
 * overs in the truth scorecard's seed format (dv-latency-*.json), each
 * checked against the scorecard's schema before it is written. The host
 * builds wavekit-chan from native/ unless WAVEKIT_CHAN_BIN is set.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { MARGIN_CAPTURE, MARGIN_CENTRE_HZ } from "./dsd-fme-margin.js"
import {
	DVCAP_VARIANTS,
	POINT_FIXED_S,
	POINT_PER_SCENE_S,
	dvGrid,
	gridSeconds,
	gridTimeoutMs,
	measureDvPoint,
	runDvGrid,
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
const scenes = list("WAVEKIT_DVCAP_SCENES")
const cnrDb = numbers("WAVEKIT_DVCAP_CNR")
const errorsHz = numbers("WAVEKIT_DVCAP_ERROR_HZ")
const phases = numbers("WAVEKIT_DVCAP_PHASES")
/** The points of this run, at collection: the test's timeout is gridTimeoutMs of them. */
const GRID = ENABLED
	? dvGrid({
			quick: process.env["WAVEKIT_DVCAP_QUICK"] === "1",
			variant: VARIANT,
			...(scenes === undefined ? {} : { scenes }),
			...(cnrDb === undefined ? {} : { cnrDb }),
			...(errorsHz === undefined ? {} : { errorsHz }),
			...(phases === undefined ? {} : { phases }),
		})
	: []

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

		it(
			"measures every over of every scene of the grid",
			async () => {
				expect(DVCAP_VARIANTS).toContain(VARIANT)
				process.stdout.write(
					`\n${GRID.length} points, about ${Math.round(gridSeconds(GRID))} s (scenes at real time + ${POINT_FIXED_S} s + ${POINT_PER_SCENE_S} s per scene second each), timeout ${Math.round(gridTimeoutMs(GRID) / 1000)} s\n`,
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
				const out =
					process.env["WAVEKIT_DVCAP_OUT"] ??
					join(tmpdir(), `dv-capture-${Date.now()}.md`)
				const { points, failed } = await runDvGrid(GRID, {
					measure: spec => measureDvPoint(spec, { channelize: chan }),
					out,
					...(linesDir === undefined ? {} : { linesDir }),
					frequencyHz: MARGIN_CENTRE_HZ + MARGIN_CAPTURE.offsetHz,
				})
				process.stdout.write(
					`\n${readFileSync(out, "utf8").split("\n\n<!--")[0]}\n\nwritten to ${out}\n`,
				)
				expect(points.length).toBeGreaterThan(0)
				// Every point is in the table; a failed one fails the run here, at the end.
				expect(
					failed.map(
						p =>
							`${p.scene} ${p.cnrDb} dB ${p.errorHz} Hz p${p.phase}: ${p.error}`,
					),
				).toEqual([])
			},
			gridTimeoutMs(GRID),
		)
	},
)

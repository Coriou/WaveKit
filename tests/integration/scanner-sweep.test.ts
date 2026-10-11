import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { createLogger } from "../../src/utils/logger.js"
import { SourceManager } from "../../src/core/source-manager.js"
import { FanoutManager } from "../../src/core/fanout-manager.js"
import { SourceFanoutRouter } from "../../src/core/source-fanout-router.js"
import { TunerController } from "../../src/core/tuner-controller.js"
import { TunerRelay } from "../../src/core/tuner-relay.js"
import { wireTunerControl } from "../../src/core/tuner-wiring.js"
import { DecoderRegistry } from "../../src/decoders/registry.js"
import { DecoderManager } from "../../src/decoders/manager.js"
import { ScannerService } from "../../src/core/scanner/scanner-service.js"
import { ScannerConfigSchema, type SourceConfig } from "../../src/config.js"
import type { ScannerSettings } from "../../src/core/scanner/types.js"
import {
	startSpectrumRtlTcp,
	type SpectrumRtlTcp,
} from "../mocks/scanner/fake-rtl-tcp.js"

const FS = 1_024_000
const INITIAL = 446_100_000
const EMITTERS = [
	{ hz: 450_112_500, amp: 0.25 },
	{ hz: 452_337_500, amp: 0.25 },
]

async function waitFor(check: () => boolean, timeoutMs: number): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out")
		await new Promise(resolve => setTimeout(resolve, 50))
	}
}

describe.skipIf(process.env["WAVEKIT_SCANNER_INTEGRATION"] !== "1")(
	"scanner sweep against a fake rtl_tcp",
	() => {
		let server: SpectrumRtlTcp | null = null
		afterEach(async () => {
			await server?.close()
			server = null
		})

		it("hops with markers, finds both emitters at their RF, holds decoders once and restores the tuner", async () => {
			server = await startSpectrumRtlTcp({
				fs: FS,
				initialHz: INITIAL,
				emitters: EMITTERS,
				seed: 9,
			})
			const logger = createLogger({ level: "fatal" })
			const dir = mkdtempSync(join(tmpdir(), "wk-sweep-"))
			const source: SourceConfig = {
				id: "rtl",
				type: "rtl_tcp",
				host: "127.0.0.1",
				port: server.port,
				loop: false,
				playbackSpeed: 1,
				caps: {
					kind: "iq",
					format: "U8_IQ",
					sampleRate: FS,
					centerFreq: INITIAL,
					exclusive: false,
				},
			}
			const sourceManager = new SourceManager(logger)
			const fanout = new FanoutManager(logger)
			const routing = new SourceFanoutRouter(
				sourceManager,
				fanout,
				logger,
				"rtl",
			)
			const tuner = new TunerController(logger, sourceManager)
			// The production wiring (src/index.ts), as tests/integration/tuner-reconnect-sync.test.ts does; no relay.
			wireTunerControl({
				log: logger,
				sourceManager,
				tunerController: tuner,
				tunerRelay: new TunerRelay(
					logger,
					sourceManager,
					new FanoutManager(logger),
					{
						enabled: false,
						host: "127.0.0.1",
						port: 1,
						controlPolicy: "shared",
					},
				),
				relayEnabled: false,
			})
			const decoders = new DecoderManager(new DecoderRegistry(), fanout, logger)
			decoders.setSourceManager(sourceManager, routing)
			const hold = vi.spyOn(decoders, "holdSource")
			const release = vi.spyOn(decoders, "releaseSource")
			const settings = ScannerConfigSchema.parse({
				storage: { dir },
				passive: { enabled: false },
				sweep: { markers: true, settleMs: { local: 300, network: 1000 } },
			}) as ScannerSettings
			const scanner = new ScannerService({
				settings,
				sourceConfigs: [source],
				decoderConfigs: [],
				region: "EU",
				stateDir: dir,
				sources: sourceManager,
				routing,
				tuner,
				decoders,
				digitalVoice: null,
				liveDemod: null,
				logger,
				engineHost: "inline",
			})
			try {
				await scanner.start()
				await sourceManager.connect(source)
				await waitFor(() => tuner.getState("rtl") !== undefined, 5000)
				const runningModes: (string | null)[] = []
				// The terminal `job` event is emitted after the teardown (restore, decoder release, engine close);
				// `getJob().state` already reads "completed" while those actions are still awaited.
				// Any terminal state ends the wait, so a failed or cancelled sweep fails fast with its reason.
				let ended: { state: string; reason?: string } | null = null
				scanner.on(
					"job",
					(j: {
						state: string
						reason?: string
						spec: { mode: string }
						progress: { settleMode: string | null }
					}) => {
						if (j.spec.mode !== "sweep") return
						if (j.state === "running") runningModes.push(j.progress.settleMode)
						if (
							j.state === "completed" ||
							j.state === "failed" ||
							j.state === "cancelled"
						)
							ended = {
								state: j.state,
								...(j.reason ? { reason: j.reason } : {}),
							}
					},
				)
				const job = await scanner.createJob({
					sourceId: "rtl",
					mode: "sweep",
					ranges: [{ startHz: 450_000_000, endHz: 452_600_000 }],
					hold: { policy: "never" },
					stop: { afterSweeps: 1 },
					takeover: true,
				})
				const hops = job.plan.hops
				const modes = runningModes
				expect(hops.length).toBeGreaterThanOrEqual(3)
				await waitFor(() => ended !== null, 30_000)
				expect(ended, `sweep ended ${JSON.stringify(ended)}`).toEqual({
					state: "completed",
				})

				const sent = server.frames
				const retunes = sent.filter(([cmd]) => cmd === 0x01).map(([, v]) => v)
				for (const hop of hops) expect(retunes).toContain(hop.centreHz)
				// every hop retune (revisits included) is bracketed back to back: TEST_MODE 1, SET_FREQ, TEST_MODE 0
				const centres = new Set(hops.map(h => h.centreHz))
				const hopRetunes = sent.flatMap(([cmd, v], i) =>
					cmd === 0x01 && centres.has(v) ? [i] : [],
				)
				expect(hopRetunes.length).toBeGreaterThanOrEqual(hops.length)
				for (const i of hopRetunes)
					expect(
						sent.slice(i - 1, i + 2),
						`frames around retune #${i}`,
					).toEqual([
						[0x07, 1],
						[0x01, sent[i]![1]],
						[0x07, 0],
					])
				// never two TEST_MODE 1 without a 0 between (a release adds an extra 0), never left on
				const tm = sent.filter(([cmd]) => cmd === 0x07).map(([, v]) => v)
				expect(tm.join("")).not.toContain("11")
				expect(tm.at(-1)).toBe(0)
				// restore: the last frequency written is the pre-lease one
				expect(retunes.at(-1)).toBe(INITIAL)
				expect(server.frequency()).toBe(INITIAL)
				// decoders held once for the whole sweep by this job (holder id = job id), released once
				expect(hold).toHaveBeenCalledTimes(1)
				expect(hold).toHaveBeenCalledWith("rtl", "tuner-scanning", job.id)
				expect(release).toHaveBeenCalledTimes(1)
				expect(release).toHaveBeenCalledWith("rtl", job.id)

				const found = scanner.listDiscoveries({
					jobId: job.id,
					limit: 500,
				}).items
				for (const e of EMITTERS) {
					const near = found.filter(
						d => Math.abs(d.frequencyHz - e.hz) <= 2_000,
					)
					expect(near, `discovery at ${e.hz}`).toHaveLength(1)
					expect(near[0]!.tuningTrust).toBe("commanded")
				}
				// the job ran under marker settle (recorded while it was running; a completed job closes its engine)
				expect(modes).toContain("marker")
			} finally {
				await scanner.stop()
				await decoders.destroy()
				await sourceManager.disconnectAll()
				rmSync(dir, { recursive: true, force: true })
			}
		}, 60_000)
	},
)

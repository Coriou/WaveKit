import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createReadStream, existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pipeline } from "node:stream/promises"
import { describe, expect, it } from "vitest"
import { createLogger } from "../../src/utils/logger.js"
import { SourceManager } from "../../src/core/source-manager.js"
import { FanoutManager } from "../../src/core/fanout-manager.js"
import { SourceFanoutRouter } from "../../src/core/source-fanout-router.js"
import { TunerController } from "../../src/core/tuner-controller.js"
import { DecoderRegistry } from "../../src/decoders/registry.js"
import { DecoderManager } from "../../src/decoders/manager.js"
import {
	createDsdFmeDecoder,
	DSD_FME_CAPS,
} from "../../src/decoders/builtin/dsd-fme.js"
import { ScannerService } from "../../src/core/scanner/scanner-service.js"
import { ScannerConfigSchema, type SourceConfig } from "../../src/config.js"
import type { ScannerSettings } from "../../src/core/scanner/types.js"

// Same meaning as in fixtures/download.sh: the local directory holding private captures by file name.
const privateDir = process.env["WAVEKIT_PRIVATE_FIXTURES_DIR"]
const RUN8 = privateDir ? join(privateDir, "run8-dmr.iq.u8") : ""
const RUN8_SHA256 =
	"5e8b81ba583abf6441dc92749968a9a195771e274e6a8ad74423c6f5a271697d"
const has = (bin: string) =>
	spawnSync("which", [bin], { stdio: "ignore" }).status === 0
const run =
	Boolean(privateDir) && existsSync(RUN8) && has("dsd-fme") && has("csdr")

// run8: DMR MS, dongle at 446.18775 MHz, carrier +6.0 kHz, 2.048 Msps, 44.9 s,
// two PTTs (0–11.37 s, keyed at capture start; 16.53–27.60 s). CC 1, TG 9,
// SRC 2060945, slot 1 (output/scanner-research/feasibility.md § 1, § 5).
describe.skipIf(!run)(
	"scanner on the run8 DMR capture (recording source)",
	() => {
		it("finds one decoded DMR discovery with two observations and nothing else above activity", async () => {
			const hash = createHash("sha256")
			await pipeline(createReadStream(RUN8), hash)
			expect(hash.digest("hex"), `${RUN8} is not the run8 capture`).toBe(
				RUN8_SHA256,
			)
			const logger = createLogger({ level: "fatal" })
			const dir = mkdtempSync(join(tmpdir(), "wk-run8-"))
			const source: SourceConfig = {
				id: "run8",
				type: "recording",
				filePath: RUN8,
				loop: false,
				playbackSpeed: 1,
				caps: {
					kind: "iq",
					format: "U8_IQ",
					sampleRate: 2_048_000,
					centerFreq: 446_187_750,
					exclusive: false,
				},
			}
			const sourceManager = new SourceManager(logger)
			const fanout = new FanoutManager(logger)
			const routing = new SourceFanoutRouter(
				sourceManager,
				fanout,
				logger,
				"run8",
			)
			const tuner = new TunerController(logger, sourceManager)
			const registry = new DecoderRegistry()
			registry.register("dsd-fme", createDsdFmeDecoder, DSD_FME_CAPS)
			const decoders = new DecoderManager(registry, fanout, logger)
			decoders.setSourceManager(sourceManager, routing)
			const settings = ScannerConfigSchema.parse({
				storage: { dir },
				passive: { enabled: false },
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
			const ended = new Promise<void>(resolve =>
				sourceManager.once("ended", () => resolve()),
			)
			try {
				await scanner.start()
				// The engine needs the source's caps, which exist only once it is connected: the job starts
				// about 0.1 s into the recording, inside the first PTT (keyed at capture start, 11.37 s long).
				await sourceManager.connect(source)
				const job = await scanner.createJob({
					name: "run8 operator in-window",
					sourceId: "run8",
					mode: "in-window",
					ranges: [{ startHz: 446_000_000, endHz: 446_200_000 }],
					protocols: [],
				})
				expect(job.spec.mode).toBe("in-window")
				await ended
				await new Promise(resolve => setTimeout(resolve, 3000))
				const all = scanner.listDiscoveries({ limit: 500 }).items
				const above = all.filter(d => d.confidence !== "activity")
				expect(above).toHaveLength(1)
				const dmr = above[0]!
				expect(Math.abs(dmr.frequencyHz - 446_193_750)).toBeLessThanOrEqual(
					1_000,
				)
				expect(dmr).toMatchObject({
					protocol: "dmr",
					confidence: "decoded",
					identity: { kind: "dmr-cc", value: "1" },
					encrypted: false,
					observationCount: 2,
				})
				expect(dmr.metadata.talkgroups).toContain("9")
				expect(dmr.metadata.sources).toContain("2060945")
				expect(dmr.metadata.slots).toEqual([1])
				expect(dmr.jobIds).toContain(job.id)
			} finally {
				await scanner.stop()
				await decoders.destroy()
				await sourceManager.disconnectAll()
				rmSync(dir, { recursive: true, force: true })
			}
		}, 120_000)
	},
)

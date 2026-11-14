import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"
import { afterEach, describe, expect, it } from "vitest"
import { chromiumPath } from "./browser.ts"
import {
	CannotRun,
	DEVICE_NAME,
	formatReport,
	insideRepository,
	lookHealthy,
	parseActions,
	parseOptions,
	readToken,
	summaryLine,
	type Look,
} from "./ui-check.ts"

const repository = fileURLToPath(new URL("../../../", import.meta.url))
const TOKEN = "t".repeat(43)

const look = (over: Partial<Look> = {}): Look => ({
	health: {
		rendererKind: "webgl2",
		rendererThread: "worker",
		reason: null,
		framesReceived: 412,
		framesDrawn: 410,
		link: "live",
		lastError: null,
	},
	traceDrawn: true,
	waterfall: "moving",
	framesAdvancing: true,
	notes: [],
	chips: [],
	...over,
})

describe("ui-check options", () => {
	afterEach(() => {
		delete process.env["WAVEKIT_UI_CHECK_LIVE"]
	})

	it("defaults to the fake core and a software GPU", () => {
		expect(parseOptions([])).toMatchObject({
			target: "fake",
			gpu: "software",
			route: "",
			screenshot: false,
			actions: [],
		})
	})

	it("reads a route, the GPU mode and scripted actions", () => {
		expect(
			parseOptions([
				"--route=#/scanner",
				"--gpu=off",
				"--screenshot",
				"--do=pause,wait:5,resume,retune:100.2e6",
			]),
		).toMatchObject({
			route: "#/scanner",
			gpu: "off",
			screenshot: true,
			actions: [
				{ name: "pause", value: null },
				{ name: "wait", value: 5 },
				{ name: "resume", value: null },
				{ name: "retune", value: 100_200_000 },
			],
		})
	})

	it("refuses what it does not know", () => {
		for (const argv of [
			["--target=prod"],
			["--gpu=fast"],
			["--route=/scanner"],
			["--do=explode"],
			["--do=retune"],
			["--do=pause:3"],
			["--token=abc"],
			["--url=http://127.0.0.1:1/"],
			["--token-file=/x"],
		])
			expect(() => parseOptions(argv)).toThrow(CannotRun)
		expect(() => parseActions("wait:-1")).toThrow(CannotRun)
	})

	it("keeps the live target for the session that owns the live core", () => {
		const live = ["--target=live", "--url=http://127.0.0.1:1/"]
		expect(() => parseOptions(live)).toThrow(/WAVEKIT_UI_CHECK_LIVE=1/)
		process.env["WAVEKIT_UI_CHECK_LIVE"] = "1"
		expect(() => parseOptions(["--target=live"])).toThrow(/--url/)
		expect(parseOptions(live)).toMatchObject({ target: "live" })
		// every action on the live target must be allowed by name; waiting changes nothing
		expect(() => parseOptions([...live, "--do=pause,wait:1"])).toThrow(
			/--allow: pause/,
		)
		expect(
			parseOptions([
				...live,
				"--do=pause,wait:1,resume",
				"--allow=pause,resume",
			]).actions,
		).toHaveLength(3)
	})
})

describe("ui-check credentials and paths", () => {
	it("reads the machine token from a file or from an access directory, and never repeats it", async () => {
		const dir = await mkdtemp(join(tmpdir(), "wavekit-ui-check-test-"))
		try {
			const file = join(dir, "machine-token")
			await writeFile(file, `${TOKEN}\n`)
			expect(await readToken({ tokenFile: file, accessDir: null })).toBe(TOKEN)
			expect(await readToken({ tokenFile: null, accessDir: dir })).toBe(TOKEN)
			await writeFile(file, "not a token\n")
			const refusal = await readToken({
				tokenFile: file,
				accessDir: null,
			}).catch((error: unknown) => error)
			expect(refusal).toBeInstanceOf(CannotRun)
			expect((refusal as Error).message).not.toContain("not a token")
			await expect(
				readToken({ tokenFile: join(dir, "missing"), accessDir: null }),
			).rejects.toThrow(CannotRun)
			await expect(
				readToken({ tokenFile: null, accessDir: null }),
			).rejects.toThrow(/--token-file/)
		} finally {
			await rm(dir, { recursive: true, force: true })
		}
	})

	it("knows a path inside the repository, existing or not", async () => {
		expect(await insideRepository(join(repository, "web"))).toBe(true)
		expect(
			await insideRepository(join(repository, "web", "new", "shots")),
		).toBe(true)
		expect(await insideRepository(join(tmpdir(), "wavekit-ui-check-x"))).toBe(
			false,
		)
		expect(await insideRepository(dirname(repository.replace(/\/$/, "")))).toBe(
			false,
		)
	})
})

describe("ui-check report", () => {
	it("reads a look in one line", () => {
		expect(summaryLine(look())).toBe(
			"spectrum: webgl2, 412 frames received, 410 drawn, waterfall moving",
		)
		expect(
			summaryLine(
				look({
					health: {
						rendererKind: "canvas2d",
						rendererThread: "worker",
						reason: "no WebGL2",
						framesReceived: 9,
						framesDrawn: 0,
						link: "live",
						lastError: null,
					},
					traceDrawn: false,
					waterfall: "empty",
				}),
			),
		).toBe(
			"spectrum: canvas2d (no WebGL2), 9 frames received, 0 drawn, waterfall empty, trace NOT drawn",
		)
		expect(summaryLine(look({ health: null }))).toContain("no health readout")
	})

	it("is healthy only with a renderer, a drawn trace, advancing frames and a moving waterfall", () => {
		expect(lookHealthy(look())).toBe(true)
		expect(lookHealthy(look({ traceDrawn: false }))).toBe(false)
		expect(lookHealthy(look({ waterfall: "still" }))).toBe(false)
		expect(lookHealthy(look({ framesAdvancing: false }))).toBe(false)
		expect(lookHealthy(look({ health: null }))).toBe(false)
	})

	it("prints one section per line, as JSON", () => {
		const text = formatReport({ healthy: true, target: { kind: "fake" } })
		expect(text.split("\n")).toEqual([
			"{",
			'  "healthy": true,',
			'  "target": {"kind":"fake"}',
			"}",
		])
		expect(JSON.parse(text)).toEqual({
			healthy: true,
			target: { kind: "fake" },
		})
	})
})

const browser =
	process.env["WAVEKIT_BROWSER_SMOKE"] === "1" && chromiumPath() !== null

// The command itself, end to end, as an agent runs it.
describe.skipIf(!browser)("node scripts/ui-check.mjs --target=fake", () => {
	it("pairs, reports a healthy spectrum, saves a screenshot outside the repository and signs out", async () => {
		const { stdout } = await promisify(execFile)(
			process.execPath,
			[join(repository, "scripts", "ui-check.mjs"), "--screenshot"],
			{ timeout: 400_000, maxBuffer: 4 * 1024 * 1024 },
		)
		const report = JSON.parse(stdout) as {
			healthy: boolean
			summary: string
			access: Record<string, unknown>
			spectrum: Look
			screenshots: string[]
		}
		const shot = report.screenshots[0] ?? ""
		try {
			expect(report.healthy).toBe(true)
			expect(report.summary).toMatch(
				/^spectrum: webgl2, \d+ frames received, \d+ drawn, waterfall moving$/,
			)
			expect(report.access).toEqual({
				mode: "protected",
				pairedBefore: false,
				pairedByRun: true,
				device: DEVICE_NAME,
				revokedAtEnd: true,
			})
			expect(existsSync(shot)).toBe(true)
			expect(await insideRepository(shot)).toBe(false)
		} finally {
			if (shot)
				await rm(dirname(dirname(shot)), { recursive: true, force: true })
		}
	}, 420_000)
})

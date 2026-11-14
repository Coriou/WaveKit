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
	Pairing,
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

describe("ui-check: the address the token goes to", () => {
	afterEach(() => {
		delete process.env["WAVEKIT_UI_CHECK_LIVE"]
	})

	it("takes https anywhere and plain http on this machine only", () => {
		process.env["WAVEKIT_UI_CHECK_LIVE"] = "1"
		for (const url of [
			"http://127.0.0.1:1/",
			"http://localhost:1/",
			"http://[::1]:1/",
			"https://radio.example/",
		])
			expect(parseOptions(["--target=live", `--url=${url}`]).url).toBe(url)
		for (const url of [
			"http://radio.example/",
			"http://192.0.2.7:5199/",
			"http://localhost.example/",
			"ftp://127.0.0.1/",
			"not a url",
		])
			expect(() => parseOptions(["--target=live", `--url=${url}`])).toThrow(
				CannotRun,
			)
	})
})

describe("ui-check: a device it paired is revoked however the run ends", () => {
	const DEVICE = `device_${"d".repeat(43)}`
	function pairing(over: Partial<Pairing> = {}) {
		const log: string[] = []
		const p = new Pairing()
		p.submitted = true
		p.deviceId = DEVICE
		p.machinePost = async (path, body) => {
			log.push(`machine ${path} ${JSON.stringify(body)}`)
			return 200
		}
		p.machineHolds = async () => false
		p.logout = async () => {
			log.push("logout")
			return true
		}
		Object.assign(p, over)
		return { p, log }
	}

	it("revokes through the machine route, by device id, without the browser", async () => {
		const { p, log } = pairing({ logout: null })
		expect(await p.revoke()).toBe(true)
		expect(p.revoked).toBe(true)
		expect(log).toEqual([
			`machine /api/access/machine/devices/revoke {"deviceId":"${DEVICE}"}`,
		])
	})

	it("revokes once, however many endings ask (the finally, a signal, the deadline)", async () => {
		const { p, log } = pairing()
		expect(await Promise.all([p.revoke(), p.revoke(), p.revoke()])).toEqual([
			true,
			true,
			true,
		])
		expect(log).toHaveLength(1)
	})

	it("reads the device id late when the run stopped between the submit and the read", async () => {
		const { p, log } = pairing({
			deviceId: null,
			readDeviceId: async () => DEVICE,
		})
		expect(await p.revoke()).toBe(true)
		expect(log[0]).toContain(DEVICE)
	})

	it("falls back to signing the page out when the machine route refuses or still lists the device", async () => {
		const refused = pairing({ machinePost: async () => 403 })
		expect(await refused.p.revoke()).toBe(true)
		expect(refused.log).toEqual(["logout"])
		const listed = pairing({ machineHolds: async () => true })
		expect(await listed.p.revoke()).toBe(true)
		expect(listed.log.at(-1)).toBe("logout")
	})

	it("says false when nothing could take the device back, and null when nothing was paired", async () => {
		const stuck = pairing({
			machinePost: async () => {
				throw new Error("core gone")
			},
			logout: async () => {
				throw new Error("browser gone")
			},
		})
		expect(await stuck.p.revoke()).toBe(false)
		expect(stuck.p.revoked).toBe(false)
		const none = new Pairing()
		expect(await none.revoke()).toBeNull()
		expect(none.revoked).toBeNull()
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

	it("revokes the device when the run fails right after pairing, and says so in its report", async () => {
		const outcome = await promisify(execFile)(
			process.execPath,
			[join(repository, "scripts", "ui-check.mjs")],
			{
				timeout: 400_000,
				maxBuffer: 4 * 1024 * 1024,
				env: { ...process.env, WAVEKIT_UI_CHECK_FAULT: "after-pairing" },
			},
		).then(
			() => ({ code: 0, stdout: "" }),
			(error: { code?: number; stdout?: string }) => ({
				code: error.code ?? -1,
				stdout: error.stdout ?? "",
			}),
		)
		expect(outcome.code).toBe(2)
		// revokedAtEnd is true only after the machine route answered and the core no longer lists the device
		expect(JSON.parse(outcome.stdout)).toEqual({
			healthy: false,
			cannotRun: "ui-check failed: fault injected after pairing",
			revokedAtEnd: true,
		})
	}, 420_000)
})

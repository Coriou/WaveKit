// Perf bench: the built web app against the loaded mock, in Chromium with a slowed CPU, checked
// against perf/budgets.json. Usage: pnpm --filter @wavekit/web perf [--no-build] [--only=a,b]
// [--measure=ms] [--cycles=n] [--throttle=x] [--out=report.json] [--profile=dir] [--headed]
//
// Each scenario loads the app fresh, opens its view and drawer, waits, then measures frames
// (requestAnimationFrame), main-thread busy time and long tasks. The leak run cycles every view,
// drawer and the palette, forcing a GC after each cycle, and fits the heap growth per cycle.
// Chromium: PLAYWRIGHT_CHROMIUM_PATH, else /opt/pw-browsers, else playwright-core's own lookup.

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { chromium, type CDPSession, type Page } from "playwright-core"

import {
	checkBudgets,
	frameStats,
	slope,
	type Budgets,
	type LeakResult,
	type ScenarioResult,
} from "./stats.ts"

const here = dirname(fileURLToPath(import.meta.url))
const webDir = join(here, "..")

const args = new Map(
	process.argv.slice(2).map(a => {
		const [k, v] = a.replace(/^--/, "").split("=")
		return [k ?? "", v ?? "true"] as const
	}),
)
const measureMs = Number(args.get("measure") ?? 8000)
const warmMs = Number(args.get("warm") ?? 3000)
const cycles = Number(args.get("cycles") ?? 8)
const throttle = Number(args.get("throttle") ?? 4)
const only = args.get("only")?.split(",")

interface Scenario {
	readonly name: string
	/** Dock buttons pressed in order (their aria-label). */
	readonly press: readonly string[]
}

// The load the earlier perf pass used: 340 aircraft at 5 updates/s each, 140 vessels.
const MOCK_ENV = { WAVEKIT_MOCK_LOAD: "10", WAVEKIT_MOCK_ADSB_RATE: "5" }

const SCENARIOS: readonly Scenario[] = [
	{ name: "spectrum", press: [] },
	{ name: "spectrum+activity", press: ["Activity"] },
	{ name: "spectrum+scanner", press: ["Scanner"] },
	{ name: "map", press: ["Map"] },
	{ name: "map+activity", press: ["Map", "Activity"] },
	{ name: "messages", press: ["Messages"] },
]

// One leak cycle: every view and drawer, Settings and the palette, back to the spectrum.
const CYCLE: readonly string[] = [
	"Activity",
	"Map",
	"Scanner",
	"Messages",
	"Recordings",
	"Settings",
	"Spectrum",
]

function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const s = createServer()
		s.unref()
		s.on("error", reject)
		s.listen(0, "127.0.0.1", () => {
			const a = s.address()
			s.close(() => {
				if (a && typeof a === "object") resolve(a.port)
				else reject(new Error("no port"))
			})
		})
	})
}

function run(
	cmd: string,
	argv: string[],
	env: NodeJS.ProcessEnv = {},
): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, argv, {
			cwd: webDir,
			stdio: "inherit",
			env: { ...process.env, ...env },
		})
		p.on("error", reject)
		p.on("exit", code =>
			code === 0
				? resolve()
				: reject(new Error(`${cmd} ${argv.join(" ")} exited ${code}`)),
		)
	})
}

/** Start a long-running child and resolve once its output matches `ready`. */
function serve(
	cmd: string,
	argv: string[],
	env: NodeJS.ProcessEnv,
	ready: RegExp,
): Promise<ChildProcess> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, argv, { cwd: webDir, env: { ...process.env, ...env } })
		let log = ""
		const timer = setTimeout(() => {
			p.kill()
			reject(new Error(`${cmd} did not start:\n${log}`))
		}, 60_000)
		const onData = (b: Buffer) => {
			log += b.toString()
			if (ready.test(log)) {
				clearTimeout(timer)
				resolve(p)
			}
		}
		p.stdout?.on("data", onData)
		p.stderr?.on("data", onData)
		p.on("error", reject)
		p.on("exit", code => {
			clearTimeout(timer)
			reject(new Error(`${cmd} exited ${code}:\n${log}`))
		})
	})
}

function chromiumPath(): string | undefined {
	const env = process.env["PLAYWRIGHT_CHROMIUM_PATH"]
	if (env) return env
	const root = "/opt/pw-browsers"
	if (!existsSync(root)) return undefined
	const dir = readdirSync(root).find(d => /^chromium-\d+$/.test(d))
	const bin = dir ? join(root, dir, "chrome-linux", "chrome") : undefined
	return bin && existsSync(bin) ? bin : undefined
}

// Installed before the app's scripts: frame stamps and long tasks between start() and stop().
const SAMPLER = `(() => {
	const s = { on: false, stamps: [], longMs: 0 }
	const tick = t => { if (s.on) s.stamps.push(t); requestAnimationFrame(tick) }
	requestAnimationFrame(tick)
	try {
		new PerformanceObserver(l => { if (s.on) for (const e of l.getEntries()) s.longMs += e.duration })
			.observe({ type: "longtask", buffered: false })
	} catch {}
	window.__wkPerf = {
		start() { s.on = true; s.stamps = []; s.longMs = 0 },
		stop() { s.on = false; return { stamps: s.stamps, longMs: s.longMs } },
	}
})()`

interface Sample {
	stamps: number[]
	longMs: number
}

async function metrics(cdp: CDPSession): Promise<Record<string, number>> {
	const { metrics: list } = await cdp.send("Performance.getMetrics")
	return Object.fromEntries(list.map(m => [m.name, m.value]))
}

async function press(page: Page, label: string): Promise<void> {
	await page
		.locator(`nav[aria-label="Primary"] button[aria-label="${label}"]`)
		.click()
}

async function open(page: Page, cdp: CDPSession, url: string): Promise<void> {
	await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
	await page.goto(url, { waitUntil: "load" })
	await page.locator('nav[aria-label="Primary"]').waitFor()
	await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle })
}

async function measure(
	page: Page,
	cdp: CDPSession,
	s: Scenario,
	url: string,
): Promise<ScenarioResult> {
	await open(page, cdp, url)
	for (const label of s.press) await press(page, label)
	await page.waitForTimeout(warmMs)
	const before = await metrics(cdp)
	const profileDir = args.get("profile")
	if (profileDir) {
		await cdp.send("Profiler.enable")
		await cdp.send("Profiler.start")
	}
	await page.evaluate(() =>
		(window as unknown as { __wkPerf: { start(): void } }).__wkPerf.start(),
	)
	const t0 = Date.now()
	await page.waitForTimeout(measureMs)
	if (profileDir) {
		const { profile } = await cdp.send("Profiler.stop")
		writeFileSync(
			join(profileDir, `${s.name}.cpuprofile`),
			JSON.stringify(profile),
		)
	}
	const sample = await page.evaluate(() =>
		(window as unknown as { __wkPerf: { stop(): Sample } }).__wkPerf.stop(),
	)
	const wall = Date.now() - t0
	const after = await metrics(cdp)
	const frames = frameStats(sample.stamps, wall)
	const busy =
		((after["TaskDuration"] ?? 0) - (before["TaskDuration"] ?? 0)) * 1000
	const script =
		((after["ScriptDuration"] ?? 0) - (before["ScriptDuration"] ?? 0)) * 1000
	return {
		name: s.name,
		...frames,
		busy: busy / wall,
		script: script / wall,
		longTaskMsPerS: (sample.longMs * 1000) / wall,
	}
}

async function leakRun(
	page: Page,
	cdp: CDPSession,
	url: string,
): Promise<LeakResult> {
	await open(page, cdp, url)
	await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 })
	const heaps: number[] = []
	const nodes: number[] = []
	const listeners: number[] = []
	// two cycles warm caches, lazy chunks and the stores' bounded buffers before the first sample
	for (let i = 0; i < cycles + 2; i++) {
		for (const label of CYCLE) {
			await press(page, label)
			await page.waitForTimeout(400)
		}
		await page.keyboard.press("Control+k")
		await page.waitForTimeout(300)
		await page.keyboard.press("Escape")
		await page.keyboard.press("Escape")
		await page.waitForTimeout(300)
		if (i < 2) continue
		await cdp.send("HeapProfiler.collectGarbage")
		await cdp.send("HeapProfiler.collectGarbage")
		const m = await metrics(cdp)
		heaps.push((m["JSHeapUsedSize"] ?? 0) / 2 ** 20)
		nodes.push(m["Nodes"] ?? 0)
		listeners.push(m["JSEventListeners"] ?? 0)
	}
	return {
		cycles,
		heapStartMb: heaps[0] ?? 0,
		heapEndMb: heaps.at(-1) ?? 0,
		nodesStart: nodes[0] ?? 0,
		nodesEnd: nodes.at(-1) ?? 0,
		listenersStart: listeners[0] ?? 0,
		listenersEnd: listeners.at(-1) ?? 0,
		heapSlopeMb: slope(heaps),
	}
}

async function main(): Promise<void> {
	const budgets = JSON.parse(
		readFileSync(join(here, "budgets.json"), "utf8"),
	) as Budgets
	if (args.get("build") !== "false" && !args.has("no-build"))
		await run("pnpm", ["exec", "vite", "build"])

	const mockPort = await freePort()
	const audioPort = await freePort()
	const webPort = await freePort()
	const children: ChildProcess[] = []
	const stop = () => {
		for (const c of children) c.kill("SIGTERM")
	}
	process.on("exit", stop)
	try {
		children.push(
			await serve(
				process.execPath,
				["--experimental-strip-types", "--no-warnings", "mock/server.ts"],
				{
					...MOCK_ENV,
					WAVEKIT_MOCK_PORT: String(mockPort),
					WAVEKIT_MOCK_AUDIO_PORT: String(audioPort),
					WAVEKIT_MOCK_AUDIO_ORIGIN: `http://127.0.0.1:${audioPort}`,
				},
				/WaveKit mock API on/,
			),
		)
		children.push(
			await serve(
				"pnpm",
				[
					"exec",
					"vite",
					"preview",
					"--strictPort",
					"--port",
					String(webPort),
					"--host",
					"127.0.0.1",
				],
				{ WAVEKIT_WEB_API: `http://127.0.0.1:${mockPort}` },
				/127\.0\.0\.1:\d+/,
			),
		)
		const url = `http://127.0.0.1:${webPort}/`
		const exe = chromiumPath()
		const browser = await chromium.launch({
			headless: !args.has("headed"),
			...(exe ? { executablePath: exe } : {}),
		})
		const context = await browser.newContext({
			viewport: { width: 1440, height: 900 },
			serviceWorkers: "block",
		})
		await context.addInitScript(SAMPLER)
		const page = await context.newPage()
		const cdp = await context.newCDPSession(page)
		await cdp.send("Performance.enable")

		const results: ScenarioResult[] = []
		for (const s of SCENARIOS) {
			if (only && !only.includes(s.name)) continue
			const r = await measure(page, cdp, s, url)
			results.push(r)
			process.stdout.write(
				`${r.name.padEnd(20)} ${r.fps.toFixed(1).padStart(5)} fps  p95 ${r.p95FrameMs
					.toFixed(1)
					.padStart(
						5,
					)} ms  missed ${(r.jank * 100).toFixed(0).padStart(3)} %  busy ${(
					r.busy * 100
				)
					.toFixed(0)
					.padStart(
						3,
					)} %  script ${(r.script * 100).toFixed(0).padStart(3)} %  long ${r.longTaskMsPerS.toFixed(0).padStart(4)} ms/s\n`,
			)
		}
		let leak: LeakResult | null = null
		if (!only || only.includes("leak")) {
			leak = await leakRun(page, cdp, url)
			process.stdout.write(
				`leak (${leak.cycles} cycles)      heap ${leak.heapStartMb.toFixed(1)} → ${leak.heapEndMb.toFixed(
					1,
				)} MB (${leak.heapSlopeMb.toFixed(2)} MB/cycle)  nodes ${leak.nodesStart} → ${
					leak.nodesEnd
				}  listeners ${leak.listenersStart} → ${leak.listenersEnd}\n`,
			)
		}
		await browser.close()

		const out = args.get("out")
		if (out)
			writeFileSync(
				out,
				JSON.stringify({ throttle, measureMs, results, leak }, null, "\t"),
			)
		const broken = checkBudgets(budgets, results, leak)
		if (broken.length > 0) {
			process.stdout.write(
				`\nOver budget:\n${broken.map(b => `  ${b}`).join("\n")}\n`,
			)
			process.exitCode = 1
		} else process.stdout.write("\nAll within budget.\n")
	} finally {
		stop()
	}
}

main().catch((error: unknown) => {
	process.stderr.write(
		`perf bench failed: ${error instanceof Error ? error.stack : String(error)}\n`,
	)
	process.exit(1)
})

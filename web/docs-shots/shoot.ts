// Documentation screenshots: the built web app against the mock, in Chromium, written to
// docs/assets/screenshots/. Usage: pnpm --filter @wavekit/web docs:shots [--no-build] [--only=a,b]
//
// The mock serves the same seeded data on every run, so a shot changes only when the app does.
// Each shot loads the app fresh with its theme in localStorage, presses its dock buttons, waits
// for the waterfall and live data to settle, then captures the viewport at 2x.
// Chromium: PLAYWRIGHT_CHROMIUM_PATH, else /opt/pw-browsers, else playwright-core's own lookup.

import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, mkdirSync, readdirSync } from "node:fs"
import { createServer } from "node:net"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { chromium } from "playwright-core"

const here = dirname(fileURLToPath(import.meta.url))
const webDir = join(here, "..")
const outDir = join(webDir, "..", "docs", "assets", "screenshots")

const args = new Map(
	process.argv.slice(2).map(a => {
		const [k, v] = a.replace(/^--/, "").split("=")
		return [k ?? "", v ?? "true"] as const
	}),
)
const only = args.get("only")?.split(",")

interface Shot {
	/** File name without extension. */
	readonly name: string
	readonly theme: "dark" | "light"
	/** Dock buttons pressed in order (their aria-label). */
	readonly press: readonly string[]
	readonly viewport?: { width: number; height: number }
	/** Time for the waterfall and the live data to fill, in ms. */
	readonly settleMs?: number
}

const DESKTOP = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

const SHOTS: readonly Shot[] = [
	{ name: "spectrum-dark", theme: "dark", press: [], settleMs: 16000 },
	{ name: "spectrum-light", theme: "light", press: [], settleMs: 16000 },
	{ name: "activity", theme: "dark", press: ["Activity"] },
	{ name: "map", theme: "dark", press: ["Map"] },
	{ name: "messages", theme: "dark", press: ["Messages"] },
	{ name: "scanner", theme: "dark", press: ["Scanner"] },
	{ name: "phone", theme: "dark", press: [], viewport: PHONE, settleMs: 16000 },
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

function run(cmd: string, argv: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const p = spawn(cmd, argv, { cwd: webDir, stdio: "inherit" })
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

async function main(): Promise<void> {
	if (!args.has("no-build")) await run("pnpm", ["exec", "vite", "build"])
	mkdirSync(outDir, { recursive: true })

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
			...(exe ? { executablePath: exe } : {}),
		})
		for (const shot of SHOTS) {
			if (only && !only.includes(shot.name)) continue
			const context = await browser.newContext({
				viewport: shot.viewport ?? DESKTOP,
				deviceScaleFactor: 2,
				colorScheme: shot.theme,
				serviceWorkers: "block",
			})
			await context.addInitScript(
				([key, value]) => localStorage.setItem(key, value),
				[
					"wavekit.web.theme",
					JSON.stringify({
						theme: shot.theme,
						ground: "black",
						accent: "mono",
						waterfall: "match",
					}),
				] as const,
			)
			const page = await context.newPage()
			await page.goto(url, { waitUntil: "load" })
			await page.locator("canvas").first().waitFor()
			for (const label of shot.press)
				await page
					.locator(`nav[aria-label="Primary"] button[aria-label="${label}"]`)
					.click()
			// No hover tooltip on the dock in the shot.
			await page.mouse.move(1, 1)
			await page.waitForTimeout(shot.settleMs ?? 5000)
			const file = join(outDir, `${shot.name}.png`)
			await page.screenshot({ path: file })
			console.log(`wrote ${file}`)
			await context.close()
		}
		await browser.close()
	} finally {
		stop()
	}
}

main().catch((err: unknown) => {
	console.error(err)
	process.exit(1)
})

// Usage: node shoot.mjs <boardDir> <outDir> <Board[:w x h]>... [--themes dark,light] [--props JSON]
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { createRequire } from "node:module"
const require = createRequire(process.env.PLAYWRIGHT_FROM ?? import.meta.url)
const { chromium } = require("playwright")
const H = path.dirname(new URL(import.meta.url).pathname)
const FONTS = path.resolve(H, "../../../packages/brand/fonts") + "/"
const BLOB = {
	"6b6b1c5cae1637ecc473a959a8d87a96": "d-din/D-DINCondensed.woff2",
	"2abc64ad8670fc5303395b91efc22319": "d-din/D-DINCondensed-Bold.woff2",
	fc93658bc9e76c8f71fbef44633be7ab: "noto-sans/NotoSans-Regular.woff2",
	d96658b3edaf151ed186f81e701c06c7: "noto-sans/NotoSans-Bold.woff2",
}
const args = process.argv.slice(2)
let themes = ["dark", "light"], extra = {}, settle = 2500, clicks = [], evalFile = null
const boards = []
for (let i = 0; i < args.length; i++) {
	if (args[i] === "--themes") themes = args[++i].split(",")
	else if (args[i] === "--props") extra = JSON.parse(args[++i])
	else if (args[i] === "--eval") evalFile = args[++i]
	else if (args[i] === "--click") clicks = args[++i].split(",")
	else if (args[i] === "--settle") settle = Number(args[++i])
	else boards.push(args[i])
}
const [dir, out, ...names] = boards
fs.mkdirSync(out, { recursive: true })
const srv = http.createServer((req, res) => {
	const u = decodeURIComponent(req.url.split("?")[0])
	let f
	if (u === "/support.js") f = process.env.DC_RUNTIME ?? path.join(H, "support.js")
	else if (u.startsWith("/_blob/")) f = FONTS + (BLOB[u.slice(7)] ?? "x")
	else f = path.join(dir, u)
	fs.readFile(f, (e, d) => {
		if (e) { res.writeHead(404); res.end(); return }
		const t = f.endsWith(".js") ? "text/javascript" : f.endsWith(".woff2") ? "font/woff2" : "text/html"
		res.writeHead(200, { "content-type": t }); res.end(d)
	})
})
await new Promise(r => srv.listen(0, r))
const port = srv.address().port
const browser = await chromium.launch()
const meta = JSON.parse(fs.readFileSync(path.join(dir, "canvas.json"), "utf8")).boards
for (const spec of names) {
	const [name, size] = spec.split(":")
	const m = meta[name + ".dc.html"] ?? { w: 1440, h: 900 }
	const [w, h] = size ? size.split("x").map(Number) : [m.w, m.h]
	for (const theme of themes) {
		const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 })
		const errs = []
		page.on("pageerror", e => errs.push(String(e)))
		page.on("console", c => { if (c.type() === "error") errs.push(c.text()) })
		await page.addInitScript(() => {
			let s = 1234567
			Math.random = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648 }
		})
		await page.clock.install({ time: new Date("2026-10-16T10:00:00Z") })
		await page.clock.pauseAt(new Date("2026-10-16T10:00:01Z"))
		await page.goto(`http://127.0.0.1:${port}/${name}.dc.html`, { waitUntil: "networkidle" })
		await page.waitForFunction(() => typeof window.__dcSetProps === "function" && window.__dcRootName)
		await page.evaluate(([p]) => window.__dcSetProps(window.__dcRootName(), p), [{ theme, ...extra }])
		for (let i = 0; i < 20; i++) { await page.clock.runFor(100); await page.waitForLoadState("networkidle"); await page.waitForTimeout(30) }
		await page.clock.runFor(settle)
		for (const c of clicks) {
			await page.getByRole("button", { name: c, exact: true }).first().click()
			for (let i = 0; i < 10; i++) { await page.clock.runFor(100); await page.waitForLoadState("networkidle"); await page.waitForTimeout(30) }
			await page.clock.runFor(settle)
		}
		await page.evaluate(() => document.fonts.ready)
		await page.clock.runFor(50); await page.waitForTimeout(200)
		if (evalFile) console.log(name, theme, clicks.join("+"), JSON.stringify(await page.evaluate(fs.readFileSync(evalFile, "utf8"))))
		await page.evaluate(() => document.getAnimations().forEach(a => { a.pause(); a.currentTime = 0 }))
		await page.waitForTimeout(50)
		const tag = (Object.keys(extra).length ? "-" + Object.values(extra).join("-") : "") + (clicks.length ? "-" + clicks.join("-").replace(/\W+/g, "") : "")
		await page.screenshot({ path: path.join(out, `${name}${tag}-${theme}.png`), fullPage: true, animations: "allow" })
		if (errs.length) console.log(name, theme, "ERRORS:", errs.slice(0, 5).join(" | "))
		await page.close()
	}
	console.log("shot", name)
}
await browser.close(); srv.close()

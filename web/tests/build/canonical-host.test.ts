import * as http from "node:http"
import type { AddressInfo } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import {
	canonicalHostRedirect,
	isNavigation,
} from "../../build/canonical-host.ts"

interface Fake {
	port: number
	/** Host headers of the bootstrap probes received. */
	probes: string[]
	close(): Promise<void>
}

const servers: Fake[] = []

/**
 * Stands for the web server with its proxy and the core behind it: /api/access/bootstrap answers
 * what the core would for the request's Host.
 */
async function fake(
	answer: (host: string, port: number) => { status: number; body: unknown },
): Promise<Fake> {
	const probes: string[] = []
	const server = http.createServer((req, res) => {
		const host = req.headers.host ?? ""
		if (req.url === "/api/access/bootstrap") probes.push(host)
		const port = (server.address() as AddressInfo).port
		const { status, body } = answer(host, port)
		res.writeHead(status, { "content-type": "application/json" })
		res.end(JSON.stringify(body))
	})
	await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve))
	const out: Fake = {
		port: (server.address() as AddressInfo).port,
		probes,
		close: () =>
			new Promise<void>(resolve => {
				server.closeAllConnections()
				server.close(() => resolve())
			}),
	}
	servers.push(out)
	return out
}

const onlyAccepts =
	(name: string) =>
	(host: string, port: number): { status: number; body: unknown } =>
		host === `${name}:${port}`
			? { status: 200, body: { version: 1 } }
			: { status: 403, body: { code: "HOST_FORBIDDEN" } }

afterEach(async () => {
	for (const s of servers.splice(0)) await s.close()
})

describe("canonicalHostRedirect", () => {
	it("sends localhost to 127.0.0.1 when the core accepts only that name", async () => {
		const web = await fake(onlyAccepts("127.0.0.1"))
		expect(
			await canonicalHostRedirect(`localhost:${web.port}`, "/?a=1", web.port),
		).toBe(`http://127.0.0.1:${web.port}/?a=1`)
	})

	it("sends 127.0.0.1 to localhost when the core accepts only that name", async () => {
		const web = await fake(onlyAccepts("localhost"))
		expect(
			await canonicalHostRedirect(`127.0.0.1:${web.port}`, "/", web.port),
		).toBe(`http://localhost:${web.port}/`)
	})

	it("leaves an accepted address alone, with one probe", async () => {
		const web = await fake(onlyAccepts("127.0.0.1"))
		expect(
			await canonicalHostRedirect(`127.0.0.1:${web.port}`, "/", web.port),
		).toBeNull()
		expect(web.probes).toEqual([`127.0.0.1:${web.port}`])
	})

	it("leaves a core without access control alone", async () => {
		const web = await fake(() => ({ status: 404, body: { code: "NOT_FOUND" } }))
		expect(
			await canonicalHostRedirect(`localhost:${web.port}`, "/", web.port),
		).toBeNull()
	})

	it("does not redirect when no loopback name is accepted", async () => {
		const web = await fake(() => ({
			status: 403,
			body: { code: "HOST_FORBIDDEN" },
		}))
		expect(
			await canonicalHostRedirect(`localhost:${web.port}`, "/", web.port),
		).toBeNull()
	})

	it("does not redirect to a name that answers with a proxy error", async () => {
		const web = await fake(host =>
			host.startsWith("localhost")
				? { status: 403, body: { code: "HOST_FORBIDDEN" } }
				: { status: 502, body: null },
		)
		expect(
			await canonicalHostRedirect(`localhost:${web.port}`, "/", web.port),
		).toBeNull()
	})

	it("never probes for a name that is not loopback, or a port that is not its own", async () => {
		const web = await fake(onlyAccepts("127.0.0.1"))
		for (const host of [
			`radio.example:${web.port}`,
			`192.0.2.7:${web.port}`,
			`localhost.example:${web.port}`,
			`localhost:${web.port + 1}`,
			"localhost",
			"",
		])
			expect(await canonicalHostRedirect(host, "/", web.port)).toBeNull()
		expect(web.probes).toEqual([])
	})

	it("keeps only a local path: an absolute or protocol-relative target is not followed", async () => {
		const web = await fake(onlyAccepts("127.0.0.1"))
		for (const url of ["//evil.example/", "http://evil.example/", "/\\evil"])
			expect(
				await canonicalHostRedirect(`localhost:${web.port}`, url, web.port),
			).toBeNull()
	})

	it("gives up quietly when nothing answers", async () => {
		const web = await fake(onlyAccepts("127.0.0.1"))
		const port = web.port
		await web.close()
		servers.length = 0
		expect(
			await canonicalHostRedirect(`localhost:${port}`, "/", port),
		).toBeNull()
	})
})

describe("isNavigation", () => {
	it("is a GET for a document, not the API, a module or a worker script", () => {
		const nav = {
			accept: "text/html,application/xhtml+xml",
			"sec-fetch-dest": "document",
		}
		expect(isNavigation("GET", "/", nav)).toBe(true)
		expect(isNavigation("GET", "/#/map", { accept: "text/html" })).toBe(true)
		expect(isNavigation("POST", "/", nav)).toBe(false)
		expect(isNavigation("GET", "/api/status", nav)).toBe(false)
		expect(isNavigation("GET", "/ws", nav)).toBe(false)
		expect(isNavigation("GET", "/health", nav)).toBe(false)
		expect(
			isNavigation("GET", "/src/main.tsx", {
				accept: "*/*",
				"sec-fetch-dest": "script",
			}),
		).toBe(false)
		expect(isNavigation("GET", "/", { accept: "*/*" })).toBe(false)
		expect(
			isNavigation("GET", "/", {
				accept: "text/html",
				"sec-fetch-dest": "iframe",
			}),
		).toBe(false)
	})
})

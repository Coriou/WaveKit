import { IncomingMessage } from "node:http"
import { Socket } from "node:net"
import { describe, expect, it } from "vitest"
import { accessRequestFromHttp } from "../../../src/access/http-request.js"

describe("accessRequestFromHttp", () => {
	it("preserves duplicate headers and raw targets without forwarding trust", () => {
		const request = new IncomingMessage(new Socket())
		request.method = "POST"
		request.url = "/api/%2faccess?example=1"
		request.rawHeaders = [
			"Host",
			"core.local",
			"Host",
			"evil.local",
			"X-Forwarded-For",
			"192.0.2.1",
			"X-Forwarded-Host",
			"trusted.local",
		]
		const facts = accessRequestFromHttp(request, "audio")
		expect(facts).toEqual({
			method: "POST",
			rawTarget: request.url,
			rawHeaders: request.rawHeaders,
			transport: "http",
			surface: "audio",
			remoteAddress: "",
		})
		request.rawHeaders.push("Origin", "https://evil.local")
		expect(facts.rawHeaders).toHaveLength(8)
		request.destroy()
	})

	it("detects raw upgrade before framework metadata, including ambiguous upgrades", () => {
		const request = new IncomingMessage(new Socket())
		request.rawHeaders = ["uPgRaDe", "websocket", "Upgrade", "h2c"]
		expect(accessRequestFromHttp(request, "api").transport).toBe("websocket")
		request.rawHeaders = ["Upgrade", "unknown"]
		expect(accessRequestFromHttp(request, "api").transport).toBe("websocket")
		request.destroy()
	})

	it("leaves missing method and target invalid for the policy", () => {
		const request = new IncomingMessage(new Socket())
		const facts = accessRequestFromHttp(request, "api")
		expect(facts.method).toBe("")
		expect(facts.rawTarget).toBe("")
		request.destroy()
	})
})

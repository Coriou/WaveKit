import type { IncomingMessage } from "node:http"
import type { AccessRequest } from "./types.js"

/**
 * Preserve wire facts for policy validation. Trusted composition supplies the
 * surface; Host/forwarded headers never select it or a listener configuration.
 * Any raw Upgrade header takes the stricter upgrade admission path, before the
 * WebSocket plugin sets framework metadata or decides which upgrades it accepts.
 */
export function accessRequestFromHttp(
	request: IncomingMessage,
	surface: AccessRequest["surface"],
): AccessRequest {
	const upgrade = request.rawHeaders.some(
		(name, index) => index % 2 === 0 && name.toLowerCase() === "upgrade",
	)
	return {
		method: request.method ?? "",
		rawTarget: request.url ?? "",
		rawHeaders: [...request.rawHeaders],
		transport: upgrade ? "websocket" : "http",
		surface,
		remoteAddress: request.socket.remoteAddress ?? "",
	}
}

#!/usr/bin/env node
// Temporary Mac loopback path when a container cannot reach a LAN receiver.
import net from "node:net"

const host = process.argv[2]
if (!host || !/^[a-zA-Z0-9.:-]+$/.test(host)) {
	console.error("Usage: node scripts/pi-lan-bridge.mjs <receiver-host>")
	process.exit(1)
}
const sockets = new Set()
const servers = []
for (const [localPort, targetPort] of [
	[15555, 5555],
	[18080, 8080],
	[15556, 5556],
]) {
	const server = net.createServer(client => {
		if (sockets.size >= 64) {
			client.destroy()
			return
		}
		const upstream = net.createConnection({ host, port: targetPort })
		sockets.add(client)
		sockets.add(upstream)
		client.setNoDelay(true)
		upstream.setNoDelay(true)
		upstream.setKeepAlive(true, 5000)
		// IQ never pauses on a healthy rtl_tcp stream; silence means a receiver
		// reboot left a half-open socket, so close it and let the client reconnect.
		if (targetPort === 5555) {
			upstream.setTimeout(15000, () =>
				upstream.destroy(new Error("Receiver IQ stalled")),
			)
		}
		const timer = setTimeout(
			() => upstream.destroy(new Error("Receiver connection timed out")),
			5000,
		)
		const close = () => {
			clearTimeout(timer)
			client.destroy()
			upstream.destroy()
			sockets.delete(client)
			sockets.delete(upstream)
		}
		client.on("error", close)
		upstream.on("error", close)
		client.on("close", close)
		upstream.on("close", close)
		upstream.once("connect", () => clearTimeout(timer))
		client.pipe(upstream)
		upstream.pipe(client)
	})
	server.on("error", error => {
		console.error(error.message)
		stop()
	})
	server.listen(localPort, "127.0.0.1", () =>
		console.log(`Loopback ${localPort} -> receiver ${targetPort}`),
	)
	servers.push(server)
}
function stop() {
	for (const socket of sockets) socket.destroy()
	for (const server of servers) server.close()
}
process.on("SIGTERM", stop)
process.on("SIGINT", stop)

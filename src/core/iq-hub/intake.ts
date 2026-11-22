/**
 * The seam through which SourceManager gets and dials a network source's socket. The default
 * (inline in source-manager.ts) is today's path: `new net.Socket()` and `socket.connect(port,
 * host)`. The hub intake (supervisor.ts) hands out a real `net.Socket` too, connected to a
 * `wavekit-iqhub` front sink over a Unix socket; every SourceManager listener, timer, pause,
 * write, end and destroy runs on that socket unchanged.
 */
import { isIP } from "node:net"
import type { Socket } from "node:net"
import type { SourceConfig } from "../../config.js"

export interface SourceIntake {
	/** The socket of one connection attempt to `host:port` (the attempt's endpoint). */
	create(id: string, config: SourceConfig, host: string, port: number): Socket
	/** Starts the attempt (today: `socket.connect(port, host)`). */
	connect(
		socket: Socket,
		id: string,
		config: SourceConfig,
		host: string,
		port: number,
	): void
	/** The upstream TCP local port of the attempt, when the socket is not the TCP socket itself. */
	localPortOf(socket: Socket): number | null
	/** The source was removed: drop its per-source state synchronously (a re-add starts fresh). */
	dispose(id: string): void
	/** Every source is gone (shutdown): resolves once every per-source process has exited. */
	disposeAll(): Promise<void>
}

/** Symbol a hub front socket is tagged with (its value is the source id); the bench preload counts it. */
export const HUB_FRONT_TAG = Symbol.for("wavekit.iqhub.front")

/**
 * Hub intake applies to IP-literal hosts only: the hub does no name resolution, and resolving a
 * name once would differ from `net.connect`'s address-family selection. Names keep the socket path.
 */
export function hubEligibleHost(host: string): boolean {
	return isIP(host) !== 0
}

/** Hub intake applies to rtl_tcp U8 IQ sources only. */
export function hubEligibleSource(config: SourceConfig): boolean {
	return config.type === "rtl_tcp" && config.caps.format === "U8_IQ"
}

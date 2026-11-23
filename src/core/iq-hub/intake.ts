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
	/**
	 * True when the intake itself bounds the attempt's connect phase (the hub: its start, its
	 * configure and the upstream connect each have their own deadline and error code), so
	 * SourceManager arms no connect timeout of its own on the socket. Absent: false.
	 */
	ownsConnectDeadline?(socket: Socket): boolean
	/**
	 * Hub intake: registers `bytes` command bytes just written on `socket` (call it synchronously
	 * after `socket.write`, so the offsets follow the write order) and calls `onPlaced` once with
	 * the Node payload position the hub placed them at (`pos`, the first byte that can carry IQ
	 * produced after the receiver read them) and the bytes that may still be in flight then, or
	 * `pos: null` when they never reached the receiver (`mismatch: true`: they may have, at an
	 * unknown position; the intake then fails the socket). False (and no call) for a socket that is
	 * not a hub front: the caller keeps today's receipt at the write callback.
	 */
	noteCommandBytes?(
		socket: Socket,
		bytes: number,
		onPlaced: (placement: CommandPlacement) => void,
	): boolean
	/** The source was removed: drop its per-source state synchronously (a re-add starts fresh). */
	dispose(id: string): void
	/** Every source is gone (shutdown): resolves once every per-source process has exited. */
	disposeAll(): Promise<void>
	/** SourceManager hears the intake's own events here (set once, before the first dial). */
	attach?(listener: SourceIntakeListener): void
}

/** A whole-frame skip the hub counted on a front (lag or start): counted loss. */
export interface IntakeGap {
	/** The Node payload position the skip sits at (the front's sink byte). */
	atSinkByte: number
	droppedBytes: number
	cause: "lag" | "start" | "stream"
}

export interface SourceIntakeListener {
	onIntakeGap(socket: Socket, gap: IntakeGap): void
}

/** Where the hub placed command bytes in the Node payload (see SourceIntake.noteCommandBytes). */
export interface CommandPlacement {
	pos: number | null
	inFlightBytes?: number
	/** With `pos: null`: the hub's placements disagreed with Node's, so the position is unknown. */
	mismatch?: true
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

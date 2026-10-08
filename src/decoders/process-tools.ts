import type { ChildProcess } from "node:child_process"

/** Quote only when needed, keeping ordinary generated arguments readable. */
export function shellArg(value: string): string {
	return /^[A-Za-z0-9_./:=,+-]+$/.test(value)
		? value
		: "'" + value.replaceAll("'", "'\\''") + "'"
}

export function shellCommand(command: string, args: string[]): string {
	return [command, ...args].map(shellArg).join(" ")
}

/** Each decoder owns a detached POSIX process group, including DSP stages. */
export function signalDecoder(
	proc: ChildProcess,
	signal: NodeJS.Signals,
): void {
	if (proc.pid === undefined || proc.pid <= 1) return
	if (process.platform !== "win32") {
		try {
			process.kill(-proc.pid, signal)
			return
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error
		}
	}
	proc.kill(signal)
}

/** Stateful band-limited resampling of paired I/Q channels, without dither. */
export function iqResampleCommand(
	inputRate: number,
	outputRate: number,
): string {
	if (
		![inputRate, outputRate].every(rate => Number.isFinite(rate) && rate > 0)
	) {
		throw new Error("IQ resampling requires positive finite sample rates")
	}
	return shellCommand("sox", [
		"-q",
		"-D",
		"-t",
		"raw",
		"-e",
		"unsigned-integer",
		"-b",
		"8",
		"-c",
		"2",
		"-r",
		String(inputRate),
		"-",
		"-t",
		"raw",
		"-e",
		"unsigned-integer",
		"-b",
		"8",
		"-c",
		"2",
		"-r",
		String(outputRate),
		"-",
		"rate",
		"-h",
		String(outputRate),
	])
}

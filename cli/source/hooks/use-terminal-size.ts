import { useEffect, useState } from "react"
import { useStdout } from "ink"

export interface TerminalSize {
	columns: number
	rows: number
}

export function useTerminalSize(): TerminalSize {
	const { stdout } = useStdout()

	const [size, setSize] = useState<TerminalSize>(() => ({
		columns: stdout?.columns ?? 80,
		rows: stdout?.rows ?? 24,
	}))

	useEffect(() => {
		if (!stdout) return

		const update = () => {
			setSize(prev => ({
				columns: stdout.columns ?? prev.columns,
				rows: stdout.rows ?? prev.rows,
			}))
		}

		update()

		if (!stdout.isTTY) return

		stdout.on("resize", update)
		return () => {
			if (typeof stdout.off === "function") {
				stdout.off("resize", update)
			} else {
				stdout.removeListener("resize", update)
			}
		}
	}, [stdout])

	return size
}

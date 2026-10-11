import { Box, Text } from "ink"
import { useContext } from "react"
import { ColorContext } from "./lines.js"
import type { ScanState } from "../data/scan-state.js"
import {
	halfBlockRuns,
	spectrumCells,
	spectrumMaskCells,
	powerRamp,
	spectrumMode,
} from "../ui/theme.js"

export function Spectrum({
	scan,
	width,
	height,
	now,
}: {
	scan: ScanState
	width: number
	height: number
	now: number
}) {
	const color = useContext(ColorContext)
	const mode = spectrumMode(
		process.env,
		color && process.stdout.isTTY === true,
		process.stdout.getColorDepth?.() ?? 0,
	)
	const last = scan.rows[scan.rows.length - 1]
	if (!last || now - last.receivedAt > 5000 || height <= 0)
		return <Box height={Math.max(0, height)} />
	const unverified = last.frame.tuningTrust === "unverified"
	const cells = spectrumCells(last.bins, width)
	const count = Math.min(
		64,
		Math.max(0, (height - 2) * (mode === "truecolor" ? 2 : 1)),
	)
	const rows = count ? scan.rows.slice(-count) : []
	return (
		<Box flexDirection="column" height={height} paddingLeft={1}>
			<Text color={color ? "cyan" : undefined} dimColor={unverified}>
				{powerRamp(cells, mode === "ascii")}
			</Text>
			{height > 1 ? <Text>{spectrumMaskCells(last.frame, width)}</Text> : null}
			{mode === "truecolor"
				? Array.from({ length: Math.ceil(rows.length / 2) }, (_, i) => {
						const top = spectrumCells(
							rows[i * 2]?.bins ?? new Uint8Array(),
							width,
						)
						const bottom = spectrumCells(
							rows[i * 2 + 1]?.bins ?? new Uint8Array(),
							width,
						)
						return (
							<Text key={i} dimColor={unverified}>
								{halfBlockRuns(top, bottom).map((r, j) => (
									<Text
										key={j}
										color={r.foreground}
										backgroundColor={r.background}
									>
										{r.text}
									</Text>
								))}
							</Text>
						)
					})
				: rows.map((r, i) => (
						<Text key={i} dimColor={unverified}>
							{powerRamp(spectrumCells(r.bins, width), mode === "ascii")}
						</Text>
					))}
		</Box>
	)
}

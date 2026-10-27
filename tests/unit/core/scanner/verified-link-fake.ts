import { linkLine } from "../../../mocks/scanner/probe-fakes.js"

/** Synthetic checked voice LC: both target and source, unlike sync-only CC. */
export function verifiedLinkLine(
	...args: Parameters<typeof linkLine>
): ReturnType<typeof linkLine> {
	return { ...linkLine(...args), verified: true, voiceLc: true }
}

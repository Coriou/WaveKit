/** Core's rate reason codes (DecoderRateAssessment.reasonCode) in plain words: one list for the cell and the detail. */
export const RATE_REASON_WORDS: Readonly<Record<string, string>> = {
	"insufficient-sample-rate": "sample rate too low",
	"unsupported-sample-rate": "sample rate not supported",
	"unsupported-input-kind": "input kind not supported",
	"unsupported-input-format": "input format not supported",
	"unsupported-frontend-rate": "front-end rate not supported",
	"unsupported-decoder-input-rate": "decoder input rate not supported",
	"unknown-requirements": "rate requirements not declared",
	"source-rate-unknown": "source rate not known",
	"adaptation-unknown": "rate adaptation not known",
	"external-input": "external input",
}

export const isRateReason = (code: string): boolean =>
	Object.hasOwn(RATE_REASON_WORDS, code)

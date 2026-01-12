import type { DecoderOutput } from "./decoders.js"

export interface DecoderOutputMessage {
	decoderId: string
	output: DecoderOutput
}

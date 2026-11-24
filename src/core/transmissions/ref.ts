/**
 * A transmission reference as a route takes it: a txId, or an alias of one of its artefacts
 * (`rec:<recording key>`, `evt:<Activity event id>`, `obs:<observation id>`), the same grammar
 * as the web's parseRef plus `tx_`. 520 characters: the 4-character prefix + 512 + room.
 */
import { z } from "zod"

export const TRANSMISSION_REF_MAX = 520

export const TransmissionRefSchema = z
	.string()
	.max(TRANSMISSION_REF_MAX)
	.regex(/^(tx_[0-9A-HJKMNP-TV-Z]{26}|(rec|evt|obs):[^\s]{1,512})$/)

export type TransmissionRefText = z.infer<typeof TransmissionRefSchema>

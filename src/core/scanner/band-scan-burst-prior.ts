import type { ScannerProtocol } from "./types.js"

type Priors = Partial<Record<ScannerProtocol, number>>

/**
 * WG11 req 1.4: the ISM prior of the live classifier context when the job says nothing at the
 * frequency.
 *
 * `classifySpectral` calls a track of at most 4 blocks an ISM burst (`ook-burst`, no probe mode)
 * unless the `ism` prior is below 1. A sweep decides at the end of its dwell, 3 blocks after the
 * settle at the defaults, so every track it can probe is that young. A job whose ranges list no
 * protocols at the frequency (an operator range no built-in plan encloses, such as 135-174 MHz)
 * and that names no protocols left `ism` unset (= 1): every land-mobile track of such a sweep was
 * an ISM burst and was never probed.
 *
 * Only then does the band plan's `ism` prior at the frequency (the priors identify uses) fill it.
 * Every other prior and every job-set prior is unchanged, and so is the result when the band plan
 * says nothing there. `ism` is read by the burst rule and the `ook-burst` hypotheses only, so no
 * other class or hypothesis score changes.
 */
export function withBandBurstPrior(
	ctx: {
		readonly priors: Priors
		/** The job's effective protocols at the frequency (empty: every protocol). */
		readonly protocols: readonly ScannerProtocol[]
		/** True when an enabled job range at the frequency lists protocols. */
		readonly rangesListProtocols: boolean
	},
	bandPriorsAt: () => Priors,
): Priors {
	if (
		ctx.rangesListProtocols ||
		ctx.protocols.length > 0 ||
		ctx.priors.ism !== undefined
	)
		return ctx.priors
	const ism = bandPriorsAt().ism
	if (ism === undefined || !Number.isFinite(ism) || ism < 0) return ctx.priors
	return { ...ctx.priors, ism }
}

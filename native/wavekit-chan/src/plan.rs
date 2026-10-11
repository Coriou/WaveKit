//! Chain planner (plan assumption A5): decimate-by-2 stages while the next rate stays at least
//! 1.1 × the output rate, then one rational L/M stage, split into two rational stages when one
//! prototype would exceed `MAX_PROTOTYPE_TAPS`.

use crate::design::{
    check_cancel, kaiser_len, kaiser_len_checked, lowpass, lowpass_bounded, DESIGN_ATTENUATION_DB,
};
use std::sync::atomic::AtomicBool;

pub const HALFBAND_MIN_RATIO: f64 = 1.1;
pub const MAX_PROTOTYPE_TAPS: usize = 16_384;

/// Slack, in Hz, on the `bw/2 + tr <= out/2` boundary (addendum §12.2). The §2 default passband
/// (bw = out·(1−t), tr = out·t/2) can round one ulp past out/2. Task 14's `admission.rs` must
/// import this constant (and Task 16's `admission.ts` use the same value) so the planner never
/// rejects a channel admission accepted.
pub const ADMISSION_EPSILON_HZ: f64 = 1e-6;

/// One L/M stage. Rates are in Hz; `pass_hz`/`stop_hz` are the prototype's band edges.
#[derive(Debug, Clone, PartialEq)]
pub struct StageSpec {
    pub l: usize,
    pub m: usize,
    pub in_rate: f64,
    pub out_rate: f64,
    pub pass_hz: f64,
    pub stop_hz: f64,
}

/// A planned stage with its prototype. The planner builds every prototype to check the tap
/// budget, so it hands them on and `ChannelDsp` never designs a filter a second time.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedStage {
    pub spec: StageSpec,
    pub prototype: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ChainPlan {
    pub stages: Vec<PlannedStage>,
}

/// The stage's prototype, designed at the upsampled rate `L × in_rate` with DC gain L
/// (`RationalFir` does not apply the interpolation gain itself).
pub fn design_stage(s: &StageSpec) -> Vec<f32> {
    let proto_rate = s.l as f64 * s.in_rate;
    lowpass(
        (s.pass_hz + s.stop_hz) / 2.0 / proto_rate,
        (s.stop_hz - s.pass_hz) / proto_rate,
        s.l as f64,
    )
}

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 {
        a
    } else {
        gcd(b, a % b)
    }
}

const MAX_FACTOR_STEPS: usize = 1_000_000;
const MAX_CANDIDATE_PAIRS: usize = 65_536;
const MAX_CANDIDATES: usize = 4_096;
const MAX_BUILD_ATTEMPTS: usize = 128;
const MAX_PHASES: usize = 16_384;
// ceil(prototype_len / L) * L <= prototype_len + L - 1.
const MAX_PHASE_PAYLOAD: usize = 2 * MAX_PROTOTYPE_TAPS;

/// A single request's budget, shared across both factorisations and all prototype builds.
struct Planner<'a> {
    cancel: Option<&'a AtomicBool>,
    factor_steps: usize,
    pairs: usize,
    builds: usize,
}

impl<'a> Planner<'a> {
    fn new(cancel: Option<&'a AtomicBool>) -> Self {
        Self {
            cancel,
            factor_steps: 0,
            pairs: 0,
            builds: 0,
        }
    }

    fn check(&self) -> Result<(), String> {
        check_cancel(self.cancel)
    }

    fn count(
        cancel: Option<&AtomicBool>,
        count: &mut usize,
        limit: usize,
        name: &str,
    ) -> Result<(), String> {
        check_cancel(cancel)?;
        if cancel.is_some() {
            if *count >= limit {
                return Err(format!("{name} limit {limit} exceeded"));
            }
            *count += 1;
        }
        Ok(())
    }

    fn divisors(&mut self, n: usize) -> Result<Vec<usize>, String> {
        self.check()?;
        let mut result = Vec::new();
        let mut d = 1;
        while d <= n / d {
            Self::count(
                self.cancel,
                &mut self.factor_steps,
                MAX_FACTOR_STEPS,
                "factor trial steps",
            )?;
            if n.is_multiple_of(d) {
                self.check()?;
                result.push(d);
                if d != n / d {
                    result.push(n / d);
                }
            }
            d += 1;
        }
        result.sort_unstable();
        Ok(result)
    }

    fn retain(
        &self,
        candidates: &mut Vec<(f64, StageSpec, StageSpec)>,
        candidate: (f64, StageSpec, StageSpec),
    ) -> Result<(), String> {
        self.check()?;
        if self.cancel.is_some() && candidates.len() >= MAX_CANDIDATES {
            return Err(format!(
                "retained candidates limit {MAX_CANDIDATES} exceeded"
            ));
        }
        candidates.push(candidate);
        Ok(())
    }

    fn estimate(&self, s: &StageSpec) -> Result<usize, String> {
        self.check()?;
        if self.cancel.is_none() {
            return Ok(estimate_len(s));
        }
        let proto_rate = s.l as f64 * s.in_rate;
        let cutoff = (s.pass_hz + s.stop_hz) / 2.0 / proto_rate;
        if !proto_rate.is_finite()
            || proto_rate <= 0.0
            || !cutoff.is_finite()
            || cutoff <= 0.0
            || cutoff >= 0.5
        {
            return Err(format!(
                "invalid effective cutoff {cutoff} at prototype rate {proto_rate}"
            ));
        }
        match kaiser_len_checked((s.stop_hz - s.pass_hz) / proto_rate, MAX_PROTOTYPE_TAPS) {
            Ok(n) => Ok(n),
            // Oversized stages may still have a feasible split; no cast/allocation is needed.
            Err(reason) if reason.starts_with("prototype tap limit") => Ok(MAX_PROTOTYPE_TAPS + 1),
            Err(reason) => Err(reason),
        }
    }

    fn build(&mut self, s: StageSpec) -> Result<Option<PlannedStage>, String> {
        self.check()?;
        if self.estimate(&s)? > MAX_PROTOTYPE_TAPS || (self.cancel.is_some() && s.l > MAX_PHASES) {
            return Ok(None);
        }
        Self::count(
            self.cancel,
            &mut self.builds,
            MAX_BUILD_ATTEMPTS,
            "prototype build attempts",
        )?;
        let prototype = if let Some(cancel) = self.cancel {
            let proto_rate = s.l as f64 * s.in_rate;
            match lowpass_bounded(
                (s.pass_hz + s.stop_hz) / 2.0 / proto_rate,
                (s.stop_hz - s.pass_hz) / proto_rate,
                s.l as f64,
                MAX_PROTOTYPE_TAPS,
                cancel,
            ) {
                Ok(p) => p,
                Err(reason) if reason.starts_with("prototype tap limit") => return Ok(None),
                Err(reason) => return Err(reason),
            }
        } else {
            design_stage(&s)
        };
        if self.cancel.is_some() {
            let payload = prototype
                .len()
                .div_ceil(s.l)
                .checked_mul(s.l)
                .ok_or_else(|| "padded phase payload overflow".to_string())?;
            if payload > MAX_PHASE_PAYLOAD {
                return Err(format!(
                    "padded phase payload limit {MAX_PHASE_PAYLOAD} exceeded ({payload})"
                ));
            }
        }
        Ok((prototype.len() <= MAX_PROTOTYPE_TAPS).then_some(PlannedStage { spec: s, prototype }))
    }
}

/// Kaiser's length estimate. `lowpass` starts there and only grows, so it is a lower bound on
/// the built prototype: good for ranking and for ruling a stage out, never for admitting one.
fn estimate_len(s: &StageSpec) -> usize {
    kaiser_len(
        DESIGN_ATTENUATION_DB,
        (s.stop_hz - s.pass_hz) / (s.l as f64 * s.in_rate),
    )
}

/// Intermediate stages keep [-(bw/2+tr), bw/2+tr] alias-free (stop = out_rate − bw/2 − tr);
/// the final stage defines the channel (stop = bw/2 + tr). See plan assumption A5.
pub fn plan_chain(fs: u64, out: u64, bw: f64, tr: f64) -> Result<ChainPlan, String> {
    plan_chain_impl(fs, out, bw, tr, &mut Planner::new(None))
}

/// Worker-only planner with bounded work/allocation and cooperative cancellation.
pub(crate) fn plan_chain_bounded(
    fs: u64,
    out: u64,
    bw: f64,
    tr: f64,
    cancel: &AtomicBool,
) -> Result<ChainPlan, String> {
    plan_chain_impl(fs, out, bw, tr, &mut Planner::new(Some(cancel)))
}

fn plan_chain_impl(
    fs: u64,
    out: u64,
    bw: f64,
    tr: f64,
    planner: &mut Planner<'_>,
) -> Result<ChainPlan, String> {
    planner.check()?;
    if out == 0 || out > fs {
        return Err(format!("output rate {out} must be within 1..={fs}"));
    }
    let (pass, guard) = (bw / 2.0, bw / 2.0 + tr);
    if !(bw > 0.0 && tr > 0.0 && guard <= out as f64 / 2.0 + ADMISSION_EPSILON_HZ)
        || (planner.cancel.is_some() && (!bw.is_finite() || !tr.is_finite()))
    {
        return Err(format!(
            "bandwidth {bw} and transition {tr} must be positive with bw/2 + tr <= {}",
            out as f64 / 2.0
        ));
    }
    if out == fs {
        return Ok(ChainPlan { stages: vec![] });
    }
    let mut stages = Vec::new();
    let mut r = fs;
    while r.is_multiple_of(2) && (r / 2) as f64 >= out as f64 * HALFBAND_MIN_RATIO {
        planner.check()?;
        let spec = StageSpec {
            l: 1,
            m: 2,
            in_rate: r as f64,
            out_rate: (r / 2) as f64,
            pass_hz: pass,
            stop_hz: (r / 2) as f64 - guard,
        };
        let stage = if planner.cancel.is_some() {
            planner.build(spec)?.ok_or_else(|| {
                format!("halfband prototype or phase resource limit exceeded for {fs}->{out}")
            })?
        } else {
            PlannedStage {
                prototype: design_stage(&spec),
                spec,
            }
        };
        planner.check()?;
        stages.push(stage);
        r /= 2;
    }
    let g = gcd(out, r);
    let (l, m) = if planner.cancel.is_some() {
        (
            usize::try_from(out / g)
                .map_err(|_| "interpolation factor exceeds usize".to_string())?,
            usize::try_from(r / g).map_err(|_| "decimation factor exceeds usize".to_string())?,
        )
    } else {
        ((out / g) as usize, (r / g) as usize)
    };
    let last = StageSpec {
        l,
        m,
        in_rate: r as f64,
        out_rate: out as f64,
        pass_hz: pass,
        stop_hz: guard,
    };
    if let Some(last) = planner.build(last)? {
        planner.check()?;
        stages.push(last);
        return Ok(ChainPlan { stages });
    }
    // Split L/M into (l1/m1)·(l2/m2) with an intermediate rate in [1.1 × out, r). Candidates are
    // ranked on the Kaiser estimate; only the cheapest ones are built to check the budget.
    let mut candidates = Vec::new();
    planner.check()?;
    let ls = planner.divisors(l)?;
    let ms = planner.divisors(m)?;
    for l1 in ls {
        for &m1 in &ms {
            Planner::count(
                planner.cancel,
                &mut planner.pairs,
                MAX_CANDIDATE_PAIRS,
                "examined candidate pairs",
            )?;
            let r1 = r as f64 * l1 as f64 / m1 as f64;
            if !(r1 < r as f64 && r1 >= out as f64 * HALFBAND_MIN_RATIO) {
                continue;
            }
            let a = StageSpec {
                l: l1,
                m: m1,
                in_rate: r as f64,
                out_rate: r1,
                pass_hz: pass,
                stop_hz: r1 - guard,
            };
            let b = StageSpec {
                l: l / l1,
                m: m / m1,
                in_rate: r1,
                out_rate: out as f64,
                pass_hz: pass,
                stop_hz: guard,
            };
            let na = planner.estimate(&a)?;
            if na > MAX_PROTOTYPE_TAPS {
                continue;
            }
            let nb = planner.estimate(&b)?;
            if nb > MAX_PROTOTYPE_TAPS
                || (planner.cancel.is_some() && (a.l > MAX_PHASES || b.l > MAX_PHASES))
            {
                continue;
            }
            let cost = a.out_rate * na as f64 / a.l as f64 + b.out_rate * nb as f64 / b.l as f64;
            planner.retain(&mut candidates, (cost, a, b))?;
        }
    }
    planner.check()?;
    candidates.sort_by(|x, y| x.0.total_cmp(&y.0));
    let mut chosen = None;
    for (_, a, b) in candidates {
        planner.check()?;
        if let Some(a) = planner.build(a)? {
            if let Some(b) = planner.build(b)? {
                chosen = Some((a, b));
                break;
            }
        }
    }
    let (a, b) = chosen.ok_or_else(|| {
        if planner.cancel.is_some() {
            format!(
                "no feasible rational split for {fs}->{out} within prototype/phase resource limits"
            )
        } else {
            format!("no feasible rational split for {fs}->{out}")
        }
    })?;
    planner.check()?;
    stages.push(a);
    stages.push(b);
    Ok(ChainPlan { stages })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_planner_matches_reference_prototype_bits() {
        let cancel = AtomicBool::new(false);
        for fs in [2_048_000, 2_400_000] {
            for out in [24_000, 48_000, 250_000, 384_000, 1_000_000, 1_050_000] {
                // Default plus a wider transition, including admission's one-ulp overshoot.
                for t in [0.05, 0.18] {
                    let (bw, tr) = (out as f64 * (1.0 - t), out as f64 * t / 2.0);
                    let reference = plan_chain(fs, out, bw, tr).unwrap();
                    let bounded = plan_chain_bounded(fs, out, bw, tr, &cancel).unwrap();
                    assert_eq!(reference.stages.len(), bounded.stages.len());
                    for (a, b) in reference.stages.iter().zip(&bounded.stages) {
                        assert_eq!(a.spec, b.spec, "{fs}->{out}, t={t}");
                        assert_eq!(
                            a.prototype.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                            b.prototype.iter().map(|v| v.to_bits()).collect::<Vec<_>>(),
                            "{fs}->{out}, t={t}"
                        );
                        assert!(b.prototype.len() <= MAX_PROTOTYPE_TAPS);
                        assert!(b.spec.l <= MAX_PHASES);
                        assert!(
                            b.prototype.len().div_ceil(b.spec.l) * b.spec.l <= MAX_PHASE_PAYLOAD
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn sorted_sqrt_divisors_preserve_nested_candidate_order() {
        let mut planner = Planner::new(None);
        for n in [1usize, 2, 16, 36, 125, 256, 525, 1024] {
            let old: Vec<_> = (1..=n).filter(|d| n.is_multiple_of(*d)).collect();
            assert_eq!(planner.divisors(n).unwrap(), old);
        }
        let ls = planner.divisors(36).unwrap();
        let ms = planner.divisors(16).unwrap();
        let actual: Vec<_> = ls
            .iter()
            .flat_map(|&l| ms.iter().map(move |&m| (l, m)))
            .collect();
        let expected: Vec<_> = (1..=36usize)
            .filter(|d| 36usize.is_multiple_of(*d))
            .flat_map(|l| {
                (1..=16usize)
                    .filter(|d| 16usize.is_multiple_of(*d))
                    .map(move |m| (l, m))
            })
            .collect();
        assert_eq!(actual, expected);
    }

    #[test]
    fn bounded_cancellation_precedes_identity_and_factorisation() {
        let cancel = AtomicBool::new(true);
        for out in [48_000, 2_048_000] {
            assert_eq!(
                plan_chain_bounded(
                    2_048_000,
                    out,
                    out as f64 * 0.95,
                    out as f64 * 0.025,
                    &cancel
                )
                .unwrap_err(),
                "channel preparation cancelled"
            );
        }
        assert_eq!(
            Planner::new(Some(&cancel)).divisors(1024).unwrap_err(),
            "channel preparation cancelled"
        );
    }

    #[test]
    fn bounded_rejects_extreme_widths_without_overflow() {
        let cancel = AtomicBool::new(false);
        for (bw, tr) in [
            (f64::INFINITY, 1.0),
            (1.0, f64::INFINITY),
            (f64::NAN, 1.0),
            (1.0, f64::NAN),
            (40_000.0, f64::MIN_POSITIVE),
            (40_000.0, f64::from_bits(1)),
        ] {
            assert!(plan_chain_bounded(2_048_000, 48_000, bw, tr, &cancel).is_err());
        }
        // Tiny user transition does not make an intermediate halfband's clearance tiny.
        let s = StageSpec {
            l: 1,
            m: 2,
            in_rate: 2_048_000.0,
            out_rate: 1_024_000.0,
            pass_hz: 20_000.0,
            stop_hz: 1_004_000.0,
        };
        assert!(Planner::new(Some(&cancel)).build(s).unwrap().is_some());
    }

    #[test]
    fn bounded_factor_budget_is_total_and_checked_before_next_trial() {
        let cancel = AtomicBool::new(false);
        let mut planner = Planner::new(Some(&cancel));
        planner.factor_steps = MAX_FACTOR_STEPS - 2;
        assert_eq!(planner.divisors(4).unwrap(), vec![1, 2, 4]);
        assert_eq!(planner.factor_steps, MAX_FACTOR_STEPS);
        assert!(planner
            .divisors(1)
            .unwrap_err()
            .contains("factor trial steps limit"));
        let mut planner = Planner::new(Some(&cancel));
        assert!(planner
            .divisors(1_000_002usize * 1_000_002)
            .unwrap_err()
            .contains("factor trial steps limit"));
    }

    #[test]
    fn bounded_retained_candidates_are_counted_before_insertion() {
        let cancel = AtomicBool::new(false);
        let planner = Planner::new(Some(&cancel));
        let s = StageSpec {
            l: 1,
            m: 2,
            in_rate: 100.0,
            out_rate: 50.0,
            pass_hz: 10.0,
            stop_hz: 20.0,
        };
        let candidate = (1.0, s.clone(), s);
        let mut candidates = Vec::new();
        for _ in 0..MAX_CANDIDATES {
            planner.retain(&mut candidates, candidate.clone()).unwrap();
        }
        assert!(planner
            .retain(&mut candidates, candidate)
            .unwrap_err()
            .contains("retained candidates limit"));
        assert_eq!(candidates.len(), MAX_CANDIDATES);
        assert_eq!(candidates.capacity(), MAX_CANDIDATES);
    }

    #[test]
    fn bounded_pair_and_build_limits_apply_to_the_whole_request() {
        let cancel = AtomicBool::new(false);
        let mut planner = Planner::new(Some(&cancel));
        planner.pairs = MAX_CANDIDATE_PAIRS;
        assert!(
            plan_chain_impl(2_048_000, 1_000_000, 950_000.0, 25_000.0, &mut planner)
                .unwrap_err()
                .contains("examined candidate pairs limit")
        );
        let mut planner = Planner::new(Some(&cancel));
        planner.builds = MAX_BUILD_ATTEMPTS;
        assert!(
            plan_chain_impl(2_048_000, 48_000, 45_600.0, 1_200.0, &mut planner)
                .unwrap_err()
                .contains("prototype build attempts limit")
        );
        let s = StageSpec {
            l: MAX_PHASES + 1,
            m: 1,
            in_rate: 1.0,
            out_rate: 1.0,
            pass_hz: 100.0,
            stop_hz: 6_000.0,
        };
        assert!(Planner::new(Some(&cancel)).build(s).unwrap().is_none());
    }

    fn halfbands(p: &ChainPlan) -> usize {
        p.stages
            .iter()
            .filter(|s| s.spec.l == 1 && s.spec.m == 2)
            .count()
    }

    fn ratio(p: &ChainPlan) -> f64 {
        p.stages
            .iter()
            .map(|s| s.spec.l as f64 / s.spec.m as f64)
            .product()
    }

    #[test]
    fn stage_counts_match_research_table() {
        let d = |out: u64| (out as f64 * 0.95, out as f64 * 0.025);
        // Research [3] table, plus 1 MHz (rtl_433's real default output rate, ruling PF2).
        for &(fs, out, hb) in &[
            (2_048_000, 48_000, 5),
            (2_048_000, 24_000, 6),
            (2_048_000, 384_000, 2),
            (2_048_000, 250_000, 2),
            (2_048_000, 1_000_000, 0),
            (2_048_000, 1_050_000, 0),
            (2_400_000, 48_000, 5),
            (2_400_000, 24_000, 6),
            (2_400_000, 384_000, 2),
            (2_400_000, 250_000, 3),
            (2_400_000, 1_000_000, 1),
            (2_400_000, 1_050_000, 1),
        ] {
            let (bw, tr) = d(out);
            let p = plan_chain(fs, out, bw, tr).unwrap();
            assert_eq!(halfbands(&p), hb, "{fs}->{out}");
            assert!(
                (ratio(&p) - out as f64 / fs as f64).abs() < 1e-12,
                "{fs}->{out} exact ratio"
            );
            for PlannedStage { spec: s, prototype } in &p.stages {
                let n = crate::design::kaiser_len(
                    crate::design::DESIGN_ATTENUATION_DB,
                    (s.stop_hz - s.pass_hz) / (s.l as f64 * s.in_rate),
                );
                assert!(n <= MAX_PROTOTYPE_TAPS, "{fs}->{out} prototype {n}");
                // The budget holds for the prototype actually built, not just Kaiser's estimate.
                let built = prototype.len();
                assert!(built <= MAX_PROTOTYPE_TAPS, "{fs}->{out} built {built}");
                // The carried prototype is the stage's design, so `ChannelDsp` can use it as is.
                assert_eq!(prototype, &design_stage(s), "{fs}->{out}");
            }
        }
    }

    #[test]
    fn splits_525_over_1024_into_two_rational_stages() {
        let p = plan_chain(2_048_000, 1_050_000, 997_500.0, 26_250.0).unwrap();
        assert_eq!(p.stages.len(), 2);
        assert!(p.stages[0].spec.out_rate >= 1_050_000.0 * HALFBAND_MIN_RATIO);
    }

    #[test]
    fn splits_125_over_256_into_two_rational_stages() {
        // 2.048 Msps -> 1 MHz (ruling PF2): one 125/256 prototype would need ~41 000 taps.
        let p = plan_chain(2_048_000, 1_000_000, 950_000.0, 25_000.0).unwrap();
        assert_eq!(p.stages.len(), 2);
        assert!(p.stages[0].spec.out_rate >= 1_000_000.0 * HALFBAND_MIN_RATIO);
        assert_eq!(p.stages[1].spec.out_rate, 1_000_000.0);
    }

    #[test]
    fn identity_when_rates_match() {
        assert!(plan_chain(2_048_000, 2_048_000, 1_900_000.0, 50_000.0)
            .unwrap()
            .stages
            .is_empty());
    }

    #[test]
    fn rejects_unrealisable_requests() {
        assert!(plan_chain(2_048_000, 0, 1_000.0, 100.0).is_err());
        assert!(plan_chain(2_048_000, 2_400_000, 1_000.0, 100.0).is_err());
        // The channel's stopband edge must fit under the output Nyquist (addendum §12.2).
        assert!(plan_chain(2_048_000, 48_000, 48_000.0, 1_000.0).is_err());
        assert!(plan_chain(2_048_000, 48_000, 0.0, 1_000.0).is_err());
        assert!(plan_chain(2_048_000, 48_000, 40_000.0, 0.0).is_err());
        // Beyond the admission epsilon.
        assert!(plan_chain(2_048_000, 250_000, 230_000.0, 10_001.0).is_err());
    }

    #[test]
    fn accepts_the_default_passband_rounding_overshoot() {
        // §2 default passband at t = 0.18: guard = 125 000.000…01, one ulp over out/2.
        // Admission accepts it (ADMISSION_EPSILON_HZ), so the planner must too.
        let (out, t) = (250_000u64, 0.18);
        let (bw, tr) = (out as f64 * (1.0 - t), out as f64 * t / 2.0);
        assert!(bw / 2.0 + tr > out as f64 / 2.0, "the case must overshoot");
        assert!(plan_chain(2_048_000, out, bw, tr).is_ok());
        for &(out, t) in &[(1_000_000u64, 0.41), (2_048_000, 0.42), (250_000, 0.43)] {
            let (bw, tr) = (out as f64 * (1.0 - t), out as f64 * t / 2.0);
            assert!(plan_chain(2_048_000, out, bw, tr).is_ok(), "{out} t={t}");
        }
    }
}

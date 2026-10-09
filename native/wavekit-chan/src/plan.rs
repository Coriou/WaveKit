//! Chain planner (plan assumption A5): decimate-by-2 stages while the next rate stays at least
//! 1.1 × the output rate, then one rational L/M stage, split into two rational stages when one
//! prototype would exceed `MAX_PROTOTYPE_TAPS`.

use crate::design::{kaiser_len, lowpass, DESIGN_ATTENUATION_DB};

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

fn divisors(n: usize) -> Vec<usize> {
    (1..=n).filter(|d| n.is_multiple_of(*d)).collect()
}

/// Kaiser's length estimate. `lowpass` starts there and only grows, so it is a lower bound on
/// the built prototype: good for ranking and for ruling a stage out, never for admitting one.
fn estimate_len(s: &StageSpec) -> usize {
    kaiser_len(
        DESIGN_ATTENUATION_DB,
        (s.stop_hz - s.pass_hz) / (s.l as f64 * s.in_rate),
    )
}

/// The stage's prototype when it fits the tap budget. The budget is checked on the prototype
/// `design_stage` actually builds; the estimate only skips designs that cannot fit.
fn build(s: StageSpec) -> Option<PlannedStage> {
    if estimate_len(&s) > MAX_PROTOTYPE_TAPS {
        return None;
    }
    let prototype = design_stage(&s);
    (prototype.len() <= MAX_PROTOTYPE_TAPS).then_some(PlannedStage { spec: s, prototype })
}

/// Multiply-accumulates per second: each output costs one polyphase branch of len/L taps.
fn cost(s: &StageSpec) -> f64 {
    s.out_rate * estimate_len(s) as f64 / s.l as f64
}

/// Intermediate stages keep [-(bw/2+tr), bw/2+tr] alias-free (stop = out_rate − bw/2 − tr);
/// the final stage defines the channel (stop = bw/2 + tr). See plan assumption A5.
pub fn plan_chain(fs: u64, out: u64, bw: f64, tr: f64) -> Result<ChainPlan, String> {
    if out == 0 || out > fs {
        return Err(format!("output rate {out} must be within 1..={fs}"));
    }
    let (pass, guard) = (bw / 2.0, bw / 2.0 + tr);
    if !(bw > 0.0 && tr > 0.0 && guard <= out as f64 / 2.0 + ADMISSION_EPSILON_HZ) {
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
        let spec = StageSpec {
            l: 1,
            m: 2,
            in_rate: r as f64,
            out_rate: (r / 2) as f64,
            pass_hz: pass,
            stop_hz: (r / 2) as f64 - guard,
        };
        stages.push(PlannedStage {
            prototype: design_stage(&spec),
            spec,
        });
        r /= 2;
    }
    let g = gcd(out, r);
    let (l, m) = ((out / g) as usize, (r / g) as usize);
    let last = StageSpec {
        l,
        m,
        in_rate: r as f64,
        out_rate: out as f64,
        pass_hz: pass,
        stop_hz: guard,
    };
    if let Some(last) = build(last) {
        stages.push(last);
        return Ok(ChainPlan { stages });
    }
    // Split L/M into (l1/m1)·(l2/m2) with an intermediate rate in [1.1 × out, r). Candidates are
    // ranked on the Kaiser estimate; only the cheapest ones are built to check the budget.
    let mut candidates = Vec::new();
    for l1 in divisors(l) {
        for m1 in divisors(m) {
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
            if estimate_len(&a) > MAX_PROTOTYPE_TAPS || estimate_len(&b) > MAX_PROTOTYPE_TAPS {
                continue;
            }
            candidates.push((cost(&a) + cost(&b), a, b));
        }
    }
    candidates.sort_by(|x, y| x.0.total_cmp(&y.0));
    let (a, b) = candidates
        .into_iter()
        .find_map(|(_, a, b)| Some((build(a)?, build(b)?)))
        .ok_or_else(|| format!("no feasible rational split for {fs}->{out}"))?;
    stages.push(a);
    stages.push(b);
    Ok(ChainPlan { stages })
}

#[cfg(test)]
mod tests {
    use super::*;

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

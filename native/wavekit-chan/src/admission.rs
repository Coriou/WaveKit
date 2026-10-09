//! Channel admission (addendum §6, §12.2). Same arithmetic order as Task 16's
//! `src/core/channelizer/admission.ts`, so Node and the process agree (Property 1).

/// The planner's boundary slack, re-exported: one constant, so admission and `plan_chain` never
/// disagree on a request exactly at `bw/2 + tr = out/2` (Review Focus 1).
pub use crate::plan::ADMISSION_EPSILON_HZ;

#[derive(Debug, Clone, PartialEq)]
pub struct Reject {
    pub code: &'static str,
    pub detail: String,
}

fn invalid(detail: String) -> Reject {
    Reject {
        code: "channel-request-invalid",
        detail,
    }
}

/// Admits iff `bw/2 + tr <= out/2` and `|center - capture_center| + bw/2 + tr <= fs·f/2`, each
/// with `ADMISSION_EPSILON_HZ` of slack. Returns the channel's offset from the capture centre.
pub fn admit(
    center: f64,
    bw: f64,
    tr: f64,
    out: u64,
    fs: u64,
    capture_center: f64,
    f: f64,
) -> Result<f64, Reject> {
    if !(center.is_finite() && bw.is_finite() && tr.is_finite() && capture_center.is_finite()) {
        return Err(invalid("non-finite request".into()));
    }
    if bw <= 0.0 || tr <= 0.0 || out == 0 || out > fs {
        return Err(invalid(format!(
            "bandwidth/transition must be > 0 and output rate within 1..={fs}"
        )));
    }
    let half_occupied = bw / 2.0 + tr;
    if half_occupied > out as f64 / 2.0 + ADMISSION_EPSILON_HZ {
        return Err(invalid(format!(
            "bw/2+tr={half_occupied} exceeds out/2={}",
            out as f64 / 2.0
        )));
    }
    let offset = center - capture_center;
    let limit = fs as f64 * f / 2.0;
    if offset.abs() + half_occupied > limit + ADMISSION_EPSILON_HZ {
        return Err(Reject {
            code: "channel-outside-capture",
            detail: format!(
                "|Δf|+bw/2+tr={} exceeds usable half-span {limit}",
                offset.abs() + half_occupied
            ),
        });
    }
    Ok(offset)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plan::plan_chain;
    use proptest::prelude::*;

    const FS: u64 = 2_048_000;
    const CAPTURE: f64 = 162e6;

    // Feature: core-channelizer, Property 2: Admission rule
    // Validates: addendum §6, §12.2
    #[test]
    fn default_request_on_the_boundary_is_admitted() {
        // Review Focus 1
        let out = 48_000u64;
        let (bw, tr) = (out as f64 * (1.0 - 0.05), out as f64 * 0.05 / 2.0);
        assert!(admit(162e6, bw, tr, out, 2_048_000, 162e6, 0.8).is_ok());
    }

    #[test]
    fn outside_and_invalid() {
        assert_eq!(
            admit(
                162e6 + 900_000.0,
                45_600.0,
                1_200.0,
                48_000,
                2_048_000,
                162e6,
                0.8
            )
            .unwrap_err()
            .code,
            "channel-outside-capture"
        );
        assert_eq!(
            admit(162e6, 50_000.0, 1_200.0, 48_000, 2_048_000, 162e6, 0.8)
                .unwrap_err()
                .code,
            "channel-request-invalid"
        );
        assert_eq!(
            admit(f64::NAN, 1.0, 1.0, 48_000, 2_048_000, 162e6, 0.8)
                .unwrap_err()
                .code,
            "channel-request-invalid"
        );
        assert_eq!(
            admit(162e6, 1.0, 1.0, 3_000_000, 2_048_000, 162e6, 0.8)
                .unwrap_err()
                .code,
            "channel-request-invalid"
        );
    }

    #[test]
    fn epsilon_is_the_planners_constant() {
        // One constant, so admission and plan_chain can never disagree on the boundary.
        assert_eq!(
            ADMISSION_EPSILON_HZ.to_bits(),
            crate::plan::ADMISSION_EPSILON_HZ.to_bits()
        );
        assert_eq!(ADMISSION_EPSILON_HZ, 1e-6);
    }

    #[test]
    fn default_passband_rounding_overshoot_is_admitted_and_planned() {
        // §2 default passband at t = 0.18 for a 250 kHz channel. Written with the literal 0.82 it
        // lands exactly on out/2; computed as out·(1−t), as the request builder does, it lands one
        // ulp over. Both must be admitted, and planned.
        let out = 250_000u64;
        let (bw, tr) = (250_000.0 * 0.82, 250_000.0 * 0.18 / 2.0);
        assert_eq!(admit(CAPTURE, bw, tr, out, FS, CAPTURE, 0.8), Ok(0.0));
        assert!(plan_chain(FS, out, bw, tr).is_ok());
        let (bw, tr) = (out as f64 * (1.0 - 0.18), out as f64 * 0.18 / 2.0);
        assert!(bw / 2.0 + tr > out as f64 / 2.0, "the case must overshoot");
        assert_eq!(admit(CAPTURE, bw, tr, out, FS, CAPTURE, 0.8), Ok(0.0));
        assert!(plan_chain(FS, out, bw, tr).is_ok());
        for &(out, t) in &[(1_000_000u64, 0.41), (2_048_000, 0.42), (250_000, 0.43)] {
            let (bw, tr) = (out as f64 * (1.0 - t), out as f64 * t / 2.0);
            // The rate rule admits these; only the capture span may still refuse the widest one.
            let verdict = admit(CAPTURE, bw, tr, out, FS, CAPTURE, 0.95).map_err(|r| r.code);
            assert_ne!(verdict, Err("channel-request-invalid"), "{out} t={t}");
            assert!(plan_chain(FS, out, bw, tr).is_ok(), "{out} t={t}");
        }
    }

    #[test]
    fn beyond_the_epsilon_is_invalid() {
        let r = admit(CAPTURE, 230_000.0, 10_001.0, 250_000, FS, CAPTURE, 0.8).unwrap_err();
        assert_eq!(r.code, "channel-request-invalid");
        assert!(plan_chain(FS, 250_000, 230_000.0, 10_001.0).is_err());
    }

    #[test]
    fn rejects_non_positive_and_zero_rate() {
        for (bw, tr, out) in [
            (0.0, 1_200.0, 48_000),
            (-1.0, 1_200.0, 48_000),
            (45_600.0, 0.0, 48_000),
            (45_600.0, -1.0, 48_000),
            (45_600.0, 1_200.0, 0),
        ] {
            let r = admit(CAPTURE, bw, tr, out, FS, CAPTURE, 0.8).unwrap_err();
            assert_eq!(r.code, "channel-request-invalid", "{bw} {tr} {out}");
        }
        for (c, bw, tr, cap) in [
            (f64::INFINITY, 1.0, 1.0, CAPTURE),
            (CAPTURE, f64::NAN, 1.0, CAPTURE),
            (CAPTURE, 1.0, f64::INFINITY, CAPTURE),
            (CAPTURE, 1.0, 1.0, f64::NEG_INFINITY),
        ] {
            let r = admit(c, bw, tr, 48_000, FS, cap, 0.8).unwrap_err();
            assert_eq!(r.code, "channel-request-invalid");
        }
    }

    #[test]
    fn capture_edge_is_inclusive_and_offset_is_signed() {
        // usable half-span = 2 048 000 × 0.8 / 2 = 819 200 Hz; h = 22 800 + 1 200 = 24 000 Hz.
        let edge = 819_200.0 - 24_000.0;
        assert_eq!(
            admit(CAPTURE + edge, 45_600.0, 1_200.0, 48_000, FS, CAPTURE, 0.8),
            Ok(edge)
        );
        assert_eq!(
            admit(CAPTURE - edge, 45_600.0, 1_200.0, 48_000, FS, CAPTURE, 0.8),
            Ok(-edge)
        );
        let r = admit(
            CAPTURE - edge - 1.0,
            45_600.0,
            1_200.0,
            48_000,
            FS,
            CAPTURE,
            0.8,
        );
        assert_eq!(r.unwrap_err().code, "channel-outside-capture");
    }

    fn arb_fs() -> impl Strategy<Value = u64> {
        prop_oneof![
            Just(2_048_000u64),
            Just(2_400_000u64),
            250_000u64..=3_200_000
        ]
    }

    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        // Feature: core-channelizer, Property 2: Admission rule
        // Validates: addendum §6, §12.2
        #[test]
        fn admitted_iff_both_inequalities_hold(
            fs in arb_fs(),
            f in 0.5f64..=0.95,
            out_frac in 0.001f64..=1.0,
            occ in 0.01f64..=1.2,
            t in 0.01f64..=0.99,
            pos in -1.2f64..=1.2,
            capture_center in 24e6f64..1.7e9,
        ) {
            let out = ((fs as f64 * out_frac) as u64).clamp(1, fs);
            // Half-occupied h = bw/2 + tr = occ × out/2, split by t between passband and skirt.
            let h = occ * out as f64 / 2.0;
            let (bw, tr) = (2.0 * h * (1.0 - t), h * t);
            let center = capture_center + pos * fs as f64 * f / 2.0;
            let verdict = admit(center, bw, tr, out, fs, capture_center, f);

            let half = bw / 2.0 + tr;
            let fits_rate = half <= out as f64 / 2.0 + ADMISSION_EPSILON_HZ;
            let offset = center - capture_center;
            let fits_capture = offset.abs() + half <= fs as f64 * f / 2.0 + ADMISSION_EPSILON_HZ;
            match verdict {
                Ok(o) => {
                    prop_assert!(fits_rate && fits_capture);
                    prop_assert_eq!(o.to_bits(), offset.to_bits());
                }
                Err(r) if !fits_rate => prop_assert_eq!(r.code, "channel-request-invalid"),
                Err(r) => {
                    prop_assert!(!fits_capture);
                    prop_assert_eq!(r.code, "channel-outside-capture");
                }
            }
        }
    }
}

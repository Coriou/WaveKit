/// csdr `convert -i char -o float`: u / (UCHAR_MAX/2.0) - 1.0, computed in f64, stored f32.
pub fn cu8_to_f32(u: u8) -> f32 {
    (u as f64 / 127.5 - 1.0) as f32
}

/// csdr `convert -i float -o char` (x * UCHAR_MAX * 0.5 + 128, truncated) with saturation.
pub fn f32_to_cu8(x: f32, gain: f32) -> (u8, bool) {
    let v = ((x * gain * 255.0f32) as f64) * 0.5 + 128.0;
    let f = v.floor();
    if f < 0.0 {
        (0, true)
    } else if f > 255.0 {
        (255, true)
    } else {
        (f as u8, false)
    }
}

#[derive(Default, Debug)]
pub struct InputAssembler {
    pub consumed_bytes: u64,
    pub carry: Option<u8>,
}

impl InputAssembler {
    pub fn push(&mut self, bytes: &[u8], i: &mut Vec<f32>, q: &mut Vec<f32>) {
        let mut rest = bytes;
        if let Some(first) = self.carry.take() {
            match rest.split_first() {
                Some((&second, tail)) => {
                    i.push(cu8_to_f32(first));
                    q.push(cu8_to_f32(second));
                    self.consumed_bytes += 2;
                    rest = tail;
                }
                None => {
                    self.carry = Some(first);
                    return;
                }
            }
        }
        let (pairs, remainder) = rest.as_chunks::<2>();
        if let [odd] = remainder {
            self.carry = Some(*odd);
        }
        for &[iu, qu] in pairs {
            i.push(cu8_to_f32(iu));
            q.push(cu8_to_f32(qu));
        }
        self.consumed_bytes += (pairs.len() * 2) as u64;
    }
    pub fn discarded(&self) -> u64 {
        self.carry.is_some() as u64
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    // Feature: core-channelizer, Property 7: Pass-through identity (scaling)
    // Validates: addendum §3, §12.7
    #[test]
    fn exact_round_trip_for_every_byte() {
        for u in 0..=255u8 {
            let (back, sat) = f32_to_cu8(cu8_to_f32(u), 1.0);
            assert_eq!(back, u, "byte {u}");
            assert!(!sat);
        }
        assert_eq!(cu8_to_f32(0), -1.0);
        assert_eq!(cu8_to_f32(255), 1.0);
    }
    #[test]
    fn saturates_and_counts() {
        assert_eq!(f32_to_cu8(1.5, 1.0), (255, true));
        assert_eq!(f32_to_cu8(-1.5, 1.0), (0, true));
        assert_eq!(f32_to_cu8(0.5, 3.0), (255, true));
    }
    proptest! {
        #![proptest_config(ProptestConfig::with_cases(100))]
        // Feature: core-channelizer, Property 4: Chunk-split independence (byte level)
        // Validates: addendum §12.4
        #[test]
        fn splits_inside_pairs_do_not_change_samples(data in proptest::collection::vec(any::<u8>(), 0..4096), cuts in proptest::collection::vec(0usize..4096, 0..16)) {
            let (mut wi, mut wq) = (Vec::new(), Vec::new());
            InputAssembler::default().push(&data, &mut wi, &mut wq);
            let mut a = InputAssembler::default();
            let (mut si, mut sq) = (Vec::new(), Vec::new());
            let mut points: Vec<usize> = cuts.into_iter().map(|c| c.min(data.len())).collect();
            points.sort_unstable();
            let mut last = 0;
            for p in points.into_iter().chain(std::iter::once(data.len())) {
                a.push(&data[last..p], &mut si, &mut sq);
                last = p;
            }
            prop_assert_eq!(wi, si);
            prop_assert_eq!(wq, sq);
            prop_assert_eq!(a.discarded(), (data.len() % 2) as u64);
            prop_assert_eq!(a.consumed_bytes, (data.len() / 2 * 2) as u64);
        }
    }
}

//! IQ capture on detection and replay; see `wavekit_chan::iqcap`.

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(wavekit_chan::iqcap::main_entry(&argv));
}

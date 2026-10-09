use wavekit_chan::args::{parse, Command, VERSION_LINE};

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    match parse(&argv) {
        Ok(Command::Version) => println!("{VERSION_LINE}"),
        Ok(Command::Run(args)) => std::process::exit(wavekit_chan::runtime::run(args)),
        Err(e) => {
            eprintln!("wavekit-chan: {e}");
            std::process::exit(2);
        }
    }
}

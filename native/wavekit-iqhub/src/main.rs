use std::io::Write as _;
use wavekit_iqhub::args::{parse, Command, VERSION_LINE};
use wavekit_iqhub::stats::StatsWriter;
use wavekit_iqhub::{io, sys};

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse(&argv) {
        Ok(Command::Version) => {
            // A closed stdout must not turn into a panic.
            let _ = writeln!(std::io::stdout(), "{VERSION_LINE}");
            return;
        }
        Ok(Command::Run(args)) => args,
        Err(e) => {
            sys::log(format_args!("{e}"));
            std::process::exit(2);
        }
    };
    // The control fd first, before this process creates any fd: if the parent did not open
    // it, its number could otherwise be handed to the listener and read as control.
    let control = match sys::take_control_fd(args.control_fd) {
        Ok(fd) => fd,
        Err(e) => {
            sys::log(format_args!("{e}"));
            std::process::exit(2);
        }
    };
    sys::ignore_sigpipe();
    let (listener, path) = match io::listen(&args.socket_dir) {
        Ok(l) => l,
        Err(e) => {
            sys::log(format_args!("{e}"));
            std::process::exit(2);
        }
    };
    let stats = match args.stats_file.as_deref().map(StatsWriter::open) {
        None => None,
        Some(Ok(w)) => Some(w),
        Some(Err(e)) => {
            sys::log(format_args!("{e}"));
            let _ = std::fs::remove_file(&path);
            std::process::exit(2);
        }
    };
    let hub = match io::Io::new(
        control,
        listener,
        path.clone(),
        args.ring_ms,
        args.debug,
        stats,
    ) {
        Ok(h) => h,
        Err(e) => {
            sys::log(format_args!("stdout: {e}"));
            let _ = std::fs::remove_file(&path);
            std::process::exit(2);
        }
    };
    std::process::exit(hub.run());
}

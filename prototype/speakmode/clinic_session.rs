//! Front door for the two clinic audio operations and explicit, local credential enrollment.
#[allow(dead_code)]
#[path = "clinic_turns.rs"]
mod turns;
#[allow(dead_code)]
#[path = "clinic_asr.rs"]
mod asr;

use serde_json::json;
use speakmode_lib::cloud;
use std::{io::{self, IsTerminal}, path::Path};

#[derive(Debug, PartialEq)]
enum Command<'a> { Capabilities, Authorize(&'a Path), Turns, Transcribe }

fn command(args: &[String]) -> Result<Command<'_>, &'static str> {
    if args == ["--capabilities"] { return Ok(Command::Capabilities); }
    if args.iter().any(|s| s == "--authorize" || s == "--capabilities") {
        if let [op, flag, file] = args {
            if op == "--authorize" && flag == "--config-db" && Path::new(file).is_absolute() {
                return Ok(Command::Authorize(Path::new(file)));
            }
        }
        return Err("usage");
    }
    // The delegated CLI parsers validate their full option and path sets.
    Ok(if args.iter().any(|s| s == "--language") { Command::Transcribe } else { Command::Turns })
}

fn authorize_once<T>(foreground: bool, lookup: impl FnOnce() -> Result<T, &'static str>) -> Result<(), &'static str> {
    if !foreground { return Err("clinic_authorization_requires_terminal"); }
    // Only this explicitly selected setup operation permits normal macOS interaction.
    // One lookup, no retries or export. Never feed the result to a model or another process.
    drop(lookup()?);
    Ok(())
}

fn authorize(path: &Path) -> Result<(), &'static str> {
    authorize_once(io::stdin().is_terminal() && io::stderr().is_terminal(), || {
        let config = turns::read_config(path)?;
        if config.provider != "aliyun" || !matches!(config.region.as_deref(), Some("beijing" | "singapore")) {
            return Err("invalid_config");
        }
        cloud::credentials::read(&config).map_err(|_| "clinic_authorization_not_completed")
    })
}

#[tokio::main]
async fn main() {
    let args: Vec<_> = std::env::args().skip(1).collect();
    let result: Result<(), String> = match command(&args) {
        Ok(Command::Capabilities) => {
            println!("{}",json!({"helper":"clinic_session","roles":["clinic_turns","clinic_asr"],"keychainInteraction":false}));
            Ok(())
        }
        Ok(Command::Authorize(path)) => authorize(path).map(|()| {
            // A successful interactive read alone does not prove a permanent ACL grant.
            println!("{}",json!({"status":"readable"}));
        }).map_err(String::from),
        Ok(Command::Turns) => turns::run().await.map_err(String::from),
        Ok(Command::Transcribe) => asr::run().await.map_err(|error| error.code),
        Err(code) => Err(code.into()),
    };
    if let Err(code) = result {
        eprintln!("{}",json!({"errorCode":code}));
        std::process::exit(1);
    }
}

#[cfg(test)]
mod session_tests {
    use super::*;
    use std::cell::Cell;
    fn args(values: &[&str]) -> Vec<String> { values.iter().map(|s| s.to_string()).collect() }

    #[test]
    fn routes_audio_and_accepts_only_the_exact_enrollment_command() {
        assert_eq!(command(&args(&["--capabilities"])), Ok(Command::Capabilities));
        assert_eq!(command(&args(&["--wav","/tmp/a","--config-db","/tmp/c","--out","/tmp/o"])), Ok(Command::Turns));
        assert_eq!(command(&args(&["--wav","/tmp/a","--config-db","/tmp/c","--out","/tmp/o","--language","auto"])), Ok(Command::Transcribe));
        assert_eq!(command(&args(&["--authorize","--config-db","/tmp/c"])), Ok(Command::Authorize(Path::new("/tmp/c"))));
        for wrong in [&["--authorize","--config-db","relative"][..], &["--authorize","--config-db","/tmp/c","--wav","/tmp/a"], &["--capabilities","--authorize"]] {
            assert_eq!(command(&args(wrong)), Err("usage"));
        }
    }

    #[test]
    fn refuses_unattended_authorization_before_any_lookup() {
        assert_eq!(authorize_once::<()>(false, || panic!("must not read")), Err("clinic_authorization_requires_terminal"));
    }

    #[test]
    fn a_cancelled_lookup_is_not_retried_and_a_success_is_immediately_dropped() {
        let calls = Cell::new(0);
        let denied = authorize_once::<()>(true, || { calls.set(calls.get()+1); Err("clinic_authorization_not_completed") });
        assert_eq!(denied, Err("clinic_authorization_not_completed"));
        assert_eq!(calls.get(), 1);
        struct FakeValue<'a>(&'a Cell<bool>);
        impl Drop for FakeValue<'_> { fn drop(&mut self) { self.0.set(true); } }
        let dropped = Cell::new(false);
        assert!(authorize_once(true, || Ok(FakeValue(&dropped))).is_ok());
        assert!(dropped.get());
    }
}

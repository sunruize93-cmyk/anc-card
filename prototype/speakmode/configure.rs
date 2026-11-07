//! ANC Card configuration helper using SpeakMode's own store and credential APIs.
use speakmode_lib::{cloud, core::{ProviderConfig, Store}};
use std::{io::{self, Read}, path::PathBuf};

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2 || !["beijing", "singapore"].contains(&args[1].as_str()) {
        return Err("usage: anc_config ABS_CONFIG_DB beijing|singapore".into());
    }
    let path = PathBuf::from(&args[0]);
    if !path.is_absolute() { return Err("absolute config database path required".into()); }
    let mut store = Store::open(path)?;
    let existing = store.provider_config()?;
    let config = ProviderConfig {
        provider: "aliyun".into(), region: Some(args[1].clone()), workspace: None,
        asr_model: "qwen3-asr-flash-realtime".into(),
        adapter_version: cloud::models::QWEN_REALTIME_ADAPTER.into(),
        ..existing.clone()
    };
    cloud::asr_endpoint(&config)?;
    let mut secret = String::new();
    io::stdin().take(4097).read_to_string(&mut secret)?;
    cloud::credentials::set(&config, &secret)?;
    store.save_provider_config(config, existing.version)?;
    println!("SpeakMode 配置已保存，API Key 已存入登录钥匙串。");
    Ok(())
}

fn main() {
    if run().is_err() {
        eprintln!("SpeakMode 配置失败，请检查地域、输入和系统钥匙串权限。");
        std::process::exit(1);
    }
}

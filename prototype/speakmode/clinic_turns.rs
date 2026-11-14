//! Report anonymous turn boundaries. Transcripts and audio remain absent from receipts.
#[path="anc_clinic/keychain.rs"] mod clinic_keychain;
use base64::{engine::general_purpose::STANDARD, Engine};
use chrono::Utc;
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use speakmode_lib::core::ProviderConfig;
use std::{fs::{self, OpenOptions}, io::{Cursor, Read, Write}, os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf}, time::{Duration, Instant}};
use uuid::Uuid;

const MODEL: &str = "qwen-audio-3.1-asr-flash";
const ADAPTER: &str = "anc-clinic-turns-v1";
const AUDIO_BYTES: u64 = 7_499_975;
const RESPONSE_BYTES: usize = 1024 * 1024;
const EDGE_MS: u64 = 250;
type Result<T> = std::result::Result<T, &'static str>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct Turn { speaker_id: u64, start_ms: u64, end_ms: u64 }

#[derive(Deserialize)]
struct Sentence {
    speaker_id: u64,
    begin_time: u64,
    end_time: u64,
    sentence_end: bool,
}

struct Boundaries {
    turns: Vec<Turn>,
    mode: &'static str,
    reason: Option<&'static str>,
}

fn whole(duration: u64, speaker: u64, reason: &'static str) -> Boundaries {
    Boundaries {
        turns: vec![Turn { speaker_id: speaker, start_ms: 0, end_ms: duration }],
        mode: "whole_audio",
        reason: Some(reason),
    }
}

fn boundaries(payload: &Value, duration: u64) -> Result<Boundaries> {
    // Different server envelopes carry the completed result on one or both levels.
    let output = payload.get("output").ok_or("invalid_response")?;
    let candidates = [Some(output), output.get("output")];
    if !candidates.iter().flatten().any(|x| x.get("text").is_some_and(Value::is_string)) {
        return Err("invalid_response");
    }
    let Some(sentences) = candidates.iter().flatten().find_map(|x| x.get("sentences")
        .and_then(Value::as_array).filter(|s| !s.is_empty())) else {
        return Ok(whole(duration,0,"missing_speaker_boundaries"));
    };
    if sentences.len() > 4000 { return Err("large_response"); }
    let mut groups: Vec<Turn> = Vec::new();
    let mut previous_start = 0;
    for value in sentences {
        let Ok(s) = serde_json::from_value::<Sentence>(value.clone()) else {
            return Ok(whole(duration,0,"unusable_speaker_boundaries"));
        };
        if !s.sentence_end || s.begin_time < previous_start || s.begin_time >= duration
            || s.end_time <= s.begin_time || s.end_time > duration.saturating_add(EDGE_MS) {
            return Ok(whole(duration,0,"unusable_speaker_boundaries"));
        }
        previous_start = s.begin_time;
        let end_ms = s.end_time.min(duration);
        if let Some(prev) = groups.last_mut() {
            if prev.speaker_id == s.speaker_id {
                prev.end_ms = prev.end_ms.max(end_ms);
                continue;
            }
            // Small cross-speaker overlaps occur in actual 3.1 output; larger ones are ambiguous.
            if prev.end_ms.saturating_sub(s.begin_time) > EDGE_MS || end_ms <= prev.end_ms {
                return Ok(whole(duration,0,"overlapping_speakers"));
            }
        }
        groups.push(Turn { speaker_id:s.speaker_id,start_ms:s.begin_time,end_ms });
    }
    if groups.len()==1 { return Ok(whole(duration,groups[0].speaker_id,"single_speaker")); }
    // Complete, contiguous coverage (including pauses); keep midpoints away from clipped words.
    let mut cuts = Vec::with_capacity(groups.len()+1);
    cuts.push(0);
    for pair in groups.windows(2) {
        let cut=(pair[0].end_ms+pair[1].start_ms)/2;
        if cut<=*cuts.last().unwrap() || cut>=duration {
            return Ok(whole(duration,0,"unusable_speaker_boundaries"));
        }
        cuts.push(cut);
    }
    cuts.push(duration);
    for (item,times) in groups.iter_mut().zip(cuts.windows(2)) {
        item.start_ms=times[0];item.end_ms=times[1];
    }
    Ok(Boundaries { turns:groups,mode:"provider_turns",reason:None })
}

fn parse_args() -> Result<(PathBuf,PathBuf,PathBuf)> {
    let args:Vec<String>=std::env::args().skip(1).collect();
    if args.len()!=6 { return Err("usage"); }
    let mut fields=std::collections::HashMap::new();
    for pair in args.chunks_exact(2) {
        if !["--wav","--config-db","--out"].contains(&pair[0].as_str()) ||
            !Path::new(&pair[1]).is_absolute() || fields.insert(pair[0].as_str(),PathBuf::from(&pair[1])).is_some() {
            return Err("usage");
        }
    }
    Ok((fields.remove("--wav").ok_or("usage")?,fields.remove("--config-db").ok_or("usage")?,
        fields.remove("--out").ok_or("usage")?))
}

fn audio(path:&Path) -> Result<(Vec<u8>,u64)> {
    let file=fs::File::open(path).map_err(|_|"audio_unavailable")?;
    let size=file.metadata().map_err(|_|"audio_unavailable")?.len();
    if size>AUDIO_BYTES {return Err("audio_size_limit");}
    let mut bytes=Vec::with_capacity(size as usize);
    file.take(AUDIO_BYTES+1).read_to_end(&mut bytes).map_err(|_|"audio_unavailable")?;
    if bytes.len() as u64>AUDIO_BYTES {return Err("audio_size_limit");}
    let mut reader=hound::WavReader::new(Cursor::new(&bytes)).map_err(|_|"invalid_audio")?;
    let spec=reader.spec(); let samples=u64::from(reader.duration());
    if spec.channels!=1 || spec.sample_rate!=16000 || spec.bits_per_sample!=16 || spec.sample_format!=hound::SampleFormat::Int {
        return Err("audio_format");
    }
    if samples==0 || samples>4_800_000 { return Err("audio_duration_limit"); }
    let actual=reader.samples::<i16>().try_fold(0u64,|n,s|s.map(|_|n+1)).map_err(|_|"invalid_audio")?;
    if actual!=samples {return Err("incomplete_audio");}
    Ok((bytes,samples))
}

pub(crate) fn read_config(path:&Path) -> Result<ProviderConfig> {
    let conn=Connection::open_with_flags(path,OpenFlags::SQLITE_OPEN_READ_ONLY|OpenFlags::SQLITE_OPEN_NO_MUTEX)
        .map_err(|_|"config_unavailable")?;
    let raw:String=conn.query_row("SELECT data FROM provider_config WHERE singleton=1",[],|r|r.get(0))
        .map_err(|_|"config_unavailable")?;
    serde_json::from_str(&raw).map_err(|_|"invalid_config")
}

async fn request(config:&ProviderConfig, bytes:&[u8], duration:u64) -> Result<Boundaries> {
    if config.provider!="aliyun" {return Err("unsupported_provider");}
    let endpoint=match config.region.as_deref(){
        Some("beijing")=>"https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        Some("singapore")=>"https://dashscope-intl.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        _=>return Err("region_required"),
    };
    let body=json!({"model":MODEL,"input":{"messages":[{"role":"user","content":[{"type":"input_audio",
        "input_audio":{"data":format!("data:audio/wav;base64,{}", STANDARD.encode(bytes))}}]}]},
        "parameters":{"format":"wav","speaker_diarization_enabled":true}});
    let client=reqwest::Client::builder().redirect(reqwest::redirect::Policy::none()).timeout(Duration::from_secs(60))
        .build().map_err(|_|"network_setup")?;
    let key=clinic_keychain::read(config).map_err(|_|"clinic_keychain_access_required")?;
    let mut req=client.post(endpoint).bearer_auth(&key).json(&body);drop(key);
    if let Some(ws)=config.workspace.as_deref().filter(|s|!s.is_empty()){req=req.header("X-DashScope-WorkSpace",ws);}
    let network=|e:reqwest::Error|if e.is_timeout(){"file_asr_timeout"}else{"file_asr_network"};
    let mut response=req.send().await.map_err(network)?;
    if !response.status().is_success() { return Err(match response.status().as_u16(){
        401|403=>"authentication_failed",429=>"rate_limited",_=>"file_asr_service_error"
    });}
    let mut data=Vec::new();
    while let Some(chunk)=response.chunk().await.map_err(network)? {
        if data.len()+chunk.len()>RESPONSE_BYTES {return Err("large_response");}data.extend_from_slice(&chunk);
    }
    let payload:Value=serde_json::from_slice(&data).map_err(|_|"invalid_response")?;
    if payload.get("code").is_some_and(|c|!c.is_null()) {return Err("file_asr_service_error");}
    boundaries(&payload,duration)
}

fn row(output:&mut fs::File, value:&Value) -> Result<()> {
    writeln!(output,"{value}").and_then(|_|output.flush()).map_err(|_|"output_failed")
}

pub(crate) async fn run() -> Result<()> {
    let (wav,db,out)=parse_args()?;let (bytes,samples)=audio(&wav)?;
    let mut output=OpenOptions::new().write(true).create_new(true).mode(0o600).open(out).map_err(|_|"output_unavailable")?;
    let mut receipt=json!({"attemptId":Uuid::new_v4().to_string(),"audioSha256":format!("{:x}",Sha256::digest(&bytes)),
        "audioSamples":samples,"model":MODEL,"adapterVersion":ADAPTER,"status":"started","startedAt":Utc::now().to_rfc3339()});
    row(&mut output,&receipt)?;
    let start=Instant::now();
    let result=match read_config(&db) {
        Ok(config)=>{receipt["region"]=json!(config.region);request(&config,&bytes,samples.div_ceil(16)).await},
        Err(e)=>Err(e)
    };
    receipt["completedAt"]=json!(Utc::now().to_rfc3339());receipt["elapsedMs"]=json!(start.elapsed().as_millis() as u64);
    match result {
        Ok(bounds)=>{
            receipt["status"]=json!("passed");receipt["turns"]=json!(bounds.turns);receipt["boundaryMode"]=json!(bounds.mode);
            if let Some(reason)=bounds.reason { receipt["boundaryReason"]=json!(reason); }
            row(&mut output,&receipt)
        },
        Err(code)=>{receipt["status"]=json!("failed");receipt["errorCode"]=json!(code);row(&mut output,&receipt)?;Err(code)}
    }
}
#[tokio::main]
async fn main() { if clinic_keychain::capabilities_requested("clinic_turns") { return; } if let Err(code)=run().await {eprintln!("{}",json!({"errorCode":code}));std::process::exit(1);} }

#[cfg(test)]
mod tests {
    use super::*;
    fn sentence(id:u64,a:u64,b:u64)->Value {json!({"speaker_id":id,"begin_time":a,"end_time":b,"sentence_end":true})}
    #[test]fn restores_contiguous_turns_from_provider_overlaps_and_split_sentences() {
        let data=json!({"output":{"output":{"text":"sample","sentences":[sentence(0,0,1960),sentence(1,1920,3020),
            sentence(1,3240,5440),sentence(0,5360,9600)]}}});
        let b=boundaries(&data,9545).unwrap();
        assert_eq!(b.mode,"provider_turns");assert_eq!(b.turns.iter().map(|t|(t.speaker_id,t.start_ms,t.end_ms))
            .collect::<Vec<_>>(),vec![(0,0,1940),(1,1940,5400),(0,5400,9545)]);
    }
    #[test]fn rejects_bad_envelope_and_marks_unknown_or_substantially_overlapping_boundaries() {
        assert!(boundaries(&json!({"output":{}}),1000).is_err());
        for data in [json!({"output":{"text":"s"}}),json!({"output":{"text":"s","sentences":[sentence(0,0,600),sentence(1,100,800)]}}),
            json!({"output":{"text":"s","sentences":[{"speaker_id":null}]}})] {
            let b=boundaries(&data,1000).unwrap();assert_eq!(b.mode,"whole_audio");assert_eq!(b.turns[0].end_ms,1000);
        }
    }
}

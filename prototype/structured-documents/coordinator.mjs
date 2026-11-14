import {rawOpusFormat} from '../audio/qs668.mjs';
import {DatabaseSync} from 'node:sqlite';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {createDocumentService} from './service.mjs';
import {createCodexDocumentGenerator} from './generator.mjs';
import {sha256} from './core.mjs';

export function pcmDuration(wav) {
  if(wav.length<44||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE'||wav.readUInt32LE(4)+8!==wav.length)throw Error('DOCUMENT_AUDIO_METADATA_UNAVAILABLE');
  let rate,align,data;
  for(let o=12;o+8<=wav.length;){const n=wav.readUInt32LE(o+4),start=o+8;if(start+n>wav.length)throw Error('INVALID_WAV');
    const tag=wav.toString('ascii',o,o+4);
    if(tag==='fmt '&&n>=16){const encoding=wav.readUInt16LE(start);if(![1,3].includes(encoding))throw Error('UNSUPPORTED_WAV');rate=wav.readUInt32LE(start+4);align=wav.readUInt16LE(start+12);}
    if(tag==='data')data=n;o=start+n+n%2;
  }
  if(!rate||!align||!data||data%align)throw Error('INVALID_WAV');return Math.ceil(data/align/rate*1000);
}

// Opt-in, explicit recording allowlist. Existing services do not load this until
// an authorized cutover. Same existing Feishu client, never a second connection.
export async function openDocumentCoordinator({directory,recordings,feishu,ids,generate,autoStart=true}) {
  const allowed=new Set(ids);for(const id of allowed)if(!/^[a-f0-9]{64}$/.test(id))throw Error('INVALID_DOCUMENT_ALLOWLIST');
  const root=join(directory,'structured-documents');await mkdir(root,{recursive:true,mode:0o700});
  const work=join(root,'generator');await mkdir(work,{recursive:true,mode:0o700});
  const db=new DatabaseSync(join(root,'documents.sqlite'));
  const seen=new Set();let closed=false,pending;
  const service=createDocumentService({db,generate:generate??createCodexDocumentGenerator({cwd:work}),
    resolveBinding:async(_device,id)=>{
      const config=feishu.status(),row=recordings.delivery.get(config,id);
      return row?.messageId&&row.finished?{appId:config.appId,chatId:config.chatId,messageId:row.messageId}:null;
    },patchOriginalCard:request=>feishu.patchDocument(request)});
  async function tick(){
    for(const id of allowed){
      if(seen.has(id))continue;const r=recordings.get(id);if(r?.status!=='complete')continue;
      const info=recordings.info(id);if(!info?.size)continue;
      try{
        const audio=recordings.readAudio(id,0,info.size);
        if(audio.length!==info.size||sha256(audio)!==id)throw Error('DOCUMENT_AUDIO_HASH_MISMATCH');
        service.enqueue({id,audioBytes:info.size,durationMs:documentAudioDuration(r,audio),transcript:r.transcript});seen.add(id);
      }catch{seen.add(id); /* No repeated model attempts for unrepresentable metadata. */}
    }
    await service.pump();
  }
  function runOnce(){if(closed)throw Error('DOCUMENT_COORDINATOR_CLOSED');return pending??(pending=tick().finally(()=>{pending=null;}));}
  const timer=autoStart?setInterval(()=>{runOnce().catch(()=>{});},3000):null;
  return {...service,runOnce,async close(){closed=true;clearInterval(timer);await pending;db.close();}};
}

export function documentAudioDuration(recording,audio) {
 if(recording.audioFormat!==rawOpusFormat)return pcmDuration(Buffer.from(audio));
 const d=recording.decodeInfo;
 if(d?.format!==rawOpusFormat||d.sourceSha256!==sha256(audio)||d.sourceBytes!==audio.length||
    d.sampleRate!==16000||d.channels!==1||!Number.isSafeInteger(d.sampleCount)||d.sampleCount<1||
    d.durationMs!==d.sampleCount/16||d.timestampBasis!=='decoded_pcm_start'||
    !/^[a-f0-9]{64}$/.test(d.decodedSha256))throw Error('DOCUMENT_DECODE_EVIDENCE_UNAVAILABLE');
 return Math.ceil(d.durationMs);
}

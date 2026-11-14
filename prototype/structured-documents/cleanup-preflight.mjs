import {freezeSource,sha256} from './core.mjs';

// Read-only eligibility for removing redundant phone/card copies. Server audio
// stays intact; this is not a server-delete authorization or a deletion executor.
export async function cleanupPreflight({recordings,documents,recordingId,now=()=>new Date()}) {
  const result={schemaVersion:'anc.cleanup-preflight.v1',scope:'iphone_and_card',recordingId,
    sourceSha256:recordingId,sourceBytes:null,audioStored:false,documentRevision:null,
    manifestSha256:null,messageId:null,checkedAt:null,validForMs:15000,allowed:false,reasons:[],
    serverAudioRetained:true,requiresDeviceChecks:['latest_five','historical_protection','card_binding','file_identity','fresh_receipt']};
  const finish=()=>{result.checkedAt=now().toISOString();result.allowed=result.reasons.length===0;return result;};
  const reject=reason=>{result.reasons.push(reason);return finish();};
  if(!/^[a-f0-9]{64}$/.test(recordingId))return reject('INVALID_RECORDING_ID');
  try {
    const recording=recordings.get(recordingId),info=recordings.info(recordingId);
    if(!recording||!info)return reject('RECORDING_NOT_FOUND');
    if(!Number.isSafeInteger(info.size)||info.size<1)return reject('SERVER_AUDIO_UNAVAILABLE');
    result.sourceBytes=info.size;
    const audio=recordings.readAudio(recordingId,0,info.size);
    if(audio.length!==info.size||sha256(audio)!==recordingId)return reject('SERVER_AUDIO_MISMATCH');
    result.audioStored=true;
    if(recording.status!=='complete')return reject('RECORDING_NOT_COMPLETE');
    if(!documents)return reject('DOCUMENT_UNAVAILABLE');
    const receipt=await documents.receipt(null,recordingId);
    if(!receipt||receipt.state!=='ready')return reject('DOCUMENT_NOT_READY');
    result.documentRevision=receipt.revision;result.manifestSha256=receipt.manifestSha256;
    result.messageId=receipt.delivery?.messageId??null;
    if(receipt.delivery?.state!=='delivered'||receipt.delivery.revision!==receipt.revision||
       receipt.delivery.manifestSha256!==receipt.manifestSha256||!result.messageId)return reject('DOCUMENT_NOT_DELIVERED');
    const artifact=await documents.readArtifact(null,recordingId,receipt.revision,'document.json');
    if(!artifact||sha256(artifact.bytes)!==receipt.artifacts?.json?.sha256)return reject('DOCUMENT_READBACK_MISMATCH');
    const doc=JSON.parse(Buffer.from(artifact.bytes).toString('utf8'));
    if(doc.recordingId!==recordingId||doc.revision!==receipt.revision||doc.source?.audioSha256!==recordingId||doc.source?.audioBytes!==info.size)return reject('DOCUMENT_SOURCE_MISMATCH');
    const source=freezeSource({id:recordingId,audioBytes:info.size,durationMs:doc.source.durationMs,transcript:recording.transcript});
    if(source.source.transcriptSha256!==doc.source.transcriptSha256)return reject('TRANSCRIPT_CHANGED');
    if(!Array.isArray(doc.uncertainties)||doc.uncertainties.length||recording.requiresAudioReview===true)return reject('AUDIO_REVIEW_REQUIRED');
    // Async adapters may yield while a new revision/job begins. Recheck before
    // returning a short-lived snapshot, never grant eligibility from old ready.
    const current=await documents.receipt(null,recordingId);
    if(recordings.get(recordingId)?.status!=='complete'||current?.state!=='ready'||
      current.revision!==receipt.revision||current.manifestSha256!==receipt.manifestSha256||
      current.delivery?.state!=='delivered'||current.delivery.messageId!==result.messageId||
      current.delivery.revision!==receipt.revision||current.delivery.manifestSha256!==receipt.manifestSha256)return reject('STATE_CHANGED');
    return finish();
  }catch{return reject('PREFLIGHT_UNAVAILABLE');}
}

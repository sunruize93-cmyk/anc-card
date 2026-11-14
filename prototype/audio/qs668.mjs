import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,writeFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const exec=promisify(execFile);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export const rawOpusFormat='qs668-raw-opus-40-v1';
// Two hours, 50 packets/s; no compressed input may expand without a duration cap.
export const maxRawBytes=2*60*60*50*40;
const invalid=code=>Object.assign(Error(code),{status:422});

export function validateRawOpus(input) {
 const raw=Buffer.from(input);
 if(!raw.length||raw.length%40||raw.length>maxRawBytes)throw invalid('QS668_INVALID_LENGTH');
 for(let o=0;o<raw.length;o+=40){
  const p=raw.subarray(o,o+40);
  // Config 9: SILK WB mono, 20 ms. Only one frame per fixed device packet.
  if(p[0]===0x48)continue;
  if(p[0]!==0x4b||(p[1]&63)!==1)throw invalid('QS668_UNSUPPORTED_PACKET');
  // RFC 6716 3.2.5. With M=1 VBR adds no frame-size fields.
  let offset=2,padding=0;
  if(p[1]&64){let n;do{if(offset>=40)throw invalid('QS668_INVALID_PADDING');n=p[offset++];padding+=n===255?254:n;}while(n===255);}
  if(offset+padding>40)throw invalid('QS668_INVALID_PADDING');
 }
 return {packetCount:raw.length/40,packetDurationMs:20,encodedDurationMs:raw.length/40*20};
}

export function validateAudioDeclaration(name,format,contentType) {
 if(format!=null&&format!==rawOpusFormat)throw Object.assign(Error('UNSUPPORTED_AUDIO_FORMAT'),{status:415});
 if(format===rawOpusFormat){
  if(!/\.opus$/i.test(name)||contentType?.split(';')[0].trim().toLowerCase()!=='application/octet-stream')throw Object.assign(Error('RAW_OPUS_REQUIRES_EXPLICIT_FORMAT_AND_OCTET_STREAM'),{status:415});
 }else if(/\.opus$/i.test(name))throw Object.assign(Error('RAW_OPUS_REQUIRES_EXPLICIT_FORMAT'),{status:415});
}

function readPCM(wav) {
 if(wav.length<44||wav.toString('ascii',0,4)!=='RIFF'||wav.toString('ascii',8,12)!=='WAVE'||wav.readUInt32LE(4)+8!==wav.length)throw invalid('DECODE_INVALID_WAV');
 let format,data;
 for(let o=12;o+8<=wav.length;){const n=wav.readUInt32LE(o+4),start=o+8;if(start+n>wav.length)throw invalid('DECODE_TRUNCATED_WAV');
 const tag=wav.toString('ascii',o,o+4);if(tag==='fmt ')format=wav.subarray(start,start+n);if(tag==='data')data=wav.subarray(start,start+n);o=start+n+n%2;}
 const encoding=format?.length>=16?format.readUInt16LE(0):null;
 const extensible=encoding===65534&&format.length>=40&&format.readUInt16LE(16)>=22&&format.readUInt16LE(18)===16&&format.subarray(24,40).toString('hex')==='0100000000001000800000aa00389b71';
 if(!format||format.length<16||(encoding!==1&&!extensible)||format.readUInt16LE(2)!==1||format.readUInt32LE(4)!==16000||format.readUInt16LE(12)!==2||format.readUInt16LE(14)!==16||!data?.length||data.length%2)throw invalid('DECODE_INVALID_PCM');
 return {data,metadata:{sampleRate:16000,channels:1,sampleCount:data.length/2,durationMs:data.length/32,pcmSha256:sha(data)}};
}

export function pcm16Metadata(wav) {return readPCM(wav).metadata;}
function canonicalWave(native) {
 const {data}=readPCM(native),h=Buffer.alloc(44);
 h.write('RIFF');h.writeUInt32LE(data.length+36,4);h.write('WAVEfmt ',8);h.writeUInt32LE(16,16);
 h.writeUInt16LE(1,20);h.writeUInt16LE(1,22);h.writeUInt32LE(16000,24);h.writeUInt32LE(32000,28);
 h.writeUInt16LE(2,32);h.writeUInt16LE(16,34);h.write('data',36);h.writeUInt32LE(data.length,40);
 return Buffer.concat([h,data]);
}
export async function decodeRawOpus(audio,directory,signal) {
 const framing=validateRawOpus(audio);
 const original=join(directory,'source.opus'),ogg=join(directory,'wrapped.ogg'),wavPath=join(directory,'normalized.wav');
 await writeFile(original,audio,{mode:0o600});
 const options={signal,timeout:120000,maxBuffer:16384};
 const script=fileURLToPath(new URL('./third_party/qs668/qs668_raw_opus_to_ogg.py',import.meta.url));
 await exec('/usr/bin/python3',[script,original,ogg],options);
 await exec('/usr/bin/afconvert',['-f','WAVE','-d','LEI16@16000','-c','1',ogg,wavPath],options);
 if((await stat(wavPath)).size>256*1024*1024)throw invalid('DECODE_TOO_LARGE');
 const native=await readFile(wavPath),wav=canonicalWave(native),pcm=pcm16Metadata(wav);
 // Vendor Ogg uses 312/48kHz pre-skip. Decoder output can differ by at most
 // one packet at the boundary; never claim byte or sample equality to card WAV.
 if(Math.abs(pcm.durationMs-(framing.encodedDurationMs-6.5))>20)throw invalid('DECODE_DURATION_MISMATCH');
 const os=await exec('/usr/bin/sw_vers',['-productVersion'],options);
 return {wav,decodeInfo:{format:rawOpusFormat,sourceSha256:sha(audio),sourceBytes:audio.length,
  decoder:'macOS afconvert',decoderVersion:'macOS '+os.stdout.trim(),wrapperVersion:'qs668-ogg-v1',
  nativeDecodedSha256:sha(native),decodedSha256:sha(wav),decodedBytes:wav.length,...framing,...pcm,
  preSkip48k:312,timestampBasis:'decoded_pcm_start',sourcePacketOffsetMs:6.5,
  cardWavAlignment:'not_verified'}};
}

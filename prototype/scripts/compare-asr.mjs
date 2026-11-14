// Offline by default; --openai sends only the specified recording's verified chunks.
import { createHash } from 'node:crypto';
import { splitWav } from '../speakmode.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const [id, mode] = process.argv.slice(2);
if (!/^[0-9a-f]{64}$/.test(id || '') || (mode && mode !== '--openai')) throw Error('用法：node prototype/scripts/compare-asr.mjs 录音SHA256 [--openai]');
const base='http://127.0.0.1:'+(process.env.ANC_PROTOTYPE_PORT||4785)+'/api/recordings';
async function load(url) { const r=await fetch(url); if(!r.ok) throw Error('无法读取本机录音'); return r; }
const rec=(await (await load(base)).json()).find(r=>r.id===id && r.status==='complete');
if (!rec || !rec.name.endsWith('.wav')) throw Error('请选择完成转写的 WAV 样本');
const original=Buffer.from(await (await load(base+'/'+id+'/audio')).arrayBuffer());
if(createHash('sha256').update(original).digest('hex')!==id) throw Error('原件哈希不符');
const dir=mkdtempSync(join(tmpdir(),'anc-asr-'));
try {
  writeFileSync(join(dir,'source.wav'),original);
  execFileSync('/usr/bin/afconvert',['-f','WAVE','-d','LEI16@16000','-c','1',join(dir,'source.wav'),join(dir,'normalized.wav')]);
  const chunks=splitWav(readFileSync(join(dir,'normalized.wav')));
  if(chunks.length!==rec.transcript.length || chunks.some((c,i)=>c.sha256!==rec.transcript[i].chunkSha256)) throw Error('与百炼转写的分段不一致');
  if(mode && !process.env.OPENAI_API_KEY) throw Error('请在本机终端设置 OPENAI_API_KEY');
  for(const [i,c] of chunks.entries()) {
    const row={recordingId:id,startMs:c.startMs,endMs:c.endMs,sha256:c.sha256,qwen:rec.transcript[i].text};
    if(mode) {
      const form=new FormData();form.set('model','gpt-transcribe');form.set('file',new Blob([c.audio],{type:'audio/wav'}),'segment.wav');
      const res=await fetch('https://api.openai.com/v1/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY},body:form,signal:AbortSignal.timeout(75000)});
      if(!res.ok) throw Error('OpenAI 转写 HTTP '+res.status+'，请求 ID '+res.headers.get('x-request-id'));
      row.openai=(await res.json()).text;
      if(typeof row.openai!=='string' || !row.openai.trim()) throw Error('OpenAI 回执没有文本');
    }
    console.log(JSON.stringify(row));
  }
} finally { rmSync(dir,{recursive:true,force:true}); }

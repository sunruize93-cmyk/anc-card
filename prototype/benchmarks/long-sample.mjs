// Public, fictional speech only. Generation is offline; no ASR or live services.
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,readFile,writeFile,stat,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {splitWav} from '../speakmode.mjs';
const exec=promisify(execFile),sha=b=>createHash('sha256').update(b).digest('hex');
const output=process.argv[2];
if(!output)throw Error('Usage: node prototype/benchmarks/long-sample.mjs NEW_SAMPLE_DIR');
const root=resolve(output);
if(await stat(root).catch(()=>null))throw Error('Use a fresh sample directory; never overwrite frozen audio');
await mkdir(root,{recursive:true,mode:0o700});
const topics=['客户访谈','产品演示','预算核对','活动报名','会议记录','资料归档','网站文案','产品定价','售后反馈','团队排期','交付检查','数据核对'];
const owners=['陈明','林芳','张华','李娜'];
function chinese(n){const d='零一二三四五六七八九';return n<10?d[n]:n<20?'十'+(n%10?d[n%10]:''):d[Math.floor(n/10)]+'十'+(n%10?d[n%10]:'');}
function pcm(wav){for(let i=12;i+8<=wav.length;){const n=wav.readUInt32LE(i+4);if(wav.toString('ascii',i,i+4)==='data')return wav.subarray(i+8,i+8+n);i+=8+n+n%2;}throw Error('Missing PCM');}
function wav(data){const b=Buffer.alloc(44);b.write('RIFF');b.writeUInt32LE(data.length+36,4);b.write('WAVEfmt ',8);b.writeUInt32LE(16,16);b.writeUInt16LE(1,20);b.writeUInt16LE(1,22);b.writeUInt32LE(16000,24);b.writeUInt32LE(32000,28);b.writeUInt16LE(2,32);b.writeUInt16LE(16,34);b.write('data',36);b.writeUInt32LE(data.length,40);return Buffer.concat([b,data]);}
const buffers=[],sections=[];let bytes=0;
for(let number=1;bytes/32<3_600_000;number++){
 if(number>=100)throw Error('Unexpected voice speed; section numbering supports fewer than 100 sections');
 const topic=topics[(number-1)%topics.length],owner=owners[(number-1)%owners.length],other=owners[number%owners.length],label=chinese(number);
 const text=`这里是第${label}段，讨论的主题是${topic}。这是一份用于长录音测试的虚构会议，不是真实客户的工作安排。由${owner}负责整理第${label}份${topic}记录，截止时间是下周五。请先核对原始材料，再列出需要补充的信息。初步预算是三千五百元，其中场地费用一千二百元，设备费用八百元，其余部分先保留，不代表已经批准付款。刚才的时间需要修正，最终截止时间改为下周一，旧的周五安排取消。${other}协助检查数字和文件名，但不要代替负责人确认。讨论中的想法先写成待确认事项，不能直接当作已经完成的承诺。如果材料不完整，就保留问题和出处，等下一轮讨论再决定。最后提醒大家，保留原始录音，核对这一段的开头和结尾。这是第${label}段的结束标记。`;
 const prefix=join(root,'voice');await exec('/usr/bin/say',['-v','Tingting','-r','165','-o',prefix+'.aiff',text]);
 await exec('/usr/bin/afconvert',['-f','WAVE','-d','LEI16@16000','-c','1',prefix+'.aiff',prefix+'.wav']);
 const audio=pcm(await readFile(prefix+'.wav'));
 sections.push({number,label,topic,owner,other,startMs:bytes/32,speechEndMs:(bytes+audio.length)/32,endMs:(bytes+audio.length+32000)/32,text,
  anchors:[`第${label}段`,`${owner}负责整理`,`${topic}记录`,'最终截止时间改为下周一','旧的周五安排取消']});
 buffers.push(audio,Buffer.alloc(32000));bytes+=audio.length+32000;
 console.log(JSON.stringify({section:number,durationSeconds:bytes/32000}));
}
const audio=wav(Buffer.concat(buffers));await writeFile(join(root,'long-coffee.wav'),audio);
const chunks=splitWav(audio).map(({index,startMs,endMs,sha256})=>({index,startMs,endMs,sha256}));
const manifest={schema:'anc-long-sample-v1',kind:'fictional templated Mandarin TTS, not a real meeting',voice:'Tingting',rate:165,
 bytes:audio.length,sha256:sha(audio),durationMs:bytes/32,sections,chunks};
await writeFile(join(root,'manifest.json'),JSON.stringify(manifest,null,2));
await rm(join(root,'voice.aiff'));await rm(join(root,'voice.wav'));
console.log(JSON.stringify({complete:true,seconds:bytes/32000,sections:sections.length,chunks:chunks.length,sha256:manifest.sha256}));

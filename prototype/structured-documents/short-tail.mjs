import {createHash} from 'node:crypto';
// Keep every sample and exact timeline. Only merge a contiguous short tail when
// the previous+tail stays within the existing 30s ASR request budget.
export function mergeShortTail(chunks) {
  if(chunks.length<2)return chunks;
  const previous=chunks.at(-2),tail=chunks.at(-1);
  if(tail.endMs-tail.startMs>=1500 || tail.startMs!==previous.endMs || tail.endMs-previous.startMs>30000)return chunks;
  const data=Buffer.concat([previous.audio.subarray(44),tail.audio.subarray(44)]),header=Buffer.from(previous.audio.subarray(0,44));
  header.writeUInt32LE(36+data.length,4);header.writeUInt32LE(data.length,40);
  const audio=Buffer.concat([header,data]);
  return [...chunks.slice(0,-2),{...previous,endMs:tail.endMs,samples:data.length/2,audio,sha256:createHash('sha256').update(audio).digest('hex')}];
}

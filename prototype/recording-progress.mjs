export function audioTime(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

// Progress counts input audio chunks, not words, accuracy, or billing units.
export function describeProgress(progress, status, { coarse = false } = {}) {
  if (!progress) return '';
  const p = progress;
  const total = Number.isSafeInteger(p.totalChunks) ? p.totalChunks : null;
  const count = Math.max(0, Math.min(total ?? 0, p.completedChunks || 0));
  const completed = total === null ? '' : `已完成 ${count}/${total} 段`;
  if (status === 'queued') return completed ? `等待恢复 · ${completed}；重新核对片段缓存后继续` : '等待处理';
  if (status === 'failed') {
    const at = p.currentChunk;
    const position = at ? `第 ${at.index + 1} 段（原音 ${audioTime(at.startMs)}–${audioTime(at.endMs)}）` :
      p.failureStage === 'normalizing' ? '音频转换阶段' : '结果整理阶段';
    return `${position}失败${completed ? ' · ' + completed : ''}。已成功片段会在重试时核对复用；未获得成功回执的请求仍可能已计费。`;
  }
  if (p.stage === 'normalizing') return '正在转换音频并确定分段';
  if (status === 'complete' && total === 0) return '分段完成，未检出待识别的有声片段；请回听原音核对';
  if (coarse && status === 'processing' && total) return `转写进度约 ${Math.floor(count / total * 10) * 10}%（按音频片段计）`;
  const reused = p.reusedChunks > 0 ? ` · 本轮复用 ${p.reusedChunks} 段` : '';
  const parallel = status === 'processing' && p.concurrency > 1 ? ` · 并行上限 ${p.concurrency}，当前 ${p.activeChunks?.length ?? 0} 段` : '';
  const at = status === 'processing' && p.currentChunk ?
    ` · 当前原音 ${audioTime(p.currentChunk.startMs)}–${audioTime(p.currentChunk.endMs)}` : '';
  return completed + reused + parallel + at;
}

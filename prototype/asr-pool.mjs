// One recording at a time; this bounds only its standard SpeakMode requests.
export function parseAsrConcurrency(value = process.env.ANC_ASR_CONCURRENCY ?? 1) {
  if (![1, 2, 4, '1', '2', '4'].includes(value)) throw Error('ANC_ASR_CONCURRENCY 必须为 1、2 或 4。');
  return Number(value);
}

export async function transcribeStandardChunks({chunks, cache, recognize, directory, signal, report, concurrency}) {
  concurrency = parseAsrConcurrency(concurrency);
  const results = new Array(chunks.length), pending = [], active = new Map();
  let completed = 0, cursor = 0, failure;
  for (let position = 0; position < chunks.length; position++) {
    const segment = cache.get(chunks[position]);
    if (segment) { results[position] = segment; completed++; }
    else pending.push({position, chunk:chunks[position]});
  }
  const reused = completed;
  const location = chunk => ({index:chunk.index,startMs:chunk.startMs,endMs:chunk.endMs});
  const update = () => {
    const activeChunks = [...active.values()].sort((a,b)=>a.index-b.index).map(location);
    report({stage:'transcribing',concurrency,totalChunks:chunks.length,completedChunks:completed,
      reusedChunks:reused,activeChunks,currentChunk:failure?.chunk ? location(failure.chunk) : activeChunks[0] ?? null});
  };
  update();
  async function worker() {
    while (!failure && cursor < pending.length) {
      if (signal.aborted) { failure={error:signal.reason}; return; }
      const {position,chunk} = pending[cursor++];
      try {
        active.set(position,chunk); update();
        const segment = await recognize(chunk,directory,signal);
        signal.throwIfAborted();
        cache.put(chunk,segment); results[position]=segment; completed++;
      } catch (error) {
        // Stop dispatching new chunks. Let already-running requests settle and save
        // successful receipts before returning; never delete their scratch early.
        failure ??= {error,chunk};
      } finally {
        active.delete(position);
        try { update(); } catch (error) { failure ??= {error,chunk}; }
      }
    }
  }
  const settled = await Promise.allSettled(Array.from({length:Math.min(concurrency,pending.length)},worker));
  // Also propagate progress/storage errors, after all sibling workers have settled.
  const rejected = settled.find(item=>item.status==='rejected');
  if (rejected) throw rejected.reason;
  if (failure) throw failure.error;
  signal.throwIfAborted();
  return results; // Original order, independent of completion order.
}

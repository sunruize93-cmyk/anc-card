import { spawn } from 'node:child_process';

// Explicit opt-in adapter. No process/model call until invoked by the isolated worker.
// Fresh read-only Codex session; transcript cannot authorize filesystem changes.
export function createCodexDocumentGenerator({binary=process.env.ANC_CODEX_BIN||'codex',cwd,timeoutMs=120000}={}) {
  if(!cwd)throw Error('GENERATOR_DIRECTORY_REQUIRED');
  return ({prompt})=>new Promise((resolve,reject)=>{
    const env=Object.fromEntries(['HOME','USER','PATH','TMPDIR','CODEX_HOME'].filter(k=>process.env[k]!==undefined).map(k=>[k,process.env[k]]));
    const child=spawn(binary,['--sandbox','read-only','--ask-for-approval','never','-c','web_search="disabled"','exec','--ignore-user-config','--skip-git-repo-check','--json','-'],{cwd,env,detached:true,stdio:['pipe','pipe','pipe']});
    let out='',size=0,failed=false,killTimer;
    const stop=()=>{failed=true;try{process.kill(-child.pid,'SIGTERM');}catch{};killTimer??=setTimeout(()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}},2000);killTimer.unref();};
    const timer=setTimeout(stop,timeoutMs);
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>4*1024*1024)stop();else out+=chunk.toString();});
    child.stderr.on('data',()=>{});child.stdin.on('error',()=>{});
    child.on('error',()=>{clearTimeout(timer);reject(Error('GENERATOR_UNAVAILABLE'));});
    child.on('close',code=>{clearTimeout(timer);clearTimeout(killTimer);
      try{
        if(failed||code!==0)throw Error();
        const events=out.trim().split('\n').map(s=>JSON.parse(s));
        if(!events.some(e=>e.type==='turn.completed'))throw Error();
        const raw=events.findLast(e=>e.type==='item.completed'&&e.item?.type==='agent_message')?.item.text;
        resolve(JSON.parse(raw));
      }catch{reject(Error('GENERATOR_FAILED'));}
    });
    child.stdin.end(prompt);
  });
}

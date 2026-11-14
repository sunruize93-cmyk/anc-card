"""Single synthetic remote job. Never imported by the ANC production service."""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import time
import urllib.request
import uuid

FILES = ['totals.mjs', 'README.md']
TASK = 'anc-remote-codex-20261114-01'
PROMPT = '''Create only totals.mjs and README.md in the current isolated directory.
totals.mjs must export function sumPositive(values): return 0 for null or undefined;
otherwise sum only finite positive numeric array entries, ignoring strings, zero,
negative numbers, NaN and infinities. Empty array returns 0.
README.md must describe the function and show null, empty array and mixed array examples.
No imports, dependencies, network, subprocesses, credentials or access outside this
directory. Do not write any other files. Do not install or publish anything.
This is a bounded synthetic task. Use built-in editing tools; do not ask for escalation.
'''


def save(path, value):
    temporary = path.with_suffix('.tmp')
    with open(temporary, 'w', encoding='utf-8') as out:
        json.dump(value, out, ensure_ascii=False)
        out.flush()
        os.fsync(out.fileno())
    os.replace(temporary, path)
    fd = os.open(path.parent, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def run_once(root, config, delivery_id, executable='codex'):
    if config.get('taskId') != TASK or not re.fullmatch(r'[A-Za-z0-9_-]{1,120}', delivery_id):
        raise ValueError('Unexpected task or delivery identifier')
    uuid.UUID(config['nonce'])
    if time.time() > config['expiresAt']:
        raise ValueError('Expired dispatch')
    canonical = {k: config[k] for k in ['taskId', 'nonce', 'expiresAt', 'callback']}
    binding = hashlib.sha256(json.dumps(canonical, sort_keys=True).encode()).hexdigest()
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    taskdir = root / TASK
    taskdir.mkdir(exist_ok=True)
    state_path = taskdir / 'state.json'
    with open(taskdir / 'lock', 'a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if state_path.exists():
            state = json.loads(state_path.read_text())
            if state['binding'] != binding:
                raise ValueError('Existing task has a different dispatch binding')
            state['deliveryIds'] = sorted(set(state['deliveryIds'] + [delivery_id]))
            save(state_path, state)
            return {**state, 'eventId': str(uuid.uuid4()), 'deliveryId': delivery_id,
                    'duplicate': True, 'nonce': config['nonce']}
        work = taskdir / 'work'
        work.mkdir()
        args = [executable, '--sandbox', 'workspace-write', '--ask-for-approval', 'never',
                '-c', 'sandbox_mode="workspace-write"',
                '-c', 'web_search="disabled"',
                '-c', 'sandbox_workspace_write.network_access=false',
                '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true',
                '-c', 'sandbox_workspace_write.exclude_slash_tmp=true',
                '-c', 'model_reasoning_effort="low"',
                'exec', '--ignore-user-config', '--skip-git-repo-check', '--json', '-']
        state = {'taskId': TASK, 'binding': binding, 'runId': str(uuid.uuid4()),
                 'status': 'reserved', 'executionCount': 0, 'deliveryIds': [delivery_id],
                 'workspace': str(work), 'argv': args, 'promptSha256': hashlib.sha256(PROMPT.encode()).hexdigest(),
                 'artifacts': [], 'startedAt': time.time()}
        # A crash after reservation requires manual reconciliation, never automatic re-execution.
        save(state_path, state)
        env = {k: os.environ[k] for k in ['HOME', 'USER', 'PATH', 'CODEX_HOME', 'SSL_CERT_FILE'] if k in os.environ}
        try:
            state['codexVersion'] = subprocess.check_output([executable, '--version'], env=env, timeout=15, text=True).strip()[:120]
            with open(taskdir / 'events.jsonl', 'w') as output, open(taskdir / 'stderr.log', 'w') as error:
                proc = subprocess.Popen(args, cwd=work, env=env, stdin=subprocess.PIPE,
                                        stdout=output, stderr=error, text=True, start_new_session=True)
                state.update(status='running', executionCount=1, pid=proc.pid)
                save(state_path, state)
                try:
                    proc.communicate(PROMPT, timeout=240)
                except subprocess.TimeoutExpired:
                    os.killpg(proc.pid, signal.SIGKILL)
                    proc.wait()
                    state['timedOut'] = True
                state['exitCode'] = proc.returncode
            raw = (taskdir / 'events.jsonl').read_bytes()
            state['eventsSha256'] = hashlib.sha256(raw).hexdigest()
            state['eventTypes'] = []
            for line in raw.decode(errors='replace').splitlines():
                try:
                    event = json.loads(line)
                except ValueError:
                    continue
                state['eventTypes'].append(event.get('type'))
                if event.get('type') == 'thread.started':
                    state['sessionId'] = event.get('thread_id')
            actual = sorted(str(p.relative_to(work)) for p in work.rglob('*'))
            state['actualFiles'] = actual
            if actual != sorted(FILES):
                raise ValueError('Artifact file scope mismatch')
            for name in FILES:
                p = work / name
                if p.is_symlink() or not p.is_file() or p.stat().st_size > 12000:
                    raise ValueError('Invalid artifact')
                content = p.read_text(encoding='utf-8')
                state['artifacts'].append({'name': name, 'content': content,
                                          'sha256': hashlib.sha256(content.encode()).hexdigest()})
            state['status'] = 'completed' if (state['exitCode'] == 0 and state.get('sessionId') and
                        'turn.completed' in state['eventTypes'] and 'turn.failed' not in state['eventTypes']) else 'failed'
        except Exception as exc:
            state['status'] = 'failed'
            state['errorType'] = type(exc).__name__
        state['finishedAt'] = time.time()
        save(state_path, state)
        return {**state, 'eventId': str(uuid.uuid4()), 'deliveryId': delivery_id,
                'duplicate': False, 'nonce': config['nonce']}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--config', required=True)
    ap.add_argument('--delivery-id', required=True)
    args = ap.parse_args()
    config = json.loads(Path(args.config).read_text())
    if not re.fullmatch(r'https://webhook\.site/[0-9a-f-]{36}', config['callback']):
        raise ValueError('Unexpected test receiver')
    result = run_once('/workspace/anc-remote-codex-trial', config, args.delivery_id)
    req = urllib.request.Request(config['callback'], data=json.dumps(result).encode(),
                                 headers={'Content-Type': 'application/json'}, method='POST')
    # One attempt only. If the response is lost, reconcile receiver logs instead of rerunning Codex.
    with urllib.request.urlopen(req, timeout=15) as response:
        print(json.dumps({'taskId': TASK, 'status': result['status'], 'duplicate': result['duplicate'],
                          'executionCount': result['executionCount'], 'httpStatus': response.status}))


if __name__ == '__main__':
    main()

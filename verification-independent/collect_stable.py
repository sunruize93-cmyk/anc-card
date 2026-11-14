#!/usr/bin/env python3
"""Explicit stable JSON export acquisition; never discovers files or opens databases."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
from datetime import datetime, timezone
sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parent.parent
DEST = ROOT/'.anc-data/independent-verification-20261114'

def capture(path, outdir):
    p = Path(path).absolute()
    if p.suffix.lower() not in ('.json','.jsonl') or p.is_symlink():
        raise ValueError('not an allowed export')
    forbidden = ('bootstrap','keychain','credential','certificate','private-key','config','install')
    if any(x in p.name.lower() for x in forbidden):
        raise ValueError('excluded export filename')
    a = p.stat()
    if not stat.S_ISREG(a.st_mode) or a.st_size > 16*1024*1024:
        raise ValueError('not a bounded regular export')
    first = p.read_bytes()
    b = p.stat()
    second = p.read_bytes()
    c = p.stat()
    entry = dict(source=str(p), capturedAt=datetime.now(timezone.utc).isoformat(), bytes=len(first))
    if (a.st_size,a.st_mtime_ns,a.st_ino)!=(b.st_size,b.st_mtime_ns,b.st_ino) or (b.st_size,b.st_mtime_ns,b.st_ino)!=(c.st_size,c.st_mtime_ns,c.st_ino) or first!=second:
        return dict(entry,status='unknown',reason='SOURCE_CHANGING_NO_COPY')
    try:
        if p.suffix == '.jsonl':
            if first and not first.endswith(b'\n'):
                raise ValueError('incomplete tail')
            data=[json.loads(line) for line in first.decode().splitlines() if line.strip()]
        else:
            data=json.loads(first)
    except (ValueError,UnicodeError):
        return dict(entry,status='unknown',reason='PARTIAL_OR_INVALID_JSON_NO_COPY')
    digest = hashlib.sha256(first).hexdigest()
    target=outdir/(digest+p.suffix)
    if not target.exists():
        fd=os.open(str(target),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'wb') as f: f.write(first)
    elif hashlib.sha256(target.read_bytes()).hexdigest()!=digest:
        raise ValueError('existing copy hash mismatch')
    return dict(entry,status='captured',sha256=digest,copy=str(target),sourceMtimeNs=c.st_mtime_ns,
                rootType=type(data).__name__)

def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--batch',required=True)
    p.add_argument('exports',nargs='+')
    a=p.parse_args()
    if not a.batch.replace('-','').replace('_','').isalnum():
        raise SystemExit('invalid batch')
    out=DEST/'inputs'/a.batch
    out.mkdir(mode=0o700,parents=True,exist_ok=True)
    DEST.chmod(0o700)
    (DEST/'inputs').chmod(0o700)
    entries=[]
    for path in a.exports:
        try: entries.append(capture(path,out))
        except (OSError,ValueError): entries.append(dict(source=str(Path(path).absolute()),status='unknown',reason='UNAVAILABLE_OR_EXCLUDED'))
    manifest=DEST/('manifest-'+a.batch+'.json')
    if manifest.exists(): raise SystemExit('batch already exists; use a new batch name')
    fd=os.open(str(manifest),os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
    with os.fdopen(fd,'w') as f: json.dump(dict(schemaVersion=1,inputs=entries),f,ensure_ascii=False,indent=2)
    print(json.dumps(dict(manifest=str(manifest),captured=sum(x['status']=='captured' for x in entries),unknown=sum(x['status']!='captured' for x in entries))))

if __name__=='__main__': main()

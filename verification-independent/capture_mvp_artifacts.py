"""Capture only the four explicitly authorized MVP artifact files; never execute them."""
import argparse,hashlib,json,os
from pathlib import Path
from datetime import datetime,timezone
ROOT=Path(__file__).resolve().parent.parent
DEST=ROOT/'.anc-data/independent-verification-20261114'

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--new-phone',action='store_true');args=parser.parse_args()
    batch='mvp-new-phone-artifacts' if args.new_phone else 'document-cutover-artifacts'
    source_root=ROOT/'.anc-data/field-20261114'/('mvp-90min/final-chain' if args.new_phone else 'document-cutover')
    out=DEST/'inputs'/batch;out.mkdir(mode=0o700,parents=True,exist_ok=True)
    entries=[]
    for round_number in (1,2):
        for name in ('totals.mjs','README.md'):
            source=source_root/(('round%d' if args.new_phone else 'executor-round%d')%round_number)/name
            a=source.stat();raw=source.read_bytes();b=source.stat();again=source.read_bytes()
            if source.is_symlink() or len(raw)>1024*1024 or (a.st_size,a.st_mtime_ns)!=(b.st_size,b.st_mtime_ns) or raw!=again:
                raise ValueError('artifact unstable or invalid')
            digest=hashlib.sha256(raw).hexdigest();target=out/(digest+source.suffix)
            if not target.exists():
                with os.fdopen(os.open(target,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'wb') as f:f.write(raw)
            entries.append(dict(source=str(source),copy=str(target),sha256=digest,bytes=len(raw),round=round_number,name=name,capturedAt=datetime.now(timezone.utc).isoformat(),sourceMtimeNs=b.st_mtime_ns,status='captured'))
    p=DEST/('manifest-'+batch+'.json')
    with os.fdopen(os.open(p,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600),'w') as f:json.dump(dict(inputs=entries),f,indent=2)
    print('Captured four explicitly named artifact files; none executed.')
if __name__=='__main__':main()

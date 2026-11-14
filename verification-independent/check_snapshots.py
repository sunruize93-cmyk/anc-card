#!/usr/bin/env python3
"""Read explicit, hash-pinned export bundles. Snapshot facts are not invented events."""
import argparse
from collections import Counter
from datetime import datetime
import hashlib
import json
from pathlib import Path
import stat
import sys
sys.dont_write_bytecode = True
from check_evidence import load_export


def upload_local_id(record):
    # Observed iOS contract: BackgroundUploader.swift uses the optional override,
    # otherwise the already-persisted record.id. This is not a fabricated ID.
    return record.get('uploadLocalID') if record.get('uploadLocalID') is not None else record.get('id')


def load_bundle(path):
    spec = load_export(path)
    if not isinstance(spec, dict) or not isinstance(spec.get('inputs'), list):
        raise ValueError('invalid bundle')
    datasets = []
    for item in spec['inputs']:
        if not isinstance(item, dict) or not all(isinstance(item.get(k), str) for k in ('file','sha256','role','label')):
            raise ValueError('invalid manifest input')
        # Only the explicitly named copies; never read source or linked application data.
        p = Path(item['file'])
        if p.suffix not in ('.json','.jsonl') or p.is_symlink():
            raise ValueError('invalid input')
        info=p.stat()
        if not stat.S_ISREG(info.st_mode) or info.st_size>16*1024*1024:
            raise ValueError('invalid input')
        raw=p.read_bytes()
        digest = hashlib.sha256(raw).hexdigest()
        if digest != item['sha256']:
            raise ValueError('input hash mismatch')
        data=([json.loads(line) for line in raw.decode().splitlines() if line.strip()]
              if p.suffix=='.jsonl' else json.loads(raw))
        datasets.append(dict(role=item['role'], label=item['label'], data=data,
                             provenance=item.get('provenance',{}),inputSha256=digest,inputBytes=len(raw)))
    return analyze(datasets)


def analyze(datasets):
    findings=[]
    def add(scope,status,code,ref=None,details=None):
        f=dict(scope=scope,status=status,code=code)
        if ref is not None: f['ref']=ref
        if details is not None: f['details']=details
        findings.append(f)
    groups={}
    phone_provenance=None
    for d in datasets:
        provenance=d.get('provenance',{})
        if d.get('role') in ('phone_state','backend_recordings','gateway_uploads'):
            if phone_provenance is None:
                phone_provenance=provenance
            elif provenance!=phone_provenance:
                add('input','unknown','PHONE_PROVENANCE_COHORT_MISMATCH_EXCLUDED')
                continue
        key=(d.get('role'),d.get('label'))
        if key in groups:
            add('input','fail','DUPLICATE_ROLE_LABEL')
        groups[key]=d
        if not all(k in provenance for k in ('systemObservation','workload','authorization')):
            add('input','unknown','PROVENANCE_DIMENSIONS_MISSING')
    phones={label:d['data'] for (role,label),d in groups.items() if role=='phone_state'}
    backends={label:d['data'] for (role,label),d in groups.items() if role=='backend_recordings'}
    gateway=[row for (role,_),d in groups.items() if role=='gateway_uploads' and isinstance(d['data'],list) for row in d['data']]
    aliases={}
    def alias(rid):
        if rid not in aliases: aliases[rid]='R%d' % (len(aliases)+1)
        return aliases[rid]
    local_bindings,card_bindings,message_bindings={}, {}, {}
    states={}
    for label,state in phones.items():
        if not isinstance(state,dict) or not isinstance(state.get('recordings'),list):
            add('phone','unknown','PHONE_STATE_MISSING'); continue
        records={}
        for r in state['recordings']:
            if not isinstance(r,dict) or not isinstance(r.get('sha256'),str):
                add('phone','unknown','PHONE_RECORDING_HASH_MISSING'); continue
            rid=r['sha256']; ref=alias(rid)
            if rid in records: add('phone','fail','DUPLICATE_LOCAL_RECORD',ref)
            records[rid]=r
            rec=r.get('receipt')
            if rec is None:
                add('phone','observed','UPLOAD_PENDING_SNAPSHOT',ref)
                continue
            if not isinstance(rec,dict):
                add('phone','unknown','INVALID_RECEIPT',ref); continue
            integrity_fields=[(r.get('sha256'),rec.get('sha256')),(r.get('sha256'),rec.get('recordingId')),
                              (r.get('bytes'),rec.get('bytes')),(upload_local_id(r),rec.get('localId'))]
            if any(a is None or b is None for a,b in integrity_fields):
                add('phone','unknown','RECEIPT_BINDING_FIELDS_MISSING',ref)
            elif any(a!=b for a,b in integrity_fields):
                add('phone','fail','RECEIPT_BINDING_MISMATCH',ref)
            else: add('phone','pass','PHONE_RECEIPT_BINDINGS_MATCH',ref)
            local=rec.get('localId')
            if isinstance(local,str):
                if local in local_bindings and local_bindings[local]!=rid:
                    add('phone','fail','LOCAL_ID_REBOUND',ref)
                local_bindings[local]=rid
            if type(rec.get('duplicate')) is not bool:
                add('phone','unknown','DUPLICATE_FLAG_MISSING',ref)
            delivery=r.get('delivery',{})
            fs=delivery.get('feishu',{}) if isinstance(delivery,dict) else {}
            msg=fs.get('messageId')
            if isinstance(msg,str) and msg:
                if delivery.get('recordingId')!=rid:
                    add('phone','fail','DELIVERY_RECORDING_MISMATCH',ref)
                if rid in card_bindings and card_bindings[rid]!=msg:
                    add('phone','fail','RECORDING_CARD_CHANGED',ref)
                if msg in message_bindings and message_bindings[msg]!=rid:
                    add('phone','fail','CARD_SHARED_ACROSS_RECORDINGS',ref)
                card_bindings[rid]=msg; message_bindings[msg]=rid
                if fs.get('state')=='complete' and delivery.get('status')=='complete':
                    add('phone','pass','RECORDING_RESULT_CARD_REPORTED_COMPLETE',ref)
                else: add('phone','unknown','RECORDING_CARD_NOT_COMPLETE',ref)
            else: add('phone','unknown','RECORDING_RESULT_CARD_MISSING',ref)
        states[label]=records
    latest=states.get('network_restored') or states.get('lock_success') or states.get('foreground_refined') or {}
    backend_list=backends.get('network_restored') or backends.get('lock_success') or backends.get('foreground_refined') or []
    backend={}
    for r in backend_list if isinstance(backend_list,list) else []:
        if isinstance(r,dict) and isinstance(r.get('id'),str):
            if r['id'] in backend: add('phone','fail','DUPLICATE_BACKEND_RECORDING',alias(r['id']))
            backend[r['id']]=r
    records_report=[]
    for rid,r in latest.items():
        ref=alias(rid); rec=r.get('receipt') or {}; b=backend.get(rid)
        row=dict(ref=ref,receiptDuplicate=rec.get('duplicate'),bytes=r.get('bytes'),
                 hasReceipt=bool(rec),hasResultCard=rid in card_bindings)
        if not b: add('phone','unknown','BACKEND_RECORDING_EXPORT_MISSING',ref)
        else:
            if b.get('status')!='complete': add('phone','unknown','BACKEND_PROCESSING_INCOMPLETE',ref)
            segs=b.get('transcript')
            if not isinstance(segs,list) or not segs:
                add('phone','unknown','TRANSCRIPT_EXPORT_MISSING',ref)
            else:
                end=0; okay=True
                for s in segs:
                    if not isinstance(s,dict) or type(s.get('startMs')) is not int or type(s.get('endMs')) is not int or not isinstance(s.get('text'),str) or not s['text']:
                        add('phone','unknown','TRANSCRIPT_FIELDS_MISSING',ref); okay=False; continue
                    if s['startMs']<end or s['endMs']<=s['startMs']:
                        add('phone','fail','TRANSCRIPT_RANGE_CONTRADICTION',ref); okay=False
                    end=s['endMs']
                if okay: add('phone','pass','TRANSCRIPT_ORDER_INTERNAL_CONSISTENCY',ref)
                row['transcriptSegments']=len(segs); row['transcriptEndMs']=end
                row['timingMethods']=sorted({str(s.get('timingMethod','unknown')) for s in segs if isinstance(s,dict)})
                row['transcriptionEngines']=sorted({str(s.get('engine','unknown')) for s in segs if isinstance(s,dict)})
                add('phone','unknown','INDEPENDENT_AUDIO_DURATION_NOT_EXPORTED',ref)
            row['candidateTaskCount']=len(b.get('ledger') or [])
        matches=[g for g in gateway if isinstance(g,dict) and g.get('localId')==upload_local_id(r)]
        if not matches: add('phone','unknown','GATEWAY_EVENT_MISSING',ref)
        elif any(g.get('sha256')!=rid for g in matches): add('phone','fail','GATEWAY_HASH_MISMATCH',ref)
        else:
            add('phone','pass','GATEWAY_LOCAL_ID_HASH_MATCH',ref)
            if rec and not any(g.get('duplicate') in (True,False,0,1) and bool(g['duplicate'])==rec.get('duplicate') for g in matches):
                add('phone','fail','GATEWAY_DUPLICATE_FLAG_CONTRADICTION',ref)
        row['matchingGatewayRows']=len(matches)
        records_report.append(row)
    offline=states.get('offline',{})
    offline_backend=backends.get('offline',[])
    offline_ids={x.get('id') for x in offline_backend if isinstance(x,dict)} if isinstance(offline_backend,list) else set()
    transitions=[]
    for rid,r in offline.items():
        if not r.get('receipt') and rid in latest:
            after=latest[rid]; ref=alias(rid)
            same_fields=('id','sha256','bytes')
            if any(r.get(f) is None or after.get(f) is None for f in same_fields):
                add('phone','unknown','OFFLINE_IDENTITY_FIELDS_MISSING',ref)
            elif any(r[f]!=after[f] for f in same_fields) or upload_local_id(r)!=upload_local_id(after):
                add('phone','fail','OFFLINE_RESTORE_IDENTITY_CHANGED',ref)
            elif after.get('receipt') and rid not in offline_ids and rid in backend:
                add('phone','pass','OFFLINE_PENDING_TO_RECEIPTED_SAME_LOCAL_RECORD',ref)
                transitions.append(ref)
            else: add('phone','unknown','OFFLINE_RESTORE_CHAIN_INCOMPLETE',ref)
    if not phones: add('phone','unknown','PHONE_EXPORTS_MISSING')
    if phones:
        add('phone','unknown','PHYSICAL_SAVE_AND_NO_MANUAL_IMPORT_NOT_IN_JSON')
        add('phone','unknown','LOCK_SCREEN_OBSERVATION_REQUIRES_FIELD_ATTESTATION')
        add('phone','unknown','NO_GLOBAL_EVENT_COMPLETENESS_PROOF')
        add('phone','unknown','INDEPENDENT_AUDIO_HASH_NOT_RECOMPUTED')
    executors=[]
    for (role,label),d in groups.items():
        if role!='executor_summary': continue
        e=d['data']; p=d.get('provenance',{})
        if not isinstance(e,dict): add('executor','unknown','EXECUTOR_SUMMARY_INVALID'); continue
        rounds=e.get('rounds'); sid=e.get('sessionId')
        ex=dict(label=label,provenance=p,rounds=len(rounds) if isinstance(rounds,list) else 0,
                taskPresent=bool(e.get('taskId')),recordingLinked=bool(e.get('recordingId')),status=e.get('status'),
                feishuConfirmationProven=False)
        if not isinstance(rounds,list) or len(rounds)<2:
            add('executor','unknown','TWO_ROUNDS_NOT_EXPORTED')
        elif not sid or any(not isinstance(r,dict) or not r.get('sessionId') for r in rounds):
            add('executor','unknown','ROUND_SESSION_MISSING')
        elif any(r['sessionId']!=sid for r in rounds):
            add('executor','fail','ROUND_SESSION_MISMATCH')
        else: add('executor','pass','TWO_ROUND_SESSION_IDS_MATCH')
        if isinstance(rounds,list):
            numbers=[r.get('round') for r in rounds if isinstance(r,dict)]
            if numbers!=list(range(1,len(rounds)+1)): add('executor','unknown','ROUND_ORDER_NOT_ESTABLISHED')
            workspaces={r.get('workspaceId') for r in rounds if isinstance(r,dict)}
            if len(workspaces)>1: add('executor','fail','ROUND_WORKSPACE_CHANGED')
            elif workspaces and None not in workspaces: add('executor','pass','ROUND_WORKSPACE_IDS_MATCH')
            for i,r in enumerate(rounds):
                if not isinstance(r,dict): continue
                if not r.get('contractDigest'): add('executor','unknown','ROUND_CONTRACT_DIGEST_MISSING', 'round-%d'%(i+1))
                arts=r.get('artifacts')
                if not isinstance(arts,list) or not arts: add('executor','unknown','ROUND_ARTIFACT_MANIFEST_MISSING','round-%d'%(i+1))
                elif not all(isinstance(a,dict) and isinstance(a.get('sha256'),str) and len(a['sha256'])==64 and type(a.get('bytes')) is int for a in arts):
                    add('executor','unknown','ROUND_ARTIFACT_MANIFEST_INCOMPLETE','round-%d'%(i+1))
                else: add('executor','pass','ROUND_ARTIFACT_MANIFEST_PRESENT','round-%d'%(i+1))
        for code in ('AUTHORIZATION_EVENT_HISTORY_NOT_EXPORTED','RUN_START_EVENT_HISTORY_NOT_EXPORTED',
                     'EXECUTOR_ASSERTIONS_ARE_SOURCE_REPORT',
                     'NO_REAL_FEISHU_APPROVAL_OR_TASK_CARD_UPDATE'):
            add('executor','unknown',code)
        executors.append(ex)
    handoff_count=0
    for (role,_),d in groups.items():
        if role!='executor_handoff': continue
        h=d['data']
        if not isinstance(h,dict) or h.get('format')!='anc-executor-snapshot-export-v1':
            add('executor','unknown','UNSUPPORTED_HANDOFF_FORMAT'); continue
        handoff_count+=1
        source=h.get('source',{}); snapshot=h.get('snapshot',{})
        originals=[v for (r,_),v in groups.items() if r=='executor_summary' and v.get('inputSha256')==source.get('evidenceSha256') and v.get('inputSha256')]
        if not originals:
            add('executor','unknown','HANDOFF_SOURCE_NOT_IN_PINNED_INPUTS')
        else:
            original=originals[0]
            if original.get('inputBytes')!=source.get('evidenceBytes'):
                add('executor','fail','HANDOFF_SOURCE_SIZE_MISMATCH')
            else: add('executor','pass','HANDOFF_SOURCE_HASH_AND_BYTES_MATCH')
            original_data=original['data']
            if any(snapshot.get(f)!=original_data.get(f) for f in ('taskId','sessionId','status')):
                add('executor','fail','HANDOFF_TASK_SESSION_STATUS_CHANGED')
            else: add('executor','pass','HANDOFF_TASK_SESSION_STATUS_MATCH')
            comparable=('round','sessionId','workspaceId','contractDigest','artifacts','acceptance','checks')
            original_rounds=[{k:r.get(k) for k in comparable} for r in original_data.get('rounds',[])]
            copied_rounds=[{k:r.get(k) for k in comparable} for r in snapshot.get('rounds',[])]
            if original_rounds!=copied_rounds: add('executor','fail','HANDOFF_ROUND_FIELDS_CHANGED')
            else: add('executor','pass','HANDOFF_ROUND_FIELDS_MATCH')
        verified_rounds={}
        for a in h.get('artifacts',[]):
            if not isinstance(a,dict) or not isinstance(a.get('content'),str):
                add('executor','unknown','HANDOFF_ARTIFACT_CONTENT_MISSING'); continue
            raw=a['content'].encode('utf-8')
            if hashlib.sha256(raw).hexdigest()!=a.get('sha256') or len(raw)!=a.get('bytes'):
                add('executor','fail','HANDOFF_ARTIFACT_HASH_OR_BYTES_MISMATCH'); continue
            rounds=snapshot.get('rounds',[])
            matches=[r for r in rounds if r.get('round')==a.get('associatedRound')]
            expected=[x for r in matches for x in r.get('artifacts',[]) if x.get('name')==a.get('name')]
            if len(expected)!=1:
                add('executor','unknown','HANDOFF_ARTIFACT_ROUND_BINDING_MISSING'); continue
            if any(expected[0].get(f)!=a.get(f) for f in ('sha256','bytes')):
                add('executor','fail','HANDOFF_ARTIFACT_ROUND_MANIFEST_MISMATCH'); continue
            verified=verified_rounds.setdefault(a['associatedRound'],set())
            if a.get('name') in verified:
                add('executor','fail','HANDOFF_DUPLICATE_ARTIFACT'); continue
            verified.add(a.get('name'))
            add('executor','pass','EXPORTED_ARTIFACT_CONTENT_HASH_AND_ROUND_MATCH','round-%s'%a['associatedRound'])
        for r in snapshot.get('rounds',[]):
            if {a.get('name') for a in r.get('artifacts',[])}-verified_rounds.get(r.get('round'),set()):
                add('executor','unknown','ROUND_ARTIFACT_BYTES_NOT_EXPORTED','round-%s'%r.get('round'))
        if not verified_rounds: add('executor','unknown','ARTIFACT_BYTES_NOT_INDEPENDENTLY_REHASHED')
    if executors and not handoff_count:
        add('executor','unknown','ARTIFACT_BYTES_NOT_INDEPENDENTLY_REHASHED')
    for (role,_),d in groups.items():
        if role!='executor_export_manifest': continue
        manifest=d['data']
        entries=[e for e in manifest.get('files',[]) if Path(e.get('path','')).name=='snapshot.json']
        handoffs=[v for (r,_),v in groups.items() if r=='executor_handoff']
        if len(entries)!=1 or len(handoffs)!=1:
            add('executor','unknown','HANDOFF_MANIFEST_LINK_MISSING')
        elif entries[0].get('sha256')!=handoffs[0].get('inputSha256') or entries[0].get('bytes')!=handoffs[0].get('inputBytes'):
            add('executor','fail','HANDOFF_MANIFEST_HASH_OR_BYTES_MISMATCH')
        else: add('executor','pass','HANDOFF_MANIFEST_HASH_AND_BYTES_MATCH')
    if not executors: add('executor','unknown','EXECUTOR_EXPORT_MISSING')
    add('end_to_end','unknown','NO_SAME_RECORDING_TASK_AUTH_SESSION_CARD_CHAIN')
    return dict(schemaVersion=2,analysisMode='snapshot_relationships_not_event_reconstruction',
                authenticityVerified=False,globalAbsenceProven=False,
                provenanceDimensions=['systemObservation','workload','authorization'],
                status='contradiction_found' if any(f['status']=='fail' for f in findings) else 'partial_evidence',
                phone=dict(provenance=phone_provenance,records=records_report,offlineRestoredRecords=transitions),executors=executors,
                findings=findings)


def human(report):
    lines=['真实导出证据关系检查：'+report['status'],
           '快照关联不等于事件顺序；来源真实性与未导出事件均未认证。',
           '手机链与本机执行器链独立分析，不拼成端到端通过。', '']
    for row in report['phone']['records']:
        lines.append(json.dumps(row,ensure_ascii=False))
    for e in report['executors']: lines.append(json.dumps(e,ensure_ascii=False))
    lines.append('')
    seen=set()
    for f in report['findings']:
        line='%s | %s | %s%s' % (f['scope'],f['status'],f['code'],(' | '+f['ref']) if f.get('ref') else '')
        if line not in seen: lines.append(line); seen.add(line)
    return '\n'.join(lines)+'\n'


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('bundle'); p.add_argument('--format',choices=['json','text'],default='json')
    a=p.parse_args()
    try: report=load_bundle(a.bundle)
    except (OSError,ValueError,TypeError,KeyError):
        print('{"status":"unknown","error":"INVALID_OR_HASH_MISMATCHED_INPUT"}'); return 2
    print(json.dumps(report,ensure_ascii=False,indent=2) if a.format=='json' else human(report))
    return 1 if report['status']=='contradiction_found' else 2

if __name__=='__main__': sys.exit(main())

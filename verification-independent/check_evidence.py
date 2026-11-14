#!/usr/bin/env python3
"""Offline export consistency checker. Standard library only; no application imports."""
import argparse
import json
import re
import stat
import sys
from pathlib import Path
sys.dont_write_bytecode = True
from export_adapters import normalize_event

LIMIT = 16 * 1024 * 1024
KINDS = {
    'audio': 'recordingId sha256 bytes durationMs',
    'upload': 'recordingId localId sha256 bytes duplicate',
    'transcript': 'recordingId segments',
    'task': 'taskId recordingId semanticKey version owner proposalId contractDigest evidence',
    'authorization': 'taskId authorizationId owner version proposalId contractDigest channel messageId decision',
    'execution_start': 'taskId runId authorizationId approvedVersion proposalId contractDigest sessionId mode',
    'execution_result': 'taskId runId authorizationId approvedVersion contractDigest sessionId disposition',
    'task_state': 'taskId version state',
    'card': 'recordingId messageId operation cardKind',
}
SECRET_KEYS = {'token', 'accesstoken', 'refreshtoken', 'authorizationheader', 'apikey',
               'password', 'secret', 'device', 'deviceid', 'udid', 'audio', 'audiobase64'}


def sensitive(value):
    if isinstance(value, dict):
        return any(re.sub('[^a-z]', '', str(k).lower()) in SECRET_KEYS or sensitive(v)
                   for k, v in value.items())
    if isinstance(value, list):
        return any(sensitive(v) for v in value)
    return isinstance(value, str) and bool(re.search(r'(?i)Bearer\s+\S+|-----BEGIN .*PRIVATE KEY', value))


def adapt(document):
    """Explicit adapter boundary. Never infer approvals or event order from snapshots."""
    if isinstance(document, list):
        return document
    if isinstance(document, dict) and isinstance(document.get('events'), list):
        return document['events']
    return [document]


def check(document):
    events = adapt(document)
    output = {'schemaVersion': 1, 'scope': 'exported_events_internal_consistency_only',
              'provenanceVerified': False, 'globalAbsenceProven': False, 'groups': {}}
    for provenance in ('simulated', 'real', 'unspecified'):
        selected = [(i + 1, e) for i, e in enumerate(events)
                    if (e.get('provenance') if isinstance(e, dict) else None) == provenance or
                    (provenance == 'unspecified' and
                     (not isinstance(e, dict) or e.get('provenance') not in ('simulated', 'real')))]
        issues, counts = [], {}
        def issue(status, code, index, field=None):
            entry = {'status': status, 'code': code, 'eventIndex': index}
            if field is not None:
                entry['field'] = field
            issues.append(entry)
        if not selected:
            output['groups'][provenance] = {'status': 'unknown', 'events': 0,
                'issues': [{'status': 'unknown', 'code': 'NO_EVIDENCE', 'eventIndex': None}]}
            continue
        if provenance == 'unspecified':
            issue('unknown', 'PROVENANCE_MISSING_OR_UNSUPPORTED', None)
        audio, uploads, transcripts, tasks, semantic, auths, runs, cards = {}, {}, {}, {}, {}, {}, {}, {}
        local_ids, sessions, messages, seen, last_seq = {}, {}, {}, {}, None
        for index, e in selected:
            if not isinstance(e, dict):
                issue('unknown', 'INVALID_EVENT', index)
                continue
            if sensitive(e):
                issue('fail', 'UNSAFE_EXPORT_FIELDS', index)
            e = normalize_event(e)
            kind = e.get('kind')
            if not isinstance(kind, str) or kind not in KINDS:
                issue('unknown', 'UNSUPPORTED_EVENT_OR_SNAPSHOT', index)
                continue
            fields = ('eventId seq ' + KINDS[kind]).split()
            missing = [f for f in fields if f not in e or e[f] is None or e[f] == '']
            for f in missing:
                issue('unknown', 'MISSING_FIELD', index, f)
            if missing:
                continue
            # Reject container-valued IDs before using them as dictionary keys.
            ids = [f for f in fields if f not in ('seq', 'version', 'approvedVersion', 'bytes',
                                                 'durationMs', 'duplicate', 'segments', 'evidence')]
            if any(not isinstance(e[f], str) for f in ids):
                issue('unknown', 'INVALID_FIELD_TYPE', index)
                continue
            if type(e['seq']) is not int or e['seq'] < 0:
                issue('unknown', 'INVALID_SEQUENCE', index)
                continue
            if e['eventId'] in seen:
                if seen[e['eventId']] != e:
                    issue('fail', 'EVENT_ID_CONFLICT', index)
                continue  # exact replay of an exported event is idempotent
            seen[e['eventId']] = e
            if last_seq is not None and e['seq'] <= last_seq:
                issue('unknown', 'ORDER_NOT_ESTABLISHED', index)
            last_seq = e['seq']
            counts[kind] = counts.get(kind, 0) + 1
            for f in ('version', 'approvedVersion', 'bytes', 'durationMs'):
                if f in e and (type(e[f]) is not int or e[f] <= 0):
                    issue('unknown', 'INVALID_FIELD_TYPE', index, f)
            for f in ('sha256', 'contractDigest'):
                if f in e and (not isinstance(e[f], str) or not re.fullmatch('[0-9a-f]{64}', e[f])):
                    issue('unknown', 'INVALID_DIGEST', index, f)
            rid, tid = e.get('recordingId'), e.get('taskId')
            if kind == 'audio':
                old = audio.get(rid)
                if old and any(old[f] != e[f] for f in ('sha256', 'bytes', 'durationMs')):
                    issue('fail', 'AUDIO_ID_CONFLICT', index)
                audio[rid] = e
            elif kind == 'upload':
                if type(e['duplicate']) is not bool:
                    issue('unknown', 'INVALID_FIELD_TYPE', index, 'duplicate')
                a = audio.get(rid)
                if not a:
                    issue('unknown', 'AUDIO_MANIFEST_MISSING', index)
                elif any(a[f] != e[f] for f in ('sha256', 'bytes')):
                    issue('fail', 'UPLOAD_INTEGRITY_MISMATCH', index)
                if rid != e['sha256']:
                    issue('fail', 'RECORDING_HASH_MISMATCH', index)
                if e['localId'] in local_ids and local_ids[e['localId']] != rid:
                    issue('fail', 'LOCAL_ID_REBOUND', index)
                local_ids[e['localId']] = rid
                if rid in uploads and e['duplicate'] is False:
                    issue('fail', 'DUPLICATE_RECORDING_CREATION', index)
                uploads[rid] = e
            elif kind == 'transcript':
                a = audio.get(rid)
                if not a:
                    issue('unknown', 'AUDIO_MANIFEST_MISSING', index)
                segs = e['segments']
                if not isinstance(segs, list) or not segs:
                    issue('unknown', 'TRANSCRIPT_MISSING', index)
                    continue
                previous = 0
                valid = {}
                for s in segs:
                    if (not isinstance(s, dict) or not isinstance(s.get('segmentId'), str)
                        or not isinstance(s.get('text'), str) or not s['text']
                        or type(s.get('startMs')) is not int or type(s.get('endMs')) is not int):
                        issue('unknown', 'SEGMENT_FIELDS_MISSING', index)
                        continue
                    if s['startMs'] < 0 or s['endMs'] <= s['startMs'] or s['startMs'] < previous:
                        issue('fail', 'TRANSCRIPT_RANGE_INVALID', index)
                    if a and isinstance(a['durationMs'], int) and s['endMs'] > a['durationMs']:
                        issue('fail', 'TRANSCRIPT_OUTSIDE_AUDIO', index)
                    if s['segmentId'] in valid:
                        issue('fail', 'SEGMENT_ID_DUPLICATE', index)
                    previous = s['endMs']
                    valid[s['segmentId']] = s
                if rid in transcripts and transcripts[rid] != valid:
                    issue('unknown', 'TRANSCRIPT_REVISION_UNMODELED', index)
                transcripts[rid] = valid
            elif kind == 'task':
                if rid not in uploads:
                    issue('unknown', 'UPLOAD_MISSING', index)
                if not isinstance(e['evidence'], list) or not e['evidence']:
                    issue('unknown', 'TASK_EVIDENCE_MISSING', index)
                else:
                    for ref in e['evidence']:
                        if not isinstance(ref, dict) or not all(f in ref for f in ('segmentId', 'startMs', 'endMs', 'quote')):
                            issue('unknown', 'TASK_EVIDENCE_FIELDS_MISSING', index)
                            continue
                        s = transcripts.get(rid, {}).get(str(ref['segmentId']))
                        if not s:
                            issue('unknown', 'EVIDENCE_SEGMENT_MISSING', index)
                        elif (ref['startMs'] != s['startMs'] or ref['endMs'] != s['endMs'] or ref['quote'] != s['text']):
                            issue('fail', 'EVIDENCE_QUOTE_OR_RANGE_MISMATCH', index)
                key = (rid, e['semanticKey'])
                if key in semantic and semantic[key] != tid:
                    issue('fail', 'DUPLICATE_TASK_CREATION', index)
                semantic[key] = tid
                old = tasks.get(tid)
                if old and old['recordingId'] != rid:
                    issue('fail', 'TASK_RECORDING_REBOUND', index)
                if old and isinstance(e['version'], int) and isinstance(old['version'], int) and e['version'] <= old['version']:
                    issue('fail', 'TASK_VERSION_NOT_ADVANCING', index)
                if old:
                    for a in auths.values():
                        if a['taskId'] == tid:
                            a['_active'] = False
                tasks[tid] = dict(e, _state='awaiting', _session=old.get('_session') if old else None,
                                  _ownerChanged=bool(old and old['owner'] != e['owner']))
            elif kind == 'card':
                if e['cardKind'] not in ('recording', 'task') or e['operation'] not in ('create', 'update', 'replay'):
                    issue('unknown', 'CARD_ACTION_UNSUPPORTED', index)
                    continue
                if e['cardKind'] == 'task' and not isinstance(tid, str):
                    issue('unknown', 'MISSING_FIELD', index, 'taskId')
                    continue
                target = (e['cardKind'], tid if e['cardKind'] == 'task' else rid)
                if target in cards and cards[target] != e['messageId']:
                    issue('fail', 'WRONG_CARD_OR_DUPLICATE_CREATE', index)
                if e['messageId'] in messages and messages[e['messageId']] != target:
                    issue('fail', 'CARD_CROSS_TASK', index)
                if e['operation'] in ('update', 'replay') and target not in cards:
                    issue('unknown', 'ORIGINAL_CARD_MISSING', index)
                if e['cardKind'] == 'task':
                    if tid not in tasks:
                        issue('unknown', 'TASK_MISSING', index)
                    elif tasks[tid]['recordingId'] != rid:
                        issue('fail', 'CARD_WRONG_RECORDING', index)
                    if e['operation'] == 'update':
                        if not isinstance(e.get('runId'), str):
                            issue('unknown', 'MISSING_FIELD', index, 'runId')
                        elif e['runId'] not in runs:
                            issue('unknown', 'CARD_RESULT_RUN_MISSING', index)
                        elif runs[e['runId']]['taskId'] != tid:
                            issue('fail', 'CARD_RESULT_WRONG_TASK', index)
                        elif not runs[e['runId']].get('_accepted'):
                            issue('fail', 'CARD_PUBLISHES_UNACCEPTED_RESULT', index)
                        else:
                            runs[e['runId']]['_cardUpdated'] = True
                cards[target] = e['messageId']
                messages[e['messageId']] = target
            elif kind == 'authorization':
                t = tasks.get(tid)
                if not t:
                    issue('unknown', 'TASK_MISSING', index)
                else:
                    for field in ('owner', 'version', 'proposalId', 'contractDigest'):
                        if t[field] != e[field]:
                            issue('fail', 'AUTHORIZATION_BINDING_MISMATCH', index, field)
                    if t['_state'] in ('withdrawn', 'paused'):
                        issue('fail', 'AUTHORIZATION_WHILE_INACTIVE', index)
                if e['channel'] != 'feishu':
                    issue('unknown', 'FEISHU_APPROVAL_NOT_EVIDENCED', index)
                expected = cards.get(('task', tid))
                if expected is None:
                    issue('unknown', 'APPROVAL_CARD_MISSING', index)
                elif e['messageId'] != expected:
                    issue('fail', 'APPROVAL_WRONG_CARD', index)
                if e['decision'] not in ('execute', 'acknowledge', 'reject'):
                    issue('unknown', 'AUTHORIZATION_DECISION_UNSUPPORTED', index)
                old = auths.get(e['authorizationId'])
                if old and any(old.get(f) != e.get(f) for f in KINDS[kind].split()):
                    issue('fail', 'AUTHORIZATION_ID_REBOUND', index)
                elif not old:
                    auths[e['authorizationId']] = dict(e, _active=e['decision'] == 'execute')
            elif kind == 'task_state':
                t = tasks.get(tid)
                if not t:
                    issue('unknown', 'TASK_MISSING', index)
                    continue
                if e['state'] not in ('paused', 'resumed', 'withdrawn'):
                    issue('unknown', 'TASK_STATE_UNSUPPORTED', index)
                    continue
                if type(e['version']) is int and type(t['version']) is int and e['version'] <= t['version']:
                    issue('fail', 'TASK_VERSION_NOT_ADVANCING', index)
                t['version'], t['_state'] = e['version'], e['state']
                for a in auths.values():
                    if a['taskId'] == tid:
                        a['_active'] = False
            elif kind in ('execution_start', 'execution_result'):
                t, a = tasks.get(tid), auths.get(e['authorizationId'])
                if not t:
                    issue('unknown', 'TASK_MISSING', index)
                if not a:
                    issue('unknown', 'AUTHORIZATION_MISSING', index)
                else:
                    if a['taskId'] != tid:
                        issue('fail', 'CROSS_TASK_AUTHORIZATION', index)
                    for field, afield in (('approvedVersion', 'version'), ('contractDigest', 'contractDigest')):
                        if e[field] != a[afield]:
                            issue('fail', 'EXECUTION_AUTHORIZATION_MISMATCH', index, field)
                    if kind == 'execution_start' and a['proposalId'] != e['proposalId']:
                        issue('fail', 'EXECUTION_AUTHORIZATION_MISMATCH', index, 'proposalId')
                stale = bool(a and not a['_active']) or bool(t and t['_state'] in ('withdrawn', 'paused'))
                if kind == 'execution_start':
                    if stale:
                        issue('fail', 'EXECUTION_WITHOUT_ACTIVE_APPROVAL', index)
                    if e['mode'] not in ('start', 'resume'):
                        issue('unknown', 'EXECUTION_MODE_UNSUPPORTED', index)
                    if e['runId'] in runs:
                        issue('fail', 'DUPLICATE_RUN_START', index)
                    if any(r['authorizationId'] == e['authorizationId'] for r in runs.values()):
                        issue('fail', 'DUPLICATE_EXECUTION_FOR_APPROVAL', index)
                    if any(r['taskId'] == tid and r['approvedVersion'] == e['approvedVersion']
                           and r['proposalId'] == e['proposalId'] for r in runs.values()):
                        issue('fail', 'DUPLICATE_EXECUTION_FOR_PROPOSAL_VERSION', index)
                    if e['sessionId'] in sessions and sessions[e['sessionId']] != tid:
                        issue('fail', 'CROSS_TASK_SESSION', index)
                    if t:
                        if t.get('_session') and t['_session'] != e['sessionId']:
                            issue('fail', 'SESSION_CHANGED', index)
                        if e['mode'] == 'resume' and not t.get('_session'):
                            issue('unknown', 'RESUME_BASE_SESSION_MISSING', index)
                        if t.get('_ownerChanged'):
                            issue('unknown', 'OWNER_CHANGE_SESSION_POLICY_REVIEW', index)
                        t['_session'] = e['sessionId']
                    sessions[e['sessionId']] = tid
                    runs[e['runId']] = dict(e, _result=False)
                else:
                    r = runs.get(e['runId'])
                    if not r:
                        issue('unknown', 'EXECUTION_START_MISSING', index)
                    else:
                        for f in ('taskId', 'sessionId', 'authorizationId', 'approvedVersion', 'contractDigest'):
                            if r[f] != e[f]:
                                issue('fail', 'RESULT_BINDING_MISMATCH', index, f)
                        if r['_result']:
                            issue('fail', 'DUPLICATE_RESULT_APPLICATION', index)
                        r['_result'] = True
                        r['_accepted'] = e['disposition'] == 'accepted'
                    if e['disposition'] not in ('accepted', 'rejected_stale', 'interrupted'):
                        issue('unknown', 'RESULT_DISPOSITION_UNSUPPORTED', index)
                    if stale and e['disposition'] == 'accepted':
                        issue('fail', 'STALE_OR_WITHDRAWN_RESULT_ACCEPTED', index)
                    if a and a['decision'] != 'execute' and e['disposition'] == 'accepted':
                        issue('fail', 'RESULT_WITHOUT_EXECUTION_APPROVAL', index)
        for rid in audio:
            for container, code in ((uploads, 'UPLOAD_MISSING'), (transcripts, 'TRANSCRIPT_MISSING')):
                if rid not in container:
                    issue('unknown', code, None)
        for tid, t in tasks.items():
            if ('task', tid) not in cards:
                issue('unknown', 'TASK_CARD_MISSING', None)
            if not any(a['taskId'] == tid for a in auths.values()) and t['_state'] != 'withdrawn':
                issue('unknown', 'AUTHORIZATION_MISSING', None)
        for r in runs.values():
            if not r['_result']:
                issue('unknown', 'EXECUTION_RESULT_MISSING', None)
            elif r.get('_accepted') and not r.get('_cardUpdated'):
                issue('unknown', 'RESULT_CARD_UPDATE_MISSING', None)
        for aid, a in auths.items():
            if a['_active'] and not any(r['authorizationId'] == aid for r in runs.values()):
                issue('unknown', 'APPROVED_EXECUTION_START_MISSING', None)
        for kind in ('audio', 'upload', 'transcript', 'task', 'authorization', 'execution_start', 'execution_result', 'card'):
            if not counts.get(kind):
                issue('unknown', 'CHAIN_STAGE_MISSING', None, kind)
        status = 'fail' if any(x['status'] == 'fail' for x in issues) else 'unknown' if issues else 'pass'
        output['groups'][provenance] = {'status': status, 'events': len(selected), 'uniqueEventCounts': counts, 'issues': issues}
    present = [g for g in output['groups'].values() if g['events']]
    output['status'] = ('fail' if any(g['status'] == 'fail' for g in present) else
                        'unknown' if not present or any(g['status'] == 'unknown' for g in present) else 'pass')
    return output


def human(report):
    lines = ['独立离线证据检查：' + report['status'],
             '仅验证所提供导出事件内部一致性；不能证明未导出的全局事件不存在。',
             'provenance 是导出方声明，工具不能认证实测真实性。']
    for name, group in report['groups'].items():
        lines.append('\n%s: %s (%s events)' % (name, group['status'], group['events']))
        for i in group['issues']:
            lines.append('  %s %s event=%s%s' % (i['status'], i['code'], i['eventIndex'],
                         (' field=' + i['field']) if 'field' in i else ''))
    return '\n'.join(lines) + '\n'


def load_export(path):
    p = Path(path)
    if p.suffix.lower() not in ('.json', '.jsonl') or p.is_symlink():
        raise ValueError('input')
    info = p.stat()
    if not stat.S_ISREG(info.st_mode) or info.st_size > LIMIT:
        raise ValueError('input')
    text = p.read_text(encoding='utf-8')
    if p.suffix.lower() == '.jsonl':
        return [json.loads(line) for line in text.splitlines() if line.strip()]
    return json.loads(text)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('export', help='explicit sanitized JSON/JSONL export only')
    parser.add_argument('--format', choices=('json', 'text'), default='json')
    args = parser.parse_args()
    try:
        report = check(load_export(args.export))
    except (OSError, ValueError, TypeError, RecursionError):
        print('{"status":"unknown","error":"INVALID_OR_UNREADABLE_EXPORT"}')
        return 2
    print(json.dumps(report, ensure_ascii=False, indent=2) if args.format == 'json' else human(report), end='\n')
    return {'pass': 0, 'fail': 1, 'unknown': 2}[report['status']]


if __name__ == '__main__':
    sys.exit(main())

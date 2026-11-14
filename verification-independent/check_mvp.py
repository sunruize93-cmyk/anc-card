#!/usr/bin/env python3
"""Bounded current-MVP audit of pinned snapshots, approvals and artifact bytes."""
import argparse,hashlib,json,stat,sys
from datetime import datetime
from pathlib import Path
sys.dont_write_bytecode=True
from check_evidence import load_export


def load_pinned(spec):
    rows=[]
    for i in spec.get('inputs',[]):
        p=Path(i['file'])
        if p.is_symlink() or not stat.S_ISREG(p.stat().st_mode) or p.stat().st_size>16*1024*1024:
            raise ValueError('invalid input')
        raw=p.read_bytes()
        if hashlib.sha256(raw).hexdigest()!=i.get('sha256') or len(raw)!=i.get('bytes'):
            raise ValueError('input hash mismatch')
        row=dict(i)
        if i['role']=='round_artifact':
            # Artifact content stays bytes, never compiled, imported, or executed.
            row['data']=dict(sha256=i['sha256'],bytes=len(raw))
        elif p.suffix=='.json':
            row['data']=json.loads(raw)
            if i.get('jsonPointer')=='/receipt':row['data']=row['data'].get('receipt')
            elif i.get('jsonPointer'):raise ValueError('unsupported JSON selection')
        else:raise ValueError('unsupported input')
        rows.append(row)
    return rows


def analyze(spec,rows):
    findings=[]
    def add(status,code,round=None):
        v=dict(status=status,code=code)
        if round is not None:v['round']=round
        findings.append(v)
    docs={}
    for row in rows:
        if row['role']=='round_artifact':continue
        if row['role'] in docs:add('fail','DUPLICATE_INPUT_ROLE')
        docs[row['role']]=row['data']
    scope=spec.get('scope')
    if scope not in ('historical_document_cutover','new_phone_mvp'):add('unknown','SCOPE_NOT_DECLARED')
    target=spec.get('targetRecordingId')
    final=docs.get('final')
    if not isinstance(final,dict):
        add('unknown','FINAL_TASK_NOT_EXPORTED')
        # A current awaiting/running snapshot supplies identity, not completion.
        final=next((docs[r] for r in ('second_result','first_result','after_confirmation','awaiting_card','first_plan')
                    if isinstance(docs.get(r),dict)),{})
    source_id=final.get('source',{}).get('recordingId')
    if scope=='new_phone_mvp':
        if not target:add('unknown','NEW_PHONE_RECORDING_ID_NOT_YET_AVAILABLE')
        elif source_id and source_id!=target:add('fail','TARGET_RECORDING_MISMATCH')
        elif source_id==target:add('pass','FINAL_TASK_FROM_TARGET_RECORDING')
        phone=docs.get('phone_receipt')
        if not phone:add('unknown','NEW_PHONE_RECEIPT_NOT_EXPORTED')
        elif not all(phone.get(f) is not None for f in ('recordingId','sha256','bytes','localId')):
            add('unknown','PHONE_RECEIPT_FIELDS_MISSING')
        elif not target:add('unknown','PHONE_RECEIPT_CANNOT_BIND_WITHOUT_TARGET')
        elif phone['recordingId']!=target or phone['sha256']!=target:add('fail','PHONE_RECEIPT_TARGET_MISMATCH')
        else:add('pass','PHONE_RECEIPT_TARGET_MATCH')
        if spec.get('provenance',{}).get('audio')!='new_physical_card_via_iphone':
            add('unknown','PHYSICAL_CARD_AUDIO_PROVENANCE_NOT_ESTABLISHED')
        handoff=docs.get('phone_handoff')
        if not handoff:add('unknown','PHONE_HANDOFF_NOT_EXPORTED')
        elif not handoff.get('recordingId'):add('unknown','PHONE_HANDOFF_RECORDING_ID_NOT_EXPORTED')
        elif target and handoff['recordingId']!=target:add('fail','PHONE_HANDOFF_TARGET_MISMATCH')
        elif target:add('pass','PHONE_HANDOFF_TARGET_MATCH')
        if handoff and phone:
            for f in ('sha256','bytes'):
                v=handoff.get(f) if handoff.get(f) is not None else (handoff.get('receipt') or {}).get(f)
                if v is None or phone.get(f) is None:add('unknown','PHONE_HANDOFF_INTEGRITY_FIELD_MISSING')
                elif v!=phone[f]:add('fail','PHONE_HANDOFF_RECEIPT_INTEGRITY_MISMATCH')
        if phone and spec.get('targetBytes') is not None:
            if phone.get('bytes')!=spec['targetBytes']:add('fail','PHONE_RECEIPT_TARGET_BYTES_MISMATCH')
            else:add('pass','PHONE_RECEIPT_TARGET_BYTES_MATCH')
        transcript=docs.get('transcript')
        if not transcript:add('unknown','TARGET_TRANSCRIPT_NOT_EXPORTED')
        else:
            rid=transcript.get('recordingId') or transcript.get('id')
            if not rid:add('unknown','TRANSCRIPT_RECORDING_ID_MISSING')
            elif target and rid!=target:add('fail','TRANSCRIPT_TARGET_MISMATCH')
            elif target:add('pass','TRANSCRIPT_TARGET_MATCH')
            segments=transcript.get('segments') or transcript.get('transcript')
            if not isinstance(segments,list) or not segments:add('unknown','TRANSCRIPT_SEGMENTS_MISSING')
            else:
                previous=0
                for s in segments:
                    start,end=s.get('startMs'),s.get('endMs')
                    if type(start) is not int or type(end) is not int:add('unknown','TRANSCRIPT_TIMING_FIELDS_MISSING');continue
                    if start<previous or end<=start:add('fail','TRANSCRIPT_RANGE_INVALID')
                    if spec.get('targetDurationMs') is not None and end>spec['targetDurationMs']:add('fail','TRANSCRIPT_EXCEEDS_TARGET_DURATION')
                    previous=end
                if transcript.get('status')=='complete':add('observed','TARGET_TRANSCRIPTION_REPORTED_COMPLETE')
                evidence=final.get('source',{})
                if not all(evidence.get(f) is not None for f in ('startMs','endMs','evidence')):
                    add('unknown','TASK_ORIGINAL_AUDIO_EVIDENCE_MISSING')
                elif any(s.get('startMs')==evidence['startMs'] and s.get('endMs')==evidence['endMs'] and s.get('text')==evidence['evidence'] for s in segments):
                    add('pass','TASK_QUOTE_AND_RANGE_MATCH_SOURCE_SEGMENT')
                else:add('unknown','TASK_EVIDENCE_REQUIRES_MULTI_SEGMENT_OR_REVISION_REVIEW')
        delivery=docs.get('recording_delivery')
        if delivery:
            if not target or delivery.get('recordingId')!=target:add('fail','RECORDING_DELIVERY_TARGET_MISMATCH')
            elif delivery.get('status')=='complete' and delivery.get('feishu',{}).get('state')=='complete':
                add('pass','TARGET_RECORDING_RESULT_CARD_REPORTED_COMPLETE')
            else:add('unknown','TARGET_RECORDING_RESULT_CARD_PENDING')
            expected_message=spec.get('targetRecordingCardMessageId')
            observed_message=delivery.get('feishu',{}).get('messageId')
            if expected_message and observed_message:
                if expected_message==observed_message:add('pass','LOCKED_TARGET_RECORDING_CARD_MATCH')
                else:add('fail','LOCKED_TARGET_RECORDING_CARD_MISMATCH')
            else:add('unknown','LOCKED_RECORDING_CARD_ID_MISSING')
        proof=docs.get('asr_source_proof')
        if proof and transcript:
            if proof.get('recordingId')!=target or proof.get('sourceSha256')!=target:
                add('fail','ASR_PROOF_TARGET_SOURCE_MISMATCH')
            else:add('pass','ASR_PROOF_BOUND_TO_TARGET_SOURCE')
            proven=proof.get('segments') or [];segments=transcript.get('segments') or transcript.get('transcript') or []
            if len(proven)!=len(segments) or not proven:add('unknown','ASR_PROOF_SEGMENT_COUNT_INCOMPLETE')
            elif any(p.get('startMs')!=s.get('startMs') or p.get('endMs')!=s.get('endMs') or p.get('sha256')!=s.get('chunkSha256') for p,s in zip(proven,segments)):
                add('fail','ASR_PROOF_SEGMENT_RANGE_OR_HASH_MISMATCH')
            else:add('pass','ASR_SEGMENT_PROOF_HASHES_AND_RANGES_MATCH_EXPORT')
            if (proof.get('continuousCoverageMs')==spec.get('targetDurationMs') and proof.get('startMarkerPresent') is True
                and proof.get('endMarkerPresent') is True and proven and all(p.get('matchesOriginalPCM') is True for p in proven)):
                add('observed','SOURCE_EXPORT_ATTESTS_FULL_PCM_COVERAGE_AND_BOTH_MARKERS')
            else:add('unknown','FULL_ORIGINAL_AUDIO_COVERAGE_PROOF_INCOMPLETE')
        else:add('unknown','SAME_SOURCE_ASR_PROOF_NOT_EXPORTED')
    elif scope=='historical_document_cutover':
        add('observed','MAC_TTS_HISTORICAL_CHAIN_NOT_NEW_PHONE_CHAIN')
    report=docs.get('verification',{})
    if report:
        if report.get('taskId')!=final.get('taskId') or report.get('recordingId')!=source_id:
            add('fail','VERIFICATION_REPORT_TASK_OR_RECORDING_MISMATCH')
        else:add('pass','VERIFICATION_REPORT_BOUND_TO_FINAL_TASK')
        if scope=='new_phone_mvp' and 'tts' in str(report.get('provenance',{}).get('audio','')).lower():
            add('fail','MAC_TTS_CANNOT_SATISFY_NEW_PHONE_MVP')
    upload=docs.get('upload')
    if upload:
        rid=upload.get('recording',{}).get('id')
        if rid!=source_id:add('fail','UPLOAD_TASK_RECORDING_MISMATCH')
        else:add('pass','UPLOAD_RECORDING_MATCHES_TASK_SOURCE')
    tid=final.get('taskId');owner=final.get('ownerOpenId');card=final.get('card',{}).get('messageId')
    if spec.get('targetTaskId') and tid:
        if tid!=spec['targetTaskId']:add('fail','LOCKED_TARGET_TASK_MISMATCH')
        else:add('pass','LOCKED_TARGET_TASK_MATCH')
    if spec.get('targetTaskCardMessageId') and card:
        if card!=spec['targetTaskCardMessageId']:add('fail','LOCKED_TARGET_TASK_CARD_MISMATCH')
        else:add('pass','LOCKED_TARGET_TASK_CARD_MATCH')
    for role in ('awaiting_card','after_confirmation','first_review','first_accepted','first_result','second_plan','second_status','second_after_confirmation','second_result'):
        task=docs.get(role)
        if not task:continue
        if not tid or not task.get('taskId'):add('unknown','TASK_ID_MISSING')
        elif task['taskId']!=tid or task.get('source',{}).get('recordingId')!=source_id:
            add('fail','SNAPSHOT_TASK_OR_RECORDING_CHANGED')
        else:add('pass','SNAPSHOT_TASK_AND_RECORDING_MATCH')
        msg=task.get('card',{}).get('messageId')
        if msg and card and msg!=card:add('fail','ORIGINAL_TASK_CARD_CHANGED')
        if task.get('ownerOpenId')!=owner:add('fail','OWNER_CHANGED_WITHIN_CHAIN')
        if task.get('chatId')!=final.get('chatId'):add('fail','TASK_CHAT_CHANGED_WITHIN_CHAIN')
        for f in ('sessionId','workspaceId'):
            if task.get(f) and final.get(f) and task[f]!=final[f]:add('fail','SNAPSHOT_SESSION_OR_WORKSPACE_CHANGED')
    for role in ('first_result','second_result','final'):
        task=docs.get(role)
        if not task: add('unknown','RESULT_SNAPSHOT_MISSING');continue
        c=task.get('card',{})
        if not c.get('messageId'):add('unknown','TASK_CARD_MESSAGE_ID_MISSING')
        elif c.get('syncedVersion')!=task.get('version') or c.get('error'):
            add('unknown','RESULT_CARD_NOT_CONFIRMED_SYNCED')
        else:add('pass','RESULT_CARD_SYNCED_TO_SNAPSHOT_VERSION')
    actual_final=docs.get('final') or {}
    if actual_final.get('status')=='complete' and owner and actual_final.get('acceptedBy')==owner:
        def ts(value):
            try:return datetime.fromisoformat(value.replace('Z','+00:00')).timestamp()
            except (ValueError,TypeError,AttributeError):return None
        events=actual_final.get('events') or []
        old_events=(docs.get('first_accepted') or {}).get('events') or []
        accepts=[(i,e) for i,e in enumerate(events) if e.get('actor')=='负责人' and '确认本轮交付' in e.get('text','') and ts(e.get('at')) is not None]
        results=[(i,e) for i,e in enumerate(events) if '执行器已回传' in e.get('text','') and ts(e.get('at')) is not None]
        confirmation_times=[ts(c.get('at')) for c in actual_final.get('confirmations',[])]
        if accepts and results and confirmation_times and all(t is not None for t in confirmation_times):
            i,a=accepts[-1];j,r=results[-1]
            if i>j and ts(a['at'])>ts(r['at']) and ts(a['at'])>max(confirmation_times) and a not in old_events:
                add('pass','FINAL_COMPLETE_WITH_FRESH_OWNER_ACCEPT_EVENT')
            else:add('unknown','FINAL_ACCEPT_EVENT_STALE_OR_PRE_RESULT')
        else:add('unknown','FRESH_FINAL_ACCEPT_EVENT_NOT_EXPORTED')
    else:add('unknown','FINAL_OWNER_ACCEPTANCE_NOT_EXPORTED')
    confirmations=final.get('confirmations') or []
    rounds=final.get('rounds') or []
    for role,number in (('first_result',1),('second_result',2)):
        snapshot=docs.get(role)
        if snapshot:
            if snapshot.get('rounds')!=rounds[:number]:add('fail','RESULT_ROUNDS_CHANGED_IN_FINAL')
            if snapshot.get('confirmations')!=confirmations[:number]:add('fail','RESULT_CONFIRMATIONS_CHANGED_IN_FINAL')
    if len(confirmations)!=2:add('unknown','TWO_CONFIRMATIONS_NOT_EXPORTED')
    if len(rounds)!=2:add('unknown','TWO_ROUNDS_NOT_EXPORTED')
    sid=final.get('sessionId');workspace=final.get('workspaceId')
    if sid and workspace and rounds and all(r.get('sessionId')==sid and r.get('workspaceId')==workspace for r in rounds):
        add('pass','TWO_ROUNDS_SAME_SESSION_AND_WORKSPACE')
    elif rounds:add('fail','ROUND_SESSION_OR_WORKSPACE_MISMATCH')
    first_run=(docs.get('after_confirmation') or {}).get('runId')
    second_run=(docs.get('second_after_confirmation') or {}).get('runId')
    if first_run and second_run:
        if first_run==second_run:add('fail','TWO_ROUNDS_REUSE_SAME_RUN_ID')
        else:add('pass','TWO_ROUNDS_HAVE_DISTINCT_RUN_IDS')
        recorded_runs=[(docs.get('first_result') or {}).get('runId'),(docs.get('second_result') or {}).get('runId'),actual_final.get('runId')]
        if any(r is None for r in recorded_runs):add('unknown','RESULT_RUN_ID_NOT_EXPORTED')
        elif recorded_runs!=[first_run,second_run,second_run]:add('fail','RESULT_RUN_ID_MISMATCH')
        else:add('pass','ROUND_RUN_IDS_MATCH_RESULT_SNAPSHOTS')
    else:add('unknown','BOTH_ROUND_RUN_IDS_NOT_EXPORTED')
    authorization_versions=[];assertion_counts={}
    for number in (1,2):
        if len(confirmations)<number or len(rounds)<number:continue
        c=confirmations[number-1];r=rounds[number-1]
        plan=docs.get('first_plan' if number==1 else 'second_plan')
        scope_value=c.get('scope') or {}
        authorization_versions.append(c.get('version'))
        if c.get('channel')=='feishu' and owner and c.get('actor')==owner and c.get('action')=='approve':
            add('pass','OWNER_FEISHU_APPROVAL_RECORDED',number)
        else:add('fail','APPROVAL_NOT_OWNER_FEISHU_EXECUTE',number)
        if not plan:add('unknown','APPROVED_PLAN_SNAPSHOT_MISSING',number)
        else:
            proposal=plan.get('proposal') or {}
            if c.get('version')!=plan.get('version') or c.get('proposalId')!=proposal.get('id'):
                add('fail','APPROVAL_VERSION_OR_PROPOSAL_MISMATCH',number)
            elif scope_value.get('contractDigest')!=proposal.get('contractDigest') or scope_value.get('id')!=proposal.get('id'):
                add('fail','APPROVAL_SCOPE_MISMATCH',number)
            else:add('pass','APPROVAL_BINDS_PRE_EXECUTION_PLAN_VERSION',number)
        if not c.get('authorizationId'):add('unknown','AUTHORIZATION_ID_NOT_EXPORTED',number)
        if scope_value.get('contractDigest') and scope_value.get('contractDigest')==r.get('contractDigest'):
            add('pass','RESULT_MATCHES_APPROVED_CONTRACT_DIGEST',number)
        else:add('fail','RESULT_CONTRACT_MISMATCH',number)
        expected=r.get('artifacts') or []
        supplied=[a for a in rows if a['role']=='round_artifact' and a.get('round')==number]
        expected_by_name={a['name']:a for a in expected}
        if len(expected_by_name)!=len(expected):add('fail','DUPLICATE_ARTIFACT_NAME_IN_MANIFEST',number)
        supplied_by_name={a['name']:a for a in supplied}
        if len(supplied_by_name)!=len(supplied):add('fail','DUPLICATE_ARTIFACT_INPUT',number)
        if not expected or set(expected_by_name)!=set(supplied_by_name):add('unknown','ROUND_ARTIFACT_BYTES_INCOMPLETE',number)
        else:
            if any(any(expected_by_name[n].get(f)!=supplied_by_name[n]['data'].get(f) for f in ('bytes','sha256')) for n in expected_by_name):
                add('fail','ROUND_ARTIFACT_BYTES_OR_HASH_MISMATCH',number)
            else:add('pass','ROUND_ARTIFACT_BYTES_AND_HASH_RECHECKED',number)
        independent=docs.get('round%d_assertions'%number)
        assertion=report.get('round%dIndependentAssertions'%number)
        if independent:
            if independent.get('round')!=number:add('fail','INDEPENDENT_ASSERTION_ROUND_MISMATCH',number)
            elif independent.get('passed') is True and independent.get('exitCode')==0 and type(independent.get('assertions')) is int and independent['assertions']>0:
                add('observed','EXPORTED_INDEPENDENT_ASSERTIONS_PASSED',number)
                assertion=dict(passed=independent['assertions'],total=independent['assertions'])
            else:add('unknown','INDEPENDENT_ASSERTION_RUN_NOT_PASSED',number)
        if assertion and assertion.get('passed')==assertion.get('total') and type(assertion.get('total')) is int and assertion['total']>0:
            add('observed','SOURCE_REPORTED_BUSINESS_ASSERTIONS_PASSED',number)
            assertion_counts['round%d'%number]=assertion
        else:add('unknown','BUSINESS_ASSERTION_RESULT_NOT_EXPORTED',number)
    # A document/recording card must not be silently relabeled as a task card.
    delivery=docs.get('document_delivery')
    if delivery:
        if delivery.get('recordingId')!=source_id:
            add('observed','UNRELATED_DOCUMENT_DELIVERY_EXCLUDED')
        elif delivery.get('feishu',{}).get('messageId')==card:
            add('unknown','DOCUMENT_AND_TASK_CARD_ROLE_REQUIRES_REVIEW')
        else:add('observed','RECORDING_DOCUMENT_CARD_SEPARATE_FROM_TASK_CARD')
    for code in ('RAW_FEISHU_CALLBACK_RECEIPTS_NOT_EXPORTED','RAW_TASK_CARD_PATCH_RESPONSE_NOT_EXPORTED',
                 'COMPLETE_EXECUTION_EVENT_WINDOW_NOT_EXPORTED'):
        add('unknown',code)
    ui=docs.get('ui_verification')
    if ui:
        if ui.get('visibleTaskId')==tid and ui.get('visibleSessionId')==sid and ui.get('visibleRounds')==2:
            add('observed','UI_OBSERVATION_EXPORT_MATCHES_TASK_SESSION_AND_ROUND_COUNT')
        else:add('unknown','UI_OBSERVATION_EXPORT_NEEDS_REVIEW')
    satisfied={f['code'] for f in findings if f['status'] in ('pass','observed')}
    required={'FINAL_TASK_FROM_TARGET_RECORDING','PHONE_RECEIPT_TARGET_MATCH','PHONE_HANDOFF_TARGET_MATCH',
              'PHONE_RECEIPT_TARGET_BYTES_MATCH','TRANSCRIPT_TARGET_MATCH','TASK_QUOTE_AND_RANGE_MATCH_SOURCE_SEGMENT',
              'TARGET_RECORDING_RESULT_CARD_REPORTED_COMPLETE','ASR_PROOF_BOUND_TO_TARGET_SOURCE',
              'ASR_SEGMENT_PROOF_HASHES_AND_RANGES_MATCH_EXPORT','SOURCE_EXPORT_ATTESTS_FULL_PCM_COVERAGE_AND_BOTH_MARKERS',
              'LOCKED_TARGET_TASK_MATCH','LOCKED_TARGET_TASK_CARD_MATCH','LOCKED_TARGET_RECORDING_CARD_MATCH','FINAL_COMPLETE_WITH_FRESH_OWNER_ACCEPT_EVENT',
              'TWO_ROUNDS_SAME_SESSION_AND_WORKSPACE','TWO_ROUNDS_HAVE_DISTINCT_RUN_IDS','ROUND_RUN_IDS_MATCH_RESULT_SNAPSHOTS'}
    per_round={'OWNER_FEISHU_APPROVAL_RECORDED','APPROVAL_BINDS_PRE_EXECUTION_PLAN_VERSION',
               'RESULT_MATCHES_APPROVED_CONTRACT_DIGEST','ROUND_ARTIFACT_BYTES_AND_HASH_RECHECKED','EXPORTED_INDEPENDENT_ASSERTIONS_PASSED'}
    business_verified=(scope=='new_phone_mvp' and required<=satisfied and
        all(per_round<={f['code'] for f in findings if f.get('round')==n and f['status'] in ('pass','observed')} for n in (1,2)) and
        actual_final.get('card',{}).get('syncedVersion')==actual_final.get('version') and
        not any(f['status']=='fail' for f in findings))
    return dict(schemaVersion=1,scope=scope,status='contradiction_found' if any(x['status']=='fail' for x in findings) else
                'mvp_verified_with_audit_gaps' if business_verified else 'partial_evidence',
                provenance=spec.get('provenance'),authorizationVersions=authorization_versions,
                finalMechanicalVersion=(docs.get('final') or {}).get('version'),finalStatus=(docs.get('final') or {}).get('status'),
                observedTaskStatus=final.get('status'),
                assertionCounts=assertion_counts,mvpBusinessChainVerifiedFromExports=business_verified,
                proofScope='Pinned export relationships and source attestations; no fresh live observation',
                fullEventAuditComplete=False,newPhoneEndToEndProven=business_verified,findings=findings)


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('manifest');p.add_argument('--format',choices=['json','text'],default='json');a=p.parse_args()
    try:
        spec=load_export(a.manifest);r=analyze(spec,load_pinned(spec))
    except (ValueError,OSError,KeyError,TypeError):
        print('{"status":"unknown","error":"INVALID_OR_CHANGED_PINNED_INPUT"}');return 2
    if a.format=='json':print(json.dumps(r,ensure_ascii=False,indent=2))
    else:
        print('MVP 独立核对：'+r['status'])
        for f in r['findings']:print(f['status'],f['code'],('round='+str(f['round'])) if 'round' in f else '')
    return 1 if r['status']=='contradiction_found' else 0 if r['mvpBusinessChainVerifiedFromExports'] else 2
if __name__=='__main__':sys.exit(main())

import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from check_snapshots import analyze, human, load_bundle
from collect_stable import capture

ROOT=Path(__file__).resolve().parent
RID='a'*64
PROV=dict(systemObservation='simulated',workload='synthetic_fixture',authorization='none')

def sample():
    receipt=dict(localId='local-1',recordingId=RID,sha256=RID,bytes=100,duplicate=False)
    record=dict(id='local-1',sha256=RID,bytes=100,receipt=receipt,delivery=dict(recordingId=RID,status='complete',feishu=dict(state='complete',messageId='recording-card-1')))
    backend=[dict(id=RID,status='complete',transcript=[dict(startMs=0,endMs=500,text='合成口令',timingMethod='audio_chunk',engine='synthetic')],ledger=[])]
    before=copy.deepcopy(record); before.pop('receipt'); before.pop('delivery')
    data=[('phone_state','network_restored',dict(recordings=[record])),('backend_recordings','network_restored',backend),
          ('phone_state','offline',dict(recordings=[before])),('backend_recordings','offline',[]),
          ('gateway_uploads','gateway',[dict(localId='local-1',sha256=RID,duplicate=0,at='2026-11-14T05:00:00Z')]),
          ('executor_summary','cli',dict(taskId='task-1',sessionId='session-1',status='review',rounds=[dict(round=i,sessionId='session-1',workspaceId='workspace-1',contractDigest='b'*64,artifacts=[dict(name='x.txt',sha256='c'*64,bytes=1)]) for i in (1,2)]))]
    return [dict(role=role,label=label,data=value,provenance=copy.deepcopy(PROV)) for role,label,value in data]

def codes(r):return {f['code'] for f in r['findings']}

class SnapshotTests(unittest.TestCase):
    def setUp(self):self.d=sample()
    def report(self):return analyze(self.d)
    def test_partial_snapshot_not_e2e_pass(self):
        r=self.report()
        self.assertEqual(r['status'],'partial_evidence')
        self.assertIn('NO_SAME_RECORDING_TASK_AUTH_SESSION_CARD_CHAIN',codes(r))
        self.assertFalse(r['authenticityVerified'])
    def test_optional_upload_override_not_missing(self):
        c=codes(self.report())
        self.assertIn('PHONE_RECEIPT_BINDINGS_MATCH',c)
        self.assertNotIn('RECEIPT_BINDING_FIELDS_MISSING',c)
        self.assertIn('GATEWAY_LOCAL_ID_HASH_MATCH',c)
    def test_explicit_upload_override(self):
        self.d[0]['data']['recordings'][0].update(id='different',uploadLocalID='local-1')
        self.assertIn('PHONE_RECEIPT_BINDINGS_MATCH',codes(self.report()))
    def test_wrong_receipt_bytes(self):
        self.d[0]['data']['recordings'][0]['receipt']['bytes']=101
        self.assertIn('RECEIPT_BINDING_MISMATCH',codes(self.report()))
    def test_wrong_receipt_local(self):
        self.d[0]['data']['recordings'][0]['receipt']['localId']='wrong'
        self.assertIn('RECEIPT_BINDING_MISMATCH',codes(self.report()))
    def test_missing_receipt_optional_fields_no_inventing(self):
        del self.d[0]['data']['recordings'][0]['receipt']['bytes']
        r=self.report()
        self.assertIn('RECEIPT_BINDING_FIELDS_MISSING',codes(r))
        self.assertNotIn('RECEIPT_BINDING_MISMATCH',codes(r))
    def test_no_duration_from_bytes_or_transcript(self):
        self.assertIn('INDEPENDENT_AUDIO_DURATION_NOT_EXPORTED',codes(self.report()))
    def test_empty_ledger_is_not_product_failure(self):
        r=self.report()
        self.assertFalse(any(f['status']=='fail' for f in r['findings']))
        self.assertEqual(r['phone']['records'][0]['candidateTaskCount'],0)
    def test_cross_recording_card(self):
        second=copy.deepcopy(self.d[0]['data']['recordings'][0])
        second.update(id='local-2',sha256='b'*64)
        second['receipt'].update(localId='local-2',recordingId='b'*64,sha256='b'*64)
        second['delivery']['recordingId']='b'*64
        self.d[0]['data']['recordings'].append(second)
        self.assertIn('CARD_SHARED_ACROSS_RECORDINGS',codes(self.report()))
    def test_gateway_mismatch(self):
        self.d[4]['data'][0]['sha256']='b'*64
        self.assertIn('GATEWAY_HASH_MISMATCH',codes(self.report()))
    def test_old_gateway_missing_is_unknown(self):
        self.d[4]['data']=[]
        r=self.report()
        self.assertIn('GATEWAY_EVENT_MISSING',codes(r))
        self.assertFalse(any(f['status']=='fail' for f in r['findings']))
    def test_offline_restored(self):
        r=self.report()
        self.assertEqual(r['phone']['offlineRestoredRecords'],['R1'])
        self.assertIn('OFFLINE_PENDING_TO_RECEIPTED_SAME_LOCAL_RECORD',codes(r))
    def test_offline_identity_changed(self):
        self.d[2]['data']['recordings'][0]['id']='changed'
        self.assertIn('OFFLINE_RESTORE_IDENTITY_CHANGED',codes(self.report()))
    def test_two_round_same_session(self):
        self.assertIn('TWO_ROUND_SESSION_IDS_MATCH',codes(self.report()))
        self.assertFalse(self.report()['executors'][0]['feishuConfirmationProven'])
    def test_two_round_wrong_session(self):
        self.d[5]['data']['rounds'][1]['sessionId']='different'
        self.assertIn('ROUND_SESSION_MISMATCH',codes(self.report()))
    def test_mixed_simulation_cannot_fill_real(self):
        self.d[1]['provenance']['systemObservation']='real'
        c=codes(self.report())
        self.assertIn('PHONE_PROVENANCE_COHORT_MISMATCH_EXCLUDED',c)
        self.assertIn('BACKEND_RECORDING_EXPORT_MISSING',c)
    def test_no_raw_ids_or_transcript_in_output(self):
        r=self.report(); text=json.dumps(r)+human(r)
        for private in (RID,'local-1','recording-card-1','session-1','合成口令'):
            self.assertNotIn(private,text)
    def test_manifest_hash_mismatch_rejected(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            path=Path(tmp)/'input.json'; path.write_text('{}')
            bundle=Path(tmp)/'bundle.json'
            bundle.write_text(json.dumps(dict(inputs=[dict(file=str(path),sha256='a'*64,role='phone_state',label='x')])) )
            with self.assertRaises(ValueError):load_bundle(bundle)
    def test_stable_capture_and_partial_tail(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            root=Path(tmp); out=root/'copies'; out.mkdir()
            p=root/'events.jsonl'; p.write_text('{"kind":"example"}\n')
            r=capture(p,out)
            self.assertEqual(r['status'],'captured')
            self.assertEqual(hashlib.sha256(Path(r['copy']).read_bytes()).hexdigest(),r['sha256'])
            p.write_text('{"kind":')
            self.assertEqual(capture(p,out)['reason'],'PARTIAL_OR_INVALID_JSON_NO_COPY')
    def test_excluded_secrets_never_copied(self):
        with tempfile.TemporaryDirectory(dir=ROOT) as tmp:
            root=Path(tmp); p=root/'bootstrap.json'; p.write_text('{}')
            with self.assertRaises(ValueError):capture(p,root)
    def test_no_event_id_or_semantic_key_synthesized(self):
        r=self.report()
        text=json.dumps(r)
        self.assertNotIn('eventId',text)
        self.assertNotIn('semanticKey',text)

    def with_handoff(self):
        original=self.d[5]
        digest=hashlib.sha256(b'x').hexdigest()
        for r in original['data']['rounds']:
            r['artifacts'][0]['sha256']=digest
        raw=json.dumps(original['data']).encode()
        original.update(inputSha256=hashlib.sha256(raw).hexdigest(),inputBytes=len(raw))
        h=dict(format='anc-executor-snapshot-export-v1',source=dict(evidenceSha256=original['inputSha256'],evidenceBytes=len(raw)),snapshot=copy.deepcopy(original['data']),artifacts=[dict(name='x.txt',content='x',sha256=digest,bytes=1,associatedRound=2)])
        raw=json.dumps(h).encode()
        hd=dict(role='executor_handoff',label='handoff',data=h,provenance=copy.deepcopy(PROV),inputSha256=hashlib.sha256(raw).hexdigest(),inputBytes=len(raw))
        self.d.append(hd)
        self.d.append(dict(role='executor_export_manifest',label='manifest',provenance=copy.deepcopy(PROV),data=dict(files=[dict(path='snapshot.json',sha256=hd['inputSha256'],bytes=len(raw))])))
        return h

    def test_handoff_bytes_verified_only_for_exported_round(self):
        self.with_handoff()
        r=self.report()
        self.assertIn('EXPORTED_ARTIFACT_CONTENT_HASH_AND_ROUND_MATCH',codes(r))
        self.assertIn('HANDOFF_MANIFEST_HASH_AND_BYTES_MATCH',codes(r))
        missing=[x['ref'] for x in r['findings'] if x['code']=='ROUND_ARTIFACT_BYTES_NOT_EXPORTED']
        self.assertEqual(missing,['round-1'])

    def test_handoff_tampered_artifact_content(self):
        h=self.with_handoff(); h['artifacts'][0]['content']='changed'
        self.assertIn('HANDOFF_ARTIFACT_HASH_OR_BYTES_MISMATCH',codes(self.report()))

    def test_handoff_swapped_session(self):
        h=self.with_handoff(); h['snapshot']['sessionId']='other'
        self.assertIn('HANDOFF_TASK_SESSION_STATUS_CHANGED',codes(self.report()))

    def test_handoff_swapped_round_contract(self):
        h=self.with_handoff(); h['snapshot']['rounds'][0]['contractDigest']='d'*64
        self.assertIn('HANDOFF_ROUND_FIELDS_CHANGED',codes(self.report()))

    def test_handoff_source_not_found_unknown(self):
        h=self.with_handoff(); h['source']['evidenceSha256']='d'*64
        self.assertIn('HANDOFF_SOURCE_NOT_IN_PINNED_INPUTS',codes(self.report()))

    def test_handoff_manifest_changed(self):
        self.with_handoff(); self.d[-1]['data']['files'][0]['sha256']='d'*64
        self.assertIn('HANDOFF_MANIFEST_HASH_OR_BYTES_MISMATCH',codes(self.report()))

    def test_handoff_partial_round_artifacts_not_complete(self):
        h=self.with_handoff(); h['snapshot']['rounds'][1]['artifacts'].append(dict(name='missing.txt',sha256='c'*64,bytes=1))
        missing=[x.get('ref') for x in self.report()['findings'] if x['code']=='ROUND_ARTIFACT_BYTES_NOT_EXPORTED']
        self.assertIn('round-2',missing)

if __name__=='__main__':unittest.main()

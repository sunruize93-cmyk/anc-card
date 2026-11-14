"""Only current MVP adapter regressions; all fixtures are synthetic."""
import copy
import unittest
from check_mvp import analyze


def sample():
    rid='a'*64
    proposals=[dict(id='p%d'%n,contractDigest=str(n)*64) for n in (1,2)]
    confirmations=[dict(actor='owner',channel='feishu',version=v,proposalId=p['id'],action='approve',scope=copy.deepcopy(p)) for v,p in zip((2,9),proposals)]
    rounds=[dict(round=n,sessionId='session',workspaceId='workspace',contractDigest=str(n)*64,artifacts=[dict(name='test.txt',bytes=1,sha256='c'*64)]) for n in (1,2)]
    final=dict(taskId='task',source=dict(recordingId=rid,startMs=0,endMs=1000,evidence='synthetic task'),ownerOpenId='owner',chatId='chat',card=dict(messageId='card',syncedVersion=16,error=None),acceptedBy='owner',status='complete',version=16,sessionId='session',workspaceId='workspace',confirmations=confirmations,rounds=rounds)
    docs={'final':final,'verification':dict(taskId='task',recordingId=rid,round1IndependentAssertions=dict(passed=3,total=3),round2IndependentAssertions=dict(passed=5,total=5)),
          'first_plan':dict(version=2,proposal=proposals[0]),'second_plan':dict(final,version=9,proposal=proposals[1]),
          'first_result':dict(final,rounds=rounds[:1],confirmations=confirmations[:1],version=8,card=dict(messageId='card',syncedVersion=8)),
          'second_result':copy.deepcopy(final)}
    rows=[dict(role=k,data=v) for k,v in docs.items()]
    rows += [dict(role='round_artifact',round=n,name='test.txt',data=dict(sha256='c'*64,bytes=1)) for n in (1,2)]
    return dict(scope='historical_document_cutover',targetRecordingId=None,provenance=dict(audio='macos_tts')),rows

class MVPTests(unittest.TestCase):
    def setUp(self):self.spec,self.rows=sample()
    def doc(self,role):return next(r['data'] for r in self.rows if r['role']==role)
    def codes(self):return {x['code'] for x in analyze(self.spec,self.rows)['findings']}
    def test_real_feishu_approval_not_legacy_synthetic(self):
        self.assertIn('OWNER_FEISHU_APPROVAL_RECORDED',self.codes())
        self.assertIn('AUTHORIZATION_ID_NOT_EXPORTED',self.codes())
        self.assertEqual(analyze(self.spec,self.rows)['authorizationVersions'],[2,9])
    def test_approval_not_compared_to_mechanical_version(self):
        self.assertIn('APPROVAL_BINDS_PRE_EXECUTION_PLAN_VERSION',self.codes())
        self.assertNotIn('APPROVAL_VERSION_OR_PROPOSAL_MISMATCH',self.codes())
    def test_wrong_approval_version(self):
        self.doc('final')['confirmations'][1]['version']=16
        self.assertIn('APPROVAL_VERSION_OR_PROPOSAL_MISMATCH',self.codes())
    def test_wrong_owner(self):
        self.doc('final')['confirmations'][0]['actor']='not-owner'
        self.assertIn('APPROVAL_NOT_OWNER_FEISHU_EXECUTE',self.codes())
    def test_changed_original_card(self):
        self.doc('first_result')['card']['messageId']='different'
        self.assertIn('ORIGINAL_TASK_CARD_CHANGED',self.codes())
    def test_artifact_bytes_mismatch(self):
        self.rows[-1]['data']['bytes']=2
        self.assertIn('ROUND_ARTIFACT_BYTES_OR_HASH_MISMATCH',self.codes())
    def test_no_new_target_never_filled_with_historical(self):
        self.spec['scope']='new_phone_mvp'
        self.assertIn('NEW_PHONE_RECORDING_ID_NOT_YET_AVAILABLE',self.codes())
        self.assertFalse(analyze(self.spec,self.rows)['newPhoneEndToEndProven'])
    def test_new_target_must_match_task(self):
        self.spec.update(scope='new_phone_mvp',targetRecordingId='b'*64)
        self.assertIn('TARGET_RECORDING_MISMATCH',self.codes())
    def test_tts_cannot_be_new_phone_source(self):
        self.spec.update(scope='new_phone_mvp',targetRecordingId='a'*64)
        self.doc('verification')['provenance']=dict(audio='self-made macOS TTS')
        self.assertIn('MAC_TTS_CANNOT_SATISFY_NEW_PHONE_MVP',self.codes())
    def test_phone_transcript_wrong_recording(self):
        self.spec.update(scope='new_phone_mvp',targetRecordingId='a'*64)
        self.rows.extend([dict(role='phone_receipt',data=dict(recordingId='a'*64,sha256='a'*64,bytes=10,localId='local')),
                          dict(role='phone_handoff',data=dict(recordingId='b'*64,sha256='b'*64,bytes=10)),
                          dict(role='transcript',data=dict(recordingId='b'*64,segments=[]))])
        self.assertIn('PHONE_HANDOFF_TARGET_MISMATCH',self.codes())
        self.assertIn('TRANSCRIPT_TARGET_MISMATCH',self.codes())

    def test_awaiting_first_confirmation_is_pending_not_failure(self):
        task=copy.deepcopy(self.doc('final'))
        task.update(status='awaiting',version=2,rounds=[],confirmations=[],sessionId=None)
        task['card']['syncedVersion']=2
        task.pop('acceptedBy')
        self.rows=[dict(role='awaiting_card',data=task)]
        self.spec.update(scope='new_phone_mvp',targetRecordingId='a'*64)
        r=analyze(self.spec,self.rows)
        self.assertEqual(r['observedTaskStatus'],'awaiting')
        self.assertIsNone(r['finalStatus'])
        self.assertFalse(any(x['status']=='fail' for x in r['findings']))

    def complete_phone_fixture(self):
        self.spec.update(scope='new_phone_mvp',targetRecordingId='a'*64,targetTaskId='task',targetTaskCardMessageId='card',targetRecordingCardMessageId='recording-card',targetBytes=100,targetDurationMs=1000,provenance=dict(audio='new_physical_card_via_iphone'))
        final=self.doc('final')
        final['runId']='run-2';self.doc('first_result')['runId']='run-1';self.doc('second_result')['runId']='run-2'
        for i,c in enumerate(final['confirmations']):c['at']='2026-11-14T07:%02d:00Z'%(10+i*10)
        old_accept=dict(actor='负责人',text='已查看产物与验收要求，确认本轮交付。',at='2026-11-14T07:12:00Z')
        final['events']=[old_accept,dict(actor='Personal Agent',text='执行器已回传，等待验收。',at='2026-11-14T07:21:00Z'),dict(actor='负责人',text='已查看产物与验收要求，确认本轮交付。',at='2026-11-14T07:22:00Z')]
        # Keep source snapshots internally consistent after adding real-shaped timestamps.
        self.doc('second_result')['confirmations']=copy.deepcopy(final['confirmations'])
        self.rows.extend([
            dict(role='first_accepted',data=dict(copy.deepcopy(self.doc('first_result')),events=[old_accept])),
            dict(role='after_confirmation',data=dict(copy.deepcopy(self.doc('first_result')),runId='run-1')),
            dict(role='second_after_confirmation',data=dict(copy.deepcopy(final),runId='run-2')),
            dict(role='phone_handoff',data=dict(recordingId='a'*64,bytes=100,receipt=dict(sha256='a'*64))),
            dict(role='phone_receipt',data=dict(recordingId='a'*64,sha256='a'*64,bytes=100,localId='local')),
            dict(role='transcript',data=dict(recordingId='a'*64,status='complete',segments=[dict(startMs=0,endMs=1000,text='synthetic task',chunkSha256='d'*64)])),
            dict(role='recording_delivery',data=dict(recordingId='a'*64,status='complete',feishu=dict(state='complete',messageId='recording-card'))),
            dict(role='asr_source_proof',data=dict(recordingId='a'*64,sourceSha256='a'*64,continuousCoverageMs=1000,startMarkerPresent=True,endMarkerPresent=True,segments=[dict(startMs=0,endMs=1000,sha256='d'*64,matchesOriginalPCM=True)])),
            dict(role='round1_assertions',data=dict(round=1,passed=True,assertions=3,exitCode=0)),
            dict(role='round2_assertions',data=dict(round=2,passed=True,assertions=5,exitCode=0))])

    def test_business_complete_distinct_from_full_audit(self):
        self.complete_phone_fixture();r=analyze(self.spec,self.rows)
        self.assertEqual(r['status'],'mvp_verified_with_audit_gaps',r)
        self.assertTrue(r['mvpBusinessChainVerifiedFromExports'])
        self.assertFalse(r['fullEventAuditComplete'])
        self.assertIn('AUTHORIZATION_ID_NOT_EXPORTED',self.codes())

    def test_inherited_accepted_by_without_new_accept_not_final(self):
        self.complete_phone_fixture();self.doc('final')['events'].pop()
        r=analyze(self.spec,self.rows)
        self.assertFalse(r['mvpBusinessChainVerifiedFromExports'])
        self.assertIn('FINAL_ACCEPT_EVENT_STALE_OR_PRE_RESULT',self.codes())

    def test_new_accept_before_second_result_not_final(self):
        self.complete_phone_fixture();self.doc('final')['events'][-1]['at']='2026-11-14T07:20:30Z'
        self.assertFalse(analyze(self.spec,self.rows)['mvpBusinessChainVerifiedFromExports'])

    def test_old_recording_card_pending_needs_new_receipt(self):
        self.complete_phone_fixture();self.doc('recording_delivery')['feishu']['state']='updating'
        self.assertFalse(analyze(self.spec,self.rows)['mvpBusinessChainVerifiedFromExports'])
        self.doc('recording_delivery')['feishu']['state']='complete'
        self.assertTrue(analyze(self.spec,self.rows)['mvpBusinessChainVerifiedFromExports'])

if __name__=='__main__':unittest.main()

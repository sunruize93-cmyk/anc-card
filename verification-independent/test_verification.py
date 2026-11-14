import copy
import json
from pathlib import Path
import subprocess
import sys
import unittest
from build_samples import positive, label, coffee, H, D
from check_evidence import check, human

ROOT = Path(__file__).resolve().parent

def codes(events):
    report = check(events)
    return report, {i['code'] for g in report['groups'].values() for i in g['issues']}

class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.e = positive()

    def fail_code(self, code):
        r, c = codes(self.e)
        self.assertEqual(r['status'], 'fail', r)
        self.assertIn(code, c)

    def test_positive_and_real_separate(self):
        r = check(self.e)
        self.assertEqual(r['groups']['simulated']['status'], 'pass')
        self.assertEqual(r['groups']['real']['status'], 'unknown')
        self.assertFalse(r['globalAbsenceProven'])
        self.assertFalse(r['provenanceVerified'])

    def test_each_required_field_missing_is_not_pass(self):
        from check_evidence import KINDS
        for i, event in enumerate(self.e):
            for field in ('eventId seq '+KINDS[event['kind']]).split():
                with self.subTest(kind=event['kind'], field=field):
                    e = copy.deepcopy(self.e)
                    del e[i][field]
                    self.assertNotEqual(check(e)['status'], 'pass')
                    self.assertIn('MISSING_FIELD', codes(e)[1])

    def test_upload_bad_digest(self):
        self.e[1]['sha256'] = 'b'*64
        self.fail_code('UPLOAD_INTEGRITY_MISMATCH')

    def test_upload_bad_length(self):
        self.e[1]['bytes'] += 1
        self.fail_code('UPLOAD_INTEGRITY_MISMATCH')

    def test_recording_hash_identity(self):
        self.e[1]['recordingId'] = 'wrong'
        self.fail_code('RECORDING_HASH_MISMATCH')

    def test_duplicate_upload_no_reexecution(self):
        replay = dict(self.e[1], duplicate=True)
        self.e.insert(2, replay)
        label(self.e)
        self.assertEqual(check(self.e)['status'], 'pass')

    def test_duplicate_recording_create(self):
        self.e.insert(2, dict(self.e[1]))
        label(self.e)
        self.fail_code('DUPLICATE_RECORDING_CREATION')

    def test_local_id_rebound(self):
        self.e.insert(2, dict(self.e[1], recordingId='b'*64, sha256='b'*64, duplicate=True))
        label(self.e)
        self.fail_code('LOCAL_ID_REBOUND')

    def test_transcript_outside(self):
        self.e[2]['segments'][0]['endMs'] = 2000
        self.fail_code('TRANSCRIPT_OUTSIDE_AUDIO')

    def test_transcript_negative(self):
        self.e[2]['segments'][0]['startMs'] = -1
        self.fail_code('TRANSCRIPT_RANGE_INVALID')

    def test_evidence_changed(self):
        self.e[3]['evidence'][0]['quote'] = '由 Zoty 负责。'
        self.fail_code('EVIDENCE_QUOTE_OR_RANGE_MISMATCH')

    def test_duplicate_task(self):
        self.e.insert(4, dict(self.e[3], taskId='task-2'))
        label(self.e)
        self.fail_code('DUPLICATE_TASK_CREATION')

    def test_owner_wrong(self):
        self.e[5]['owner'] = 'person-zoty'
        self.fail_code('AUTHORIZATION_BINDING_MISMATCH')

    def test_old_authorization_version(self):
        self.e[5]['version'] = 2
        self.fail_code('AUTHORIZATION_BINDING_MISMATCH')

    def test_wrong_proposal(self):
        self.e[6]['proposalId'] = 'other'
        self.fail_code('EXECUTION_AUTHORIZATION_MISMATCH')

    def test_wrong_scope_digest(self):
        self.e[6]['contractDigest'] = 'b'*64
        self.fail_code('EXECUTION_AUTHORIZATION_MISMATCH')

    def test_acknowledge_is_not_execute(self):
        self.e[5]['decision'] = 'acknowledge'
        self.fail_code('EXECUTION_WITHOUT_ACTIVE_APPROVAL')

    def test_missing_approval_unknown(self):
        del self.e[5]
        r, c = codes(self.e)
        self.assertEqual(r['status'], 'unknown')
        self.assertIn('AUTHORIZATION_MISSING', c)

    def test_cross_task_authorization(self):
        self.e[6]['taskId'] = 'task-other'
        self.fail_code('CROSS_TASK_AUTHORIZATION')

    def test_result_wrong_task(self):
        self.e[7]['taskId'] = 'task-other'
        self.fail_code('RESULT_BINDING_MISMATCH')

    def test_result_wrong_session(self):
        self.e[7]['sessionId'] = 'other-session'
        self.fail_code('RESULT_BINDING_MISMATCH')

    def test_result_wrong_version(self):
        self.e[7]['approvedVersion'] = 2
        self.fail_code('EXECUTION_AUTHORIZATION_MISMATCH')

    def test_wrong_approval_card(self):
        self.e[5]['messageId'] = 'wrong-card'
        self.fail_code('APPROVAL_WRONG_CARD')

    def test_wrong_result_card(self):
        self.e[8]['messageId'] = 'new-card'
        self.fail_code('WRONG_CARD_OR_DUPLICATE_CREATE')

    def test_missing_result_card_unknown(self):
        self.e.pop()
        self.assertIn('RESULT_CARD_UPDATE_MISSING', codes(self.e)[1])
        self.assertEqual(check(self.e)['status'], 'unknown')

    def test_duplicate_approval_replay(self):
        self.e.insert(6, dict(self.e[5]))
        label(self.e)
        self.assertEqual(check(self.e)['status'], 'pass')

    def test_duplicate_execution(self):
        self.e.insert(7, dict(self.e[6], runId='run-2'))
        label(self.e)
        self.fail_code('DUPLICATE_EXECUTION_FOR_APPROVAL')

    def test_different_approval_id_same_version_execution(self):
        a, r = dict(self.e[5], authorizationId='auth-2'), dict(self.e[6], authorizationId='auth-2', runId='run-2')
        self.e.extend([a, r])
        label(self.e)
        self.fail_code('DUPLICATE_EXECUTION_FOR_PROPOSAL_VERSION')

    def test_late_result_after_withdrawal_rejected(self):
        self.e.insert(7, dict(kind='task_state', taskId='task-1', version=6, state='withdrawn'))
        self.e[8]['disposition'] = 'rejected_stale'
        self.e.pop()
        label(self.e)
        self.assertEqual(check(self.e)['status'], 'pass')

    def test_late_result_after_withdrawal_applied(self):
        self.e.insert(7, dict(kind='task_state', taskId='task-1', version=6, state='withdrawn'))
        label(self.e)
        self.fail_code('STALE_OR_WITHDRAWN_RESULT_ACCEPTED')

    def test_late_result_after_reassignment(self):
        self.e.insert(7, dict(self.e[3], version=6, owner='person-zoty', proposalId='proposal-2'))
        label(self.e)
        self.fail_code('STALE_OR_WITHDRAWN_RESULT_ACCEPTED')

    def resumed(self):
        self.e = self.e[:8]
        self.e[-1]['disposition'] = 'interrupted'
        self.e += [dict(kind='task_state', taskId='task-1', version=6, state='paused'),
                   dict(kind='task_state', taskId='task-1', version=7, state='resumed'),
                   dict(positive()[5], version=7, authorizationId='auth-2'),
                   dict(positive()[6], approvedVersion=7, authorizationId='auth-2', runId='run-2', mode='resume'),
                   dict(positive()[7], approvedVersion=7, authorizationId='auth-2', runId='run-2'),
                   dict(positive()[8], runId='run-2')]
        label(self.e)

    def test_pause_resume_same_session(self):
        self.resumed()
        self.assertEqual(check(self.e)['status'], 'pass')

    def test_resume_wrong_session(self):
        self.resumed()
        self.e[-3]['sessionId'] = 'new-session'
        self.fail_code('SESSION_CHANGED')

    def test_cross_task_session(self):
        second = positive()[3:]
        for e in second:
            e['taskId'] = 'task-2'
            for k in ('semanticKey', 'authorizationId', 'runId', 'messageId'):
                if k in e:
                    e[k] += '-second'
        self.e += second
        label(self.e)
        self.fail_code('CROSS_TASK_SESSION')

    def test_card_cross_task(self):
        self.e.append(dict(self.e[4], taskId='task-2'))
        label(self.e)
        self.fail_code('CARD_CROSS_TASK')

    def test_recording_and_task_cards_distinct(self):
        self.e.append(dict(kind='card', recordingId=H, cardKind='recording', messageId='recording-card', operation='create'))
        label(self.e)
        self.assertEqual(check(self.e)['status'], 'pass')

    def test_second_task_approval_without_start_unknown(self):
        extra = positive()[3:6]
        for e in extra:
            e['taskId'] = 'task-2'
            for k in ('semanticKey', 'authorizationId', 'messageId'):
                if k in e:
                    e[k] += '-second'
        self.e += extra
        label(self.e)
        self.assertEqual(check(self.e)['status'], 'unknown')
        self.assertIn('APPROVED_EXECUTION_START_MISSING', codes(self.e)[1])

    def test_exact_export_replay(self):
        self.e.append(copy.deepcopy(self.e[6]))
        self.assertEqual(check(self.e)['status'], 'pass')

    def test_conflicting_event_id(self):
        self.e.append(dict(self.e[6], runId='different'))
        self.fail_code('EVENT_ID_CONFLICT')

    def test_duplicate_result(self):
        self.e.append(dict(self.e[7]))
        label(self.e)
        self.fail_code('DUPLICATE_RESULT_APPLICATION')

    def test_unknown_when_order_missing(self):
        self.e[6]['seq'] = 1
        self.assertEqual(check(self.e)['status'], 'unknown')

    def test_empty_unknown(self):
        self.assertEqual(check([])['status'], 'unknown')

    def test_malformed_types_unknown(self):
        for val in (None, 1, [], {'kind': []}, {'events':'bad'}, 'secret'):
            with self.subTest(value=val):
                self.assertEqual(check(val)['status'], 'unknown')

    def test_raw_snapshot_unknown(self):
        self.assertEqual(check({'taskId':'x','version':8,'status':'complete'})['status'], 'unknown')

    def test_receipt_adapter(self):
        payload = {k:v for k,v in self.e[1].items() if k not in ('kind','eventId','seq','provenance')}
        self.e[1] = dict(kind='mobile_upload_receipt', payload=payload, eventId='event-02', seq=2, provenance='simulated')
        self.assertEqual(check(self.e)['status'], 'pass')

    def test_transcript_adapter(self):
        self.e[2] = dict(kind='recording_transcript_export', payload=dict(id=H, transcript=self.e[2]['segments']), eventId='event-03', seq=3, provenance='simulated')
        self.assertEqual(check(self.e)['status'], 'pass')

    def test_no_sensitive_values_in_reports(self):
        marker = 'PRIVATE-DO-NOT-PRINT'
        self.e[0]['token'] = marker
        r = check(self.e)
        self.assertEqual(r['status'], 'fail')
        self.assertNotIn(marker, json.dumps(r)+human(r))
        self.assertNotIn(H, json.dumps(r)+human(r))

    def test_simulated_cannot_fill_real_gaps(self):
        self.e[5]['provenance'] = 'real'
        r = check(self.e)
        self.assertEqual(r['groups']['real']['status'], 'unknown')
        self.assertNotEqual(r['groups']['simulated']['status'], 'pass')

    def test_cli_formats_and_exit_codes(self):
        for filename, fmt in [('positive.json','json'),('positive.jsonl','text')]:
            p = subprocess.run([sys.executable,'-B',str(ROOT/'check_evidence.py'),str(ROOT/'fixtures'/filename),'--format',fmt], capture_output=True, text=True)
            self.assertEqual(p.returncode, 0, p.stdout+p.stderr)
        p = subprocess.run([sys.executable,'-B',str(ROOT/'check_evidence.py'),str(ROOT/'fixtures'/'absent.json')],capture_output=True,text=True)
        self.assertEqual(p.returncode, 2)
        self.assertNotIn('absent.json', p.stdout)

class GoldenTests(unittest.TestCase):
    def test_all_cases_have_contiguous_synthetic_evidence(self):
        data = coffee()
        self.assertEqual(len(data['cases']),14)
        for c in data['cases']:
            with self.subTest(case=c['caseId']):
                self.assertFalse(c['audioExists'])
                self.assertEqual(c['provenance'],'simulated')
                self.assertFalse(c['expected']['executionAllowedFromTranscript'])
                end = 0
                mapping = {}
                for s in c['segments']:
                    self.assertEqual(s['startMs'],end)
                    self.assertGreater(s['endMs'],end)
                    self.assertIn(s['speaker'],('Eric.s','Zoty'))
                    end = s['endMs']
                    mapping[s['segmentId']] = s
                self.assertEqual(end,c['durationMs'])
                for r in c['expected']['candidateRevisions']:
                    for ref in r['evidence']:
                        s = mapping[ref['segmentId']]
                        self.assertEqual(ref['quote'],s['text'])
                        self.assertEqual((ref['startMs'],ref['endMs']),(s['startMs'],s['endMs']))

    def test_anchor_and_ambiguity(self):
        cases = coffee()['cases']
        self.assertIsNone(cases[4]['expected']['candidateRevisions'][0]['deadline']['resolved'])
        self.assertEqual(cases[10]['expected']['candidateRevisions'][0]['deadline']['resolved'],'2026-11-15T10:00:00+09:00')
        self.assertEqual(cases[2]['expected']['candidateRevisions'],[])
        self.assertEqual(cases[12]['expected']['candidateRevisions'],[])

if __name__ == '__main__':
    unittest.main(verbosity=2)

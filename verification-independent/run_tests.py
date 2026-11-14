#!/usr/bin/env python3
"""Run only independent tests and persist synthetic verification reports here."""
import contextlib
import copy
import io
import json
from pathlib import Path
import sys
import unittest
sys.dont_write_bytecode = True
from build_samples import positive, label
from check_evidence import check, human

ROOT = Path(__file__).resolve().parent

def cases():
    yield 'positive', positive(), 'pass', None
    modifications = [
        ('wrong-bytes', 1, 'bytes', 123, 'UPLOAD_INTEGRITY_MISMATCH'),
        ('wrong-owner', 5, 'owner', 'person-zoty', 'AUTHORIZATION_BINDING_MISMATCH'),
        ('old-approval-version', 5, 'version', 2, 'AUTHORIZATION_BINDING_MISMATCH'),
        ('acknowledge-not-execute', 5, 'decision', 'acknowledge', 'EXECUTION_WITHOUT_ACTIVE_APPROVAL'),
        ('wrong-session', 7, 'sessionId', 'session-other', 'RESULT_BINDING_MISMATCH'),
        ('wrong-task', 7, 'taskId', 'task-other', 'RESULT_BINDING_MISMATCH'),
        ('wrong-card', 8, 'messageId', 'card-other', 'WRONG_CARD_OR_DUPLICATE_CREATE'),
        ('stale-result-version', 7, 'approvedVersion', 1, 'EXECUTION_AUTHORIZATION_MISMATCH'),
    ]
    for name, i, field, value, code in modifications:
        e = positive()
        e[i][field] = value
        yield name, e, 'fail', code
    e = positive()
    del e[5]['owner']
    yield 'missing-owner', e, 'unknown', 'MISSING_FIELD'
    e = positive()
    e.insert(7, dict(e[6],runId='run-duplicate'))
    label(e)
    yield 'duplicate-execution', e, 'fail', 'DUPLICATE_EXECUTION_FOR_APPROVAL'
    e = positive()
    e.insert(2, dict(e[1],duplicate=True))
    label(e)
    yield 'duplicate-upload-single-execution', e, 'pass', None
    e = positive()
    e.insert(7, dict(kind='task_state',taskId='task-1',version=6,state='withdrawn'))
    label(e)
    yield 'withdrawn-late-applied', copy.deepcopy(e), 'fail', 'STALE_OR_WITHDRAWN_RESULT_ACCEPTED'
    e[8]['disposition']='rejected_stale'
    e.pop()
    yield 'withdrawn-late-rejected', e, 'pass', None


def main():
    reports = ROOT/'reports'
    reports.mkdir(exist_ok=True)
    output = io.StringIO()
    suite = unittest.defaultTestLoader.discover(str(ROOT), pattern='test_*.py')
    with contextlib.redirect_stdout(output):
        result = unittest.TextTestRunner(stream=output, verbosity=2).run(suite)
    fixtures = []
    for name, events, expected, code in cases():
        (ROOT/'fixtures'/(name+'.json')).write_text(json.dumps({'events':events},ensure_ascii=False,indent=2)+'\n')
        report = check(events)
        codes = {i['code'] for g in report['groups'].values() for i in g['issues']}
        okay = report['status']==expected and (code is None or code in codes)
        fixtures.append(dict(fixture=name+'.json',expected=expected,expectedCode=code,actual=report['status'],matched=okay))
        (reports/(name+'.json')).write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        (reports/(name+'.txt')).write_text(human(report))
    summary = dict(provenance='simulated',realEvidenceCollected=False,testsRun=result.testsRun,
                   failures=len(result.failures),errors=len(result.errors),skipped=len(result.skipped),
                   fixtures=fixtures,passed=result.wasSuccessful() and all(x['matched'] for x in fixtures))
    (reports/'test-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
    (reports/'test-output.txt').write_text(output.getvalue())
    print(json.dumps(summary,ensure_ascii=False,indent=2))
    return 0 if summary['passed'] else 1

if __name__ == '__main__':
    sys.exit(main())

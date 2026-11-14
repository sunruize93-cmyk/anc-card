import concurrent.futures
import json
from pathlib import Path
import tempfile
import time
import unittest
import uuid
from runner import run_once, TASK


class DurableDedup(unittest.TestCase):
    def test_concurrent_and_later_deliveries_start_exactly_one_process(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            fake = root / 'fake-codex'
            fake.write_text('''#!/usr/bin/env python3
import sys, pathlib, json, time
if '--version' in sys.argv:
 print('fake-codex-test-only');sys.exit(0)
sys.stdin.read()
with open(pathlib.Path(__file__).parent/'invocations','a') as out:out.write('start\\n')
time.sleep(.2)
pathlib.Path('totals.mjs').write_text('export function sumPositive(v) { return 0; }')
pathlib.Path('README.md').write_text('test-only')
print(json.dumps({'type':'thread.started','thread_id':'00000000-0000-0000-0000-000000000001'}))
print(json.dumps({'type':'turn.completed'}))
''')
            fake.chmod(0o700)
            c = {'taskId':TASK,'nonce':str(uuid.uuid4()),'expiresAt':time.time()+60,
                 'callback':'https://webhook.site/00000000-0000-0000-0000-000000000001'}
            with concurrent.futures.ThreadPoolExecutor(2) as pool:
                futures = [pool.submit(run_once,root/'jobs',c,str(i),str(fake)) for i in range(2)]
                results = [f.result() for f in futures]
            later=run_once(root/'jobs',c,'3',str(fake))
            self.assertEqual((root/'invocations').read_text(),'start\n')
            self.assertEqual(sorted(r['duplicate'] for r in results),[False,True])
            self.assertEqual(len({r['runId'] for r in [*results,later]}),1)
            self.assertTrue(later['duplicate'])
            self.assertEqual(later['executionCount'],1)
            self.assertEqual(len(later['deliveryIds']),3)
            with self.assertRaises(ValueError):
                run_once(root/'jobs',{**c,'nonce':str(uuid.uuid4())},'4',str(fake))
            self.assertEqual((root/'invocations').read_text(),'start\n')

    def test_reserved_crash_and_expiry_never_start_executor(self):
        with tempfile.TemporaryDirectory() as directory:
            c={'taskId':TASK,'nonce':str(uuid.uuid4()),'expiresAt':time.time()+60,'callback':'test'}
            failed=run_once(directory,c,'first','/nonexistent/codex')
            again=run_once(directory,c,'retry','/nonexistent/codex')
            self.assertEqual(failed['status'],'failed')
            self.assertEqual(again['executionCount'],0)
            self.assertTrue(again['duplicate'])
            with self.assertRaises(ValueError):
                run_once(directory,{**c,'expiresAt':time.time()-1},'expired')


if __name__=='__main__':unittest.main()

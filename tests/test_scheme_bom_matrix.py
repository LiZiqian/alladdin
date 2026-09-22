import copy
import sys
import tempfile
import unittest
from pathlib import Path
from backend_fixture import seed_state
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend import server

class SchemeDeletionTests(unittest.TestCase):
    def setUp(self):
        root = ROOT / 'batch_import_test_data'
        root.mkdir(exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix='scheme-matrix-', dir=root)
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(server._apply_runtime_paths, server._RUNTIME_PATHS)
        server.prepare_runtime_data_root(Path(self.tmp.name))
        server.init_db()
        state, revision, _ = server.get_state()
        self.stage = {'id':'st', 'name':'ST', 'skuNames':['A','B','C'], 'bom':[{'materialName':'屏幕','sku1':'A屏','sku2':'B屏','sku3':'C屏'}], 'strategy':[], 'progress':[], 'tasks':[{'id':'t','skuIndex':2,'status':'正常完成','sampleIds':[]}]}
        state['projects'] = [{'id':'p','name':'P','stages':[self.stage]}]
        ok, result = seed_state(state, revision, '127.0.0.1')
        self.assertTrue(ok, result)

    def remove(self, index):
        stage = copy.deepcopy(self.stage)
        stage['skuNames'].pop(index)
        _, revision, _ = server.get_state()
        return server.commit_stage_mutation({'projectId':'p','stageId':'st','stage':stage,'revision':revision,'action':'remove_scheme'}, '127.0.0.1')

    def test_reject_deletion_that_relabels_existing_or_archived_tasks(self):
        for index in (0,1):
            ok, result = self.remove(index)
            self.assertFalse(ok)
            self.assertEqual(result['error_code'], 'SCHEME_HAS_TASK_REFERENCES')
        with server.connect_db() as conn:
            conn.execute("UPDATE project_tasks SET deleted_at='2026-09-21' WHERE id='t'")
        ok, result = self.remove(0)
        self.assertFalse(ok)
        self.assertEqual(result['error_code'], 'SCHEME_HAS_TASK_REFERENCES')

    def test_unused_trailing_scheme_can_be_deleted(self):
        ok, result = self.remove(2)
        self.assertTrue(ok, result)
        state, _, _ = server.get_state()
        self.assertEqual(state['projects'][0]['stages'][0]['skuNames'], ['A','B'])

if __name__ == '__main__':
    unittest.main()

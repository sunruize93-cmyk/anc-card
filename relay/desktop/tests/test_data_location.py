import subprocess
import unittest
from pathlib import Path

from ancrelay.workspace import DEFAULT_ROOT, REPO_ROOT, ROOT_ENV, TOOL_ROOT, make_workspace


class DataLocationTests(unittest.TestCase):
    def test_default_folder_is_inside_the_project(self):
        self.assertEqual(DEFAULT_ROOT, REPO_ROOT / ".anc-field")
        self.assertIn(REPO_ROOT, (TOOL_ROOT, TOOL_ROOT.parents[1]))

    def test_default_folder_is_ignored_by_git(self):
        if subprocess.run(["git", "rev-parse"], cwd=TOOL_ROOT, capture_output=True).returncode != 0:
            self.skipTest("不在 git 仓库里（例如从源码包解压），没有可检查的忽略规则")
        # 公开仓库：数据目录一旦没被忽略，原音和日志就可能被提交上去。
        probe = DEFAULT_ROOT / "card-A" / "note.wav"
        result = subprocess.run(["git", "check-ignore", "-q", str(probe)], cwd=REPO_ROOT, check=False)
        self.assertEqual(result.returncode, 0, f"{probe} 没有被 .gitignore 忽略")

    def test_environment_variable_and_flag_override_the_default(self):
        import os
        from unittest import mock

        with mock.patch.dict(os.environ, {ROOT_ENV: "E:/field"}):
            self.assertEqual(make_workspace(None, "A").root, Path("E:/field").resolve())
            self.assertEqual(make_workspace("F:/x", "A").root, Path("F:/x").resolve())
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(make_workspace(None, "A").root, DEFAULT_ROOT)


if __name__ == "__main__":
    unittest.main()

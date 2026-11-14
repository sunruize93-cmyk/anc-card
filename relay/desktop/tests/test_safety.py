import unittest

from ancrelay.safety import ForbiddenCommand, assert_safe, describe


class SafetyTests(unittest.TestCase):
    def test_delete_commands_are_always_rejected(self):
        for payload in (bytes([2, 8]) + bytes(28), bytes([2, 9])):
            with self.assertRaises(ForbiddenCommand) as caught:
                assert_safe(payload)
            self.assertIn("删除", str(caught.exception))

    def test_commands_outside_the_allowlist_are_rejected(self):
        # 同步时间、开始录音、保存录音、设置增益都会改变卡的状态，今天的联调用不到。
        for payload in (
            bytes([0, 0, 0xEA, 7, 11, 14, 9, 0, 0]),
            bytes([3, 1]),
            bytes([3, 3]),
            bytes([3, 27, 2]),
            bytes([2, 12]),
            bytes([9, 9]),
        ):
            with self.assertRaises(ForbiddenCommand):
                assert_safe(payload)

    def test_too_short_payload_is_rejected(self):
        for payload in (b"", bytes([2])):
            with self.assertRaises(ForbiddenCommand):
                assert_safe(payload)

    def test_read_and_stream_commands_pass(self):
        for payload in (
            bytes([0, 1]),
            bytes([0, 3]),
            bytes([0, 10]),
            bytes([2, 0]),
            bytes([2, 2]) + bytes(28),
            bytes([2, 7]),
            bytes([1, 0]),
            bytes([1, 2]),
            bytes([3, 19]),
            bytes([3, 21]),
            bytes([3, 23]),
        ):
            assert_safe(payload)

    def test_describe_names_the_command(self):
        self.assertEqual(describe(bytes([2, 0])), "2-0 列文件")
        self.assertEqual(describe(bytes([2, 9])), "2-9 删除全部文件")
        self.assertEqual(describe(bytes([7, 7])), "7-7 未知命令")


if __name__ == "__main__":
    unittest.main()

import base64
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'local'))
import server

class FolderPicker(unittest.TestCase):
    def run_picker(self, result=None, error=None):
        with patch.object(server.os,'name','nt'),patch.object(server.subprocess,'run',return_value=result,side_effect=error):
            return server.choose_folder()

    def test_cancel_and_unicode_selection_are_distinct(self):
        self.assertEqual(self.run_picker(subprocess.CompletedProcess([],0,b'',b'')), '')
        selected='E:\\照片\\漫展'
        self.assertEqual(self.run_picker(subprocess.CompletedProcess([],0,base64.b64encode(selected.encode()),b'')), selected)

    def test_failed_picker_and_timeout_are_reported_instead_of_silent_cancel(self):
        with self.assertRaisesRegex(ValueError,'启动失败'):
            self.run_picker(subprocess.CompletedProcess([],1,b'',b'PowerShell error'))
        with self.assertRaisesRegex(ValueError,'超时'):
            self.run_picker(error=subprocess.TimeoutExpired('powershell.exe',180))

if __name__=='__main__':unittest.main()

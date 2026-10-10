import importlib.util
import os
import tempfile
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('winbox_runner', os.path.join(ROOT, 'resources', 'jvm', 'python-runner', 'runner.py'))
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

class RunnerCompatibility(unittest.TestCase):
    def test_bom_and_file(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, 'source.py')
            with open(path, 'w', encoding='utf-8-sig') as f:
                f.write('class Spider:\n    path = __file__\n    def homeContent(self): return {"list": [self.path]}\n')
            ns = runner._load_script(path)
            result = runner._call_method(ns['Spider'](), 'homeContent', [])
            self.assertEqual(result['list'], [path])

    def test_search_page_required(self):
        class Source:
            def searchContent(self, key, quick, pg): return [key, quick, pg]
        self.assertEqual(runner._call_method(Source(), 'searchContent', ['book']), ['book', False, '1'])
        self.assertEqual(runner._call_method(Source(), 'searchContent', ['book', '', '3']), ['book', False, '3'])

    def test_internal_type_error_is_not_retried(self):
        class Source:
            calls = 0
            def homeContent(self, filter=True):
                self.calls += 1
                raise TypeError('source bug')
        source = Source()
        with self.assertRaisesRegex(TypeError, 'source bug'):
            runner._call_method(source, 'homeContent', [])
        self.assertEqual(source.calls, 1)

    def test_proxy_binary_and_dict(self):
        class Source:
            def localProxy(self, params): return [206, 'video/mp2t', b'\x00\xff' + params['id'].encode(), {'Content-Range': 'bytes 0-2/3'}]
        result = runner._call_method(Source(), 'proxy', ['{"id":"1"}'])
        self.assertEqual(result[2], {'base64': 'AP8x'})
        self.assertEqual(result[0], 206)

if __name__ == '__main__':
    unittest.main()

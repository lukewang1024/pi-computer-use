import copy
import importlib.util
from pathlib import Path
import unittest
from unittest import mock
import tempfile
import contextlib
import io

spec = importlib.util.spec_from_file_location('selector', Path(__file__).resolve().parents[1] / 'scripts/select-checked-candidate.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
REPOSITORY = 'owner/repository'
REVISION = 'a' * 40


class SelectorTests(unittest.TestCase):
    def setUp(self):
        self.run = dict(id=123, event='push', head_branch='main', head_sha=REVISION,
                        path='.github/workflows/ci.yml', status='completed', conclusion='success',
                        repository=dict(full_name=REPOSITORY, id=42),
                        head_repository=dict(full_name=REPOSITORY, id=42))
        self.artifact = dict(id=456, name='checked-candidate-' + REVISION, expired=False,
                             workflow_run=dict(id=123, head_sha=REVISION, head_branch='main',
                                               repository_id=42, head_repository_id=42))

    def select(self, run=None, artifact=None):
        return s.select_candidate([self.run if run is None else run],
                                  lambda run_id: [self.artifact if artifact is None else artifact],
                                  REPOSITORY, REVISION)

    def test_only_successful_exact_main_push_candidate_reused(self):
        self.assertEqual(self.select(), 123)
        self.assertIsNone(s.select_candidate([], lambda _: [], REPOSITORY, REVISION))
        self.assertIsNone(s.select_candidate([self.run], lambda _: [], REPOSITORY, REVISION))

    def test_wrong_source_event_branch_workflow_repository_or_status_denied(self):
        changes = [('event', 'pull_request'), ('head_branch', 'feature'), ('head_sha', 'b' * 40),
                   ('path', '.github/workflows/other.yml'), ('status', 'in_progress'),
                   ('conclusion', 'failure'), ('conclusion', 'cancelled'), ('id', True),
                   ('repository', dict(full_name='other/repository', id=42)),
                   ('head_repository', dict(full_name='fork/repository', id=99))]
        for key, value in changes:
            with self.subTest(key=key, value=value):
                run = copy.deepcopy(self.run)
                run[key] = value
                self.assertIsNone(self.select(run=run))

    def test_expired_wrong_name_or_wrong_builder_artifact_denied(self):
        for key, value in [('expired', True), ('expired', None), ('name', 'other'), ('id', True)]:
            with self.subTest(key=key):
                artifact = copy.deepcopy(self.artifact)
                artifact[key] = value
                self.assertIsNone(self.select(artifact=artifact))
        for key, value in [('id', 124), ('head_sha', 'b' * 40), ('head_branch', 'feature'),
                           ('repository_id', 99), ('head_repository_id', 99)]:
            with self.subTest(binding=key):
                artifact = copy.deepcopy(self.artifact)
                artifact['workflow_run'][key] = value
                self.assertIsNone(self.select(artifact=artifact))

    def invoke(self, output, responses, wait='1200'):
        arguments = ['selector', '--repository', REPOSITORY, '--revision', REVISION,
                     '--output', str(output), '--wait-seconds', wait]
        with mock.patch('sys.argv', arguments), mock.patch.object(s, 'api', side_effect=responses), \
                mock.patch.object(s.time, 'monotonic', return_value=0), \
                mock.patch.object(s.time, 'sleep') as sleep, contextlib.redirect_stdout(io.StringIO()):
            s.main()
        return sleep

    def test_active_main_ci_is_waited_for_and_then_reused(self):
        active = dict(self.run, status='in_progress', conclusion=None)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'output'
            sleep = self.invoke(output, [{'workflow_runs': [active]},
                                        {'workflow_runs': [self.run]},
                                        {'total_count': 1, 'artifacts': [self.artifact]}])
            sleep.assert_called_once_with(30)
            self.assertEqual(output.read_text(), 'builder-run-id=123\n')

    def test_bounded_wait_expiration_uses_full_build_fallback(self):
        active = dict(self.run, status='in_progress', conclusion=None)
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'output'
            sleep = self.invoke(output, [{'workflow_runs': [active]}], wait='0')
            sleep.assert_not_called()
            self.assertEqual(output.read_text(), 'builder-run-id=\n')

    def test_api_failure_cannot_select_artifact_or_claim_fallback(self):
        with tempfile.TemporaryDirectory() as temporary:
            output = Path(temporary) / 'output'
            with self.assertRaises(RuntimeError):
                self.invoke(output, [RuntimeError('API failed')])
            self.assertFalse(output.exists())

    def test_duplicate_artifacts_fail_closed(self):
        with self.assertRaisesRegex(RuntimeError, 'Ambiguous'):
            s.select_candidate([self.run], lambda _: [self.artifact, self.artifact], REPOSITORY, REVISION)


if __name__ == '__main__':
    unittest.main()

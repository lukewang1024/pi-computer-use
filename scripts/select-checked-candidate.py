#!/usr/bin/env python3
"""Reuse only successful main-push CI artifacts for the exact merged source."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import time
from urllib.parse import urlencode


def trusted_run(run, repository, revision):
    return (type(run.get('id')) is int and run['id'] > 0
            and run.get('event') == 'push' and run.get('head_branch') == 'main'
            and run.get('head_sha') == revision and run.get('path') == '.github/workflows/ci.yml'
            and run.get('repository', {}).get('full_name') == repository
            and run.get('head_repository', {}).get('full_name') == repository)


def select_candidate(runs, artifacts, repository, revision):
    eligible = [run for run in runs if trusted_run(run, repository, revision)
                and run.get('status') == 'completed' and run.get('conclusion') == 'success']
    for run in sorted(eligible, key=lambda item: item['id'], reverse=True):
        matches = []
        for artifact in artifacts(run['id']):
            binding = artifact.get('workflow_run') or {}
            if (artifact.get('name') == 'checked-candidate-' + revision
                    and artifact.get('expired') is False
                    and type(artifact.get('id')) is int and artifact['id'] > 0
                    and binding.get('id') == run['id']
                    and binding.get('head_sha') == revision and binding.get('head_branch') == 'main'
                    and binding.get('repository_id') == run['repository'].get('id')
                    and binding.get('head_repository_id') == run['repository'].get('id')
                    and type(run['repository'].get('id')) is int):
                matches.append(artifact)
        if len(matches) > 1:
            raise RuntimeError('Ambiguous checked candidate artifacts')
        if matches:
            return run['id']
    return None


def api(endpoint):
    result = subprocess.run(['gh', 'api', endpoint], capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise RuntimeError('Candidate discovery API failed; publication is prohibited')
    return json.loads(result.stdout)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--revision', required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--wait-seconds', type=int, default=1200)
    args = parser.parse_args()
    if (not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', args.repository)
            or not re.fullmatch(r'[0-9a-f]{40}', args.revision)
            or not 0 <= args.wait_seconds <= 1200):
        parser.error('Require an exact repository, commit and bounded wait')
    base = 'repos/' + args.repository + '/actions'
    query = urlencode(dict(head_sha=args.revision, event='push', branch='main', per_page=100))
    deadline = time.monotonic() + args.wait_seconds
    while True:
        runs = api(base + '/workflows/ci.yml/runs?' + query)['workflow_runs']
        def artifacts(run_id):
            response = api(base + '/runs/' + str(run_id) + '/artifacts?per_page=100')
            if response['total_count'] > len(response['artifacts']):
                raise RuntimeError('Incomplete artifact discovery; publication is prohibited')
            return response['artifacts']
        selected = select_candidate(runs, artifacts, args.repository, args.revision)
        active = any(trusted_run(run, args.repository, args.revision)
                     and run.get('status') != 'completed' for run in runs)
        if selected or not active or time.monotonic() >= deadline:
            with args.output.open('a') as stream:
                stream.write('builder-run-id=' + (str(selected) if selected else '') + '\n')
            print(json.dumps(dict(builderRunId=selected, rebuildRequired=selected is None)))
            return
        time.sleep(min(30, max(0, deadline - time.monotonic())))


if __name__ == '__main__':
    main()

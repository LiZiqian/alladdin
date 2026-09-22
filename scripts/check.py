"""Run source checks and regression suites without third-party dependencies.

Each suite owns a process: tests patch global server paths and must not
share an interpreter. Logs and exit codes are retained even when a suite fails.
Use the project's Python interpreter; Node.js is needed for frontend checks.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, default=ROOT / 'output' / 'checks')
    parser.add_argument('--match', default='', help='Run suites whose relative path contains this text')
    parser.add_argument('--timeout', type=int, default=180, help='Seconds allowed per suite')
    args = parser.parse_args()
    node = shutil.which('node')
    if not node:
        parser.error('Node.js is required for JavaScript syntax and regression checks')
    args.output.mkdir(parents=True, exist_ok=True)
    results = []

    def run(label, command, env):
        start = time.monotonic()
        log = args.output / (label.replace('/', '__') + '.log')
        with log.open('wb') as stream:
            try:
                completed = subprocess.run(command, cwd=ROOT, env=env, stdin=subprocess.DEVNULL,
                                           stdout=stream, stderr=subprocess.STDOUT, timeout=args.timeout)
                code = completed.returncode
            except subprocess.TimeoutExpired:
                stream.write(b'\nCHECK TIMED OUT\n')
                code = 124
        results.append(dict(check=label, exit_code=code, seconds=round(time.monotonic()-start, 3)))
        print(f'{"PASS" if code == 0 else "FAIL"} {label}', flush=True)

    # Tests own temporary/in-memory databases. Do not inherit a deployment data
    # override: runtime tests deliberately exercise their own default roots.
    env = {**os.environ, 'PYTHONUTF8': '1', 'PYTHONDONTWRITEBYTECODE': '1'}
    env.pop('TESTCHAMBER_DATA_DIR', None)
    try:
        sources = [*ROOT.joinpath('backend').rglob('*.py'), *ROOT.joinpath('scripts').rglob('*.py')]
        for source in sources:
            compile(source.read_bytes(), str(source), 'exec')
        results.append(dict(check='python-syntax', exit_code=0, files=len(sources)))
    except SyntaxError as error:
        print(error, file=sys.stderr)
        results.append(dict(check='python-syntax', exit_code=1))
    for source in sorted(ROOT.joinpath('frontend/js').rglob('*.js')):
        run(source.relative_to(ROOT).as_posix(), [node, '--check', str(source)], env)
    directories = [ROOT / 'tests']
    suites = sorted(p for folder in directories for pattern in ('test_*.py', '*.test.cjs')
                    for p in folder.glob(pattern) if args.match in p.relative_to(ROOT).as_posix())
    if not suites:
        parser.error('No matching regression suites found')
    for suite in suites:
        run(suite.relative_to(ROOT).as_posix(),
            [sys.executable if suite.suffix == '.py' else node, str(suite)], env)
    (args.output / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2), encoding='utf-8')
    failures = [r for r in results if r['exit_code'] != 0]
    print(f'{len(results)-len(failures)}/{len(results)} checks passed; logs: {args.output}')
    return int(bool(failures))


if __name__ == '__main__':
    raise SystemExit(main())

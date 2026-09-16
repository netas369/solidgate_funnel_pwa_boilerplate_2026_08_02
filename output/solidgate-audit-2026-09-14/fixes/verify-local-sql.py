#!/usr/bin/env python3
"""Local-only fresh PostgreSQL release check; never connects to hosted Supabase."""
from pathlib import Path
import datetime, hashlib, json, os, shlex, shutil, subprocess, sys, uuid

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
RUN = OUT / ('local-sql-' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
RUN.mkdir(exist_ok=False)
DATABASE = 'solidgate_final_verify_' + datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d_%H%M%S_') + uuid.uuid4().hex[:6]
ENV = dict(os.environ, PGPASSWORD='postgres')
PSQL = ['/opt/homebrew/bin/psql', '-h', '127.0.0.1', '-p', '5432', '-U', 'postgres', '-X', '-v', 'ON_ERROR_STOP=1']
summary = {'database': DATABASE, 'host': '127.0.0.1', 'port': 5432, 'started_at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'stages': [], 'input_hashes': {}}
(RUN / 'database.txt').write_text(DATABASE + '\n')
(OUT / 'latest-local-sql-run.txt').write_text(str(RUN) + '\n')

def persist():
    (RUN / 'summary.json').write_text(json.dumps(summary, indent=2) + '\n')

def execute(stage, args, database=DATABASE):
    cmd = PSQL + ['-d', database] + args
    log_path = RUN / (stage + '.log')
    started = datetime.datetime.now(datetime.timezone.utc)
    with (RUN / 'commands.txt').open('a') as commands:
        commands.write(shlex.join(cmd) + '\n')
    print(f'RUN {stage}', flush=True)
    with log_path.open('w') as log:
        result = subprocess.run(cmd, cwd=ROOT, env=ENV, stdout=log, stderr=subprocess.STDOUT, timeout=240)
    text = log_path.read_text()
    banners = [line for line in text.splitlines() if 'PASSED' in line or 'passed' in line]
    summary['stages'].append({'stage': stage, 'exit_code': result.returncode, 'seconds': (datetime.datetime.now(datetime.timezone.utc)-started).total_seconds(), 'log': str(log_path), 'banners': banners})
    persist()
    if result.returncode:
        print(text[-8000:], flush=True)
        raise SystemExit(f'FAILED {stage}: {log_path}')
    print(f'PASS {stage}' + (f' ({len(banners)} banners)' if banners else ''), flush=True)

sources = [ROOT / 'supabase/migrations/00001_baseline.sql'] + sorted((ROOT / 'supabase/migrations').glob('20260914*.sql'))
sources += sorted((ROOT / 'supabase/tests').rglob('*.sql'))
for source in sources:
    relative = source.relative_to(ROOT)
    destination = RUN / 'inputs' / relative
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    summary['input_hashes'][str(relative)] = hashlib.sha256(destination.read_bytes()).hexdigest()
persist()
execute('00-create-database', ['-c', f'CREATE DATABASE "{DATABASE}";'], database='postgres')
scaffold = RUN / 'scaffold.sql'
scaffold.write_text('''CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS dblink WITH SCHEMA extensions;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), email TEXT);
CREATE TABLE auth.sessions (id UUID PRIMARY KEY DEFAULT gen_random_uuid(), user_id UUID);
CREATE TABLE auth.refresh_tokens (id BIGSERIAL PRIMARY KEY, session_id UUID, revoked BOOLEAN DEFAULT false);
CREATE FUNCTION auth.uid() RETURNS UUID LANGUAGE sql STABLE AS 'SELECT NULL::UUID';
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;
GRANT USAGE ON SCHEMA public, auth, extensions TO anon, authenticated, service_role;
''')
execute('01-scaffold', ['-f', str(scaffold)])
for index, source in enumerate(sources[:1] + sorted((ROOT / 'supabase/migrations').glob('20260914*.sql')), start=2):
    execute(f'{index:02d}-' + source.stem, ['-f', str(RUN / 'inputs' / source.relative_to(ROOT))])

for index, source in enumerate(sorted((RUN / 'inputs/supabase/tests').glob('*.sql')), start=10):
    repeats = 2 if source.stem in ['solidgate_round2_concurrency','solidgate_financial_concurrency'] else 1
    for repetition in range(1, repeats+1):
        execute(f'{index:02d}-{source.stem}-{repetition}', ['-v', 'round2_dblink_conn=host=127.0.0.1 port=5432 user=postgres password=postgres', '-f', str(source)])

summary['changed_inputs_during_run'] = [path for path, digest in summary['input_hashes'].items() if hashlib.sha256((ROOT/path).read_bytes()).hexdigest() != digest]
summary['finished_at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
summary['status'] = 'passed' if not summary['changed_inputs_during_run'] else 'passed_snapshot_sources_changed'
persist()
print(json.dumps({'database':DATABASE, 'status':summary['status'], 'stages':len(summary['stages']), 'run_directory':str(RUN), 'changed_inputs':summary['changed_inputs_during_run']}), flush=True)

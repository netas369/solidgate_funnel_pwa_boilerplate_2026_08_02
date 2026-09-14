#!/usr/bin/env python3
"""Local-only populated legacy upgrade, with immutable command/input evidence."""
from pathlib import Path
import datetime, hashlib, json, os, shlex, shutil, subprocess, uuid

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
STAMP = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
RUN = OUT / ('legacy-upgrade-' + STAMP)
RUN.mkdir(exist_ok=False)
DATABASE = 'solidgate_legacy_verify_' + STAMP.lower() + '_' + uuid.uuid4().hex[:6]
ENV = dict(os.environ, PGPASSWORD='postgres')
PSQL = ['/opt/homebrew/bin/psql','-h','127.0.0.1','-p','5432','-U','postgres','-X','-v','ON_ERROR_STOP=1']
summary = {'database':DATABASE,'host':'127.0.0.1','stages':[],'input_hashes':{}}
(RUN/'database.txt').write_text(DATABASE+'\n')
(OUT/'latest-legacy-upgrade-run.txt').write_text(str(RUN)+'\n')
def persist():
    (RUN/'summary.json').write_text(json.dumps(summary,indent=2)+'\n')
def execute(stage,args,database=DATABASE):
    cmd=PSQL+['-d',database]+args
    with (RUN/'commands.txt').open('a') as commands: commands.write(shlex.join(cmd)+'\n')
    print('RUN '+stage,flush=True)
    with (RUN/(stage+'.log')).open('w') as log:
        result=subprocess.run(cmd,cwd=ROOT,env=ENV,stdout=log,stderr=subprocess.STDOUT,timeout=240)
    summary['stages'].append({'stage':stage,'exit_code':result.returncode})
    persist()
    if result.returncode:
        print((RUN/(stage+'.log')).read_text()[-10000:],flush=True)
        raise SystemExit('FAILED '+stage)
    print('PASS '+stage,flush=True)

sources=[ROOT/'supabase/migrations/00001_baseline.sql']+sorted((ROOT/'supabase/migrations').glob('20260914*.sql'))
for source in sources:
    destination=RUN/source.name
    shutil.copyfile(source,destination)
    summary['input_hashes'][str(source.relative_to(ROOT))]=hashlib.sha256(destination.read_bytes()).hexdigest()
baseline=(RUN/'00001_baseline.sql').read_text()
marker='-- BEGIN SOLIDGATE FINANCIAL AUDIT FIXES'
assert baseline.count(marker)==1
(RUN/'legacy-baseline.sql').write_text(baseline.split(marker)[0])
for name in ['legacy-upgrade-seed.sql','legacy-upgrade-assert.sql']:
    shutil.copyfile(OUT/name,RUN/name)
scaffold=next(OUT.glob('local-sql-*/scaffold.sql'))
shutil.copyfile(scaffold,RUN/'scaffold.sql')
execute('00-create-database',['-c',f'CREATE DATABASE "{DATABASE}";'],database='postgres')
execute('01-scaffold',['-f',str(RUN/'scaffold.sql')])
execute('02-legacy-baseline',['-f',str(RUN/'legacy-baseline.sql')])
execute('03-seed-populated-legacy',['-f',str(RUN/'legacy-upgrade-seed.sql')])
for repetition in [1,2]:
    for index,source in enumerate(sources[1:]):
        execute(f'{repetition+3}{index}-migration-{repetition}-'+source.stem,['-f',str(RUN/source.name)])
    execute(f'{repetition+3}9-assert-{repetition}',['-f',str(RUN/'legacy-upgrade-assert.sql')])
summary['changed_inputs_during_run']=[path for path,digest in summary['input_hashes'].items()
    if hashlib.sha256((ROOT/path).read_bytes()).hexdigest()!=digest]
summary['status']='passed' if not summary['changed_inputs_during_run'] else 'passed_snapshot_sources_changed'
persist()
print(json.dumps({'database':DATABASE,'status':summary['status'],'stages':len(summary['stages']),'run_directory':str(RUN)}),flush=True)

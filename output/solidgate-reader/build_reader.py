from pathlib import Path
from html import escape, unescape
import hashlib
import json
import re
import subprocess

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DOCS = ROOT / 'docs' / 'solidgate'
SOURCES = [
    ('architecture', 'Architektūra', 'boilerplate-architecture-audit.lt.md'),
    ('core', 'Pirkimai ir prieiga', 'boilerplate-tables-core.lt.md'),
    ('workflows', 'Checkout ir kortelės', 'boilerplate-tables-workflows.lt.md'),
    ('events', 'Webhook ir eilės', 'boilerplate-tables-events.lt.md'),
]


def plain(value):
    return unescape(re.sub(r'<[^>]*>', '', value)).strip()


documents = []
payload = []
flow = (HERE / 'flow.html').read_text()
for doc_id, title, filename in SOURCES:
    source = DOCS / filename
    rendered = subprocess.run(
        ['pandoc', '-f', 'gfm', '-t', 'html5', '--wrap=none', str(source)],
        check=True, capture_output=True, text=True,
    ).stdout
    rendered = re.sub(
        r'(<pre class="mermaid">.*?</pre>)',
        lambda match: flow + '<details><summary>Mermaid diagramos šaltinis</summary>' + match.group(1) + '</details>',
        rendered, flags=re.S,
    )
    sections = re.split(r'(?=<h2(?:\s|>))', rendered)
    section_data = []
    payload.append('<div data-document="' + doc_id + '" data-title="' + escape(title, quote=True) + '" data-filename="' + filename + '">')
    for index, section in enumerate(sections):
        heading = re.search(r'<h2[^>]*>(.*?)</h2>', section, re.S)
        section_title = plain(heading.group(1)) if heading else 'Apimtis ir skaitymo pradžia'
        if index == 0:
            section = re.sub(r'<h1([^>]*)>(.*?)</h1>', r'<h2\1>\2</h2>', section, flags=re.S)
        section_data.append({'id': f'{doc_id}-{index}', 'title': section_title, 'html': section})
        payload.append('<template data-title="' + escape(section_title, quote=True) + '">\n' + section + '</template>')
    payload.append('</div>')
    documents.append({
        'id': doc_id, 'title': title, 'filename': filename,
        'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'sections': section_data,
    })

template = (HERE / 'reader-template.html').read_text()
first_sections = documents[0]['sections']
toc = '\n'.join(
    '<li><a href="#' + section['id'] + '" data-section="' + section['id'] + '"' + (' aria-current="page"' if i == 0 else '') + '>' + escape(section['title']) + '</a></li>'
    for i, section in enumerate(first_sections)
)
options = '\n'.join('<option value="' + section['id'] + '">' + escape(section['title']) + '</option>' for section in first_sections)
result = template.replace('<!--READER_DATA-->', '\n'.join(payload)).replace('<!--READER_INITIAL-->', first_sections[0]['html']).replace('<!--READER_TOC-->', toc).replace('<!--READER_OPTIONS-->', options)
assert not re.search(r'<!doctype|<html\b|<head\b|<body\b', result, re.I)
assert len(result.encode()) < 1_000_000
assert '<!--READER_' not in result
(HERE / 'solidgate-reader.html').write_text(result)
(HERE / 'source-manifest.json').write_text(json.dumps([
    {k: v for k, v in doc.items() if k != 'sections'} | {'section_count': len(doc['sections'])}
    for doc in documents
], indent=2, ensure_ascii=False) + '\n')
print('Built', len(documents), 'documents,', sum(len(doc['sections']) for doc in documents), 'sections,', len(result.encode()), 'bytes')

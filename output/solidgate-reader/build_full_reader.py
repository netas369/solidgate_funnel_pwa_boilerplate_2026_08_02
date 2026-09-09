"""Render the complete source analysis as one continuous, offline-readable page."""
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
    ('review', 'Dabartinio boilerplate peržiūra ir pataisymai', 'BOILERPLATE_REVIEW.lt.md'),
    ('handoff', 'Darbo kontekstas ir tęsinys', 'HANDOFF.lt.md'),
    ('architecture', 'Architektūra ir naujo projekto setup', 'boilerplate-architecture-audit.lt.md'),
    ('pricing', 'Price map ir Solidgate katalogas', 'price-map-and-catalog.lt.md'),
    ('core', 'Pirkimai, sąskaitos ir prieiga', 'boilerplate-tables-core.lt.md'),
    ('workflows', 'Checkout, kortelės ir tokenai', 'boilerplate-tables-workflows.lt.md'),
    ('events', 'Webhook, įvykių tvarka ir eilės', 'boilerplate-tables-events.lt.md'),
]


def plain(value):
    return unescape(re.sub(r'<[^>]*>', '', value)).strip()


def prepare_table(match):
    table = match.group(0).replace('<table>', '<table class="full-table">', 1)
    headings = re.findall(r'<th(?:\s[^>]*)?>(.*?)</th>', table, re.S)
    labels = [plain(heading) for heading in headings]
    widths = {3: [25, 25, 50], 4: [23, 23, 44, 10]}.get(len(labels), [])
    if widths:
        cols = '<colgroup>' + ''.join(f'<col style="width:{width}%">' for width in widths) + '</colgroup>'
        table = table.replace('<thead>', cols + '<thead>', 1)

    def row_labels(row):
        index = 0

        def cell_label(cell):
            nonlocal index
            label = labels[index] if index < len(labels) else ''
            index += 1
            return '<td data-label="' + escape(label, quote=True) + '"' + cell.group(1) + '>'

        return re.sub(r'<td([^>]*)>', cell_label, row.group(0))

    return re.sub(r'<tr[^>]*>.*?</tr>', row_labels, table, flags=re.S)


def prepare_link(match, doc_id):
    url = unescape(match.group(1))
    attrs = match.group(2)
    path, _, fragment = url.partition('#')
    target = next((item[0] for item in SOURCES if path.endswith(item[2])), None)
    if target:
        url = '#' + target + ('-' + fragment if fragment else '')
    elif url.startswith('#'):
        url = '#' + doc_id + '-' + fragment
    elif url.startswith('/Users/'):
        return '<a href="#full-source-dialog" data-source-path="' + escape(url, quote=True) + '"' + attrs + '>'
    elif url.startswith('https://'):
        attrs += ' target="_blank" rel="noopener noreferrer"'
    elif not re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', url):
        source_path = str((DOCS / url).resolve())
        return '<a href="#full-source-dialog" data-source-path="' + escape(source_path, quote=True) + '"' + attrs + '>'
    return '<a href="' + escape(url, quote=True) + '"' + attrs + '>'


toc, content, manifest = [], [], []
for number, (doc_id, title, filename) in enumerate(SOURCES, 1):
    source = DOCS / filename
    rendered = subprocess.run(['pandoc', '-f', 'gfm', '-t', 'html5', '--wrap=none', str(source)], check=True, capture_output=True, text=True).stdout
    rendered = re.sub(r'id="([^"]+)"', lambda m: f'id="{doc_id}-{m.group(1)}"', rendered)
    headings = re.findall(r'<h2 id="([^"]+)">(.*?)</h2>', rendered, re.S)
    toc.append('<section class="full-toc-group"><h3><a href="#' + doc_id + '">' + f'{number:02d} · ' + escape(title) + '</a></h3><ul>')
    toc.append('<li><a href="#' + doc_id + '">Apimtis ir įžanga</a></li>')
    toc.extend('<li><a href="#' + heading_id + '">' + escape(plain(heading)) + '</a></li>' for heading_id, heading in headings)
    toc.append('</ul></section>')
    rendered = re.sub(r'<(/?)h([1-5])(\s|>)', lambda m: '<' + m.group(1) + 'h' + str(int(m.group(2)) + 1) + m.group(3), rendered)
    rendered = re.sub(r'<a href="([^"]+)"([^>]*)>', lambda m: prepare_link(m, doc_id), rendered)
    rendered = re.sub(r'<table>.*?</table>', prepare_table, rendered, flags=re.S)
    if doc_id == 'architecture':
        rendered = re.sub(r'(<pre class="mermaid">.*?</pre>)', lambda m: (HERE / 'flow.html').read_text() + '<details open><summary>Mermaid diagramos šaltinis</summary>' + m.group(1) + '</details>', rendered, flags=re.S)
    content.append('<article class="full-topic" id="' + doc_id + '" data-source="' + filename + '"><p class="full-eyebrow full-topic-label">' + f'{number:02d} / {len(SOURCES):02d} · ' + escape(title) + '</p>\n' + rendered + '<p class="full-topic-end"><a href="#full-toc">↑ Grįžti į turinį</a></p></article>')
    manifest.append({'id': doc_id, 'filename': filename, 'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'section_count': len(headings) + 1})

quick_nav = '<a href="#full-toc">Turinys</a>' + ''.join('<a href="#' + doc_id + '">' + f'{index:02d} ' + escape(title) + '</a>' for index, (doc_id, title, _) in enumerate(SOURCES, 1))
fragment = (HERE / 'full-reader-template.html').read_text().replace('<!--FULL_TOC-->', '\n'.join(toc)).replace('<!--FULL_CONTENT-->', '\n'.join(content)).replace('<!--FULL_QUICK_NAV-->', quick_nav).replace('<!--FULL_DOCUMENT_COUNT-->', str(len(SOURCES)))
assert '<!--FULL_' not in fragment
assert len(fragment.encode()) < 1_000_000
fragment_path = HERE / 'solidgate-full-analysis.html'
fragment_path.write_text(fragment)
(HERE / 'full-source-manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')

# The local shell was exported from the original visualization helper. Keep it
# alongside the reader so teammates can rebuild without that plugin or network.
destination = HERE / 'solidgate-analysis.html'
shell = (HERE / 'standalone-template.html').read_text()
assert shell.count('<!--STANDALONE_CONTENT-->') == 1
standalone = shell.replace('<!--STANDALONE_CONTENT-->', fragment)
destination.write_text(standalone)
print(f'Built {len(SOURCES)} documents, {sum(item["section_count"] for item in manifest)} sections, {len(fragment.encode())} fragment bytes; standalone {len(standalone.encode())} bytes')

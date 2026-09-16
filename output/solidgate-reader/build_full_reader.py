"""Render the complete source analysis as one continuous, offline-readable page."""
from pathlib import Path
from html import escape, unescape
import hashlib
import json
import re
import subprocess
from urllib.parse import unquote

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
DOCS = ROOT / 'docs' / 'solidgate'
BLOCKS = [
    ('payments', 'Mokėjimų sistema: dabartinis boilerplate', 'Kiekviena lentelė, kiekvienas stulpelis, visos DB funkcijos ir srautai tokie, kokie yra šio repo kode. Skirta skaityti prieš pritaikant produktą.'),
    ('audit', 'Šaltinio auditas ir peržiūros', 'Iš pirminio projekto perkelta analizė, šio boilerplate peržiūra, Stripe išvalymas ir tęstinumo užrašai. Šaltinio lentelės ir kainos nėra šio repo konfigūracija.'),
]
SOURCES = [
    ('audit-fixes-20260914', '2026-09-14 audito pataisos ir pinigų žurnalas', 'FIXES_2026-09-14.lt.md', 'payments'),
    ('audit-20260914', '2026-09-14 pilnas auditas prieš pataisas', 'AUDIT_2026-09-14.lt.md', 'audit'),
    ('auth-rollout-20260914', 'Prisijungimo ir billing pataisų išleidimas', 'AUTH_BILLING_ROLLOUT.md', 'audit'),
    ('pay-overview', 'Apžvalga ir žemėlapis', 'payments/00-apzvalga.lt.md', 'payments'),
    ('pay-flows', 'Srautai žingsnis po žingsnio', 'payments/01-srautai.lt.md', 'payments'),
    ('pay-orders', 'Lentelės: orders ir entitlements', 'payments/02-lenteles-orders-entitlements.lt.md', 'payments'),
    ('pay-renewals', 'Lentelės: sąskaitos, intro, atribucija', 'payments/03-lenteles-prenumeratos-saskaitos.lt.md', 'payments'),
    ('pay-cards', 'Lentelės: checkout būsenos, kortelės, tokenai', 'payments/04-lenteles-checkout-korteles-tokenai.lt.md', 'payments'),
    ('pay-queues', 'Lentelės: webhook inbox ir eilės', 'payments/05-lenteles-webhook-eiles.lt.md', 'payments'),
    ('pay-platform', 'Lentelės: sesijos ir platforma', 'payments/06-lenteles-platforma.lt.md', 'payments'),
    ('pay-functions', 'DB funkcijos: RPC, trigger\'iai, view', 'payments/07-funkcijos-rpc-triggeriai.lt.md', 'payments'),
    ('pay-catalog', 'Produktų katalogas ir kodai', 'payments/08-produktu-katalogas-ir-kodai.lt.md', 'payments'),
    ('cleanup', 'Stripe išvalymas ir pratęsimų indekso pataisa', 'STRIPE_CLEANUP.lt.md', 'audit'),
    ('review', 'Dabartinio boilerplate peržiūra ir pataisymai', 'BOILERPLATE_REVIEW.lt.md', 'audit'),
    ('handoff', 'Darbo kontekstas ir tęsinys', 'HANDOFF.lt.md', 'audit'),
    ('architecture', 'Architektūra ir naujo projekto setup', 'boilerplate-architecture-audit.lt.md', 'audit'),
    ('pricing', 'Price map ir Solidgate katalogas', 'price-map-and-catalog.lt.md', 'audit'),
    ('core', 'Šaltinio lentelės: pirkimai, sąskaitos ir prieiga', 'boilerplate-tables-core.lt.md', 'audit'),
    ('workflows', 'Šaltinio lentelės: checkout, kortelės ir tokenai', 'boilerplate-tables-workflows.lt.md', 'audit'),
    ('events', 'Šaltinio lentelės: webhook, įvykių tvarka ir eilės', 'boilerplate-tables-events.lt.md', 'audit'),
]


def plain(value):
    return unescape(re.sub(r'<[^>]*>', '', value)).strip()


def prepare_table(match):
    table = match.group(0).replace('<table>', '<table class="full-table">', 1)
    headings = re.findall(r'<th(?:\s[^>]*)?>(.*?)</th>', table, re.S)
    labels = [plain(heading) for heading in headings]
    widths = {3: [25, 25, 50], 4: [23, 23, 44, 10], 5: [16, 16, 30, 22, 16]}.get(len(labels), [])
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


def prepare_link(match, doc_id, source_dir):
    url = unescape(match.group(1))
    attrs = match.group(2)
    path, _, fragment = url.partition('#')
    target = next((item[0] for item in SOURCES if path and path.endswith(Path(item[2]).name)), None)
    if target and not re.fullmatch(r'L\d+(?:-L?\d+)?', fragment):
        url = '#' + target + ('-' + fragment if fragment else '')
    elif url.startswith('#'):
        url = '#' + doc_id + '-' + fragment
    elif url.startswith('/Users/'):
        return '<a href="#full-source-dialog" data-source-path="' + escape(url, quote=True) + '"' + attrs + '>'
    elif url.startswith('https://'):
        attrs += ' target="_blank" rel="noopener noreferrer"'
    elif not re.match(r'^[a-zA-Z][a-zA-Z0-9+.-]*:', url):
        source_path = str((source_dir / unquote(path)).resolve()) + ('#' + fragment if fragment else '')
        return '<a href="#full-source-dialog" data-source-path="' + escape(source_path, quote=True) + '"' + attrs + '>'
    return '<a href="' + escape(url, quote=True) + '"' + attrs + '>'


toc, content, manifest = [], [], []
block_toc = {block_id: [] for block_id, _, _ in BLOCKS}
for number, (doc_id, title, filename, block_id) in enumerate(SOURCES, 1):
    source = DOCS / filename
    rendered = subprocess.run(['pandoc', '-f', 'gfm', '-t', 'html5', '--wrap=none', str(source)], check=True, capture_output=True, text=True).stdout
    rendered = re.sub(r'id="([^"]+)"', lambda m: f'id="{doc_id}-{m.group(1)}"', rendered)
    headings = re.findall(r'<h2 id="([^"]+)">(.*?)</h2>', rendered, re.S)
    group = ['<section class="full-toc-group"><h3><a href="#' + doc_id + '">' + f'{number:02d} · ' + escape(title) + '</a></h3><ul>']
    group.append('<li><a href="#' + doc_id + '">Apimtis ir įžanga</a></li>')
    group.extend('<li><a href="#' + heading_id + '">' + escape(plain(heading)) + '</a></li>' for heading_id, heading in headings)
    group.append('</ul></section>')
    block_toc[block_id].append('\n'.join(group))
    rendered = re.sub(r'<(/?)h([1-5])(\s|>)', lambda m: '<' + m.group(1) + 'h' + str(int(m.group(2)) + 1) + m.group(3), rendered)
    rendered = re.sub(r'<a href="([^"]+)"([^>]*)>', lambda m: prepare_link(m, doc_id, source.parent), rendered)
    rendered = re.sub(r'<table>.*?</table>', prepare_table, rendered, flags=re.S)
    if doc_id == 'architecture':
        rendered = re.sub(r'(<pre class="mermaid">.*?</pre>)', lambda m: (HERE / 'flow.html').read_text() + '<details open><summary>Mermaid diagramos šaltinis</summary>' + m.group(1) + '</details>', rendered, flags=re.S)
    else:
        # Offline reader: no mermaid runtime. Keep the diagram source readable
        # (GitHub / VS Code render the same Markdown as a picture).
        rendered = re.sub(r'(<pre class="mermaid">.*?</pre>)', lambda m: '<details open><summary>Diagrama (mermaid šaltinis; GitHub ir VS Code ją piešia)</summary>' + m.group(1) + '</details>', rendered, flags=re.S)
    block_title = next(b[1] for b in BLOCKS if b[0] == block_id)
    if not any(c.startswith('<section class="full-block" id="block-' + block_id + '"') for c in content):
        content.append('<section class="full-block" id="block-' + block_id + '"><p class="full-eyebrow">Blokas</p><h2 class="full-block-title">' + escape(block_title) + '</h2><p class="full-block-lead">' + escape(next(b[2] for b in BLOCKS if b[0] == block_id)) + '</p></section>')
    content.append('<article class="full-topic" id="' + doc_id + '" data-source="' + filename + '" data-block="' + block_id + '"><p class="full-eyebrow full-topic-label">' + f'{number:02d} / {len(SOURCES):02d} · ' + escape(block_title) + ' · ' + escape(title) + '</p>\n' + rendered + '<p class="full-topic-end"><a href="#full-toc">↑ Grįžti į turinį</a></p></article>')
    manifest.append({'id': doc_id, 'block': block_id, 'filename': filename, 'source_sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'section_count': len(headings) + 1})

quick_nav = '<a href="#full-toc">Turinys</a>' + ''.join('<a href="#block-' + block_id + '"><strong>' + escape(block_title) + '</strong></a>' for block_id, block_title, _ in BLOCKS) + ''.join('<a href="#' + doc_id + '">' + f'{index:02d} ' + escape(title) + '</a>' for index, (doc_id, title, _, _) in enumerate(SOURCES, 1))
for block_id, block_title, block_lead in BLOCKS:
    toc.append('<section class="full-toc-block" id="toc-' + block_id + '"><h3 class="full-toc-block-title"><a href="#block-' + block_id + '">' + escape(block_title) + '</a></h3><p class="full-toc-note">' + escape(block_lead) + '</p><div class="full-toc-grid">' + '\n'.join(block_toc[block_id]) + '</div></section>')
fragment = (HERE / 'full-reader-template.html').read_text().replace('<!--FULL_TOC-->', '\n'.join(toc)).replace('<!--FULL_CONTENT-->', '\n'.join(content)).replace('<!--FULL_QUICK_NAV-->', quick_nav).replace('<!--FULL_DOCUMENT_COUNT-->', str(len(SOURCES)))
assert '<!--FULL_' not in fragment
assert len(fragment.encode()) < 3_000_000
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

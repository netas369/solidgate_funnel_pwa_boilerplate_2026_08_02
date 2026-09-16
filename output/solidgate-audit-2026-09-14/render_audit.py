#!/usr/bin/env python3
"""Render the Lithuanian audit without external dependencies."""
from pathlib import Path
from html import escape
from html.parser import HTMLParser
from urllib.parse import urlsplit
import os
import re
import unicodedata

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'docs/solidgate/AUDIT_2026-09-14.lt.md'
TARGET = ROOT / 'output/solidgate-reader/solidgate-audit-2026-09-14.html'
source = SOURCE.read_text()
links = []
headings = []


def rewrite_url(url):
    if urlsplit(url).scheme or url.startswith('#'):
        return url
    path, sep, fragment = url.partition('#')
    target = (SOURCE.parent / path).resolve()
    return os.path.relpath(target, TARGET.parent) + (sep + fragment if sep else '')


def inline(text):
    result = []
    pos = 0
    while pos < len(text):
        if text[pos] == '`':
            end = text.find('`', pos + 1)
            if end >= 0:
                result.append('<code>' + escape(text[pos + 1:end]) + '</code>')
                pos = end + 1
                continue
        if text.startswith('**', pos):
            end = text.find('**', pos + 2)
            if end >= 0:
                result.append('<strong>' + inline(text[pos + 2:end]) + '</strong>')
                pos = end + 2
                continue
        if text[pos] == '[':
            label_end = text.find('](', pos + 1)
            if label_end >= 0:
                cursor = label_end + 2
                depth = 1
                while cursor < len(text) and depth:
                    if text[cursor] == '(':
                        depth += 1
                    elif text[cursor] == ')':
                        depth -= 1
                    cursor += 1
                if depth == 0:
                    url = text[label_end + 2:cursor - 1]
                    converted = rewrite_url(url)
                    links.append((url, converted))
                    attrs = ' class="source-link"'
                    if urlsplit(url).scheme:
                        attrs += ' target="_blank" rel="noopener noreferrer"'
                    result.append('<a href="' + escape(converted, quote=True) + '"' + attrs + '>' + inline(text[pos + 1:label_end]) + '</a>')
                    pos = cursor
                    continue
        result.append(escape(text[pos]))
        pos += 1
    return ''.join(result)


def slug(text):
    normalized = unicodedata.normalize('NFKD', text).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', normalized.lower()).strip('-')


def table_row(line, tag):
    cells = line.strip().strip('|').split('|')
    output = []
    for cell in cells:
        value = cell.strip()
        contents = inline(value)
        if re.fullmatch(r'P[012](?:/P[012])?', value):
            contents = '<span class="priority ' + value.split('/')[0].lower() + '">' + contents + '</span>'
        output.append('<' + tag + '>' + contents + '</' + tag + '>')
    return '<tr>' + ''.join(output) + '</tr>'


lines = source.splitlines()
blocks = []
index = 0
while index < len(lines):
    line = lines[index].strip()
    if not line:
        index += 1
        continue
    heading = re.match(r'^(#{1,6}) (.+)', line)
    if heading:
        level, label = len(heading[1]), heading[2]
        identity = slug(label)
        headings.append((level, label, identity))
        if level > 1:
            extra = ''
            if level == 3:
                priority = 'p0' if label.startswith('A01.') else 'p1' if re.match(r'A0[2-9]', label) else 'p2'
                extra = ' class="finding ' + priority + '"'
            blocks.append(f'<h{level} id="{identity}"{extra}>' + inline(label) + f'</h{level}>')
        index += 1
        continue
    if line.startswith('|') and index + 1 < len(lines) and re.match(r'^\|[\s:|\-]+\|$', lines[index + 1].strip()):
        rows = [table_row(line, 'th')]
        index += 2
        body = []
        while index < len(lines) and lines[index].strip().startswith('|'):
            body.append(table_row(lines[index], 'td'))
            index += 1
        blocks.append('<div class="table-wrap" tabindex="0" role="region" aria-label="Audito duomenų lentelė"><table><thead>' + ''.join(rows) + '</thead><tbody>' + ''.join(body) + '</tbody></table></div>')
        continue
    ordered = re.match(r'^\d+\. ', line)
    if ordered or line.startswith('- '):
        tag = 'ol' if ordered else 'ul'
        items = []
        pattern = r'^\d+\. (.*)' if ordered else r'^- (.*)'
        while index < len(lines):
            item = re.match(pattern, lines[index].strip())
            if not item:
                break
            items.append('<li>' + inline(item[1]) + '</li>')
            index += 1
        blocks.append('<' + tag + '>' + ''.join(items) + '</' + tag + '>')
        continue
    para = [line]
    index += 1
    while index < len(lines) and lines[index].strip() and not re.match(r'^(#{1,6} |\||- |\d+\. )', lines[index].strip()):
        para.append(lines[index].strip())
        index += 1
    content = inline(' '.join(para))
    cls = ' class="verdict"' if para[0].startswith('**Verdiktas:') else ''
    blocks.append('<p' + cls + '>' + content + '</p>')

major = [(label, identity) for level, label, identity in headings if level == 2]
toc = ''.join('<a href="#' + identity + '"><span>' + escape(label.split('. ', 1)[0]).zfill(2) + '</span>' + escape(label.split('. ', 1)[-1]) + '</a>' for label, identity in major)
css = '''
:root{--ink:#182c3b;--muted:#62727e;--line:#dfe5e5;--paper:#fff;--canvas:#f3f5f3;--accent:#127368;--red:#b3283c;--amber:#9b5a09;--blue:#42697b}
*{box-sizing:border-box}html{scroll-behavior:smooth;scroll-padding-top:32px}body{margin:0;background:var(--canvas);color:var(--ink);font:16px/1.75 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--accent);text-decoration-thickness:1px;text-underline-offset:3px}a:hover{color:#073f39}a:focus-visible,button:focus-visible,summary:focus-visible,.table-wrap:focus-visible{outline:3px solid #28aa98;outline-offset:4px;border-radius:3px}button{font:inherit;cursor:pointer}.masthead{background:#142e38;color:#fff;padding:54px max(30px,calc((100vw - 1260px)/2));position:relative;overflow:hidden;border-top:5px solid #31b4a2}.masthead:after{content:"";position:absolute;width:370px;height:370px;border:1px solid #ffffff18;border-radius:50%;right:-80px;top:-140px;box-shadow:0 0 0 70px #ffffff06,0 0 0 140px #ffffff04;pointer-events:none}.eyebrow{margin:0 0 17px;font-size:12px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#9dd8cf}.masthead h1{font:500 clamp(34px,4.2vw,56px)/1.12 Georgia,serif;letter-spacing:-1px;margin:0;max-width:900px}.masthead .subtitle{color:#b4c9d0;margin:18px 0 0;font-size:15px}.masthead .hero-meta{display:flex;gap:10px;margin-top:25px;flex-wrap:wrap}.hero-meta span{border:1px solid #ffffff2a;border-radius:4px;padding:4px 11px;font-size:12px;font-weight:600;letter-spacing:.3px}.shell{max-width:1320px;display:grid;grid-template-columns:248px minmax(0,1fr);gap:38px;margin:0 auto;padding:36px 30px 80px}aside{position:sticky;top:24px;align-self:start}.nav-label{font-size:11px;font-weight:750;text-transform:uppercase;letter-spacing:1.8px;color:var(--muted);margin:0 0 15px 10px}.toc{display:grid;gap:4px}.toc a{display:flex;gap:11px;text-decoration:none;color:#43545f;padding:10px 10px;font-size:13px;line-height:1.5;border-radius:5px}.toc a span{font-size:11px;color:#86969e;font-variant-numeric:tabular-nums;padding-top:2px}.toc a:hover,.toc a.active{background:#e3ece8;color:#075f55}.toc a.active span{color:#127368}.aside-tools{border-top:1px solid var(--line);margin:25px 10px 0;padding-top:19px;display:grid;gap:10px}.aside-tools a,.aside-tools button{font-size:12px;text-align:left}.aside-tools button{border:0;background:transparent;color:var(--accent);padding:0}.aside-note{font-size:11px;color:var(--muted);margin:20px 10px 0;line-height:1.6}.article{background:var(--paper);border:1px solid var(--line);border-radius:8px;padding:34px clamp(24px,4vw,52px) 50px;min-width:0;box-shadow:0 7px 30px #173a3410}.article>p:first-child{font-size:13px;color:var(--muted);margin-top:0}.article p{margin:0 0 19px}.article .verdict{border-left:4px solid #b3283c;background:#fdf2f1;padding:20px 23px;line-height:1.65;border-radius:0 5px 5px 0;margin:22px 0}.article .verdict strong{color:#842337}.article h2{font:500 29px/1.25 Georgia,serif;letter-spacing:-.3px;margin:48px 0 22px;padding-top:28px;border-top:1px solid var(--line)}.article h3{font-size:20px;line-height:1.4;letter-spacing:-.2px;margin:34px 0 18px}.article .finding{position:relative;padding:15px 17px;border:1px solid var(--line);border-left:4px solid var(--blue);border-radius:4px;background:#f5f8f9}.article .finding.p0{border-left-color:var(--red);background:#fdf0f1;color:#8c2031}.article .finding.p1{border-left-color:#c78631;background:#fff8ed;color:#744209}strong{font-weight:690}code{font: .84em/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;background:#edf1f2;border:1px solid #e4e9eb;padding:2px 5px;border-radius:4px;overflow-wrap:anywhere;color:#254655}.table-wrap{overflow-x:auto;margin:25px 0 27px;border:1px solid var(--line);border-radius:5px}table{border-collapse:collapse;width:100%;font-size:13px;line-height:1.5}th{background:#edf2f0;text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:.6px;padding:13px 15px;color:#40595d}td{padding:12px 15px;border-top:1px solid #e5e9e8;vertical-align:top}tbody tr:nth-child(even){background:#fafcfb}td:first-child{font-weight:550}td code{font-size:.93em}.priority{display:inline-flex;white-space:nowrap;font-size:11px;font-weight:750;letter-spacing:.5px;line-height:1.2;padding:5px 7px;border-radius:4px;background:#e7edf0;color:#426071}.priority.p0{background:#f9dfe3;color:#9c2238}.priority.p1{background:#ffedcc;color:#865005}.article ul,.article ol{padding-left:25px;margin:16px 0 24px}.article li{padding-left:4px;margin:12px 0}.article ol li::marker{font-weight:700;color:var(--accent)}.article .source-link{overflow-wrap:anywhere}.footer{font-size:12px;color:var(--muted);border-top:1px solid var(--line);margin-top:42px;padding-top:20px}.mobile-nav{display:none}.progress{position:fixed;bottom:0;height:3px;left:0;background:#178f7d;width:0;z-index:5}
@media(max-width:1000px){.shell{grid-template-columns:210px minmax(0,1fr);gap:22px;padding:25px 20px 60px}.article{padding:26px}.masthead{padding:42px 30px}}
@media(max-width:760px){body{font-size:15px}.masthead{padding:34px 22px}.masthead h1{letter-spacing:-.5px}.shell{display:block;padding:20px 14px 45px}.shell>aside{display:none}.article{padding:23px 20px;border-radius:5px}.article h2{font-size:26px;margin-top:36px}.article h3{font-size:18px}.article .verdict{padding:17px}.table-wrap{margin-left:-5px;margin-right:-5px}table{min-width:530px;font-size:12px}th,td{padding:10px 12px}.mobile-nav{display:block;background:#e7efec;border:1px solid #d5e1dc;border-radius:5px;padding:12px 15px;margin-bottom:18px}.mobile-nav summary{font-weight:650;font-size:13px;cursor:pointer;color:#214b43}.mobile-nav nav{padding-top:12px}.mobile-nav .tools{display:flex;gap:18px;font-size:12px;padding:12px 10px}.mobile-nav button{background:none;border:0;color:var(--accent);padding:0}.hero-meta{gap:6px!important}.hero-meta span{font-size:11px}.article p{overflow-wrap:break-word}}
@media print{@page{margin:18mm}body{background:#fff;font-size:10pt;color:#000}.masthead{background:#fff;color:#000;border:0;padding:0 0 20px}.masthead:after,.hero-meta,.subtitle,aside,.mobile-nav,.progress,.aside-tools{display:none!important}.eyebrow{color:#555}.masthead h1{font-size:28pt}.shell{display:block;padding:0;max-width:none}.article{padding:0;border:0;box-shadow:none}.article h2{break-after:avoid;font-size:20pt}.article h3{break-after:avoid;font-size:14pt}.table-wrap{overflow:visible}table{min-width:0;font-size:8pt}tr{break-inside:avoid}a{color:#234844}code{border:0}.footer{font-size:8pt}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}}
'''
md_link = escape(os.path.relpath(SOURCE, TARGET.parent), quote=True)
html = '''<!doctype html>
<html lang="lt"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Solidgate mokėjimų auditas · 2026-09-14</title><meta name="description" content="Boilerplate mokėjimų auditas: dubliavimas, pinigų apskaita, renewal, autentifikacija ir tikri duomenų patikros rezultatai."><style>''' + css + '''</style></head><body id="top">
<header class="masthead"><p class="eyebrow">Mokėjimų sistemos patikra · 2026-09-14</p><h1>Solidgate mokėjimų auditas</h1><p class="subtitle">Boilerplate kodas, pinigų istorija ir theastrologist DB patikra</p><div class="hero-meta"><span>15 radinių</span><span>P0 / P1 / P2 prioritetai</span><span>Auditas · pataisos neįdiegtos</span></div></header>
<div class="shell"><aside aria-label="Dokumento navigacija"><p class="nav-label">Dokumento turinys</p><nav class="toc">''' + toc + '''</nav><div class="aside-tools"><a href="''' + md_link + '''">Atverti Markdown šaltinį ↗</a><button type="button" onclick="window.print()">Spausdinti / išsaugoti PDF</button><a href="#top">Grįžti į pradžią ↑</a></div><p class="aside-note">Šaltinių nuorodos veda į kodo failus ir audito įrodymus. Visas turinys pateiktas šiame dokumente.</p></aside>
<main><details class="mobile-nav"><summary>Dokumento turinys ir eksportas</summary><nav class="toc">''' + toc + '''</nav><div class="tools"><a href="''' + md_link + '''">Markdown šaltinis</a><button type="button" onclick="window.print()">Spausdinti / PDF</button></div></details><article class="article">''' + '\n'.join(blocks) + '''<div class="footer">2026-09-14 · Solidgate mokėjimų auditas · Dokumento šaltinis: AUDIT_2026-09-14.lt.md</div></article></main></div><div class="progress" aria-hidden="true"></div>
<script>
(()=>{const bar=document.querySelector('.progress');const update=()=>{const max=document.documentElement.scrollHeight-innerHeight;bar.style.width=(max>0?100*scrollY/max:0)+'%'};addEventListener('scroll',update,{passive:true});addEventListener('resize',update);update();if('IntersectionObserver' in window){const links=[...document.querySelectorAll('.toc a')];const observer=new IntersectionObserver(entries=>{for(const entry of entries){if(entry.isIntersecting){links.forEach(link=>link.classList.toggle('active',link.getAttribute('href')==='#'+entry.target.id))}}},{rootMargin:'-5% 0px -72% 0px'});document.querySelectorAll('article h2').forEach(node=>observer.observe(node));}})();
</script></body></html>'''
TARGET.write_text(html)


class AuditParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = set()
        self.anchors = []
        self.source_anchors = []
        self.tables = 0
        self.headings = 0
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs:
            assert attrs['id'] not in self.ids, ('duplicate ID', attrs['id'])
            self.ids.add(attrs['id'])
        if tag == 'a':
            self.anchors.append(attrs.get('href', ''))
            if attrs.get('class') == 'source-link':
                self.source_anchors.append(attrs.get('href', ''))
        if tag == 'table': self.tables += 1
        if re.fullmatch('h[1-6]', tag): self.headings += 1

parsed = AuditParser()
parsed.feed(html)
assert len(parsed.source_anchors) == len(links)
assert parsed.headings == len(headings)
assert parsed.tables == len(re.findall(r'^\|[\s:|\-]+\|$', source, flags=re.M))
missing = []
for url in parsed.anchors:
    if url.startswith('#'):
        assert url[1:] in parsed.ids, ('broken internal anchor', url)
    elif not urlsplit(url).scheme:
        filepath = url.partition('#')[0]
        if not (TARGET.parent / filepath).resolve().is_file():
            missing.append(url)
print('Rendered:', TARGET.relative_to(ROOT))
print('Headings:', parsed.headings, 'Tables:', parsed.tables, 'Source links:', len(links), 'Internal anchors: valid')
print('Missing local link targets:', sorted(set(missing)))
assert not missing, 'Missing evidence/source links'

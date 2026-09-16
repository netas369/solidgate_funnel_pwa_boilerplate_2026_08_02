#!/usr/bin/env python3
"""Build the app's public documentation from its allowlisted Markdown sources.

Run locally with Python 3 and pandoc. Generated JSON is checked in, so the
Next.js build and deployed application do not need Python, pandoc, or filesystem
access. This script never reads application configuration or calls an API.
"""

from __future__ import annotations

import ast
from collections import Counter
from html import escape, unescape
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import subprocess
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
SOURCE_ROOT = ROOT / "docs/solidgate"
OUTPUT = ROOT / "apps/funnel/src/features/documentation/generated"

GROUPS = [
    {"id": "getting-started", "title": "Pradžia", "description": "Sistemos žemėlapis, naujausios pataisos ir prisijungimo taisyklės."},
    {"id": "payment-flows", "title": "Mokėjimų srautai", "description": "Nuo checkout iki atnaujinimo: kanalai, produktai ir kainos."},
    {"id": "data-model", "title": "Duomenų modelis", "description": "Užsakymai, sąskaitos, prieigos teisės, kortelės ir DB funkcijos."},
    {"id": "reliability", "title": "Patikimumas", "description": "Webhook apdorojimas, eilės ir ankstesnių pataisų kontekstas."},
    {"id": "audit-history", "title": "Auditas ir istorija", "description": "Pirminio audito įrodymai, architektūra ir šaltinio projekto analizė."},
]

# Explicit public allowlist. The names are deliberately independent of filenames
# so changing the source layout does not break published documentation URLs.
# file, slug, title, description, group, updatedAt, status
DOCUMENTS = [
    ("FIXES_2026-09-14.lt.md", "audit-fixes", "Audito pataisos ir pinigų žurnalas", "Kas pataisyta po pilno audito, kur saugomi finansiniai faktai ir kaip tikrinti pinigų bei prenumeratų istoriją.", "getting-started", "2026-09-14", "current"),
    ("payments/00-apzvalga.lt.md", "overview", "Apžvalga ir sistemos žemėlapis", "Pagrindinės sąvokos, mokėjimo kelias, sistemos komponentai ir ryšys su naujausiomis pataisomis.", "getting-started", "2026-09-11", "historical"),
    ("AUTH_BILLING_ROLLOUT.md", "auth-rollout", "Prisijungimas ir billing atkūrimas", "Pašto patvirtinimas, kortelės nuosavybė, prieigos ribos ir pataisų išleidimo seka.", "getting-started", "2026-09-14", "current"),
    ("payments/01-srautai.lt.md", "payment-flows", "Srautai žingsnis po žingsnio", "Funnel checkout, OTO, PWA pirkimai, 3DS, kortelės keitimas ir foninis apdorojimas.", "payment-flows", "2026-09-11", "historical"),
    ("payments/08-produktu-katalogas-ir-kodai.lt.md", "product-catalog", "Produktų katalogas ir kodai", "Kaip produkto kodas ir kaina keliauja nuo konfigūracijos iki Solidgate, užsakymo ir prieigos.", "payment-flows", "2026-09-11", "historical"),
    ("payments/02-lenteles-orders-entitlements.lt.md", "orders-entitlements", "Orders ir prieigos teisės", "Užsakymo tapatybė, sumos, būsenos, entitlement ribos ir kiekvieno lauko paskirtis.", "data-model", "2026-09-11", "historical"),
    ("payments/03-lenteles-prenumeratos-saskaitos.lt.md", "renewals-invoices", "Pratęsimai, sąskaitos ir intro", "Renewal įrašai, prenumeratos sąskaitos, intro ribojimas ir mokėjimų atribucija.", "data-model", "2026-09-11", "historical"),
    ("payments/04-lenteles-checkout-korteles-tokenai.lt.md", "checkout-cards", "Checkout, kortelės ir tokenai", "Išsaugota checkout būsena, kortelių saugyklos, atnaujinimo bandymai ir tokenų sinchronizacija.", "data-model", "2026-09-11", "historical"),
    ("payments/06-lenteles-platforma.lt.md", "platform-sessions", "Sesijos ir platforma", "Funnel sesijos, paskyros, operatoriaus pagalbiniai duomenys ir jų apsaugos.", "data-model", "2026-09-11", "historical"),
    ("payments/07-funkcijos-rpc-triggeriai.lt.md", "database-functions", "DB funkcijos, RPC ir triggeriai", "Atominės operacijos, konkurencijos kontrolė, būsenų taisyklės ir duomenų bazės view.", "data-model", "2026-09-11", "historical"),
    ("payments/05-lenteles-webhook-eiles.lt.md", "webhook-queues", "Webhook inbox ir darbų eilės", "Įvykių priėmimas, deduplikacija, tvarka, užraktai ir patvarus darbų vykdymas.", "reliability", "2026-09-11", "historical"),
    ("STRIPE_CLEANUP.lt.md", "stripe-cleanup", "Stripe išvalymas ir renewal indeksas", "Ankstesnės integracijos pavadinimų sutvarkymas ir pratęsimo įrašų unikalumo pataisa.", "reliability", "2026-09-11", "historical"),
    ("BOILERPLATE_REVIEW.lt.md", "boilerplate-review", "Boilerplate peržiūra ir pataisos", "Ankstesnės kodo peržiūros išvados, jau įgyvendintos rekomendacijos ir patikrų kontekstas.", "reliability", "2026-09-11", "historical"),
    ("AUDIT_2026-09-14.lt.md", "audit-2026-09-14", "Pilnas auditas prieš pataisas", "Pradiniai radiniai apie prisijungimą, pinigų apskaitą, renewal, refund, chargeback ir ataskaitas.", "audit-history", "2026-09-14", "historical"),
    ("boilerplate-architecture-audit.lt.md", "architecture", "Architektūra ir projekto paruošimas", "Pirminės sistemos architektūros schema, modulio ribos ir naujo projekto paruošimo kontekstas.", "audit-history", "2026-09-09", "historical"),
    ("HANDOFF.lt.md", "handoff", "Darbo kontekstas ir tęstinumas", "Analizės kilmė, priimti sprendimai ir ankstesnių darbų perdavimo užrašai.", "audit-history", "2026-09-09", "historical"),
    ("price-map-and-catalog.lt.md", "price-map", "Šaltinio kainodara ir Solidgate katalogas", "Pirminio projekto pasiūlymai, kainų žemėlapis, prenumeratos sąlygos ir katalogo susiejimas.", "audit-history", "2026-09-09", "historical"),
    ("boilerplate-tables-core.lt.md", "source-core-tables", "Šaltinio pirkimų ir prieigos lentelės", "Pirminio projekto užsakymų, sąskaitų ir prieigos laukų žodynas bei audito įrodymai.", "audit-history", "2026-09-09", "historical"),
    ("boilerplate-tables-workflows.lt.md", "source-workflows", "Šaltinio checkout ir kortelių lentelės", "Pirminio projekto checkout būsenos, kortelių tokenai, atnaujinimas ir sinchronizacija.", "audit-history", "2026-09-09", "historical"),
    ("boilerplate-tables-events.lt.md", "source-events", "Šaltinio webhook ir įvykių lentelės", "Pirminio projekto įvykių tvarka, inbox, outbox, pakartojimas ir darbų eilių garantijos.", "audit-history", "2026-09-09", "historical"),
]


def plain(value: str) -> str:
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]*>", "", value))).strip()


def public_paths(value: str) -> str:
    """Keep the project/source identity, omit workstation-specific prefixes."""
    return re.sub(r"(?:file://)?/Users/[^/\s]+/Projects/", "", value)


def original_sources() -> set[str]:
    # Parse the reader's manifest without executing its HTML build side effects.
    tree = ast.parse((ROOT / "output/solidgate-reader/build_full_reader.py").read_text())
    for node in tree.body:
        if isinstance(node, ast.Assign) and any(isinstance(target, ast.Name) and target.id == "SOURCES" for target in node.targets):
            return {item[2] for item in ast.literal_eval(node.value)}
    raise AssertionError("The existing documentation source manifest is missing")


def source_reference(url: str, source: Path) -> str:
    decoded = unquote(url)
    if decoded.startswith(("/Users/", "file:///Users/")):
        return public_paths(decoded)
    path, _, fragment = decoded.partition("#")
    target = (source.parent / path).resolve()
    try:
        label = target.relative_to(ROOT).as_posix()
    except ValueError:
        # Links outside the public source allowlist are references only. The app
        # never reads or serves the referenced file.
        label = path.lstrip("./")
    return label + (f"#{fragment}" if fragment else "")


class ValidateHtml(HTMLParser):
    """Reject executable markup or accidentally published workstation paths."""

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        assert tag not in {"script", "iframe", "object", "embed", "style", "form", "input"}, f"Unexpected active HTML: {tag}"
        for key, value in attrs:
            assert not key.lower().startswith("on"), f"Unexpected event attribute: {key}"
            if key in {"href", "src"} and value:
                assert not re.match(r"(?:javascript|data|file):", value, re.I), f"Unexpected URL scheme: {key}"


def build() -> None:
    assert {entry[0] for entry in DOCUMENTS} == original_sources(), "Public documents must match the reader's 20-source manifest"
    assert len({entry[1] for entry in DOCUMENTS}) == len(DOCUMENTS)
    assert all(entry[4] in {group["id"] for group in GROUPS} for entry in DOCUMENTS)
    by_path = {(SOURCE_ROOT / entry[0]).resolve(): entry[1] for entry in DOCUMENTS}
    by_name = {Path(entry[0]).name: entry[1] for entry in DOCUMENTS}
    rendered_docs: dict[str, str] = {}
    ids_by_slug: dict[str, set[str]] = {}
    removed_titles: dict[str, str] = {}
    metadata = []

    for filename, slug, title, description, group, updated_at, status in DOCUMENTS:
        source = SOURCE_ROOT / filename
        markdown = source.read_text()
        assert not re.search(r"\b(?:sk_(?:live|test)_|sb_secret_|eyJ[A-Za-z0-9_-]{25})", markdown), f"Potential credential in {filename}"
        assert not re.search(r"[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}", markdown), f"Review email address before publishing {filename}"
        rendered = subprocess.run(["pandoc", "-f", "gfm", "-t", "html5", "--wrap=none", str(source)], check=True, capture_output=True, text=True).stdout
        first_title = re.search(r'<h1(?: id="([^"]+)")?[^>]*>.*?</h1>\s*', rendered, re.S)
        if first_title:
            removed_titles[slug] = first_title.group(1) or ""
            rendered = rendered[:first_title.start()] + rendered[first_title.end():]
        # The route has one title. Any additional H1 from a concatenated source
        # becomes a content section rather than a second document title.
        rendered = re.sub(r"<(/?)h1(\s|>)", r"<\1h2\2", rendered)
        all_ids = re.findall(r'\bid="([^"]+)"', rendered)
        duplicates = [heading_id for heading_id, count in Counter(all_ids).items() if count > 1]
        assert not duplicates, f"Duplicate IDs in {filename}: {duplicates}"
        headings = [
            {"id": match.group(2), "text": plain(match.group(3)), "level": int(match.group(1))}
            for match in re.finditer(r'<h([2-6]) id="([^"]+)"[^>]*>(.*?)</h\1>', rendered, re.S)
        ]
        metadata.append({"slug": slug, "title": title, "description": description, "group": group, "source": f"docs/solidgate/{filename}", "updatedAt": updated_at, "status": status, "headings": headings})
        rendered_docs[slug] = rendered
        ids_by_slug[slug] = set(all_ids)

    internal_links: list[tuple[str, str, str]] = []
    contents: dict[str, list[dict[str, str]]] = {}
    reference_count = 0
    for filename, slug, *_ in DOCUMENTS:
        source = SOURCE_ROOT / filename

        def rewrite_link(match: re.Match[str]) -> str:
            nonlocal reference_count
            url, attrs, label = unescape(match.group(1)), match.group(2), match.group(3)
            split = urlsplit(url)
            if split.scheme in {"https", "http"}:
                return f'<a href="{escape(url, quote=True)}"{attrs} target="_blank" rel="noopener noreferrer">{label}</a>'
            path, _, fragment = unquote(url).partition("#")
            target_slug = None
            if not path:
                target_slug = slug
            elif not split.scheme:
                target_slug = by_path.get((source.parent / path).resolve()) or by_name.get(Path(path).name)
            if target_slug:
                if fragment == removed_titles.get(target_slug) or re.fullmatch(r"L\d+(?:-L?\d+)?", fragment):
                    fragment = ""
                if fragment:
                    assert fragment in ids_by_slug[target_slug], f"Broken document anchor: {filename} → {url}"
                internal_links.append((slug, target_slug, fragment))
                href = f"/documentation/{target_slug}" + (f"#{fragment}" if fragment else "")
                return f'<a href="{escape(href, quote=True)}"{attrs}>{label}</a>'
            if Path(path).name == "README.md" and (source.parent / path).resolve() == SOURCE_ROOT / "README.md":
                return f'<a href="/documentation"{attrs}>{label}</a>'
            reference_count += 1
            reference = source_reference(url, source)
            return f'<span class="documentation-source-reference" title="{escape(reference, quote=True)}" aria-label="{escape(plain(label) + ": " + reference, quote=True)}">{label}</span>'

        rendered = re.sub(r'<a href="([^"]+)"([^>]*)>(.*?)</a>', rewrite_link, rendered_docs[slug], flags=re.S)
        rendered = public_paths(rendered)
        # Scrolling wrappers keep wide schema/price tables inside the article.
        rendered = re.sub(r"<table>(.*?)</table>", r'<div class="documentation-table-scroll" role="region" aria-label="Dokumentacijos lentelė" tabindex="0"><table>\1</table></div>', rendered, flags=re.S)
        blocks = []
        cursor = 0
        for index, match in enumerate(re.finditer(r'<pre class="mermaid"><code>(.*?)</code></pre>|<pre class="mermaid">(.*?)</pre>', rendered, re.S), 1):
            if rendered[cursor:match.start()].strip():
                blocks.append({"type": "html", "html": rendered[cursor:match.start()].strip()})
            blocks.append({"type": "mermaid", "code": unescape(match.group(1) or match.group(2)).strip(), "id": f"docs-{slug}-diagram-{index}"})
            cursor = match.end()
        if rendered[cursor:].strip():
            blocks.append({"type": "html", "html": rendered[cursor:].strip()})
        assert blocks, f"Empty document {filename}"
        contents[slug] = blocks
        for block in blocks:
            serialized = json.dumps(block, ensure_ascii=False)
            assert "/Users/" not in serialized and "file://" not in serialized, f"Local path escaped redaction: {filename}"
            if block["type"] == "html":
                ValidateHtml().feed(block["html"])

    diagrams = sum(block["type"] == "mermaid" for blocks in contents.values() for block in blocks)
    assert diagrams == 3, f"Expected all 3 source Mermaid diagrams, found {diagrams}"
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, data in [("groups.json", GROUPS), ("metadata.json", metadata), ("content.json", contents)]:
        (OUTPUT / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    print(f"Built {len(metadata)} documents in {len(GROUPS)} sections; {sum(len(item['headings']) for item in metadata)} headings; {diagrams} Mermaid diagrams.")
    print(f"Validated {len(internal_links)} internal document links and {reference_count} readable source references; no credentials, email addresses, or local home paths.")


if __name__ == "__main__":
    build()

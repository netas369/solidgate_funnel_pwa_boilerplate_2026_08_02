# Solidgate modulio auditas ir darbų tęsinys

Visa 2026-09-09 atlikta analizė perkelta į šį projektą. Darbus tęsiame čia, naudodami **API v1 / Billing 1.0**.

**Skaityti viename puslapyje:** [visa analizė HTML formatu](../../output/solidgate-reader/solidgate-analysis.html). Failas veikia lokaliai, be serverio ir interneto. Chrome jį galima atidaryti per „Open File“ / `⌘O`. Turinys leidžia pereiti prie temos; `⌘F` / `Ctrl+F` ieško visame tekste.

## Skaitymo tvarka

0. [Dabartinio boilerplate peržiūra ir pratęsimų pataisa](BOILERPLATE_REVIEW.lt.md) — patikrinti šio repo radiniai, įgyvendinti prieigos pataisymai, testai ir likę darbai.
1. [Tęstinumo užrašas ir tolesni darbai](HANDOFF.lt.md) — kas patikrinta, kas nuspręsta ir kaip tęsti šiame boilerplate.
2. [Architektūros auditas](boilerplate-architecture-audit.lt.md) — sistemos srautas, radiniai, modulio ribos, siūloma schema ir naujo projekto setup seka.
3. [Price map ir Solidgate katalogas](price-map-and-catalog.lt.md) — kainos, pasiūlymai, prenumeratos sąlygos, providerio ID ir checkout pavyzdys.
4. [Pirkimų, sąskaitų ir prieigos lentelės](boilerplate-tables-core.lt.md) — 9 lentelės, 146 stulpeliai.
5. [Checkout, kortelių ir tokenų lentelės](boilerplate-tables-workflows.lt.md) — 7 lentelės, 98 stulpeliai.
6. [Webhook ir darbų eilių lentelės](boilerplate-tables-events.lt.md) — 6 lentelės, 63 stulpeliai.

Žodynuose iš viso aprašytos **22 lentelės ir 307 stulpeliai**. Tai analizuoto šaltinio lentelės; jų skaičius nėra reikalavimas naujai boilerplate schemai.

## Analizės kilmė

Keturi `boilerplate-*.lt.md` dokumentai analizuoja `/Users/Netas/Projects/theastrologist` darbo katalogo kodą ir migracijas. Jie nukopijuoti nepakeitus turinio. Price map paaiškinimas remiasi tuo pačiu šaltiniu. Nuorodos į seno projekto failus ir eilučių numerius išsaugotos kaip įrodymai; jos nepervadintos į tariamas šio boilerplate kodo vietas.

Šis boilerplate jau turi kitokių sprendimų. Todėl prieš taisant radinį būtina sutikrinti jį su dabartiniu šio projekto kodu. Įgyvendintos rekomendacijos vėliau žymimos atskirai nuo pirminio audito.

[Perkėlimo manifestas](audit-transfer-manifest.json) saugo originalių keturių dokumentų SHA-256, šaltinio ir paskirties projektus bei Git HEAD. Šaltinio darbo katalogas turėjo necommitintų pakeitimų, todėl vien Git HEAD neatkuria audituotos būsenos.

Jau buvę [įgyvendinimo dokumentas](IMPLEMENTATION_AND_MIGRATION_GUIDE.md) ir [go-live runbook](go-live-runbook.md) palikti kaip atskiri šio projekto dokumentai. Perkėlimas jų teiginių nepatvirtina ir neatnaujina.

## Skaityklės atnaujinimas

Redaguoti Markdown šaltinius šiame kataloge, tada iš projekto šaknies vykdyti:

```bash
python3 output/solidgate-reader/build_full_reader.py
```

Reikia `python3` ir `pandoc`. Generavimas vietinis, be API kvietimų. HTML stilius ir šablonas laikomi kartu su skaitykle, todėl nereikia Codex pluginų ar pradinio projekto failų skaityklei atkurti.

Pagrindiniai rezultatai:

- `output/solidgate-reader/solidgate-analysis.html` — pilnas HTML puslapis naršyklei.
- `output/solidgate-reader/solidgate-full-analysis.html` — tos pačios analizės įterpiama peržiūra.
- `output/solidgate-reader/full-source-manifest.json` — dabartinių skaityklės šaltinių kontrolinės sumos.

Senas `solidgate-reader.html` su dokumentų perjungimu ir jo generavimo failai taip pat išsaugoti kaip ankstesnė versija. Aktualus skaitymo puslapis yra `solidgate-analysis.html`.

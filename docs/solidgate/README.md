# Solidgate modulio dokumentacija ir auditas

Visa medžiaga skaitoma **funnel appse, adresu `/documentation`**. Dokumentai suskirstyti pagal temas, kiekvienas turi savo URL, skyrių turinį ir paiešką. Mermaid diagramos atvaizduojamos pačiame appse, be išorinio CDN. Kol kas dokumentacija vieša, be slaptažodžio; puslapiai pažymėti `noindex`.

Vietinis adresas: `http://localhost:3205/documentation` (`npm run dev:funnel`). Ankstesnis [`solidgate-analysis.html`](../../output/solidgate-reader/solidgate-analysis.html) išsaugotas kaip atskirai atidaromas archyvas.

Dokumentacijos UI ir naujo appso instrukcijos naudoja tik **shadcn/ui Base Nova** komponentus ir juodos, baltos bei neutralių pilkų tonų paletę. Komponentai laikomi `apps/funnel/src/components/ui/`, konfigūracija – `apps/funnel/components.json`. Markdown turiniui paliekamas semantinis HTML su skaitymo stiliais; Mermaid schemos generuojamos monochromiškai, o jų valdikliai ir langai yra shadcn. Ši tema taikoma dokumentacijos layout ir jo langams.

Darbus tęsiame naudodami **API v1 / Billing 1.0**.

**2026-09-15 — statinis Descriptor visiems produktams.** Banko išrašo Descriptor nustatomas Solidgate kanale / connector ir naudojamas main, trial, OTO2 prenumeratai, vienkartiniams OTO, PWA pirkimams bei renewal. Naujose užklausose aplikacija nesiunčia `dynamic_descriptor` ir nekuria produkto suffix. Jau pradėto checkout išsaugotas payload nekeičiamas vien dėl šio atnaujinimo. Locale pagrįsti `product_code`, `order_description` ir UTM išlieka atskiri pirkimo duomenys. [Įgyvendinimo taisyklė](IMPLEMENTATION_AND_MIGRATION_GUIDE.md#8-static-statement-descriptor), [srautų papildymas](payments/01-srautai.lt.md). Oficialus OpenAPI aprašo providerio galimybes; tai nekeičia šio appso statinės politikos.

**Naujo appso instrukcijos:** `/documentation/setup` — [penkių žingsnių seka](setup/README.md): 01 produktai, 02 katalogas ir OTO, 03 DB bei webhook, 04 checkout ir OTO, 05 sandbox patikra. Kiekvienas žingsnis turi atskirą URL, reikalingą įvestį, perduodamus failus, priėmimo kriterijus ir kopijuojamą agento promptą. Bendras 02–05 planas apima main variantus, vieną OTO2 prenumeratą ir kitus vienkartinius OTO. Šis interaktyvus skyrius laikomas atskirai nuo 20 archyvinės skaityklės šaltinių; jo kodas yra `apps/funnel/src/features/documentation/setup/`. Markdown atitikmenys generuojami `npm run docs:setup:build`, tikrinami `npm run docs:setup:check`.

**2026-09-14:** [pilnas auditas](AUDIT_2026-09-14.lt.md) ir [įgyvendintos pataisos, pinigų žurnalas bei diegimo seka](FIXES_2026-09-14.lt.md). Senesni lentelių kiekiai ir srautų aprašymai žemiau yra iki šių pataisų; naujų finansinių lentelių aprašymas yra pataisų dokumente.

## Blokas 1. Mokėjimų sistema: dabartinis boilerplate

Katalogas `payments/`. Aprašo šio repo kodą tokį, koks jis yra: 24 lentelės ir 313 stulpelių (kiekvienas stulpelis su tipu, reikšme, rašytojais, skaitytojais ir apsaugomis), 76 DB funkcijos ir 15 trigger'ių, visi srautai ir produktų katalogas. Tai pagrindas būsimai „žingsnis po žingsnio“ produkto pritaikymo instrukcijai.

0. [Apžvalga ir žemėlapis](payments/00-apzvalga.lt.md) — kas tai, pagrindinis srautas, sąvokos, lentelių inventorius, kur kas gyvena kode.
1. [Srautai žingsnis po žingsnio](payments/01-srautai.lt.md) — checkout, OTO, prieiga, paskyra, PWA pirkimai, kortelės keitimas, webhook, worker, aplinkos, operatoriaus įrankiai.
2. [Lentelės: orders ir entitlements](payments/02-lenteles-orders-entitlements.lt.md)
3. [Lentelės: prenumeratų sąskaitos, intro ribojimas, atribucija](payments/03-lenteles-prenumeratos-saskaitos.lt.md)
4. [Lentelės: checkout būsenos, kortelių saugyklos, tokenų sinchronizacija](payments/04-lenteles-checkout-korteles-tokenai.lt.md)
5. [Lentelės: webhook inbox, įvykių tvarka, darbų eilės](payments/05-lenteles-webhook-eiles.lt.md)
6. [Lentelės: sesijos, auth ir platformos pagalbinės](payments/06-lenteles-platforma.lt.md)
7. [DB funkcijos: RPC, trigger'iai, view](payments/07-funkcijos-rpc-triggeriai.lt.md)
8. [Produktų katalogas ir kodai](payments/08-produktu-katalogas-ir-kodai.lt.md) — kodo gramatika, visos vietos, kurios keičiasi kartu, palyginimas su šaltinio projektu.

## Blokas 2. Šaltinio auditas ir peržiūros

00. [Stripe palikimo išvalymas ir pratęsimų žurnalo indekso pataisa](STRIPE_CLEANUP.lt.md) — 2026-09-11: kas iš Stripe realiai liko (tik pavadinimai), kas išvalyta, `orders.psp` sprendimas, ir patikrintas kritinis `renewal_events` upsert radinys su pataisa.
0. [Dabartinio boilerplate peržiūra ir pratęsimų pataisa](BOILERPLATE_REVIEW.lt.md) — patikrinti šio repo radiniai, įgyvendinti prieigos pataisymai, testai ir likę darbai.
1. [Tęstinumo užrašas ir tolesni darbai](HANDOFF.lt.md) — kas patikrinta, kas nuspręsta ir kaip tęsti šiame boilerplate.
2. [Architektūros auditas](boilerplate-architecture-audit.lt.md) — sistemos srautas, radiniai, modulio ribos, siūloma schema ir naujo projekto setup seka.
3. [Price map ir Solidgate katalogas](price-map-and-catalog.lt.md) — kainos, pasiūlymai, prenumeratos sąlygos, providerio ID ir checkout pavyzdys.
4. [Pirkimų, sąskaitų ir prieigos lentelės](boilerplate-tables-core.lt.md) — 9 lentelės, 146 stulpeliai.
5. [Checkout, kortelių ir tokenų lentelės](boilerplate-tables-workflows.lt.md) — 7 lentelės, 98 stulpeliai.
6. [Webhook ir darbų eilių lentelės](boilerplate-tables-events.lt.md) — 6 lentelės, 63 stulpeliai.

Šaltinio žodynuose aprašytos **22 lentelės ir 307 stulpeliai** — tai analizuoto pirminio projekto lentelės, ne šio repo. Dabartinio boilerplate lentelės (24, 313 stulpelių) aprašytos 1 bloke.

## Analizės kilmė

Keturi `boilerplate-*.lt.md` dokumentai analizuoja `/Users/Netas/Projects/theastrologist` darbo katalogo kodą ir migracijas. Jie nukopijuoti nepakeitus turinio. Price map paaiškinimas remiasi tuo pačiu šaltiniu. Nuorodos į seno projekto failus ir eilučių numerius išsaugotos kaip įrodymai; jos nepervadintos į tariamas šio boilerplate kodo vietas.

Šis boilerplate jau turi kitokių sprendimų. Todėl prieš taisant radinį būtina sutikrinti jį su dabartiniu šio projekto kodu. Įgyvendintos rekomendacijos vėliau žymimos atskirai nuo pirminio audito.

[Perkėlimo manifestas](audit-transfer-manifest.json) saugo originalių keturių dokumentų SHA-256, šaltinio ir paskirties projektus bei Git HEAD. Šaltinio darbo katalogas turėjo necommitintų pakeitimų, todėl vien Git HEAD neatkuria audituotos būsenos.

Jau buvę [įgyvendinimo dokumentas](IMPLEMENTATION_AND_MIGRATION_GUIDE.md) ir [go-live runbook](go-live-runbook.md) palikti kaip atskiri šio projekto dokumentai. Perkėlimas jų teiginių nepatvirtina ir neatnaujina.

## Appso dokumentacijos atnaujinimas

Redaguoti Markdown šaltinius šiame kataloge, tada iš projekto šaknies vykdyti:

```bash
npm run docs:build
```

Generatoriui reikia vietinių `python3` ir `pandoc`. Jis sugeneruoja turinį į `apps/funnel/src/features/documentation/generated/`; šiuos failus reikia įtraukti kartu su Markdown pakeitimais. Next.js build naudoja paruoštą turinį ir nereikalauja `pandoc`, DB ar išorinių API. Naują dokumentą ir jo temą pridėti į `scripts/build-documentation.py` sąrašą `DOCUMENTS` ir archyvinės skaityklės `SOURCES` manifestą. Viešame puslapyje nuorodos į kitus dokumentus veda į `/documentation/...`, o lokalių šaltinio failų keliai pateikiami kaip repo nuorodos be kompiuterio absoliutaus kelio.

Naujausios pataisos ir ankstesnės sistemos aprašymai pažymėti atskirai. Istoriniai lentelių kiekiai nėra dabartinio inventoriaus patvirtinimas.

## Archyvinės HTML skaityklės atnaujinimas

Redaguoti Markdown šaltinius šiame kataloge (1 blokas — `payments/`, 2 blokas — šis katalogas), tada iš projekto šaknies vykdyti:

```bash
python3 output/solidgate-reader/build_full_reader.py
```

Reikia `python3` ir `pandoc`. Generavimas vietinis, be API kvietimų. HTML stilius ir šablonas laikomi kartu su skaitykle, todėl nereikia Codex pluginų ar pradinio projekto failų skaityklei atkurti.

Pagrindiniai rezultatai:

- `output/solidgate-reader/solidgate-analysis.html` — pilnas HTML puslapis naršyklei.
- `output/solidgate-reader/solidgate-full-analysis.html` — tos pačios analizės įterpiama peržiūra.
- `output/solidgate-reader/full-source-manifest.json` — dabartinių skaityklės šaltinių kontrolinės sumos ir blokas.

Naują dokumentą pridėti į `SOURCES` sąrašą `build_full_reader.py` faile su bloko raktu (`payments` arba `audit`); turinys, greita navigacija ir bloko antraštės susigeneruoja.

Senas `solidgate-reader.html` su dokumentų perjungimu ir jo generavimo failai taip pat išsaugoti kaip ankstesnė versija. Aktualus skaitymo puslapis yra appso `/documentation`.

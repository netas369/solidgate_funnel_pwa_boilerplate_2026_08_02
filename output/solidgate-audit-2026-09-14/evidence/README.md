# 2026-09-14 Solidgate audito įrodymai

Pagrindinė ataskaita: [AUDIT_2026-09-14.lt.md](../../../docs/solidgate/AUDIT_2026-09-14.lt.md).

## Turinys

- `live-summary.json` – galutinės `theastrologist` tik skaitymo patikros agregatai. Jokių klientų el. paštų, kortelių tokenų ar raktų.
- `live-diagnostics.sql` – tiksli SELECT užklausa, įskaitant aiškią tikrinamų pinigų likučių formulę ir aprėptį. Tai nėra pataisa ar apskaitos sistemos specifikacija.
- `orders-review.md`, `renewals-review.md`, `checkout-review.md` – atskirų audito dalių išsamūs radiniai, šaltinių vietos ir įrodymų ribos. Istorinės `/tmp` nuorodos juose nurodo pirmines vykdymo vietas; reikalingos kopijos yra šiame kataloge.
- `*-audit.test.ts.txt` – minimalios naujų webhook scenarijų kopijos. `.txt` galūnė neleidžia netyčia jų prijungti prie įprasto testų rinkinio.
- `orders-results.txt`, `renewals-results.txt` – jų pirminiai rezultatai; nauji testai sąmoningai tikrina teisingą elgseną, todėl audituotame kode nepraeina.
- `checkout-proof.cjs`, `card-update-proof.cjs`, `reporting-proof.cjs` – tikro TypeScript kodo vietinės imitacijos. Jos tikrina pastebėtą klaidingą elgseną, todėl audituotame kode praeina.
- `existing-*-tests.txt`, `existing-kpi-retry.txt` – esamų testų paleidimo žurnalai. Vienas KPI testas bendrame lygiagrečiame paleidime viršijo laiką; atskirai praėjo.
- `sql/` – aštuonių SQL rinkinių žurnalai; concurrency vykdytas du kartus.

## Pakartoti naujas reprodukcijas vietoje

Iš repo šaknies, su jau įdiegtomis projekto priklausomybėmis:

```sh
node output/solidgate-audit-2026-09-14/evidence/run-reproductions.mjs
```

Runner sukuria tik laikiną harness OS temp kataloge, importuoja dabartinį repo kodą, blokuoja webhook testų tinklą, naudoja Supabase / auth / provider imitacijas. Jis nekeičia DB ar mokėjimų ir nieko neinstaliuoja. Audituotoje versijoje numatyta **14 nepraeinančių teisingos elgsenos teiginių** ir exit code 1; po pataisų teiginiai turėtų pradėti praeiti. Vienas testas skirtas nepilnam provider payload, kitas kelių invoice ribinei kombinacijai – jų gyvas paplitimas nepatvirtintas.

Tai nėra pilni webhook ir PostgreSQL integraciniai testai. Tikri SQL rinkiniai paleidžiami atskiroje naujoje DB pagal [supabase/tests/README.md](../../../supabase/tests/README.md); jų negalima vykdyti produkcijoje.

Produkcijos mokėjimai, providerio operacijų eksportas, tikra paskyros ataka ir mokamos API operacijos šio audito metu nevykdyti. Galutinė ataskaita aiškiai atskiria gyvos DB stebėjimus nuo lokalių atkurtų scenarijų.

Papildomai tie patys 14 teiginių pakartoti su dabartine `trial4` USD 1700 centų kaina; visi 14 pakartotinai nepraėjo dėl tų pačių priežasčių. Žurnalas: `canonical-price-reproduction-run.txt`. Paleidimas: `SOLIDGATE_AUDIT_CANONICAL_PRICE=1 node output/solidgate-audit-2026-09-14/evidence/run-reproductions.mjs`. Pirminiai 1767 centų fixture yra sintetiniai ir nėra dabartinio kainoraščio kopija.

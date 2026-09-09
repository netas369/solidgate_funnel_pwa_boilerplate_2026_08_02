# Solidgate modulio darbų tęstinumas

Atnaujinta 2026-09-09. Vartotojo nurodyta tolesnio darbo vieta: `/Users/Netas/Projects/solidgate_funnel_pwa_boilerplate_2026_08_02`.

## Naujausias darbas šiame boilerplate

Vartotojas patikslino, kad nepratęsiama **pagrindinės narystės** prieiga. Vietoje
atkurtos ir pataisytos konkrečios webhook / DB problemos: pratęsimą aplenkiantis
mokamo invoice callback, ankstesnio dalinio refund atpažinimas, mokamo laikotarpio
pabaigos skaičiavimas ir senesnio callback bandymas sutrumpinti prieigą.
[Dabartinio boilerplate peržiūra](BOILERPLATE_REVIEW.lt.md) saugo pataisos ribas,
testų rezultatus, tik šio repo radinius ir tolesnių darbų prioritetus.
Produkcijos incidento priežastis be konkretaus payload dar nenustatyta; gyvos
DB, providerio konfigūracija ir mokėjimai nekeisti. Pataisyta boilerplate baseline
funkcija pati savaime neatnaujina jau sukurtų projektų DB.

## Tikslas

Paruošti komandai pakartotinai naudojamą Solidgate mokėjimų modulį funnel + PWA boilerplate. Produkto pakeitimai turi būti aiškiai atskirti nuo mokėjimų infrastruktūros. Pirmas etapas — suprasti dabartines lenteles, kiekvieną stulpelį, srautus ir patikimumo apsaugas; tada patvirtinti reikalingą schemą ir modulio ribas, įgyvendinti pakeitimus ir parengti konkrečią naujo projekto setup instrukciją.

Vartotojas šiuo metu skaito analizę ir klausia apie atskiras sistemos dalis. Paskutinis klausimas buvo apie `price-map.ts` ir `solidgate/catalog.ts`; jo išnagrinėtas paaiškinimas išsaugotas [atskirame dokumente](price-map-and-catalog.lt.md).

## Priimti sprendimai ir darbo taisyklės

- **API v1 / Billing 1.0.** Vartotojas perdavė tiesioginę Solidgate rekomendaciją dabar naudoti v1, o v2 atskirai išbandyti sandbox. V2 tyrimas nėra šio modulio paleidimo sąlyga; v2 sandbox neužsakytas ir nesukonfigūruotas.
- Modulio `customers`, `subscriptions`, `invoices` ar panašūs vietiniai domeno objektai savaime nereiškia v2 API naudojimo. Siūloma schema dar nepatvirtinta kaip galutinė migracija.
- Analizę pateikti lietuviškai. Naudotojui patogiausia visa medžiaga viename ištisiniame puslapyje su temų turiniu ir pilnais stulpelių paaiškinimais.
- Prieš atskirai apmokestinamą išorinį API kvietimą, AI generavimą, vertimo / QA ciklą ar benchmark būtinas išankstinis aiškus vartotojo leidimas ir konkreti maksimali pinigų suma. Raktų buvimas ir nurodymas dirbti savarankiškai nesuteikia leidimo išlaidoms. Taikomas vienas bendras limitas visiems agentams, pakartojimams ir lygiagretiems kvietimams. Pirmiausia naudoti vietinius darbus.
- Šio perkėlimo metu jokie providerio seed / apply / verify, mokėjimai, deploy ar DB migracijos nevykdyti. Raktai, `.env` ir realių providerio ID konfigūracija neperkelti.
- Prieš tęsiant skaityti projekto `CLAUDE.md`. Išlaikyti bendrinį boilerplate kontekstą; audito pavyzdžių prekės ženklų, kainų ir ID nekopijuoti į veikiančią konfigūraciją.

## Kas iš tikrųjų patikrinta

Pirminis auditas atliktas **`/Users/Netas/Projects/theastrologist` darbo kataloge**, įskaitant tuo metu esančius necommitintus pakeitimus. Keturi originalūs audito dokumentai perkelti nepakeitus turinio ir turi kontrolines sumas [manifeste](audit-transfer-manifest.json).

Aprašytos 22 lentelės ir 307 stulpeliai: 15 aktyvių mokėjimų lentelių, 4 gretimos platformos / analitikos lentelės ir 3 Stripe palikimo lentelės. Kiekviename žodyne paaiškinti tipai, NULL / default, raktai, naudojimas ir perkėlimo rekomendacijos.

Patikrintos migracijos, TypeScript naudojimas ir generuoti DB tipai. Produkcinė DB schema, realūs duomenys, užklausų planai ir Solidgate paskyros nustatymai netikrinti. Tai kodo auditas, o ne produkcinių incidentų ar išmatuoto našumo įrodymas.

Pirminio audito metu šaltinio projekte praėjo 56 vietiniai testai: 49 iš catalog / rpc-binding / grant-replay / session-vault / account-vault rinkinių ir 7 SQL kainų sutapimo testai. Pastarieji numatytoje `jsdom` aplinkoje neužsikrovė dėl `fileURLToPath`, bet praėjo su `--environment node`. Tikros DB transakcijos ir sandbox mokėjimai šiame audite netestuoti. **Šie rezultatai nepriskirtini šio boilerplate testams.**

Pirminės ištisinės skaityklės turinys sutikrintas su visais keturiais Markdown šaltiniais: 1 594 teksto elementai, 29 lentelės, visi 307 stulpelių įrašai, 40 nuorodų į vietinius kodo šaltinius. Skaityklės UI patikra ir failo perkėlimo patikra nėra mokėjimų srauto testai.

## Svarbiausi šaltinio audito radiniai

Tai sąrašas, ką reikia sutikrinti šiame boilerplate; jis neteigia, kad visos problemos čia tebėra.

1. Checkout el. pašto susiejimas su esama paskyra ir automatinis prisijungimas per `generateLink` / `verifyOtp`: būtina aiški autentifikacijos riba.
2. Entitlement klaidų ir prieigos tikrinimas: šaltinyje rasti fail-open scenarijai ir prieigos tikrinimas, kuris atmeta `revoked`, bet ne visada reikalauja egzistuojančios teisės.
3. Finansinių duomenų gyvavimas priklauso nuo `orders.session_id` ir `ON DELETE CASCADE`; konkretų poveikį riboja ir kiti FK / CHECK, todėl incidentas nepatvirtintas.
4. Domeno būsena ir outbox darbai ne visur įrašomi viena transakcija. Crash tarp jų gali palikti neįvykdytą papildomą veiksmą.
5. Išsaugotas webhook payload neturi rasto savarankiško failed / užstrigusių inbox įvykių atkūrimo worker. Entity watermark lease trūksta konkretaus vykdytojo tokeno apsaugos.
6. Analytics outbox užbaigimas netikrina claim token; jo vykdymas priklauso nuo webhook kelio. Fulfillment turi stipresnį modelį, kurį galima naudoti kaip atskaitos tašką.
7. Kainos ir produktų taisyklės kartojasi TypeScript kataloguose ir SQL. Kainų versija turi būti fiksuota pradėtame bandyme.
8. Neįjungtas locale gali gauti `en` fallback ir pakeisti naujo checkout valiutos / kainos kontekstą.
9. Šaltinio `solidgate_invoice_orders` generuotuose tipuose trūksta migracijoje ir webhook naudojamų `product_price_id` bei `order_metadata`.
10. Pajamų suvestinės parsisiunčia eilutes ir sumuoja aplikacijoje be puslapiavimo; galima nepilna suma viršijus Data API grąžinamų eilučių ribą.

Detalesni radiniai apima intro pakartojimus ir galimas papildomas prenumeratas be automatinės kompensacijos, tokenų kilmę, payload saugojimą, outbox retry ir monitoringą. Visi įrodymai ir išlygos pateikti pagrindiniame audite bei lentelių žodynuose.

## Šio boilerplate pradinė būklė

Perkėlimo pradžioje Git darbo katalogas buvo švarus; HEAD užfiksuotas manifeste. Projekto instrukcijos jau aprašo bendrinį produktą, tuščią `catalog-ids.json` ir vieną `00001_baseline.sql` schemą. Šie sprendimai skiriasi nuo audituoto šaltinio.

Trumpa vietinių failų patikra per perkėlimą nustatė šiuos konkrečius skirtumus:

- [Baseline schema](../../supabase/migrations/00001_baseline.sql:1) turi 24 visų sričių lentelių definicijas; joje nėra šaltinio trijų Stripe palikimo lentelių `payment_intent_sessions`, `stripe_customers`, `stripe_webhook_events`. Tai atskiras inventorius nuo 22 šaltinyje audituotų mokėjimų ir gretimų lentelių.
- [Price map](../../packages/shared/src/price-map.ts:63) naudoja bendrinį `BRAND` kodą ir `PRICE_BATCH = '000000'`; locale kainų tinklelis generuojamas iš produkto specifikacijų ir demonstracinių valiutų koeficientų. Tai nėra šaltinio realios kainos.
- [Solidgate katalogo sumos](../../packages/shared/src/solidgate/catalog.ts:7) vis dar įrašytos atskirais literalais. Parity testai tikrina sutapimą, bet sumos negaunamos tiesiogiai iš `PRICE_MAP`. Kainų dubliavimo nelaikyti jau išspręstu.
- [Boilerplate `special_free`](../../packages/shared/src/solidgate/catalog.ts:370) turi `auth_0_amount` ir 7 dienų trial; pradinė kaina nulinė. Šaltinio audite aprašytas mokamas €1 pasiūlymas čia negalioja.
- `catalog-ids.json` turi 8 pasiūlymų struktūrą su 88 tuščiomis ID reikšmėmis; „tuščias“ čia reiškia neužpildytus ID, ne pažodinį `{}`. [Testas](../../packages/shared/src/__tests__/solidgate-catalog.test.ts:190) reikalauja, kad boilerplate liktų be realių ID.
- Checkout vis dar importuoja vietinį [catalog ID JSON](../../apps/funnel/src/app/api/solidgate/create-session/route.ts:20), o webhook kodų susiejimas laikomas [_codes.ts](../../supabase/functions/solidgate-webhooks/_codes.ts:23). Nėra pagrindo teigti, kad visas produktų mapping jau perkeltas į aplinkos kintamuosius.

Tai orientacinis perkėlimo kontekstas. Prieš įgyvendinimą reikia atskiro šio projekto kodo ir schemos palyginimo. Senų migracijų ar šaltinio produkto kainų perkelti automatiškai nereikia.

## Nuo ko tęsti darbus

1. Perskaityti [architektūrą](boilerplate-architecture-audit.lt.md) ir [kainodaros paaiškinimą](price-map-and-catalog.lt.md), atsakyti į vartotojo klausimus apie esamą modelį.
2. Palyginti audito radinius su šio boilerplate kodu ir kiekvienam pažymėti `aktualu`, `jau išspręsta`, `neaktualu` arba `reikia patikros`, pridėjus konkretaus šio repo failo įrodymą.
3. Sutarti privalomas funkcijas: pagrindinė prenumerata, vienkartiniai pirkimai, anoniminis funnel, one-click, kortelės keitimas, intro ribojimas. Pagal jas priimti lentelių ir modulio ribų sprendimą.
4. Apibrėžti vieną pasiūlymų / kainų konfigūraciją ir atskirą Solidgate v1 susiejimą pagal aplinką bei kanalą. Išlaikyti pradėto mokėjimo snapshot ir DB pinigų validaciją.
5. Įgyvendinti patvirtintus pakeitimus bei tikrinti realias rizikas: autentifikacijos ribą, dublius, lygiagretumą, crash / retry, vėluojančius įvykius, refund / dispute ir prieigos būseną.
6. Užbaigti komandai ir agentui skirtą setup dokumentaciją: produkto konfigūracija → švari DB → sandbox konfigūracija → providerio produktų planas / sukūrimas → viso kontrakto read-back → webhook / worker → scenarijų patikra → produkcijos paleidimas.

Perkėlimas pats nėra leidimas automatiškai paleisti išorinius seed, mokėjimus ar produkcijos pakeitimus. Galutinis DDL ir setup komandos turi remtis šiame projekte patvirtintu v1 sprendimu.

## Dokumentų ir skaityklės priežiūra

Pradžios nuorodos pateiktos [README](README.md). Markdown lieka redaguojamas šaltinis; HTML atnaujinamas su `python3 output/solidgate-reader/build_full_reader.py` iš šio projekto šaknies.

Pirminiai keturi audito failai saugo šaltinio analizės būseną. Tolesnį šio boilerplate įgyvendinimo progresą dokumentuoti atskirai, kad pasiūlymai nebūtų supainioti su įgyvendintais sprendimais.

# 03. DB ir webhook

Interaktyvus žingsnis ir kopijuojamas agento promptas: **`/documentation/setup/database-webhooks`**.

Paruošiame serverio apskaitą prieš checkout: kiekvienas mokėjimas, trial, renewal, refund ir prieigos pakeitimas turi atsekamą istoriją DB.

Šis puslapis aprašo būsimo agento darbą tiksliniame appso repo. Dokumentacijos UI generuoja instrukcijas; jis nevykdo providerio API, migracijų ar deploy. Įvesti laukai nepatvirtina failų egzistavimo ar integracijos parengties.

## Reikalinga įvestis

- 01-provider-manifest.json, 02-commerce-contract.json ir 02-catalog-report.md.
- Paruošti katalogo TS / SQL pakeitimai ir izoliuota vietinė DB patikrai.
- Serverio webhook / worker konfigūracijos pavadinimai ir pasirinktos aplinkos ryšiai, be paslapčių dokumentuose.

## Žingsnio rezultatas

- docs/payments/setup/03-backend-report.md — migracijų, webhook, finansinių įvykių, teisių ir testų ataskaita.
- Vietinėje DB patikrintos migracijos, idempotentiškas webhook / worker kelias ir aiškios serverio būsenos.
- Atribucijos snapshot saugojimo schema / adapteriai ir seną bei naują metadata formatą suprantantys skaitytojai; checkout rašymas jungiamas 04.

## Order ir finansiniai judėjimai nėra tas pats

Order aprašo konkretų pirkimą ar invoice bandymą; nekintamų finansinių įvykių istorija aprašo realius capture, refund ir dispute judėjimus. Auth ir jo Settle nėra dvi pajamos. Failed / processing būsena nėra nurašytų pinigų įrodymas. Capture ir refund saugomi su suma, valiuta, providerio tapatybe bei įvykio laiku. Skirtingų valiutų bendros sumos nejungiamos be aiškiai dokumentuoto konvertavimo šaltinio. Grynieji capture minus refund nėra providerio payout ar pelnas: mokesčiams ir atsiskaitymams reikia jų pačių duomenų.

## Pristatymas gali kartotis ir vėluoti

Webhook parašas patikrinamas pagal tikslinį kanalą ir aplinką, įvykis patikimai išsaugomas, o apdorojimas vyksta atominėmis būsenų operacijomis. Tas pats event gali būti pristatytas kelis kartus; skirtingi event taip pat gali reikšti tą patį finansinį judėjimą, todėl vien event ID deduplikacijos neužtenka. Vėlesnis capture negali būti panaikintas pavėluoto processing įvykio. Worker retry, klaidos ir atsilikimas turi būti matomi DB ir ataskaitose.

## Trial ir renewal sekami kiekvienai prenumeratai

Saugome atskiras main ir OTO2 prenumeratas, pradinį mokėjimą, trial pradžią / pabaigą, apmokėto periodo ribas, kitą planuojamą nurašymą kai provideris jį pateikia, cancellation ir realią būsenų istoriją. Kiekvienas renewal / invoice siejamas su jo subscription_id; sumos imamos iš tikro įvykio, ne iš dabartinės katalogo kainos. Nemokamas trial nėra piniginės pajamos. Vėliau nepavykus priimtam OTO mokėjimui, laukiančios būsenos ir galimi laikini entitlement turi būti sutvarkyti pagal kontraktą.

## Atšaukimas nepanaikina visų kliento prenumeratų

Atšaukiant main nekeičiamas OTO2, o atšaukiant OTO2 nekeičiamas main. OTO1 lifetime šaka vykdo after_purchase=cancel_main_after_capture tik kai 02 kontrakte tai aiškiai įjungta, yra patvirtintas capture ir teisingam savininkui jau patikimai išsaugotas lifetime entitlement. Vien capture neužtenka: nepavykus grant, cancellation užduotis dar nekuriama. Vėlesnis main cancellation webhook lifetime prieigos nepanaikina. Išorinis atšaukimo veiksmas turi saugų pakartojimą ir reconciliation būseną, kad nutraukus ryšį nebūtų nei dvigubo veiksmo, nei amžinai pamiršto atšaukimo.

## Atribucijai paruošiame abi skaitymo kryptis

03 paruošia pilno first-touch / last-touch snapshot saugojimą ir kanoninius plokščius utm_* laukus vidinėje DB. Skaitytojai supranta senus plokščius providerio UTM, naują utm JSON tekstą ir attribution_id nuorodą į jau išsaugotą snapshot. Checkout pradės rašyti šį formatą 04 žingsnyje. Renewal paveldi pradinio pirkimo atribucijos ryšį, o naujas apsilankymas neperrašo istorinio acquisition. Blogai suformuota marketing metadata neturi nutraukti patvirtinto finansinio įvykio apskaitos.

## Paskyros nuosavybė ir patikros lygis

Checkout el. paštas pats savaime nėra teisė prisijungti prie egzistuojančios paskyros. Pirkimo claim turi remtis patikrintu pirkimo / sesijos nuosavybės įrodymu, o prisijungimas — patvirtintu autentifikacijos keliu. Finansines lenteles, RPC ir ataskaitų views apsaugome pagal tikrą serverio / vartotojo modelį, įskaitant RLS ir grants. Vietinis signed fixture testas patikrina handler logiką; realus Solidgate webhook pristatymas bus atskiras 05 patikros rezultatas.

## Užbaigimo patikros

- Pakartotas ar ne eilės tvarka gautas įvykis nedubliuoja order, finansinio judėjimo, prieigos ar išorinio šalutinio veiksmo.
- Auth 5 EUR + Settle 5 EUR apskaitoje reiškia vieną 5 EUR capture; nepavykęs mokėjimas nėra pajamos.
- Main ir OTO2 trial, renewal, cancellation bei entitlement atskiriami pagal konkrečią prenumeratą.
- Per vartotojo el. paštą nesukuriama patvirtinta sesija esamai paskyrai be nuosavybės įrodymo.
- DB leidžia atsekti sumą, valiutą, įvykio laiką, providerio įrodymą, kainos versiją ir atribuciją.

## Agento promptas

Programėlės forma prideda bendras vykdymo taisykles ir įvestą projekto kontekstą. Kopijuojant vien šį dokumentą, agentui taip pat perduodamas target repo, app_key, aplinka, kanalas, konkreti catalog_version, provider_manifest_path ir main + OTO pasiūlymų planas. Paslapčių prie prompto nepridėkite. Kontekste nurodytas manifesto kelias pakeičia numatytą kelią visose instrukcijose; kitas kopijas kurti nereikia.

```text
Įgyvendink mokėjimų diegimo 03 žingsnį: DB, webhook ir worker pasirengimą.

Perskaityk kontekste nurodytą providerManifestPath / provider_manifest_path (numatytasis docs/payments/setup/01-provider-manifest.json), docs/payments/setup/02-commerce-contract.json ir docs/payments/setup/02-catalog-report.md. Patikrink, kad aplinka, kanalas ir katalogo versija sutampa su pateiktu kontekstu. Neužbaigto 02 katalogo nelaikyk paruoštu mokėjimams; nepriklausomą vietinį backend darbą tęsk.

1. Surask tikrą migracijų, order, subscription, entitlement, webhook inbox, worker ir finansinių įvykių kelią. Šiame repo pradėk nuo supabase/migrations, supabase/functions/solidgate-webhooks, apps/funnel/src/app/api/solidgate/grant ir jų testų. Remkis esamomis apsaugomis; nekurk naujos lygiagrečios apskaitos be aiškios migracijos.
2. Užbaik 02 paruoštus schema / RPC / katalogo patikrų pakeitimus ir išbandyk juos izoliuotoje vietinėje DB. Patikrink švarų įdiegimą ir atnaujinimą su sintetiniais istoriniais order. Neperrašyk jau pritaikytų migracijų ir netrink istorinių katalogo ID. Nuotolinės migracijos leidimo nelaikyk numanomu.
3. Įdiek arba patikrink webhook parašo tikrinimą, kanalo / aplinkos atskyrimą, patikimą inbox išsaugojimą ir atominį worker claim. Atsakymas provideriui neturi pamesti įvykio tarp gavimo ir saugojimo. Dokumentuok retry, klaidų, sustojusių claim ir neapdorotų event stebėjimą bei saugų pakartojimą.
4. Deduplikuok tiek pristatytą event, tiek jo verslo / finansinį poveikį. Skirtingi event gali reikšti tą patį capture. Pakartojus ar pakeitus įvykių tvarką negali daugėti order, capture, refund, entitlement ar cancellation šalutinių veiksmų. Senesnis processing / auth neturi sumažinti jau patvirtinto capture būsenos.
5. Saugok realius piniginius judėjimus pagal providerio patvirtintus ID, sumą, valiutą ir occurred_at; received_at laikyk atskirai. Auth nėra capture: Auth 500 EUR minor ir Settle 500 EUR minor reiškia vieną 500 minor capture. Initial, renewal ir OTO pažymėk atskirai. Nemokamas trial, failed, created ir processing nėra piniginės pajamos.
6. Dalinius ir pilnus refund, dispute pradžią, grąžintą dispute sumą / reversal registruok pagal realią semantiką, neleisdamas vienos grąžintos sumos atimti du kartus. Finansinių įvykių neištrink keičiant order statusą. Ataskaitose sumuok pagal valiutą; capture minus refund nevadink payout ar pelnu. Jei providerio duomenų istorijoje trūksta, žymėk nežinoma / reconciliation, ne išgalvotą sumą.
7. Main ir OTO2 subscription saugok atskirai pagal jų tikrus subscription_id. Fiksuok trial tipą, faktines pradžios / pabaigos datas, mokamo periodo ribas, invoice ir renewal bandymus, numatomą kitą mokėjimą kai pateikta, būsenų istoriją bei cancellation. 30 dienų nelaikyk kalendoriniu mėnesiu. Faktinio invoice kaina ir valiuta turi pirmenybę prieš dabartinį katalogą; užfiksuotą istorinio pasiūlymo mapping išsaugok.
8. Patikrink failed renewal, sėkmingą retry, vėluojantį invoice ir accepted OTO po kurio ateina failure. Prieigos suteikimo / panaikinimo taisyklė remiasi 02 kontraktu ir providerio įrodymais. accepted nėra paid. Vienos prenumeratos būsena neturi panaikinti kitos prenumeratos ar nepriklausomo one_time entitlement.
9. OTO1 lifetime cancellation užduotį kurk tik kai kontrakte after_purchase=cancel_main_after_capture, yra patvirtintas capture ir teisingam savininkui patikimai išsaugotas lifetime entitlement. Jei grant DB operacija nepavyksta, main nenutraukiama ir cancellation užduotis nesukuriama. Tikslas — konkreti main prenumerata, ne visos vartotojo prenumeratos. Išorinį veiksmą atlik per esamą saugiai kartojamą mechanizmą, su po klaidos tęsiama būsena. Main cancellation webhook turi išlaikyti jau suteiktą lifetime prieigą. default grant_only atveju neturi likti paslėpto lifetime cancel kodo kelio.
10. Paruošk pilno first-touch / last-touch snapshot saugojimą ir serverio adapterį su stabiliu attribution_id. Viduje išlaikyk kanoninius plokščius utm_* laukus. Reader turi suprasti seną plokščią metadata, naują serializuotą utm JSON tekstą ir attribution_id į jau įrašytą snapshot. Aprašyk aiškią konfliktų pirmenybę: užfiksuotas kanoninis pirkimo snapshot yra pirminis, o sena metadata — suderinamumo fallback. Bloga UTM JSON reikšmė neturi numesti finansinio event. 04 prijungs checkout rašymą; čia jo buvimo dar neteik kaip fakto.
11. Retry ir renewal turi paveldėti pradinės prenumeratos atribuciją bei locale. Atskirk first-success acquisition įvykį nuo kiekvieno finansinio mokėjimo, kad renewal nepadidintų naujų klientų skaičiaus. Patikrink grant, webhook, renewal ir analitikos adapterius, ne tik vieną skaitytoją.
12. Peržiūrėk serverio paslapčių ribas, RLS, grants ir privilegijuotus RPC / views. Nepasitikėk vartotojo įvedamais price, status, subscription_id ar nuosavybės laukais. Vien checkout email negali auto-confirm ar atidaryti egzistuojančios paskyros. Neautorizuotą claim, svetimą order / session / subscription ir pakartotinį claim tikrink neigiamais testais.
13. Vietiniais testais patikrink atominį vienalaikį apdorojimą, dublikatus, įvykių eiliškumą, capture / refund sumas, abiejų prenumeratų renewal / cancellation, lifetime grant DB klaidą be ankstyvo main cancellation, prieigos išlikimą po main cancellation webhook, nemokamą trial, atribucijos formatus ir paskyros nuosavybę. Ataskaitoje nurodyk pradinę bei galutinę DB būseną ir tikrą patikros rūšį. Nevadink sintetinės renewal žinutės realiu providerio planuoklio testu.
14. Parašyk docs/payments/setup/03-backend-report.md: pakeitimai, migracijų būsena pagal aplinką, testai, finansinių ir trial / renewal užklausų pavyzdžiai, retry / reconciliation kelias, neišspręstos spragos ir 04 žingsniui paruošti adapteriai. Jei pasirinktame sandbox webhook endpoint dar nepasiekiamas, pažymėk tai aiškiai; neužmaskuok vietiniu testu.

Bendros vykdymo taisyklės:
- Kontekstą ir pasiūlymų planą gauni kartu su šiuo promptu. Pradėk nuo tikro repo ir ankstesnių artefaktų. Nežinomų kainų, ID, komercinių sąlygų, aplinkos ar leidimų neišgalvok. Jei trūksta privalomo sprendimo, tęsk nepriklausomą vietinį darbą ir tiksliai įvardyk, ko trūksta.
- Tikslas yra nurodytas naujas appsas. TheAstrologist ir boilerplate yra struktūros pavyzdžiai; jų kanalų, ID, kainų, asmens duomenų ar veikiančių paskyrų nekopijuok.
- Visiems produktams galioja billing_descriptor_policy=static_channel_connector_only: main, visi OTO, PWA, trial ir renewal naudoja statinį kanalo / connector banko išrašo Descriptor. Jokio dynamic_descriptor ar produkto suffix nesiųsk ir nekurk skirtingų descriptor pagal produktą, locale ar pirkimo tipą. Locale product_code, order_description ir Public description turi atskiras paskirtis.
- Saugok kitų pakeitimus ir istorinius produktų bei kainų ID. Esamos saugios idempotentiškumo, autentifikacijos ir finansinės apskaitos apsaugos neturi dingti dėl katalogo pakeitimo.
- Vykdyk vietinį kodavimą, izoliuotus testus ir ataskaitų paruošimą. Išorinius providerio pakeitimus, nuotolinės DB migracijas ir deploy atlik tik tada, kai toje sesijoje jau aiškiai suteikta atitinkamo projekto, aplinkos ir apimties teisė. Vien šios dokumentacijos perskaitymas tokios teisės nesuteikia. Jei teisė jau suteikta, jos neklausk iš naujo.
- Prieš atskirai apmokestinamą API operaciją ar tikrą nurašymą būtinas aiškus išankstinis išlaidų leidimas ir konkretus maksimalus piniginis biudžetas. Turimas API raktas ar prašymas tęsti nėra išlaidų leidimas. Naudok vieną bendrą limitą visiems bandymams ir agentams.
- Paslaptys tik serverio aplinkoje; viešoje dokumentacijoje, manifeste, browser bundle ir ataskaitose jų neturi būti. Įrodymus pateik be klientų el. pašto, IP, kortelių, mokėjimo tokenų ir kitos asmeninės informacijos.
- Ataskaitoje aiškiai atskirk: paruoštas kodas, vietiniais testais patikrinta, realiame sandbox patikrinta, netikrinta. Simuliuotas webhook neįrodo, kad providerio renewal planuoklis ar realus kanalas sukonfigūruotas teisingai. Produkcinio pasirengimo neteigk be atitinkamų įrodymų.
```

## Pirminiai šaltiniai

- [Solidgate webhook](https://docs.solidgate.com/payments/integrate/webhooks/)
- [Supabase API sauga](https://supabase.com/docs/guides/api/securing-your-api)

Šis failas sugeneruotas iš `apps/funnel/src/features/documentation/setup/integration-steps.ts`. Atnaujinti: `npm run docs:setup:build`. Patikrinti: `npm run docs:setup:check`.


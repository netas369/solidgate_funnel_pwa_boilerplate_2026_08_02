# 05. Pilna sandbox patikra

Interaktyvus žingsnis ir kopijuojamas agento promptas: **`/documentation/setup/sandbox-verification`**.

Patikriname visą pirkimo istoriją nuo UI iki vidinės DB ir atskiriame simuliuotus testus nuo realaus providerio sandbox įrodymų.

Šis puslapis aprašo būsimo agento darbą tiksliniame appso repo. Dokumentacijos UI generuoja instrukcijas; jis nevykdo providerio API, migracijų ar deploy. Įvesti laukai nepatvirtina failų egzistavimo ar integracijos parengties.

## Reikalinga įvestis

- 01-provider-manifest.json, 02-commerce-contract.json ir visos 02–04 ataskaitos.
- Veikiantis vietinis appsas, izoliuota DB ir patikrinta backend / checkout versija.
- Realiems sandbox bandymams: aiškiai pasirinktas sandbox kanalas, jo serverio raktai, pasiekiamas webhook kelias ir leistina testų apimtis.
- Bet kokiam atskirai apmokestinamam veiksmui ar tikram nurašymui — išankstinis išlaidų leidimas ir maksimalus piniginis biudžetas.

## Žingsnio rezultatas

- docs/payments/setup/05-verification-report.md — scenarijų matrica, įrodymai, pataisytos klaidos ir likę blokavimai.
- Atsekamas main + OTO2 + one_time pirkimų, renewal, refund, cancellation ir atribucijos patikrų rezultatas.
- Atskiras sprendimas pagal aplinką: vietinė logika patikrinta / sandbox įrodyta / trūksta įrodymų. Production iš šio žingsnio savaime netampa patikrinta.

## Pirma vietinė patikra, tada realus sandbox

Agentas pirmiausia paleidžia tinkamus typecheck, lint, build, katalogo, DB ir integracijos testus. Realius sandbox veiksmus pradeda tik su aiškiai parinkta aplinka, kanalu, tik testui skirtais mokėjimo duomenimis ir pasiekiamu webhook keliu. Jei šių sąlygų nėra, užbaigia vietines patikras ir ataskaitoje nurodo konkrečius trūkstamus įrodymus. Tikrų kortelių ar mokamų operacijų nenaudoja be atskiro leidimo ir biudžeto.

## Main ir kiekvienas OTO kelias

Matrica apima pasirinktus main trial variantus, OTO2 subscription, likusių one_time OTO priėmimą / praleidimą, 3DS, decline, timeout, refresh ir du vienalaikius tabus. Locale tikrinama po routing, taip pat pakeitus IP ar siunčiant neleistiną locale. Bent vienas sėkmingas main mokėjimas neįrodo visų kainų / metodų palaikymo; netestuotus derinius įvardijame. Nereikia realiai nurašyti visų derinių, kad vietiniais testais patikrintume jų mapping.

## Renewal planuoklis ir webhook handler — atskiri įrodymai

Main bei OTO2 tikrinami paid / free trial, pirmas renewal, failed renewal ir vėlesnis sėkmingas bandymas, periodų datos ir konkretus subscription_id. Kontroliuojamai pakartotas fixture įrodo handler ir DB elgesį. Tikras providerio sandbox invoice / renewal įvykis įrodo tą bandytą providerio kelią. Jei įvykio dar laukiama arba paskyra nepalaiko pagreitinimo, įrašome laukimo / neatliktos patikros būseną; sistemos laiko pakeitimas nėra providerio billing testo pakaitalas.

## Finansai sutikrinami nuo pradžios iki DB

Kiekvieno bandymo kainą lyginame tarp UI, serverio kontrakto, providerio mokėjimo ir DB. Auth + Settle turi vieną capture, refund — savo judėjimą, o event pakartojimas rezultato nekeičia. Tikriname dalinį / pilną refund ir dispute / reversal tiek, kiek scenarijų leidžia pasirinktas sandbox; likusius pažymime sintetiniais ar netikrintais. Pajamos, refund ir valiutos turi atsekamą šaltinį; informacijos spragų nepaslepiame bendru žaliu statusu.

## Atribucija, saugumas ir galutinis perdavimas

Iš vidinės DB turi būti įmanoma atsekti sesiją, order, prenumeratą, kainos versiją, pirkimo locale, sumą, trial / renewal laiką ir pilną leidžiamą atribuciją. Patikriname trumpą UTM JSON, ilgo snapshot nuorodą, seną metadata ir nebuvusį UTM; nieko neišgalvojame. Svetimas order, token, 3DS return ar checkout email nesuteikia paskyros ir prieigos. Ataskaita pateikia įrodymų nuorodas be paslapčių ir asmens duomenų, pataisytas klaidas bei konkrečias likusias užduotis.

## Užbaigimo patikros

- Prie kiekvieno scenarijaus nurodyta aplinka, įrodymo tipas, laukta ir faktinė būsena bei sumos.
- Dublikatai, dvigubi paspaudimai ir pakartoti webhook nesukuria papildomų nurašymų ar finansinių judėjimų.
- Patikrinti abiejų prenumeratų atskiri renewal / cancellation ir OTO1 grant_only / aiškiai įjungtos lifetime taisyklės.
- UI → serverio katalogas → providerio request / response → DB financial events rodo tas pačias sumas ir valiutą.
- Visų main / OTO / PWA mokėjimų request neturi dynamic_descriptor; kanalo statinio descriptor ir renewal išrašo patikra turi savo įrodymą arba aiškią netikrinta būseną.
- Netestuotas tikras renewal, nepasiekiamas webhook ar nesukonfigūruotas mokėjimo metodas aiškiai pažymėti kaip spragos.

## Agento promptas

Programėlės forma prideda bendras vykdymo taisykles ir įvestą projekto kontekstą. Kopijuojant vien šį dokumentą, agentui taip pat perduodamas target repo, app_key, aplinka, kanalas, konkreti catalog_version, provider_manifest_path ir main + OTO pasiūlymų planas. Paslapčių prie prompto nepridėkite. Kontekste nurodytas manifesto kelias pakeičia numatytą kelią visose instrukcijose; kitas kopijas kurti nereikia.

```text
Atlik mokėjimų diegimo 05 žingsnį: pilną vietinę ir, kai sąlygos leidžia, realaus sandbox patikrą.

Perskaityk kontekste nurodytą providerManifestPath / provider_manifest_path (numatytasis docs/payments/setup/01-provider-manifest.json), docs/payments/setup/02-commerce-contract.json, docs/payments/setup/02-catalog-report.md, docs/payments/setup/03-backend-report.md ir docs/payments/setup/04-checkout-report.md. Patikrink jų bendrą app, environment, kanalą, katalogo versiją ir aktualumą dabartiniam kodui. Kiekvieno bandymo aplinką įvardyk atskirai.

1. Sudaryk scenarijų matricą prieš bandymus. Kiekviena eilutė turi scenarijų, prielaidas, laukiamą UI / providerio / DB rezultatą, įrodymo tipą, faktinį rezultatą ir likusį veiksmą. Tipai: vietinis vienetinis / integracinis, sintetinė izoliuota DB, realus Solidgate sandbox, netikrinta. Vieno tipo sėkmės neperkelk kitam tipui. Visų main, OTO ir PWA formų bei saved-token request patikrink dynamic_descriptor ir produkto suffix nebuvimą. Statinio kanalo / connector nustatymo, įskaitant renewal, faktinį išrašą tikrink tik turint atitinkamos aplinkos įrodymą. Ankstesnės versijos jau pradėto checkout išsaugotas merchant_data gali turėti seną suffix iki užbaigimo / galiojimo pabaigos: nekeisk jo ar order tapatybės aklai; tokį atvejį ataskaitoje atskirk nuo naujo intento.
2. Paleisk repo tinkamus typecheck, lint, build ir prasmingus mokėjimų / katalogo / DB testus. Patikrink migracijų pritaikymą švariai bei su sintetiniais istoriniais order. Pataisyk rastas klaidas vietiniame kode ir kartok tik paveiktas patikras. Nereikia mokamos išorinės AI, benchmark ar production užklausų.
3. Prieš realų sandbox patikrink pasirinktą testinį kanalą, testinių raktų serverio vietą, callback / return URL, webhook endpoint pasiekiamumą ir worker veikimą. Naudok tik oficialiai leistinus testinius mokėjimo duomenis. Jei tai atskirai apmokestinama ar sukelia tikrą nurašymą, prieš veiksmą turi būti aiškus biudžetas. Jei būtinų sąlygų nėra, tęsk vietines patikras ir tiksliai užfiksuok realaus sandbox blokavimą.
4. Main patikrink pasirinktus paid trial, free trial ir be trial variantus tiek, kiek jie įjungti kontrakte: pradinę sumą, valiutą, trial trukmę, billing periodą, lokalizuotą kodą, serverio ID ir entitlement. Kelių valiutų / metodų kombinacijas parodyk matricoje; nebandyti deriniai turi likti nebandyti, o ne numanomi sėkmingi.
5. Patikrink OTO2 kaip vienintelį subscription OTO ir kiekvieną įjungtą one_time OTO: accept, skip, refresh, grįžimą atgal, du tabus ir accept / skip lenktynes. Main ir OTO2 turi gauti atskirus subscription_id. One_time sumos mokėjimas neturi sukurti paslėptos prenumeratos ar fiktyvių providerio produkto ID.
6. Patikrink sėkmingą mokėjimą, decline, 3DS sėkmę / atmetimą / nutraukimą, neaiškų timeout ir pakartotinį paspaudimą. Tas pats neaiškus bandymas turi būti sutikrinamas tuo pačiu order. Pasenęs ar svetimas 3DS grįžimas neturi užbaigti kito pirkimo; teisėtas pakartotinis patvirtinimas turi grąžinti arba sutikrinti tą patį order be papildomo nurašymo. accepted / processing po kurių ateina failure negali likti rodomi kaip apmokėti.
7. Pakartok tą patį webhook, lygiagrečiai apdorok jo dublikatą ir pakeisk auth / processing / capture įvykių tvarką. Patikrink tiek event deduplikaciją, tiek finansinio judėjimo tapatybę tarp skirtingų event. Po retry order, capture, refund, entitlement ir cancellation šalutinių veiksmų skaičius neturi didėti neteisingai.
8. Atskirai patikrink main ir OTO2 pirmą renewal, failed renewal, vėlesnį sėkmingą retry, trial ir mokamo periodo datas bei invoice ryšį. Sumos turi remtis faktiniu invoice ir istorine kainos versija. Simuliuotą invoice aiškiai žymėk sintetiniu. Jei tikro providerio renewal dar nėra arba jo negalima pagreitinti, palik realų planuoklio patikrinimą nebaigtą; neskelbk jo sėkmingu vien iš handler testo.
9. Patikrink main cancellation nepakeičiant OTO2 ir OTO2 cancellation nepakeičiant main. OTO1 default after_purchase=grant_only atveju main lieka savo būsenoje. Jei kontrakte aiškiai pasirinkta after_purchase=cancel_main_after_capture, tik patvirtintas OTO1 capture ir patikimai išsaugotas lifetime entitlement teisingam savininkui leidžia pradėti saugiai kartojamą konkrečios main prenumeratos nutraukimą. Sintetiniu grant DB klaidos testu įrodyk, kad capture be sėkmingo grant dar nepaleidžia cancellation. Patikrink, kad vėlesnis main cancellation webhook nepanaikina lifetime prieigos. Nepavykęs OTO1 neturi nutraukti main.
10. Finansams sutikrink UI → serverio kontraktas → providerio rezultatas → DB financial events. Auth 5 EUR + Settle 5 EUR turi vieną 5 EUR capture. Patikrink dalinį / pilną refund, dispute ir reversal pagal galimus sandbox scenarijus; jų sintetinį pakaitalą pažymėk. Išskaidyk sumas pagal valiutą, initial / renewal / OTO ir įvykio laiką. Capture minus refund nevadink payout ar pelnu.
11. Patikrink TWD integer minor units bei JPY / KRW zero-decimal mapping, jei šios valiutos įjungtos, taip pat PayPal apribojimus kai metodas įjungtas. Nežinoma locale, nepatvirtintas price ID, pakeista browser suma ar billing_type turi būti atmesti prieš providerio veiksmą. Naujas katalogas negali perrašyti jau pradėto order ar seno renewal kainos versijos.
12. Atribucijai patikrink first-touch / last-touch išsaugojimą DB, trumpą utm JSON, daugiau nei 380 simbolių UTM → jau išsaugoto snapshot attribution_id, seną plokščią metadata, nebuvusius UTM ir blogą JSON. Visa leistina atribucija turi likti atsekama viduje; ilgis neturi sukelti providerio metadata viršijimo. Renewal išlaiko pirminį ryšį; naujas apsilankymas neperrašo seno acquisition. Vieno kliento renewal neskaičiuok nauja acquisition konversija.
13. Patikrink paskyros ir mokėjimo nuosavybę: svetimas order, session, token, subscription_id ar 3DS grįžimas neturi suteikti prieigos. Vien esamo vartotojo email checkout lauke neturi patvirtinti jo paskyros ar atidaryti jos sesijos. Browser bundle ir viešose ataskaitose negali būti serverio raktų.
14. Parašyk docs/payments/setup/05-verification-report.md su bandyta kodo / katalogo versija, matrica, redaguotais įrodymais, rasta → pataisyta → pakartotinai patikrinta klaidų lentele, likusiomis spragomis ir sprendimu kiekvienai aplinkai. Įtrauk praktiškas DB užklausas arba ataskaitų pavyzdžius: kas mokėjo, kiek ir kokia valiuta, kuris trial / renewal įvyko, kuri prenumerata pasikeitė ir kur rasti jos atribuciją. Naudok tik sintetinius ar nuasmenintus duomenis.
15. Nevykdyk production deploy ir neskelbk production patikrinta. Šio etapo rezultatas yra įrodymais pagrįsta patikros ataskaita ir vietiniai pataisymai; trūkstant realaus sandbox įrodymų, juos aiškiai palik užduočių sąraše.

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

- [Solidgate testiniai kortelių mokėjimai](https://docs.solidgate.com/payments/testing/card-payments/)

Šis failas sugeneruotas iš `apps/funnel/src/features/documentation/setup/integration-steps.ts`. Atnaujinti: `npm run docs:setup:build`. Patikrinti: `npm run docs:setup:check`.


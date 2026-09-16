# 04. Checkout ir OTO

Interaktyvus žingsnis ir kopijuojamas agento promptas: **`/documentation/setup/checkout-oto`**.

Prijungiame main mokėjimą, vieną prenumeratos OTO ir vienkartinius OTO prie jau paruošto katalogo bei backend.

Šis puslapis aprašo būsimo agento darbą tiksliniame appso repo. Dokumentacijos UI generuoja instrukcijas; jis nevykdo providerio API, migracijų ar deploy. Įvesti laukai nepatvirtina failų egzistavimo ar integracijos parengties.

## Reikalinga įvestis

- 01-provider-manifest.json, 02-commerce-contract.json, 02-catalog-report.md ir 03-backend-report.md.
- 03 paruošti DB / webhook ir atribucijos adapteriai, tikslinio appso routing ir checkout / OTO UI.
- Patvirtintos klientui rodomos trial, renewal, vienkartinės kainos bei pirkimo ir atšaukimo sąlygos.

## Žingsnio rezultatas

- docs/payments/setup/04-checkout-report.md — main / OTO / 3DS / UTM integracijos ir vietinių testų ataskaita.
- Sujungtas serverio checkout ir OTO kelias su locale, užfiksuota kaina, saugiais retry bei aiškiomis UI būsenomis.
- Pilnas serverio atribucijos snapshot ir suderintas providerio metadata rašymas, naudojantis 03 skaitytojais.

## Serveris priima sprendimą dėl pasiūlymo

Browser pateikia pasirinktą pasiūlymą ir svetainės kontekstą; serveris iš 02 kontrakto nustato leistiną billing_type, sumą, valiutą ir providerio ID. UI aiškiai parodo kiek mokama dabar, kiek ir kada bus renewal, ar mokėjimas vienkartinis. OTO2 turi savo atskiras prenumeratos sąlygas. Return URL ar kliento success callback savaime nesuteikia prieigos ir nepatvirtina nurašymo.

## OTO seka ir mokėjimo bandymas turi vieną savininką

Išsaugomas esamas atominis order / OTO pozicijos claim ir serverio sekos tikrinimas. Priimti ir praleisti tą patį OTO vienu metu negalima. Timeout arba nežinomas providerio atsakymas sprendžiamas tikrinant to paties order būseną, o ne automatiškai sukuriant kitą mokėjimą. Aiškus galutinis atsisakymas ir neaiškus rezultatas turi skirtingus retry kelius. Sesijos atnaujinimas, du tabai ir grįžimas po 3DS turi tęsti esamą veiksmą.

## Išsaugotas mokėjimo būdas negarantuoja nurašymo

One-click main / OTO ryšį patikrina serveris: išsaugotas mokėjimo tokenas priklauso tam pačiam klientui ir leistinai kilmės sesijai. Jis nepatenka į viešą browser konfigūraciją. Provideris gali pareikalauti 3DS; challenge susiejamas su konkrečiu order ir bandymu, o pasenęs ar svetimas grįžimas atmetamas, o teisėtas to paties patvirtinimo pakartojimas grąžina arba sutikrina esamo order būseną. accepted arba processing rodo priimtą apdoroti užklausą, o apmokėjimą ir prieigą nustato patvirtinta serverio būsena.

## Šeši baziniai laukai ir vienas UTM tekstas

Subscription transakcijos metadata turi funnel_code, funnel_variant, price_id, product_code, product_slug ir session_id. Pridedame vieną utm su JSON tekstu — iš viso 7 laukai. Vienkartinis sumos mokėjimas neturi išgalvoto price_id; neprieinamą lauką praleidžiame. Visų laukų ir jų ilgio ribas tikriname pagal endpointą: Payment Form v1 leidžia 10 porų ir 380 simbolių reikšmę. Senas 5 bazinių laukų + 5 UTM kelias pakeičiamas tik kartu su visais 03 paruoštais skaitytojais.

## Ilgi UTM lieka pilni vidinėje DB

Checkout serveryje pirmiausia išsaugo pilną first-touch / last-touch snapshot ir kanoninius plokščius UTM, susietus su sesija, order ir vėlesne prenumerata. Jei serializuotas utm viršija 380 simbolių, į providerio metadata vietoje jo įrašo trumpą attribution_id į sėkmingai išsaugotą snapshot. JSON nekertame ir rinkodaros duomenų ilgiu mokėjimo neblokuojame. Jei pats būtinas DB saugojimas nepavyksta, grąžiname saugų pakartojamą saugojimo klaidos rezultatą, o ne siunčiame neveikiančią nuorodą ar prarandame auditą.

## Atskiri providerio laukai išlieka atskiri

order_description gauna pilną užfiksuotą pirkimo kodą. website ir traffic_source yra atskiri API laukai; traffic_source nėra visas UTM objektas. Name, produkto vidinis Description, Public description ir banko Descriptor turi skirtingas paskirtis. SDK merchant_data yra merchant, signature ir paymentIntent wrapperis, ne vieta savavališkai metadata. Visiems produktams taikomas tik statinis kanalo / connector Descriptor; jokio dynamic_descriptor ar produkto suffix nesiunčiame. Faktinius endpointų laukus ir mokėjimo metodus agentas patikrina pagal naudojamą SDK bei API kontraktą.

## Užbaigimo patikros

- Dvigubas paspaudimas, du tabai ar timeout nesukuria antro nepatvirtinto bandymo ir nenurašo du kartus.
- OTO priėmimas, praleidimas ir grįžimas saugomi atomiškai; naršyklė negali pakeisti kainos ar billing_type.
- 3DS challenge ir jo grįžimas susieti su konkrečiu order, sesija ir bandymu; accepted / processing nerodomi kaip paid.
- Providerio metadata neviršija 10 laukų ir 380 simbolių lauke; pilni UTM išlieka DB.
- Main, OTO2 ir one_time užklausos naudoja savo endpointų laukus; kliento prieiga remiasi backend įrodymais.

## Agento promptas

Programėlės forma prideda bendras vykdymo taisykles ir įvestą projekto kontekstą. Kopijuojant vien šį dokumentą, agentui taip pat perduodamas target repo, app_key, aplinka, kanalas, konkreti catalog_version, provider_manifest_path ir main + OTO pasiūlymų planas. Paslapčių prie prompto nepridėkite. Kontekste nurodytas manifesto kelias pakeičia numatytą kelią visose instrukcijose; kitas kopijas kurti nereikia.

```text
Įgyvendink mokėjimų diegimo 04 žingsnį: main checkout, OTO ir pilną atribucijos rašymą.

Perskaityk kontekste nurodytą providerManifestPath / provider_manifest_path (numatytasis docs/payments/setup/01-provider-manifest.json), docs/payments/setup/02-commerce-contract.json, docs/payments/setup/02-catalog-report.md ir docs/payments/setup/03-backend-report.md. Naudok jų patvirtintas sąlygas. Jei 03 backend ar pasirinktos aplinkos migracijos dar neparuoštos, nepradėk realių mokėjimų; vietinę integraciją ir testus tęsk su aiškia ataskaitos būsena.

1. Surask realų main create-session / grant, charge-oto / advance-oto ir browser checkout kelią. Šiame repo pradėk nuo apps/funnel/src/app/api/solidgate, checkout / OTO komponentų, packages/shared/src/solidgate/form.ts ir oto.ts. Sutvarkyk vieną autoritetingą kainos bei pasiūlymo parinkimo kelią, išlaikydamas esamas atominio claim ir replay apsaugas.
2. Serveris iš 02 kontrakto turi patvirtinti app, environment, kanalą, svetainės locale, pasiūlymą, OTO poziciją, billing_type ir prieigą. Browser amount, currency, product_id, subscription_id, order status ar nuosavybės laukais aklai nepasitikėk. Kainos versiją ir galutinio puslapio locale užfiksuok prieš pirmą mokėjimo bandymą; IP ir nauji retry UTM šio snapshot neperrašo.
3. Main request naudok produkto product_id ir pasirinktos kainos product_price_id. OTO2 /recurring naudok produkto product_id bei currency ir patikrink susietą kainą. Kitų OTO /recurring naudok serverio amount bei currency, be išgalvotų providerio UUID. OTO2 lieka vienintelė subscription OTO pozicija. Patikrink kiekvieno įjungto metodo / valiutos palaikymą konkrečiame kanale; vien produkto kainos buvimo neužtenka.
4. UI suderink su užfiksuotu serverio pasiūlymu: mokama dabar, trial trukmė, renewal suma / periodas ir atskiro OTO2 prenumeratos sąlygos turi būti matomos prieš pirkimą. One_time pasiūlymams nerodyk paslėpto renewal. Praleidimas turi tęsti kontrakte nustatytą seką be mokesčio.
5. Išlaikyk atominį order ir OTO pozicijos claim, kad du paspaudimai, du tabai ar accept / skip lenktynės negalėtų laimėti kartu. Priimto providerio bandymo, neaiškaus timeout ir galutinio failure kelius atskirk. Neaiškaus rezultato atveju tikrink tą patį order; nepradėk naujo mokėjimo vien dėl browser retry. Dalinio DB / providerio nesutapimo atvejį palik saugiai reconciliation būsenai.
6. Išsaugoto mokėjimo būdo nuosavybę ir ryšį su kilmės pirkimu tikrink serveryje. OTO 3DS turi būti susietas su tuo pačiu order, sesija ir aktyviu bandymu. Atmesk pasenusius ir svetimus challenge grįžimus. Teisėtą to paties challenge patvirtinimo pakartojimą apdorok idempotentiškai: grąžink arba sutikrink tą patį order, nesukurk naujo nurašymo ir neatmesk vien dėl teisėto retry. Po refresh ar grįžimo iš 3DS nuskaityk serverio būseną ir tęsk pradėtą pirkimą.
7. accepted / auth_ok / processing nelaikyk paid. UI turi atskirti laukimą, papildomą patvirtinimą, sėkmę ir galutinę klaidą. Nei return URL, nei kliento success callback nesuteikia nepatikrinto entitlement. Vėliau gautas failure po priėmimo turi pasiekti UI ir 03 backend sutvarkyti būseną pagal kontraktą.
8. Prijunk 03 paruoštą atribucijos adapterį: prieš providerio pateikimą išsaugok pilną first-touch / last-touch snapshot, kanoninius plokščius utm_* ir stabilų ryšį su sesija bei order. Atmetinėk netinkamas formas / nevaldomus dydžius pagal aiškią įvesties sutartį; nesaugok klientų paslapčių ar neapriboto savavališko payload. Jei būtinas DB išsaugojimas nepavyksta, pateik saugų pakartojamą klaidos rezultatą prieš mokėjimą, ne veikiančią tik iš vardo attribution_id nuorodą.
9. Subscription order_metadata siųsk šešis pagrindinius tekstinius laukus: funnel_code, funnel_variant, price_id, product_code, product_slug, session_id. Pridėk vieną utm su serializuotu JSON tekstu, kai UTM yra; jų neišgalvok. One_time order neturimam price_id ar product_id nenaudok fiktyvaus UUID. Visų laukų skaičių ir ilgį tikrink pagal endpointo kontraktą: Payment Form v1 iki 10 porų, iki 380 simbolių lauke.
10. Jei serializuotas utm viršija 380 simbolių, vietoje jo siųsk trumpą attribution_id į jau sėkmingai išsaugotą pilną snapshot. JSON nekarpyk, duomenų neprarask ir vien dėl ilgo marketing teksto mokėjimo neatmesk. Patikrink, kad 03 grant / webhook / renewal / analitikos skaitytojai palaiko naują JSON, nuorodą ir seną plokščią metadata; vien rašytojo pakeitimo neužtenka.
11. order_description nustatyk į pilną pirkimo kodą su užfiksuota locale. Website ir traffic_source siųsk jų atskiruose laukuose, ne metadata lizdų sąskaita. SDK merchant_data palik jo pasirašyto wrapperio paskirčiai. Nepriskirk Public description ir Descriptor vienodai semantikai. Main, OTO ir PWA užklausose visada praleisk dynamic_descriptor bei produkto suffix; statinį Descriptor nustato kanalas / connector. Tai galioja ir visiems trial bei renewal produktams.
12. OTO1 paprasto one_time atveju after_purchase=grant_only ir main neatšaukiama. Tik after_purchase=cancel_main_after_capture lifetime scenarijus perduodamas 03 įgyvendintam backend keliui po patvirtinto capture ir patikimai išsaugoto lifetime entitlement teisingam savininkui. Grant klaida neturi paleisti cancellation; vėlesnis main cancellation webhook neturi panaikinti lifetime prieigos. Main ir OTO2 prenumeratų, jų renewal ir cancellation nesujunk į vieną globalią vartotojo būseną.
13. Prisijungimą bei order claim laikyk atskirais nuo checkout el. pašto įvedimo. Esamos paskyros neauto-confirmink ir nesukurk jos sesijos vien pagal pirkime įrašytą email. Patikrink neautorizuotą order / session / token pernaudojimą.
14. Paleisk prasmingus integracijos ir browser testus: pagrindinis pirkimas, kiekvieno billing_type OTO accept / skip, dvigubas submit, neaiškus timeout, vienalaikis retry, 3DS / refresh, klaida po accepted, kainos manipuliacija, kelios locale, metadata ribos ir ilgų UTM nuorodos išsprendimas. Vietiniai mokėjimo stub / fixture nėra realus sandbox nurašymas.
15. Parašyk docs/payments/setup/04-checkout-report.md: sujungti keliai ir failai, UI / serverio sumų atitikimas, UTM saugojimo ir skaitymo įrodymai, testų rezultatai, apribojimai, konkrečios 05 sandbox patikros. Neįdėk paslapčių ar tikrų klientų duomenų.

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

- [Solidgate Payment Form](https://docs.solidgate.com/payments/integrate/payment-form/create-your-payment-form/)
- [Solidgate mokėjimai išsaugota kortele](https://docs.solidgate.com/payments/card-payments/manage-card-payments/)

Šis failas sugeneruotas iš `apps/funnel/src/features/documentation/setup/integration-steps.ts`. Atnaujinti: `npm run docs:setup:build`. Patikrinti: `npm run docs:setup:check`.


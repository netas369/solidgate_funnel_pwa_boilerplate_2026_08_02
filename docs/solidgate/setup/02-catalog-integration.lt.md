# 02. Katalogas ir OTO

Interaktyvus žingsnis ir kopijuojamas agento promptas: **`/documentation/setup/catalog-integration`**.

Sujungiame patvirtintus produktus, kainas, website locale ir visą main + OTO pasiūlymų seką į vieną appso kontraktą.

Šis puslapis aprašo būsimo agento darbą tiksliniame appso repo. Dokumentacijos UI generuoja instrukcijas; jis nevykdo providerio API, migracijų ar deploy. Įvesti laukai nepatvirtina failų egzistavimo ar integracijos parengties.

## Reikalinga įvestis

- 01-provider-manifest.json su perskaitytais ir patikrintais visų pasirinktų main variantų bei OTO2 prenumeratos produktų / kainų ID.
- Naujo appso repo, app_key, aplinka ir Solidgate kanalas.
- Main variantai, įjungtos svetainės locale, OTO pozicijos, kainos ir suteikiamos prieigos.
- Aiškus sprendimas, ar OTO1 yra lifetime, ir ar po jo apmokėjimo nutraukiama main prenumerata.

## Žingsnio rezultatas

- docs/payments/setup/02-commerce-contract.json — versijuotas main + OTO katalogo kontraktas.
- docs/payments/setup/02-catalog-report.md — mapping, konfliktai, pakeisti failai ir patikrų rezultatai.
- Atnaujintas vietinis TS katalogas, kainynas ir paruoštas suderintas SQL migracijos pakeitimas; main bei OTO sąlygos sutampa.

## Pirmas žingsnis kartojamas prenumeratos pasiūlymams

01 produkto formą užpildome kiekvienam norimam main trial variantui ir atskiram OTO2 prenumeratos pasiūlymui. Rezultatus kaupiame viename appso, aplinkos ir kanalo 01-provider-manifest.json, išsaugodami ankstesnius įrašus ir patikros būseną. required_offers išvardija visus pasirinktus main variantus ir vieną OTO2 su tikslia catalog_version. Imama tik kontekste nurodyta versija; istorinių įrašų netriname, o kelių tinkamų verified įrašų konfliktas neišsprendžiamas automatiškai imant pirmą ar naujausią. planned ar vien created įrašas nepakeičia verified įrašo su realiai perskaitytais ID ir verified_at. Vienkartiniams OTO šiame boilerplate providerio produkto nereikia: jų kainos priklauso serverio katalogui. Jei OTO2 produkto dar nėra, antro žingsnio agentas gali paruošti likusį vietinį mapping, tačiau negali pažymėti katalogo užbaigtu.

## Viena OTO prenumerata, kiti — vienkartiniai

Dabartinis TS ir SQL modelis prenumeratos OTO laiko 2 pozicijoje. Kontrakte kiekvienas įjungtas OTO turi poziciją, stabilų pasiūlymo raktą, billing_type, kainas, entitlement ir sėkmės taisyklę. Main yra atskira prenumerata; nusipirkus main ir OTO2 klientas turi dvi nepriklausomas prenumeratas. Jų renewal, atšaukimas, grąžinimai ir prieigos tikrinami atskirai. Kodo galūnė _SUB nenustato mokėjimo tipo: dabartinio lifetime demonstracinis kodas irgi gali taip baigtis.

## OTO1 turi aiškią komercinę taisyklę

Boilerplate OTO1 yra lifetime pasiūlymas su pagrindinės prenumeratos nutraukimo elgesiu. Naujam įprastam one_time pasiūlymui to nepaveldime. Numatytasis after_purchase yra grant_only. Tik aiškiai pasirinktam lifetime scenarijui naudojame cancel_main_after_capture ir aprašome, kuri main prenumerata nutraukiama. Atšaukimo užduotis kuriama tik po patvirtinto capture ir patikimai išsaugoto lifetime entitlement teisingam savininkui. Main atšaukimo webhook negali panaikinti šios lifetime prieigos. Ši taisyklė nesuteikia leidimo nutraukti OTO2 prenumeratos.

## Mapping apima TS ir SQL

Vien catalog-ids.json pakeitimo neužtenka. Agentas sutikrina price-map, Solidgate katalogą, įjungtas locale, UI pasiūlymus, serverio allowlist, entitlement atpažinimą, OTO pozicijų ir DB kainų apribojimus. 02 formos offerKey yra runtime checkout product_slug, o pricingReference susieja jį su manifesto catalog_key. Jie neprivalo sutapti: addon_trial kataloge gali atitikti oto2_addon_weekly checkout. Kontrakte šis ryšys, pilnas pirkimo product_code, provider_product_id ir provider_price_id laikomi atskirai. Demo kodai pakeičiami tik jų tikroje paskirtyje; istorinių order neprirašome naujai kainai. 02 paruošia suderintą SQL pakeitimą, 03 jį išbando izoliuotoje DB.

## Kaina ir locale fiksuojamos pirkimo pradžioje

Galutinio atvaizduoto URL locale nustato valiutą ir prenumeratos pirkimo kodą {LOCALE}_{PRODNAME}_{YYMMDD}_SUB. IP šalies nenaudojame šiam pasirinkimui. Vienkartinių prekių kodo formatas aprašomas kontrakte atskirai, nenaudojant _SUB tipo atspėjimui. Data yra fiksuota katalogo versija. Trial, pradinis mokėjimas ir renewal sumos laikomos atskirai, integer minor units; TWD turi 2 skaitmenis, JPY ir KRW — 0. Retry bei renewal išlaiko užfiksuotą kainos versiją ir kilmės locale, o nežinomi variantai negauna tylaus fallback.

## Kiekvienas endpointas turi savo sutartį

Main Payment Form siunčia produkto product_id ir pasirinktos valiutos product_price_id. OTO2 subscription mokėjimas per /recurring šiame repo siunčia produkto product_id ir currency; kainų mapping vis tiek patikrinamas prieš kreipiantis. Vienkartinis OTO siunčia serveryje nustatytą amount ir currency be išgalvotų produkto / kainos UUID. Produkto ir default kainos UUID sutapimas savaime nėra klaida. Nauja valiuta laikoma įjungta tik kai ją palaiko visas pasirinktas mokėjimo kelias, ne vien 01 forma.

## Užbaigimo patikros

- OTO sekoje tik viena subscription pozicija — OTO2; likę įjungti OTO yra one_time.
- Main ir OTO2 turi atskirus produktus, entitlement raktus ir būsimus subscription_id.
- Vienas produktas pasiūlymui, viena patvirtinta kaina kiekvienai valiutai; vienodą EUR kainą gali naudoti kelios locale.
- Serverio, UI ir DB kainų patikros sutampa; nežinoma locale, pasiūlymas ar trūkstamas ID atmetami.
- Vienkartinis OTO1 neatšaukia main, nebent after_purchase yra cancel_main_after_capture ir saugiai užfiksuoti capture bei lifetime prieiga teisingam savininkui.

## Agento promptas

Programėlės forma prideda bendras vykdymo taisykles ir įvestą projekto kontekstą. Kopijuojant vien šį dokumentą, agentui taip pat perduodamas target repo, app_key, aplinka, kanalas, konkreti catalog_version, provider_manifest_path ir main + OTO pasiūlymų planas. Paslapčių prie prompto nepridėkite. Kontekste nurodytas manifesto kelias pakeičia numatytą kelią visose instrukcijose; kitas kopijas kurti nereikia.

```text
Įgyvendink mokėjimų diegimo 02 žingsnį: naujo appso main + OTO katalogą.

Prieš keisdamas kodą perskaityk repo instrukcijas, pateiktą kontekstą ir 01 produkto artefaktą. Numatytasis įvesties failas yra docs/payments/setup/01-provider-manifest.json. Jei kontekste nurodytas kitas providerManifestPath / provider_manifest_path, tas failas yra autoritetingas visoje 02–05 sekoje. Jo nekopijuok ir nesujunk su numatytuoju failu; išsaugok pasirinktą kelią 02 kontrakte bei ataskaitose ir iš jo skaityk ankstesnes versijas, kilmę bei patikros būseną. Svetimo appso, aplinkos ar kanalo įrašų nepriimk. Vien suplanuotas produktas nėra patikrintas providerio produktas.

1. Inventorizuok realius integracijos taškus. Šiame boilerplate pradėk nuo packages/shared/src/price-map.ts, packages/shared/src/solidgate/catalog.ts, catalog-ids.json, packages/i18n/src/routing.ts, apps/funnel/src/app/api/solidgate, checkout / OTO komponentų ir supabase/migrations. Kelių naujame repo nebuvimas nėra leidimas kurti antrą lygiagretų katalogą: surask tikrus atitikmenis.
2. Sudaryk visą main variantų ir OTO pasiūlymų sąrašą. Main variantai yra subscription. OTO sekoje turi būti tik vienas subscription pasiūlymas ir jis yra OTO2; visi kiti įjungti OTO yra one_time. Nustatyk billing_type aiškiu lauku, ne pagal produkto kodo galūnę. Nepalik paslėpto papildomo subscription pasiūlymo kituose OTO.
3. Patikrink, kad 01 manifesto required_offers apima kiekvieną pasirinktą main variantą ir vieną atskirą OTO2 prenumeratą su tikslia konteksto catalog_version, o offers įrašai turi teisingus role, runtime_product_slug, entitlement_key, trial, billing periodą, default / papildomas kainas bei patvirtintus ID. Kiekvienam pasiūlymui turi būti tiksliai vienas tinkamas app + environment + channel + catalog_key + catalog_version verified atitikmuo. Trūkstama versija arba keli tinkami įrašai yra konfliktas; neimk naujausio, pirmo ar kitos versijos įrašo savo nuožiūra. Istorinės versijos lieka manifeste. Paruoštumo įrodymas yra verified būsena su verified_at ir perskaitytomis sąlygomis; planned ar created vieni nepakanka. Jei produkto trūksta, įrašyk tikslų grįžimą į 01 žingsnį; neegzistuojančio UUID negeneruok. Nepaversk seno patvirtinto įrašo planned ir neprarask dalinio kūrimo ID.
4. Parašyk docs/payments/setup/02-commerce-contract.json su schema_version, app_key, environment, channel_reference, catalog_version, billing_descriptor_policy=static_channel_connector_only, kilmės manifesto nuoroda ir pasiūlymų rinkiniu. 02 formos offerKey yra runtime checkout product_slug, o pricingReference nurodo manifesto catalog_key arba tikslų kainyno šaltinį; šių raktų lygybės nedaryk numanomos. Pavyzdžiui, catalog_key addon_trial gali atitikti runtime_product_slug oto2_addon_weekly. Kiekvienam pasiūlymui išsaugok aiškų catalog_key → runtime_product_slug ryšį, vaidmenį main arba oto, billing_type, OTO poziciją kai taikoma, display_name, entitlement_key, trial / billing sąlygas, integer sumas ir after_purchase reikšmę grant_only arba cancel_main_after_capture. Taip pat užfiksuok entitlement politiką atšaukus dabar / periodo pabaigoje, failed renewal grace trukmę ir prieigos elgesį po dalinio / pilno refund bei dispute. Nežinomų komercinių sprendimų neparink tyliai. Subscription pasiūlymams laikyk produkto ir kainos UUID atskirais laukais; one_time pasiūlymams jų nereikalauk. Pateik locale → currency → pasiūlymas → pirkimo kodas → kainos versija mapping.
5. Vienam subscription pasiūlymui naudok vieną providerio produktą ir vieną patvirtintą kiekvienos valiutos kainą. Vienodos tos pačios valiutos kainos kelioms locale turi nurodyti tą patį kainos įrašą. Nesuderinamos tos pačios valiutos sąlygos yra konfliktas, kuriam reikia atskiro pasiūlymo ar aiškiai suprojektuotos regioninės kainodaros. Nefalsifikuok geo_country. Default valiuta priklauso produktui, ne locale.
6. Konvertuok tik dešimtainį sumos tekstą į integer minor units vieną kartą, be slankiojo kablelio apvalinimo. TWD exponent=2, JPY/KRW=0; kitų valiutų tikslumą patikrink pagal naudojamą Solidgate kontraktą. Jei įjungtas PayPal, tikrink jo atskiras sumų ir valiutų palaikymo taisykles. UI, serverio ir DB sumos bei trial / renewal turi sutapti. Neįjunk valiutos vien todėl, kad ją siūlo 01 forma.
7. Pirkimo locale imk iš galutinės svetainės routing konfigūracijos po redirect. Prenumeratos pilnas kodas yra {LOCALE}_{PRODNAME}_{YYMMDD}_SUB; vienkartinių pasiūlymų formatą aprašyk kontrakte atskirai. Užfiksuok kainos versiją, locale, valiutą ir kodą viename pirkimo kontekste. Retry ar renewal neturi parinkti naujos katalogo versijos. Nežinomas pasiūlymas / locale / nepatvirtintas ID turi būti aiški klaida.
8. Main ir OTO2 suprojektuok su atskirais entitlement ir subscription_id ryšiais. Main prieigos raktas stabilus tarp locale bei trial variantų, kad kalbos pakeitimas nesuteiktų antro intro. Išsaugok teisėtus istorinius kainos ID ir jų semantikas.
9. OTO1 after_purchase numatyk grant_only. Tik aiškiai pateiktam lifetime sprendimui leisk cancel_main_after_capture; aprašyk tikslų main subscription tikslą, patvirtintą capture ir patikimai išsaugotą lifetime entitlement teisingam savininkui kaip privalomas sąlygas prieš cancellation užduotį. Jei grant nepavyksta, main dar nenutraukiama; vėlesnis main cancellation webhook negali panaikinti lifetime prieigos. Nepriskirk šios taisyklės paprastam one_time pirkimui ir netaikyk jos OTO2 prenumeratai.
10. Įdiek vietinį TS katalogą / kainyną ir paruošk suderintą SQL migracijos pakeitimą. Patikrink DB kainų / OTO pozicijų apribojimus, kodų atpažinimą, RPC, UI pasirinkimus ir įjungtas locale. Migracijos netaikyk nuotolinei DB vien dėl šio prompto. Esamų migracijų istorijos neperrašyk; naujoje migracijoje išsaugok seno katalogo įrašų interpretaciją.
11. Patikrink skirtingas endpointų semantikas: main siunčia product_id ir product_price_id; šio repo OTO2 /recurring — product_id ir currency, patikrinant pasirinktą kainą; one_time /recurring — amount ir currency. Nesukurk bendro adapterio, kuris aklai sukeičia produkto ir kainos UUID. Lygi produkto ir default kainos UUID reikšmė nėra validacijos klaida.
12. Paleisk prasmingas katalogo, tipo / sumų, nežinomų įvesčių ir OTO taisyklių patikras; TS ir SQL sulyginimui nenaudok tik iš to paties objekto sugeneruoto savitikros testo. Užfiksuok, ką DB dar turi išbandyti 03 žingsnis. Parašyk docs/payments/setup/02-catalog-report.md su failais, patikromis, likusiais blokavimais ir aiškiu perdavimu 03 žingsniui. Mokėjimų šiame žingsnyje nepradėk.

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

- [Solidgate produktai](https://docs.solidgate.com/billing/manage-products/products/)
- [Solidgate kainos](https://docs.solidgate.com/billing/manage-products/prices/)
- [Palaikomos valiutos](https://docs.solidgate.com/payments/payments-insights/supported-currencies/)

Šis failas sugeneruotas iš `apps/funnel/src/features/documentation/setup/integration-steps.ts`. Atnaujinti: `npm run docs:setup:build`. Patikrinti: `npm run docs:setup:check`.


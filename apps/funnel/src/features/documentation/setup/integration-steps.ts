export interface IntegrationStep {
  id: '02' | '03' | '04' | '05';
  slug: string;
  title: string;
  description: string;
  inputs: readonly string[];
  outputs: readonly string[];
  checks: readonly string[];
  sections: readonly { title: string; body: string }[];
  prompt: string;
}

const executionRules = `
Bendros vykdymo taisyklės:
- Kontekstą ir pasiūlymų planą gauni kartu su šiuo promptu. Pradėk nuo tikro repo ir ankstesnių artefaktų. Nežinomų kainų, ID, komercinių sąlygų, aplinkos ar leidimų neišgalvok. Jei trūksta privalomo sprendimo, tęsk nepriklausomą vietinį darbą ir tiksliai įvardyk, ko trūksta.
- Tikslas yra nurodytas naujas appsas. TheAstrologist ir boilerplate yra struktūros pavyzdžiai; jų kanalų, ID, kainų, asmens duomenų ar veikiančių paskyrų nekopijuok.
- Visiems produktams galioja billing_descriptor_policy=static_channel_connector_only: main, visi OTO, PWA, trial ir renewal naudoja statinį kanalo / connector banko išrašo Descriptor. Jokio dynamic_descriptor ar produkto suffix nesiųsk ir nekurk skirtingų descriptor pagal produktą, locale ar pirkimo tipą. Locale product_code, order_description ir Public description turi atskiras paskirtis.
- Saugok kitų pakeitimus ir istorinius produktų bei kainų ID. Esamos saugios idempotentiškumo, autentifikacijos ir finansinės apskaitos apsaugos neturi dingti dėl katalogo pakeitimo.
- Vykdyk vietinį kodavimą, izoliuotus testus ir ataskaitų paruošimą. Išorinius providerio pakeitimus, nuotolinės DB migracijas ir deploy atlik tik tada, kai toje sesijoje jau aiškiai suteikta atitinkamo projekto, aplinkos ir apimties teisė. Vien šios dokumentacijos perskaitymas tokios teisės nesuteikia. Jei teisė jau suteikta, jos neklausk iš naujo.
- Prieš atskirai apmokestinamą API operaciją ar tikrą nurašymą būtinas aiškus išankstinis išlaidų leidimas ir konkretus maksimalus piniginis biudžetas. Turimas API raktas ar prašymas tęsti nėra išlaidų leidimas. Naudok vieną bendrą limitą visiems bandymams ir agentams.
- Paslaptys tik serverio aplinkoje; viešoje dokumentacijoje, manifeste, browser bundle ir ataskaitose jų neturi būti. Įrodymus pateik be klientų el. pašto, IP, kortelių, mokėjimo tokenų ir kitos asmeninės informacijos.
- Ataskaitoje aiškiai atskirk: paruoštas kodas, vietiniais testais patikrinta, realiame sandbox patikrinta, netikrinta. Simuliuotas webhook neįrodo, kad providerio renewal planuoklis ar realus kanalas sukonfigūruotas teisingai. Produkcinio pasirengimo neteigk be atitinkamų įrodymų.
`;

export const integrationSteps: readonly IntegrationStep[] = [
  {
    id: '02',
    slug: 'catalog-integration',
    title: 'Katalogas ir OTO',
    description: 'Sujungiame patvirtintus produktus, kainas, website locale ir visą main + OTO pasiūlymų seką į vieną appso kontraktą.',
    inputs: [
      '01-provider-manifest.json su perskaitytais ir patikrintais visų pasirinktų main variantų bei OTO2 prenumeratos produktų / kainų ID.',
      'Naujo appso repo, app_key, aplinka ir Solidgate kanalas.',
      'Main variantai, įjungtos svetainės locale, OTO pozicijos, kainos ir suteikiamos prieigos.',
      'Aiškus sprendimas, ar OTO1 yra lifetime, ir ar po jo apmokėjimo nutraukiama main prenumerata.',
    ],
    outputs: [
      'docs/payments/setup/02-commerce-contract.json — versijuotas main + OTO katalogo kontraktas.',
      'docs/payments/setup/02-catalog-report.md — mapping, konfliktai, pakeisti failai ir patikrų rezultatai.',
      'Atnaujintas vietinis TS katalogas, kainynas ir paruoštas suderintas SQL migracijos pakeitimas; main bei OTO sąlygos sutampa.',
    ],
    checks: [
      'OTO sekoje tik viena subscription pozicija — OTO2; likę įjungti OTO yra one_time.',
      'Main ir OTO2 turi atskirus produktus, entitlement raktus ir būsimus subscription_id.',
      'Vienas produktas pasiūlymui, viena patvirtinta kaina kiekvienai valiutai; vienodą EUR kainą gali naudoti kelios locale.',
      'Serverio, UI ir DB kainų patikros sutampa; nežinoma locale, pasiūlymas ar trūkstamas ID atmetami.',
      'Vienkartinis OTO1 neatšaukia main, nebent after_purchase yra cancel_main_after_capture ir saugiai užfiksuoti capture bei lifetime prieiga teisingam savininkui.',
    ],
    sections: [
      {
        title: 'Pirmas žingsnis kartojamas prenumeratos pasiūlymams',
        body: '01 produkto formą užpildome kiekvienam norimam main trial variantui ir atskiram OTO2 prenumeratos pasiūlymui. Rezultatus kaupiame viename appso, aplinkos ir kanalo 01-provider-manifest.json, išsaugodami ankstesnius įrašus ir patikros būseną. required_offers išvardija visus pasirinktus main variantus ir vieną OTO2 su tikslia catalog_version. Imama tik kontekste nurodyta versija; istorinių įrašų netriname, o kelių tinkamų verified įrašų konfliktas neišsprendžiamas automatiškai imant pirmą ar naujausią. planned ar vien created įrašas nepakeičia verified įrašo su realiai perskaitytais ID ir verified_at. Vienkartiniams OTO šiame boilerplate providerio produkto nereikia: jų kainos priklauso serverio katalogui. Jei OTO2 produkto dar nėra, antro žingsnio agentas gali paruošti likusį vietinį mapping, tačiau negali pažymėti katalogo užbaigtu.',
      },
      {
        title: 'Viena OTO prenumerata, kiti — vienkartiniai',
        body: 'Dabartinis TS ir SQL modelis prenumeratos OTO laiko 2 pozicijoje. Kontrakte kiekvienas įjungtas OTO turi poziciją, stabilų pasiūlymo raktą, billing_type, kainas, entitlement ir sėkmės taisyklę. Main yra atskira prenumerata; nusipirkus main ir OTO2 klientas turi dvi nepriklausomas prenumeratas. Jų renewal, atšaukimas, grąžinimai ir prieigos tikrinami atskirai. Kodo galūnė _SUB nenustato mokėjimo tipo: dabartinio lifetime demonstracinis kodas irgi gali taip baigtis.',
      },
      {
        title: 'OTO1 turi aiškią komercinę taisyklę',
        body: 'Boilerplate OTO1 yra lifetime pasiūlymas su pagrindinės prenumeratos nutraukimo elgesiu. Naujam įprastam one_time pasiūlymui to nepaveldime. Numatytasis after_purchase yra grant_only. Tik aiškiai pasirinktam lifetime scenarijui naudojame cancel_main_after_capture ir aprašome, kuri main prenumerata nutraukiama. Atšaukimo užduotis kuriama tik po patvirtinto capture ir patikimai išsaugoto lifetime entitlement teisingam savininkui. Main atšaukimo webhook negali panaikinti šios lifetime prieigos. Ši taisyklė nesuteikia leidimo nutraukti OTO2 prenumeratos.',
      },
      {
        title: 'Mapping apima TS ir SQL',
        body: 'Vien catalog-ids.json pakeitimo neužtenka. Agentas sutikrina price-map, Solidgate katalogą, įjungtas locale, UI pasiūlymus, serverio allowlist, entitlement atpažinimą, OTO pozicijų ir DB kainų apribojimus. 02 formos offerKey yra runtime checkout product_slug, o pricingReference susieja jį su manifesto catalog_key. Jie neprivalo sutapti: addon_trial kataloge gali atitikti oto2_addon_weekly checkout. Kontrakte šis ryšys, pilnas pirkimo product_code, provider_product_id ir provider_price_id laikomi atskirai. Demo kodai pakeičiami tik jų tikroje paskirtyje; istorinių order neprirašome naujai kainai. 02 paruošia suderintą SQL pakeitimą, 03 jį išbando izoliuotoje DB.',
      },
      {
        title: 'Kaina ir locale fiksuojamos pirkimo pradžioje',
        body: 'Galutinio atvaizduoto URL locale nustato valiutą ir prenumeratos pirkimo kodą {LOCALE}_{PRODNAME}_{YYMMDD}_SUB. IP šalies nenaudojame šiam pasirinkimui. Vienkartinių prekių kodo formatas aprašomas kontrakte atskirai, nenaudojant _SUB tipo atspėjimui. Data yra fiksuota katalogo versija. Trial, pradinis mokėjimas ir renewal sumos laikomos atskirai, integer minor units; TWD turi 2 skaitmenis, JPY ir KRW — 0. Retry bei renewal išlaiko užfiksuotą kainos versiją ir kilmės locale, o nežinomi variantai negauna tylaus fallback.',
      },
      {
        title: 'Kiekvienas endpointas turi savo sutartį',
        body: 'Main Payment Form siunčia produkto product_id ir pasirinktos valiutos product_price_id. OTO2 subscription mokėjimas per /recurring šiame repo siunčia produkto product_id ir currency; kainų mapping vis tiek patikrinamas prieš kreipiantis. Vienkartinis OTO siunčia serveryje nustatytą amount ir currency be išgalvotų produkto / kainos UUID. Produkto ir default kainos UUID sutapimas savaime nėra klaida. Nauja valiuta laikoma įjungta tik kai ją palaiko visas pasirinktas mokėjimo kelias, ne vien 01 forma.',
      },
    ],
    prompt: `Įgyvendink mokėjimų diegimo 02 žingsnį: naujo appso main + OTO katalogą.

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
${executionRules}`,
  },
  {
    id: '03',
    slug: 'database-webhooks',
    title: 'DB ir webhook',
    description: 'Paruošiame serverio apskaitą prieš checkout: kiekvienas mokėjimas, trial, renewal, refund ir prieigos pakeitimas turi atsekamą istoriją DB.',
    inputs: [
      '01-provider-manifest.json, 02-commerce-contract.json ir 02-catalog-report.md.',
      'Paruošti katalogo TS / SQL pakeitimai ir izoliuota vietinė DB patikrai.',
      'Serverio webhook / worker konfigūracijos pavadinimai ir pasirinktos aplinkos ryšiai, be paslapčių dokumentuose.',
    ],
    outputs: [
      'docs/payments/setup/03-backend-report.md — migracijų, webhook, finansinių įvykių, teisių ir testų ataskaita.',
      'Vietinėje DB patikrintos migracijos, idempotentiškas webhook / worker kelias ir aiškios serverio būsenos.',
      'Atribucijos snapshot saugojimo schema / adapteriai ir seną bei naują metadata formatą suprantantys skaitytojai; checkout rašymas jungiamas 04.',
    ],
    checks: [
      'Pakartotas ar ne eilės tvarka gautas įvykis nedubliuoja order, finansinio judėjimo, prieigos ar išorinio šalutinio veiksmo.',
      'Auth 5 EUR + Settle 5 EUR apskaitoje reiškia vieną 5 EUR capture; nepavykęs mokėjimas nėra pajamos.',
      'Main ir OTO2 trial, renewal, cancellation bei entitlement atskiriami pagal konkrečią prenumeratą.',
      'Per vartotojo el. paštą nesukuriama patvirtinta sesija esamai paskyrai be nuosavybės įrodymo.',
      'DB leidžia atsekti sumą, valiutą, įvykio laiką, providerio įrodymą, kainos versiją ir atribuciją.',
    ],
    sections: [
      {
        title: 'Order ir finansiniai judėjimai nėra tas pats',
        body: 'Order aprašo konkretų pirkimą ar invoice bandymą; nekintamų finansinių įvykių istorija aprašo realius capture, refund ir dispute judėjimus. Auth ir jo Settle nėra dvi pajamos. Failed / processing būsena nėra nurašytų pinigų įrodymas. Capture ir refund saugomi su suma, valiuta, providerio tapatybe bei įvykio laiku. Skirtingų valiutų bendros sumos nejungiamos be aiškiai dokumentuoto konvertavimo šaltinio. Grynieji capture minus refund nėra providerio payout ar pelnas: mokesčiams ir atsiskaitymams reikia jų pačių duomenų.',
      },
      {
        title: 'Pristatymas gali kartotis ir vėluoti',
        body: 'Webhook parašas patikrinamas pagal tikslinį kanalą ir aplinką, įvykis patikimai išsaugomas, o apdorojimas vyksta atominėmis būsenų operacijomis. Tas pats event gali būti pristatytas kelis kartus; skirtingi event taip pat gali reikšti tą patį finansinį judėjimą, todėl vien event ID deduplikacijos neužtenka. Vėlesnis capture negali būti panaikintas pavėluoto processing įvykio. Worker retry, klaidos ir atsilikimas turi būti matomi DB ir ataskaitose.',
      },
      {
        title: 'Trial ir renewal sekami kiekvienai prenumeratai',
        body: 'Saugome atskiras main ir OTO2 prenumeratas, pradinį mokėjimą, trial pradžią / pabaigą, apmokėto periodo ribas, kitą planuojamą nurašymą kai provideris jį pateikia, cancellation ir realią būsenų istoriją. Kiekvienas renewal / invoice siejamas su jo subscription_id; sumos imamos iš tikro įvykio, ne iš dabartinės katalogo kainos. Nemokamas trial nėra piniginės pajamos. Vėliau nepavykus priimtam OTO mokėjimui, laukiančios būsenos ir galimi laikini entitlement turi būti sutvarkyti pagal kontraktą.',
      },
      {
        title: 'Atšaukimas nepanaikina visų kliento prenumeratų',
        body: 'Atšaukiant main nekeičiamas OTO2, o atšaukiant OTO2 nekeičiamas main. OTO1 lifetime šaka vykdo after_purchase=cancel_main_after_capture tik kai 02 kontrakte tai aiškiai įjungta, yra patvirtintas capture ir teisingam savininkui jau patikimai išsaugotas lifetime entitlement. Vien capture neužtenka: nepavykus grant, cancellation užduotis dar nekuriama. Vėlesnis main cancellation webhook lifetime prieigos nepanaikina. Išorinis atšaukimo veiksmas turi saugų pakartojimą ir reconciliation būseną, kad nutraukus ryšį nebūtų nei dvigubo veiksmo, nei amžinai pamiršto atšaukimo.',
      },
      {
        title: 'Atribucijai paruošiame abi skaitymo kryptis',
        body: '03 paruošia pilno first-touch / last-touch snapshot saugojimą ir kanoninius plokščius utm_* laukus vidinėje DB. Skaitytojai supranta senus plokščius providerio UTM, naują utm JSON tekstą ir attribution_id nuorodą į jau išsaugotą snapshot. Checkout pradės rašyti šį formatą 04 žingsnyje. Renewal paveldi pradinio pirkimo atribucijos ryšį, o naujas apsilankymas neperrašo istorinio acquisition. Blogai suformuota marketing metadata neturi nutraukti patvirtinto finansinio įvykio apskaitos.',
      },
      {
        title: 'Paskyros nuosavybė ir patikros lygis',
        body: 'Checkout el. paštas pats savaime nėra teisė prisijungti prie egzistuojančios paskyros. Pirkimo claim turi remtis patikrintu pirkimo / sesijos nuosavybės įrodymu, o prisijungimas — patvirtintu autentifikacijos keliu. Finansines lenteles, RPC ir ataskaitų views apsaugome pagal tikrą serverio / vartotojo modelį, įskaitant RLS ir grants. Vietinis signed fixture testas patikrina handler logiką; realus Solidgate webhook pristatymas bus atskiras 05 patikros rezultatas.',
      },
    ],
    prompt: `Įgyvendink mokėjimų diegimo 03 žingsnį: DB, webhook ir worker pasirengimą.

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
${executionRules}`,
  },
  {
    id: '04',
    slug: 'checkout-oto',
    title: 'Checkout ir OTO',
    description: 'Prijungiame main mokėjimą, vieną prenumeratos OTO ir vienkartinius OTO prie jau paruošto katalogo bei backend.',
    inputs: [
      '01-provider-manifest.json, 02-commerce-contract.json, 02-catalog-report.md ir 03-backend-report.md.',
      '03 paruošti DB / webhook ir atribucijos adapteriai, tikslinio appso routing ir checkout / OTO UI.',
      'Patvirtintos klientui rodomos trial, renewal, vienkartinės kainos bei pirkimo ir atšaukimo sąlygos.',
    ],
    outputs: [
      'docs/payments/setup/04-checkout-report.md — main / OTO / 3DS / UTM integracijos ir vietinių testų ataskaita.',
      'Sujungtas serverio checkout ir OTO kelias su locale, užfiksuota kaina, saugiais retry bei aiškiomis UI būsenomis.',
      'Pilnas serverio atribucijos snapshot ir suderintas providerio metadata rašymas, naudojantis 03 skaitytojais.',
    ],
    checks: [
      'Dvigubas paspaudimas, du tabai ar timeout nesukuria antro nepatvirtinto bandymo ir nenurašo du kartus.',
      'OTO priėmimas, praleidimas ir grįžimas saugomi atomiškai; naršyklė negali pakeisti kainos ar billing_type.',
      '3DS challenge ir jo grįžimas susieti su konkrečiu order, sesija ir bandymu; accepted / processing nerodomi kaip paid.',
      'Providerio metadata neviršija 10 laukų ir 380 simbolių lauke; pilni UTM išlieka DB.',
      'Main, OTO2 ir one_time užklausos naudoja savo endpointų laukus; kliento prieiga remiasi backend įrodymais.',
    ],
    sections: [
      {
        title: 'Serveris priima sprendimą dėl pasiūlymo',
        body: 'Browser pateikia pasirinktą pasiūlymą ir svetainės kontekstą; serveris iš 02 kontrakto nustato leistiną billing_type, sumą, valiutą ir providerio ID. UI aiškiai parodo kiek mokama dabar, kiek ir kada bus renewal, ar mokėjimas vienkartinis. OTO2 turi savo atskiras prenumeratos sąlygas. Return URL ar kliento success callback savaime nesuteikia prieigos ir nepatvirtina nurašymo.',
      },
      {
        title: 'OTO seka ir mokėjimo bandymas turi vieną savininką',
        body: 'Išsaugomas esamas atominis order / OTO pozicijos claim ir serverio sekos tikrinimas. Priimti ir praleisti tą patį OTO vienu metu negalima. Timeout arba nežinomas providerio atsakymas sprendžiamas tikrinant to paties order būseną, o ne automatiškai sukuriant kitą mokėjimą. Aiškus galutinis atsisakymas ir neaiškus rezultatas turi skirtingus retry kelius. Sesijos atnaujinimas, du tabai ir grįžimas po 3DS turi tęsti esamą veiksmą.',
      },
      {
        title: 'Išsaugotas mokėjimo būdas negarantuoja nurašymo',
        body: 'One-click main / OTO ryšį patikrina serveris: išsaugotas mokėjimo tokenas priklauso tam pačiam klientui ir leistinai kilmės sesijai. Jis nepatenka į viešą browser konfigūraciją. Provideris gali pareikalauti 3DS; challenge susiejamas su konkrečiu order ir bandymu, o pasenęs ar svetimas grįžimas atmetamas, o teisėtas to paties patvirtinimo pakartojimas grąžina arba sutikrina esamo order būseną. accepted arba processing rodo priimtą apdoroti užklausą, o apmokėjimą ir prieigą nustato patvirtinta serverio būsena.',
      },
      {
        title: 'Šeši baziniai laukai ir vienas UTM tekstas',
        body: 'Subscription transakcijos metadata turi funnel_code, funnel_variant, price_id, product_code, product_slug ir session_id. Pridedame vieną utm su JSON tekstu — iš viso 7 laukai. Vienkartinis sumos mokėjimas neturi išgalvoto price_id; neprieinamą lauką praleidžiame. Visų laukų ir jų ilgio ribas tikriname pagal endpointą: Payment Form v1 leidžia 10 porų ir 380 simbolių reikšmę. Senas 5 bazinių laukų + 5 UTM kelias pakeičiamas tik kartu su visais 03 paruoštais skaitytojais.',
      },
      {
        title: 'Ilgi UTM lieka pilni vidinėje DB',
        body: 'Checkout serveryje pirmiausia išsaugo pilną first-touch / last-touch snapshot ir kanoninius plokščius UTM, susietus su sesija, order ir vėlesne prenumerata. Jei serializuotas utm viršija 380 simbolių, į providerio metadata vietoje jo įrašo trumpą attribution_id į sėkmingai išsaugotą snapshot. JSON nekertame ir rinkodaros duomenų ilgiu mokėjimo neblokuojame. Jei pats būtinas DB saugojimas nepavyksta, grąžiname saugų pakartojamą saugojimo klaidos rezultatą, o ne siunčiame neveikiančią nuorodą ar prarandame auditą.',
      },
      {
        title: 'Atskiri providerio laukai išlieka atskiri',
        body: 'order_description gauna pilną užfiksuotą pirkimo kodą. website ir traffic_source yra atskiri API laukai; traffic_source nėra visas UTM objektas. Name, produkto vidinis Description, Public description ir banko Descriptor turi skirtingas paskirtis. SDK merchant_data yra merchant, signature ir paymentIntent wrapperis, ne vieta savavališkai metadata. Visiems produktams taikomas tik statinis kanalo / connector Descriptor; jokio dynamic_descriptor ar produkto suffix nesiunčiame. Faktinius endpointų laukus ir mokėjimo metodus agentas patikrina pagal naudojamą SDK bei API kontraktą.',
      },
    ],
    prompt: `Įgyvendink mokėjimų diegimo 04 žingsnį: main checkout, OTO ir pilną atribucijos rašymą.

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
${executionRules}`,
  },
  {
    id: '05',
    slug: 'sandbox-verification',
    title: 'Pilna sandbox patikra',
    description: 'Patikriname visą pirkimo istoriją nuo UI iki vidinės DB ir atskiriame simuliuotus testus nuo realaus providerio sandbox įrodymų.',
    inputs: [
      '01-provider-manifest.json, 02-commerce-contract.json ir visos 02–04 ataskaitos.',
      'Veikiantis vietinis appsas, izoliuota DB ir patikrinta backend / checkout versija.',
      'Realiems sandbox bandymams: aiškiai pasirinktas sandbox kanalas, jo serverio raktai, pasiekiamas webhook kelias ir leistina testų apimtis.',
      'Bet kokiam atskirai apmokestinamam veiksmui ar tikram nurašymui — išankstinis išlaidų leidimas ir maksimalus piniginis biudžetas.',
    ],
    outputs: [
      'docs/payments/setup/05-verification-report.md — scenarijų matrica, įrodymai, pataisytos klaidos ir likę blokavimai.',
      'Atsekamas main + OTO2 + one_time pirkimų, renewal, refund, cancellation ir atribucijos patikrų rezultatas.',
      'Atskiras sprendimas pagal aplinką: vietinė logika patikrinta / sandbox įrodyta / trūksta įrodymų. Production iš šio žingsnio savaime netampa patikrinta.',
    ],
    checks: [
      'Prie kiekvieno scenarijaus nurodyta aplinka, įrodymo tipas, laukta ir faktinė būsena bei sumos.',
      'Dublikatai, dvigubi paspaudimai ir pakartoti webhook nesukuria papildomų nurašymų ar finansinių judėjimų.',
      'Patikrinti abiejų prenumeratų atskiri renewal / cancellation ir OTO1 grant_only / aiškiai įjungtos lifetime taisyklės.',
      'UI → serverio katalogas → providerio request / response → DB financial events rodo tas pačias sumas ir valiutą.',
      'Visų main / OTO / PWA mokėjimų request neturi dynamic_descriptor; kanalo statinio descriptor ir renewal išrašo patikra turi savo įrodymą arba aiškią netikrinta būseną.',
      'Netestuotas tikras renewal, nepasiekiamas webhook ar nesukonfigūruotas mokėjimo metodas aiškiai pažymėti kaip spragos.',
    ],
    sections: [
      {
        title: 'Pirma vietinė patikra, tada realus sandbox',
        body: 'Agentas pirmiausia paleidžia tinkamus typecheck, lint, build, katalogo, DB ir integracijos testus. Realius sandbox veiksmus pradeda tik su aiškiai parinkta aplinka, kanalu, tik testui skirtais mokėjimo duomenimis ir pasiekiamu webhook keliu. Jei šių sąlygų nėra, užbaigia vietines patikras ir ataskaitoje nurodo konkrečius trūkstamus įrodymus. Tikrų kortelių ar mokamų operacijų nenaudoja be atskiro leidimo ir biudžeto.',
      },
      {
        title: 'Main ir kiekvienas OTO kelias',
        body: 'Matrica apima pasirinktus main trial variantus, OTO2 subscription, likusių one_time OTO priėmimą / praleidimą, 3DS, decline, timeout, refresh ir du vienalaikius tabus. Locale tikrinama po routing, taip pat pakeitus IP ar siunčiant neleistiną locale. Bent vienas sėkmingas main mokėjimas neįrodo visų kainų / metodų palaikymo; netestuotus derinius įvardijame. Nereikia realiai nurašyti visų derinių, kad vietiniais testais patikrintume jų mapping.',
      },
      {
        title: 'Renewal planuoklis ir webhook handler — atskiri įrodymai',
        body: 'Main bei OTO2 tikrinami paid / free trial, pirmas renewal, failed renewal ir vėlesnis sėkmingas bandymas, periodų datos ir konkretus subscription_id. Kontroliuojamai pakartotas fixture įrodo handler ir DB elgesį. Tikras providerio sandbox invoice / renewal įvykis įrodo tą bandytą providerio kelią. Jei įvykio dar laukiama arba paskyra nepalaiko pagreitinimo, įrašome laukimo / neatliktos patikros būseną; sistemos laiko pakeitimas nėra providerio billing testo pakaitalas.',
      },
      {
        title: 'Finansai sutikrinami nuo pradžios iki DB',
        body: 'Kiekvieno bandymo kainą lyginame tarp UI, serverio kontrakto, providerio mokėjimo ir DB. Auth + Settle turi vieną capture, refund — savo judėjimą, o event pakartojimas rezultato nekeičia. Tikriname dalinį / pilną refund ir dispute / reversal tiek, kiek scenarijų leidžia pasirinktas sandbox; likusius pažymime sintetiniais ar netikrintais. Pajamos, refund ir valiutos turi atsekamą šaltinį; informacijos spragų nepaslepiame bendru žaliu statusu.',
      },
      {
        title: 'Atribucija, saugumas ir galutinis perdavimas',
        body: 'Iš vidinės DB turi būti įmanoma atsekti sesiją, order, prenumeratą, kainos versiją, pirkimo locale, sumą, trial / renewal laiką ir pilną leidžiamą atribuciją. Patikriname trumpą UTM JSON, ilgo snapshot nuorodą, seną metadata ir nebuvusį UTM; nieko neišgalvojame. Svetimas order, token, 3DS return ar checkout email nesuteikia paskyros ir prieigos. Ataskaita pateikia įrodymų nuorodas be paslapčių ir asmens duomenų, pataisytas klaidas bei konkrečias likusias užduotis.',
      },
    ],
    prompt: `Atlik mokėjimų diegimo 05 žingsnį: pilną vietinę ir, kai sąlygos leidžia, realaus sandbox patikrą.

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
${executionRules}`,
  },
];

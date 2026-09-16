# 01. Produktų kūrimas naujam appsui

Forma ir pagal jos laukus generuojamas agento promptas: **`/documentation/setup`**. Vienas formos pildymas aprašo vieną prenumeratos pasiūlymą (`SUB`), jo trial, pratęsimo sąlygas ir kelių valiutų kainas. Visą 01 žingsnį sudaro visi pasirinkti main variantai ir vienas OTO2 prenumeratos produktas; formą pakartojame kiekvienam. Kiti OTO yra vienkartiniai ir aprašomi 02 žingsnyje, providerio produktų jiems čia nekuriame. Forma generuoja konfigūraciją bei instrukciją; Solidgate API nekviečia ir produktų nesukuria. Agentas instrukciją vykdo tiksliniame naujo appso projekte, naudodamas **Solidgate API v1 / Billing 1.0**.

## Ką reiškia formos laukai

| Laukas | Paskirtis | Pavyzdys |
| --- | --- | --- |
| `app_key` | Mūsų vidinis appso identifikatorius katalogo nuosavybei atskirti. Tai mūsų metadata susitarimas, ne privalomas standartinis Solidgate produkto laukas. | `carnivore` |
| `PRODNAME` | Brando / produkto šeimos dalis verslo kode. Ji gali būti bendra keliems trial pasiūlymams. | `CARNIVORE` arba `THEASTRL` |
| `offer_key` | Providerio produkto `catalog_key` mūsų mappinge. | `trial1` arba `addon_trial` |
| `product_slug` | Checkout pasiūlymas transakcijos metadata. Main atveju gali sutapti su offer_key; OTO2 esamame kode skiriasi. | `addon_trial → oto2_addon_weekly` |
| Prenumeratos vaidmuo ir prieigos šeima | Main variantai bendrina pagrindinę prieigą. OTO2 yra atskira prenumerata su atskira šeima. | `main → main`, `oto → addon` |
| `Name` | Solidgate produkto pavadinimas kataloge. Buvęs labelis „Klientui rodomas pavadinimas“ buvo netikslus: laukas savaime nekeičia appso kainodaros UI. | `TheAstrologist Monthly (trial1)` |
| `Public description` | Neprivalomas klientui skirtas produkto aprašymas, kurį Solidgate perduoda bankams ir naudoja klientų išrašuose bei Solidgate el. pašto kvituose. Jis atskiras nuo `Descriptor`. | `TheAstrologist Monthly (trial1)` |

Produkto vidiniam `Description` siūlome **`Name — PRODNAME_YYMMDD_SUB`**, pvz. `TheAstrologist Monthly (trial1) — THEASTRL_260523_SUB`. Konkretaus pirkimo `order_description` yra pilnas kodas su svetainės locale, pvz. `SK_CARNIVORE_260307_SUB`. Tai du skirtingi aprašymai. [Solidgate produkto laukai](https://docs.solidgate.com/billing/manage-products/products/)

`Descriptor`, pvz. `PMC/CARNIVORE`, yra atskiras banko išrašo identifikatorius. Visiems šio appso produktams naudojamas tik statinis kanalo / connector nustatymas: main, OTO, PWA, trial ir renewal. Mokėjimo užklausose `dynamic_descriptor`, produkto suffix ar kitas per-payment Descriptor override nesiunčiamas. `Public description` ir locale `order_description` lieka atskiri laukai. Formos „Statinis kanalo descriptor“ yra laukiamo kanalo nustatymo patikros nuoroda, ne produkto ar mokėjimo API parametras. [Solidgate Descriptor](https://docs.solidgate.com/payments/payments-insights/billing-descriptor/)

Papildomai nurodome katalogo versijos datą, aplinką, tikslinį kanalą, vieną numatytąją valiutą, trial tipą ir trukmę, billing periodą, kainas bei svetainės locale mappingą. **30 dienų nėra tas pats kaip vienas kalendorinis mėnuo.** Website URL, `funnel_code`, `funnel_variant` ir laukiamas statinis kanalo Descriptor yra patikros kontekstas. API paslapčių ir statinių UTM reikšmių į formą nededame.

## Vienas pasiūlymas → vienas produktas → kelių valiutų kainos

TheAstrologist pavyzdyje `trial1`, `trial2`, `trial3`, `trial4` ir `special_1eur` yra atskiri Solidgate produktai. Kiekvienas produktas turi savo EUR, USD, TWD, JPY ir kitų valiutų kainas. Tai modelis, kurį naudoja forma. Pavyzdžio kainos ir ID automatiškai netampa naujo appso katalogu.

- Vienas pasiūlymas konkrečioje katalogo versijoje kuria vieną providerio produktą, vieną default kainą ir reikiamas papildomas kainas. Skirtingi trial variantai gali turėti bendrą šeimos kodą `THEASTRL_260523_SUB`.
- Produkto nuosavybės / pakartotinio paleidimo tapatybė apima **app + environment + channel + offer + catalog version**. Vien šeimos kodo ar Name paieškos nepakanka. Skirtingas trial su tuo pačiu pasiūlymo ir versijos raktu reiškia konfliktą, o ne leidimą tyliai perrašyti sąlygas.
- SK ir LT gali naudoti vieną to paties produkto EUR kainos įrašą. Formos vienodos tos pačios valiutos kainos sujungiamos. Skirtingos EUR kainos atmetamos kaip konfliktas; joms reikia aiškaus atskiro pasiūlymo arba atskirai suprojektuotos regioninės kainodaros.
- Solidgate palaiko kainų šalių / regionų apribojimus, tačiau ši paprasta forma jų nekonfigūruoja. Negalima suklastoti `geo_country`, kad būtų parinkta norima valiuta.
- Papildomą valiutos kainą galima pridėti neturint atitinkamos svetainės locale. Nereikia išgalvoti `/kr/quiz` vien tam, kad produktas turėtų KRW kainą.
- Numatytoji valiuta pasirenkama vieną kartą visam produktui ir privalo turėti kainą. Ji nėra iš naujo nustatoma kiekvienam locale.

`provider_product_id` ir `provider_price_id` semantikas saugome atskirai. Produkto UUID ir jo default kainos UUID gali sutapti — vien tai nėra klaida. Dabartinis main checkout siunčia `product_id` kaip produkto UUID ir `product_price_id` kaip pasirinktos kainos UUID. Dabartinis OTO2 `/recurring` siunčia produkto ID ir valiutą, be amount ir be product_price_id; pasirinktos kainos ID tikrinamas viduje ir išlieka mappinge / metadata. Kitų endpointų laukus reikia tikrinti pagal jų sutartį; nėra universalios taisyklės „į product_id visada siųsti kainos ID“. [Solidgate kainų modelis](https://docs.solidgate.com/billing/manage-products/prices/)

## Pirkimo kodas ir svetainės locale

```text
Produkto šeimos kodas: {PRODNAME}_{YYMMDD}_SUB
THEASTRL_260523_SUB

Konkretaus pirkimo kodas: {LOCALE}_{PRODNAME}_{YYMMDD}_SUB
CZ_MEMREPL_260510_SUB
```

`PRODNAME` sudaro didžiosios lotyniškos raidės ir skaitmenys, be tarpų ar apatinių brūkšnių. Data fiksuota katalogo versijai ir nesikeičia kiekvieno pirkimo metu. `SUB` yra pažodinis prenumeratos tipas. Kode tarp dalių yra apatiniai brūkšniai; žvaigždučių nėra. Šie verslo kodai nėra providerio UUID ir neturi būti vieninteliai unikalumo / entitlement raktai.

| Galutinis svetainės URL | Vidinė locale | Kodo prefiksas | Valiuta | Pirkimo kodas |
| --- | --- | --- | --- | --- |
| `/cz/quiz` | `cs` | `CZ` | CZK | `CZ_MEMREPL_260510_SUB` |
| `/tw/quiz` | `zh-TW` | `TW` | TWD | `TW_MEMREPL_260510_SUB` |
| `/jp/quiz` | `ja` | `JP` | JPY | `JP_MEMREPL_260510_SUB` |
| `/lt/quiz` | `lt` | `LT` | EUR | `LT_MEMREPL_260510_SUB` |
| `/quiz`, kai galutinis puslapis EN | `en` | `EN` | USD | `EN_MEMREPL_260510_SUB` |

Šio repo `packages/i18n/src/routing.ts` susieja `/cz → cs`, `/tw → zh-TW`, `/jp → ja`, `/dk → da`, `/gr → el`, `/il → he`. Anglų locale dėl `as-needed` gali neturėti prefikso. Pradinė `/quiz` užklausa dar gali būti nukreipta į kitą locale: pirkimui imama **galutinio atvaizduoto puslapio locale po routing / redirect**. Naujo appso agentas patikrina tikrą routing konfigūraciją.

Klientas `/cz/quiz` gauna CZ kodą ir tam pasiūlymui priskirtą CZK kainą net būdamas Lietuvoje. IP, kortelės šalis, naršyklės kalba ir billing adresas nekeičia jau pasirinktos svetainės locale. Tikri šalies duomenys providerio rizikai ar mokesčiams perduodami atskirai.

Serveris priima tik leidžiamą locale ir pasiūlymą, o kodą, kainą ir providerio ID parenka pats. Nežinomas prefiksas netampa numanoma EN kaina. Pradėjus pirkimą, locale, valiuta, kodas ir pasirinktos kainos versija užfiksuojami. Retry jų nekeičia; renewal paveldi pradinės prenumeratos kontekstą, nes webhook neturi naršomo puslapio URL. Kiekvienam naujam main, OTO ar PWA pirkimui galioja aiškiai perduodama ir serveryje tikrinama svetainės locale.

Pagrindinės prieigos raktas stabilus tarp main locale, katalogo versijų ir intro variantų: kalbos ar trial pasirinkimo pakeitimas nesuteikia antro intro ir netyčia nesukuria antros pagrindinės prenumeratos. Jau lokalizuoto kodo antrą kartą prefiksuoti negalima, įskaitant OTO kilmės `o:` dalį. Kilmės kodas išlaiko kilmės pirkimo locale. OTO2 turi kitą stabilią prieigos šeimą ir savo subscription_id, trial teisę, renewal bei atšaukimo būsenas; jo negalima sutapatinti su main.

## Sumos: TWD turi du skaitmenis po kablelio

Formoje įvedame žmogui rodomą sumą, API siunčiame sveiką skaičių mažiausiais valiutos vienetais (`minor units`).

| Valiuta | Tikslumas | Trial → API vienetai | Renewal → API vienetai |
| --- | --- | --- | --- |
| EUR | 2 | 5.00 → `500` | 59.00 → `5900` |
| TWD | 2 | 185.00 → `18500` | 2182.00 → `218200` |
| JPY | 0 | 926 → `926` | 10932 → `10932` |
| KRW | 0 | 7900 → `7900` | 92900 → `92900` |

Lentelėje pateiktos vartotojo TheAstrologist pavyzdžio kainos. Visas formos palaikomas rinkinys: **EUR, USD, CZK, HUF, RON, TWD, ILS, PLN, DKK, HKD, NOK, SEK, TRY, UAH ir RSD — 2 skaitmenys; JPY ir KRW — 0.** TWD rodymas kaip „NT$185“ nekeičia API vienetų. JPY ir KRW iš 100 nedauginamos. [Solidgate valiutos](https://docs.solidgate.com/payments/payments-insights/supported-currencies/)

Įjungus PayPal patikrą, **HUF, TWD ir RSD** kainos šiame rinkinyje turi būti sveiki pagrindiniai vienetai, nors API vis tiek siunčiame du nulius, pvz. `185 TWD → 18500`. `185.50 TWD` atmetama, ne apvalinama. Tai sumos tikslumo patikra, o ne garantija, kad pasirinktas kanalas / PayPal paskyra palaiko visas valiutas. [Solidgate PayPal taisyklės](https://docs.solidgate.com/payments/alternative-payments/apms-overview/paypal/)

Konvertuojame vieną kartą, analizuodami dešimtainį tekstą ir naudodami sveikųjų skaičių aritmetiką. Tylus apvalinimas, formato naudojimas vietoje valiutos exponent ir pakartotinis `amount_minor` dauginimas netinka. Atskirai laikome `initial_payment_minor`, `intro_minor` ir `renewal_minor`. Be trial pradinis mokėjimas lygus renewal, nemokamo trial intro yra nulis. Finansinėje apskaitoje **Auth 5 EUR ir to paties mokėjimo Settle 5 EUR reiškia vieną 5 EUR mokėjimą**, ne 10 EUR pajamas.

## Produkto metadata ir pirkimo metadata

Bendro produkto metadata naudojama katalogo nuosavybei, pvz. `app_key`, `catalog_key` (pasiūlymo raktas), `base_product_code`, `catalog_version`. Vieno produkto metadata neturi vienos `website_locale`, `session_id` ar pirkėjo UTM: tas pats produktas naudojamas kelioms locale ir daugeliui pirkimų. Konkrečių produkto metadata laukų palaikymą patikriname tiksliniame Billing endpoint'e, o pilną manifestą saugome vidiniame kataloge.

Katalogo prenumeratos transakcijos šeši pagrindiniai metadata laukai atitinka pateiktą Hub pavyzdį. Vienkartiniams OTO, apmokamiems tiesiog pagal sumą, providerio produkto ar kainos UUID gali nebūti: jų neišgalvojame, neprieinamus laukus praleidžiame.

```json
{
  "funnel_code": "funnel_carnivore_v1",
  "funnel_variant": "main",
  "price_id": "<selected_price_id>",
  "product_code": "SK_CARNIVORE_260307_SUB",
  "product_slug": "carni_plan_1_week",
  "session_id": "<session_id>",
  "utm": "{\"utm_source\":\"facebook\",\"utm_medium\":\"paid_social\",\"utm_campaign\":\"launch\",\"utm_content\":\"video_01\",\"utm_term\":\"broad\"}"
}
```

UTM reikšmės čia iliustracinės. Tikri duomenys surenkami iš apsilankymo, ne įrašomi kuriant produktą. Jei jų nėra, jų neišgalvojame.

Payment Form v1 `order_metadata` leidžia **iki 10 porų, iki 380 simbolių kiekviename lauke**. Šeši pagrindiniai laukai ir penki atskiri UTM sudarytų 11. Sutartas būsimo checkout formatas: šeši laukai ir vienas `utm` su serializuotu JSON tekstu — iš viso 7. API siunčiamos tekstinės reikšmės, ne įdėtas objektas. Patikriname visų laukų skaičių bei ilgį. Jeigu serializuotas UTM viršija 380 simbolių, pilną atribuciją saugome DB, o vietoje `utm` siunčiame trumpą `attribution_id`, kuris nurodo tą išsaugotą įrašą. JSON nekarpome, atribucijos neprarandame ir vien dėl per ilgų rinkodaros laukų mokėjimo neblokuojame. [Payment Form metadata kontraktas](https://docs.solidgate.com/payments/integrate/payment-form/create-your-payment-form/)

`traffic_source` yra atskiras vieno šaltinio API laukas, pvz. `facebook` arba `direct`. `website` yra svetainės URL. Tai nėra visi UTM. `merchant_data` SDK wrapperis turi `merchant`, `signature` ir pasirašytą `paymentIntent`; laisvos metadata į jį nededame. `order_metadata` priklauso serverio ruošiamam payment intent.

Pilna first-touch ir last-touch atribucija turi būti išsaugota vidinėje DB, susieta su sesija, order ir prenumerata. `attribution_id` siunčiame tik po sėkmingo jo nurodomo snapshot išsaugojimo. DB išlaikome kanoninius plokščius `utm_*` laukus ir pilną snapshot; grant, webhook bei renewal skaitytojams pridedame naujo `utm` JSON iškodavimą / `attribution_id` rezoliuciją, palaikydami ir seną plokščią providerio metadata. Vien išsiunčiamo formato pakeitimas neužtikrina teisingos atribucijos.

Retry naudoja užfiksuotą pirkimo snapshot, renewal išlaiko pirminio pirkimo atribucijos ryšį; naujo apsilankymo UTM neperrašo istorinio acquisition. Webhook sumas ir įvykius registruojame pagal providerio mokėjimų įrodymus, ne pagal naršyklės atsiųstą kainą.

## Ką turi atlikti pirmo žingsnio agentas

1. Perskaityti tikslinio appso routing, kainodarą, katalogą, DB kainų patikras ir entitlement mappingą. `theastrologist` naudoti kaip struktūros nuorodą; jo kanalų, produktų ID ir kainų automatiškai nekopijuoti.
2. Paruošti vieno pasiūlymo produkto planą, jo default ir papildomas valiutų kainas bei atskirą locale → pirkimo kodas → kaina mappingą. Parodyti trial, billing periodą, pradinę ir renewal sumas žmogaus bei API vienetais. Nežinomų komercinių sąlygų neišgalvoti.
3. Patikrinti aplinką, kanalą, appso nuosavybę ir visus produktų / kainų puslapius. Pakartotinis paleidimas turi tęsti tą patį manifestą. Svetimų produktų nenaudoti ir nearchyvuoti; konfliktą parodyti. Dalinio vykdymo ID išsaugoti iš karto, kad tęsinys nekurtų dublikatų.
4. Paruošti konkretų kūrimo planą. Jei sesijoje jau pavesta sukurti šiuos produktus tame kanale, vykdyti suteikto leidimo ribose; trūkstamą kanalą ar apimtį išsiaiškinti prieš rašant. Sukurti vieną produktą, jo numatytąją kainą ir trūkstamas papildomas valiutų kainas. Tai kelių API užklausų seka, ne viena atominė transakcija.
5. Perskaityti rezultatą ir sutikrinti visą konfigūraciją: nuosavybę, Name, Description, Public description, metadata, būseną, trial tipą / trukmę / kainas, billing periodą, Auth-Settle / settle interval / retry, default valiutą ir visas kainas bei ID. Vien kainų kiekio patikros nepakanka.
6. Išsaugoti produkto ir kainų ID versijuotame vidiniame manifeste, atskirai nuo locale pirkimo mappingo. Išlaikyti istorinius ID. Prieš checkout sutikrinti UI, serverio katalogą, DB kainų patikras, `ENABLED_CHECKOUT_LOCALES` ir providerio kainas. Ataskaitoje atskirti: paruošta / sukurta / perskaityta ir patikrinta / dar nesujungta su checkout.

Produktus ir kainas galima paruošti vieno agento vykdymo metu arba papildyti vėliau. Kiekvienu atveju aiškiai fiksuojama katalogo versija ir perskaitomas rezultatas. Dalinai sukurto katalogo negalima paskelbti pilnai paruoštu checkout. [Produktų kūrimas](https://docs.solidgate.com/billing/manage-products/products/), [kainų valdymas](https://docs.solidgate.com/billing/manage-products/prices/)

## Perdavimo failas kitam žingsniui

Agentas išsaugo **`docs/payments/setup/01-provider-manifest.json`** tiksliniame appso repo. Tai providerio rezultatų manifestas; formos atsisiųstas setup JSON yra įvestis ir jo nepakeičia.

Manifestas turi `schema_version: 1`, `app_key`, `environment`, `channel_reference`, patikrintą `verified_channel_id`, visą `required_offers` sąrašą ir `offers` įrašus. Į required_offers įrašomi visi pasirinkti main variantai ir tiksliai vienas OTO2 produktas su konkrečia kiekvieno catalog_version. 02 agentas renkasi tik nurodytą katalogo versiją, ne latest ar pirmą istorinį įrašą. Kiekvienam pasiūlymui saugomi `offer_key`, `role`, `oto_step`, `runtime_product_slug`, `entitlement_key`, katalogo versija, bazinis kodas, visa produkto / trial konfigūracija, tikras `product_id`, valiutų `price_id`, sumos minor vienetais ir locale mappingas.

Kiekvienas įrašas turi atskirą `verification_status: planned | created | verified` ir `verified_at`. Providerio active status nereiškia verified. Neegzistuojantys ID yra `null`. Po sėkmingo API atsakymo ID išsaugomi iškart, o verified pažymima tik perskaičius visas produkto / kainų reikšmes. Kitas pasiūlymo paleidimas **papildo tą patį manifestą**, neperrašo kitų variantų, versijų ar kanalo istorijos. Kitai aplinkai / kanalui naudojamas atskiras artefaktų rinkinys.

**01 paruoštas vykdymui toliau**, kai visi required_offers produktai ir jų kainos patikrinti tinkamame kanale. Vienas patikrintas produktas dar neužbaigia viso 01. Jei sukūrimas neatliktas, planned manifestas leidžia tęsti vietinį planavimą, bet ne skelbti mokėjimų parengties.

Tolesnė seka: [02 katalogo ir OTO sutartis](02-catalog-integration.lt.md) → [03 DB, webhook ir atribucijos skaitytojai](03-database-webhooks.lt.md) → [04 checkout, OTO ir atribucijos rašymas](04-checkout-oto.lt.md) → [05 sandbox patikra](05-sandbox-verification.lt.md). 01 patikros apima katalogą ir manifestą; DB, UTM ir pinigų registravimo veikimą įrodo vėlesni žingsniai.

## Kas dar nėra padaryta runtime

Šis dokumentacijos žingsnis nekeičia checkout, webhook ar senų order įrašų. Dabartinis providerio katalogas jau bendras kelioms locale; naujoji forma nebereikalauja perkurti jo į produktą kiekvienai locale.

Dabartinis main checkout siunčia 5 fiksuotus `order_metadata` laukus ir iki 5 atskirų UTM; pilno `product_code` tame objekte nėra. Pilnas first-touch / last-touch snapshot lieka browser saugykloje, o DB išsaugomi tik pasirinkti tracking duomenys. **Pilnas serverio snapshot, šeši baziniai metadata laukai ir sutartas UTM formatas yra būsimo checkout žingsnio užduotis.** Negalima teigti, kad vien sugeneravus šį promptą visa atribucija jau prieinama iš DB.

Esamo `scripts/solidgate-seed-catalog.ts --apply` negalima aklai paleisti kaip universalaus diegimo: jis renkasi visą demonstracinį katalogą, produktus atpažįsta per siaurai, o periodui nesutapus gali archyvuoti esamą įrašą. Prieš providerio veiksmus agentas turi patikrinti ir pataisyti šias vietas. Ši forma vykdomo skripto nekeičia ir nepaleidžia.

Mokami išorinių API veiksmai ir tikri bandomieji nurašymai reikalauja atskiro aiškaus išlaidų leidimo ir maksimalaus piniginio biudžeto. Formos pildymas, pavyzdžio įkėlimas, kopijavimas ir vietinė patikra tokių veiksmų neatlieka.

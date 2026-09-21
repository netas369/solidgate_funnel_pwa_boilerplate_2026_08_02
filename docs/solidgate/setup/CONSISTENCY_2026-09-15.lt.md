# 01–05 instrukcijų nuoseklumo patikra — 2026-09-15

Patikrinta vietinė `/documentation/setup` dokumentacija, jos formos, generuojami agentų promptai ir Markdown instrukcijos. Penki žingsniai suderinti į vieną nuoseklią vykdymo seką. Ši ataskaita patvirtina dokumentacijos veikimą ir sutarties nuoseklumą; ji nėra būsimo appso mokėjimų ar realaus Solidgate sandbox bandymų ataskaita.

## Žingsnių perdavimas

| Žingsnis | Ką gauna | Ką perduoda |
| --- | --- | --- |
| 01 — Produktai | App, aplinka, kanalas, pasirinkti main variantai ir OTO2, aiškios kainos ir locale | Kaupiamą `01-provider-manifest.json` su kiekvieno pasiūlymo vaidmeniu, konkrečia versija, tikrais arba dar negautais ID ir atskira patikros būsena |
| 02 — Katalogas ir OTO | Pasirinktos versijos patikrintą manifestą, visą main / OTO planą ir vienkartinių kainų šaltinius | `02-commerce-contract.json`, `02-catalog-report.md`, vietinį katalogą ir paruoštus suderintus SQL pakeitimus |
| 03 — DB ir webhook | Manifestą, 02 sutartį ir katalogo ataskaitą | `03-backend-report.md`, patikrintą DB / webhook / worker logiką ir atribucijos skaitytojus |
| 04 — Checkout ir OTO | Bendrą sutartį ir 02–03 ataskaitas | `04-checkout-report.md`, prijungtą checkout / OTO ir atribucijos rašymą |
| 05 — Patikra | Manifestą, bendrą sutartį ir visas 02–04 ataskaitas | `05-verification-report.md`, atskiriančią vietinius, sintetinius, realaus sandbox ir neatliktus bandymus |

Artefaktai pagal nutylėjimą laikomi tikslinio repo `docs/payments/setup/`. Pasirinktas kitas manifesto kelias yra autoritetingas. Skirtingų aplinkų ir kanalų įrodymai laikomi atskirai. Pakitus bendrai sutarčiai, priklausomi žingsniai peržiūrimi iš naujo.

## Peržiūros metu suderintos vietos

| Vieta | Galutinė taisyklė |
| --- | --- |
| 01 apimtis | Forma vykdoma kiekvienam pasirinktam main variantui ir vienam OTO2. Vykdymai papildo bendrą manifestą ir išsaugo istoriją; vieno produkto sukūrimas neužbaigia viso katalogo. |
| Produkto raktai | Providerio `catalog_key` / `offer_key` ir checkout `runtime_product_slug` atskirti. `addon_trial → oto2_addon_weekly` yra aiškus mapping. |
| Banko išrašo descriptor | Visuose penkiuose promptuose galioja `static_channel_connector_only`: main, visi OTO, PWA, trial ir renewal naudoja statinį kanalo / connector nustatymą. Produkto suffix nesiunčiamas; locale kodai ir `order_description` išlieka atskiri. |
| OTO tipai | Tarp OTO tik OTO2 yra subscription. OTO1 ir OTO3–7 yra one_time; OTO3 variantai yra alternatyvūs pasirinkimai, OTO8 — santrauka. `_SUB` galūnė nenustato mokėjimo tipo. |
| Prenumeratų prieiga | Main variantai bendrina stabilią pagrindinę prieigą. OTO2 turi atskirą prieigą, subscription_id, trial / renewal ir atšaukimą. |
| Katalogo versija | Pasirenkama konkreti `catalog_version`; latest ar pirmo tinkamo įrašo fallback neleidžiamas. Istoriniai order ir renewal išlaiko savo versiją. |
| Manifesto kelias | Pakeistas kelias perduodamas visiems promptams. Su ankstesniu manifestu susietos numatytos subscription kainų nuorodos atnaujinamos, individualios nuorodos išsaugomos. |
| Locale ir sumos | Pirkimo locale paimama iš galutinio svetainės maršruto ir užfiksuojama kartu su pasiūlymu. Kainos aiškiai nurodomos valiutų mažiausiais vienetais; TWD ir JPY / KRW skirtumai išlaikomi. |
| OTO1 lifetime | Numatyta `grant_only`. `cancel_main_after_capture` leidžiama tik aiškiai pasirinktam lifetime scenarijui: pirmiausia capture ir patikimai išsaugota to savininko lifetime prieiga, tada saugiai kartojamas main atšaukimas. |
| Prieigos politika | Atšaukimo laikas, failed renewal grace ir refund / dispute prieigos taisyklės apibrėžiamos 02 sutartyje. Nežinomų verslo sprendimų agentas neišgalvoja. |
| 3DS ir retry | Pasenę bei svetimi grįžimai atmetami. Teisėtas pakartotinis to paties 3DS patvirtinimas suderinamas su tuo pačiu order, nesukuriant naujo nurašymo. |
| UTM seka | 03 paruošia seno formato, naujo JSON ir snapshot nuorodos skaitytojus; 04 prijungia rašymą. Pilna leidžiama atribucija išsaugoma DB prieš siunčiant jos nuorodą. |
| Finansiniai įrodymai | Auth + Settle nedvigubina capture. Sintetinis renewal tikrina handler / DB, o realus providerio įvykis — atskirą sandbox kelią; rezultatai nesuplakami. |

## Atliktos vietinės patikros

- 140 testų praėjo dviejuose setup modelių testų failuose: produktų / valiutų taisyklės, manifesto perdavimas, OTO apribojimai, artefaktų seka ir pasirinktas manifesto kelias.
- TypeScript patikra ir tikslinis dokumentacijos ESLint praėjo.
- Funnel production build praėjo; jame yra 01 puslapis ir visi keturi statiniai 02–05 adresai. Build vykdytas vietoje.
- `npm run docs:setup:check` patvirtino keturių generuojamų Markdown instrukcijų ir bendro appso promptų šaltinio atitikimą bei navigacijos URL.
- Naršyklėje patikrinti visi penki žingsniai, aktyvi navigacija, paieška, bendro plano išsaugojimas ir atkūrimas, kopijavimas, prompto bei JSON atsisiuntimas.
- Patikrintas papildomas main variantas, alternatyvus OTO3 pasirinkimas ir netinkamo antro subscription OTO blokavimas. 01 OTO2 forma generuoja atskirą vaidmenį, runtime slug ir prieigos raktą.
- Desktop ir 390 px mobile vaizduose nėra viso puslapio horizontalaus perpildymo; plati lentelė slenkama savo konteineryje. Po švaraus perkrovimo React klaidų neužfiksuota.
- `git diff --check` praėjo.

## Patikros ribos

Formų validacija patikrina įvesties struktūrą ir plano taisykles. Ji nepatvirtina, kad įvestas repo failas egzistuoja, ID priklauso pasirinktam kanalui ar providerio produktas jau sukurtas. Šias prielaidas kiekvienas vykdymo promptas įpareigoja patikrinti tiksliniame projekte.

Šio dokumentacijos atnaujinimo metu neatlikti nuotoliniai DB pakeitimai, produktų kūrimas, realūs mokėjimai ar production deploy. Būsimo appso faktinė integracija ir jos finansiniai rezultatai tikrinami vykdant šiuos žingsnius; jų įrodymai turi atsirasti atskirose 02–05 vykdymo ataskaitose.

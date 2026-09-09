# Solidgate checkout, kortelių ir užduočių lentelių auditas

[Architektūros vertinimas ir naujo boilerplate rekomendacijos](boilerplate-architecture-audit.lt.md).

Audito apimtis: 7 lentelės, pagal visas repozitorijos migracijas iki `20260908110000_wave2_currency_amounts.sql` ir dabartinius TS/Edge Function vartotojus. Nuotolinė DB netikrinta, todėl čia aprašoma repozitorijoje deklaruota schema, o ne patvirtinta produkcinės DB būsena. Aplikacijos kodas ir migracijos nekeisti. `NN` = `NOT NULL`; `NULL` = galima tuščia reikšmė; `—` = deklaruoto default nėra. UUID laukai nėra Solidgate ID, jei aiškiai nenurodyta kitaip. Sumos yra mažiausiais valiutos vienetais, nors kodo pavadinimai baigiasi `_cents`.

## Pagrindiniai sprendimai naujam boilerplate

| Lentelė | Dabartinė paskirtis | Rekomendacija |
|---|---|---|
| `solidgate_main_checkout_states` | Vienas aktyvus pagrindinio funnel checkout ir jau pasirašyta forma vienai sesijai / produktui | Palikti funkciją, generalizuoti produkto ir pasiūlymų apribojimus. Paprastame projekte gali būti bendros `checkout_attempts` dalis. |
| `solidgate_pwa_purchase_states` | Prisijungusio vartotojo išsaugotos kortelės / hosted-form pirkimo rezervacija, lease ir tikslus paskutinis rezultatas | Reikalinga, jeigu yra tokie PWA/member-area pirkimai. Galima turėti bendrą checkout variklį, išlaikant atskirą kliento tipą ir unikalumą. |
| `solidgate_intro_claims` | Vienas įvadinis pagrindinis planas vienam normalizuotam el. paštui, nepriklausomai nuo sesijų ir kainos pakopų | Verslo taisyklių priedas, ne Solidgate branduolio reikalavimas. `lease_expires_at` ir jo indeksas yra supaprastinimo kandidatai. |
| `solidgate_session_vault` | Anoniminio funnel kortelės tokenas ir jo patikrinta kilmė | Palikti, jeigu checkout vyksta prieš paskyros sukūrimą ir yra vieno paspaudimo OTO. Nekelti tokenų į viešai rašomą `sessions`. |
| `solidgate_account_vault` | Dabartinė paskyros kortelė, jos kilmė ir monotoninė versija | Reikalinga saved-card pirkimams / billing. Dabartines 2 vault saugu palikti. Vieną vault svarstyti tik įvedus aiškią bendrą billing-customer tapatybę ir išlaikius prieigos ribas. |
| `solidgate_card_update_attempts` | Atskiras 0-amount kortelės pakeitimo procesas, kuris pats nėra produkto pirkimas | Pasirenkamas billing priedas, kai klientas gali keisti kortelę. |
| `solidgate_subscription_token_sync_jobs` | Patikimas naujos kortelės priskyrimas jau veikiančioms Solidgate prenumeratoms | Reikalinga, jei kortelės pakeitimas turi pakeisti ir jau esančių prenumeratų mokėjimo priemonę. Eilės / retry mechanizmo neišmesti. |

Svarbiausia: tai nėra 7 dubliuojančios finansinių operacijų lentelės. Dvi saugo checkout koordinavimą, viena verslo pasiūlymo teisę, dvi saugo dabartinę mokėjimo priemonę, viena kortelės pakeitimo eigą, viena darbų eilę. `orders` lieka atskiras mokėjimo / užsakymo įrašas.

## 1. `solidgate_main_checkout_states`

Viena eilutė = dabartinis pagrindinio checkout bandymas konkrečioje aplinkoje, sesijoje ir kanoniniam produktui. Tai koordinavimo būsena, ne visa bandymų istorija: pakeitus patikimai užbaigtą nesėkmingą bandymą, `order_db_id` persijungia į naują `orders` eilutę. Paraleliniai langai naudoja tą patį order ID ir tą patį `merchant_data`, kol leidžiama kurti naują bandymą.

Schema: `supabase/migrations/20260721091117_solidgate_main_checkout_atomic_open.sql:12`. Dabartinis atidarymas: `supabase/migrations/20260907120000_wave2_locales.sql:208`; kritinė blokavimo ir reuse dalis `:286`. Formos užbaigimas: `supabase/migrations/20260721091117_solidgate_main_checkout_atomic_open.sql:587`, v2 wrapper `supabase/migrations/20260721124000_solidgate_payment_identity.sql`.

| Stulpelis | Tipas / NULL / default | Kur, kam ir kaip naudojamas |
|---|---|---|
| `payment_environment` | `text NN`, —; `production` / `sandbox` | PK dalis ir kiekvieno RPC filtro dalis. Atskira checkout tapatybė testinei ir realiai aplinkai. |
| `session_id` | `uuid NN`, —; FK `sessions.id ON DELETE CASCADE` | Anoniminio pirkėjo funnel sesija; PK dalis ir transaction advisory-lock raktas. |
| `product_slug` | `text NN`, —; CHECK tik `THEASTRL_260523_SUB` | Kanoninis perkamas produktas, PK dalis. Ne kainos pasiūlymas. Dabartinis apribojimas pririštas prie šio projekto. |
| `offer_slug` | `text NN`, —; `trial1`, `trial2`, `trial3`, `trial4`, `special_1eur`, `special_free` | Konkreti kainos / trial pakopa. Atidarymo RPC tikrina, kad tęsiant tą patį mokamą bandymą pasiūlymas nepasikeitė. |
| `order_db_id` | `uuid NN`, —; FK `orders.id ON DELETE CASCADE`; UNIQUE | Nurodo konkretaus bandymo finansinį užsakymą. Per jį tikrinama pirminė suma, valiuta, PSP ID, email, locale ir būsena. |
| `builder_token` | `uuid NN`, — | Formą kuriančio serverio iškvietimo nuosavybės žetonas. Tik jį turintis iškvietimas gali užbaigti formą; kitas po lease gali perimti darbą. Tai ne mokėjimo kortelės tokenas. |
| `build_started_at` | `timestamptz NN`, `now()` | Nebaigtos formos kūrimo lease pradžia. Dabartinis RPC po 30 s leidžia perimti kūrimą, jei `merchant_data` dar nėra. |
| `merchant_data` | `jsonb NULL`, —; jei yra, JSON object | Jau paruoštas Solidgate Payment Form rinkinys (`merchant`, `paymentIntent`, `signature`). Išsaugomas vieną kartą ir grąžinamas kartotiniams/paraleliniams requestams. |
| `created_at` | `timestamptz NN`, `now()` | Šios koordinavimo eilutės sukūrimo laikas; gali būti senesnis už dabartinio užsakymo sukūrimą, nes eilutė pakartotinai naudojama. |
| `updated_at` | `timestamptz NN`, `now()` | RPC rankiniu būdu atnaujina po state/payload pakeitimų. Auditas, ne provider event ordering. |

PK `(payment_environment, session_id, product_slug)` ir `UNIQUE(order_db_id)` saugo tapatybę. RLS įjungta; `PUBLIC`, `anon`, `authenticated` teisės atšauktos, `service_role` turi DML. App naudoja RPC: `apps/funnel/src/app/api/solidgate/create-session/route.ts:620` atidaro, `:745` užbaigia v2 formą. **Išlaikyti lock + builder token + lease + immutable order binding.** Mažinant lentelių skaičių šių garantijų neprarasti.

## 2. `solidgate_pwa_purchase_states`

Viena eilutė = konkretaus vartotojo / produkto dabartinis member-area pirkimo bandymas. Skirtingai nuo pagrindinio funnel, čia reikia ir išsaugotos kortelės iškvietimo, ir hosted formos, ir nežinomo provider rezultato sutikrinimo. Dėl to laukai platesni.

Schema: `supabase/migrations/20260721105632_solidgate_pwa_purchase_atomic_open.sql:30`; dabartinis atidarymas `supabase/migrations/20260907120000_wave2_locales.sql:520`. Reuse/perėjimas prie naujo bandymo: `supabase/migrations/20260721105632_solidgate_pwa_purchase_atomic_open.sql:699`. Rezultato įrašymas `:1189`, patvirtintas capture `supabase/migrations/20260721125000_solidgate_card_update_state.sql:1351`.

| Stulpelis | Tipas / NULL / default | Kur, kam ir kaip naudojamas |
|---|---|---|
| `payment_environment` | `text NN`, —; `production` / `sandbox` | PK ir visų užklausų apimtis. |
| `user_id` | `uuid NN`, —; FK `auth.users.id ON DELETE CASCADE` | Prisijungęs pirkėjas, PK dalis. Reikia serverio auth, tai nėra klientui laisvai pasirenkamas user ID. |
| `product_slug` | `text NN`, — | Kanoninis produktas, PK dalis. Vienu metu tam pačiam vartotojui ir produktui koordinuojamas vienas bandymas. |
| `offer_slug` | `text NN`, — | Kainos pasiūlymas / PWA produkto slug; RPC tikrina atitikimą kanoniniam produktui. Lentelės lygyje ne hardcoded CHECK, bet SQL funkcijose projektinis katalogas yra. |
| `order_db_id` | `uuid NN`, —; FK `orders.id ON DELETE CASCADE`; UNIQUE | Dabartinio pirkimo order. Jei patikimai leidžiama bandyti iš naujo, šis pointer pakeičiamas, o `last_result_*` išvalomi. |
| `purchase_mode` | `text NN`, —; `saved_card` / `hosted_form` | Nusako kelią: recurring/token API ar mokėjimo forma. Vault papildomas tik iš hosted-form pirkimo, kad senas saved-card charge nebūtų palaikytas naujai pasirinkta kortele. |
| `claim_token` | `uuid NN`, — | Dabartinio / paskutinio veiksmą vykdančio serverio requesto nuosavybės tokenas. Atmeta pavėluotus rezultatus iš kito workerio. Gali likti ir pasibaigus aktyviai lease. |
| `claim_kind` | `text NULL`, —; `build_form`, `submit_card`, `reconcile` | Kokį veiksmą šiuo metu turi teisę atlikti claim savininkas. NULL = aktyvios claim operacijos nėra. `reconcile` reiškia patikrinti jau turimą order, o ne kurti naują charge. |
| `claim_started_at` | `timestamptz NULL`, — | Lease pradžia. CHECK reikalauja, kad būtų NULL tik kartu su `claim_kind`. Leidžia atsigauti po nutrūkusio requesto. |
| `merchant_data` | `jsonb NULL`, —; JSON object | Hosted formos pasirašytas payload; kartotiniams requestams reuse. Saved-card keliui gali nebūti. |
| `last_result_kind` | `text NULL`, —; `pending`, `requires_action`, `captured`, `terminal_failure` | Paskutinio tiksliai šiam bandymui užfiksuoto serverinio rezultato klasė. Naudojama replay ir sprendimui, ar reikia 3DS / ar rezultatas galutinis. |
| `last_result_net_amount_cents` | `integer NULL`, —; >= 0 | Paskutinio rezultato patvirtinta net suma. Tikrinama `captured` prieš nekintamą užsakymo gross; terminal failure privalo reikšti 0. Tai nėra papildoma nepriklausoma apskaitos suma. |
| `last_result_subscription_id` | `text NULL`, — | To paties rezultato Solidgate subscription ID. Replay metu tikrinamas tikslus sutapimas, neleidžiant to paties claim perrašyti kitu subscription. |
| `last_result_verify_url` | `text NULL`, — | To paties rezultato 3DS URL. Saugo challenge tęsimą ir tikslaus replay palyginimą. Capture kelyje nulininamas. |
| `created_at` | `timestamptz NN`, `now()` | Koordinavimo eilutės sukūrimas, ne kiekvieno bandymo pradžia. |
| `updated_at` | `timestamptz NN`, `now()` | Atnaujinama RPC keičiant lease, payload ar rezultatą. |

PK `(payment_environment, user_id, product_slug)`, `UNIQUE(order_db_id)`, paired-NULL lease CHECK ir JSON shape CHECK. RLS, klientų teisių revoke, service-role DML kaip main state. App atidarymas `apps/pwa/src/app/api/solidgate/purchase/route.ts:841`; paskutinės sumos tikrinimas `:303`, `:396`. Webhook publikuoja capture prieš vault: `supabase/functions/solidgate-webhooks/index.ts:2788`. **`last_result_*` nėra nenaudojamas dubliavimas**: DB iš jų atpažįsta to paties atsakymo replay (`20260721105632...:1356` ir `20260721125000...:1480`).

## 3. `solidgate_intro_claims`

Viena eilutė = vieno normalizuoto el. pašto teisė į įvadinį pagrindinį pasiūlymą konkrečioje aplinkoje. Reikalinga šio projekto taisyklei „vienas intro per pirkėją“, nes atskiros sesijos ir intro pakopos gali naudoti atskirus Solidgate customer/product ID.

Schema: `supabase/migrations/20260716213000_solidgate_intro_offer_claims.sql:10`; papildomas masyvas ir indeksai `supabase/migrations/20260720200000_solidgate_intro_claim_recovery.sql:27`. **Dabartinė** claim politika yra `supabase/migrations/20260728090000_solidgate_intro_claim_immediate_retry.sql:23`, ne pirminė 60 min versija. Consume funkcija `supabase/migrations/20260720200000_solidgate_intro_claim_recovery.sql:170`.

| Stulpelis | Tipas / NULL / default | Kur, kam ir kaip naudojamas |
|---|---|---|
| `payment_environment` | `text NN`, —; `production` / `sandbox` | PK dalis. Sandbox bandymas nesunaudoja produkcinio intro. |
| `email_hash` | `text NN`, —; 64 mažosios hex raidės/skaitmenys | PK dalis. `introOfferEmailHash()` skaičiuoja SHA-256 nuo `trim().toLowerCase()` email. Ta pati normalizuota reikšmė sujungia skirtingas sesijas. Tai pseudoniminis lookup, ne stipri email anonimizacija. |
| `session_id` | `uuid NULL`, —; FK `sessions.id ON DELETE SET NULL` | Dabartinio/pamokėjusio claim sesija; used siejant bandymą ir ieškant jos užsakymų. Ištrynus sesiją claim lieka. Pirminis komentaras apie niekada nepernaudojamą anonimizuotą claim nėra absoliučiai teisingas naujajai pending takeover logikai. |
| `tier` | `text NN`, —; šešios tos pačios `trial*` / `special_*` reikšmės | Intro pasiūlymas, kuriam claim paimta / kuris iš tikro apmokėtas. Tai projekto verslo taisyklė. |
| `state` | `text NN`, `'pending'`; `pending` / `consumed` | Pending = dar nepatvirtinta prenumerata; consumed = provider subscription jau susieta ir intro panaudotas. Claim grąžina `already_used`, jei consumed. |
| `lease_expires_at` | `timestamptz NN`, `now() + interval '60 minutes'` | **Dabartinis kodas tik atnaujina; kaip gate nebeskaito.** Nuo liepos 28 d. nauja sesija gali perimti neapmokėtą claim iškart, jei incumbent order nepasiekė aktyvaus mokėjimo statuso. Paliktas observability. Švariam boilerplate šalinti arba aiškiai pervadinti pagal realią paskirtį. |
| `solidgate_subscription_id` | `text NULL`, — | Pirmoji/tikroji claim sunaudojusi Solidgate prenumerata. Su aplinka turi partial UNIQUE, kai ne NULL. Pakartotinis consume su tuo pačiu ID yra idempotentiškas net ištrynus sesiją. |
| `consumed_at` | `timestamptz NULL`, — | Kada pirmąkart suvartotas intro; consume nustato `now()` / išlaiko ankstesnį. Lentelėje nėra CHECK, kad `state='consumed'` implikuotų šį lauką ir subscription ID — garantiją palaiko RPC. |
| `created_at` | `timestamptz NN`, `now()` | Pirmo claim sukūrimas. |
| `updated_at` | `timestamptz NN`, `now()` | Paskutinis claim takeover, lease atnaujinimas ar consume/reconciliation pakeitimas. |
| `superseded_subscription_ids` | `text[] NN`, `'{}'` | Papildomai apmokėtos subscription ID tam pačiam email. Consume prideda naują ID be dublikatų; jau sumokėjęs klientas vis tiek gauna prieigą. Tai realių dvigubų prenumeratų manual refund/cancel eilė. |

PK `(payment_environment, email_hash)`; indeksai aplinka+sesija, partial unique aplinka+subscription, partial aplinka kur duplicate masyvas netuščias ir partial `(payment_environment, lease_expires_at) WHERE state='pending'`. Pastarasis po politikos pakeitimo neturi repo vartotojo pagal lease paiešką; prieš trynimą esamoje DB tikrinti operacinius vartotojus, naujame boilerplate jo nekopijuoti automatiškai. Visi klientai uždrausti per RLS+revoke, service-role turi visas teises.

App claim: `apps/funnel/src/app/api/solidgate/create-session/route.ts:491`. Hash kodas: `packages/shared/src/solidgate/intro-offer.ts:2`. Rezultatų semantika `:13`: `reassigned` = viena prenumerata, claim buvo kitur; `superseded` = tikras antras mokėjimas. View `solidgate_intro_claims_needing_refund`: `20260720200000...:243`; repozitorijoje nėra UI/worker, kuris uždarytų kiekvieną duplicate kaip išspręstą.

**Pagerinimai:** jei dedamas toks priedas, turėti `offer_group`/`campaign_id` PK dalyje, nes dabartinis `(env,email_hash)` leidžia tik vieną intro per visą projektą visam laikui. Duplicate tvarkymui, kai reikia realios operacinės eilės, masyvą keisti vaikinėmis eilutėmis su `status`, `resolved_at`, provider refund/cancel reference. Dabar array neturi kiekvieno elemento uždarymo istorijos. `lease_expires_at` išmesti iš švarios schemos, jeigu tokia pati immediate-retry politika. Email hash schemai dokumentuoti normalizaciją ir raktų strategiją; serverinis HMAC su paslaptimi apsaugotų nuo paprasto žinomų email sąrašo perhashinimo, bet keistų lookup/rotacijos sutartį.

**Tiksli rizika:** dabartinė politika neanuliuoja jau išduotos senos formos, tik perkelia claim, jei DB dar nemato pradėto mokėjimo (`20260728090000...:97`). Todėl leidžiant naują sesiją iš karto neįmanoma teigti, kad ledger absoliučiai užkerta kelią dvigubam apmokėjimui. Kodas sąmoningai tvarko likusį atvejį `superseded` šaka. Tai svarbus setup/operacijų dokumentacijos punktas.

## 4. `solidgate_session_vault`

Viena eilutė = anoniminės funnel sesijos dabartinė patikrinta kortelės generacija konkrečioje aplinkoje. Tai tokeno / maskuotų detalių saugykla, ne pilni kortelės duomenys. Tokeno stoka gali būti sąmoninga: naujesnis apmokėtas order be tokeno vis tiek įrašo naujesnės kilmės ribą, kad pavėluotas senas webhook neatkurtų senos kortelės.

Schema: `supabase/migrations/00039_solidgate_columns.sql:35`; aplinka ir PK `supabase/migrations/20260716152843_solidgate_webhook_lifecycle.sql:426`; kilmė `supabase/migrations/20260721124000_solidgate_payment_identity.sql:86`; dabartinis kilmės CHECK `supabase/migrations/20260721125000_solidgate_card_update_state.sql:110`; payment-method `supabase/migrations/20260722084816_solidgate_token_origin_payment_type.sql:5`. Dabartinis monotonic write `supabase/migrations/20260728091000_solidgate_session_vault_auth_ok.sql:19`, wrapper `20260722084816...:360`.

| Stulpelis | Tipas / NULL / default | Kur, kam ir kaip naudojamas |
|---|---|---|
| `session_id` | `uuid NN`, —; FK `sessions.id ON DELETE CASCADE` | Anoniminės sesijos savininkas; PK dalis. Po paskyros priskyrimo pagal šią sesiją vyksta promotion. |
| `customer_account_id` | `text NN`, — | Tikslus merchant customer_account_id, su kuriuo tokenas gautas ir naudojamas OTO. Saugoma atskirai nuo application session ID, kad serveris tikrintų tikslų PSP ryšį. |
| `card_token` | `text NULL`, — | Solidgate pasikartojančiam/token mokėjimui naudotina nuoroda, gaunama iš patikrintų provider duomenų. NULL taip pat reiškia naują patvirtintą kilmę, kurios tokeno dar nėra. |
| `card_brand` | `text NULL`, — | Provider kortelės ženklas UI (`Visa`, ir pan.); grąžinamas tik su usable tokenu. |
| `card_last4` | `text NULL`, — | Paskutiniai 4 skaitmenys UI. TS ištraukia iš maskuoto PAN; write RPC tikrina 4 skaitmenų formatą. |
| `created_at` | `timestamptz NN`, `now()` | Vault eilutės pirmo sukūrimo laikas; ne kortelės pasirinkimo eiliškumo kriterijus. |
| `updated_at` | `timestamptz NN`, `now()` | Paskutinis tokeno / kilmės / metodo papildymas; RPC atnaujina ranka. |
| `payment_environment` | `text NN`, `'production'`; `production` / `sandbox` | PK su sesija. Senos eilutės migracijoje perkeltos į sandbox. Naujam boilerplate galima reikalauti eksplicitinės aplinkos be default. |
| `card_source_order_id` | `uuid NULL`, —; FK `orders.id ON DELETE SET NULL` | Tikslus pagrindinis užsakymas, iš kurio leidžiama ši kortelė. Reader neišduoda legacy/nepririšto tokeno. |
| `card_source_created_at` | `timestamptz NULL`, — | Kilmės order sukūrimo laiko snapshot. To paties source replay privalo sutapti. Ne galutinis ordering kriterijus — tai source sequence. |
| `card_source_sequence` | `bigint NULL`, — | To order monotoniškai didėjantis `solidgate_card_source_sequence`. Neleidžia senesniam order atgal perrašyti naujesnės kortelės. |
| `card_source_legacy` | `boolean NN`, `true` | Žymi seną tokeną be patikimai atkurtos kilmės. Šiuolaikinis source write nustato false. Jei true, programinis reader tokeną paslepia. Švarioje schemoje be legacy duomenų galima nebenešti atskiro legacy režimo. |
| `card_original_payment_method` | `text NULL`, —; `card`, `apple-pay`, `google-pay`, `network-token`, `click-to-pay` | Tikslus tokeno origin. Pasirenkamas leistinas `payment_type`: card/network → `1-click`; Apple/Google → `rebill`; click-to-pay/unknown netinka reuse. CHECK leidžia metodą tik jei yra netuščias tokenas. |

PK `(payment_environment, session_id)`. Likęs indeksas `idx_solidgate_session_vault_customer(customer_account_id)` — dabartiniai matyti app ir RPC readeriai ieško pagal `(environment,session_id)`, tad customer indeksas yra kandidatas pasitikrinti prieš perkeliant, o ne įrodytai lėtina sistemą. RLS be client policies; source ir payment-method triggeriai neleidžia neaprobuoto tiesioginio source perrašymo. Tokenų negalima kelti į anon/auth rašomą `sessions`; priežastis ir originali grant problema aprašyta `00039...:29`.

TS skaitymas `packages/shared/src/solidgate/session-vault.ts:89`, rašymas `:53`. App grant rašo `apps/funnel/src/app/api/solidgate/grant/route.ts:1004` ir `:1312`; webhook `supabase/functions/solidgate-webhooks/index.ts:2848`; OTO payment type `apps/funnel/src/app/api/solidgate/charge-oto/route.ts:1125`. Vien tik `card_token IS NOT NULL` nėra visos naudojimo teisės patikra: reader reikalauja source ir žinomos kilmės, o mokėjimo kelias dar tikrina reuse tipą.

**Peržiūros punktas naujai schemai:** `card_source_order_id ON DELETE SET NULL` ir source CHECK yra nesuderinami su izoliuotu source order ištrynimu: po FK nullification liktų `card_source_created_at/sequence` ir `card_source_legacy=false`, todėl CHECK netenkina nė vienos šakos. Source guard triggeris taip pat gali atmesti tiesioginį pakeitimą. Tai nėra įrodytas vartotojo sesijos trynimo incidentas, bet deklaruota FK semantika nėra veikiantis savaiminis „palikti vault be order“ sprendimas. Rinktis aiškią politiką: saugoti source order, išvalyti visą vault/source atomine procedūra arba naudoti tinkamą tombstone/soft-delete.

## 5. `solidgate_account_vault`

Viena eilutė = vartotojo dabartinė mokėjimo priemonė konkrečioje aplinkoje. Ji gali būti perkelta iš funnel, gauta per PWA hosted formą ar pasirinkta kortelės pakeitimo lange. Šiuos šaltinius bendra sequence tvarka saugo nuo vėluojančių webhook/requestų.

Schema: `supabase/migrations/20260716152843_solidgate_webhook_lifecycle.sql:445`; source laukų pridėjimas `supabase/migrations/20260721125000_solidgate_card_update_state.sql:61`, rašymas `:1547`, eiliškumo palyginimas `:1809`; method stulpelis `supabase/migrations/20260722084816_solidgate_token_origin_payment_type.sql:8`, wrapper `:454`.

| Stulpelis | Tipas / NULL / default | Kur, kam ir kaip naudojamas |
|---|---|---|
| `user_id` | `uuid NN`, —; FK `auth.users.id ON DELETE CASCADE` | Paskyros savininkas, PK dalis. |
| `payment_environment` | `text NN`, `'production'`; `production` / `sandbox` | PK dalis, environment izoliacija. |
| `customer_account_id` | `text NN`, — | Account-side merchant customer ID. Dabartinis writer visada įrašo `user_id::text`; reader grąžina saved-card pirkimui. Šiame kode išvedamas, bet abstrakčiam provider klientui kaip atskiras ID prasmingas. |
| `card_token` | `text NULL`, — | Dabartinis provider tokenas. NULL gali reikšti naują source watermark, kuris užblokuoja ankstesnę kortelę iki tikslaus naujo tokeno gavimo. |
| `card_brand` | `text NULL`, — | UI kortelės ženklas. |
| `card_last4` | `text NULL`, — | UI paskutiniai keturi skaitmenys; write RPC validuoja formatą. |
| `session_origin_id` | `uuid NULL`, —; FK `sessions.id ON DELETE SET NULL` | Pirminė funnel sesija / lineage. Promotion ją įrašo; vėlesnis PWA/card-update ją išlaiko per COALESCE. Todėl **nebūtinai dabartinės kortelės šaltinis**; dabartinį rodo `card_source_*`. |
| `created_at` | `timestamptz NN`, `now()` | Pirmas paskyros vault sukūrimas. |
| `updated_at` | `timestamptz NN`, `now()` | Paskutinis įrašo papildymas / pakeitimas. |
| `card_source_kind` | `text NN`, `'legacy'`; `legacy`, `main_order`, `pwa_order`, `card_update` | Polimorfinis šaltinio tipas. Reader leidžia tik ne legacy ir yra saugomas source-write trigerių. |
| `card_source_created_at` | `timestamptz NN`, `'-infinity'` | Šaltinio sukūrimo laiko snapshot; legacy surikiuojamas kaip nežinomas/senas. Reikalaujama tikslaus sutapimo, kai papildomas to paties šaltinio tokenas. |
| `card_source_sequence` | `bigint NN`, `0` | Bendra šaltinio versija iš order ar card-update sequence. Pirmas comparison kriterijus sprendžiant, kuri kortelė naujesnė. Legacy = 0. |
| `card_source_id` | `text NN`, `'legacy'` | Jei main/PWA → `orders.id` tekstu; jei card_update → `solidgate_card_update_attempts.id` tekstu. Ne Solidgate order ID. FK nėra dėl polimorfiškumo; RPC tikrina konkrečią kilmę, vartotoją ir būseną. |
| `card_original_payment_method` | `text NULL`, —; tie patys 5 origin variantai | Mokėjimo reuse tipo parinkimas. Metodas yra susietas su tuo pačiu tokenu ir negali tyliai keistis to paties source retry metu. |

PK `(payment_environment,user_id)`. RLS įjungta, anon/auth teisės atšauktos; source ir payment-method triggeriai riboja rašymą net service-role kelyje, approved RPC viduje naudojant lokalią konfiguraciją. TS read `packages/shared/src/solidgate/account-vault.ts:30`; write `:64`; promotion `:108`. PWA patvirtinimas `apps/pwa/src/app/api/solidgate/purchase/confirm/route.ts:995`; kortelės keitimas `apps/pwa/src/app/api/solidgate/billing/update-card/route.ts:481`; webhook `supabase/functions/solidgate-webhooks/index.ts:2816`.

**Palikti semantiką:** lyginama `(source_sequence, kind_priority, source_id)`, ne `updated_at` ar webhook gavimo laikas. Net įrašant source be tokeno senesnis tokenas negrąžinamas (`20260721125000...:1759` ir `:1880`). Naujam boilerplate galima turėti tvarkingą UUID `source_id` ir aiškų source modelį be `legacy` sentinel, bet reikia išlaikyti tos pačios kilmės tikrinimą. `session_origin_id` yra auditinis lineage, optional jei naujas projektas jo niekur neturės.

## 6. `solidgate_card_update_attempts`

Viena eilutė = vienas vartotojo kortelės pakeitimo bandymas. Čia nėra produkto kainos ar entitlement, nes vyksta 0-amount authorization. Po patvirtinimo keičiamas account vault, o senos prenumeratos atnaujinamos atskiroje darbų eilėje. Historiniai attempt paliekami, `is_current` žymi vieną einamą.

Schema: `supabase/migrations/20260721125000_solidgate_card_update_state.sql:5`. Naujausias locale CHECK ir open RPC: `supabase/migrations/20260907120000_wave2_locales.sql:878` ir `:896`. Užbaigimas/claim `20260721125000...:1022`, `:1073`, `:1984`.

| Stulpelis | Tipas / NULL / default | Kur, kam ir kaip naudojamas |
|---|---|---|
| `id` | `uuid NN`, `gen_random_uuid()`; PK | Vidinis attempt ID; account vault `card_source_id` nurodo jį. |
| `source_sequence` | `bigint NN`, `nextval('public.solidgate_card_source_sequence')` | Tos pačios globalios sekos generacija kaip orders. Apsaugo nuo seno kortelės pakeitimo rezultato, atėjusio po naujesnio pirkimo/kortelės pasirinkimo. |
| `payment_environment` | `text NN`, —; `production` / `sandbox` | Izoliacija; dalis provider ID unikalumo ir current-owner rakto. |
| `user_id` | `uuid NN`, —; FK `auth.users.id ON DELETE CASCADE` | Kortelę keičianti paskyra. |
| `solidgate_order_id` | `text NN`, —; UNIQUE kartu su aplinka | Serverio paruoštas merchant order ID `u-<user-id>:card_update:<skaičius>`. Su juo provider status sutikrinamas prieš išsaugant tokeną. |
| `customer_email` | `text NN`, —; normalizuotas, regex, ilgis 3–320 | Nekintamas email snapshot kortelės formai ir tiksliam provider atsakymo binding. Negalima tiesiog naudoti tuo metu naujausio profile email confirm metu. |
| `checkout_locale` | `text NN`, —; dabartinis 32 locale CHECK | Nekintama formos kalba. Leidžiama: en, cs, hu, sk, ro, lt, ru, lv, zh-TW, el, he, pl, hr, da, ja, bg, de, et, es, fi, fr, it, ko, nl, no, pt, sl, sr, sv, tr, uk, zh-HK. |
| `state` | `text NN`, —; `building`, `issued`, `applying`, `completed`, `failed` | Formos kūrimas → išduota → rezultatą įrašantis worker → baigta arba atmesta. Tai lokalaus workflow, ne raw PSP statusas. |
| `is_current` | `boolean NN`, `true` | Tik vienas current attempt vienam environment+user. Terminal attempt gali likti current, kol kitas open jį pažymi false. |
| `builder_token` | `uuid NULL`, — | Formos kūrimo lease savininkas. Išvalomas sėkmingai publikuojant payload. |
| `builder_started_at` | `timestamptz NULL`, — | Formos kūrimo lease pradžia; po 30 s galima perimti neužbaigtą build. CHECK pora su builder token. |
| `merchant_data` | `jsonb NULL`, —; object | Pasirašytas formos payload. CHECK: tik `building` būsenoje NULL; visose kitose turi būti. |
| `apply_token` | `uuid NULL`, — | Result-apply worker nuosavybė. Neleidžia dviem confirm requestams užbaigti skirtingai ir atmeta stale completion. |
| `apply_started_at` | `timestamptz NULL`, — | Apply lease pradžia; dabartinis claim po 30 s gali perimti. CHECK pora su apply token. |
| `last_provider_status` | `text NULL`, — | Paskutinis provider statusas, pvz. `auth_ok`, pending ar terminal. Observability ir palaikymas; nėra atskiras finansinis order. |
| `completed_at` | `timestamptz NULL`, — | Sėkmingo kortelės pritaikymo laikas. CHECK užtikrina, kad ne NULL tik ir tik tada, kai state completed. |
| `created_at` | `timestamptz NN`, `now()` | Attempt sukūrimo laikas, taip pat source provenance. |
| `updated_at` | `timestamptz NN`, `now()` | Paskutinis būsenos / lease pakeitimas. |

Indeksai: UNIQUE `(payment_environment,solidgate_order_id)`, partial UNIQUE `(payment_environment,user_id) WHERE is_current`, history `(payment_environment,user_id,created_at DESC,id DESC)`. RLS įjungta, **tiesioginis DML atšauktas ir `service_role`**; viskas vyksta per specialiai suteiktus SECURITY DEFINER RPC. Tai griežtesnis modelis negu main/PWA state, kur service role gali rašyti tiesiai.

App `apps/pwa/src/app/api/solidgate/billing/update-card/route.ts:547` atidaro, `:385` tikrina provider, `:448` claim, `:481` vault write, `:503` complete. RPC `get_solidgate_card_update_attempt` grąžina minimalų snapshot, ne tokeną. Istorijos indeksas kol kas neturi matyto app history-list vartotojo; gali būti naudingas admin įrankiui, bet nėra būtinas vykdomiems get-by-order/current-by-user keliams. Prieš trinti esamame projekte patikrinti DB statistiką.

## 7. `solidgate_subscription_token_sync_jobs`

Viena eilutė = vienos vartotojo Solidgate prenumeratos pageidaujama nauja kortelės versija. Čia tokenas nedubliuojamas; worker jį pasiima iš vault tik jei vault vis dar atitinka tiksliai pageidaujamą šaltinį. Naujesnė kortelė gali pakeisti tikslą, net kai senesnis worker jau vykdo išorinį requestą: tas pats worker po completion konflikto sutikrina naują versiją ir pataiso provider.

Schema ir delivery indeksas `supabase/migrations/20260721125000_solidgate_card_update_state.sql:324`. Enqueue `:407`, tokenless fencing `:539`, entitlement trigger `:669`, claim `:725`, exact-source read `:770`, complete `:816`, failure `:855`.

| Stulpelis | Tipas / NULL / default | Kur, kam ir kaip naudojamas |
|---|---|---|
| `payment_environment` | `text NN`, —; `production` / `sandbox` | PK dalis, provider aplinka ir worker filtras. |
| `user_id` | `uuid NN`, —; FK `auth.users.id ON DELETE CASCADE` | Prenumeratos/vault savininkas, PK dalis. |
| `solidgate_subscription_id` | `text NN`, —; ne tuščias | Kurią provider prenumeratą atnaujinti; PK dalis. Eilė tikrina jos ryšį su tiksliu order ir entitlement. |
| `desired_source_kind` | `text NN`, —; `main_order`, `pwa_order`, `card_update` | Pageidaujamos kortelės kilmės tipas iš account vault. |
| `desired_source_created_at` | `timestamptz NN`, — | Pageidaujamos kilmės laiko snapshot; read jungia su lygiai tuo pačiu vault source. |
| `desired_source_sequence` | `bigint NN`, — | Pageidaujamos kilmės generacija; enqueue naujesnio šaltinio atveju atominiu būdu perkelia tikslą. |
| `desired_source_id` | `text NN`, — | Tikslus source order/card-update ID. Complete/fail privalo atitikti worker matytą generation, kad nepažymėtų naujesnio darbo baigtu. |
| `status` | `text NN`, `'pending'`; `awaiting_token`, `pending`, `processing`, `applied`, `failed` | Laukia tokeno, laukia workerio, vykdoma, sutvarkyta arba paskutinis bandymas nepavyko. `failed` nėra galutinis dead-letter: retry dar vyksta. `applied` gali reikšti ir nebemokėtinos prenumeratos praleidimą. |
| `attempts` | `integer NN`, `0`; >= 0 | Claim skaičius; didinamas prieš kiekvieną vykdymą. Naudojamas eksponentiniam backoff. Dabar neanuliuojamas pasikeitus source generacijai. |
| `claim_token` | `uuid NULL`, — | Workerio lease savininkas; CHECK reikalauja ne NULL tik state processing. |
| `processing_started_at` | `timestamptz NULL`, — | Lease pradžia. Nutrauktas worker perimamas po 300 s pagal app (SQL minimum 180 s). CHECK atitinka processing būseną. |
| `next_attempt_at` | `timestamptz NN`, `now()` | Retry planavimo laikas, indeksuotas pending/failed darbo paėmimui. |
| `applied_at` | `timestamptz NULL`, — | Kada dabartinis tikslas laikytas sutvarkytu; nauja generacija išvalo. Nereiškia, kad būtinai siųstas provider request, nes nonbillable job gali būti uždaromas be jo. |
| `last_error` | `text NULL`, — | Paskutinė serverinė/provider klaida, fail RPC trumpina iki 2000 simbolių; kitam claim išvalo. |
| `created_at` | `timestamptz NN`, `now()` | Pirmasis šios prenumeratos job sukūrimas; nauji source perrašo tą pačią eilutę. |
| `updated_at` | `timestamptz NN`, `now()` | Paskutinis job veiksmas; naudojamas ir stabiliai paėmimo eilei. |

PK `(payment_environment,user_id,solidgate_subscription_id)`. Delivery indeksas `(payment_environment,next_attempt_at,updated_at) WHERE status IN ('pending','processing','failed')`. `FOR UPDATE SKIP LOCKED` leidžia kelis workerius, nepaimant tų pačių eilučių. RLS ir visų tiesioginių teisių, įskaitant service-role, revoke; tik RPC API.

Worker: `packages/shared/src/solidgate/subscription-token-sync.ts:123`; iki 16 source pasikeitimo iteracijų per lease (`:129`), exact-generation read (`:67`), provider `updateSubscriptionToken` (`:144`), claim 5 min (`:184`). Wake-up po PWA capture (`apps/pwa/src/app/api/solidgate/purchase/confirm/route.ts:1016`), kortelės pakeitimo (`apps/pwa/src/app/api/solidgate/billing/update-card/route.ts:155`), main grant (`apps/funnel/src/app/api/solidgate/grant/route.ts:1608`); durable drain internal endpoint `apps/funnel/src/app/api/internal/solidgate-fulfillment/route.ts:27`.

**Palikti:** queue, retries, lease, exact-generation fencing ir billable subscription įrodymą. Patobulinti operacijas: atskiras galutinės klaidos/dead-letter ar alert slenkstis, apibrėžta `awaiting_token` stebėsena, pageidaujamos kartos atskiras bandymų skaičius. Dabartinė SQL backoff formulė `LEAST(1800, 5 * 2^LEAST(attempts,8))` faktiškai pasiekia 1280 s, o ne 1800 s, nes eksponentas apribotas 8 (`20260721125000...:873`). Tai maža konfigūracijos/aiškumo problema, ne mokėjimų korektiškumo klaida.

## Architektūros ir optimizavimo pastabos šioms 7 lentelėms

1. **Geras branduolys:** aplinka įtraukta į tapatybes; mokamas order išrenkamas atomiškai; yra lease perėmimas po request nutrūkimo; vėluojantys callback'ai neatgalina kortelės generacijos; tokenless nauja kilmė saugoma sąmoningai; išoriniai subscription pakeitimai iškelti į patikimą eilę. Tai svarbesnė optimizacija už kuo mažesnį lentelių skaičių.
2. **Didžiausias perkėlimo trūkumas — projektinės taisyklės įmaišytos į SQL.** Main state CHECK pririštas prie vieno TheAstrologist produkto ir šešių pasiūlymų, intro ledger prie vienos lifetime akcijos, PWA mapping funkcijos prie konkrečių PDF ir advisory. Reusable modulyje skirti mokėjimų mechaniką nuo katalogo, pasiūlymų / intro taisyklių ir entitlement adapterio.
3. **Nekopijuoti migracijų istorijos kaip produkto API.** Senos funkcijos perrašytos daug kartų, o TypeScript naudoja v2 ir `*_with_method`. Boilerplate turi gauti susumuotą dabartinę schemą ir tik reikalingas viešas RPC, legacy backfill/corrective SQL laikant už jos ribų. Rugsėjo locale pakeitimai taip pat turi patekti į snapshot.
4. **Stulpelių, kuriuos galima pagrįstai atsisakyti švarioje instaliacijoje, yra mažai.** `intro_claims.lease_expires_at` ir jo pending-lease indeksas yra konkretus kandidatas. Vault `legacy` reikšmės / backfill yra istorinis suderinamumas; naujoje sistemoje įrodyta kilmė gali būti privaloma nuo pradžių. `session_origin_id` yra pasirenkamas lineage. Kitų claim/result/source laukų nenaudojamais vadinti negalima vien todėl, kad frontend jų neskaito: juos vartoja SQL.
5. **Dalies indeksų būtinybė neįrodyta pagal kodą:** session vault customer indeksas, card-update user-history indeksas. Nekelti jų į naują projektą mechaniškai; spręsti pagal tikrą admin/query poreikį. Produkciniam „optimizuota“ vertinimui dar reikėtų `pg_stat_user_indexes`, eilučių skaičių, retention ir `EXPLAIN ANALYZE`; šiame skaitymo audite tai netikrinta.
6. **Retencija turi išlaikyti teisingumą.** Koordinavimo lentelės mažos (po eilutę scope), bet card-update istorija ir neapdorotos klaidų eilės auga; `merchant_data` galima mažinti/tvarkyti tik pagal aiškią terminalumo/replay/retencijos sutartį. Intro claim ar source generacijos negalima tiesiog trinti dėl amžiaus ir taip atkurti panaudotą teisę ar leisti senai kortelei sugrįžti.
7. **Vienoda RPC riba būtų aiškesnė.** Card-update/job lentelės jau RPC-only net service role; main/PWA state ir intro dar turi service-role DML. Švarus modulis gali vienodai slėpti workflow mutation už RPC, palikdamas tik aiškią read API. Tai sumažina atsitiktinio app upsert, apeinančio invariantus, riziką.
8. **Tokeno kilmė ir teisė pakartotinai naudoti nėra tas pats kaip source order dabartinis access statusas.** Pradinis purchase gali būti refunded, o nepriklausomas galiojantis card-update likti vartotojo pasirinkta mokėjimo priemonė. Modulis turi vieną aiškią eligibility taisyklę visiems saved-card ir subscription-sync keliams, o ne automatiškai invaliduoti kortelę vien dėl bet kurio seno order grąžinimo. Dabartinis reader tikrina source shape ir origin; mokėjimo keliai dar tikrina konkrečius grant/reuse reikalavimus.

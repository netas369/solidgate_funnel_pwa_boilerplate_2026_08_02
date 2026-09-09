# Solidgate įvykių ir vykdymo lentelių auditas

[Architektūros vertinimas ir naujo boilerplate rekomendacijos](boilerplate-architecture-audit.lt.md).

Apimtis: tik lokalus repozitorijos skaitymas; DB ir išorinių API nekviečiau. Schema atkurta sudėjus visas šias lenteles liečiančias migracijas; dabartiniai sugeneruoti TS tipai atitinka išvardytus stulpelius. Tai **repozitorijoje deklaruojama galutinė schema**, ne patvirtintas produkcinės DB snapshotas. `NULL: taip` reiškia, kad DB leidžia NULL; `default: —` reiškia nėra DEFAULT išraiškos. `updated_at DEFAULT now()` savaime neatnaujina lauko per UPDATE: šiose lentelėse jį nustato RPC arba aplikacijos kodas.

## Esminis vertinimas

Pagrindinė mintis gera: webhook inbox atskirtas nuo mokėjimų būsenos, vienas įvykis turi deduplikaciją ir valdymo tokeną, o vienas mokėjimas gali generuoti kelis atskirai kartojamus outbox darbus. Naujam boilerplate verta perkelti šį patikimumo modelį, bet ne visą senų diegimų suderinamumo ir konkretaus produkto logiką.

| Lentelė | Paskirtis | Naujam Solidgate boilerplate |
|---|---|---|
| `solidgate_webhook_events` | Patvarus gautų webhookų inbox: vienas įvykis vienoje aplinkoje, claim, retry, rezultatas | Būtina webhook patikimumo infrastruktūra |
| `solidgate_entity_watermarks` | Skirtingų įvykių, liečiančių tą patį mokėjimą / prenumeratą, eiliškumas ir trumpa vykdytojo nuoma | Reikalingas šis mechanizmas; nebūtinai būtent atskira tokia lentelė, jei būsena serializuojama domeno DB transakcijoje |
| `solidgate_fulfillment_outbox` | Patvarūs veiksmai po pirkimo: dabartiniame projekte lifetime prenumeratos nutraukimas, welcome, profilio pildymas, CRM, Meta | Reikalinga outbox infrastruktūra, jei yra tokių veiksmų; konkretūs `effect_type` yra projekto adapteriai |
| `solidgate_analytics_outbox` | Patvarus PostHog siuntimas ir dedupe | Pasirenkama analytics integracija, ne Solidgate reikalavimas |
| `meta_capi_event_claims` | Viešo browser → Meta CAPI endpointo dedupe ir per-IP ribojimas | Marketingo modulis, neprivalomas payments branduoliui |
| `stripe_webhook_events` | Seno Stripe webhook dedupe | Nekelti į Solidgate-only boilerplate; šiame checkout sraute aktyvaus caller neradau |

## 1. `solidgate_webhook_events` — 15 stulpelių

Šaltiniai: [pradinė schema](/Users/Netas/Projects/theastrologist/supabase/migrations/00039_solidgate_columns.sql:105), [lifecycle papildymas](/Users/Netas/Projects/theastrologist/supabase/migrations/20260716152843_solidgate_webhook_lifecycle.sql:23), [claim papildymas](/Users/Netas/Projects/theastrologist/supabase/migrations/20260721090209_solidgate_webhook_claim_states.sql:7). `20260721105000_solidgate_round2_corrective_reapply.sql` šias definicijas pakartoja. Toliau lentelėje L = lifecycle migracija, C = claim migracija, O = pradinė 00039 migracija.

| Stulpelis | Tipas; NULL; default | Kam ir kaip naudojamas | Schema |
|---|---|---|---|
| `event_id` | text; ne; — | Iš `solidgate-event-id` antraštės. Tai tiekėjo įvykio identifikatorius, ne order ID. Su `environment` deduplikuoja tą patį pakartotinai pristatytą įvykį. | O:106 |
| `type` | text; ne; — | Iš `solidgate-event-type`; parenka `card_gate.order.updated`, `alt_gate.order.updated`, `subscription.updated.v2` arba `card_gate.chargeback.received` handlerį. DB tipo reikšmių CHECK nėra, unsupported tipas inbox'e lieka failed. | O:107 |
| `event_created_at` | timestamptz; taip; — | Tiekėjo įvykio sukūrimo laikas iš antraštės; perduodamas į entity eiliškumo patikrą. NULL paliktas dėl senos schemos, bet dabartinis HTTP kelias ir v2 claim RPC reikalauja validžios reikšmės. | O:108 |
| `received_at` | timestamptz; ne; now() | Kada šis įvykis pirmą kartą įrašytas lokaliai. Pakartotiniai claim šio lauko neatnaujina. Naudojamas monitoringui; nėra paskutinio gavimo laikas. | O:109 |
| `environment` | text; ne; `'production'` | `production` arba `sandbox`; kartu su `event_id` izoliuoja aplinkų dedupe. Esami istoriniai įrašai buvo pažymėti sandbox prieš nustatant naujų įrašų default. Dabartinis handleris visada perduoda aplinką aiškiai. | L:23–27 |
| `status` | text; ne; `'completed'` | Inbox apdorojimo būsena: `processing`, `completed`, `failed`. **Tai ne mokėjimo būsena.** Istorinis completed default reikalingas senų sėkmingai apdorotų įrašų migracijai; v2 RPC naują įvykį aiškiai kuria processing. | L:33,61 |
| `attempts` | integer; ne; `1` | Kiek kartų įvykis buvo realiai perimtas vykdymui. Pradžioje 1, per failed arba pasibaigusios lease perėmimą +1. Busy / completed dublikatai neskaičiuojami kaip naujas bandymas. | L:34,65 |
| `payload` | jsonb; taip; — | Visas po signature patikrinimo JSON-parsed webhook body. Diagnostika ir potencialus replay šaltinis. Šiame repo automatinio skaitytojo, kuris iš šio payload pakartotinai paleistų failed inbox įvykius, neradau; dabar pakartotinis apdorojimas remiasi nauju tiekėjo HTTP pristatymu. | L:35 |
| `processing_started_at` | timestamptz; taip; — | Dabartinio apdorojimo claim pradžia. Po 300 s (RPC minimalus leidžiamas 30 s) naujas worker gali perimti įstrigusį processing. Complete/fail išvalo. | L:36 |
| `completed_at` | timestamptz; taip; — | Kada sėkmingai užbaigtas verslo handleris. Analitikos siuntimas vyksta vėliau, todėl completed negarantuoja pristatytos analitikos ar fulfillment. Naujas retry išvalo. | L:37 |
| `failed_at` | timestamptz; taip; — | Paskutinio nepavykusio apdorojimo laikas. Sėkmingas naujas claim / completion išvalo; visa atskirų bandymų istorija čia nesaugoma. | L:38 |
| `last_error` | text; taip; — | Paskutinė klaida, v2 fail RPC trumpina iki 4 000 simbolių. Claim / completion išvalo. | L:39 |
| `updated_at` | timestamptz; ne; now() | Paskutinio claim / status pakeitimo laikas; rašomas rankiniu būdu SQL funkcijose. | L:40 |
| `claim_token` | uuid; taip; — | Unikalus konkretaus perėmimo savininko tokenas. V2 claim suteikia naują UUID; complete/fail turi pateikti tą patį tokeną. Terminalinėje būsenoje turi būti NULL. | C:8,20 |
| `claim_generation` | bigint; ne; `0` | Monotoniškai didėjantis claim numeris. V2 pirmas claim = 1, kiekvienas perėmimas +1. Complete/fail tikrina kartu su tokenu. `0` yra senų įrašų / tiesioginio INSERT default. Tai nėra tiekėjo event sekos numeris. | C:9,15 |

Naudojimas: [antraštės ir signature](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:4614), [claim v2](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:884), [complete/fail su token+generation](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:927), [tikslus pagrindinis srautas](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:4653).

Indeksai ir ribojimai:

- PK `(environment,event_id)`, abu NOT NULL. CHECK environment tik production/sandbox; status tik processing/completed/failed; attempts > 0; generation >= 0; `status = 'processing' OR claim_token IS NULL`. Pastarasis leidžia processing su NULL tokenu dėl seno v1 kelio.
- `idx_solidgate_webhook_events_received_at(received_at)` pirmo gavimo monitoringo / būsimo retention užklausoms. Naudojimo pavyzdys: [monitorius](/Users/Netas/Projects/theastrologist/scripts/monitor-renewals.mjs:22).
- Dalinis `idx_solidgate_webhook_events_retry(status,processing_started_at) WHERE status IN ('processing','failed')`; skirtas įstrigusių / failed paieškai, nors savarankiško replay worker nėra.
- Dalinis `idx_solidgate_webhook_events_active_claim(environment,event_id,claim_generation) WHERE status='processing' AND claim_token IS NOT NULL`. Kandidatas supaprastinti naujoje schemoje: PK jau suranda ne daugiau kaip vieną row pagal pirmus du laukus, o generation tikrina tos eilutės predikatas. Tai optimizavimo hipotezė, ne įrodymas be `EXPLAIN` ir apkrovos.
- FK į order nėra: įvykis gali būti apie prenumeratą ir gali ateiti prieš lokalaus order susiejimą. RLS įjungtas, browser rolėms prieiga atimta, v2 RPC su `SECURITY INVOKER`, `search_path=''`, execute tik service_role ([ACL](/Users/Netas/Projects/theastrologist/supabase/migrations/20260721105000_solidgate_round2_corrective_reapply.sql:976)).

Boilerplate pakeitimai: pašalinti v1 suderinamumą; naujiems įvykiams neduoti completed default; švarioje DB `event_created_at` ir `payload` gali būti NOT NULL. Sąmoningai pasirinkti `pending` inbox + async worker modelį arba esamą processing claim modelį. `claim_token` ir `claim_generation` nėra didelė storage našta; tokeno principo neatsisakyti siekiant mažiau stulpelių.

## 2. `solidgate_entity_watermarks` — 8 stulpeliai

Lentelės [pilna definicija](/Users/Netas/Projects/theastrologist/supabase/migrations/20260716152843_solidgate_webhook_lifecycle.sql:121). Galutinė [claim logika](/Users/Netas/Projects/theastrologist/supabase/migrations/20260721130000_solidgate_equal_timestamp_entity_ordering.sql:6); complete/release lieka lifecycle migracijos 184/207 eilutėse. Žemiau eilučių numeriai yra lifecycle migracijos.

| Stulpelis | Tipas; NULL; default | Kam ir kaip naudojamas | Schema |
|---|---|---|---|
| `entity_type` | text; ne; — | Aplikacija naudoja `payment` arba `subscription`. Atskiria tų dviejų objektų vardų erdves. DB CHECK nėra. | 122 |
| `entity_id` | text; ne; — | **Dabartinė reikšmė yra ne grynas tiekėjo ID:** aplikacija konstruoja `production:<order/subscription ID>` arba `sandbox:<ID>`. Su entity_type sudaro PK. | 123 |
| `last_event_created_at` | timestamptz; taip; — | Paskutinio sėkmingai užbaigto šio objekto įvykio tiekėjo timestamp. Naujas įvykis laikomas stale tik kai jo laikas griežtai mažesnis. Vienodą timestamp turintys skirtingi įvykiai leidžiami. | 124 |
| `last_event_id` | text; taip; — | Paskutinio baigto įvykio ID diagnostikai. Seniau dalyvavo lexicografiniame eiliškume; galutinė 20260721130000 claim funkcija jo chronologijai nebenaudoja. | 125 |
| `processing_event_created_at` | timestamptz; taip; — | Šiuo metu paimto įvykio timestamp. Claim įrašo, complete/release išvalo. Galutinė claim / complete logika jo neskaito: šiuo metu tai diagnostinis laukas. | 126 |
| `processing_event_id` | text; taip; — | Dabartinis šio objekto įvykis. Kito ID įvykis gauna busy, kol lease dar gyva. Complete/release atnaujina tik sutampantį ID. **Tai nėra unikalaus vykdytojo tokenas.** | 127 |
| `processing_started_at` | timestamptz; taip; — | Entity lease pradžia; 300 s po jos kitas worker gali perimti. Complete/release išvalo. | 128 |
| `updated_at` | timestamptz; ne; now() | Paskutinis claim / complete / release laikas. | 129 |

PK `(entity_type,entity_id)`, kitų indeksų nėra; eilutė kuriama `INSERT ... ON CONFLICT DO NOTHING`, po to `SELECT ... FOR UPDATE` vienoje claim RPC transakcijoje. RLS + service-role-only prieiga. Nėra FK į inbox / orders, nėra environment CHECK, nėra lease laukų tarpusavio CHECK.

Naudojimas: [withEntityOrdering](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:971) prefiksuoja environment, kreipiasi į RPC, gavęs busy iki keturių kartų palaukia (1,5 + 3 + 4,5 + 6 = 15 sekundžių), tada meta retryable klaidą; stale grąžina be domeno apdorojimo. [handleEvent](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:4567) apgaubia card/alt order + chargeback kaip payment, subscription.v2 kaip subscription.

Boilerplate: aiškus `(environment,entity_type,entity_id)` yra geriau nei prefikso sutartis. Galima neperkelti `processing_event_created_at`, jeigu diagnostikai pakanka inbox, o `last_event_id` palikti dėl pigaus operacinio paaiškinamumo. Eiliškumo mechanizmo naikinti vien dėl stulpelių skaičiaus nereikėtų.

Svarbi likusi konkurencijos rizika: šios lease **neturi claim_token/generation**. Tą patį event_id perėmęs naujas inbox worker nėra atskiriamas entity lentelėje nuo ankstesnio worker; senas worker gali atlikti complete/release naujajam priklausančiam tokiam pačiam event_id. Be to, domeno handleris negauna inbox claim tokeno, todėl inbox completion fencing pats savaime nefencina domeno rašymų. Tai iš kodo išplaukiantis lease expiry scenarijus, ne patvirtintas produkcinis incidentas. Naujoje architektūroje arba rišti entity lease su konkrečiu claim tokenu ir tikrinti domeno transakcijoje, arba vienoje trumpoje DB transakcijoje užrakinti domeno objektą ir iš karto pakeisti jo būseną.

## 3. `solidgate_analytics_outbox` — 15 stulpelių

[Schema ir claim RPC](/Users/Netas/Projects/theastrologist/supabase/migrations/20260716152843_solidgate_webhook_lifecycle.sql:518). Eilučių numeriai žemiau šios migracijos.

| Stulpelis | Tipas; NULL; default | Kam ir kaip naudojamas | Schema |
|---|---|---|---|
| `id` | uuid; ne; gen_random_uuid() | Lokalus outbox row ID; claim ir status update raktas. | 519 |
| `environment` | text; ne; `'production'` | Aplinkos izoliacija dedupe ir worker claim. Sandbox wrapper šiuo metu analytics išvis išjungia. | 520 |
| `event_key` | text; ne; — | Deterministinis verslo įvykio raktas, pvz. konkretaus mokėjimo settlement. Vieną business faktą gali pranešti keli webhookai, todėl negalima dedupe grįsti vien tiekėjo event_id. | 522 |
| `event_name` | text; ne; — | PostHog įvykio pavadinimas, pvz. purchase_completed, subscription event, payment_failed ar identity merge. | 523 |
| `distinct_id` | text; ne; — | PostHog vartotojo / sesijos identifikatorius. Tai analytics tapatybė, nebūtinai `auth.users.id`. | 524 |
| `insert_id` | uuid; ne; — | Stabilus PostHog dedupe UUID, generuojamas iš SHA-256(`solidgate:${eventKey}`) ir pateikiamas kaip uuid bei `$insert_id`. Kartojant nekinta. | 525 |
| `properties` | jsonb; ne; `'{}'::jsonb` | Išplėstinės analytics savybės: suma, valiuta, order/subscription/product ID, vartotojo ir sesijos ryšiai, UTM, aplinka ir kt. JSON forma laisva, CHECK schemos nėra. | 526 |
| `status` | text; ne; `'pending'` | `pending`, `processing`, `completed`, `failed`; tik siuntimo būsena. | 527 |
| `attempts` | integer; ne; `0` | Kiek kartų worker paėmė siuntimui; kiekvienas claim +1, CHECK >=0. Bendro bandymų limito nėra. | 529 |
| `processing_started_at` | timestamptz; taip; — | Analytics siuntimo lease pradžia. Po 300 s processing gali būti vėl paimtas. | 530 |
| `next_attempt_at` | timestamptz; ne; now() | Nuo kada pending/failed gali būti paimtas. Dabartinis failure kelias nustato `now`, t. y. nepritaiko backoff. | 531 |
| `completed_at` | timestamptz; taip; — | Kada worker laikė siuntimą sėkmingu po PostHog shutdown/flush. | 532 |
| `last_error` | text; taip; — | Paskutinio siuntimo/persistinimo nesėkmė; aplikacija trumpina iki 2 000 simbolių. Claim išvalo. | 533 |
| `created_at` | timestamptz; ne; now() | Outbox sukūrimo laikas; claim ima seniausius. Siunčiamas kaip stabilus PostHog event timestamp, kad retry nenusimuštų tiekėjo dedupe. Tai outbox, ne provider event sukūrimo laikas. | 534 |
| `updated_at` | timestamptz; ne; now() | Paskutinis claim / delivery rezultato persistinimas. | 535 |

Raktai: PK id, UNIQUE `(environment,event_key)`, UNIQUE `(environment,insert_id)`. Šie trys ID turi skirtingą paskirtį: DB row, business dedupe, tiekėjo dedupe; nelaikyčiau jų tiesiog nereikalinga kopija. Dalinis delivery indeksas `(environment,next_attempt_at,created_at) WHERE status IN ('pending','failed','processing')`. Claim: `FOR UPDATE SKIP LOCKED`, ne daugiau 100 per call; realus caller prašo 25. RLS; FK nėra; service_role-only ACL.

Rašymas: [enqueueAnalytics](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:312), deterministinis UUID [282 eilutė](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:282). Siuntimas ir žymėjimas [787 eilutė](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:787). Sandbox išjungimas [wrapper](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks-sandbox/index.ts:28).

Konkretūs trūkumai:

1. **Nėra fenced completion/failure:** UPDATE filtruoja tik environment ir id ([820](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:820), [847](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:847)); nėra claim_token ar attempt/generation palyginimo. Sena užsitęsusi užklausa po lease perėmimo gali perrašyti naujo worker rezultatą. Fulfillment lentelėje tai jau išspręsta tokenu.
2. **Viso batch catch vėl pažymi failed net jau užbaigtas to batch eilutes.** Klaida ties vėlesniu completion ar `orders.analytics_captured_at` atnaujinimu nukreipia visą `rows` masyvą į failure loop. Be to, failure update neišvalo `completed_at`, todėl įrašas gali turėti `status='failed'` ir seną completed_at. Stabilus PostHog ID mažina dvigubos analitikos riziką, bet lokali būsenų semantika prastesnė.
3. **Analitika pririšta prie webhook atsakymo ir tiekėjo retry.** `serveRequest` užbaigia business inbox, tada laukia `drainAnalyticsOutbox`; PostHog klaida grąžina Solidgate 500. Visame repo neradau kito šio drain caller. Outbox patvarus, bet nėra nepriklausomo cron, kuris baigtų backlog nustojus ateiti webhookams arba pasibaigus jų redelivery langui. Naujam moduliui perkelti į atskirą worker su backoff + alert/dead-letter.
4. `environment,next_attempt_at,created_at` indeksas ne idealiai atitinka `processing_started_at` stale OR atšaką ir `ORDER BY created_at`. Keičiant optimizuoti tik su realiu EXPLAIN; galima atskirti due pending/failed ir stale processing indeksus / claim queries.

## 4. `solidgate_fulfillment_outbox` — 15 stulpelių

[Originali schema](/Users/Netas/Projects/theastrologist/supabase/migrations/20260721085110_solidgate_oto_durable_fulfillment.sql:525), identiška [corrective reapply schema](/Users/Netas/Projects/theastrologist/supabase/migrations/20260721105000_solidgate_round2_corrective_reapply.sql:538). Stulpelių numeriai žemiau corrective reapply. Galutinis `effect_type` CHECK [20260730160000](/Users/Netas/Projects/theastrologist/supabase/migrations/20260730160000_meta_capi_purchase_fulfillment.sql:14).

| Stulpelis | Tipas; NULL; default | Kam ir kaip naudojamas | Schema |
|---|---|---|---|
| `id` | uuid; ne; gen_random_uuid() | Lokalaus darbo ID; worker status/payload update raktas. | 539 |
| `environment` | text; ne; — | production/sandbox; privaloma pateikti eksplicitiškai, default nėra. Izoliuoja mokėjimą ir darbo vykdymą. | 540 |
| `solidgate_order_id` | text; ne; — | Šį darbą sukėlęs Solidgate mokėjimas. Naudojamas perskaityti source `orders` ir dar kartą patikrinti status, ownership, immutable email/locale. FK nėra. | 542 |
| `effect_type` | text; ne; — | Worker handlerio parinkimas. Galutiniai šeši tipai išvardyti toliau. | 543 |
| `effect_key` | text; ne; — | Semantinis konkretaus veiksmo dedupe raktas. Pvz. `send_welcome_email` arba `cancel_main_subscription:<subscriptionId>`. Su environment/order užtikrina, kad vienam pirkimui tas pats veiksmas nepersistins kelis kartus. | 545 |
| `payload` | jsonb; ne; `'{}'::jsonb` | Veiksmui reikalingi duomenys: subscription_id arba user_id; Meta papildomai fbp/fbc/IP/UA/source URL; welcome worker įrašo stabilų laiško turinį ir ambiguous send laiko žymą. | 546 |
| `status` | text; ne; `'pending'` | `pending`, `processing`, `completed`, `failed`, `manual_review`. Completed gali reikšti sąmoningą no-op (pvz. obsolete/reversed pirkimas ar legacy PDF job). | 547 |
| `attempts` | integer; ne; `0` | Kiek kartų paimtas darbui, kiekvienas claim +1; backoff ir kai kurių effect specialių limitų pagrindas. | 549 |
| `claim_token` | uuid; taip; — | Unikalus dabartinio worker nuomos tokenas. Tik processing turi tokeną; kiekvienas claim pakeičia UUID. Kiekvienas worker update tikrina šį tokeną. | 550 |
| `processing_started_at` | timestamptz; taip; — | Lease pradžia, realus worker naudoja 120 s; užstrigęs processing po to paimamas iš naujo. | 551 |
| `next_attempt_at` | timestamptz; ne; now() | Backoff nustatytas kito bandymo laikas. Aplikacijos formulė 5 × 2^min(attempts,8) sekundžių, t. y. faktinė riba 1 280 s ≈21 min 20 s (išorinė min(1800,...) čia nepasiekiama). | 552 |
| `completed_at` | timestamptz; taip; — | Sėkmingo veiksmo arba sąmoningo no-op užbaigimo laikas. | 553 |
| `last_error` | text; taip; — | Paskutinė klaida iki 2 000 simbolių, įskaitant manual_review priežastį. Claim / sėkmingas completion išvalo. | 554 |
| `created_at` | timestamptz; ne; now() | Darbo sukūrimo laikas; claim ima seniausius, tada rikiuoja pagal id. | 555 |
| `updated_at` | timestamptz; ne; now() | Claim, payload paruošimo, owner patikrinimo, rezultato paskutinis laikas; nėra lease heartbeat, nes `assertClaimOwned` atnaujina updated_at, ne processing_started_at. | 556 |

Galutiniai effect tipai ir jų atskyrimas:

| effect_type | Dabartinis veiksmas | Boilerplate |
|---|---|---|
| `cancel_main_subscription` | OTO1 lifetime pirkimas pakeičia pasikartojančią prenumeratą; atšaukiamos visos atitinkamos main prenumeratos | Pasirenkamas produkto billing policy adapteris |
| `deliver_oto_pdfs` | **Nebevykdomas**: worker užbaigia kaip no-op, kad seni darbai nesiųstų laiškų; PDF prieiga per app entitlements | Švarioje DB nereikalingas legacy tipas |
| `send_welcome_email` | Per-purchase access laiškas; stabilus turinys, Resend idempotency key, ambiguous send/manual review mechanizmas | Pasirenkamas notifications adapteris |
| `enrich_main_profile` | Projekto pirkėjo profilis, quiz duomenys, onboarding | Projekto adapteris, ne payments branduolys |
| `sync_activecampaign_buyer` | ActiveCampaign buyer žymėjimas | CRM adapteris |
| `send_meta_capi_purchase` | Server-side Meta Purchase arba StartTrial | Marketingo adapteris |

Raktai: PK id; UNIQUE `(environment,solidgate_order_id,effect_key)`; CHECK environment, effect_type, status, attempts>=0 ir **`(status='processing') = (claim_token IS NOT NULL)`**. Dalinis delivery indeksas `(environment,next_attempt_at,created_at) WHERE status IN ('pending','failed','processing')`. Claim `FOR UPDATE SKIP LOCKED`; DB max 50, default 10; aplikacija realiai default 5. RLS, service role ACL, jokių browser policies. FK į orders nėra; worker source patikrinimas yra aplikacijos kontrolė, ne DB referencinis ryšys.

Dabartinis [worker](/Users/Netas/Projects/theastrologist/apps/funnel/src/lib/payment/solidgate-fulfillment.ts:946) leidžia atskirus darbus lygiagrečiai; vienam effect 20 s timeout. [Fenced update](/Users/Netas/Projects/theastrologist/apps/funnel/src/lib/payment/solidgate-fulfillment.ts:590) filtruoja environment/id/processing/token. [Welcome patvarus turinys ir idempotency](/Users/Netas/Projects/theastrologist/apps/funnel/src/lib/payment/solidgate-fulfillment.ts:786). [Legacy PDF no-op](/Users/Netas/Projects/theastrologist/apps/funnel/src/lib/payment/solidgate-fulfillment.ts:645).

Paleidimas: webhook best-effort wake; grant/charge-oto keliai; atskiras [autorizuotas endpointas](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/internal/solidgate-fulfillment/route.ts:8); [cron kas 5 min](/Users/Netas/Projects/theastrologist/apps/funnel/vercel.json:3). Šis worker kartu paleidžia ir subscription-token-sync worker.

Vertinimas: claim fencing ir per-effect retry yra gerai. Bendras generic failure bandymų limitas nėra: Meta turi 24 attempts arba per seno event manual-review atvejį, welcome turi 23 val. ambiguous siuntimo saugos langą, tačiau kitos nuolatinės klaidos lieka kartojamos neribotai. Naujam moduliui reikia eksplicitiško retryable/permanent error kontrakto, alertų ir rankinio resume/replay API.

Vienoje eilėje yra ir finansinis billing veiksmas (subscription cancel), ir marketingo darbai. Naujam moduliui verta bendras queue primitives išlaikyti bendras, o registruojamus effect handlerius, retry policy ir galbūt prioritetą/destination atskirti. Nebūtina saugoti dviejų beveik identiškų outbox implementacijų; galima turėti vieną patikimą infrastruktūrą, kelias logines eiles. Abu sprendimai teisėti — svarbiau vienodas fencing ir nepriklausomas vykdymas.

## 5. `meta_capi_event_claims` — 7 stulpeliai; neprivaloma payments moduliui

[Schema](/Users/Netas/Projects/theastrologist/supabase/migrations/20260716153452_meta_capi_ingress_guard.sql:6). Tik frontend CAPI bridge; fulfillment Meta worker šios lentelės nenaudoja, jis turi savo outbox dedupe ir tą patį Meta business event ID.

| Stulpelis | Tipas; NULL; default | Paskirtis | Schema eilutė |
|---|---|---|---|
| `id` | bigint; ne; GENERATED BY DEFAULT AS IDENTITY | Lokalios claim eilutės PK, DB sugeneruojamas numeris. | 7 |
| `environment` | text; ne; — | **Vercel / analytics aplinka:** production/preview/development; tai skirtinga aibė nuo payments production/sandbox. | 8 |
| `event_name` | text; ne; — | Meta event vardas; su event_id ir environment deduplikuoja. | 9 |
| `event_id` | text; ne; — | Naršyklės / serverio bendras semantinis Meta dedupe ID, pvz. `purchase:<orderId>`. | 10 |
| `ip_hash` | text; ne; — | Hashed IP rate-limit raktas. RPC serializuoja vieno environment/IP claim per advisory xact lock ir skaičiuoja priimtus įvykius per langą. | 11 |
| `session_id` | uuid; taip; — | Ryšys į `sessions.id`, DELETE SET NULL. Suteikia claim kontekstą; ištrynus sesiją pats claim išlieka. | 12 |
| `created_at` | timestamptz; ne; now() | Rate-limit lango ir 30 dienų retention pagrindas. | 13 |

PK id; UNIQUE `(environment,event_name,event_id)`; indeksai `(environment,ip_hash,created_at DESC)` ir `(created_at)`. RLS be public politikų. `claim_meta_capi_event` yra SECURITY DEFINER, bet execute PUBLIC atimtas ir suteiktas tik service_role. Browser kviečia [API maršrutą](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/meta/capi/route.ts:175), o ne tiesiogiai RPC; route naudoja 40 events/600 seconds. Dublikatas ir rate limit grąžina tą patį accepted=false.

Optimizavimas: [RPC kiekvieno claim metu daro bendrą DELETE senesniems nei 30 dienų](/Users/Netas/Projects/theastrologist/supabase/migrations/20260716153452_meta_capi_ingress_guard.sql:55). Esant didesnei apkrovai cleanup perkelti į periodinį batched job; retention indeksas jau yra. Nepavykus siuntimui route [ištrina claim](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/meta/capi/route.ts:212), tačiau nepatikrina DELETE klaidos; likęs claim gali blokuoti browser retry. Be to, čia nėra processing lease: proceso žūtis tarp claim ir send palieka claim, todėl ši lentelė nepakeičia durable outbox. Payments core jos nereikia.

## 6. `stripe_webhook_events` — 3 stulpeliai; legacy

[Vienintelė schema](/Users/Netas/Projects/theastrologist/supabase/migrations/00035_stripe_webhook_events.sql:9).

| Stulpelis | Tipas; NULL; default | Paskirtis | Schema eilutė |
|---|---|---|---|
| `event_id` | text; ne; — | Stripe event ID, PK; seno insert-only claim dedupe raktas. | 10 |
| `type` | text; ne; — | Stripe įvykio tipas diagnostikai/dispatch. | 11 |
| `received_at` | timestamptz; ne; now() | Pirmo claim gavimo laikas, retention indeksui. | 12 |

Indeksas `idx_stripe_webhook_events_received_at(received_at)`; RLS įjungtas be policies. Schema neturi aplinkos, payload, lease, rezultatų, retry history. Migracijos komentare aprašytas INSERT claim / DELETE on failure modelis, tačiau visoje dabartinėje repo aktyvaus lentelę skaitančio/rašančio Stripe handlerio neradau — ji minima migracijose, generated types ir dokumentuose. Į naują Solidgate-only modulį nekelti; esamame projekte lentelės trynimas būtų atskiras sprendimas pagal istorinių duomenų poreikį.

## Bendros architektūros išvados su įrodymais

1. **Outbox įrašymas nėra viena transakcija su domeno pakeitimu.** Webhook iš pradžių [suteikia entitlement](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:2963), tuomet atskirais HTTP/DB veiksmais [enqueue main / lifetime / analytics](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:2993), o dar vėliau [complete inbox](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:4680). Idempotentiškas handleris ir pakartotinis tiekėjo pristatymas daug tokių langų sutvarko, tačiau tai nėra transakcinio outbox garantija. Crash tarp entitlement ir enqueue palieka suteiktą prieigą be patvaraus billing/notification darbo iki sėkmingo retry. Naujam moduliui vienas RPC turėtų domeno state transition ir outbox INSERT užbaigti vienoje transakcijoje; išorinis siuntimas lieka worker'yje.
2. **Vienas inbox retry nėra duomenų bandymų istorija.** `attempts`, paskutinė klaida ir payload perrašomi; jei reikia audito po kelių mėnesių, papildomas struktūrinis attempt log/observability arba append-only event archyvas turi būti sąmoningas reikalavimas, ne savaiminė šios schemos savybė.
3. **Inbox patvarus, bet savarankiško recovery worker trūksta.** Neradau kodo, kuris periodiškai skaitytų failed/stale inbox payload ir iš naujo apdorotų; tinkamas indeksas jau yra. `received_at` stebėjimas tik parodo gavimą, ne sėkmingą apdorojimą. Reikia oldest failed/stale, processing age, queue lag ir manual_review monitoringo.
4. **Žali webhook payload gali laikyti daugiau jautrių duomenų nei reikia ilgam laikui.** `serveRequest` persistina visą body, o toje pačioje callback schemoje yra reusable `card_token` ([parser](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:1496)). Iš šių šešių lentelių automatinis TTL yra tik Meta claims. Inbox/outbox retention, archyvavimas ir payload/token redakcija nėra įgyvendinti šiame repo. Naujam moduliui nustatyti, ką reikia replay, ką verta saugoti tik trumpai, ir kiek laiko saugomas dedupe tombstone; retention skaičius turi būti parinktas pagal tiekėjo replay ir verslo poreikius.
5. **Nereikia paveldėti konkretaus projekto poveikių.** CRM, quiz/profile, welcome, Meta ir PDF yra už payments branduolio ribos. `effect_type` CHECK su konkrečiais pavadinimais riboja moduliškumą: kiekvieno projekto adapteriui reikia schema deploy. Galimas stabilus domain event + išorinių subscriber'ių modelis arba aiškiai registruojamas outbox handlerių rinkinys.
6. **Dispute alertai nepatenka į outbox.** [sendDisputeAlert](/Users/Netas/Projects/theastrologist/supabase/functions/solidgate-webhooks/index.ts:1395) Slack klaidą tik logina. Inbox gali būti completed, nors alertas nepasiektas. Jei dispute pranešimas yra operacinis reikalavimas, padaryti jį patvariu efektu.
7. **Dviejų enqueue implementacijų semantika dubliuojasi.** Webhook `enqueueOtoFulfillment` / `enqueueMainPurchaseEnrichment` ir Next.js `enqueueCapturedOtoFulfillment` / `enqueueMainPurchaseEnrichment` atskirai konstruoja tuos pačius key/payload. Dedupe veikia, bet taisant produkto sąlygas reikia abiejų runtime. Bendras grynas effect factory arba DB domeno tranzicija su outbox mažintų drift riziką.
8. **Kai kurie `ignoreDuplicates` tyčia užfiksuoja pirmą payload.** Meta atveju webhook gali pirmas įrašyti tik user_id, tuomet browser/grant su geresne fbc/fbp informacija ignoruojamas ([grant komentaras](/Users/Netas/Projects/theastrologist/apps/funnel/src/lib/payment/solidgate-fulfillment.ts:249)). Tai aiškus esamos implementacijos tradeoff, ne finansinės tiesos klaida; jei attribution svarbi, saugiai papildyti dar neišsiųstą payload su claim/status kontrole.
9. **Optimali schema nėra mažiausias stulpelių skaičius.** Dedupe, lease, retry, aplinka, rezultatas ir stabilūs provider idempotency key yra reikalingos garantijos. Realus supaprastinimas: pašalinti legacy v1/Stripe/PDF, izoliuoti adapters, sutvarkyti transakcines ribas ir vienodą worker patikimumą. Indeksų/JSONB talpos tuning reikia apkrovos ir EXPLAIN; tokie duomenys šiame lokaliame audite nesurinkti.

## Minimalūs dokumentacijos punktai agentui, kuris perkelia šią dalį

- Atskirk provider `event_id`, `order_id`, `subscription_id` ir vidinį UUID; nededuplikuok verslo efekto vien provider event ID.
- Nurodyk kiekvieno status priklausomybę: inbox status ≠ mokėjimo status ≠ outbox status.
- Aprašyk at-least-once pristatymą, claim tokenus, lease expiry ir monotoniškas domeno tranzicijas. Išorinis side effect su retry netampa absoliučiai exactly-once vien dėl UNIQUE indekso.
- Nurodyk, kur naudojama provider aplinka production/sandbox, o kur deployment aplinka production/preview/development.
- Domain update + outbox INSERT turi būti viena DB transakcija; išorinį API kvietimą vykdyti vėliau.
- Cron / worker deploy yra būtina setup dalis: vien lentelės su next_attempt_at nieko nevykdo.
- Atskirai dokumentuok retryable klaidas, permanent klaidas, maksimalų amžių / attempts, manual_review ir saugų replay nešalinant dedupe įrašų.
- Aiškiai nurodyk RLS/GRANT/RPC EXECUTE ir server-only prieigą; payload gali turėti tokenų / asmens duomenų.
- Į naują švarią DB kelk galutinę schemą ir aktyvius RPC, ne corrective reapply, istorinį sandbox backfill ir senų deploy suderinamumą.

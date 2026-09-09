# Solidgate branduolio, prieigos ir senų Stripe lentelių auditas

[Architektūros vertinimas ir naujo boilerplate rekomendacijos](boilerplate-architecture-audit.lt.md).

Patikrinta lokaliai 2026-09-09 (įskaitant dabartinius necommitintus pakeitimus): visos `supabase/migrations/*.sql` iki `20260908110000_wave2_currency_amounts.sql`, aktualūs programos skaitymai/rašymai ir sugeneruoti DB tipai. Tai repozitorijos deklaruojama schema; veikiančios Supabase DB, migracijų pritaikymo, realių eilučių, indeksų naudojimo ir užklausų planų netikrinau. API / generavimo išlaidų nepatirta.

Apimtis: 9 lentelės, 146 stulpeliai. `orders` 39; `renewal_events` 21; `solidgate_invoice_orders` 20; `entitlements` 15; `sessions` 20; `payment_intent_sessions` 3; `stripe_customers` 10; `user_acquisition_attribution` 12; `funnel_events` 6.

## Esminė išvada

Pagrindinės dabartinės idėjos geros: prieš tiekėjo iškvietimą sukuriamas savas užsakymas; mokėjimas ir prieiga atskirti; sandbox/production įtraukti į raktus; tapatybės snapshot užrakinamas DB; pakartotinius užklausų ir callback atvejus saugo RPC, užraktai ir indeksai. Vis dėlto dabartinių migracijų kopija nėra švarus modulis: likę Stripe laukai ir lentelės, viename `orders.status` sumaišytas mokėjimas ir prenumerata, produktų kodai / lokalės / kainos įsiūti į SQL, bendroje `sessions` lentelėje sumaišytas quiz, sutikimai ir checkout progresas.

`orders`, `renewal_events` ir `solidgate_invoice_orders` nėra trys identiškos užsakymų kopijos:

- `orders`: mūsų aplikacijos inicijuotas pirmasis pirkimas / OTO / PWA pirkimas ir jo vietinis patikimas susiejimas. Čia gali būti daug nepavykusių bandymų. Tai nėra kiekvieno periodinio nurašymo lentelė.
- `solidgate_invoice_orders`: Solidgate prenumeratos invoice → vieno ar kelių provider order/bandymų žemėlapis; būtinas atpažinti vėliau atėjusius refund / chargeback / order callback, kurių ID `orders` nėra.
- `renewal_events`: vienas įrašas už sėkmingą pratęsimo invoice; naudojamas pajamų projekcijai, vėliau koreguojamas refund/dispute. Nepaisant pavadinimo, tai mutabili suvestinė, ne nekintamas įvykių žurnalas.
- `entitlements`: ką vartotojas dabar gali naudoti; sėkmingo mokėjimo pasekmė, ne mokėjimo įrodymo pakaitalas.

Naujame boilerplate rekomenduoju aiškias `payment_orders` / `payment_attempts`, `subscriptions`, `invoices`, `entitlements` atsakomybes. Pagal vartotojo perduotą tiesioginę Solidgate rekomendaciją naudojame **API v1 / Billing 1.0**; v2 paliekamas atskiram būsimam sandbox tyrimui. Siūlomos lentelės yra vietinio domeno modelis ir nereikalauja v2 API. Invoice-order žemėlapio negalima šalinti prieš perkeliant jo funkciją.

## Šaltinių žymėjimas

Žemiau `I:96` reiškia konkretaus failo 96 eilutę. Visi keliai nuo repozitorijos šaknies `/Users/Netas/Projects/theastrologist`.

| Žyma | Failas |
|---|---|
| I | `supabase/migrations/00001_initial.sql` |
| R | `supabase/migrations/00031_renewal_events.sql` |
| SG | `supabase/migrations/00039_solidgate_columns.sql` |
| L | `supabase/migrations/20260716152843_solidgate_webhook_lifecycle.sql` |
| A | `supabase/migrations/20260716173032_solidgate_identity_acquisition.sql` |
| ID | `supabase/migrations/20260721124000_solidgate_payment_identity.sql` |
| O | `supabase/migrations/20260721105000_solidgate_round2_corrective_reapply.sql` |
| STEP | `supabase/migrations/20260721124500_solidgate_oto_step_hardening.sql` |
| REPORT | `supabase/migrations/20260824120000_solidgate_reporting_metadata_shape.sql` |
| LOCALE | `supabase/migrations/20260907120000_wave2_locales.sql` |
| W | `supabase/functions/solidgate-webhooks/index.ts` |
| E | `packages/shared/src/entitlements.ts` |
| S | `apps/funnel/src/app/api/session/persist/route.ts` |
| ACCT | `packages/shared/src/auth/claim-purchase.ts` |
| REVENUE | `apps/funnel/src/app/admin/_queries/revenue.ts` |

Tipai: `?` leidžia SQL `NULL`, be `?` = `NOT NULL`; `= ...` = DB default. `timestamptz` yra laiko momentas su timezone semantika, `integer` yra 32 bitų sveikasis. „Palikti“ reiškia išsaugoti funkciją naujame modulyje, nebūtinai tą patį pavadinimą ar lentelę. „Neperkelti“ taikoma NAUJAM Solidgate-only boilerplate, ne istorinių production duomenų trynimui.

## 1. `orders` — 39 stulpeliai

Schema I:96, SG:15, `00032_orders_updated_at_trigger.sql:19`, `00041_orders_analytics_captured.sql:17`, L:237–289, A:52, O:24, ID:13–80. Checkout opener įrašo eilutę per RPC (pvz. REPORT:285); signed provider callback ją suranda pagal `(payment_environment, solidgate_order_id)` (W:2378).

| Stulpelis | Tipas / default | Kur, kam ir kaip naudojamas; sprendimas naujam moduliui |
|---|---|---|
| `id` | uuid = gen_random_uuid() | Vidinis pirminis raktas. Entitlement, checkout state ir fulfillment remiasi juo; I:97, REPORT:752. **Palikti**. |
| `session_id` | uuid? FK sessions, DELETE CASCADE | Anoniminio funnel pirkimo ryšys; PWA pirkimai gali turėti NULL; I:98, REPORT:305, W:2087. **Palikti kaip pasirenkamą ryšį, keisti CASCADE į SET NULL / aiškią retention politiką**. |
| `user_id` | uuid? FK auth.users, DELETE SET NULL | Kam priklauso mokėjimas; iki account susiejimo NULL, claim užpildo (ACCT:108). RLS naudoja savininkui skaityti (I:127). **Palikti**, numatyti atskirą billing customer identitetą nuo auth. |
| `stripe_checkout_session_id` | text? | Istorinis Stripe Checkout ID; indeksas I:122. Aktyvaus Solidgate rašytojo nerasta. **Neperkelti**. |
| `stripe_payment_intent_id` | text?, UNIQUE | Istorinis Stripe mokėjimo ID; I:102; likęs union `provision-account.ts:29`. Solidgate jį pakeičia savas order binding. **Neperkelti**. |
| `stripe_subscription_id` | text?, UNIQUE | Stripe prenumeratos istorija; admin cohort tebenaudoja `admin/_queries/subscriptions.ts:100`. **Neperkelti** Solidgate-only branduoliui. |
| `stripe_dispute_id` | text? | Senas Stripe ginčo ryšys; I:104; aktyvaus rašytojo nerasta. **Neperkelti**. |
| `order_sequence` | integer = 1 | Istorinė pirkimų eilė; I:106. Aktyvūs Solidgate opener neįrašo šio lauko (REPORT:285–316), bandymų numeris užkoduojamas Solidgate order ID. Aktyvaus naudojimo nerasta. **Neperkelti** arba aiškiai pervadinti į realų `attempt_number`. |
| `amount_cents` | integer | Atidarant yra prašoma suma (REPORT:308), po refund — neto suma (W:2428), po void — 0 (W:2477); admin sumuoja (REVENUE:25,55). **Keisti**: atskiri immutable requested/gross ir aiškūs net/refund dydžiai; tai ne vien „kaina“. |
| `currency` | text = 'eur' | Sumos valiuta, perduodama checkout ir analitikai; REPORT:309, W:2455. **Palikti**, normalizuoti ir tikrinti valiutos kodą, dokumentuoti provider mažiausius vienetus. |
| `status` | text = 'pending', CHECK | Leidžiama pending/completed/failed/refunded/disputed/trialing/active/past_due/canceled (I:109). Mokėjimo ir prenumeratos būsena viename lauke. W:2427,4379; E:67–78. **Skaidyti** payment state ir subscription state; išvengti netiesioginių finansinių išvadų iš lifecycle. |
| `product_name` | text | Pirkimo metu išsaugotas pavadinimas / reporting code (REPORT:310). Legacy entitlement lookup remiasi atvirkštiniu vardų žemėlapiu (E:19–40). **Palikti kaip snapshot**, nenaudoti kaip produkto rakto. |
| `product_slug` | text? | Solidgate kelyje dažnai company code (`THEASTRL_...`), nors pavadinimas žada canonical slug; lookup/brand guard W:2404; canonical konversijos E:25–32. **Keisti į aiškų stable `product_key` ir atskirą `reporting_code`**, naujiems užsakymams NOT NULL. |
| `claimed_at` | timestamptz? | Kada order priskirtas prisijungusiam naudotojui (ACCT:108, W:2918). **Palikti, jei anonymous checkout**; tai ne apmokėjimo laikas. |
| `created_at` | timestamptz = now() | Vietinio order atidarymo momentas, bandymų tvarka, acquisition ir admin kohortos (REPORT:336, REVENUE:29). **Palikti**, finansams pridėti `paid_at`, nes order sukūrimas ≠ atsiskaitymas. |
| `updated_at` | timestamptz = now() | `00032` BEFORE UPDATE trigger automatiškai keičia kiekvieną kartą; nėra „prenumerata atšaukta kada“ laukas. **Palikti**, lifecycle datoms naudoti atskirus laukus / events. |
| `psp` | text = 'stripe' | Atkiria istorinius PSP; Solidgate opener įrašo solidgate (REPORT:302). Identity trigger neleidžia pakeisti Solidgate PSP (LOCALE:71). **Pervadinti `provider`, default solidgate / privalomas, CHECK**; seno default neperkelti. |
| `solidgate_order_id` | text? | Merchant/provider order ID, callback trust anchor; W:2382. Unikalus su aplinka L:268. **Palikti kaip provider ID**, nesupainioti su vidiniu uuid. |
| `solidgate_subscription_id` | text? | Užsakymo sukurtos prenumeratos provider ID; atnaujinamas callback bind; W:3270, renewal parent lookup W:2089. Unikalus su aplinka L:272. **Perkelti prenumeratos ryšį į `subscriptions`**, išsaugant original order ryšį. |
| `analytics_captured_at` | timestamptz? | W:832 užpildo po pirmo užbaigto analytics outbox įvykio su order ID. Tai nėra garantija, kad išsiųsti VISI order analytics įvykiai. **Nebūtinas core**; outbox turi atskiro delivery status. |
| `payment_environment` | text = 'production', CHECK production/sandbox | Atskira ledger, tapatybės, subscription ir callback erdvė L:261,W:2381. **Palikti visų provider raktų dalimi**, dar geriau atskiros DB aplinkos; vengti tylaus production default. |
| `solidgate_original_amount_cents` | integer? | Originali bruto / autorizuojama suma, naudojama canonical checkout ir refund skaičiavimui (REPORT:312, W:2416). **Palikti kaip provider-neutral `original_amount_minor` / `requested_amount_minor`, naujiems NOT NULL**. |
| `solidgate_refunded_amount_cents` | integer = 0, CHECK ≥0 | Kaupiamas refund dydis (W:2418,2430); apsaugo pakartotinį skaičiavimą ir terminal grant. **Palikti** kaip atskirą finansinę sumą arba išvesti iš operacijų ledger. |
| `solidgate_payment_status` | text? | Žalia provider būsena + mūsų tarpinės `creating`, `request_rejected` būsenos; REPORT:313, STEP:287; callback W:2431. **Palikti raw provider status, vietines attempt būsenas laikyti atskirai**. |
| `solidgate_chargeback_id` | text? | Dabartinio ginčo provider ID (W:4382); stabdo naują grant (REPORT:684). **Palikti**, daugeliui ginčų/operacijų geriau atskira disputes lentelė. |
| `solidgate_chargeback_status` | text? | Ginčo būsena (W:4383), naudojama reversal ir access sprendimui. **Palikti** disputes/projection modelyje. |
| `solidgate_chargeback_amount_cents` | integer = 0, CHECK ≥0 | Ginčo suma (W:4384); mažina neto, reversal atstato (W:4373). **Palikti**, aiški valiuta ir sumų modelis. |
| `solidgate_pre_dispute_status` | text? | Kokią sumaišytą order būseną grąžinti po chargeback reversal (W:4376,4388). **Dabartiniame modelyje būtinas**, atskyrus mokėjimą ir prenumeratą gali nebereikėti. |
| `tracking_metadata` | jsonb = '{}' | Serverio išvalytas checkout / produkto / UTM snapshot; kartu yra canonical checkout ir identity įrodymo dalis (A:52; W:2407; REPORT:316). **Skaidyti patikimą checkout snapshot nuo optional marketing**, pagrindinius tapatybės/kainos laukus daryti typed. |
| `solidgate_verify_url` | text? | Išlikusi 3DS challenge nuoroda resume veiksmui (O:22–25); nuvaloma settlement (W:2747). **Palikti tik jei toks flow**, geriau payment_attempt/current_action struktūroje, su galiojimu. |
| `solidgate_submission_token` | uuid? | Konkretaus užklausos vykdytojo lease/fencing token, ne kortelės token (REPORT:314,340). Terminal callback nuvalo (W:2432). **Palikti attempt lease modelyje**, dokumentuoti skirtumą nuo recurring token. |
| `solidgate_submission_started_at` | timestamptz? | Kada prasidėjo tiekėjo užklausos bandymas; stale lease/perėmimas (REPORT:336–345); W:2433 nuvalo. **Palikti** attempts struktūroje. |
| `solidgate_customer_email` | text? | Normalizuotas nebekeičiamas checkout email (ID:31; LOCALE:41–43,77); vėlesnis profile email jo nekeičia. **Palikti snapshot**. |
| `solidgate_checkout_locale` | text? | Nekeičiama to konkretaus atsiskaitymo kalba (ID:33; LOCALE:44–49). Dabartinė CHECK leidžia 32 lokales, ne tik 15. **Palikti**, leidžiamų lokalių registrą konfigūruoti. |
| `solidgate_product_id` | text? | Provider produkto UUID, fiksuotas prieš subscription checkout (ID:35); vienkartiniams gali būti NULL. **Palikti provider price/product snapshot**, ne business slug. |
| `solidgate_payment_action` | text? | auth_settle / auth_0_amount; fiksuota užsakymo autorizavimo semantika (LOCALE:50). **Palikti** attempts/checkout snapshot. |
| `solidgate_checkout_identity_bound_at` | timestamptz? | Kada email/locale/action snapshot patikimai surištas (ID:39); naujiems Solidgate CHECK/trigger reikalauja. **Palikti arba užtikrinti atominį NOT NULL snapshot be atskiro flag**. |
| `solidgate_checkout_identity_legacy` | boolean = false | Iki snapshot migracijos sukurtų istorinių order karantino žyma (ID:21–28); pažymėtiems negalima suteikti naujos prieigos be reconciliation. **Naujame tuščiame boilerplate neperkelti istorinio compatibility kelio**. |
| `solidgate_card_source_sequence` | bigint = nextval(sequence) | Monotoniška kortelės šaltinio generacija; užsakymus su tuo pačiu timestamp vis tiek galima vienareikšmiškai surikiuoti (ID:44–80). Naudojama session/account vault apsaugoti nuo seno token callback. **Palikti jei vaulted card keitimas / asinchroniniai callback**, susieti su payment instrument versija. |

Svarbūs DB invariantai: PK `id`; UNIQUE Stripe IDs (legacy); UNIQUE `(payment_environment, solidgate_order_id)` ir `(payment_environment, solidgate_subscription_id)` tik kai ID ne NULL; FK į session/user; status ir environment CHECK; nonnegative refund/chargeback. Naujiems Solidgate order tapatybę ir canonical kainą saugo ir trigeriai, ne vien stulpelių CHECK. Main / PWA / OTO opener su advisory lock stabdo paralelinį apmokestinimą. OTO partial UNIQUE `(environment, session, product→step)` galutinai neleidžia dviejų dar mokėtinų tos pačios OTO pakopos order (STEP:275–289). Šios apsaugos negalima išmesti vien „mažinant lentelių skaičių“.

Indeksai: session_id, user_id, Stripe checkout ID; `idx_orders_solidgate_oto_open` `(environment,session_id,product_slug,created_at DESC,id DESC)` dalinis (O:29); PWA ekvivalentas su user_id (`20260721105632...:60`); OTO live-step unique. Admin laiko filtrams nėra atskiro bendro `(payment_environment,created_at)` indekso; prieš įdiegiant tikrinti tikrą `EXPLAIN` ir apimtį. Laiko intervalų agregavimą verta vykdyti DB, o ne siųsti visas eilutes į TS.

## 2. `renewal_events` — 21 stulpelis

R:13, SG:81–97, L:301–369, `20260818210000_renewal_events_upsertable_invoice_key.sql:14`. Dabartinis callback rašo patvirtintą invoice, kai term ≥1 ir suma >0 (W:3915); periodinis pinigų mokėjimas nėra naujas `orders` įrašas.

| Stulpelis | Tipas / default | Paskirtis, realus naudojimas ir sprendimas |
|---|---|---|
| `id` | uuid = gen_random_uuid() | Vietinis ledger PK (R:14). **Palikti**, jei invoice modelis gauna savo uuid. |
| `stripe_invoice_id` | text?, UNIQUE | Legacy Stripe invoice dedupe (R:15, SG:81). **Neperkelti**. |
| `stripe_subscription_id` | text? | Legacy Stripe prenumeratos ryšys (R:16, SG:82); admin cohort. **Neperkelti**. |
| `stripe_customer_id` | text? | Legacy Stripe customer (R:17). **Neperkelti**. |
| `amount_cents` | integer, CHECK ≥0 | Dabartinė neto pratęsimo suma; W:3926 nustato, W:2181 refund koreguoja, REVENUE:42 sumuoja. **Aiškiai pervadinti net amount / perkelti į invoices projection**. |
| `currency` | text | Invoice valiuta iš callback/product/original order; W:3869,3930. **Palikti**. |
| `product_key` | text? | Atkeliauja `orders.product_slug`, kartais reporting code, ne canonical key (W:3931); admin filtrai. **Suvienodinti su produkto registru / FK**. |
| `created_at` | timestamptz = now() | Writer gali įrašyti PROVIDER invoice sukūrimo laiką (W:3934), kitaip įrašymo laikas. Admin laiko grafikas (REVENUE:44). **Keisti** į atskirus `created_at` (DB) ir `invoice_created_at` / `paid_at`, nemaišyti. |
| `solidgate_invoice_id` | text? | Vieno invoice dedupe raktas su aplinka (W:3936). **Palikti NOT NULL Solidgate-only invoices**. |
| `solidgate_subscription_id` | text? | Prenumeratos ryšys (W:3923). **Palikti, geriau vidinis subscription FK + provider ID**. |
| `payment_environment` | text = production, CHECK | Izoliuoja sandbox / production (W:3921). **Palikti visų provider raktų dalimi**. |
| `solidgate_order_id` | text? | Sėkmingo invoice payment order ID (W:3924), unikalus su aplinka. Nepavykę kiti bandymai lieka invoice_orders. **Palikti payment-attempt ryšį**, nebūtinai stulpelis invoices. |
| `subscription_term_number` | integer? | Billing ciklo numeris; term 0 initial, ≥1 renewal (W:3874,3915). **Palikti provider cycle index**, aiškiai aprašyti trial semantics. |
| `status` | text = paid, CHECK | paid/partially_refunded/refunded/disputed/chargeback_reversed/voided (L:352); W:2183,2219,4511. **Palikti typed invoice/payment projekcijoje**. |
| `gross_amount_cents` | integer? | Bruto before corrections (W:3927), refund/chargeback bazė (W:2178,4493). **Palikti NOT NULL naujiems**, original sums nekaitalioti. |
| `refunded_amount_cents` | integer = 0, CHECK ≥0 | Kaupiamas invoice refund (W:2182). **Palikti** arba išvesti iš atskiro operations ledger. |
| `chargeback_id` | text? | Ginčo provider ID (W:4512). **Palikti disputes ryšį**. |
| `chargeback_status` | text? | Ginčo būsena (W:4513). **Palikti disputes / projection**. |
| `chargeback_amount_cents` | integer = 0, CHECK ≥0 | Ginčijama suma (W:4514). **Palikti**. |
| `invoice_created_at` | timestamptz? | Pirminis provider invoice timestamp (W:3932). **Palikti**, neprilyginti sumokėjimo momentui. |
| `event_created_at` | timestamptz? | Callback laikas, paskutinės korekcijos kontekstas (W:3933,2184). **Palikti šaltinio auditui**, nėra visa event istorija. |

RLS įjungta, klientų policies nėra (SG:76); server/admin lentelė. CHECK reikalauja tiksliai vieno Stripe arba Solidgate invoice ID (SG:96). Indeksai: created_at; Stripe subscription; Solidgate subscription; UNIQUE `(environment,solidgate_invoice_id)`; partial UNIQUE `(environment,solidgate_order_id)`. **Svarbu: partial invoice indeksas ir PostgREST upsert konflikto problema jau pataisyta 2026-08-18 pilnu UNIQUE constraint.** Nereikia to klaidingai pateikti kaip dar nepašalinto bug.

## 3. `solidgate_invoice_orders` — 20 stulpelių

L:371–413; pagrindinis rašytojas W:3879–3900; order callback W:2137; chargeback W:4474. Vienas invoice turi daug provider order bandymų. Tai aktyvi būtina sąsaja, net jei admin jos tiesiogiai nerodo.

| Stulpelis | Tipas / default | Paskirtis, naudojimas ir sprendimas |
|---|---|---|
| `environment` | text = production, CHECK | Pusė composite PK; W:3884,2139. **Palikti**, suvienodinti pavadinimą į payment_environment visame modulyje. |
| `solidgate_order_id` | text | Kita PK pusė; kiekvieno invoice bandymo provider order ID (W:3885). **Palikti `payment_attempts`**. |
| `solidgate_invoice_id` | text | Kokiam invoice priklauso bandymas (W:3886); pagal tai koreguojamas renewal (W:2174). **Palikti ryšį**. |
| `solidgate_subscription_id` | text | Prenumeratos provider ID (W:3887); pagal jį revoke (W:4522). **Palikti ryšį**. |
| `subscription_term_number` | integer? | Kuris subscription ciklas (W:3888). **Palikti provider snapshot / gauti per invoice**. |
| `status` | text | Žalia provider order būsena; CHECK nėra; W:3889,2154. **Palikti provider_status**, vietinė state atskirai. |
| `amount_cents` | integer = 0, CHECK ≥0 | Provider bandymo suma (W:3890), refund/chargeback bruto fallback (W:4493). **Palikti `amount_minor` su aiškia semantika**. |
| `currency` | text | Bandymo/invoice valiuta (W:3891). **Palikti**. |
| `operation` | text? | Provider operation rūšis iš invoice order (W:3892), šiame kode toliau nevaldo prieigos. **Naudinga auditui**, neprivaloma core logikai. |
| `product_price_id` | text? | Solidgate invoice konkreti price versija arba metadata price ID (W:3893); analytics W:2096. **Palikti price snapshot/ryšį**. |
| `order_metadata` | jsonb = '{}' | Provider invoice metadata snapshot (W:3894); analytics product, UTM, order context (W:2092). **Palikti ribotą provider snapshot**, ne vienintelį tiesos šaltinį autorizacijai. |
| `refunded_amount_cents` | integer = 0, CHECK ≥0 | To provider order kaupiamas refund (W:2164), reikalingas delta skaičiavimui. **Palikti / operations ledger**. |
| `chargeback_id` | text? | Šio provider order ginčo ID (W:4499). **Palikti disputes ryšį**. |
| `chargeback_status` | text? | Ginčo būsena (W:4500). **Palikti**. |
| `chargeback_amount_cents` | integer = 0, CHECK ≥0 | Ginčo suma (W:4501). **Palikti**. |
| `source_created_at` | timestamptz? | Provider order sukūrimo laikas (W:3895). **Palikti auditui**. |
| `source_updated_at` | timestamptz? | Provider order update laikas iš pirmo invoice snapshot (W:3896). Pirmas insert naudoja ignoreDuplicates, vėlesnis order callback šio lauko nekeičia. **Palikti, bet patikslinti atnaujinimo sutartį**. |
| `event_created_at` | timestamptz? | Callback, kuris įrašė / pakeitė map, laikas (W:3897,2155). **Palikti event linkage**. |
| `created_at` | timestamptz = now() | DB įrašo sukūrimas (L:390). **Palikti**. |
| `updated_at` | timestamptz = now() | Writer ranka nustato W:3898,2156; trigger nerastas. **Palikti, patikimai atnaujinti vienu būdu**. |

RLS be browser policies; PK `(environment,solidgate_order_id)`; indeksai `(environment,solidgate_invoice_id)` ir `(environment,solidgate_subscription_id)` (L:408–412). Provider ID ryšiams nėra FK į local subscription/invoice lenteles, nes jų nėra. Naujas normalizuotas modelis gali turėti vidinius FK ir unique provider keys.

**Patvirtintas tipų neatitikimas:** `packages/shared/src/types/database.ts:1362` `solidgate_invoice_orders.Row` neturi `product_price_id` ir `order_metadata`, nors abu stulpeliai yra migracijoje L:381–382 ir aktyviai rašomi W:3893–3894. Vien type failo negalima laikyti pilnu schemos šaltiniu; prieš boilerplate eksportą regeneruoti ir tikrinti typecheck.

## 4. `entitlements` — 15 stulpelių

I:183–209; SG:60; L:475–515; naujausias `prevent_solidgate_entitlement_replay` turinys REPORT:1034 ir papildomos token sync apsaugos kitose migracijose. Įrašas yra dabartinės prieigos projekcija pagal `(environment,user,product)`, ne visa pirkimų istorija.

| Stulpelis | Tipas / default | Paskirtis, naudojimas ir sprendimas |
|---|---|---|
| `id` | uuid = gen_random_uuid() | Vidinis PK, entitlement identitetas (I:184). **Palikti**. |
| `user_id` | uuid, FK auth.users DELETE CASCADE | Kam suteikta prieiga; E:87,131; owner RLS I:207. **Palikti**. |
| `product_slug` | text | Prieigos produktas; E:88,132. Kartais canonical slug, kartais code; E:197 juos konvertuoja. **Keisti į vienareikšmį `entitlement_key`**, kuris gali skirtis nuo komercinio produkto / kainos. |
| `access_level` | text = full | Runtime tipai full/trial/grace (E:48), DB CHECK nėra; grace leidžia past_due laikiną prieigą (E:135). **Palikti su CHECK/konfigūruojama policy**. |
| `status` | text = active, CHECK active/past_due/canceled | Dabartinė prieigos būsena; grant E:95, revoke W:1224. **Palikti**, aiškiai atskirti nuo subscription cancel_at_period_end. |
| `stripe_subscription_id` | text? | Istorinis Stripe šaltinis; E:93. **Neperkelti**. |
| `order_id` | uuid?, FK orders DELETE SET NULL | Koks tikslus order dabar valdo grant; E:90. Revoke pagal exact source order (W:1225–1226), replay guard. **Palikti grant šaltinio ryšį**, istoriją geriau laikyti atskirai. |
| `granted_at` | timestamptz = now() | Suteikimo momentas; E:212 parenka naujausią governing row, E:242 rūšiuoja. Kai kurie upsert jo neatnaujina (E:84–98). **Sutarti first_granted_at vs effective_granted_at**, kad renew/repurchase tvarka būtų vienareikšmė. |
| `expires_at` | timestamptz? | Prieigos pabaiga; NULL reiškia neterminuotą; E:137,207. Subscription dažnai provider next_charge_at; dalis app vartų vien expiry nelaiko revoke. **Palikti su aiškia galiojimo/grace politika**. |
| `revoked_at` | timestamptz? | Atšaukimo tombstone; W:1224, E:136. Senas callback negali paprastai nuvalyti to paties order revoke (replay trigger). **Palikti**, ne vien ištrinti entitlement. |
| `source` | text? | Kas suteikė (`claim`, webhook, pirkimo kelias); E:92, ACCT:131. **Palikti aiškų enum / event reference**. |
| `created_at` | timestamptz = now() | Pirmos eilutės sukūrimas (I:196). **Palikti**. |
| `updated_at` | timestamptz = now() | Kai kurie writer atnaujina E:97; revoke W:1224 jo nerašo ir nėra bendro trigger. **Palikti + centralizuoti trigger/rašymą**; šiuo metu nebūtinai atspindi paskutinį būsenos pasikeitimą. |
| `solidgate_subscription_id` | text? | Prenumeratos, kuri palaiko šią prieigą, ID; E:94, revoke W:1241. **Palikti subscription FK/ryšį**, nullable vienkartiniam grant. |
| `payment_environment` | text = production, CHECK | Atskiria sandbox grant nuo production (E:86,130). **Palikti**, nebūtinas tik jei DB fiziškai atskiros ir tai enforce. |

PK `id`; UNIQUE `(payment_environment,user_id,product_slug)` (L:510). Indeksai user; `(user,status,expires_at)`; `(environment,subscription_id)` partial; `(environment,order_id)` partial (O:565). Vienas komercinis order dabartiniuose helper dažnai traktuojamas kaip vienas entitlement (`maybeSingle`, W:1203); universaliam moduliui vienas produktas gali suteikti kelias teises, todėl reikia aiškios 1:N sutarties.

**Svarbi elgsena, kuri neturi būti tylus boilerplate default:** E:190–195 DB klaida grąžina `active`; E:200 / 215 be aktyvaus entitlement gali grąžinti `none`; app layout draudžia tik `revoked`. Tai sąmoningas esamo produkto prieinamumo sprendimas, bet naujam mokamam produktui reikalingas aiškus `pending provisioning`, ribotas grace ir klaidos režimas. Ši išvada nereiškia, kad visi mokami API yra prieinami — kiekvienas endpoint gali turėti kitus vartus.

**Helper neatitikimas:** `getUserEntitlements` sako „active/non-revoked“, tačiau E:237–242 filtruoja tik `revoked_at IS NULL`, ne status / expiry. Kviečiantis kodas turi filtruoti pats arba helper pervadinti/pataisyti. `hasEntitlement` E:128–137 tikrina status ir expiry teisingai pagal jo sutartį.

## 5. `sessions` — 20 stulpelių

I:18–70; `20260717110000_marketing_consent_always_true.sql:5`; STEP:78. Tai FUNNEL sesija, ne Supabase Auth session ir ne Solidgate form session. Dabartiniam funnel reikalinga, bet billing moduliui neturi tapti 20-field privaloma priklausomybe.

| Stulpelis | Tipas / default | Paskirtis, naudojimas ir sprendimas |
|---|---|---|
| `id` | uuid = gen_random_uuid() | Funnel sesijos PK; klientas gali sugeneruoti ir serveris įrašo (S:239). Order/session vault ryšys. **Palikti funnel modulyje**, billing ima optional external checkout/session ref. |
| `email` | text? | Mutabilus lead email (S:53); checkout snapshot užfiksuojamas atskirai orders. **Palikti funnel/customer layer**, nenaudoti pakartotinei jau apmokėto order tapatybei nustatyti. |
| `quiz_answers` | jsonb = '{}' | Quiz atsakymai (S:49), hydration S:204, producto profilis. **Neperkelti į payment core**; išorinis checkout context jei būtina. |
| `result_segment` | text? | Quiz rezultato segmentas/archetipas (S:57,216). **Produkto/funnel modulis**, ne billing. |
| `current_step_id` | text? | Kur quiz/funnel vartotojas yra (S:45); atnaujinamas per persist. **Funnel modulis**. |
| `locale` | text | Dabartinė sesijos kalba, keičiasi (S:248–249). **Funnel/customer modulis**, billing pasilieka savo immutable snapshot. |
| `source` | text = quiz | Įėjimo kelias (quiz / special-offer ir kt.), veikia rinkodaros pasirinkimus (S:261–266). **Funnel modulis**, ne provider schema. |
| `user_id` | uuid? FK auth.users DELETE SET NULL | Sesijos susiejimas po authentication (ACCT:102); RLS owner. **Palikti funnel modulyje**, billing turi savo user/customer ref. |
| `last_oto_step` | text? | Persistintas OTO checkpoint / resume. `20260721140620_solidgate_oto_progress.sql:143` įrašo, grant route:1434 skaito. **Jei OTO naudojamas, perkelti į checkout_flow_progress**, ne quiz/legacy sesiją. |
| `stripe_customer_id` | text? | Sena Stripe customer reuse reikšmė (I:32); aktyviame mokėjimo kelyje neberašoma. **Neperkelti**. |
| `default_payment_method` | text? | Senas Stripe payment method ID (I:33); Solidgate naudoja atskiras vault lenteles. **Neperkelti**. |
| `stripe_payment_intent_id` | text? | Legacy payment trust / access; tebėra session-summary read `api/orders/session-summary/route.ts:56,72`. **Neperkelti kartu atsisakant legacy access parametru**. |
| `stripe_schedule_id` | text? | Sena Stripe subscription schedule nuoroda (I:35), indeksuota; aktyvaus rašytojo nerasta. **Neperkelti**. |
| `consent_given_at` | timestamptz? | Vartotojo sutikimo data; S:61 tiesiog paima kliento reikšmę. **Sutikimų modulis**, geriau serverio užfiksuotas evidence su paskirtimi. |
| `consent_version` | text? | Kokiai sąlygų/sutikimo versijai pritarė (S:64). **Sutikimų modulis**, ne provider core. |
| `marketing_consent` | boolean? = true (pakeista nuo false) | DB migracija pakeitė į true; S:66–69 tyčia ignoruoja kliento false ir rašo true. **Neperkelti šios produkto taisyklės**; naujame projekte tikras pasirinkimas / evidence. Tai techninis elgsenos faktas, ne teisinė išvada. |
| `welcome_email_pending` | boolean = false | Istorinė welcome email atidėjimo vėliava (I:43). Aktyvių source skaitymų/rašymų nerasta. Dabar yra fulfillment outbox. **Neperkelti**. |
| `created_at` | timestamptz = now() | Sesijos sukūrimas, admin funnel laiko langai. **Palikti funnel**. |
| `updated_at` | timestamptz = now() | S:41 ranka atnaujina; OTO resume taip pat skaito. Bendro trigger nerasta. **Palikti funnel**, apibrėžti ar activity, ar bet kokio įrašo keitimo momentas. |
| `solidgate_oto_environment` | text?, CHECK production/sandbox/null | Pirmas OTO veiksmas pririša chain prie aplinkos, kad sandbox nepakeistų production checkpoint (STEP:75; progress migration:55,69). **Palikti OTO progress identity dalimi**, tik jei bendroje DB gyvena abi aplinkos. |

RLS: anon INSERT su `WITH CHECK(true)`; authenticated SELECT/UPDATE tik `user_id=auth.uid()` (I:59–70). Tai bendros visos eilutės teisės, ne atskirų stulpelių whitelist. API persist turi savo patikras; tiesioginė Data API prieiga priklauso nuo grants. Naujame modulyje jokio mokėjimo ar patikimo identity fakto nelaikyti anon/browser modifikuojamoje sesijoje.

Indeksai email, user_id, current_step_id, Stripe customer, partial Stripe schedule. Solidgate-only boilerplate Stripe indeksų nereikia. `email` indeksas nėra user identity įrodymas.

## 6. `payment_intent_sessions` — 3 stulpeliai, legacy

I:134–143. Senasis Stripe PaymentIntent → funnel sesijos append-only trust anchor. Dabartinis Solidgate atitikmuo yra orders binding; tiesiogiai tai paaiškinta `packages/shared/src/solidgate/order-id.ts:6`. Aktyvių app/webhook `.from('payment_intent_sessions')` skaitymų/rašymų nerasta.

| Stulpelis | Tipas / default | Kam naudotas; sprendimas |
|---|---|---|
| `stripe_payment_intent_id` | text PK | Nekintamas Stripe mokėjimo → sesijos raktas I:135. **Neperkelti**. |
| `session_id` | uuid FK sessions DELETE CASCADE | Kuriam funnel srautui priklausė Stripe intent I:136; atskiras indeksas I:140. **Neperkelti lentelės**, bendrą binding funkciją išsaugoti payment orders. |
| `created_at` | timestamptz = now() | Binding sukūrimo momentas I:137. **Neperkelti**. |

RLS be browser policies. Naujam Solidgate-only boilerplate visa lentelė nereikalinga; esamame projekte istorijos netrinti be retention sprendimo.

## 7. `stripe_customers` — 10 stulpelių, legacy vault

I:164–178, SG:53–55, `00040_account_vault_psp_agnostic.sql:17–23`. Tarpinė migracija čia buvo pridėjusi Solidgate korteles; po to jos perkeltos į aplinkos atžvilgiu atskirą `solidgate_account_vault` (L:460–473). Aktyvių app/webhook `.from('stripe_customers')` skaitymų/rašymų nerasta.

| Stulpelis | Tipas / default | Kam naudotas; sprendimas |
|---|---|---|
| `id` | uuid = gen_random_uuid() | Seno vault PK I:165. **Neperkelti**. |
| `user_id` | uuid FK auth.users DELETE CASCADE | Vienas vault row vienam user, UNIQUE I:174. Nėra environment dimensijos. **Naudoti naują customer/payment instrument modelį**, senos lentelės neperkelti. |
| `stripe_customer_id` | text? | Stripe customer ID; 00040 panaikino NOT NULL Solidgate-only pirkėjams. **Neperkelti**. |
| `default_payment_method` | text? | Stripe pasirinktas mokėjimo metodas I:168. **Neperkelti**. |
| `session_origin_id` | uuid? FK sessions DELETE SET NULL | Iš kurios sesijos kortelė perkelta į account I:169. **Funkciją išsaugoti naujo instrument kilmės modelyje**, ne šioje lentelėje. |
| `created_at` | timestamptz = now() | Vault eilutės sukūrimo data I:170. **Neperkelti senos lentelės**. |
| `updated_at` | timestamptz = now() | Seno vault atnaujinimas I:171. **Neperkelti senos lentelės**. |
| `solidgate_card_token` | text? | Tarpinės integracijos recurring token SG:53; L:468 perkeliama į account vault. **Neperkelti dubliuoto laikymo**, instrument funkciją išsaugoti vienoje vietoje. |
| `solidgate_card_brand` | text? | Kortelės brand UI informacijai SG:54. **Vienas source naujame vault/instruments**, ne legacy table. |
| `solidgate_card_last4` | text? | Maskuota kortelės paskutinių 4 skaitmenų informacija SG:55. **Vienas source naujame vault/instruments**. |

RLS be browser policies. CHECK `num_nonnulls(stripe_customer_id,solidgate_card_token) >= 1` reikalauja bent vieno, nors migracijos komentaras sako „exactly one“; ABU laukai kartu SQL yra leidžiami. Tai patvirtinta komentaro ir constraint neatitiktis, bet legacy modelio; naujame boilerplate nereikia jos taisyti kopijuojant.

## 8. `user_acquisition_attribution` — 12 stulpelių, optional marketing integracija

A:5–43. Išsaugo pirmojo ankstyviausio sėkmingo susieto pirkimo UTM pagal user/environment. RPC neleidžia vėlesnio callback laikyti ankstesne acquisition vien dėl delivery eilės: pakeičia tik jei naujo source order `captured_at` ankstesnis (A:124–134). Tai nėra visų marketing prisilietimų istorija.

| Stulpelis | Tipas / default | Paskirtis, naudojimas ir sprendimas |
|---|---|---|
| `payment_environment` | text, CHECK | Composite PK dalis; W:763, PWA purchase route:777. **Palikti optional attribution adapteryje**. |
| `user_id` | uuid FK auth.users DELETE CASCADE | Composite PK kita dalis; vienas canonical acquisition / user / env (A:19). **Palikti attribution modulyje**. |
| `source_session_id` | uuid? FK sessions DELETE SET NULL | Kuris funnel srautas atvedė pirkėją; W:765. RPC input reikalauja ne NULL, vėliau FK delete gali NULL. **Palikti auditui**. |
| `source_order_id` | uuid? FK orders DELETE SET NULL | Tikslus acquisition order; W:766. **Palikti auditui**, payment core neturi priklausyti nuo jo sėkmės. |
| `utm_source` | text?, max 380 CHECK | Source platforma; W:768; PWA purchase:776 perkelia į order metadata. **Optional marketing**. |
| `utm_medium` | text?, max 380 CHECK | Kanalo tipas; W:769. **Optional marketing**. |
| `utm_campaign` | text?, max 380 CHECK | Kampanijos identifikatorius; W:770. **Optional marketing**. |
| `utm_content` | text?, max 380 CHECK | Kūrybinio varianto/skelbimo identifikatorius; W:771. **Optional marketing**. |
| `utm_term` | text?, max 380 CHECK | Raktažodis / papildomas kampanijos segmentas; W:772. **Optional marketing**. |
| `captured_at` | timestamptz = now() | Atitinkamo acquisition order momentas, ne callback arrival; W:767; pagal jį earliest wins A:134. **Palikti su aiškiu `source_order_created_at` pavadinimu/sutartimi**. |
| `created_at` | timestamptz = now() | Kada pirmą kartą įrašyta attribution eilutė A:17. **Palikti**. |
| `updated_at` | timestamptz = now() | Kada ankstesnis source pakeitė laimėtoją; RPC A:133. **Palikti**. |

RLS + explicit REVOKE PUBLIC/anon/authenticated, tik service role SELECT/INSERT/UPDATE (A:42–43). CHECK bent vienas netuščias UTM ir visi ≤380. PK jau aptarnauja pagrindinį lookup. Papildomi UTM indeksai nereikalingi, jei nėra DB-side campaign analizės. Dabartinis webhook attribution failure meta klaidą (W:774); moduliškame dizaine rinkodaros delivery galima perkelti į atskirą outbox, kad finansinės projekcijos nereikėtų kartoti dėl neprivalomos integracijos.

## 9. `funnel_events` — 6 stulpeliai, optional funnel analitika

Schema I:74–92; papildoma authenticated INSERT policy `supabase/migrations/20260717160000_funnel_events_authenticated_insert.sql:6`. Rašytojas `apps/funnel/src/features/quiz/lib/track-funnel-event.ts:26`; quiz žingsnis `use-quiz-navigation.ts:161`; OTO/checkout browser analitikos mirror `apps/funnel/src/features/analytics/hooks/use-analytics.ts:74–83`. Tai nėra finansinės sėkmės autoritetas ir neturi suteikti entitlement.

| Stulpelis | Tipas / default | Paskirtis, naudojimas ir sprendimas |
|---|---|---|
| `id` | uuid = gen_random_uuid() | Įvykio PK I:75. Kiekvienas INSERT sukuria naują įvykį; atskiro idempotency key nėra. **Palikti optional analytics**, dedupe jei tiksliai skaičiuojami įvykiai. |
| `session_id` | uuid FK sessions DELETE CASCADE | Kokios funnel sesijos įvykis I:76; writer laukia sesijos persist, kad nepažeistų FK. **Palikti funnel analitikoje**, ne billing core. |
| `event_type` | text, CHECK | quiz_started / step_completed / lead_captured / quiz_completed / oto_viewed / oto_accepted / oto_declined / checkout_completed (I:77–80). Browser mapping hook:38–42. **Optional analytics**, naujam flow konfigūruoti. |
| `step_number` | integer? | Quiz žingsnio numeris I:81; quiz navigation:161 įrašo `answeredStepNum`. OTO mirror dažnai NULL. **Funnel-specific**, ne payment field. |
| `metadata` | jsonb? = '{}' | Step ID, OTO/kainos/analitikos kontekstas I:82, analytics hook:83. **Optional, aiški schema ir PII ribojimas**; ne provider trust anchor. |
| `created_at` | timestamptz = now() | Įvykio įrašymo DB momentas I:83, admin funnel laikų analitika. **Palikti**, jei reikia source occurred_at pridėti atskirai. |

Indeksai session_id ir event_type (I:86–87), RLS įjungta. Anon ir authenticated turi INSERT policies su `WITH CHECK(true)`; policies nėra apribotos sesijos savininku. Tikras tiesioginės prieigos veikimas priklauso nuo table grants, tačiau tai schema, tinkama tik nepatikimai browser analitikai: įrašas `checkout_completed` NEGALI reikšti „pinigai patvirtinti“. Naujam moduliui payment events ateina iš patikrinto serverio/provider ir outbox. Funnel events palikti atskiro marketing/analytics paketo dalimi; vartotojo prašymas optimizuoti mokėjimų modulį nėra priežastis šios lentelės kopijuoti į kiekvieną backend.

## Patvirtinti trūkumai ir siūlomi pagerinimai

1. **Finansinių duomenų trynimo ryšys:** `orders.session_id ON DELETE CASCADE` (I:98). Ištrynus sesiją DB automatiškai trina order; per kitus FK gali trinti checkout pagalbines eilutes, entitlement order_id virsta NULL; kitų source apribojimų atvejais trynimas gali būti atmestas. Fulfillment outbox neturi orders FK, todėl savaime dėl jo neištrinamas. Tai schemos elgsena, ne teiginys, kad production jau prarasti duomenys. Naujam moduliui naudoti SET NULL / archyvavimą su aiškia retention.
2. **Nepastovios finansinės sąvokos:** order `amount_cents` pradedamas kaip prašoma suma, po refund kaip neto; order `status` yra ir payment, ir subscription; renewal `created_at` yra tai DB, tai provider invoice laikas. Atskirti requested/gross/net, paid_at, invoice_created_at, recorded_at ir subscription_status. Jei reikia accounting-grade atsekamumo — nekintamas payment operations ledger, iš jo suvestinės.
3. **Admin našumas ir pilnumas:** REVENUE:24–30 ir :41–45 pasiima visas matching eilutes ir sumuoja Node/TS, nėra puslapiavimo ar SQL agregacijos. Jei Data API max_rows mažesnis nei rinkinys, rezultatas bus nepilnas; konkrečios live max_rows reikšmės netikrintos. SQL SUM/group by ir tinkami indeksai yra pirmas optimizavimo kandidatas. „grossRevenue“ funkcija realiai sumuoja neto pakoreguotas sumas — naming neatitinka pinigų semantikos.
4. **Tipų drift:** `solidgate_invoice_orders` 20 realiai deklaruotų stulpelių, generated type tik 18. Regeneruoti DB tipus iš atkurtos švarios schemos ir įtraukti į CI drift/typecheck.
5. **Prieigos fail-open ir nevienodi helper:** E:190–195, E:237–242. Naujame modulyje aiškiai pasirinkti ir vienoje vietoje užtikrinti entitlement policy; pending provisioning ir grace turi būti apibrėžti, ne neribotas „none leidžia“.
6. **Audit timestamps ne visur patikimi:** orders turi trigger, entitlements/sessions daugiausia rankinį updated_at; revoke nekeičia entitlements.updated_at. Suvienodinti atnaujinimą ir atskirai laikyti prasmingas lifecycle datas.
7. **Tvirtai įsiūtas konkretus produktas:** CHECK ir funkcijos remiasi THEASTRL kodais, kainomis, OTO pakopomis, 32 lokalėmis. Rugsėjo migracija turėjo kopijuoti/widen septynias vietas. Į boilerplate perkelti product/price/flow konfigūraciją ar registrą, išsaugoti server+DB canonical validation generuojant iš vieno šaltinio.
8. **Nebūtini legacy elementai:** 4 Stripe order laukai; 3 Stripe renewal laukai; stripe entitlement field; 4 Stripe session laukai; payment_intent_sessions ir stripe_customers; `welcome_email_pending`, `order_sequence` ir snapshot legacy flags tuščiame projekte neturi dabartinės paskirties. Kiekvienam išėmimui būtina išvalyti susijusius query/type/RPC argumentus, o ne vien DDL.
9. **Schema integrity gerinimas:** CHECK currency format, provider enum, entitlement access_level; žinomiems naujiems mokėjimams NOT NULL gross/product key; kainų ir subscription ryšiams vidiniai FK. Dabartinių ID unique/lock/replay garantijų neprarasti.
10. **Neoptimizuoti vien pagal lentelių skaičių:** checkout lease, webhook idempotency, invoice-attempt mapping, entitlement ir outbox yra skirtingos atsakomybės. Viena didelė payments lentelė paprastai padidintų statusų painiavą. Tikri pertekliniai dalykai čia yra palikta Stripe compatibility ir konkretaus produkto kodas bendrame modulyje.

## Ką agentui būtina žinoti prieš perkeliant

- Vidinis order UUID, merchant Solidgate order ID, provider subscription UUID, invoice UUID, card recurring token ir submission lease token yra SKIRTINGI dalykai. Niekada nekeisti vieno kitu.
- Payment success autoritetas — patikrintas provider faktas, susietas su savomis immutable užsakymo reikšmėmis; browser „success“ tekstas pats savaime nesuteikia teisės.
- Vienas user gali turėti kelis order/bandymus, vienas subscription kelis invoice, vienas invoice kelis payment order bandymus. Entitlement yra projekcija; istorija lieka mokėjimų pusėje.
- Visose lookup/upsert natūralių provider ID operacijose dalyvauja aplinka. Idempotency ≠ sėkmė; neaiškaus provider atsakymo negalima automatiškai paversti nauju apmokestinimu.
- Callback gali dubliuotis ir atkeliauti atvirkštine tvarka. Invoice kartografija, watermark, replay guard ir durable side effects neturi dingti refaktorinant.
- Produkto key, marketing/reporting code, lokalizuotas name ir provider product/price ID turi būti aprašyti kaip keturios atskiros sąvokos.
- Teisės galiojimas, cancellation, refund, chargeback, dunning grace ir kortelės atnaujinimas yra atskiri lifecycle procesai; dokumentacija turi turėti būsenų lentelę ir kas gali jas keisti.
- Naujam projektui schema turi būti atkuriama viena švaria baseline + seeds/config; istorinių duomenų backfill, reconciliation ir legacy flags nėra naujo projekto setupas.

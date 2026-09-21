# Stripe palikimo išvalymas: analizė ir atlikti darbai

Data: 2026-09-11. Tikslas — boilerplate priima **tik Solidgate**. Šis dokumentas
fiksuoja, kas iš Stripe realiai buvo likę šiame repozitorijuje, kas išvalyta
šiuo žingsniu, kas sąmoningai palikta ir kodėl, bei koks vienas sprendimas dar
laukia savininko.

Apimtis: statinė viso repo peržiūra (`grep` visų failų, išskyrus
`node_modules`, `.next`, `output/`), abiejų aplikacijų, `packages/`,
`supabase/` ir `scripts/`. Gyvos DB, Solidgate paskyra ir deploy nekeisti.

## Išvada viena pastraipa

Stripe **integracijos** šiame boilerplate nėra ir nebuvo: nėra `stripe`
priklausomybės, nėra `STRIPE_*` aplinkos kintamųjų, nėra Stripe lentelių
(`stripe_customers`, `stripe_webhook_events`, `payment_intent_sessions`
egzistavo tik šaltinio projekte), nėra Stripe stulpelių, webhook ar API kelių.
Liko tik **pavadinimų ir komentarų palikimas** bei vienas PSP-neutralus
schemos artefaktas — `orders.psp` stulpelis. Viskas, kas buvo negyva, išvalyta;
`psp` paliktas su atskira rekomendacija žemiau.

## Patikrinimo inventorius

| Kategorija | Rasta | Rezultatas |
|---|---|---|
| `package.json` priklausomybės (visi workspace) | 0 Stripe paketų | Nieko daryti |
| Aplinkos kintamieji (`.env.example`, kodas) | 0 `STRIPE_*`; visi `SOLIDGATE_*` deklaruoti ir naudojami | Nieko daryti |
| DB lentelės (`00001_baseline.sql`, 24 lentelės) | 0 Stripe lentelių | Nieko daryti |
| DB stulpeliai | 0 `stripe_*` stulpelių; 1 PSP-neutralus `orders.psp` | Žr. skyrių „Likęs sprendimas“ |
| Webhook / API keliai | Tik `solidgate-webhooks`, `api/solidgate/*` | Nieko daryti |
| i18n žinutės | `billing.update.errorByCode` — 8 Stripe decline kodai, niekur nenaudojami | **Pašalinta** |
| Kodo komentarai / testų pavadinimai | 7 vietos su „Stripe“ | **Perrašyta** (argumentacija išsaugota) |
| SQL testas | `SET psp = 'stripe'` PSP nekintamumo teste | **Pakeista** į neutralų `'other_psp'` |
| CSP (`apps/funnel/next.config.ts`) | `hooks.stripe.com`, `js.stripe.com` `frame-src` sąraše | **Palikta sąmoningai** — žr. žemiau |
| `docs/gdpr-compliance.md` | Visas mokėjimų procesorius aprašytas kaip Stripe; nurodytos neegzistuojančios lentelės ir migracijos | **Perrašyta į Solidgate realybę** |
| `docs/new-product-checklist.md` | Nuoroda į „`STRIPE_PRICE_*` env blob“ | **Perrašyta** |
| `docs/solidgate/IMPLEMENTATION_AND_MIGRATION_GUIDE.md` §17–18 | Stripe→Solidgate migracijos vadovas (27 paminėjimai) | **Palikta**, žr. „Savininko sprendimai“ |
| `docs/solidgate/boilerplate-*.lt.md`, `price-map-and-catalog.lt.md` | Šaltinio audito kopijos su Stripe kontekstu | **Neliečiama** — kontrolinės sumos manifeste |

## Kas pakeista šiuo žingsniu

1. `packages/i18n/messages/en/billing.json` — pašalintas `update.errorByCode`
   objektas. Jame buvo Stripe klaidų kodai (`invoice_payment_intent_requires_action`,
   `card_declined`, `incorrect_cvc` ir pan.). Solidgate atmetimų žinutės gyvena
   `offer.json` kaip `decline_*` raktai ir generuojamos iš
   `packages/shared/src/solidgate/decline-reason.ts`. Vienintelis `billing.update`
   naudotojas (`SolidgateUpdateCard.tsx`) skaito tik `updateError` ir `updateSubmit`.
2. `supabase/functions/solidgate-webhooks/index.ts` — du antraštės komentarai
   nebeapeliuoja į „Stripe handler“; Solidgate pristatymo savybių aprašymas
   (vienas įvykis daugeliui būsenų, netvarkingas pristatymas, RAW body parašas)
   išsaugotas žodis į žodį.
3. `supabase/migrations/00001_baseline.sql` — vienas komentaras
   `special_free` perrišimo apsaugoje; logika nepakeista.
4. `supabase/tests/solidgate_round2_concurrency.sql` — PSP nekintamumo testas
   naudoja `'other_psp'` vietoje `'stripe'`. Testas tikrina tą pačią trigger
   klaidą `PSP identity is immutable`.
5. `scripts/solidgate-seed-catalog.ts` — antraštė ir baigiamoji konsolės žinutė
   nebelygina su Stripe seeder'iais.
6. `apps/funnel/vitest.config.mts` — alias komentaras.
7. `apps/pwa/src/lib/analytics/payment-event.test.ts` — testo pavadinimas.
8. `apps/funnel/next.config.ts` — prie `frame-src` komentaro pridėtas vienas
   sakinys, kad tai **ne** Stripe integracija (žr. žemiau); hostai nepakeisti.
9. `docs/gdpr-compliance.md` — duomenų inventorius, procesorių lentelė,
   ištrynimo srautas, DPA sąrašas, §4.5 ir priedas A perrašyti pagal šio repo
   schemą (`solidgate_order_id`, `solidgate_subscription_id`,
   `solidgate_customer_email`, vault lentelės, `solidgate_webhook_events.payload`).
   Šablono įspėjimas dokumento viršuje lieka galioti.
10. `docs/new-product-checklist.md` — `catalog-ids.json` aprašymas be Stripe.
11. **Ne Stripe, bet kritinis** — `supabase/migrations/00001_baseline.sql`
    `renewal_events_solidgate_invoice_key` indeksas padarytas pilnas (ne
    dalinis) ir `supabase/tests/solidgate_subscription_renewals.sql` gavo
    regresinį bloką. Priežastis aprašyta skyriuje „Papildomi radiniai“, 1 punktas.

### Patikra po pakeitimų

| Rinkinys | Rezultatas |
|---|---|
| `npm run test` (4 workspace) prieš pakeitimus | Praėjo; funnel 977 testai |
| `packages/i18n` (`messages.test.ts` tikrina namespace paritetą) | Praėjo |
| `apps/pwa` `payment-event.test.ts` | Praėjo |
| Visi 8 `supabase/tests/*.sql` rinkiniai prieš pakeistą baseline | Visi praėjo (vienkartinis `postgres:17-alpine` konteineris pagal `supabase/tests/README.md`), įskaitant naują `RENEWAL LEDGER ARBITER INDEX` bloką |
| Naujas regresinis blokas prieš **seną** dalinį indeksą | Krenta su `there is no unique or exclusion constraint matching the ON CONFLICT specification` — testas tikrai gaudo klaidą |
| `npm run test` po visų pakeitimų (4 workspace) | Praėjo; funnel 86 failai / 977 testai |

## Kodėl CSP palieka `hooks.stripe.com` ir `js.stripe.com`

Tai nėra Stripe integracija. Komentaras `apps/funnel/next.config.ts` fiksuoja
incidentą: Solidgate 3DS iššūkio iframe (`acs.charge-auth.com`) perduoda
tikrą challenge į **įgijėjo (acquirer) ACS** hostą, o bent viename Solidgate
įgijimo maršrute tas hostas buvo Stripe hosted 3DS puslapis. Be šių įrašų
kiekvienas challenge'intas pirkėjas gavo pilką užblokuotą iframe **po**
apmokėjimo. Sandbox to neparodo — jo simuliuotas challenge lieka
`*.charge-auth.com`. Pagal `CLAUDE.md` 7 taisyklę (saugoti operacinius
komentarus) hostai palikti. Šalinti tik patvirtinus savo įgijėjo ACS hostus
produkcijoje.

## Likęs sprendimas: `orders.psp` stulpelis

`orders.psp TEXT NOT NULL DEFAULT 'solidgate'` — vienintelis PSP eros
schemos artefaktas. Reikšmė visada `'solidgate'`; kiekvienas RPC ją įrašo
eksplicitiškai, o trigger draudžia keisti. Faktai:

| Kur | Paminėjimų |
|---|---|
| `00001_baseline.sql` (CHECK, daliniai indeksai, 4 BEFORE trigger'iai, ~20 RPC) | 68 |
| `supabase/tests/*.sql` | 22 |
| TypeScript (funnel, pwa, shared, webhook, scripts; be `database.ts`) | 63 eilutės 21 faile |

Stulpelis nėra tik balastas — jis šiuo metu atlieka dvi funkcijas:

- **Testų fixture escape hatch.** `solidgate_intro_claims.sql` sąmoningai
  įrašo `psp = 'fixture'`, kad apeitų `orders_solidgate_checkout_identity_check`
  (Solidgate eilutė privalo turėti pilną nekintamą checkout tapatybės snapshot).
- **Latentinė spraga.** Tas pats CHECK prasideda `psp IS DISTINCT FROM 'solidgate' OR (...)`,
  todėl bet kuris `service_role` rašytojas, įrašęs `psp = 'x'`, apeina visas
  Solidgate tapatybės ir pinigų apsaugas. Šiandien tokių rašytojų kode nėra.

Trys variantai (rekomendacija — B):

| Variantas | Kas daroma | Kaina | Rizika |
|---|---|---|---|
| A. Palikti kaip yra | Nieko | 0 | Spraga lieka; naujam programuotojui neaišku, kodėl stulpelis egzistuoja |
| **B. Prisegti CHECK `psp = 'solidgate'`** | Vienas CHECK; `intro_claims` fixture'ai perrašomi su pilnu tapatybės snapshot (2 INSERT) | ~1 val. | Maža; uždaro spragą, nekeičia RPC logikos |
| C. Išmesti stulpelį | Redaguoti 68 SQL vietas pinigų logikoje, 22 testų vietas, 63 TS eilutes, regeneruoti `database.ts`, perleisti 8 SQL rinkinius | ~1 darbo diena | Vidutinė; PostgREST filtrų eilutės nematomos TypeScript (CLAUDE.md 2 taisyklė), kiekvieną `.eq('psp', …)` reikia rasti ranka |

Nei B, nei C nevykdyti šiuo žingsniu, nes tai keičia pinigų logikos schemą ir
jau sukurtoms DB reikėtų atskiros migracijos. Sprendimas savininko.

## Savininko sprendimai (nevykdyta)

1. **`psp` stulpelis** — žr. aukščiau.
2. **Mokėjimo slapuko pavadinimai.** `packages/shared/src/payment-cookie.ts`
   naudoja `kind: 'pi'` ir lauką `paymentIntentId`, nors saugo Solidgate
   `order_id`. Tas pats `PaymentCookieKind` naudojamas `proxy.ts`,
   `payment-session-access.ts`, `solidgate-access.ts` ir testuose (~15 vietų).
   Veikia teisingai, klaidina tik pavadinimas. Pervadinimas į `'order'` /
   `orderId` yra mechaninis, bet keičia pasirašyto slapuko wire formatą —
   boilerplate tai nesvarbu, gyvam produktui reikštų visų aktyvių mokėjimo
   slapukų negaliojimą 90 min. lange.
3. **`IMPLEMENTATION_AND_MIGRATION_GUIDE.md` §17 „Stripe-to-Solidgate mapping“
   ir §18 „Refactoring a live Stripe project“.** Tai ne kodas, o vadovas
   komandai, perkeliančiai kitus produktus iš Stripe. Naujam Solidgate-only
   produktui nereikalingas; komandai su Stripe produktais gali būti naudingas.
   Palikta; trinti, jei komanda tokių perkėlimų neplanuoja.
4. **Solidgate `paymentIntent` terminas** (`form.ts`, `create-session`,
   PWA `purchase`) — tai oficialus Solidgate SDK laukas `merchantData.paymentIntent`,
   ne Stripe palikimas. Neliesti.

## Papildomi radiniai mokėjimų sistemoje

Peržiūra buvo nukreipta į Stripe palikimą, bet du agentai atskirai peržiūrėjo
funnel API kelius, webhook funkciją ir PWA pirkimų kelius. Žemiau tik tie
radiniai, kuriuos patikrinau pats kode arba empiriškai. Būsenos: **pataisyta**
arba **nepataisyta** (savininko sprendimas).

### 1. Kritinis — pataisyta: kiekvienas apmokėtas pratęsimas krenta ties `renewal_events` upsert

Webhook (`supabase/functions/solidgate-webhooks/index.ts`, `recordSubscriptionInvoices`)
rašo pratęsimų žurnalą per PostgREST:
`upsert(..., { onConflict: 'payment_environment,solidgate_invoice_id', ignoreDuplicates: true })`.
PostgREST generuoja `ON CONFLICT (payment_environment, solidgate_invoice_id) DO NOTHING`
**be indekso predikato**. Baseline unikalus indeksas buvo **dalinis**
(`WHERE solidgate_invoice_id IS NOT NULL`), o Postgres dalinio unikalaus
indekso be predikato kaip arbitro nenaudoja. Rezultatas — `SQLSTATE 42P10`,
webhook meta `renewal ledger upsert failed`, grąžina 5xx, Solidgate kartoja
pristatymą į tą pačią klaidą.

Svarbiausia: `recordSubscriptionInvoices` kviečiamas **prieš**
`applySolidgateSubscriptionLifecycle` (entitlement pratęsimą). Todėl apmokėtas
pratęsimas niekada nepratęsia prieigos. Tai tiksliai atitinka
[peržiūroje](BOILERPLATE_REVIEW.lt.md) aprašytą incidentą „apmokėta, bet
prieiga pasibaigė“, kurio priežastis liko nenustatyta. Ankstesnė pataisa keitė
laikotarpio skaičiavimą, bet iki jo kodas nepasiekdavo.

Patikrinta empiriškai `postgres:17-alpine` konteineryje su šio repo baseline:
tas pats `INSERT ... ON CONFLICT (…) DO NOTHING` krenta su daliniu indeksu ir
praeina su pilnu. Kodėl to nepagavo esami testai: webhook vitest rinkinys
mock'ina DB, o SQL rinkiniai kviečia RPC, ne PostgREST upsert.

Pataisa: indeksas be `WHERE` (stulpelis jau turi `CHECK (solidgate_invoice_id IS NOT NULL)`,
tad semantika identiška) ir regresinis SQL blokas, kartojantis tikslų PostgREST
sakinį. **Jau sukurtoms DB reikia atskiros migracijos** (`DROP INDEX` +
`CREATE UNIQUE INDEX` be predikato). Ar šaltinio projekto produkcijos DB turi tą
patį dalinį indeksą — nepatikrinta; tai pirmas dalykas, kurį verta pažiūrėti
`pg_indexes`.

Kiti PostgREST upsert taikiniai patikrinti: `solidgate_analytics_outbox`,
`solidgate_fulfillment_outbox`, `solidgate_invoice_orders`, `entitlements`,
`user_prefs` — visi turi pilnus unikalius indeksus arba PK.

### 2. Aukštas — nepataisyta: webhook aplinka visada `production`

`index.ts` `runtime.environment` inicijuojama `'production'`, o vienintelis
keitimo kelias `configureWebhookRuntime()` kviečiamas tik testuose. Šaltinio
projekte buvo atskira sandbox wrapper funkcija; į boilerplate ji neperkelta,
`supabase/functions/` turi tik `solidgate-webhooks`. Tuo tarpu `.env.example`
ir `go-live-runbook.md` vis dar aprašo `SOLIDGATE_WEBHOOK_*_SANDBOX` ir
`SOLIDGATE_SANDBOX_FULFILLMENT_*` — jų neskaito joks kodas. Pasekmė: sandbox
webhook įvykiai arba neatlaiko parašo patikros, arba (įdėjus sandbox raktus į
pagrindinius kintamuosius) įrašomi kaip `payment_environment='production'`,
kur sandbox order eilučių nėra. Boilerplate, kurio pirmas žingsnis yra sandbox
testavimas, čia neturi veikiančio kelio. Siūlymas: skaityti
`SOLIDGATE_ENVIRONMENT` funkcijoje arba pridėti `solidgate-webhooks-sandbox`
wrapper ir išvalyti nenaudojamus env raktus.

### 3. Aukštas — nepataisyta: laimėtas ginčas (reversed chargeback) visam laikui užšaldo order

Chargeback handler'is (`index.ts`, ~4260) net kai `reversed = true` įrašo
`solidgate_chargeback_id`, `solidgate_chargeback_status` ir
`solidgate_chargeback_amount_cents`; praleidžia tik entitlement atšaukimą. Bet
`terminalOrderPreventsGrant()` (~1176) ir `nonLifecycleTerminalOrder()` (~3413)
laiko terminaliu **bet kokį** ne-NULL chargeback id/status. Po laimėto ginčo
kiekvienas vėlesnis `renew` / `recurring` išeina anksti, o pakartotinis grant
atmetamas. Pinigai grįžta, prieiga — ne. Siūlymas: `reversed` atveju valyti
chargeback laukus (arba saugoti `reversed` būseną atskirai) ir terminalumo
tikrinimuose atskirti `reversed` nuo aktyvaus ginčo.

### 4. Vidutinis — nepataisyta: funnel proxy neatpažįsta prenumeratos pirkėjo

`apps/funnel/src/proxy.ts` (~328) tikrina `.eq('status', 'completed')`, bet
pagrindinis checkout finalizuojamas kaip `'trialing'` (`grant/route.ts` ~1225),
vėliau webhook pakelia į `'active'`. `'completed'` gauna tik vienkartiniai OTO.
Todėl `authenticatedHasCompletedOrder` prenumeratos pirkėjui visada `false`:
apmokėjusio vartotojo peradresavimas į `/dashboard` neveikia, o cross-device
OTO kelias (D-13) negyvas. Teisinga aibė jau yra tame pačiame faile —
`CAPTURED_MAIN_ORDER_STATUSES` (~87). Pataisa vienos eilutės:
`.in('status', ['completed', 'trialing', 'active'])`.

### 5. Vidutinis — nepataisyta: dunning grace skaičiuojamas nuo `Date.now()`

`index.ts` ~4154: `past_due` prieiga nustatoma `Date.now() + 60 d.`, ne nuo
laikotarpio pabaigos. `lifecycleAlreadyApplied` trumpina tik kai ir order, ir
entitlement jau `past_due`; kitais atvejais pakartotinis pristatymas pratęsia
dar 60 dienų nuo dabar.

### 6. Vidutinis — nepataisyta (jau žinoma): `charge-oto` `expectedAmount: 0`

Jau aprašyta [peržiūroje](BOILERPLATE_REVIEW.lt.md) kaip 7 radinys; agentas
patvirtino tą patį (`charge-oto/route.ts` ~1451 vs `initialAmount()` ~244).

### 7. Žemas — nepataisyta: klaidinantys, bet nekenksmingi

- `create-session/route.ts` ~387: `.or('product_slug.eq.<main>,product_slug.ilike.trial%,product_slug.ilike.special%')` —
  `entitlements.product_slug` visada laiko produkto **kodą** (`BRAND_000000_SUB`,
  RPC tai pina), tad du `ilike` nariai nieko neatitinka; veikia tik `eq`.
  Komentaras virš užklausos klaidina.
- `grant/route.ts` ~1181: `fullyCaptured = order.status === 'partial_settled'`
  atrodo apverstas; klientas `OR`'ina `captured || settled || fullyCaptured`,
  todėl elgsena nesikeičia.
- `proxy.ts` ~383: `'pi'` slapuko kelias tikrina tik eilutės egzistavimą, ne
  refund / chargeback būseną; apmokestinimas saugus, nes `solidgate-access`
  pertikrina, bet OTO puslapiai po void lieka atidaryti iki slapuko galiojimo
  (90 min.).
- `pm-info/route.ts`: `sessionId` netikrinamas pagal UUID šabloną, o sesijos
  skaitymo klaida nutylima į `sessionUserId: null`.
- `charge-oto` ~1144 pasitiki `x-forwarded-for` be privačių / loopback
  adresų filtro, nors `create-session` ~203 juos atmeta.

### 8. Saugumas — nepataisyta: PWA neturi jokios Content-Security-Policy

`apps/pwa/next.config.ts` nustato tik Apple Pay domain-verification
`Content-Type`; `apps/pwa/src/proxy.ts` prideda tik `Accept-Language`. Nėra CSP,
HSTS, `nosniff`, `Referrer-Policy`, `Permissions-Policy`. Funnel turi visą
rinkinį su `frame-src` / `frame-ancestors` Solidgate 3DS grandinei. PWA
renderina tą pačią Solidgate formą (`purchase`, `billing/update-card`) ir OTP
auth be jokios apsaugos. Siūlymas: iškelti funnel `securityHeaders` į
`packages/shared` (tik header'iai, ne CSS — CLAUDE.md 6 taisyklė) ir naudoti
abiejose aplikacijose.

### 9. Negyvas kodas (grep patikrinta)

- `supabase/functions/solidgate-webhooks/_welcome_email.ts` — 237 eilutės,
  importuoja tik jo paties testas; `index.ts` siunčia `send_welcome_email`
  per fulfillment outbox, ne per šį modulį.
- `configureWebhookRuntime` / `WebhookRuntimeConfig` — tik testai (žr. 2 radinį;
  spręsti kartu).
- `apps/funnel/src/lib/payment/provision-account.ts` `provisionPurchasedAccount` —
  produkcinio importuotojo nėra, tik `vi.mock` testuose.
- `checkout-tiers.ts`: `MAIN_RECURRING_PRODUCT_ID`, `MAIN_PLAN_PRODUCT_IDS`,
  `PAID_MAIN_CHECKOUT_TIER_IDS` — eksportuoti, naudojami tik tame faile.
- `payment-cookie.ts`: `kind: 'sub'` šaka ir `subscriptionId` laukas —
  `signPaymentCookie` visur kviečiamas be `opts`, o visi trys skaitytojai
  atmeta ne-`'pi'`. Visa `PaymentCookieKind` sąjunga negyva (susiję su
  „Savininko sprendimai“ 2 punktu).
- `payment-session-access.ts`: `@deprecated sessionPaymentIntentId` vis dar
  privalomas interfeise; vienintelis kvietėjas perduoda `null`.
- `create-session/route.ts` ~53 rankinis `CHECKOUT_TIERS` dubliuoja
  `MAIN_CHECKOUT_TIER_SLUGS` iš `checkout-tiers.ts` — būtent tas drift, nuo
  kurio įspėja to failo antraštė.

Nenaudojami i18n raktai (`billing.update.*` be `updateSubmit` / `updateError`)
ir nuoroda į neegzistuojantį `docs/solidgate/migration-plan.md`
(`order-id.ts` 1 eilutė) — smulkmenos tai pačiai valymo bangai.

## Kas nepatikrinta

- Gyva DB, Solidgate paskyra, webhook registracija, deploy — nekeista ir
  netikrinta.
- `output/solidgate-reader/*.html` negeneruotas iš naujo (reikia `pandoc`);
  jis atspindi ankstesnę dokumentų būseną.
- Realių mokėjimų, refund ar 3DS scenarijų nevykdyta.

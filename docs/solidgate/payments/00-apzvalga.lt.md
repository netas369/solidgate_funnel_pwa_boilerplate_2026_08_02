# Mokėjimų sistema: apžvalga ir žemėlapis

> Šis detalus aprašymas fiksuoja būseną iki 2026-09-14 audito pataisų. Naujas pinigų žurnalas, auth / kortelės patvirtinimo apsaugos ir pakeisti srautai aprašyti [pataisų dokumente](../FIXES_2026-09-14.lt.md).

Šis blokas dokumentuoja **dabartinio boilerplate** mokėjimų sistemą tokią,
kokia ji yra kode 2026-09-11: 24 lentelės ir 313 stulpelių, 76 DB funkcijos,
15 trigger'ių, 1 operatoriaus view, du Next.js API sluoksniai (funnel ir PWA),
viena Supabase Edge webhook funkcija, vienas foninis worker ir operatoriaus
skriptai. Tai aprašymas, ne pasiūlymas: kiekvienas teiginys remiasi šio repo
failu su nuoroda.

Kam skaityti pirma: šį dokumentą, tada [srautus](01-srautai.lt.md), tada tas
lenteles, kurių reikia. Produktų kodų ir kainų grandinė yra atskirame
[katalogo dokumente](08-produktu-katalogas-ir-kodai.lt.md), nes būtent ją keis
kiekvienas naujas produktas.

## Kas tai yra

Boilerplate parduoda per du kanalus ir vieną mokėjimų tiekėją (Solidgate,
API v1 / Billing 1.0):

- **Funnel** (`apps/funnel`, `:3205`): anoniminis quiz → pasiūlymas → hosted
  Solidgate forma → iki 8 OTO / upsell žingsnių vienu paspaudimu su išsaugota
  kortele → success → paskyros sukūrimas per OTP.
- **PWA narių zona** (`apps/pwa`, `:3206`): prieiga pagal `entitlements`,
  papildomi pirkimai narių zonoje, kortelės atnaujinimas po nepavykusio
  pratęsimo, grace laikotarpio baneris.
- **Webhook** (`supabase/functions/solidgate-webhooks`): po pirkimo pinigų
  gyvenimas — pratęsimai, dunning, atšaukimai, refund'ai, chargeback'ai,
  vėluojantys settlement'ai. Tai sistemos „tiesos šaltinis“ viskam, kas vyksta
  pirkėjui palikus puslapį.
- **Worker** (`apps/funnel/src/app/api/internal/solidgate-fulfillment`):
  Vercel Cron kas 5 minutes vykdo durable side effects (sveikinimo laiškas,
  profilio praturtinimas, Meta CAPI, pagrindinės prenumeratos atšaukimas
  perkant lifetime) ir prenumeratų tokenų sinchronizaciją.
- **DB** (`supabase/migrations/00001_baseline.sql`): viena idempotentiška
  schema. Pinigų logika gyvena PL/pgSQL funkcijose ir trigger'iuose, ne
  TypeScript'e, kad webhook'as ir API kelias, liesdami tą pačią eilutę vienu
  metu, negalėtų jos sugadinti.

## Pagrindinis srautas viename paveiksle

<div class="reader-flow" role="img" aria-label="Funnel sesija atidaro atominį order per RPC. Solidgate hosted forma apmoka. Serveris (grant) arba webhook patvirtina. Iš to gimsta teisė, išsaugota kortelė ir foniniai darbai. OTO žingsniai kartoja ciklą su išsaugota kortele.">
  <div class="reader-flow-step">sessions: anoniminė funnel sesija, el. paštas, locale</div>
  <div class="reader-flow-arrow" aria-hidden="true">↓</div>
  <div class="reader-flow-step">POST /api/solidgate/create-session → open_solidgate_main_checkout_v2 → orders (pending) + solidgate_main_checkout_states + solidgate_intro_claims → merchantData šifravimas → finalize_solidgate_main_checkout_v2 (formos cache)</div>
  <div class="reader-flow-arrow" aria-hidden="true">↓</div>
  <div class="reader-flow-step">Solidgate hosted forma (@solidgate/react-sdk), 3DS per solidgate_verify_url</div>
  <div class="reader-flow-arrow" aria-hidden="true">↙　↘</div>
  <div class="reader-flow-branches">
    <div class="reader-flow-branch">
      <div class="reader-flow-step">POST /api/solidgate/grant: status API įrodymas → orders CAS UPDATE (pending → trialing/completed) → grant_solidgate_main_entitlement</div>
      <div class="reader-flow-arrow" aria-hidden="true">↓</div>
      <div class="reader-flow-step">payment_access slapukas, main-accepted slapukas, linkAuthUser, solidgate_session_vault</div>
    </div>
    <div class="reader-flow-branch">
      <div class="reader-flow-step">Webhook card_gate.order.updated → solidgate_webhook_events (claim) → solidgate_entity_watermarks (tvarka)</div>
      <div class="reader-flow-arrow" aria-hidden="true">↓</div>
      <div class="reader-flow-step">orders būsena, kortelės tokenas, solidgate_fulfillment_outbox + solidgate_analytics_outbox</div>
    </div>
  </div>
  <div class="reader-flow-arrow" aria-hidden="true">↘　↙</div>
  <div class="reader-flow-step">entitlements: prieiga PWA; OTO 1..8 su išsaugota kortele per charge-oto → open_solidgate_oto_order_v2 → POST /recurring</div>
  <div class="reader-flow-arrow" aria-hidden="true">↓</div>
  <div class="reader-flow-results">
    <div class="reader-flow-step">success → OTP → auth user ↔ sessions.user_id</div>
    <div class="reader-flow-step">renewal_events + subscription callbacks → apply_solidgate_subscription_entitlement_lifecycle</div>
    <div class="reader-flow-step">worker: laiškai, profilio praturtinimas, CAPI, atšaukimai, tokenų sinchronizacija, cron_runs</div>
  </div>
</div>

Detalus kiekvieno žingsnio aprašymas su failais ir RPC yra
[srautų dokumente](01-srautai.lt.md).

## Sąvokos, be kurių likusi dokumentacija neskaitoma

**Order.** Viena eilutė `orders` = vienas mokėjimo bandymas (funnel arba PWA).
Atmestas bandymas sunaudoja savo `order_id`; pakartojimas gauna naują eilutę
su `attempt + 1`. Order niekada nerašomas iš naršyklės ir niekada tiesiogiai
iš TypeScript INSERT'u: tik per RPC („opener“), kuris laiko advisory lock ir
išsaugo nekintamą tapatybės snapshot.

**`order_id` gramatika.** Solidgate neturi idempotencijos raktų ir
PaymentIntent objekto, todėl pardavėjo generuojamas `order_id` vienu metu yra
idempotencijos raktas, sesijos ↔ order ryšys ir analitikos jungtis:
`{sessionId}:{offeringSlug}:{attempt}` (PWA pirkimams `u-{userId}` vietoje
sesijos). Šaltinis: [`order-id.ts`](../../../packages/shared/src/solidgate/order-id.ts#L1).
Solidgate riboja 255 simbolius.

**Nekintamas checkout tapatybės snapshot.** Atidarant order užfiksuojami
`solidgate_customer_email`, `solidgate_checkout_locale`,
`solidgate_product_id`, `solidgate_payment_action`,
`solidgate_checkout_identity_bound_at`. CHECK ir trigger'is
`guard_solidgate_checkout_identity()` neleidžia jų keisti. Tai apsauga nuo
„perrašyto“ pirkimo: naršyklė negali pakeisti nei sumos, nei produkto, nei
el. pašto po to, kai forma jau atidaryta.

**Kainos autoritetas.** Naršyklės atsiųsta suma tikrinama prieš
`solidgate_main_checkout_amount(slug, currency)` DB funkciją. Nesutapimas —
`SQLSTATE 23514` ir checkout krenta. Žr.
[katalogo dokumentą](08-produktu-katalogas-ir-kodai.lt.md).

**`payment_environment`.** Kiekviena mokėjimų eilutė pažymėta `production`
arba `sandbox`. Vercel `production` deploy dirba su `production`; Preview,
lokalus dev ir testai — su `sandbox`
([`payment-environment.ts`](../../../packages/shared/src/payment-environment.ts)).
Solidgate sandbox ir live yra atskiri kanalai su atskiromis raktų poromis; nėra
„test mode“ vėliavos. Unikalumai visur apima aplinką, todėl tas pats
`solidgate_order_id` gali egzistuoti abiejose.

**Entitlement.** `entitlements` yra vienintelis tiesos šaltinis, ką vartotojas
gali matyti: viena eilutė per (aplinka, vartotojas, produkto kodas). Prieiga
PWA tikrinama per
[`appAccessEntitlementState`](../../../packages/shared/src/entitlements.ts).
Teisę suteikia tik RPC (`grant_solidgate_*`, `apply_solidgate_subscription_entitlement_lifecycle`),
o trigger'is `prevent_solidgate_entitlement_replay()` neleidžia senam įvykiui
atkurti jau atšauktos teisės.

**Webhook inbox, claim ir watermark.** Solidgate negarantuoja tvarkos ir
kartoja pristatymus. Kiekvienas įvykis pirmiausia užrakinamas
`solidgate_webhook_events` eilute su `claim_token` ir `claim_generation`
(fencing: lėtas worker, kurio lease pasibaigė, negali užbaigti įvykio kito
vardu). Tada `solidgate_entity_watermarks` serializuoja įvykius per entity
(prenumerata, order): tik **griežtai senesnis** providerio laikas laikomas
pasenusiu, lygūs laikai apdorojami abu, nes įvykių ID neturi tvarkos.

**Outbox.** Domeno pakeitimas ir „ką dar reikia padaryti“ atskirti:
`solidgate_fulfillment_outbox` (laiškai, profilio praturtinimas, CAPI,
atšaukimai) ir `solidgate_analytics_outbox` (PostHog su `insert_id` dedupe;
čia pat keliauja ir anoniminės sesijos ↔ vartotojo tapatybių sujungimas
`$merge_dangerously`)
vykdomi at-least-once su claim ir retry. Įrašymas į outbox ir domeno
pakeitimas šiandien **nėra** viena transakcija — tai žinomas trūkumas
([peržiūros 4 radinys](../BOILERPLATE_REVIEW.lt.md)).

**Vault ir kortelės kilmė.** Išsaugota kortelė gyvena
`solidgate_session_vault` (funnel OTO grandinei) ir `solidgate_account_vault`
(narių zonai). Kiekvienas įrašas turi `card_source_sequence` (globali seka,
kad vėlyvas webhook'as neperrašytų naujesnės kortelės senesne) ir kilmės
įrodymą: tokenas iš nulinės autorizacijos ir tokenas iš apmokėto pirkimo
laikomi skirtingai.

**Lease / claim.** Kelios lentelės (`*_states`, `*_attempts`, `*_jobs`,
inbox, outbox) turi `claim_token` / `claim_started_at` / `generation` grupę.
Tai trumpalaikis užraktas: pirmas gauna darbą, kiti laukia arba perima tik
pasibaigus terminui. Kiekvienas rezultato įrašas turi pateikti savo token,
kitaip atmetamas.

**Fail-closed vs fail-open.** Pinigų keliai (order, grant, charge) yra
fail-closed: neaiški būsena = klaida, ne pirkimas. Prieigos skaitymas PWA
šiuo metu vietomis fail-open (DB klaida = `active`), sąmoningai, kad
neužblokuotų pirkėjo tarp mokėjimo ir webhook'o; tai
[peržiūros 2 radinys](../BOILERPLATE_REVIEW.lt.md).

## Lentelių inventorius

24 lentelės, sugrupuotos taip, kaip išdėstyti žodynai. Stulpelių skaičiai iš
DDL.

### Pirkimai ir prieiga → [02](02-lenteles-orders-entitlements.lt.md)

| Lentelė | Stulpeliai | Paskirtis |
|---|---|---|
| `orders` | 35 | Kiekvienas mokėjimo bandymas, funnel arba narių zonos. Rašo tik `service_role`; invariantus saugo CHECK ir keturi BEFORE trigger'iai. |
| `entitlements` | 14 | Vienintelis tiesos šaltinis, ką vartotojas gali pasiekti. Viena eilutė per (aplinka, vartotojas, produktas). |

### Prenumeratų sąskaitos, intro, atribucija → [03](03-lenteles-prenumeratos-saskaitos.lt.md)

| Lentelė | Stulpeliai | Paskirtis |
|---|---|---|
| `renewal_events` | 18 | Pasikartojančių pajamų žurnalas, viena eilutė per providerio sąskaitą (invoice). |
| `solidgate_invoice_orders` | 20 | Providerio invoice-order eilučių veidrodis: jungtis tarp prenumeratos sąskaitos ir atskirų apmokestinimo bandymų joje. |
| `solidgate_intro_claims` | 11 | Vienas įvadinis pasiūlymas per pirkėjo el. paštą, rezervuojamas checkout metu; dubliai matomi operatoriaus view. |
| `user_acquisition_attribution` | 12 | First-touch UTM atribucija iš pirmo susieto order. |

### Checkout būsenos, kortelės, tokenai → [04](04-lenteles-checkout-korteles-tokenai.lt.md)

| Lentelė | Stulpeliai | Paskirtis |
|---|---|---|
| `solidgate_main_checkout_states` | 10 | Vienas vykstantis pagrindinis checkout per (aplinka, sesija, produktas); `builder_token` neleidžia dviem tabams sukurti dviejų payment intent. |
| `solidgate_pwa_purchase_states` | 16 | Narių zonos pirkimo tapatybė, režimas (išsaugota kortelė / forma), lease ir formos cache. |
| `solidgate_session_vault` | 13 | Funnel išsaugota kortelė OTO grandinei ir „mokėti su •••• 4242“ UI. |
| `solidgate_account_vault` | 14 | Paskyros lygio kortelė narių zonos apmokestinimams; monotoniškas pagal `card_source_sequence`. |
| `solidgate_card_update_attempts` | 18 | Nulinės autorizacijos kortelės keitimo žurnalas; tik vienas gyvas bandymas per vartotoją. |
| `solidgate_subscription_token_sync_jobs` | 16 | Claim-fenced eilė, kuri kiekvieną apmokestinamą prenumeratą nukreipia į dabartinį įrodytą kortelės tokeną. |

### Webhook inbox ir eilės → [05](05-lenteles-webhook-eiles.lt.md)

| Lentelė | Stulpeliai | Paskirtis |
|---|---|---|
| `solidgate_webhook_events` | 15 | Webhook idempotencija ir claim fence; saugo pilną payload. |
| `solidgate_entity_watermarks` | 8 | Serializuoja callback'us per entity, kad du tos pačios prenumeratos įvykiai nesipintų. |
| `solidgate_analytics_outbox` | 15 | At-least-once analitikos pristatymas; `insert_id` yra PostHog dedupe raktas. |
| `solidgate_fulfillment_outbox` | 15 | Durable po-pirkimo veiksmai, vykdomi app worker'io. |
| `meta_capi_event_claims` | 7 | Meta Conversions API dedupe ir rate-limit; aplinka čia yra **deploy** aplinka, ne `payment_environment`. |
| `cron_runs` | 10 | Viena eilutė per suplanuoto darbo paleidimą; be jos tyliai sustojęs cron būtų nematomas. |
| `generation_locks` | 4 | Bendras single-flight užraktas brangiam serverio darbui. |

### Sesijos ir platforma → [06](06-lenteles-platforma.lt.md)

| Lentelė | Stulpeliai | Paskirtis |
|---|---|---|
| `sessions` | 16 | Viena anoniminė funnel sesija per lankytoją; po OTP susiejama su auth vartotoju. |
| `funnel_events` | 6 | Funnel įvykių žurnalas analitikai. |
| `otp_attempts` | 5 | Brute-force ribojimo žurnalas `verify-otp`. |
| `user_prefs` | 6 | Vartotojo UI nuostatos; proxy iš čia hidratuoja locale slapuką. |
| `deletion_requests` | 9 | GDPR 17 str. audito pėdsakas; boilerplate dar niekas nerašo. |

## Kur kas gyvena kode

| Sluoksnis | Vieta | Ką daro |
|---|---|---|
| Funnel API | `apps/funnel/src/app/api/solidgate/{create-session,grant,charge-oto,advance-oto,pm-info}/route.ts` | Order atidarymas, patvirtinimas, OTO apmokestinimas ir progresas |
| Funnel prieiga | `apps/funnel/src/proxy.ts`, `apps/funnel/src/lib/payment/*.ts` | Maršrutų apsauga pagal mokėjimo slapuką ir DB, paskyros provisioning, worker |
| Funnel UI | `apps/funnel/src/components/checkout/solidgate-checkout.tsx`, `apps/funnel/src/features/oto/**` | Hosted forma, 3DS grįžimas, OTO šablonas ir recovery hook'ai |
| PWA API | `apps/pwa/src/app/api/solidgate/{purchase,purchase/confirm,billing/update-card}/route.ts` | Narių zonos pirkimai, patvirtinimas, kortelės keitimas |
| PWA UI | `apps/pwa/src/components/solidgate/*`, `apps/pwa/src/components/billing/*`, `apps/pwa/src/lib/solidgate/*`, `apps/pwa/src/lib/pwa-products.ts` | Forma, grace baneris, ką galima parduoti |
| Bendras paketas | `packages/shared/src/solidgate/*.ts` | Solidgate klientas, parašai, formos šifravimas, katalogas, vault'ai, OTO helper'iai, tokenų sinchronizacija |
| Bendras paketas (šaknis) | `packages/shared/src/{price-map,entitlements,grace-period,payment-cookie,payment-session-access,payment-environment,oto-product-label,locale-prefixes}.ts` | Kainos, prieiga, slapukai, aplinka, kodai |
| Webhook | `supabase/functions/solidgate-webhooks/{index,_signature,_codes,_welcome_email}.ts` | Visi Solidgate įvykiai |
| DB | `supabase/migrations/00001_baseline.sql` | Schema, trigger'iai, 76 funkcijos |
| DB testai | `supabase/tests/*.sql` | Vienintelė PL/pgSQL pinigų logikos padengimas |
| Skriptai | `scripts/solidgate-*.ts`, `scripts/export-price-*.ts` | Katalogo seed / verify / archive, tapatybių sutikrinimas, kainų eksportai |
| Admin | `apps/funnel/src/app/admin/**` | Pajamų ir prenumeratų suvestinės |

Pilnas failas-po-failo žemėlapis yra [srautų dokumento](01-srautai.lt.md)
pradžioje.

## Ko šis blokas nedaro

- Nesiūlo pakeitimų. Rasti trūkumai surašyti antrame bloke:
  [peržiūra](../BOILERPLATE_REVIEW.lt.md) ir
  [Stripe išvalymas](../STRIPE_CLEANUP.lt.md) (jame yra ir patikrinti
  papildomi radiniai).
- Neaprašo šaltinio projekto lentelių: tos yra
  [šaltinio audito](../boilerplate-tables-core.lt.md) dokumentuose ir skiriasi
  nuo šio repo.
- Neaprašo, kaip pritaikyti produktą — tai atskiras „žingsnis po žingsnio“
  dokumentas, kuris remsis šiuo bloku ir
  [katalogo dokumentu](08-produktu-katalogas-ir-kodai.lt.md).

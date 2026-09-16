# Solidgate boilerplate: dabartinio kodo peržiūra

Peržiūros data: 2026-09-09. Šis dokumentas palygina į `docs/solidgate`
perkeltą pirminio projekto auditą su **šio boilerplate** kodu. Pirminiai audito
dokumentai nekeičiami: jų produktai, kainos, migracijų pavadinimai ir absoliučios
nuorodos nėra šio projekto konfigūracija.

Taikoma API v1 / Billing 1.0 kryptis, nurodyta [CLAUDE.md](../../CLAUDE.md)
ir [perdavimo dokumente](HANDOFF.lt.md). Siūloma nauja mokėjimų schema nelaikoma
įgyvendinta migracija. Toliau aprašyta statinė vietinio kodo peržiūra; ji
nepatvirtina produkcijos DB, Solidgate kanalo ar veikiančių worker nustatymų.

Per šios peržiūros palyginimą išorinės API nekviestos, mokamų operacijų
neatlikta. Radinių patvirtinimas kodu nėra tikro mokėjimo ar saugumo incidento
atkūrimas.

## Būsenų reikšmės

- **Aktualu** — radinys patvirtintas šiame repozitorijoje.
- **Jau sutvarkyta** — pirminio audito trūkumo šiame boilerplate nebėra.
- **Netaikoma** — pirminio projekto sąlyga neatitinka boilerplate konfigūracijos.
- **Nepatikrinta** — išvadai reikia papildomo tyrimo arba konkrečios aplinkos.
- **Tiriama** — vykdomo darbo dalis; galutinė pataisa ir patikrinimai dar turi
  būti įrašyti.
- **Pataisyta vietiniame kode** — pakeitimas įgyvendintas ir patikrintas nurodyta
  apimtimi; tai nereiškia, kad jis jau įdiegtas veikiančioje aplinkoje.

## Pataisyta vietiniame kode: mokamas prenumeratos pratęsimas

**Būsena: pataisyta vietiniame kode; galutinis visų SQL rinkinių paleidimas dar
tikrinamas.** Rasti ir pataisyti keli keliai, galėję palikti pasibaigusią arba
neteisingo laikotarpio prieigą po apmokėjimo. Be konkrečios paveiktos
prenumeratos ir jos webhook payload negalima patvirtinti, kuris kelias sukėlė
vartotojo stebėtą problemą.

Pakeitimai [webhook realizacijoje](../../supabase/functions/solidgate-webhooks/index.ts):

1. Sėkmingai apmokėtos sąskaitos `billing_period_ended_at` turi pirmenybę
   nustatant prieigos pabaigą. Tik tinkamos sąskaitos laikotarpio nesant
   naudojamas kitas mokėjimo laikas arba ribota produkto ciklo trukmė.
   `active` callback su teigiamu prenumeratos laikotarpio numeriu laikomas
   pratęsimu: pagrindinei prenumeratai atsarginis ciklas yra 30 dienų, o ne
   pradinis septynių dienų trial. Tai nėra kalendorinio mėnesio skaičiavimas.
   Atsarginė data siejama su to laikotarpio sąskaita, kad vėlesnis callback
   savaime nepridėtų naujų dienų.
2. Tiksliai suderintas dalinis **pradinio order** grąžinimas, po kurio lieka
   teigiama neto suma, nepraranda pradinio apmokėjimo įrodymo vėlesniam main
   prenumeratos pratęsimui. Išsaugomos pilno refund, void ir dispute apsaugos.
3. Naujesnis `order_update` arba `scheduled_for_cancellation` callback gali
   atkurti mokamo laikotarpio prieigą, kai ankstesnis `renew` jau laikomas
   pasenusiu pagal entity įvykių tvarką. Tam reikia aktyvios prenumeratos,
   sutampančio produkto ir valiutos, teigiamo laikotarpio numerio bei tiksliai
   apmokėtos sąskaitos įrodymo. Vien callback pavadinimo neužtenka. Šiam
   papildomam snapshot keliui taikoma konservatyvi taisyklė: bet kokie
   reversal / refund / void / dispute požymiai tikrinamame snapshot, net
   ankstesniame jo mokėjimo bandyme, neleidžia automatiškai atkurti prieigos.

[DB lifecycle RPC](../../supabase/migrations/00001_baseline.sql)
`apply_solidgate_subscription_entitlement_lifecycle()` taip pat pakeista:
tam pačiam prieigos savininkui `active → active` atnaujinimas negali sutrumpinti
jau suteikto mokamo laikotarpio arba pakeisti `full` atgal į `trial`.
`past_due → active` naudoja faktinę apmokėto laikotarpio pabaigą, pakeisdamas
ankstesnį grace terminą; grace dienos nėra papildomai apmokėtas laikas.
Savininko, prenumeratos, terminalių būsenų ir aplinkos apsaugos išlieka.

Paleisti vietiniai patikrinimai:

| Patikrinimas | Rezultatas |
|---|---|
| [Webhook vienetiniai ir regresiniai testai](../../supabase/functions/solidgate-webhooks/__tests__/webhook.test.ts) | 223 testai praėjo. |
| [Grant route replay](../../apps/funnel/src/app/api/solidgate/__tests__/grant-replay.test.ts) ir [intro offer](../../apps/funnel/src/app/api/solidgate/__tests__/grant-intro-offer.test.ts) testai | 64 testai praėjo. |
| Shared testų patikrinimai, įskaitant [grant replay](../../packages/shared/src/__tests__/solidgate-grant-replay.test.ts) | 68 testai praėjo. |
| [Naujas prenumeratos pratęsimų SQL rinkinys](../../supabase/tests/solidgate_subscription_renewals.sql) | 30 teiginių praėjo su pakeista schema. |
| Deno webhook tipų patikra | Praėjo. |
| Visų aštuonių SQL rinkinių patikra su galutiniu baseline | Visi praėjo naujoje vietinėje PostgreSQL 18.3 DB; concurrency rinkinys papildomai praėjo antrą kartą iš eilės. |
| [DB tipų regeneravimas](../../packages/shared/src/types/database.ts) | Regeneruota vietoje su Supabase postgres-meta; viešos DB API tipai semantiškai sutampa su ankstesniais. |
| Žemiau pateikta diagnostikos SQL užklausa | Įvykdyta vietinėje DB; schema ir užklausa suderinamos. |

SQL testai tikrina realią RPC elgseną, įskaitant pasikartojimą, laikotarpio
nesutrumpinimą, grace pakeitimą, nuosavybę ir aplinkų izoliaciją. Webhook
testai atskirai tikrina providerio įrodymą ir laikotarpio parinkimą.
Callback eiliškumo, dalinio refund ir prieigos sutrumpinimo regresijos prieš
pataisą nepraėjo, o po jos praėjo. V1 įvykių reikšmės sutikrintos su
[oficialia prenumeratos įvykių dokumentacija](https://docs.solidgate.com/billing/subscriptions/subscriptions-1.0/subscription-insights/subscription-events/);
invoice laukų kontraktas aprašytas vietiniame [OpenAPI išraše](openapi/WEBHOOK-SCHEMAS.md).

**Diegimo riba.** Pakeista boilerplate pradinė migracija; jau sukurtai DB reikia
atskiros naujos migracijos, kuri įdiegtų tą patį pakeistos
`apply_solidgate_subscription_entitlement_lifecycle()` funkcijos kūną. RPC
parašas nepasikeitė. Vien pritaikyto baseline failo redagavimas esamos DB
neatnaujina. Nebuvo deploy, nuotolinės DB pakeitimų, gyvų Solidgate testų ar
automatinio senų teisių taisymo.

### Tik skaitymo diagnostika konkrečiai prenumeratai

Operatorius įrašo tikslinę aplinką ir prenumeratos ID į `params`. Pagrindinio
produkto kodas turi atitikti konkretaus projekto konfigūraciją; šiame
boilerplate jis yra `BRAND_000000_SUB`. Užklausą vykdyti serverio / operatoriaus
teisėmis, kuriomis leidžiama skaityti šias vidines lenteles. Ji nieko nekeičia,
nerodo viso webhook payload ir nėra automatinio prieigos atkūrimo receptas.

```sql
WITH params AS (
  SELECT
    'sandbox'::text AS payment_environment,
    'REPLACE_WITH_SUBSCRIPTION_ID'::text AS subscription_id,
    'BRAND_000000_SUB'::text AS main_product_code
), main_orders AS (
  SELECT
    o.id, o.user_id, o.product_slug, o.solidgate_order_id,
    o.solidgate_subscription_id, o.status, o.amount_cents, o.currency,
    o.solidgate_original_amount_cents, o.solidgate_payment_status,
    o.solidgate_refunded_amount_cents, o.solidgate_chargeback_status,
    o.solidgate_chargeback_amount_cents, o.created_at, o.updated_at
  FROM public.orders AS o
  CROSS JOIN params AS p
  WHERE o.payment_environment = p.payment_environment
    AND o.psp = 'solidgate'
    AND o.solidgate_subscription_id = p.subscription_id
    AND o.product_slug = p.main_product_code
), current_entitlements AS (
  SELECT
    e.user_id, e.product_slug, e.order_id, e.solidgate_subscription_id,
    e.status, e.access_level, e.expires_at, e.revoked_at, e.source,
    e.granted_at, e.updated_at,
    e.solidgate_subscription_id = p.subscription_id AS matches_subscription
  FROM public.entitlements AS e
  CROSS JOIN params AS p
  WHERE e.payment_environment = p.payment_environment
    AND e.product_slug = p.main_product_code
    AND (
      e.solidgate_subscription_id = p.subscription_id
      OR EXISTS (SELECT 1 FROM main_orders AS o WHERE o.user_id = e.user_id)
    )
), latest_renewal AS (
  SELECT
    r.solidgate_invoice_id, r.solidgate_order_id,
    r.subscription_term_number, r.status, r.amount_cents,
    r.gross_amount_cents, r.refunded_amount_cents, r.currency,
    r.chargeback_status, r.chargeback_amount_cents,
    r.invoice_created_at, r.event_created_at, r.created_at
  FROM public.renewal_events AS r
  CROSS JOIN params AS p
  WHERE r.payment_environment = p.payment_environment
    AND r.solidgate_subscription_id = p.subscription_id
  ORDER BY r.event_created_at DESC NULLS LAST,
    r.invoice_created_at DESC NULLS LAST, r.created_at DESC,
    r.solidgate_invoice_id DESC
  LIMIT 1
), provider_order_ids AS (
  SELECT o.solidgate_order_id FROM main_orders AS o
  UNION
  SELECT i.solidgate_order_id
  FROM public.solidgate_invoice_orders AS i
  CROSS JOIN params AS p
  WHERE i.environment = p.payment_environment
    AND i.solidgate_subscription_id = p.subscription_id
), failed_webhooks AS (
  SELECT
    w.event_id, w.type, w.payload ->> 'callback_type' AS callback_type,
    w.event_created_at, w.attempts, w.failed_at, w.last_error
  FROM public.solidgate_webhook_events AS w
  CROSS JOIN params AS p
  WHERE w.environment = p.payment_environment
    AND w.status = 'failed'
    AND (
      w.payload #>> '{subscription,id}' = p.subscription_id
      OR w.payload #>> '{order,subscription_id}' = p.subscription_id
      OR w.payload #>> '{order,order_id}' IN (
        SELECT solidgate_order_id FROM provider_order_ids
      )
    )
  ORDER BY w.event_created_at DESC NULLS LAST, w.received_at DESC, w.event_id
  LIMIT 20
)
SELECT jsonb_build_object(
  'scope', (SELECT to_jsonb(p) FROM params AS p),
  'main_orders', COALESCE((SELECT jsonb_agg(to_jsonb(o)) FROM main_orders AS o), '[]'::jsonb),
  'entitlements', COALESCE((SELECT jsonb_agg(to_jsonb(e)) FROM current_entitlements AS e), '[]'::jsonb),
  'latest_renewal', (SELECT to_jsonb(r) FROM latest_renewal AS r),
  'failed_webhooks', COALESCE((SELECT jsonb_agg(to_jsonb(w)) FROM failed_webhooks AS w), '[]'::jsonb)
) AS renewal_diagnosis;
```

Vertinant rezultatą svarbu palyginti paskutinio mokėjimo būseną, neto sumą,
entitlement `expires_at` ir savininką. `matches_subscription = false` gali
rodyti, kad teisę jau valdo kitas pirkimas — vien seno apmokėjimo radimas
neleidžia jo perrašyti. `last_error` padeda atskirti grant / binding / callback
problemas. Tuščias klaidų sąrašas neįrodo, kad įvykis buvo gautas ar apdorotas:
nežinomo invoice order, pristatymo nebuvimo arba ištrinto inbox užklausa gali
nerasti. Tada reikia konkrečių providerio pristatymo duomenų ir išsaugotų
callback laikų, prieš priimant sprendimą dėl atkūrimo.

## Aktualūs radiniai

### 1. Kritinis: checkout el. paštas naudojamas prisijungimui

**Būsena: aktualu.** `linkAuthUser()` su administratoriaus teisėmis kuria arba
suranda naudotoją, sugeneruoja magic link ir jo hash iš karto sunaudoja
užklausos SSR kliente. Kelias taikomas ir egzistuojančiai paskyrai. Checkout
el. paštas šiam veiksmui perduodamas iš grant route.

Įrodymai: [paskyros sukūrimas ir magic link sunaudojimas](../../apps/funnel/src/lib/payment/provision-account.ts#L64),
[kvietimas su pirkimo el. paštu](../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1441).

Tai reiškia, kad mokėjimo atlikimas naudojamas vietoje pašto nuosavybės
patvirtinimo. Tikras paskyros perėmimas šioje peržiūroje nebuvo vykdomas.
Artimiausias atskiras darbas — atskirti pirkimo priskyrimą nuo autentifikacijos:
esamos paskyros sesijai reikia jau patvirtinto sutampančio naudotojo arba
įprasto el. pašto patvirtinimo. Mokėjimo slapuko ir OTO tęsimo sutartį reikia
išlaikyti nepriklausomai nuo auth cookie sukūrimo.

### 2. Aukštas: bendras prieigos tikrinimas leidžia trūkstamą ar pasibaigusią teisę

**Būsena: aktualu.** `appAccessEntitlementState()` DB klaidos atveju grąžina
`active`. Kai nėra teisių arba aktyvi teisė pasibaigusi be aiškaus atšaukimo
žymens, grąžina `none`. PWA layout blokuoja tik `revoked`.

Įrodymai: [prieigos būsenos ir klaidos apdorojimas](../../packages/shared/src/entitlements.ts#L147),
[PWA layout vartai](<../../apps/pwa/src/app/[locale]/(app)/layout.tsx#L39>).

Komentarai paaiškina ankstesnę politiką: apsaugoti pirkėją tarp mokėjimo ir
webhook, taip pat ties pratęsimo riba. Bendram mokamos prieigos kontraktui
reikia aiškių `active`, ribotos trukmės `grace` / `pending`, atsisakymo ir
techninės klaidos rezultatų. Pratęsimo projekcijos pataisa aprašyta aukščiau;
vartų politiką toliau keisti su pirmo pirkimo ir pratęsimo ribos scenarijais. Visų
mokamų API autorizacija šioje peržiūroje **nepatikrinta**.

### 3. Aukštas: finansinės istorijos gyvavimas susietas su funnel sesija

**Būsena: aktualu.** `orders.session_id` vis dar turi `ON DELETE CASCADE`.
Sesijos šalinimas gali pašalinti finansinį order ir su juo susietą būseną.
Produkcijos duomenų praradimas nepatvirtintas.

Įrodymas: [orders sesijos FK](../../supabase/migrations/00001_baseline.sql#L454).

Ribotas kitas darbas — pasirinkti ir ištestuoti saugojimo politiką. `RESTRICT`
yra mažesnis pakeitimas, išlaikantis mokėjimo tapatybę. `SET NULL` reikalautų
kartu suderinti nekintančio session ID taisykles
([identity guard](../../supabase/migrations/00001_baseline.sql#L1487),
[OTO guard](../../supabase/migrations/00001_baseline.sql#L1598)) ir priklausomus
atkūrimo kelius. Vien FK pakeitimas nėra baigtas `SET NULL` sprendimas.

### 4. Aukštas: grant ir outbox dar nėra viena transakcija; trūksta inbox atkūrimo

**Būsena: aktualu.** Pirmo mokėjimo webhook suteikia teisę, po to atskirais DB
kvietimais sukuria fulfillment ir analytics darbus. Inbox užbaigiamas dar
vėliau. Įvykio pakartojimas gali sutvarkyti tarpą, tačiau tai nėra transakcinio
outbox garantija.

Įrodymai: [pradinės teisės suteikimas](../../supabase/functions/solidgate-webhooks/index.ts),
[fulfillment ir analytics enqueue](../../supabase/functions/solidgate-webhooks/index.ts),
[inbox užbaigimas ir analytics drain](../../supabase/functions/solidgate-webhooks/index.ts).

Nerastas nepriklausomas worker, kuris iš išsaugoto inbox payload kartotų
failed / užstrigusius įvykius. Dabartinis internal endpoint kartoja fulfillment
ir prenumeratos tokenų sinchronizavimą
([endpoint](../../apps/funnel/src/app/api/internal/solidgate-fulfillment/route.ts#L25),
[penkių minučių cron](../../apps/funnel/vercel.json#L5)). Analytics drain
kviečiamas webhook atsakymo kelyje ir jo klaida prašo providerio redelivery.

Kiti atskiri darbai: sudėti domeno pakeitimą ir privalomų darbų įrašymą į vieną
DB transakciją; įdiegti savininko claim tikrinantį inbox atkūrimą; atskirti
analytics pristatymą nuo mokėjimo webhook HTTP rezultato. Patvaraus payload
ir veikiančios atkūrimo sistemos nelaikyti tuo pačiu įrodymu.

### 5. Aukštas: intro dublikatų sprendimas lieka rankinis ir nesekamas

**Būsena: aktualu.** Dvigubai apmokėtos įvadinės prenumeratos matomos
`solidgate_intro_claims_needing_refund` view. Grant kelias registruoja klaidą,
tačiau atskiras operatoriaus procesas, kuris fiksuotų refund / cancel rezultatą,
bandymų skaičių ir uždarymą, nerastas.

Įrodymai: [operatoriaus view ir rankinio refund komentaras](../../supabase/migrations/00001_baseline.sql#L1292),
[grant dublikato registravimas](../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1419).

Artimiausias darbas — patvari sprendimo eilė su aiškiu rezultatu ir operatoriaus
veiksmais. Automatinė kompensavimo politika turi būti apibrėžta atskirai;
vien radinys nesuteikia pagrindo vykdyti realius grąžinimus.

### 6. Vidutinis: entity ir analytics lease neturi vykdytojo nuosavybės apsaugos

**Būsena: aktualu.** Entity completion / release filtruoja pagal
`processing_event_id`, ne konkretų worker tokeną. Analytics completion /
failure filtruoja pagal aplinką ir outbox eilutės ID. Po lease perėmimo senas
worker gali įrašyti rezultatą naujojo vardu; tai statinis konkurencijos
scenarijus, ne patvirtintas incidentas.

Įrodymai: [entity completion / release](../../supabase/migrations/00001_baseline.sql#L2703),
[analytics completion / failure](../../supabase/functions/solidgate-webhooks/index.ts).

Kitas darbas — claim tokeno arba generation patikra visiems šių eilių rezultatų
rašymams. Vien inbox completion apsaugos neužtenka: domeno pakeitimai taip pat
turi atmesti pasenusį vykdytoją arba vykti trumpoje užrakintoje transakcijoje.

### 7. Vidutinis: mokamo add-on trial pradinė suma kai kur vis dar lygi nuliui

**Būsena: aktualu.** `ADDON_TRIAL_INTRO_AMOUNTS` nustato mokamą pradžią, o
`initialAmount()` ją naudoja. Tačiau `subscribeSavedCard()` gauna
`expectedAmount: 0`, ir analytics kontekstas be override prenumeratos pradžiai
taip pat grąžina nulį.

Įrodymai: [mokamas add-on trial](../../packages/shared/src/solidgate/catalog.ts#L338),
[pradinės sumos parinkimas](../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L244),
[neteisingas expectedAmount](../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L1444),
[analytics numatytoji suma](../../apps/funnel/src/features/analytics/lib/checkout-context.ts#L157).

Helper naudoja expected amount providerio rezultato normalizavimui ir
klasifikavimui ([helper](../../packages/shared/src/solidgate/oto.ts#L284)).
Route vėliau vėl tikrina išsaugotą bound amount, todėl universali mokėjimo
nesėkmė nėra įrodyta. Ribota pataisa: helper perduoti `boundAmountCents`,
analytics default imti iš `ADDON_TRIAL_INTRO_AMOUNTS[currency]`, pridėti mokamo
trial rezultato ir analytics regresinius patikrinimus.

### 8. Vidutinis: neįjungta locale tyliai keičia naujo checkout valiutos kontekstą

**Būsena: aktualu.** Trūkstant `ENABLED_CHECKOUT_LOCALES`, leidžiama `en`;
neįjungtos naujo checkout sesijos locale pakeičiama į `en`. Esamo order
snapshot turi pirmenybę ir jo locale išsaugoma.

Įrodymas: [locale parinkimas](../../apps/funnel/src/app/api/solidgate/create-session/route.ts#L338).

Kitas darbas — aiškus nepasiekiamos rinkos rezultatas arba vienas serverio
quote, rodomas prieš pirkėjo patvirtinimą. UI parodyta suma, valiuta ir
serverio užfiksuotos sąlygos turi sutapti; turinio fallback savaime neturi
keisti pirkimo kainos.

### 9. Vidutinis: catalog verify nepatikrina pilnų prenumeratos sąlygų

**Būsena: aktualu.** Seeder `--verify` perskaito produkto kainas ir tikrina
sumas, valiutas bei ID. Jis neperskaito ir nesutikrina viso produkto billing
periodo, trial periodo bei payment action kontrakto.

Įrodymas: [verify funkcija](../../scripts/solidgate-seed-catalog.ts#L141).

Ribotas darbas — pridėti gryną produkto sąlygų palyginimo funkciją ir vietinius
fixture testus, tada prijungti ją prie read-back. Gyvas catalog read-back šioje
peržiūroje nevykdytas. Kainų kartojimas tarp `PRICE_MAP`, `CATALOG_AMOUNTS`
ir SQL išlieka žinomas priežiūros klausimas; dabartinių pariteto testų ir DB
kainos apsaugos šalinti nereikia.

### 10. Vidutinis: pajamų agregatai priklauso nuo Data API grąžinamų eilučių ribos

**Būsena: aktualu kode; poveikis produkcijoje nepatikrintas.** Orders ir renewal
eilutės parsisiunčiamos be puslapiavimo, o sumuojamos TypeScript. Viršijus
aplinkos grąžinamų eilučių ribą suvestinė gali būti nepilna.

Įrodymas: [užklausos ir agregatai](../../apps/funnel/src/app/admin/_queries/revenue.ts#L21).

Ribotas darbas — agreguoti DB pagal valiutą / dieną arba naudoti deterministinį
puslapiavimą. Tikslinti „gross“ pavadinimą pagal realią refund sumų semantiką.
Produkcijos eilučių skaičius, API limitas ir query planai netikrinti.

## Kas iš pirminio audito jau nebegalioja

| Pirminis radinys / prielaida | Šio boilerplate būsena | Įrodymas |
|---|---|---|
| `solidgate_invoice_orders` tipuose trūksta `order_metadata` ir `product_price_id` | **Jau sutvarkyta**: abu laukai yra Row, Insert ir Update tipuose. | [DB tipai](../../packages/shared/src/types/database.ts#L830) |
| Reikia neperkelti visos istorinės Stripe / produkto migracijų grandinės | **Jau sutvarkyta šios bazės struktūroje**: yra vienas konsoliduotas baseline su bendriniais produktais. Tai neįrodo jo pritaikymo gyvai DB. | [baseline](../../supabase/migrations/00001_baseline.sql), [repo kontekstas](../../CLAUDE.md) |
| Pirminio projekto `special_free` iš tikrųjų apmokamas | **Netaikoma**: šis boilerplate naudoja nulį ir `auth_0_amount`; kitam kanalui konfigūracija tikrinama atskirai. | [sumos](../../packages/shared/src/solidgate/catalog.ts#L152), [produkto sąlygos](../../packages/shared/src/solidgate/catalog.ts#L370) |
| Visi darbai priklauso vien nuo providerio webhook | **Netaikoma kaip bendras teiginys**: fulfillment ir token-sync turi nepriklausomą cron. Inbox replay ir analytics vis dar turi aukščiau aprašytų trūkumų. | [internal worker](../../apps/funnel/src/app/api/internal/solidgate-fulfillment/route.ts), [cron](../../apps/funnel/vercel.json) |
| Inbox nėra konkretaus vykdytojo apsaugos | **Netaikoma**: inbox turi token ir generation fencing. Aktualus atskiras entity / analytics radinys. | [inbox schema](../../supabase/migrations/00001_baseline.sql#L771), [claim RPC](../../supabase/migrations/00001_baseline.sql#L2443) |

## Prioritetinė tolesnio darbo seka

> 2026-09-11 papildymas: [Stripe išvalymo dokumente](STRIPE_CLEANUP.lt.md)
> empiriškai patvirtinta, kad `renewal_events` PostgREST upsert su daliniu
> unikaliu indeksu krenta `42P10` **prieš** pratęsimo RPC — tai tikėtina 1 punkto
> incidento priežastis. Baseline indeksas pataisytas; gyvai DB reikia atskiros
> migracijos ir `pg_indexes` patikros.

1. Užfiksuoti galutinio SQL paleidimo rezultatą. Konkretaus vartotojo incidento
   priežastį tikrinti pagal jo prenumeratos duomenis ir callback istoriją;
   esamai DB paruošti atskirą lifecycle RPC migraciją prieš diegiant pataisą.
2. Atskiru aiškiu pakeitimu pašalinti nepatvirtinto checkout el. pašto naudojimą
   prisijungimui. Tai kritinis pakartotinio panaudojimo saugumo trūkumas.
3. Sutvarkyti mokamo add-on intro expected amount ir analytics neatitikimą.
4. Apibrėžti mokamos prieigos, provisioning ir ribotos grace būsenų kontraktą;
   patikrinti konkrečių saugomų API / turinio vartus.
5. Sutvarkyti finansinės istorijos retention ribą ir įdiegti privalomų darbų
   transakcinį įrašymą, vykdytojo apsaugą bei nepriklausomą inbox atkūrimą.
6. Įdiegti intro dublikatų operatoriaus sprendimo žurnalą, pilną katalogo
   kontrakto patikrą ir vienodą naujo checkout quote.
7. Pajamų agregatus perkelti į DB arba puslapiuoti; kainų manifesto
   centralizavimą planuoti išsaugant nekintantį jau pradėto order snapshot.

Platus viso mokėjimų paketo ar schemos perrašymas nėra būtina pirmos
pratęsimo pataisos sąlyga. Esamos aplinkos izoliacijos, nekintamos mokėjimo
tapatybės, saugaus retry, kortelių kilmės ir terminalių būsenų apsaugos lieka
privalomos.

## Patikrinimų ribos

Pradinis audito palyginimas remiasi vietinių failų skaitymu; aukščiau atskirai
įrašyti pratęsimo pataisos patikrinimai, kurie iš tikrųjų paleisti. Kodo testų sėkmė
nepatvirtina gyvos DB migracijų būsenos, providerio katalogo, webhook
registracijos ar worker paleidimo. Tikri mokėjimai, automatiniai refund ir
atskirai apmokestinamos API operacijos nevykdomos be vartotojo išankstinio
patvirtinimo ir konkretaus maksimalaus piniginio biudžeto.

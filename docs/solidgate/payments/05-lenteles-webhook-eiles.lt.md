# Lentelės: webhook inbox, įvykių tvarka ir darbų eilės

> Šis detalus aprašymas fiksuoja būseną iki 2026-09-14 audito pataisų. Naujas pinigų žurnalas, auth / kortelės patvirtinimo apsaugos ir pakeisti srautai aprašyti [pataisų dokumente](../FIXES_2026-09-14.lt.md).

Šis dokumentas aprašo patikimumo sluoksnį tarp Solidgate webhook'o ir programos: įeinančių įvykių inbox'ą su
lease/token/generation fencing'u (`solidgate_webhook_events`), per-entity įvykių tvarkos „vandens ženklus“
(`solidgate_entity_watermarks`), dvi at-least-once darbų eiles (`solidgate_analytics_outbox`,
`solidgate_fulfillment_outbox`), Meta CAPI ingress apsaugą (`meta_capi_event_claims`) ir dvi bendras platformos
pagalbines lenteles (`cron_runs`, `generation_locks`). Iš viso 7 lentelės ir 74 stulpeliai. Visos septynios yra
`service_role` only: RLS įjungtas, politikų nėra, `anon`/`authenticated` teisės atimtos.

Bendras srautas: [`serveRequest`](../../../supabase/functions/solidgate-webhooks/index.ts#L4497) patikrina parašą,
per `claim_solidgate_webhook_event_v2` užima inbox eilutę, [`handleEvent`](../../../supabase/functions/solidgate-webhooks/index.ts#L4450)
apvynioja verslo logiką [`withEntityOrdering`](../../../supabase/functions/solidgate-webhooks/index.ts#L966)
(vandens ženklai), verslo logika įrašo darbus į abi outbox lenteles, po `complete_solidgate_webhook_event_v2`
webhook'as pats išsemia analitikos outbox'ą ([`drainAnalyticsOutbox`](../../../supabase/functions/solidgate-webhooks/index.ts#L782))
ir best-effort pažadina funnel worker'į ([`scheduleFunnelFulfillment`](../../../supabase/functions/solidgate-webhooks/index.ts#L571)),
kuris išsemia fulfillment outbox'ą. Vercel cron kas 5 min. ([`vercel.json`](../../../apps/funnel/vercel.json#L5))
yra atkūrimo kelias.

## Lentelė `public.solidgate_webhook_events`

**Paskirtis.** Webhook'o idempotencijos ir claim-fence lentelė („durable inbox“). Solidgate negarantuoja pristatymo
tvarkos, o dublikatai pasitaiko, todėl kiekvienas įvykis pirmiausia atsiduria čia su `status='processing'` ir tik
tada vykdoma verslo logika. `(claim_token, claim_generation)` pora užtikrina, kad lėtas worker'is, kurio lease
pasibaigė, negalėtų užbaigti įvykio, kurį jau perėmė naujesnis worker'is. Žalias `payload` saugomas visada, tad
nieko neprarandama net kai įvykis ACK'inamas kaip neatpažintas
([komentaras](../../../supabase/functions/solidgate-webhooks/index.ts#L3307)).

**Gyvavimo ciklas.** Eilutė atsiranda per [`claim_solidgate_webhook_event_v2`](../../../supabase/migrations/00001_baseline.sql#L2449)
(INSERT `status='processing'`, `attempts=1`, `claim_generation=1`, naujas `claim_token`), kurį kviečia
[`claimEvent`](../../../supabase/functions/solidgate-webhooks/index.ts#L879). Jei eilutė jau yra, `ON CONFLICT`
ją perima tik kai `status='failed'` arba `status='processing'` su pasibaigusia lease
(`processing_started_at < NOW() - GREATEST(p_lease_seconds, 30)`; webhook'as siunčia `p_lease_seconds: 300`).
Perėmimas didina `attempts` ir `claim_generation`, išduoda naują `claim_token`, nunulina `completed_at`/`failed_at`/`last_error`.
Jei perimti nepavyksta, RPC grąžina `claim_state='completed'` (webhook'as atsako `{duplicate:true}` ir vis tiek
išsemia analitikos outbox'ą, [L4549](../../../supabase/functions/solidgate-webhooks/index.ts#L4549)) arba
`'busy'` (atsakymas 503 su `Retry-After: 5`, [L4555](../../../supabase/functions/solidgate-webhooks/index.ts#L4555)).
Sėkmė: [`complete_solidgate_webhook_event_v2`](../../../supabase/migrations/00001_baseline.sql#L2567) →
`status='completed'`, `claim_token=NULL`. Klaida: [`fail_solidgate_webhook_event_v2`](../../../supabase/migrations/00001_baseline.sql#L2609)
→ `status='failed'`, `claim_token=NULL`, `last_error` (webhook'as atsako 500, kad Solidgate pristatytų dar kartą,
[L4582](../../../supabase/functions/solidgate-webhooks/index.ts#L4582)). Abu UPDATE'ai vykdomi tik kai
`status='processing' AND claim_token=p_claim_token AND claim_generation=p_claim_generation`; jei sutapimo nėra,
grąžinama `false`, o TS meta klaidą „claim is stale“ ([`completeEvent`](../../../supabase/functions/solidgate-webhooks/index.ts#L922),
[`failEvent`](../../../supabase/functions/solidgate-webhooks/index.ts#L943)). Eilutės niekada netrinamos programos
kodu (`service_role` net neturi DELETE teisės, žr. žemiau). Senoji [`claim_solidgate_webhook_event`](../../../supabase/migrations/00001_baseline.sql#L2374)
(v1, grąžina `BOOLEAN`, `claim_token=NULL`) tebėra schemoje, bet TS kode nekviečiama; ją tikrina tik SQL testas
[`solidgate_round2_concurrency.sql`](../../../supabase/tests/solidgate_round2_concurrency.sql#L24).

**Raktai, indeksai, RLS.** PK `(environment, event_id)` ([L801](../../../supabase/migrations/00001_baseline.sql#L801)).
Indeksai: `idx_solidgate_webhook_events_received_at` ant `(received_at)`
([L806](../../../supabase/migrations/00001_baseline.sql#L806)); **dalinis** `idx_solidgate_webhook_events_retry` ant
`(status, processing_started_at) WHERE status IN ('processing','failed')` ([L808](../../../supabase/migrations/00001_baseline.sql#L808));
**dalinis** `idx_solidgate_webhook_events_active_claim` ant `(environment, event_id, claim_generation)
WHERE status='processing' AND claim_token IS NOT NULL` ([L811](../../../supabase/migrations/00001_baseline.sql#L811)).
FK nėra. RLS įjungtas, politikų nėra; `REVOKE ALL` iš `PUBLIC, anon, authenticated`; `GRANT SELECT, INSERT, UPDATE`
(be DELETE) `service_role` ([L817](../../../supabase/migrations/00001_baseline.sql#L817)). RPC teisės: visi trys
`*_v2` ir v1 – `GRANT EXECUTE ... TO service_role`, `REVOKE` iš kitų ([L9535](../../../supabase/migrations/00001_baseline.sql#L9537)).

**Apsaugos.** CHECK `environment IN ('production','sandbox')`; CHECK `status IN ('processing','completed','failed')`;
CHECK `attempts > 0`; CHECK `claim_generation >= 0`; CHECK `solidgate_webhook_events_terminal_claim_check`:
`status='processing' OR claim_token IS NULL` ([L802](../../../supabase/migrations/00001_baseline.sql#L802)) – terminalinė
eilutė negali laikyti token'o (SQLSTATE `23514`). RPC parametrų validacija meta `22023` („invalid Solidgate webhook
claim“ / „... completion claim“ / „... failure claim“) kai `event_id`/`type` tušti, `event_created_at` NULL,
`environment` ne iš sąrašo, `payload` NULL, `claim_generation < 1` ar `last_error` tuščias. Jei po nesėkmingo
`ON CONFLICT` eilutės būsena nėra nei `completed`, nei `processing`, `claim_solidgate_webhook_event_v2` meta
„unexpected Solidgate webhook inbox state“ ([L2561](../../../supabase/migrations/00001_baseline.sql#L2562)).
Trigger'ių nėra; `updated_at` atnaujina patys RPC.

### Stulpeliai

| Stulpelis | Tipas · NULL · default | Reikšmė | Kas rašo / kas skaito | Apsaugos ir pastabos |
|---|---|---|---|---|
| `environment` | `TEXT` · NOT NULL · `'production'` | Mokėjimų aplinka, į kurią atėjo callback'as. Ta pati `event_id` reikšmė sandbox ir production aplinkose yra dvi skirtingos eilutės. | Rašo: [`claim_solidgate_webhook_event_v2`](../../../supabase/migrations/00001_baseline.sql#L2449) iš `p_environment` = [`runtime.environment`](../../../supabase/functions/solidgate-webhooks/index.ts#L74). Skaito: visi trys `*_v2` RPC per PK. | CHECK `IN ('production','sandbox')`; PK dalis. |
| `event_id` | `TEXT` · NOT NULL · — | Solidgate `solidgate-event-id` antraštė – idempotencijos raktas. ID yra nepermatomas (opaque), todėl pagal jį netvarkoma įvykių chronologija. | Rašo: `claim_..._v2` iš [antraštės](../../../supabase/functions/solidgate-webhooks/index.ts#L4505). Skaito: `complete_/fail_..._v2`. | PK dalis; tuščias → `22023`. |
| `type` | `TEXT` · NOT NULL · — | `solidgate-event-type` antraštė (`card_gate.order.updated`, `alt_gate.order.updated`, `subscription.updated.v2`, `card_gate.chargeback.received`; senasis `subscription.updated` atmetamas [`handleEvent`](../../../supabase/functions/solidgate-webhooks/index.ts#L4488)). | Rašo: `claim_..._v2` (perrašo ir per `ON CONFLICT`). Skaito: TS kode neskaitoma iš lentelės, tik operatoriaus užklausoms. | Tuščias → `22023`. |
| `event_created_at` | `TIMESTAMPTZ` · NULL · — | Solidgate `solidgate-event-created-at` – vienintelis chronologinis požymis. Čia saugomas informaciniais tikslais; stale-guard'as vyksta `solidgate_entity_watermarks`. | Rašo: `claim_..._v2` iš [išanalizuotos antraštės](../../../supabase/functions/solidgate-webhooks/index.ts#L4525). Skaito: —. | DDL leidžia NULL, bet v2 RPC NULL atmeta (`22023`); webhook'as be validžios antraštės atsako 400. |
| `status` | `TEXT` · NOT NULL · `'completed'` | Inbox būsena: `processing` (užimta, vykdoma), `completed` (terminalinė sėkmė), `failed` (klaida, perimama iš karto kitu pristatymu). Perėjimai: INSERT→`processing`; `processing`→`completed` (`complete_..._v2`); `processing`→`failed` (`fail_..._v2`); `failed`→`processing` ir pasenusi `processing`→`processing` (pakartotinis `claim_..._v2`). | Rašo: trys `*_v2` RPC. Skaito: `claim_..._v2` (`ON CONFLICT ... WHERE`, būsenos nustatymas [L2549](../../../supabase/migrations/00001_baseline.sql#L2549)). | CHECK 3 reikšmės; `terminal_claim_check`; DDL default `'completed'` niekada nenaudojamas, nes RPC visada įrašo `'processing'`. Dalinis retry indeksas. |
| `attempts` | `INTEGER` · NOT NULL · `1` | Kiek kartų eilutė buvo užimta (pirmas INSERT = 1, kiekvienas perėmimas +1). | Rašo: `claim_..._v2` ([L2518](../../../supabase/migrations/00001_baseline.sql#L2518)). Skaito: — (TS neskaito; viršutinės ribos nėra). | CHECK `> 0`. |
| `payload` | `JSONB` · NULL · — | Pilnas Solidgate JSON kūnas (po parašo patikros). Perrašomas kiekvienu perėmimu naujausiu pristatymu. Tai ir audito šaltinis neatpažintiems callback'ams. | Rašo: `claim_..._v2` iš [`JSON.parse(rawBody)`](../../../supabase/functions/solidgate-webhooks/index.ts#L4531). Skaito: TS neskaito iš lentelės. | NULL → `22023`. |
| `claim_token` | `UUID` · NULL · — | Aktyvios lease žetonas. Išduodamas `gen_random_uuid()` prie kiekvieno užėmimo; `complete`/`fail` UPDATE'ai reikalauja tikslaus sutapimo, todėl pasibaigusios lease turėtojas negali nei užbaigti, nei pažymėti klaidos. | Rašo: `claim_..._v2` ([L2512](../../../supabase/migrations/00001_baseline.sql#L2510)), nunulina `complete_`/`fail_`. Skaito: [`claimEvent`](../../../supabase/functions/solidgate-webhooks/index.ts#L902) validuoja UUID formą. | `terminal_claim_check`: ne-`processing` eilutėje privalo būti NULL. Dalinis `active_claim` indeksas. |
| `claim_generation` | `BIGINT` · NOT NULL · `0` | Monotoniška užėmimo karta: 1 po INSERT, +1 kiekvienu perėmimu. Antras fencing'o komponentas – net jei token'as būtų pakartotas, sena karta neatitiks. | Rašo: `claim_..._v2` ([L2525](../../../supabase/migrations/00001_baseline.sql#L2525)). Skaito: `complete_/fail_..._v2` (WHERE), grąžinama į TS ([`WebhookClaim.generation`](../../../supabase/functions/solidgate-webhooks/index.ts#L873)). | CHECK `>= 0`; RPC reikalauja `>= 1` užbaigimui. |
| `processing_started_at` | `TIMESTAMPTZ` · NULL · — | Lease pradžia. Užėmimas su `processing_started_at < NOW() - lease` laikomas mirusiu ir gali būti perimtas. Nunulinama užbaigiant ar žymint klaidą. | Rašo: `claim_..._v2` (`NOW()`), `complete_`/`fail_` (NULL). Skaito: `claim_..._v2` `ON CONFLICT ... WHERE` ([L2531](../../../supabase/migrations/00001_baseline.sql#L2531)). | Lease minimumas 30 s (`GREATEST(p_lease_seconds, 30)`); webhook'as naudoja 300 s. |
| `completed_at` | `TIMESTAMPTZ` · NULL · — | Sėkmingo užbaigimo laikas. Nunulinamas, jei eilutė perimama iš naujo (tai įmanoma tik iš `failed` arba pasibaigusios `processing`). | Rašo: `complete_..._v2` (`NOW()`), `claim_..._v2` (NULL). Skaito: —. | — |
| `failed_at` | `TIMESTAMPTZ` · NULL · — | Paskutinės klaidos laikas. | Rašo: `fail_..._v2` (`NOW()`), `claim_`/`complete_` (NULL). Skaito: —. | — |
| `last_error` | `TEXT` · NULL · — | Paskutinės klaidos žinutė, apkarpyta iki 4000 simbolių (`LEFT(p_last_error, 4000)`; TS taip pat karpo iki 4000 [L958](../../../supabase/functions/solidgate-webhooks/index.ts#L958)). Nunulinama sėkmingai užbaigus ar perėmus. | Rašo: `fail_..._v2`; `claim_`/`complete_` (NULL). Skaito: —. | Tuščias `p_last_error` → `22023`. |
| `received_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Pirmo gavimo laikas; perėmimai jo nekeičia. | Rašo: DB default. Skaito: niekas TS kode; skirta operatoriaus užklausoms (indeksas). | Indeksas `received_at`. |
| `updated_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Paskutinio RPC pakeitimo laikas. | Rašo: visi trys `*_v2` RPC (`NOW()`). Skaito: —. | Trigger'io nėra – tik RPC. |

**Susiję RPC ir trigger'iai.** [`claim_solidgate_webhook_event`](../../../supabase/migrations/00001_baseline.sql#L2374) (v1, nenaudojama TS),
[`claim_solidgate_webhook_event_v2`](../../../supabase/migrations/00001_baseline.sql#L2449),
[`complete_solidgate_webhook_event_v2`](../../../supabase/migrations/00001_baseline.sql#L2567),
[`fail_solidgate_webhook_event_v2`](../../../supabase/migrations/00001_baseline.sql#L2609). Trigger'ių nėra.

## Lentelė `public.solidgate_entity_watermarks`

**Paskirtis.** Serializuoja callback'us per vieną entity (Solidgate užsakymą arba prenumeratą), kad du to paties
entity įvykiai niekada nesipintų, ir atmeta pasenusius įvykius. „Vandens ženklas“ (watermark) – tai paskutinio
sėkmingai apdoroto įvykio provider'io laiko žyma tam entity: naujas įvykis su **griežtai senesne** `event_created_at`
grąžinamas kaip `stale` ir praleidžiamas; įvykis su **lygia** laiko žyma privalo būti apdorotas, nes Solidgate
`event_id` yra nepermatomas ir auth/settle callback'ai vienam užsakymui dažnai turi tą pačią sekundę
([DDL komentaras](../../../supabase/migrations/00001_baseline.sql#L821), [RPC komentaras](../../../supabase/migrations/00001_baseline.sql#L2685),
[SQL testas](../../../supabase/tests/solidgate_round2_concurrency.sql#L255)). Domeno handler'iai turi būti
monotoniški ir idempotentiški, nes lygios laiko žymos gali ateiti bet kokia tvarka.

**Gyvavimo ciklas.** Eilutę sukuria [`claim_solidgate_entity_event`](../../../supabase/migrations/00001_baseline.sql#L2652)
(`INSERT ... ON CONFLICT DO NOTHING`, po to `SELECT ... FOR UPDATE`). Kviečia [`withEntityOrdering`](../../../supabase/functions/solidgate-webhooks/index.ts#L966)
su `entity_type` `'payment'` (`card_gate.order.updated`, `alt_gate.order.updated`, `card_gate.chargeback.received`)
arba `'subscription'` (`subscription.updated.v2`) ir `entity_id = "<environment>:<providerId>"`
([L978](../../../supabase/functions/solidgate-webhooks/index.ts#L978)). RPC grąžina: `'stale'` (kai
`last_event_created_at IS NOT NULL AND p_event_created_at < last_event_created_at`), `'busy'` (kai
`processing_event_id` priklauso kitam įvykiui ir `processing_started_at >= NOW() - lease`), kitaip užrašo
`processing_*` ir grąžina `'claimed'`. TS `busy` atveju kartoja iki 5 kartų su 1,5 s · (n+1) pauzėmis
([L992](../../../supabase/functions/solidgate-webhooks/index.ts#L992)) – „busy“ yra dažnas atvejis, ne reta lenktynė;
jei vis dar `busy`, meta klaidą, įvykis pažymimas `failed`, Solidgate pristato dar kartą. `stale` – įvykis
logiškai praleidžiamas ir inbox'e užbaigiamas kaip sėkmė ([L999](../../../supabase/functions/solidgate-webhooks/index.ts#L999)).
Po handler'io sėkmės [`complete_solidgate_entity_event`](../../../supabase/migrations/00001_baseline.sql#L2710)
perkelia `processing_*` į `last_event_*`; po klaidos [`release_solidgate_entity_event`](../../../supabase/migrations/00001_baseline.sql#L2733)
tik nunulina `processing_*`, vandens ženklas nejuda. Abu UPDATE'ai sąlygoti `processing_event_id = p_event_id`,
todėl svetimo įvykio užbaigti/atleisti negalima. Eilutės netrinamos (išskyrus SQL testus). Jei įvykis neturi
`eventId`/`eventCreatedAt` konteksto, `withEntityOrdering` vykdo handler'į be vandens ženklo
([L973](../../../supabase/functions/solidgate-webhooks/index.ts#L973)).

**Raktai, indeksai, RLS.** PK `(entity_type, entity_id)` ([L833](../../../supabase/migrations/00001_baseline.sql#L833)).
Papildomų indeksų ir FK nėra. RLS įjungtas, politikų nėra; `REVOKE ALL` iš `PUBLIC, anon, authenticated`;
`GRANT ALL` `service_role` ([L836](../../../supabase/migrations/00001_baseline.sql#L836)). Trys RPC –
`GRANT EXECUTE ... TO service_role` ([L9547](../../../supabase/migrations/00001_baseline.sql#L9546)).

**Apsaugos.** CHECK apribojimų nėra. `claim_solidgate_entity_event` meta `22023` („invalid Solidgate entity event
claim“), jei `entity_type`/`entity_id`/`event_id` tušti arba `event_created_at`/`lease_seconds` NULL. Lease minimumas
30 s (`GREATEST(p_lease_seconds, 30)`), webhook'as siunčia 300 s. `SELECT ... FOR UPDATE` serializuoja lygiagrečius
claim'us to paties entity eilutėje. Trigger'ių nėra.

### Stulpeliai

| Stulpelis | Tipas · NULL · default | Reikšmė | Kas rašo / kas skaito | Apsaugos ir pastabos |
|---|---|---|---|---|
| `entity_type` | `TEXT` · NOT NULL · — | Entity rūšis. TS naudoja dvi reikšmes: `'payment'` (užsakymas) ir `'subscription'` ([tipas](../../../supabase/functions/solidgate-webhooks/index.ts#L969)). | Rašo: `claim_solidgate_entity_event`. Skaito: visi trys RPC per PK. | PK dalis; DB lygmeniu reikšmės neribojamos. |
| `entity_id` | `TEXT` · NOT NULL · — | Aplinka + provider'io ID: `"<environment>:<order_id>"` arba `"<environment>:<subscription_id>"`. Aplinkos prefiksas leidžia sandbox ir production įvykiams gyventi vienoje lentelėje be `environment` stulpelio. | Rašo: `claim_solidgate_entity_event` iš [`orderedEntityId`](../../../supabase/functions/solidgate-webhooks/index.ts#L978). Skaito: RPC per PK. | PK dalis. |
| `last_event_created_at` | `TIMESTAMPTZ` · NULL · — | Vandens ženklas: paskutinio **sėkmingai užbaigto** įvykio provider'io laiko žyma. Kol NULL, joks įvykis nėra `stale`. Po užbaigimo lygus arba naujesnis įvykis praeina; griežtai senesnis – `stale`. | Rašo: `complete_solidgate_entity_event` ([L2721](../../../supabase/migrations/00001_baseline.sql#L2721)). Skaito: `claim_solidgate_entity_event` stale-guard ([L2687](../../../supabase/migrations/00001_baseline.sql#L2687)). | Palyginimas griežtas `<`; lygios reikšmės praeina. `release_` jo nekeičia. |
| `last_event_id` | `TEXT` · NULL · — | Paskutinio užbaigto įvykio `event_id`. Informacinis – tvarkai nenaudojamas, nes ID nepermatomi. | Rašo: `complete_solidgate_entity_event`. Skaito: —. | — |
| `processing_event_created_at` | `TIMESTAMPTZ` · NULL · — | Šiuo metu apdorojamo įvykio provider'io laiko žyma. Kopijuojama į `last_event_created_at` užbaigiant. | Rašo: `claim_` (nustato), `complete_`/`release_` (NULL). Skaito: — (užbaigimas naudoja `p_event_created_at` parametrą, ne šį stulpelį). | — |
| `processing_event_id` | `TEXT` · NULL · — | Šiuo metu apdorojamo įvykio `event_id` – entity lease savininkas. Kitas įvykis gauna `busy`, kol lease galioja; tas pats `event_id` (pakartotas pristatymas) gali užimti iš naujo. | Rašo: `claim_` (nustato), `complete_`/`release_` (NULL). Skaito: `claim_` busy-check ([L2692](../../../supabase/migrations/00001_baseline.sql#L2692)); `complete_`/`release_` WHERE sąlyga. | — |
| `processing_started_at` | `TIMESTAMPTZ` · NULL · — | Entity lease pradžia. Kai `processing_started_at < NOW() - lease`, kitas įvykis gali perimti entity, net jei `processing_event_id` tebėra užpildytas (nulūžęs worker'is). | Rašo: `claim_` (`NOW()`), `complete_`/`release_` (NULL). Skaito: `claim_` busy-check. | Lease ≥ 30 s; webhook'as 300 s. |
| `updated_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Paskutinio RPC pakeitimo laikas. | Rašo: visi trys RPC (`NOW()`). Skaito: —. | Trigger'io nėra. |

**Susiję RPC ir trigger'iai.** [`claim_solidgate_entity_event`](../../../supabase/migrations/00001_baseline.sql#L2652),
[`complete_solidgate_entity_event`](../../../supabase/migrations/00001_baseline.sql#L2710),
[`release_solidgate_entity_event`](../../../supabase/migrations/00001_baseline.sql#L2733). Trigger'ių nėra.

## Lentelė `public.solidgate_analytics_outbox`

**Paskirtis.** At-least-once PostHog įvykių pristatymas iš webhook'o. Įvykis pirmiausia patvariai įrašomas čia,
o siunčiamas tik po to, kai inbox eilutė užbaigta. `event_key` yra vietinis dedupe raktas (kartotinis webhook'as
neįrašo antros eilutės), `insert_id` – PostHog `$insert_id`, deterministiškai išvestas iš `event_key`
([`deterministicUuid`](../../../supabase/functions/solidgate-webhooks/index.ts#L287)), todėl pakartotinis siuntimas
po neaiškaus tinklo atsakymo netampa antru pajamų įvykiu.

**Gyvavimo ciklas.** Eilutę sukuria [`enqueueAnalytics`](../../../supabase/functions/solidgate-webhooks/index.ts#L308)
(`upsert` su `onConflict: 'environment,event_key', ignoreDuplicates: true`; praleidžiama, kai
`runtime.analyticsEnabled=false`). Kviečia [`enqueueOrderAnalytics`](../../../supabase/functions/solidgate-webhooks/index.ts#L333)
(`order:<orderId>:settled|...`), intro-offer konfliktas ([L678](../../../supabase/functions/solidgate-webhooks/index.ts#L678)),
identity merge ([L724](../../../supabase/functions/solidgate-webhooks/index.ts#L724)), renewal/dunning/cancel/chargeback
handler'iai ([L2190](../../../supabase/functions/solidgate-webhooks/index.ts#L2190), [L3841](../../../supabase/functions/solidgate-webhooks/index.ts#L3841),
[L3997](../../../supabase/functions/solidgate-webhooks/index.ts#L3997), [L4135](../../../supabase/functions/solidgate-webhooks/index.ts#L4135),
[L4183](../../../supabase/functions/solidgate-webhooks/index.ts#L4183), [L4317](../../../supabase/functions/solidgate-webhooks/index.ts#L4317),
[L4407](../../../supabase/functions/solidgate-webhooks/index.ts#L4407)). Užima [`claim_solidgate_analytics_outbox`](../../../supabase/migrations/00001_baseline.sql#L2753)
(`FOR UPDATE SKIP LOCKED`, `ORDER BY created_at`, limitas 1–100; webhook'as prašo 25 su lease 300 s
[L786](../../../supabase/functions/solidgate-webhooks/index.ts#L786)): kandidatai – `pending`/`failed` su
`next_attempt_at <= NOW()` arba `processing` su pasibaigusia lease; užėmimas nustato `status='processing'`,
`attempts+1`, `processing_started_at=NOW()`, `last_error=NULL`. [`drainAnalyticsOutbox`](../../../supabase/functions/solidgate-webhooks/index.ts#L782)
siunčia visas eilutes į PostHog (`uuid: insert_id`, `timestamp: created_at`), tada kiekvieną žymi
`completed` ([L817](../../../supabase/functions/solidgate-webhooks/index.ts#L817)) ir užsakymui uždeda
`orders.analytics_captured_at` ([L827](../../../supabase/functions/solidgate-webhooks/index.ts#L827)). Bet kokia klaida
visą partiją grąžina į `failed` su `next_attempt_at = now` (iš karto vėl užimama) ir `last_error` iki 2000 simbolių
([L844](../../../supabase/functions/solidgate-webhooks/index.ts#L844)); webhook'as tada atsako 5xx, kad Solidgate
pristatytų dar kartą ir tuo pačiu išsemtų eilę net be kito mokėjimų srauto. Terminalinė būsena – `completed`;
eilutės netrinamos. Atskiro cron'o šiai eilei nėra: ją semia tik webhook invokacijos.

**Raktai, indeksai, RLS.** PK `id`. **Unikalūs**: `solidgate_analytics_outbox_environment_event_key`
`(environment, event_key)` ([L902](../../../supabase/migrations/00001_baseline.sql#L902)),
`solidgate_analytics_outbox_environment_insert_id` `(environment, insert_id)` ([L904](../../../supabase/migrations/00001_baseline.sql#L904)).
**Dalinis** `idx_solidgate_analytics_outbox_delivery` `(environment, next_attempt_at, created_at)
WHERE status IN ('pending','failed','processing')` ([L906](../../../supabase/migrations/00001_baseline.sql#L906)).
FK nėra. RLS įjungtas, politikų nėra; `REVOKE ALL` iš `PUBLIC, anon, authenticated`; `GRANT ALL` `service_role`
([L910](../../../supabase/migrations/00001_baseline.sql#L910)). RPC – `service_role` ([L9555](../../../supabase/migrations/00001_baseline.sql#L9555)).

**Apsaugos.** CHECK `environment IN ('production','sandbox')`; CHECK `status IN ('pending','processing','completed','failed')`;
CHECK `attempts >= 0`. Bandymų viršutinės ribos ir `manual_review` būsenos nėra – nuolat lūžtantis įvykis kartojamas
kol pavyks. Trigger'ių nėra.

### Stulpeliai

| Stulpelis | Tipas · NULL · default | Reikšmė | Kas rašo / kas skaito | Apsaugos ir pastabos |
|---|---|---|---|---|
| `id` | `UUID` · NOT NULL · `gen_random_uuid()` | Vidinis PK. | Rašo: DB default. Skaito: `drainAnalyticsOutbox` UPDATE'ai per `.eq('id', row.id)` ([L824](../../../supabase/functions/solidgate-webhooks/index.ts#L824)). | — |
| `environment` | `TEXT` · NOT NULL · `'production'` | Mokėjimų aplinka. Eilė semiama tik savo aplinkai (`p_environment`), todėl sandbox webhook'as niekada nesiunčia production įvykių. | Rašo: `enqueueAnalytics` (`runtime.environment`). Skaito: `claim_solidgate_analytics_outbox` WHERE; `drainAnalyticsOutbox` UPDATE filtras. | CHECK; abiejų unikalių indeksų ir dalinio indekso dalis. |
| `event_key` | `TEXT` · NOT NULL · — | Vietinis dedupe raktas: `order:<orderId>:settled` (ar kitas sufiksas), `renewal:<invoiceId>:paid / voided / refunded:<n>`, `subscription:<id>:cancelled / cancellation-scheduled / payment-failed:<invoice>`, `chargeback:<id>:<status>`, `intro-offer-conflict:...`, `identity:...`. Pakartotinis webhook'as su tuo pačiu raktu nieko neįrašo (`ignoreDuplicates`). | Rašo: `enqueueAnalytics` iš kvietėjo `eventKey`. Skaito: — (unikalumas per indeksą). | UNIQUE `(environment, event_key)`. |
| `event_name` | `TEXT` · NOT NULL · — | PostHog įvykio pavadinimas: `purchase_completed`, `subscription_started`, `oto_subscription_started`, `payment_refunded`, `payment_voided`, `payment_failed` ([L355](../../../supabase/functions/solidgate-webhooks/index.ts#L356)) ir kt. | Rašo: `enqueueAnalytics`. Skaito: `drainAnalyticsOutbox` → `posthog.capture({ event })` ([L803](../../../supabase/functions/solidgate-webhooks/index.ts#L803)). | — |
| `distinct_id` | `TEXT` · NOT NULL · — | PostHog `distinctId`: `session_id ?? user_id ?? order_id` ([L375](../../../supabase/functions/solidgate-webhooks/index.ts#L375)). | Rašo: `enqueueAnalytics`. Skaito: `drainAnalyticsOutbox`. | — |
| `insert_id` | `UUID` · NOT NULL · — | PostHog `$insert_id`/`uuid`: SHA-256(`solidgate:<event_key>`) sutraukta į UUID v5 formą. Deterministiškas, todėl pakartotinis siuntimas dedupe'inamas PostHog pusėje. | Rašo: `enqueueAnalytics` per `deterministicUuid`. Skaito: `drainAnalyticsOutbox` (`uuid`, `properties.$insert_id`). | UNIQUE `(environment, insert_id)`. |
| `properties` | `JSONB` · NOT NULL · `'{}'` | Įvykio savybės: `revenue`, `amount_cents`, `currency`, `product_slug`, `solidgate_order_id`, `subscription_id`, `utm_*`, `funnel_variant` ir kt. ([L376](../../../supabase/functions/solidgate-webhooks/index.ts#L376)). | Rašo: `enqueueAnalytics`. Skaito: `drainAnalyticsOutbox` (siunčia; iš `properties.solidgate_order_id` ima užsakymą `analytics_captured_at` žymai). | — |
| `status` | `TEXT` · NOT NULL · `'pending'` | `pending` (įrašyta, dar neužimta) → `processing` (užimta) → `completed` (išsiųsta) arba `failed` (klaida; iš karto vėl kandidatė). `failed`/pasenusi `processing` → `processing` per claim. | Rašo: DB default; `claim_` RPC; `drainAnalyticsOutbox` ([L817](../../../supabase/functions/solidgate-webhooks/index.ts#L817), [L844](../../../supabase/functions/solidgate-webhooks/index.ts#L844)). Skaito: `claim_` RPC. | CHECK 4 reikšmės; dalinis delivery indeksas. |
| `attempts` | `INTEGER` · NOT NULL · `0` | Užėmimų skaičius (didinamas claim'e, ne užbaigime). | Rašo: `claim_solidgate_analytics_outbox` ([L2780](../../../supabase/migrations/00001_baseline.sql#L2780)). Skaito: TS gauna `attempts` eilutėje ([`AnalyticsOutboxRow`](../../../supabase/functions/solidgate-webhooks/index.ts#L772)), bet sprendimų nepriima. | CHECK `>= 0`; ribos nėra. |
| `processing_started_at` | `TIMESTAMPTZ` · NULL · — | Lease pradžia; `processing` eilutė su `processing_started_at < NOW() - lease` perimama. | Rašo: `claim_` (`NOW()`), `drainAnalyticsOutbox` (NULL užbaigiant/klaidoje). Skaito: `claim_` WHERE. | Lease ≥ 30 s; webhook'as 300 s. |
| `next_attempt_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Kada eilutė vėl gali būti užimta. Analitikos eilėje backoff'o nėra – po klaidos nustatoma į `now` ([L849](../../../supabase/functions/solidgate-webhooks/index.ts#L849)), nes kitas Solidgate pristatymas turi galėti išsemti eilutę. | Rašo: DB default; `drainAnalyticsOutbox` klaidoje. Skaito: `claim_` WHERE (`<= NOW()`); dalinio indekso dalis. | — |
| `completed_at` | `TIMESTAMPTZ` · NULL · — | Sėkmingo išsiuntimo laikas (tas pats `completedAt` rašomas ir į `orders.analytics_captured_at`). | Rašo: `drainAnalyticsOutbox`. Skaito: —. | — |
| `last_error` | `TEXT` · NULL · — | Paskutinės pristatymo klaidos žinutė (≤ 2000 simbolių). Nunulinama claim'e. | Rašo: `drainAnalyticsOutbox` klaidoje; `claim_` (NULL). Skaito: —. | — |
| `created_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Įrašymo laikas. Naudojamas kaip PostHog įvykio `timestamp`, nes PostHog dedupe raktas apima ir laiko žymą ([L804](../../../supabase/functions/solidgate-webhooks/index.ts#L804)). Claim rikiuoja pagal jį (FIFO). | Rašo: DB default. Skaito: `claim_` ORDER BY; `drainAnalyticsOutbox`. | Dalinio delivery indekso dalis. |
| `updated_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Paskutinio pakeitimo laikas. | Rašo: `claim_` RPC; `drainAnalyticsOutbox`. Skaito: —. | Trigger'io nėra. |

**Susiję RPC ir trigger'iai.** [`claim_solidgate_analytics_outbox`](../../../supabase/migrations/00001_baseline.sql#L2753).
Trigger'ių nėra. Užbaigimas ir klaidos rašomos tiesioginiais `UPDATE` iš webhook'o (be RPC ir be claim token'o –
skirtingai nei fulfillment outbox).

## Lentelė `public.solidgate_fulfillment_outbox`

**Paskirtis.** Patvarūs post-purchase šalutiniai efektai, vykdomi ne webhook'o atsakymo kritiniame kelyje, o
programos pusės worker'yje [`solidgate-fulfillment.ts`](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts).
Kiekvienas efektas turi stabilų `effect_key` per užsakymą, todėl tą patį darbą gali saugiai įrašyti ir naršyklės
grant kelias, ir webhook backstop'as – laimi pirmas commit'as, antras įrašas ignoruojamas.

**Gyvavimo ciklas.** Rašytojai (visi `upsert` su `onConflict: 'environment,solidgate_order_id,effect_key',
ignoreDuplicates: true`): funnel [`enqueueMainPurchaseEnrichment`](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L205)
iš grant route ([L1584](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1584)),
[`enqueueCapturedOtoFulfillment`](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L105) iš charge-oto route
([L1810](../../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L1810)), webhook
[`enqueueMainPurchaseEnrichment`](../../../supabase/functions/solidgate-webhooks/index.ts#L490) ir
[`enqueueOtoFulfillment`](../../../supabase/functions/solidgate-webhooks/index.ts#L425) (kviečiami po grant'o
[L2899](../../../supabase/functions/solidgate-webhooks/index.ts#L2899)). Užima
[`claim_solidgate_fulfillment_outbox`](../../../supabase/migrations/00001_baseline.sql#L2789) (`FOR UPDATE SKIP LOCKED`,
`ORDER BY created_at, id`, limitas 1–50): `pending`/`failed` su `next_attempt_at <= NOW()` arba `processing` su
pasibaigusia lease → `status='processing'`, `attempts+1`, naujas `claim_token`, `processing_started_at=NOW()`.
Worker'is [`drainSolidgateFulfillmentOutbox`](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L934)
prašo `p_limit` 5 (numatytasis), `p_lease_seconds` 120, aplinką nustato pagal `VERCEL_ENV`
([L942](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L942)). Jį kviečia: route
[`/api/internal/solidgate-fulfillment`](../../../apps/funnel/src/app/api/internal/solidgate-fulfillment/route.ts#L25)
(POST iš webhook'o su `x-internal-secret`, GET iš Vercel cron su `Bearer CRON_SECRET`; cron `*/5 * * * *`
[`vercel.json`](../../../apps/funnel/vercel.json#L5)); `after()` grant route ([L1604](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1604))
ir charge-oto route ([L1828](../../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L1828)). Kiekvienas
efektas vykdomas [`processEffect`](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L635) su 20 s
timeout'u; visi eilutės UPDATE'ai eina per [`fencedOutboxUpdate`](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L586)
(`WHERE status='processing' AND claim_token=<mano>`), o prieš išorinius kvietimus
[`assertClaimOwned`](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L605) patikrina, ar lease dar mano.
Sėkmė → `completed`, `claim_token=NULL`. Klaida → `failed` su eksponentiniu backoff'u
`min(1800, 5·2^min(attempts,8))` s ([L980](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L980)):
10 s, 20 s, 40 s, 80 s, 160 s, 320 s, 640 s, toliau 1280 s (≈21 min) lubos – 1800 s riba faktiškai nepasiekiama.
`FulfillmentManualReviewError` → `manual_review`, `next_attempt_at` nekeičiamas; claim RPC tokių eilučių
nebeima – terminalinė būsena, kurią keičia tik operatorius. Prarasta lease (`StaleFulfillmentClaimError`) – tyliai
praleidžiama, eilutę užbaigs naujas savininkas. Eilutės netrinamos.

Efektų tipai ir kas juos vykdo (visi `processEffect` viduje, kartu su `SolidgateClient`, Resend ir Meta Graph API):

- `cancel_main_subscription` – įrašo lifetime OTO (`REPLACES_MAIN_SUBSCRIPTION_PRODUCT = 'oto1_lifetime'`,
  [L69](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L69)) capture; `effect_key`
  `cancel_main_subscription:<subscriptionId>`, `payload {subscription_id}`. Worker'is patikrina, kad prenumerata yra
  tos pačios sesijos main planas, atsisako veikti kol main užsakymas dar `pending` (throw = retry,
  [L901](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L901)), atšaukia per Solidgate API
  (`verifiedCancelSubscription`) ir vietinį užsakymą pažymi `canceled` ([L914](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L914)).
- `enrich_main_profile` – po main pirkimo; `payload {user_id}`. Vykdo
  [`enrichPurchasedAccount`](../../../apps/funnel/src/lib/payment/provision-account.ts#L174) (sesijos `locale` →
  `user_prefs`, produkto praplėtimo vieta).
- `send_welcome_email` – tik `production` ir tik kai yra el. paštas; `payload {user_id}`, kurį worker'is papildo
  `prepared_message` ir `delivery_ambiguous_at` ([L822](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L822)).
  Siunčia per Resend su idempotency key `welcome:<orderId>` ([L835](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L835));
  po 23 val. neaiškios būsenos → `manual_review` ([L805](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L805)).
- `send_meta_capi_purchase` – serverio Meta CAPI `Purchase`/`StartTrial`; grant kelias įrašo `payload` su
  `fbp`/`fbc`/`client_ip_address`/`client_user_agent`/`event_source_url`, webhook backstop'as – tik `{user_id}`
  ([L525](../../../supabase/functions/solidgate-webhooks/index.ts#L525)). Ne-production arba be
  `META_CAPI_ACCESS_TOKEN`+pixel ID – užbaigiama kaip no-op ([L683](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L683));
  senesnis nei 6,5 d. užsakymas arba `attempts >= 24` po nesėkmės → `manual_review`
  ([L699](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L699), [L746](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L746)).

Prieš kiekvieną efektą worker'is perskaito šaltinio užsakymą: jei jis atšauktas/grąžintas/ginčijamas arba
entitlement'as `canceled`/`revoked`, efektas užbaigiamas kaip fenced no-op
([L649](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L649), [L863](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L863)).
Naujas efektas reikalauja trijų pakeitimų viename commit'e: CHECK sąrašo, `FulfillmentEffectType` tipo ir
`processEffect` šakos – be handler'io eilutė užimama, lūžta ir kartojama ([DDL komentaras](../../../supabase/migrations/00001_baseline.sql#L919),
[worker komentaras](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L51)).

**Raktai, indeksai, RLS.** PK `id`. UNIQUE `(environment, solidgate_order_id, effect_key)`
([L941](../../../supabase/migrations/00001_baseline.sql#L941)) – vienas efektas per užsakymą. **Dalinis**
`idx_solidgate_fulfillment_outbox_delivery` `(environment, next_attempt_at, created_at) WHERE status IN
('pending','failed','processing')` ([L955](../../../supabase/migrations/00001_baseline.sql#L955)); `manual_review` ir
`completed` eilutės indekse nėra. FK nėra (`solidgate_order_id` yra provider'io tekstinis ID, ne `orders.id`).
RLS įjungtas, politikų nėra; `REVOKE ALL` iš `PUBLIC, anon, authenticated`; `GRANT ALL` `service_role`
([L959](../../../supabase/migrations/00001_baseline.sql#L959)). RPC – `service_role` ([L9558](../../../supabase/migrations/00001_baseline.sql#L9558)).

**Apsaugos.** CHECK `environment IN ('production','sandbox')`; CHECK `status IN ('pending','processing','completed',
'failed','manual_review')`; CHECK `attempts >= 0`; CHECK `(status='processing') = (claim_token IS NOT NULL)`
([L940](../../../supabase/migrations/00001_baseline.sql#L940)) – token'as yra tada ir tik tada, kai eilutė vykdoma
(griežtesnis nei inbox'o `terminal_claim_check`); CHECK `solidgate_fulfillment_outbox_effect_type_check`
`effect_type IN ('cancel_main_subscription','send_welcome_email','enrich_main_profile','send_meta_capi_purchase')`,
pridedamas per `ALTER TABLE ... ADD CONSTRAINT` ([L946](../../../supabase/migrations/00001_baseline.sql#L946)), kad
būtų keičiamas be lentelės perkūrimo. Trigger'ių nėra.

### Stulpeliai

| Stulpelis | Tipas · NULL · default | Reikšmė | Kas rašo / kas skaito | Apsaugos ir pastabos |
|---|---|---|---|---|
| `id` | `UUID` · NOT NULL · `gen_random_uuid()` | Vidinis PK. | Rašo: DB default. Skaito: `fencedOutboxUpdate` (`.eq('id', row.id)`); claim RPC `ORDER BY created_at, id`. | — |
| `environment` | `TEXT` · NOT NULL · — | Mokėjimų aplinka. Worker'is semia tik savo aplinką (Vercel production → `production`, kitaip `sandbox`). | Rašo: visi keturi enqueue'eriai. Skaito: claim RPC WHERE; `fencedOutboxUpdate` filtras. | CHECK; UNIQUE ir dalinio indekso dalis. Default'o nėra – aplinka privaloma. |
| `solidgate_order_id` | `TEXT` · NOT NULL · — | Provider'io užsakymo ID, kuriam priklauso efektas (šaltinio užsakymas). Worker'is per jį perskaito `orders` eilutę ir tikrina, ar efektas dar leistinas. | Rašo: enqueue'eriai. Skaito: `sourceOrderAllowsEffect` ([L369](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L369)), `mainSourceOrderAllowsEffect` ([L445](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L445)); CAPI `eventId`, Resend idempotency key. | UNIQUE dalis. Ne FK. |
| `effect_type` | `TEXT` · NOT NULL · — | Efekto rūšis – žr. sąrašą aukščiau. | Rašo: enqueue'eriai. Skaito: `processEffect` šakos ([L641](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L641), [L865](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L865)); nežinomas tipas → `unknown fulfillment effect` klaida. | CHECK 4 reikšmės. |
| `effect_key` | `TEXT` · NOT NULL · — | Stabilus raktas užsakymo viduje: `enrich_main_profile`, `send_welcome_email`, `send_meta_capi_purchase` (raktas = tipas) arba `cancel_main_subscription:<subscriptionId>` (vienas per atšaukiamą prenumeratą). | Rašo: enqueue'eriai. Skaito: klaidų pranešimai ir timeout'o žinutė. | UNIQUE `(environment, solidgate_order_id, effect_key)`. |
| `payload` | `JSONB` · NOT NULL · `'{}'` | Efekto duomenys: `user_id` (visiems main efektams; worker'is tikrina, kad sutampa su užsakymo `user_id`), `subscription_id` (cancel), CAPI atribucija (`fbp`, `fbc`, `client_ip_address`, `client_user_agent`, `event_source_url`), welcome laiško `prepared_message` ir `delivery_ambiguous_at` (rašo pats worker'is). | Rašo: enqueue'eriai; `processEffect` (welcome parengimas/bandymas, fenced). Skaito: `processEffect`. | Pirmas rašytojas fiksuoja payload'ą (`ignoreDuplicates`), todėl webhook backstop'as neperrašo grant'o atribucijos. |
| `status` | `TEXT` · NOT NULL · `'pending'` | `pending` → `processing` (claim) → `completed` (sėkmė arba fenced no-op) / `failed` (retry po backoff'o) / `manual_review` (terminalinė, tik operatoriui). `failed` ir pasenusi `processing` → `processing` per claim; `manual_review` claim'o neima. | Rašo: DB default; claim RPC; `drainSolidgateFulfillmentOutbox` ([L964](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L964), [L983](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L983)). Skaito: claim RPC; `fencedOutboxUpdate` (`status='processing'`). | CHECK 5 reikšmės; CHECK sąryšis su `claim_token`. |
| `attempts` | `INTEGER` · NOT NULL · `0` | Užėmimų skaičius. Iš jo skaičiuojamas backoff'as ir CAPI 24 bandymų riba. | Rašo: claim RPC ([L2817](../../../supabase/migrations/00001_baseline.sql#L2817)). Skaito: worker'is (`delaySeconds`, `META_CAPI_MAX_ATTEMPTS`). | CHECK `>= 0`. |
| `claim_token` | `UUID` · NULL · — | Lease žetonas, išduodamas claim'e. Visi worker'io UPDATE'ai filtruoja `claim_token = <mano>`; jei kitas worker'is perėmė eilutę (pasibaigus 120 s lease), senasis gauna 0 eilučių ir meta `StaleFulfillmentClaimError`. | Rašo: claim RPC (`gen_random_uuid()`); worker'is (NULL užbaigiant/klaidoje/manual_review). Skaito: `fencedOutboxUpdate`, `assertClaimOwned`. | CHECK: ne-NULL ⇔ `status='processing'`. Tuščias token'as `processing` eilutėje → `StaleFulfillmentClaimError` ([L591](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L591)). |
| `processing_started_at` | `TIMESTAMPTZ` · NULL · — | Lease pradžia; perimama, kai `< NOW() - GREATEST(p_lease_seconds, 30)` (worker'is 120 s). | Rašo: claim RPC (`NOW()`); worker'is (NULL). Skaito: claim RPC WHERE. | — |
| `next_attempt_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Kada eilutė vėl kandidatė. Po klaidos = `now + delaySeconds` (backoff); `manual_review` – paliekamas senas (`row.next_attempt_at`), nes claim'as jos vis tiek neima. | Rašo: DB default; worker'is klaidoje ([L986](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L986)). Skaito: claim RPC (`<= NOW()`); dalinio indekso dalis. | — |
| `completed_at` | `TIMESTAMPTZ` · NULL · — | Užbaigimo laikas (ir fenced no-op atveju). | Rašo: worker'is. Skaito: —. | — |
| `last_error` | `TEXT` · NULL · — | Paskutinė klaida (≤ 2000 simbolių): handler'io žinutė, timeout `fulfillment effect timed out: <effect_key>`, `manual_review` priežastis. Nunulinama claim'e ir užbaigiant. | Rašo: worker'is; claim RPC (NULL). Skaito: —. | — |
| `created_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Įrašymo laikas; claim rikiuoja FIFO (`created_at, id`). Dėl to ilgai lūžtanti sena eilutė (pvz. CAPI su atšauktu token'u) blokuotų naujesnes – tam ir 24 bandymų riba ([komentaras](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L45)). | Rašo: DB default. Skaito: claim RPC ORDER BY. | Dalinio indekso dalis. |
| `updated_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Paskutinio pakeitimo laikas; `assertClaimOwned` jį atnaujina kaip „heartbeat“ UPDATE, kad patikrintų lease. | Rašo: claim RPC; worker'is kiekviename fenced UPDATE. Skaito: —. | Trigger'io nėra. |

**Susiję RPC ir trigger'iai.** [`claim_solidgate_fulfillment_outbox`](../../../supabase/migrations/00001_baseline.sql#L2789).
Trigger'ių nėra. Užbaigimas/klaidos – tiesioginiai fenced `UPDATE` iš worker'io.

## Lentelė `public.meta_capi_event_claims`

**Paskirtis.** Serverio Meta Conversions API ingress apsauga naršyklės inicijuotiems įvykiams: dedupe'ina
`event_id` ir riboja įvykių skaičių per hash'uotą IP. **Svarbu:** `environment` čia yra *diegimo* aplinka
(`production`/`preview`/`development` pagal `VERCEL_ENV`), ne `payment_environment`
([DDL komentaras](../../../supabase/migrations/00001_baseline.sql#L745), [`analyticsEnvironment`](../../../apps/funnel/src/app/api/meta/capi/route.ts#L34)).
Ši lentelė nesusijusi su `send_meta_capi_purchase` outbox efektu – tas eina per fulfillment outbox be claim'o čia.

**Gyvavimo ciklas.** Eilutę sukuria [`claim_meta_capi_event`](../../../supabase/migrations/00001_baseline.sql#L9036)
(`SECURITY DEFINER`), kurį kviečia [`POST /api/meta/capi`](../../../apps/funnel/src/app/api/meta/capi/route.ts#L175)
po sesijos ir (Purchase/StartTrial atveju) užsakymo bei payment cookie patikros. RPC eiga: (1) ištrina senesnes nei
30 d. eilutes, (2) `pg_advisory_xact_lock(hash(environment:ip_hash))` serializuoja to paties IP užklausas, (3)
suskaičiuoja IP įvykius lange (`p_window_seconds` 600, `p_max_events` 40) – viršijus grąžina `FALSE`, (4)
`INSERT ... ON CONFLICT (environment, event_name, event_id) DO NOTHING` – dublikatas grąžina `FALSE`. Route'as
`FALSE` atveju atsako 202 `accepted:false` neatskleisdamas, kuris saugiklis suveikė. Jei siuntimas į Meta
nepavyksta du kartus, route'as **ištrina** claim'ą ([L216](../../../apps/funnel/src/app/api/meta/capi/route.ts#L216)),
kad vėlesnis pakartojimas nebūtų užblokuotas. Kitų trynimų nėra, išskyrus 30 d. retenciją pačiame RPC.
Pastaba: naršyklės klientas [`sendCapiFromBrowser`](../../../apps/funnel/src/features/analytics/lib/meta-capi-client.ts#L27)
šiuo metu niekur neimportuojamas (mirror'as išjungtas, žr. [komentarą](../../../apps/funnel/src/features/analytics/hooks/use-analytics.ts#L83)),
todėl production'e ši lentelė pildoma tik jei mirror'as vėl įjungiamas.

**Raktai, indeksai, RLS.** PK `id` (`BIGINT GENERATED BY DEFAULT AS IDENTITY`). UNIQUE `(environment, event_name, event_id)`
([L757](../../../supabase/migrations/00001_baseline.sql#L757)). Indeksai: `meta_capi_event_claims_ip_window_idx`
`(environment, ip_hash, created_at DESC)` ([L760](../../../supabase/migrations/00001_baseline.sql#L760)) – lango
skaičiavimui; `meta_capi_event_claims_retention_idx` `(created_at)` ([L762](../../../supabase/migrations/00001_baseline.sql#L762))
– 30 d. valymui. FK `session_id → sessions(id) ON DELETE SET NULL`. RLS įjungtas, politikų nėra; `REVOKE ALL` iš
`PUBLIC, anon, authenticated`; `GRANT ALL` `service_role` ([L765](../../../supabase/migrations/00001_baseline.sql#L765)).
RPC – `service_role` ([L9682](../../../supabase/migrations/00001_baseline.sql#L9691)).

**Apsaugos.** CHECK `environment IN ('production','preview','development')`. RPC tyliai grąžina `FALSE` (be
klaidos), jei aplinka ne iš sąrašo, `event_name`/`event_id`/`ip_hash` tušti arba langas/limitas < 1. Route'as
prieš RPC validuoja `eventName` iš `Lead|AddToCart|InitiateCheckout|Purchase|StartTrial`, `eventId` pagal
`^[A-Za-z0-9:_-]{8,255}$`, `sessionId` UUID, `Origin` antraštę. Trigger'ių nėra.

### Stulpeliai

| Stulpelis | Tipas · NULL · default | Reikšmė | Kas rašo / kas skaito | Apsaugos ir pastabos |
|---|---|---|---|---|
| `id` | `BIGINT` · NOT NULL · identity (BY DEFAULT) | Vidinis PK. | Rašo: DB identity. Skaito: —. | — |
| `environment` | `TEXT` · NOT NULL · — | Diegimo aplinka (`VERCEL_ENV`), kad preview testai neblokuotų production `event_id`. | Rašo: `claim_meta_capi_event` iš `analyticsEnvironment()`. Skaito: RPC lango skaičiavimas; route DELETE filtras. | CHECK 3 reikšmės; UNIQUE ir indeksų dalis. |
| `event_name` | `TEXT` · NOT NULL · — | Meta standartinis įvykis (`Purchase`, `StartTrial`, `Lead`, ...). Dedupe raktas kartu su `event_id`, nes tas pats `event_id` gali būti naudojamas skirtingiems įvykiams. | Rašo: RPC. Skaito: route DELETE. | UNIQUE dalis. |
| `event_id` | `TEXT` · NOT NULL · — | Naršyklės pateiktas deterministiškas ID (pirkimams `purchase:<solidgate_order_id>`, [L128](../../../apps/funnel/src/app/api/meta/capi/route.ts#L129)); tas pats ID siunčiamas ir iš pixel'io, kad Meta sujungtų porą. | Rašo: RPC. Skaito: route DELETE. | UNIQUE dalis; formatą tikrina route. |
| `ip_hash` | `TEXT` · NOT NULL · — | HMAC-SHA256(`PAYMENT_COOKIE_SECRET`, kliento IP) ([`hashIp`](../../../apps/funnel/src/app/api/meta/capi/route.ts#L40)) – rate-limit raktas be žalio IP saugojimo. | Rašo: RPC. Skaito: RPC `COUNT(*)` lange ([L9078](../../../supabase/migrations/00001_baseline.sql#L9078)). | `ip_window_idx`. |
| `session_id` | `UUID` · NULL · — | Funnel sesija, kurios vardu įvykis pateiktas (route prieš tai patikrina, kad sesija egzistuoja). | Rašo: RPC iš `p_session_id`. Skaito: —. | FK `sessions(id) ON DELETE SET NULL`. |
| `created_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Claim'o laikas; lango ir 30 d. retencijos pagrindas. | Rašo: DB default. Skaito: RPC (`>= NOW() - window`, `< NOW() - 30 days` DELETE). | Abu indeksai. |

**Susiję RPC ir trigger'iai.** [`claim_meta_capi_event`](../../../supabase/migrations/00001_baseline.sql#L9036). Trigger'ių nėra.

## Lentelė `public.cron_runs`

**Paskirtis.** Suplanuotų darbų stebimumas: viena eilutė per paleidimą, sėkmingą ar ne. Cron route'o
`{ ok: false }` atsakymo niekas neskaito, todėl ši lentelė – vienintelis būdas pamatyti tyliai lūžtantį ar visai
nebeveikiantį darbą (`select * from cron_runs where ok = false order by ran_at desc`; tarpas `ran_at` sekoje reiškia,
kad darbas nebeleidžiamas) ([DDL komentaras](../../../supabase/migrations/00001_baseline.sql#L399)).

**Gyvavimo ciklas.** Vienintelis rašytojas – [`recordCronRun`](../../../apps/pwa/src/lib/record-cron-run.ts#L29)
(INSERT per admin klientą, best-effort, niekada nemeta klaidos, `failures` apkarpo iki 30 elementų). Ši funkcija
**šiuo metu niekur nekviečiama** (patikrinta grep'u; jos pačios komentaras tai pripažįsta). Vienintelis realus
cron'as šiame boilerplate – funnel [`/api/internal/solidgate-fulfillment`](../../../apps/funnel/src/app/api/internal/solidgate-fulfillment/route.ts#L43)
kas 5 min. – **nerašo** į `cron_runs`; PWA [`vercel.json`](../../../apps/pwa/vercel.json#L3) turi `crons: []`.
[`docs/cron-jobs.md`](../../../docs/cron-jobs.md#L85) aprašo tris PWA darbus (`daily-content`, `daily-focus`,
`moon-forecast`), kurių route'ų šiame repo nėra (`apps/pwa/src/app/api/cron/` neegzistuoja) – tai šaltinio projekto
palikimas, ne šio boilerplate būsena. Skaitytojų TS kode nėra; eilutės netrinamos (retencijos nėra).

**Raktai, indeksai, RLS.** PK `id` (`BIGINT GENERATED ALWAYS AS IDENTITY`). Indeksai: `idx_cron_runs_job_ran_at`
`(job, ran_at DESC)` ([L419](../../../supabase/migrations/00001_baseline.sql#L419)); **dalinis** `idx_cron_runs_failed`
`(ran_at DESC) WHERE ok = false` ([L420](../../../supabase/migrations/00001_baseline.sql#L420)). FK nėra. RLS
įjungtas, politikų nėra; `REVOKE ALL` iš `PUBLIC, anon, authenticated`; `GRANT ALL` `service_role`
([L423](../../../supabase/migrations/00001_baseline.sql#L423)).

**Apsaugos.** CHECK apribojimų ir trigger'ių nėra. `id` yra `GENERATED ALWAYS`, todėl rankinis `id` įrašymas be
`OVERRIDING SYSTEM VALUE` lūžta. Lentelė nėra sugeneruotuose `Database` tipuose – `recordCronRun` naudoja
netipizuotą klientą ([L33](../../../apps/pwa/src/lib/record-cron-run.ts#L33)).

### Stulpeliai

| Stulpelis | Tipas · NULL · default | Reikšmė | Kas rašo / kas skaito | Apsaugos ir pastabos |
|---|---|---|---|---|
| `id` | `BIGINT` · NOT NULL · identity (ALWAYS) | Vidinis PK, auga monotoniškai. | Rašo: DB identity. Skaito: —. | `GENERATED ALWAYS`. |
| `job` | `TEXT` · NOT NULL · — | Darbo pavadinimas (pagal [`cron-jobs.md`](../../../docs/cron-jobs.md#L352) konvenciją – kebab-case route slug'as). | Rašo: `recordCronRun` iš `stats.job`. Skaito: — (indeksas skirtas `WHERE job = ...` užklausoms). | `job_ran_at` indeksas. |
| `ran_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Paleidimo laikas (įrašymo momentas). | Rašo: DB default. Skaito: —. | Abu indeksai. |
| `ok` | `BOOLEAN` · NOT NULL · — | Ar paleidimas pavyko kaip visuma. `false` eilutės – dalinis indeksas. | Rašo: `recordCronRun` iš `stats.ok`. Skaito: —. | Dalinio indekso sąlyga. |
| `total` | `INTEGER` · NOT NULL · `0` | Kiek vienetų darbas turėjo apdoroti. | Rašo: `recordCronRun`. Skaito: —. | — |
| `generated` | `INTEGER` · NOT NULL · `0` | Kiek vienetų sugeneruota iš naujo (brangi operacija, pvz. AI kvietimas). | Rašo: `recordCronRun`. Skaito: —. | — |
| `cached` | `INTEGER` · NOT NULL · `0` | Kiek vienetų praleista, nes rezultatas jau buvo (idempotencijos rodiklis). | Rašo: `recordCronRun`. Skaito: —. | — |
| `failed` | `INTEGER` · NOT NULL · `0` | Kiek vienetų lūžo. | Rašo: `recordCronRun`. Skaito: —. | — |
| `failures` | `JSONB` · NOT NULL · `'[]'` | Klaidų detalių masyvas; `recordCronRun` apkarpo iki 30 elementų ([L41](../../../apps/pwa/src/lib/record-cron-run.ts#L41)). | Rašo: `recordCronRun`. Skaito: —. | — |
| `duration_ms` | `INTEGER` · NULL · — | Paleidimo trukmė milisekundėmis. | Rašo: `recordCronRun` iš `stats.durationMs`. Skaito: —. | — |

**Susiję RPC ir trigger'iai.** Nėra. Vienintelis rašytojas – TS [`recordCronRun`](../../../apps/pwa/src/lib/record-cron-run.ts#L29) (nekviečiama).

## Lentelė `public.generation_locks`

**Paskirtis.** Bendras single-flight vartas brangiam serverio darbui (AI kvietimai, ataskaitų generavimas): du
lygiagretūs prašymai tam pačiam `(scope, scope_key)` – tik vienas vykdo darbą, kitas gauna „užimta iki“ ir turi
grįžti prie cache'uotų duomenų. Pasibaigusi eilutė elgiasi kaip užrakto nebuvimas, todėl nulūžęs prašymas negali
užrakinti rakto amžinai ([DDL komentaras](../../../supabase/migrations/00001_baseline.sql#L378)).

**Gyvavimo ciklas.** [`acquireGenerationLock`](../../../packages/shared/src/generation-lock.ts#L24): pirma
`DELETE` tos pačios `(scope, scope_key)` eilutės, kurios `expires_at < now` (savo pasenusio užrakto šlavimas), tada
`INSERT` (`expires_at = now + ttlSeconds`, numatytasis 300 s). `23505` (unique_violation) reiškia, kad užraktą laiko
kitas – funkcija perskaito laikytojo `expires_at` ir grąžina `{acquired:false, heldUntil}`; bet kokia kita klaida
irgi traktuojama kaip „užimta“ (fail-safe, kad nebūtų dubliuotas brangus kvietimas).
[`releaseGenerationLock`](../../../packages/shared/src/generation-lock.ts#L80) – `DELETE` pagal raktą.
[`withGenerationLock`](../../../packages/shared/src/generation-lock.ts#L105) apvynioja acquire → work → release
(`finally`, todėl užraktas nenuteka ir po throw). **Šiuo metu nė viena iš trijų funkcijų nekviečiama iš `apps/`**
(patikrinta grep'u) – tai paruošta infrastruktūra būsimam produkto darbui. Pasenusios eilutės kito rakto
nešluojamos; bendro valymo darbo nėra.

**Raktai, indeksai, RLS.** PK `(scope, scope_key)` ([L387](../../../supabase/migrations/00001_baseline.sql#L387)) –
pats atominis vartas. Indeksas `idx_generation_locks_expires_at` `(expires_at)`
([L391](../../../supabase/migrations/00001_baseline.sql#L391)). FK nėra. RLS įjungtas, politikų nėra; `REVOKE ALL`
iš `PUBLIC, anon, authenticated`; `GRANT ALL` `service_role` ([L395](../../../supabase/migrations/00001_baseline.sql#L395)).

**Apsaugos.** CHECK apribojimų ir trigger'ių nėra. `INSERT ... ON CONFLICT DO NOTHING` semantiką DDL komentaras
mini, bet TS naudoja paprastą `INSERT` ir gaudo `23505` – rezultatas tas pats (įterpėjas laimi).

### Stulpeliai

| Stulpelis | Tipas · NULL · default | Reikšmė | Kas rašo / kas skaito | Apsaugos ir pastabos |
|---|---|---|---|---|
| `scope` | `TEXT` · NOT NULL · — | Užrakto sritis (kokio tipo darbas, pvz. ataskaitos rūšis). | Rašo: `acquireGenerationLock`. Skaito: `acquire`/`release` `.eq('scope', ...)`. | PK dalis. |
| `scope_key` | `TEXT` · NOT NULL · — | Konkretus raktas srityje (pvz. vartotojo ar dienos ID). | Rašo: `acquireGenerationLock`. Skaito: `acquire`/`release`. | PK dalis. |
| `acquired_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Užrakto paėmimo laikas (TS įrašo tą pačią `now` reikšmę, iš kurios skaičiuoja `expires_at`). | Rašo: `acquireGenerationLock` ([L47](../../../packages/shared/src/generation-lock.ts#L47)). Skaito: —. | — |
| `expires_at` | `TIMESTAMPTZ` · NOT NULL · — | Kada užraktas nustoja galioti. Pasibaigęs užraktas ištrinamas prieš naują `INSERT`; laikytojo `expires_at` grąžinamas kaip `heldUntil`. | Rašo: `acquireGenerationLock` (`now + ttl`). Skaito: `acquire` (`.lt('expires_at', now)` DELETE; `select('expires_at')` laikytojui). | Indeksas. Default'o nėra – TTL privalomas. |

**Susiję RPC ir trigger'iai.** Nėra. Visa logika TS [`generation-lock.ts`](../../../packages/shared/src/generation-lock.ts#L1) (nekviečiama iš programų).

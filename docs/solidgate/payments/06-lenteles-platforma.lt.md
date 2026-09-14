# Lentelės: sesijos, auth ir platformos pagalbinės lentelės

> Šis detalus aprašymas fiksuoja būseną iki 2026-09-14 audito pataisų. Naujas pinigų žurnalas, auth / kortelės patvirtinimo apsaugos ir pakeisti srautai aprašyti [pataisų dokumente](../FIXES_2026-09-14.lt.md).

Šis dokumentas aprašo platformos sluoksnį, ant kurio stovi mokėjimai: anoniminę funnel sesiją
(`sessions`) – vienintelį ryšį tarp naršyklės, `orders` ir vėliau sukuriamo auth vartotojo; funnel įvykių
veidrodį analitikai (`funnel_events`); OTP brute-force žurnalą (`otp_attempts`); nario nustatymus
(`user_prefs`) ir GDPR trynimo audito karkasą (`deletion_requests`). Iš viso 5 lentelės ir 42 stulpeliai.
Skirtingai nei `solidgate_*` lentelės, trys iš šių (`sessions`, `funnel_events`, `user_prefs`) turi `anon`/`authenticated`
RLS politikas – kiekviena aprašyta prie savo lentelės.

## Lentelė `public.sessions`

**Paskirtis.** Viena anoniminė funnel sesija per lankytoją. Naršyklė sugeneruoja UUID
([`crypto.randomUUID()`](../../../apps/funnel/src/features/quiz/components/quiz-page.tsx#L152)) ir per
`/api/session/persist` įrašo quiz atsakymus, el. paštą, lokalę ir sutikimus. Sesija yra jungtis tarp trijų pasaulių:
(1) `orders.session_id` (FK `ON DELETE CASCADE`, [L456](../../../supabase/migrations/00001_baseline.sql#L456)) susieja
kiekvieną mokėjimo bandymą su anoniminiu lankytoju dar prieš atsirandant auth vartotojui; (2) `sessions.user_id`
užpildomas po pirkimo (grant/claim/OTP), ir tada `orders.user_id` + `orders.claimed_at` „pereina“ vartotojui; (3)
`sessions.email` yra vienintelis kelias nuo el. pašto iki apmokėtų užsakymų, nes `orders` el. pašto stulpelio neturi
([komentaras](../../../packages/shared/src/auth/request-otp.ts#L84)). `quiz_answers` yra laisvos formos JSONB, kad quiz
keistų formą be migracijos ([DDL komentaras](../../../supabase/migrations/00001_baseline.sql#L240)). Sesija taip pat laiko
OTO grandinės kontrolinį tašką (`last_oto_step`) ir aplinkos „prisegimą“ (`solidgate_oto_environment`).

Ko šioje lentelėje **nėra**: `utm_*` stulpelių (UTM keliauja `orders.tracking_metadata` ir pirmojo pirkimo
atribucija saugoma [`user_acquisition_attribution`](../../../supabase/migrations/00001_baseline.sql#L706)),
`claimed_at` (jis yra `orders` lentelėje, [L502](../../../supabase/migrations/00001_baseline.sql#L502)) ir kortelės
token'ų (sąmoningai iškelti į `solidgate_session_vault`, nes `sessions` turi `anon` INSERT / `authenticated` UPDATE
politikas, o stulpelio lygio REVOKE Supabase'e neveikia – [komentaras](../../../supabase/migrations/00001_baseline.sql#L1015)).

**Gyvavimo ciklas.** Eilutę sukuria [`POST /api/session/persist`](../../../apps/funnel/src/app/api/session/persist/route.ts#L255)
(admin klientas; INSERT su naršyklės `id`, privaloma `locale`), kai `sessionId` dar nerastas. Kviečia quiz
[`use-quiz-persistence.ts`](../../../apps/funnel/src/features/quiz/hooks/use-quiz-persistence.ts#L19) (kiekvienas
žingsnis, `source:'quiz'`), lead capture ([L91](../../../apps/funnel/src/features/quiz/hooks/use-quiz-persistence.ts#L91)),
rezultatų puslapis ([`result_segment`](../../../apps/funnel/src/features/results/components/results-page.tsx#L38)),
pasiūlymo puslapis ([L124](../../../apps/funnel/src/features/offer/components/offer-page.tsx#L124)), special-offer
el. pašto vartai ([L84](../../../apps/funnel/src/features/offer/components/special-offer-email-gate.tsx#L84),
`source:'special-offer'|'special-offer-free'`) ir checkout komponentas prieš užsakymo atidarymą
([L629](../../../apps/funnel/src/components/checkout/solidgate-checkout.tsx#L629)). Tolesni kvietimai daro UPDATE
([L267](../../../apps/funnel/src/app/api/session/persist/route.ts#L267)). Special-offer įėjimui su jau žinomu el. paštu
route'as nukopijuoja `quiz_answers` + `result_segment` iš naujausios ankstesnės to paties el. pašto sesijos
(„hydration“, [L220](../../../apps/funnel/src/app/api/session/persist/route.ts#L220)) ir blokuoja pakartotinį pirkimą,
jei el. paštas jau turi aktyvų entitlement'ą (409 `already_subscribed`,
[L132](../../../apps/funnel/src/app/api/session/persist/route.ts#L132)). `user_id` užpildo penki keliai:
[`linkAuthUser`](../../../apps/funnel/src/lib/payment/provision-account.ts#L100) (grant route po apmokėjimo),
[`handleClaimPurchase`](../../../packages/shared/src/auth/claim-purchase.ts#L101) (tik dabartinę sesiją pagal payment
cookie), [`handleVerifyOtp`](../../../packages/shared/src/auth/verify-otp.ts#L127) (visas neprisietas to el. pašto
sesijas), [`handleRequestOtp`](../../../packages/shared/src/auth/request-otp.ts#L122) self-heal (kai el. paštas turi
`completed` užsakymą, bet auth vartotojo nėra) ir webhook settle backstop'as
([L2834](../../../supabase/functions/solidgate-webhooks/index.ts#L2834), tik kai `user_id IS NULL`; pralaimėjus kitam
vartotojui – klaida). OTO kontrolinį tašką keičia tik SQL: [`advance_solidgate_oto_progress`](../../../supabase/migrations/00001_baseline.sql#L5913).
Eilutės programos kodu netrinamos; trynimas kaskadu nuneštų `orders`, `funnel_events`, `solidgate_session_vault`,
`solidgate_main_checkout_states` (GDPR dokumentas dėl to rekomenduoja anonimizuoti, ne trinti,
[gdpr-compliance.md](../../../docs/gdpr-compliance.md#L313)). `auth.users` trynimas `user_id` tik nunulina.

**Raktai, indeksai, RLS.** PK `id`. FK `user_id → auth.users(id) ON DELETE SET NULL`. Indeksai (visi pilni):
`idx_sessions_email (email)` ([L277](../../../supabase/migrations/00001_baseline.sql#L277)), `idx_sessions_user_id (user_id)`
([L278](../../../supabase/migrations/00001_baseline.sql#L278)), `idx_sessions_current_step (current_step_id)`
([L279](../../../supabase/migrations/00001_baseline.sql#L279)). Į `sessions` rodo FK: `funnel_events.session_id` (CASCADE,
[L302](../../../supabase/migrations/00001_baseline.sql#L302)), `orders.session_id` (CASCADE, [L456](../../../supabase/migrations/00001_baseline.sql#L456)),
`user_acquisition_attribution.source_session_id` (SET NULL, [L710](../../../supabase/migrations/00001_baseline.sql#L710)),
`meta_capi_event_claims.session_id` (SET NULL, [L755](../../../supabase/migrations/00001_baseline.sql#L755)),
`solidgate_intro_claims.session_id` (SET NULL, [L973](../../../supabase/migrations/00001_baseline.sql#L973)),
`solidgate_session_vault.session_id` (CASCADE, [L1023](../../../supabase/migrations/00001_baseline.sql#L1023)),
`solidgate_account_vault.session_origin_id` (SET NULL, [L1097](../../../supabase/migrations/00001_baseline.sql#L1097)),
`solidgate_main_checkout_states.session_id` (CASCADE, [L1127](../../../supabase/migrations/00001_baseline.sql#L1127)).
RLS įjungtas; politikos: `"Anyone can create a session"` – `INSERT TO anon WITH CHECK (true)`
([L284](../../../supabase/migrations/00001_baseline.sql#L284)); `"Authenticated users can read their own sessions"` –
`SELECT TO authenticated USING (user_id = auth.uid())` ([L288](../../../supabase/migrations/00001_baseline.sql#L288));
`"Authenticated users can update their own sessions"` – `UPDATE TO authenticated USING/WITH CHECK (user_id = auth.uid())`
([L293](../../../supabase/migrations/00001_baseline.sql#L293)). `anon` SELECT/UPDATE ir bet kieno DELETE politikų
nėra. Aiškaus `GRANT`/`REVOKE` šiai lentelei baseline neturi. Šio repo TS kodas nė vienos politikos nenaudoja –
visi skaitymai ir rašymai eina per `service_role` admin klientą (naršyklėje `from('sessions')` kvietimų nėra), todėl
politikos yra atsarginis paviršius, ne aktyvus kelias.

**Apsaugos.** CHECK `sessions_solidgate_oto_environment_check`: `solidgate_oto_environment IS NULL OR IN
('production','sandbox')` ([L271](../../../supabase/migrations/00001_baseline.sql#L271)). Trigger'ių ant `sessions`
nėra (`updated_at` rašo route'ai ir RPC rankiniu būdu). Netiesioginės apsaugos iš SQL: `orders` BEFORE trigger'is
[`guard_solidgate_oto_payable_order`](../../../supabase/migrations/00001_baseline.sql#L1580) užrakina sesiją
(`FOR UPDATE`, [L1729](../../../supabase/migrations/00001_baseline.sql#L1729)) ir meta `23514` `invalid persisted OTO step` /
`oto_progress_environment_mismatch` / `oto_progress_conflict`; [`open_solidgate_oto_order_v2`](../../../supabase/migrations/00001_baseline.sql#L3997)
ir [`advance_solidgate_oto_progress`](../../../supabase/migrations/00001_baseline.sql#L5959) elgiasi taip pat (pastarasis
dar `P0002` `oto_progress_session_not_found`, `22023` `invalid_oto_current_step`). Route lygio validacija: `locale`
turi būti iš `routing.locales` (400 `Invalid locale`), `source` iš `ALLOWED_SOURCES` (400 `Invalid source`), naujai
sesijai `locale` privaloma (400 `Missing locale for new session`).

### Stulpeliai

| Stulpelis | Tipas · NULL · default | Reikšmė | Kas rašo / kas skaito | Apsaugos ir pastabos |
|---|---|---|---|---|
| `id` | `UUID` · NOT NULL · `gen_random_uuid()` | Sesijos ID. Praktiškai DB default nenaudojamas: UUID sugeneruoja naršyklė ir perduoda kiekviename persist kvietime; tas pats ID keliauja į `orders.session_id`, payment cookie ir Solidgate `customer_account_id`. | Rašo: [persist INSERT](../../../apps/funnel/src/app/api/session/persist/route.ts#L255) iš `body.sessionId`. Skaito: visi route'ai per `.eq('id', sessionId)` – [read](../../../apps/funnel/src/app/api/session/read/route.ts#L18), [create-session](../../../apps/funnel/src/app/api/solidgate/create-session/route.ts#L276), [charge-oto](../../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L1035), webhook ([L3287](../../../supabase/functions/solidgate-webhooks/index.ts#L3287) tikrina, ar `customer_account_id` yra mūsų sesija). | PK. Route'ai tikrina UUID formą ([session-summary](../../../apps/funnel/src/app/api/orders/session-summary/route.ts#L21)). |
| `email` | `TEXT` · NULL · — | Lead el. paštas, įvestas quiz'e arba special-offer vartuose. Po pirkimo tampa auth vartotojo el. paštu ir raktu OTP prisiejimui (`WHERE email = ? AND user_id IS NULL`). Neunikalus – tas pats el. paštas gali turėti daug sesijų. | Rašo: persist ([L71](../../../apps/funnel/src/app/api/session/persist/route.ts#L71)). Skaito: [verify-otp](../../../packages/shared/src/auth/verify-otp.ts#L117), [request-otp](../../../packages/shared/src/auth/request-otp.ts#L87) (join su `orders!inner`), [claim-purchase](../../../packages/shared/src/auth/claim-purchase.ts#L32), [create-session](../../../apps/funnel/src/app/api/solidgate/create-session/route.ts#L276), [CAPI route](../../../apps/funnel/src/app/api/meta/capi/route.ts#L113) (hash'uojamas `em`), hydration ir dublikatų sargas persist'e, admin [lead statistika](../../../apps/funnel/src/app/admin/_queries/funnel.ts#L211). | `idx_sessions_email`. Formato validacijos DB nėra; persist priima bet kokią eilutę. AC sąrašo pridėjimas – tik `source` ne special ([L297](../../../apps/funnel/src/app/api/session/persist/route.ts#L297)). |
| `quiz_answers` | `JSONB` · NOT NULL · `'{}'` | Visi quiz atsakymai kaip `{stepId: value}` maišas. Schema neapibrėžta DB lygiu – quiz konfigūracija keičiama be migracijos. Hydration kopijuoja visą objektą į naują special-offer sesiją. | Rašo: persist ([L67](../../../apps/funnel/src/app/api/session/persist/route.ts#L67)); special-offer vartai rašo `{}`. Skaito: [read route](../../../apps/funnel/src/app/api/session/read/route.ts#L18) (quiz atkūrimui), [grant route](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1362), fulfillment worker'is [L656](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L656) → [`enrichPurchasedAccount`](../../../apps/funnel/src/lib/payment/provision-account.ts#L174) (produkto praplėtimo vieta), hydration ([L220](../../../apps/funnel/src/app/api/session/persist/route.ts#L220)) su `HYDRATION_REQUIRED_ANSWER_KEYS` JSONB predikatais. | PostgREST `quiz_answers->key` filtrai neklysta kompiliuojant – raktas, kurio quiz nerašo, tyliai niekada nesutaps ([komentaras](../../../apps/funnel/src/app/api/session/persist/route.ts#L25)). |
| `result_segment` | `TEXT` · NULL · — | Quiz rezultato segmentas (pvz. pagrindinis tikslas), pagal kurį personalizuojamas pasiūlymas. Rašomas fire-and-forget iš rezultatų ir pasiūlymo puslapių. | Rašo: persist ([L75](../../../apps/funnel/src/app/api/session/persist/route.ts#L75)) iš [results-page](../../../apps/funnel/src/features/results/components/results-page.tsx#L38) / [offer-page](../../../apps/funnel/src/features/offer/components/offer-page.tsx#L124); hydration kopija. Skaito: [read route](../../../apps/funnel/src/app/api/session/read/route.ts#L18). | — |
| `current_step_id` | `TEXT` · NULL · — | Paskutinio pasiekto quiz žingsnio ID (iš `quiz-config.ts`), kad grįžęs lankytojas tęstų nuo tos vietos. Special-offer vartai rašo `null`. | Rašo: persist ([L63](../../../apps/funnel/src/app/api/session/persist/route.ts#L63)). Skaito: [read route](../../../apps/funnel/src/app/api/session/read/route.ts#L18). | `idx_sessions_current_step` (skirtas nutraukimo analizei; TS kode šiuo stulpeliu nefiltruojama). |
| `locale` | `TEXT` · NOT NULL · — | Funnel kalba (`routing.locales`). Keičiama quiz metu per kalbos jungiklį ([`persistSessionLocale`](../../../apps/funnel/src/features/quiz/hooks/use-quiz-persistence.ts#L42)). Iš čia sėjama `user_prefs.locale`, parenkama welcome laiško kalba ir įrašoma nekintama `orders.solidgate_checkout_locale`. | Rašo: persist ([L255](../../../apps/funnel/src/app/api/session/persist/route.ts#L255), [L263](../../../apps/funnel/src/app/api/session/persist/route.ts#L263)). Skaito: [create-session](../../../apps/funnel/src/app/api/solidgate/create-session/route.ts#L276), [charge-oto](../../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L1035), [verify-otp](../../../packages/shared/src/auth/verify-otp.ts#L142) (naujausios sesijos lokalė → `user_prefs`), [request-otp](../../../packages/shared/src/auth/request-otp.ts#L87), fulfillment worker'is ([L656](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L656)), admin [locales](../../../apps/funnel/src/app/admin/_queries/locales.ts#L14). | Route validuoja prieš `routing.locales`; DB CHECK nėra. |
| `source` | `TEXT` · NOT NULL · `'quiz'` | Įėjimo taškas: `quiz` (pagrindinis funnel), `special-offer` (nuolaidos intro abandonment puslapis), `special-offer-free` (nemokamo intro abandonment puslapis) – [`ALLOWED_SOURCES`](../../../apps/funnel/src/app/api/session/persist/route.ts#L19). Nuo jo priklauso hydration, dublikatų sargas ir AC sąrašo pridėjimas. | Rašo: persist ([L103](../../../apps/funnel/src/app/api/session/persist/route.ts#L103)). Skaito: admin [`countQuizSessions`](../../../apps/funnel/src/app/admin/_queries/funnel.ts#L150) (`source='quiz'`). | TEXT be CHECK, kad naujas įėjimas nereikalautų migracijos; route atmeta nežinomas reikšmes. |
| `user_id` | `UUID` · NULL · — | Auth vartotojas, kuriam sesija priklauso po pirkimo. NULL = anoniminė. Autorizacijos pagrindas OTO/ordersroute'uose (`sessionUserId` lyginamas su prisijungusiu vartotoju arba payment cookie) ir RLS politikų sąlyga. | Rašo: [`linkAuthUser`](../../../apps/funnel/src/lib/payment/provision-account.ts#L100), [claim-purchase](../../../packages/shared/src/auth/claim-purchase.ts#L101), [verify-otp](../../../packages/shared/src/auth/verify-otp.ts#L127), [request-otp](../../../packages/shared/src/auth/request-otp.ts#L122), webhook ([L2834](../../../supabase/functions/solidgate-webhooks/index.ts#L2834), `.is('user_id', null)`). Skaito: [read route](../../../apps/funnel/src/app/api/session/read/route.ts#L32), [session-summary](../../../apps/funnel/src/app/api/orders/session-summary/route.ts#L56), [advance-oto](../../../apps/funnel/src/app/api/solidgate/advance-oto/route.ts#L34), [pm-info](../../../apps/funnel/src/app/api/solidgate/pm-info/route.ts#L24), [charge-oto](../../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L1035), webhook ownership patikros ([L1870](../../../supabase/functions/solidgate-webhooks/index.ts#L1870), [L3142](../../../supabase/functions/solidgate-webhooks/index.ts#L3142), [L3943](../../../supabase/functions/solidgate-webhooks/index.ts#L3943)), funnel [verify-otp route](../../../apps/funnel/src/app/api/auth/verify-otp/route.ts#L11) (post-login kryptis). | FK `auth.users ON DELETE SET NULL`; `idx_sessions_user_id`. Webhook'as meta klaidą, jei sesija priklauso kitam vartotojui nei užsakymas („ownership binding mismatch“). |
| `last_oto_step` | `TEXT` · NULL · — | OTO grandinės kontrolinis taškas `'1'..'8'`. NULL ir `'1'` reiškia „ant OTO1“. Juda tik į priekį ir tik per RPC (praleidimas arba priimtas pirkimas su catch-up). Po prisijungimo per 24 val. nuo `updated_at` vartotojas grąžinamas į `/oto/<step>` ([`resolvePostLoginDestination`](../../../packages/shared/src/auth/post-login-route.ts#L8)). | Rašo: [`advance_solidgate_oto_progress`](../../../supabase/migrations/00001_baseline.sql#L6044) (kviečia [advance-oto](../../../apps/funnel/src/app/api/solidgate/advance-oto/route.ts#L56) ir [charge-oto `persistNextOto`](../../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L419)). Skaito: tas pats RPC, [`open_solidgate_oto_order_v2`](../../../supabase/migrations/00001_baseline.sql#L3997), trigger'is [`guard_solidgate_oto_payable_order`](../../../supabase/migrations/00001_baseline.sql#L1729), [grant route](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1362), [verify-otp route](../../../apps/funnel/src/app/api/auth/verify-otp/route.ts#L11). | Neatpažinta reikšmė → `23514` `invalid persisted OTO step`; atgal judėti negalima (idempotentiškas grąžinimas). TS niekada nerašo tiesiogiai. |
| `solidgate_oto_environment` | `TEXT` · NULL · — | Prisega visą sesijos OTO grandinę prie vienos mokėjimų aplinkos. Užpildoma pirmo OTO atidarymo/žingsnio metu; vėlesnis bandymas su kita aplinka atmetamas. | Rašo: [`advance_solidgate_oto_progress`](../../../supabase/migrations/00001_baseline.sql#L5970), [`open_solidgate_oto_order_v2`](../../../supabase/migrations/00001_baseline.sql#L4006), trigger'is [`guard_solidgate_oto_payable_order`](../../../supabase/migrations/00001_baseline.sql#L1739) (tik kai NULL). Skaito: tie patys. TS kode nei rašoma, nei skaitoma. | CHECK NULL arba `production`/`sandbox`; nesutapimas → `23514` `oto_progress_environment_mismatch`. |
| `consent_given_at` | `TIMESTAMPTZ` · NULL · — | Kada lankytojas davė sutikimą lead capture formoje. | Rašo: persist ([L79](../../../apps/funnel/src/app/api/session/persist/route.ts#L79)) iš [lead capture](../../../apps/funnel/src/features/quiz/hooks/use-quiz-persistence.ts#L100). Skaito: TS kode neskaitoma (tik audito reikmėms). | — |
| `consent_version` | `TEXT` · NULL · — | Sutikimo teksto versija, kad būtų galima įrodyti, su kuo sutiko. | Rašo: persist ([L82](../../../apps/funnel/src/app/api/session/persist/route.ts#L82)). Skaito: TS kode neskaitoma. | — |
| `marketing_consent` | `BOOLEAN` · NULL · `true` | Rinkodaros sutikimas. Route'as ignoruoja kliento reikšmę ir visada rašo `true` (verslo sprendimas 2026-07-17, [L85](../../../apps/funnel/src/app/api/session/persist/route.ts#L85)), todėl faktiškai stulpelis visada `true`. | Rašo: persist. Skaito: TS kode neskaitoma. | DDL leidžia NULL (be NOT NULL), bet default ir route užtikrina `true`. |
| `welcome_email_pending` | `BOOLEAN` · NOT NULL · `false` | Istorinė vėliava welcome laiško atidėjimui iki mokėjimo patvirtinimo. Šiame boilerplate welcome laiškas eina per `solidgate_fulfillment_outbox` (`send_welcome_email`), todėl stulpelio **niekas TS kode nei rašo, nei skaito** (patikrinta grep'u; lieka tik DB default). | Rašo: DB default. Skaito: —. | Kandidatas šalinimui kartu su sugeneruotais tipais. |
| `created_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Sesijos sukūrimo laikas. Hydration renkasi naujausią ankstesnę sesiją (`ORDER BY created_at DESC`); admin statistikos filtruoja pagal langą. | Rašo: DB default. Skaito: persist hydration ([L222](../../../apps/funnel/src/app/api/session/persist/route.ts#L227)), admin [sessions](../../../apps/funnel/src/app/admin/_queries/sessions.ts#L11), [funnel](../../../apps/funnel/src/app/admin/_queries/funnel.ts#L150), [locales](../../../apps/funnel/src/app/admin/_queries/locales.ts#L14). | — |
| `updated_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Paskutinio pakeitimo laikas. Persist route'as jį nustato kiekviename kvietime ([L57](../../../apps/funnel/src/app/api/session/persist/route.ts#L59)); OTO RPC – `NOW()`. Naudojamas kaip „aktyvios OTO grandinės“ langas (24 val.) ir naujausios sesijos parinkimui OTP prisiejime. | Rašo: persist; `advance_solidgate_oto_progress`, `open_solidgate_oto_order_v2`, OTO trigger'is. Skaito: [grant route](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1362) (`resumeTo`), [verify-otp](../../../packages/shared/src/auth/verify-otp.ts#L142) (`ORDER BY updated_at DESC`), funnel [verify-otp route](../../../apps/funnel/src/app/api/auth/verify-otp/route.ts#L11). | Trigger'io nėra – tiesioginis `UPDATE` iš kitų kelių (pvz. `user_id` prisiejimas) `updated_at` **nekeičia**. |

**Susiję RPC ir trigger'iai.** [`advance_solidgate_oto_progress`](../../../supabase/migrations/00001_baseline.sql#L5913),
[`open_solidgate_oto_order_v2`](../../../supabase/migrations/00001_baseline.sql#L3869) (skaito/prisega aplinką),
trigger'io funkcija [`guard_solidgate_oto_payable_order`](../../../supabase/migrations/00001_baseline.sql#L1580)
(BEFORE ant `orders`, užrakina ir tikrina sesiją), [`find_auth_user_id_by_email`](../../../supabase/migrations/00001_baseline.sql#L9187)
(naudoja persist dublikatų sargas, ne pačią lentelę). Trigger'ių ant `sessions` nėra.

## Lentelė `public.funnel_events`

**Paskirtis.** Funnel įvykių veidrodis pačioje DB, kad quiz→pirkimo konversija ir OTO funnel būtų skaičiuojami
iš savų duomenų, ne tik iš PostHog ([komentaras](../../../apps/funnel/src/features/analytics/hooks/use-analytics.ts#L112)).
Rašo naršyklė tiesiogiai per Supabase klientą (anon raktas + vartotojo JWT), todėl ši lentelė – vienintelė iš
aprašomų, kur RLS INSERT politikos yra aktyvus kelias.

**Gyvavimo ciklas.** Eilutę įterpia [`trackFunnelEvent`](../../../apps/funnel/src/features/quiz/lib/track-funnel-event.ts#L26)
(fire-and-forget; prieš tai laukia [`waitForSession`](../../../apps/funnel/src/features/quiz/lib/session-ready.ts#L22)
iki 8 s, kad INSERT neaplenktų sesijos sukūrimo – FK į `sessions`). Kvietėjai: [quiz-page](../../../apps/funnel/src/features/quiz/components/quiz-page.tsx#L169)
(`quiz_started`, `lead_captured`, `quiz_completed`), [use-quiz-navigation](../../../apps/funnel/src/features/quiz/hooks/use-quiz-navigation.ts#L161)
(`step_completed` su `step_number` ir `metadata.step_id`) ir [`useAnalytics`](../../../apps/funnel/src/features/analytics/hooks/use-analytics.ts#L121),
kuris PostHog įvykius `checkout_completed`, `oto<N>_viewed|purchased|declined` sumapuoja į `checkout_completed`,
`oto_viewed`, `oto_accepted`, `oto_declined` ([`dbFunnelEventType`](../../../apps/funnel/src/features/analytics/hooks/use-analytics.ts#L66))
ir originalų pavadinimą deda į `metadata.source_event`. Skaito tik admin dashboard'as per `service_role`
(`count: 'exact', head: true`): [`countStepCompletions`](../../../apps/funnel/src/app/admin/_queries/funnel.ts#L95),
[`countQuizCompleted`](../../../apps/funnel/src/app/admin/_queries/funnel.ts#L166),
[`countLeadsInRange`](../../../apps/funnel/src/app/admin/_queries/leads.ts#L11), OTO take-rate
([`ilike('event_type', '%<offer>%')`](../../../apps/funnel/src/app/admin/_queries/otos.ts#L89)). Eilutės nekeičiamos
ir netrinamos programos kodu; dingsta tik kaskadu ištrynus sesiją.

**Raktai, indeksai, RLS.** PK `id`. FK `session_id → sessions(id) ON DELETE CASCADE` (NOT NULL). Indeksai (pilni):
`idx_funnel_events_session_id (session_id)` ([L312](../../../supabase/migrations/00001_baseline.sql#L312)),
`idx_funnel_events_event_type (event_type)` ([L313](../../../supabase/migrations/00001_baseline.sql#L313)); pagal
`created_at`, kuriuo filtruoja visos admin užklausos, indekso nėra. RLS įjungtas; politikos:
`"Anyone can insert funnel events"` – `INSERT TO anon WITH CHECK (true)` ([L318](../../../supabase/migrations/00001_baseline.sql#L318));
`"Authenticated can insert funnel events"` – `INSERT TO authenticated WITH CHECK (true)`
([L324](../../../supabase/migrations/00001_baseline.sql#L324)) – be jos visi po-checkout OTO įvykiai būtų atmesti, nes
lankytojas tuo metu jau prisijungęs ([komentaras](../../../supabase/migrations/00001_baseline.sql#L321)). SELECT/UPDATE/DELETE
politikų nėra → klientams šie veiksmai uždrausti; skaito tik `service_role`. Aiškaus `GRANT`/`REVOKE` nėra.

**Apsaugos.** CHECK `event_type IN ('quiz_started','step_completed','lead_captured','quiz_completed','oto_viewed',
'oto_accepted','oto_declined','checkout_completed')` ([L303](../../../supabase/migrations/00001_baseline.sql#L303)) –
naršyklė gali įterpti bet kokį `session_id`, bet ne nežinomą tipą. Trigger'ių nėra. `WITH CHECK (true)` reiškia, kad
anonimas gali įrašyti įvykius svetimai sesijai, jei žino jos UUID – tai priimta analitikos lentelės rizika.

### Stulpeliai

| Stulpelis | Tipas · NULL · default | Reikšmė | Kas rašo / kas skaito | Apsaugos ir pastabos |
|---|---|---|---|---|
| `id` | `UUID` · NOT NULL · `gen_random_uuid()` | Vidinis PK. | Rašo: DB default. Skaito: —. | — |
| `session_id` | `UUID` · NOT NULL · — | Sesija, kuriai priklauso įvykis. Privaloma – `useAnalytics` išvis nerašo į DB, jei įvykyje nėra `session_id`. | Rašo: `trackFunnelEvent` iš kvietėjo. Skaito: admin užklausos šiuo stulpeliu nefiltruoja (agreguoja globaliai). | FK CASCADE; indeksas. |
| `event_type` | `TEXT` · NOT NULL · — | Įvykio tipas iš CHECK sąrašo: quiz eiga (`quiz_started`, `step_completed`, `lead_captured`, `quiz_completed`), pirkimas (`checkout_completed`), OTO (`oto_viewed`, `oto_accepted`, `oto_declined`). | Rašo: `trackFunnelEvent`. Skaito: admin [`eq('event_type', ...)`](../../../apps/funnel/src/app/admin/_queries/funnel.ts#L97), [leads](../../../apps/funnel/src/app/admin/_queries/leads.ts#L13), [otos `ilike`](../../../apps/funnel/src/app/admin/_queries/otos.ts#L91). | CHECK 8 reikšmės; indeksas. Admin `ilike('%<offer>%')` OTO užklausa į `oto_viewed` tipo eilutes nepataiko, nes tipe pasiūlymo slug'o nėra – jis `metadata.source_event` (nepatikrinta, ar tai numatyta). |
| `step_number` | `INTEGER` · NULL · — | 1-based quiz žingsnio pozicija `step_completed` įvykiams; kitiems NULL. | Rašo: [use-quiz-navigation](../../../apps/funnel/src/features/quiz/hooks/use-quiz-navigation.ts#L161). Skaito: admin [`countStepCompletions`](../../../apps/funnel/src/app/admin/_queries/funnel.ts#L98). | — |
| `metadata` | `JSONB` · NULL · `'{}'` | Papildomi laukai: `step_id`, `source_event` (originalus PostHog pavadinimas), produktas/suma OTO ir checkout įvykiams (be `capi_email` – PII nuimama prieš įrašant, [L98](../../../apps/funnel/src/features/analytics/hooks/use-analytics.ts#L98)). | Rašo: `trackFunnelEvent` (`metadata ?? {}`). Skaito: TS kode neskaitoma. | — |
| `created_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Įvykio laikas (įrašymo momentas, ne naršyklės laikas). | Rašo: DB default. Skaito: visos admin užklausos (`gte/lt`). | Indekso nėra. |

**Susiję RPC ir trigger'iai.** Nėra. Vienintelis rašytojas – naršyklės [`trackFunnelEvent`](../../../apps/funnel/src/features/quiz/lib/track-funnel-event.ts#L14).

## Lentelė `public.otp_attempts`

**Paskirtis.** Brute-force žurnalas 6 skaitmenų OTP kodui (≈1M raktų erdvė): kiekvienas `verify-otp` bandymas
įrašomas, o prieš tikrinant kodą skaičiuojamos nesėkmės per el. paštą. Bendra funnel ir PWA politika: soft-lock po
5 nesėkmių per 15 min., hard-lock po 10 per 60 min. ([`otp-rate-limit.ts`](../../../packages/shared/src/auth/otp-rate-limit.ts#L4),
[runbook](../../../docs/auth-otp-login-runbook.md#L31)).

**Gyvavimo ciklas.** Eilutę įterpia [`recordOtpAttempt`](../../../packages/shared/src/auth/otp-rate-limit.ts#L69)
(fire-and-forget, klaidos tik logu), kurį [`handleVerifyOtp`](../../../packages/shared/src/auth/verify-otp.ts#L106)
kviečia po nesėkmingo (`success=false`) ir sėkmingo (`success=true`) `supabase.auth.verifyOtp`. Prieš tikrinimą
[`checkOtpRateLimit`](../../../packages/shared/src/auth/otp-rate-limit.ts#L26) skaito `success=false` eilutes 60 min.
lange ir grąžina `soft_lock`/`hard_lock` (route atsako 429). DB klaida → fail-open (leidžiama). Abu callback'us
perduoda trys route'ai: funnel [verify-otp](../../../apps/funnel/src/app/api/auth/verify-otp/route.ts#L22), PWA
[verify-otp](../../../apps/pwa/src/app/api/auth/verify-otp/route.ts#L9), funnel admin
[verify-otp](../../../apps/funnel/src/app/api/admin/auth/verify-otp/route.ts#L8). Eilutės niekada netrinamos – retencijos
nėra ([gdpr-compliance.md](../../../docs/gdpr-compliance.md#L368) tai pažymi kaip trūkumą; siūloma 30 d.).

**Raktai, indeksai, RLS.** PK `id`. FK nėra (el. paštas tekstu, ne `auth.users`). Indeksas `idx_otp_attempts_email_time
(email, attempted_at DESC)` ([L338](../../../supabase/migrations/00001_baseline.sql#L338)) – tiksliai `checkOtpRateLimit`
užklausai. RLS įjungtas, politikų nėra; `REVOKE ALL` iš `PUBLIC, anon, authenticated`; `GRANT ALL` `service_role`
([L342](../../../supabase/migrations/00001_baseline.sql#L342)).

**Apsaugos.** CHECK apribojimų ir trigger'ių nėra. Slenksčiai gyvena tik TS konstantose.

### Stulpeliai

| Stulpelis | Tipas · NULL · default | Reikšmė | Kas rašo / kas skaito | Apsaugos ir pastabos |
|---|---|---|---|---|
| `id` | `UUID` · NOT NULL · `gen_random_uuid()` | Vidinis PK. | Rašo: DB default. Skaito: —. | — |
| `email` | `TEXT` · NOT NULL · — | Normalizuotas (trim + lowercase, [`normalizeEmail`](../../../packages/shared/src/auth/verify-otp.ts#L11)) el. paštas, kuriam bandytas kodas. Rate-limit raktas. | Rašo: `recordOtpAttempt`. Skaito: `checkOtpRateLimit` (`.eq('email', email)`). | Indekso dalis. |
| `ip_address` | `TEXT` · NULL · — | Kliento IP iš `x-forwarded-for` (pirmas) arba `x-real-ip` ([L88](../../../packages/shared/src/auth/verify-otp.ts#L87)); NULL, jei antraščių nėra. Tik auditui – limitas skaičiuojamas per el. paštą, ne IP. | Rašo: `recordOtpAttempt`. Skaito: TS kode neskaitoma. | Asmens duomenys be retencijos (žr. GDPR dokumentą). |
| `success` | `BOOLEAN` · NOT NULL · `false` | Ar kodas priimtas. Limitas skaičiuoja tik `false`; sėkmė lango nenunulina (senos nesėkmės lieka skaičiuotis iki lango pabaigos). | Rašo: `recordOtpAttempt`. Skaito: `checkOtpRateLimit` (`.eq('success', false)`). | — |
| `attempted_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Bandymo laikas; langų (15/60 min.) pagrindas. | Rašo: DB default. Skaito: `checkOtpRateLimit` (`gte`, rikiavimas, soft-lango filtras TS pusėje). | Indekso dalis. |

**Susiję RPC ir trigger'iai.** Nėra. Visa logika TS [`otp-rate-limit.ts`](../../../packages/shared/src/auth/otp-rate-limit.ts#L1).

## Lentelė `public.user_prefs`

**Paskirtis.** Nario UI nustatymai per auth vartotoją: rodymo lokalė, šalis ir programėlės atidarymų skaitiklis.
Sukuriama tingiai. PWA proxy kiekvienoje autentifikuotoje užklausoje hidratuoja `NEXT_LOCALE` cookie iš šios
lentelės, todėl DB laimi prieš pasenusį cookie ([DDL komentaras](../../../supabase/migrations/00001_baseline.sql#L346),
[proxy prioritetai](../../../apps/pwa/src/proxy.ts#L145)).

**Gyvavimo ciklas.** Keturi rašytojai: (1) [`handleVerifyOtp`](../../../packages/shared/src/auth/verify-otp.ts#L150)
– INSERT su naujausios prisietos sesijos `locale`, tik jei eilutės dar nėra; (2) fulfillment worker'io
`enrich_main_profile` efektas → [`enrichPurchasedAccount`](../../../apps/funnel/src/lib/payment/provision-account.ts#L190)
– `upsert(..., ignoreDuplicates: true)` su funnel sesijos `locale` (niekada neperrašo esamos eilutės); (3) PWA
[`PATCH /api/user-prefs`](../../../apps/pwa/src/app/api/user-prefs/route.ts#L92) – `upsert` su `onConflict:'user_id'`
(vienintelis kelias, kuris **perrašo** lokalę/šalį; naujam vartotojui, patch'inančiam tik šalį, lokalė imama iš esamos
eilutės arba `routing.defaultLocale`); (4) RPC [`bump_user_app_open`](../../../supabase/migrations/00001_baseline.sql#L9253)
iš [`POST /api/app-open`](../../../apps/pwa/src/app/api/app-open/route.ts#L36) – `INSERT ... ON CONFLICT DO UPDATE
app_open_count+1, last_active_at=now()` (naujam vartotojui lokalė `p_default_locale`). Skaitytojai: PWA
[`proxy.ts`](../../../apps/pwa/src/proxy.ts#L176) (SSR klientas su vartotojo JWT – naudoja RLS SELECT politiką),
[`GET /api/user-prefs`](../../../apps/pwa/src/app/api/user-prefs/route.ts#L23), PWA pirkimo route'as
([billing lokalė](../../../apps/pwa/src/app/api/solidgate/purchase/route.ts#L642)), `verify-otp` egzistavimo patikra
([L136](../../../packages/shared/src/auth/verify-otp.ts#L136)). Eilutė dingsta kaskadu ištrynus `auth.users`.

**Raktai, indeksai, RLS.** PK `user_id` (kartu FK `auth.users(id) ON DELETE CASCADE`). Papildomų indeksų nėra. RLS
įjungtas; politikos: `"Users read own prefs"` – `SELECT TO authenticated USING (user_id = auth.uid())`
([L362](../../../supabase/migrations/00001_baseline.sql#L362)); `"Users insert own prefs"` – `INSERT TO authenticated
WITH CHECK (user_id = auth.uid())` ([L367](../../../supabase/migrations/00001_baseline.sql#L367)); `"Users update own prefs"`
– `UPDATE TO authenticated USING/WITH CHECK (user_id = auth.uid())` ([L372](../../../supabase/migrations/00001_baseline.sql#L372)).
`anon` politikų ir DELETE politikos nėra. Aiškaus `GRANT`/`REVOKE` lentelei nėra. Iš politikų realiai naudojama tik
SELECT (proxy); visi rašymai eina per admin klientą arba RPC.

**Apsaugos.** CHECK apribojimų nėra – `locale` (BCP-47 iš `routing.locales`) ir `country` (ISO 3166-1 alpha-2)
validuoja tik route'ai (`invalid_locale`, `invalid_country` 400). Trigger'ių nėra; `updated_at` rašo route'ai,
`bump_user_app_open` jo **neatnaujina**. RPC `bump_user_app_open` yra `LANGUAGE sql`, SECURITY INVOKER (numatytasis),
be `SET search_path` ir be aiškaus `REVOKE`/`GRANT` baseline faile (skirtingai nei visos kitos funkcijos) – kokios
numatytosios EXECUTE teisės galioja diegime, nepatikrinta; kviečiama per admin klientą, tad RLS jo neriboja.

### Stulpeliai

| Stulpelis | Tipas · NULL · default | Reikšmė | Kas rašo / kas skaito | Apsaugos ir pastabos |
|---|---|---|---|---|
| `user_id` | `UUID` · NOT NULL · — | Auth vartotojas; vienas įrašas per vartotoją. | Rašo: visi keturi rašytojai. Skaito: visi skaitytojai per `.eq('user_id', ...)`; RLS `auth.uid()` palyginimas. | PK + FK CASCADE. |
| `locale` | `TEXT` · NOT NULL · — | Nario pasirinkta rodymo kalba. Šaltinių eiliškumas: funnel sesijos lokalė (verify-otp / enrichment sėja), po to aiškus pasirinkimas PWA jungiklyje (PATCH perrašo). Proxy ją kopijuoja į `NEXT_LOCALE`, jei skiriasi. | Rašo: verify-otp INSERT, enrichment upsert (ignoreDuplicates), PATCH upsert, `bump_user_app_open` (tik naujai eilutei). Skaito: proxy ([L176](../../../apps/pwa/src/proxy.ts#L176)), GET user-prefs, PWA purchase route (billing kaina pagal lokalę). | NOT NULL be CHECK; proxy ignoruoja reikšmę ne iš `routing.locales`. |
| `country` | `TEXT` · NULL · — | ISO 3166-1 alpha-2 šalis, pasirinkta PWA jungiklyje; NULL = nenustatyta. | Rašo: PATCH user-prefs (`COUNTRY_RE = /^[A-Z]{2}$/`, gali nustatyti `null`). Skaito: GET user-prefs. | Validacija tik route lygiu. |
| `app_open_count` | `INTEGER` · NOT NULL · `0` | Realių programėlės atidarymų skaitiklis (klientas siunčia beacon'ą kartą per idle langą, ne per navigaciją). Naudojamas in-app upsell tempui ([`TrialPromoGate`](<../../../apps/pwa/src/app/[locale]/(app)/dashboard/_components/shell/TrialPromoGate.tsx#L9>)). | Rašo: `bump_user_app_open` (`+1`; nauja eilutė = 1). Skaito: app-open route grąžina klientui ([L47](../../../apps/pwa/src/app/api/app-open/route.ts#L47)). | — |
| `last_active_at` | `TIMESTAMPTZ` · NULL · — | Paskutinio programėlės atidarymo laikas. | Rašo: `bump_user_app_open` (`now()`). Skaito: app-open route grąžina klientui. | — |
| `updated_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Paskutinio nustatymų pakeitimo laikas (rašomas tik TS rašytojų). | Rašo: verify-otp, enrichment, PATCH (`new Date().toISOString()`). Skaito: —. | `bump_user_app_open` nekeičia; trigger'io nėra. |

**Susiję RPC ir trigger'iai.** [`bump_user_app_open`](../../../supabase/migrations/00001_baseline.sql#L9253). Trigger'ių nėra.

## Lentelė `public.deletion_requests`

**Paskirtis.** GDPR 17 str. („teisė būti pamirštam“) audito pėdsakas: kas paprašė ištrinti, kada, kas ištrinta ir
ar pavyko. Lentelė pateikta kaip karkasas – **šiame boilerplate nėra delete-account route'o, todėl į ją niekas
nerašo ir iš jos niekas neskaito** ([DDL komentaras](../../../supabase/migrations/00001_baseline.sql#L427): „nothing writes
here until you add one. Drop the table if you never will“). Patikrinta grep'u: `deletion_requests` TS kode nepasirodo
(nėra net sugeneruotuose `Database` tipuose už DDL ribų).

**Gyvavimo ciklas.** Numatytas, bet neįgyvendintas: būsimas `DELETE /api/user/delete` route'as
([gdpr-compliance.md planas](../../../docs/gdpr-compliance.md#L311)) įrašytų `pending` eilutę, atliktų trynimus
(`user_prefs`, `entitlements` atšaukimas, `sessions`/`orders` anonimizavimas, vault token'ai, `otp_attempts`, auth
vartotojas) ir užbaigtų `completed` su `tables_affected` arba `failed` su `error_details`. Šiuo metu eilučių nėra.

**Raktai, indeksai, RLS.** PK `id`. FK nėra – `user_id` sąmoningai be nuorodos į `auth.users`, kad eilutė išliktų
po vartotojo ištrynimo. Indeksų nėra. RLS įjungtas, politikų nėra; `REVOKE ALL` iš `PUBLIC, anon, authenticated`;
`GRANT ALL` `service_role` ([L445](../../../supabase/migrations/00001_baseline.sql#L445)).

**Apsaugos.** CHECK `status IN ('pending','completed','failed')` ([L435](../../../supabase/migrations/00001_baseline.sql#L435)).
Trigger'ių nėra.

### Stulpeliai

| Stulpelis | Tipas · NULL · default | Reikšmė | Kas rašo / kas skaito | Apsaugos ir pastabos |
|---|---|---|---|---|
| `id` | `UUID` · NOT NULL · `gen_random_uuid()` | Vidinis PK. | Rašo: DB default. Skaito: —. | — |
| `user_id` | `UUID` · NOT NULL · — | Trinamo auth vartotojo ID. Be FK, kad įrašas išliktų ištrynus vartotoją. | Rašo: niekas (numatyta – būsimas delete route'as). Skaito: niekas. | — |
| `email` | `TEXT` · NOT NULL · — | Vartotojo el. paštas prašymo metu – kad auditas būtų suprantamas, kai `auth.users` eilutės nebėra. | Rašo/skaito: niekas. | Po trynimo tai lieka asmens duomuo audito lentelėje (nepatikrinta, ar planuojama anonimizuoti). |
| `status` | `TEXT` · NOT NULL · `'pending'` | Prašymo būsena: `pending` (gautas), `completed` (visi trynimai atlikti), `failed` (bent vienas žingsnis lūžo, žr. `error_details`). | Rašo/skaito: niekas. | CHECK 3 reikšmės. |
| `requested_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Prašymo laikas (30 d. GDPR terminas skaičiuojamas nuo jo). | Rašo: DB default. Skaito: niekas. | — |
| `completed_at` | `TIMESTAMPTZ` · NULL · — | Kada prašymas užbaigtas (`completed` arba `failed`). | Rašo/skaito: niekas. | — |
| `tables_affected` | `JSONB` · NULL · `'{}'` | Kurios lentelės paliestos ir kiek eilučių (numatyta struktūra – `{table: count}`, formatas neapibrėžtas kode). | Rašo/skaito: niekas. | — |
| `error_details` | `TEXT` · NULL · — | Klaidos aprašymas `failed` būsenai. | Rašo/skaito: niekas. | — |
| `created_at` | `TIMESTAMPTZ` · NOT NULL · `now()` | Eilutės sukūrimo laikas (dubliuoja `requested_at`, nes abu `now()`). | Rašo: DB default. Skaito: niekas. | — |

**Susiję RPC ir trigger'iai.** Nėra. [`revoke_user_auth_sessions`](../../../supabase/migrations/00001_baseline.sql#L9224)
(auth sesijų atšaukimas per `service_role`) yra susijusi paskirtimi, bet šios lentelės neliečia.

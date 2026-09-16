# DB funkcijos: RPC, trigger'iai ir view

> Šis detalus aprašymas fiksuoja būseną iki 2026-09-14 audito pataisų. Naujas pinigų žurnalas, auth / kortelės patvirtinimo apsaugos ir pakeisti srautai aprašyti [pataisų dokumente](../FIXES_2026-09-14.lt.md).

Šis dokumentas aprašo kiekvieną funkciją, trigger'į ir view, kuriuos apibrėžia
[`supabase/migrations/00001_baseline.sql`](../../../supabase/migrations/00001_baseline.sql).
Aprašyta: **76 funkcijos** (`grep -ni "^create or replace function"` – 75 didžiosiomis
raidėmis ir viena, [`find_auth_user_id_by_email`](../../../supabase/migrations/00001_baseline.sql#L9187),
mažosiomis), **15 trigger'ių** (8 skyrius, nuo [L9272](../../../supabase/migrations/00001_baseline.sql#L9272))
ir **1 view** (5 skyrius, [L1301](../../../supabase/migrations/00001_baseline.sql#L1301)).
Kiekvienam nurodyta: parašas, eilutė baseline faile, ką daro ir kokius invariantus saugo,
kas kviečia (TS/Deno kodas arba tik kitos SQL funkcijos), kokias klaidas kelia
(`RAISE EXCEPTION` su `SQLSTATE`) ir į kurias lenteles rašo.

## Kaip funkcijos pasiekiamos

**Kvietimo kelias.** Aplikacija funkcijas kviečia tik per PostgREST `.rpc()` su
`service_role` raktu. Next.js maršrutai naudoja
[`getSupabaseAdminClient()`](../../../packages/shared/src/supabase/admin.ts#L16)
(`SUPABASE_SERVICE_ROLE_KEY`), Deno webhook'as –
[`admin()`](../../../supabase/functions/solidgate-webhooks/index.ts#L258). Parametrai
perduodami vardais (`p_*`), todėl parametro pervadinimas yra API lūžis
(baseline komentaras [L2367](../../../supabase/migrations/00001_baseline.sql#L2367)).
Naršyklė (`anon`/`authenticated`) nė vienos funkcijos tiesiogiai kviesti negali.

**`SECURITY` ir `search_path`.** Deklaracijos patikrintos kiekvienai funkcijai atskirai
(žr. lauką „Deklaracija“ prie kiekvienos). Bendras vaizdas:

- Visos 7 skyriaus RPC ir 6 skyriaus trigger funkcijos turi `SET search_path = ''`, išskyrus
  dvi: [`bump_orders_updated_at`](../../../supabase/migrations/00001_baseline.sql#L1327) ir
  [`bump_user_app_open`](../../../supabase/migrations/00001_baseline.sql#L9253), kurios neturi
  nei `SECURITY`, nei `search_path` sakinio.
- `SECURITY DEFINER` naudojamas ten, kur funkcija turi pasiekti lentelę, kurios
  `service_role` skaityti/rašyti negali: `solidgate_card_update_attempts`
  ([REVOKE ... service_role, L1242](../../../supabase/migrations/00001_baseline.sql#L1242)),
  `solidgate_subscription_token_sync_jobs`
  ([L1287](../../../supabase/migrations/00001_baseline.sql#L1287)), `auth.*` schema, taip pat
  „identity-aware“ `_v2` atidarymo funkcijoms, kortelių saugyklų rašytojams,
  intro ribojimui, atribucijai ir dviem trigger funkcijoms
  (`prevent_solidgate_entitlement_replay`, `enqueue_solidgate_subscription_token_sync_from_entitlement`).
- Likusios yra `SECURITY INVOKER` (deklaruota arba pagal numatytąjį elgesį, kai sakinio nėra:
  2 skyriaus trys pirmieji resolveriai, `solidgate_checkout_core_is_canonical`,
  `bump_orders_updated_at`, `bump_user_app_open`).

**Privilegijų modelis (9 skyrius, [L9489](../../../supabase/migrations/00001_baseline.sql#L9489)).**
Principas „default-deny“: kiekvienai funkcijai `REVOKE ALL ... FROM PUBLIC, anon, authenticated`,
o `GRANT EXECUTE ... TO service_role` gauna tik tos, kurias aplikacija kviečia. Trys grupės:

| Grupė | Funkcijos |
|---|---|
| `service_role` gali kviesti | 5 katalogo resolveriai, `prevent_solidgate_entitlement_replay` (vienintelė trigger funkcija su GRANT, [L9531](../../../supabase/migrations/00001_baseline.sql#L9531)), `claim_solidgate_webhook_event` (v1), visos `_v2` webhook/entity/outbox funkcijos, `get_*_identity`, `open_*_v2`, `finalize_*_v2`, OTO/PWA rezultatų funkcijos, `advance_solidgate_oto_progress`, `solidgate_special_free_card_ready`, `grant_*`, `apply_*_lifecycle`, visi `write_/promote_` vault rašytojai, visos `*_card_update_attempt*`, `claim/read_claimed/complete/fail_solidgate_subscription_token_sync`, intro `claim/consume`, `claim_meta_capi_event`, `persist_user_acquisition_attribution`, `find_auth_user_id_by_email`, `revoke_user_auth_sessions` |
| Atimta ir iš `service_role` (tik SQL viduje arba operatoriui `postgres`) | `solidgate_checkout_core_is_canonical` ([L9561](../../../supabase/migrations/00001_baseline.sql#L9561)), `open_solidgate_main_checkout` v1 ([L9569](../../../supabase/migrations/00001_baseline.sql#L9569)), `finalize_solidgate_main_checkout` v1 ([L9574](../../../supabase/migrations/00001_baseline.sql#L9574)), `open_solidgate_pwa_purchase` v1 ([L9585](../../../supabase/migrations/00001_baseline.sql#L9585)), `finalize_solidgate_pwa_form` v1 ([L9590](../../../supabase/migrations/00001_baseline.sql#L9590)), `reconcile_solidgate_legacy_order_identity` ([L9607](../../../supabase/migrations/00001_baseline.sql#L9607)), `clear_solidgate_legacy_session_vault` ([L9642](../../../supabase/migrations/00001_baseline.sql#L9642)), `solidgate_subscription_token_sync_is_billable`, `enqueue_solidgate_subscription_token_sync`, `fence_solidgate_subscription_token_sync_for_tokenless_source` ([L9665–L9669](../../../supabase/migrations/00001_baseline.sql#L9665)) |
| Tik `REVOKE`, be `GRANT` (trigger funkcijos, kviečiamos tik per trigger'į) | `bump_orders_updated_at`, `guard_solidgate_*` (8 vnt.), `enqueue_solidgate_subscription_token_sync_from_entitlement` ([L9511–L9533](../../../supabase/migrations/00001_baseline.sql#L9511)) |

Išimtis: [`bump_user_app_open`](../../../supabase/migrations/00001_baseline.sql#L9253) 9 skyriuje
neminima, todėl jai lieka PostgreSQL numatytoji `EXECUTE` teisė `PUBLIC` (lentelė
`user_prefs` vis tiek saugoma RLS ir savo GRANT, tai šiame dokumente netikrinta).

Privilegijų būseną testai patikrina `has_function_privilege` tvirtinimais:
[`solidgate_payment_identity.sql#L80`](../../../supabase/tests/solidgate_payment_identity.sql#L80)
(v1 atidarytojai ir `reconcile`/`clear` neprieinami `service_role`),
[`solidgate_card_update_state.sql#L62`](../../../supabase/tests/solidgate_card_update_state.sql#L62)
(kortelės atnaujinimo ir token sync lentelės pasiekiamos tik per DEFINER RPC),
[`solidgate_oto_progress.sql#L5`](../../../supabase/tests/solidgate_oto_progress.sql#L5),
[`solidgate_round2_concurrency.sql#L22`](../../../supabase/tests/solidgate_round2_concurrency.sql#L22).

**Bendra klaidų konvencija.** `22023` (`invalid_parameter_value`) – neteisingi įvesties
parametrai; `23514` (`check_violation`) – pažeistas nekintamumo arba surišimo invariantas;
`23505` (`unique_violation`) – bandymas sukurti antrą mokėtiną užsakymą tam pačiam raktui;
`40001` (`serialization_failure`) – builder/claim prarado nuosavybę; `22003` – išsemtas bandymų
skaitiklis; `P0001`/`P0002` – `RAISE` be `ERRCODE` arba `INTO STRICT` be eilutės. Vieta, kur
TS kodas šiuos kodus interpretuoja, čia neaprašoma.

## Produktų katalogo resolveriai (2 skyrius)

Baseline antraštė ([L48](../../../supabase/migrations/00001_baseline.sql#L48)) deklaruoja, kad
šie penki `IMMUTABLE` resolveriai yra vienintelė vieta, kur schema žino apie pasiūlymus, ir kad
jie turi sutapti su `packages/shared/src/price-map.ts`, `oto-product-label.ts` ir
`supabase/functions/solidgate-webhooks/_codes.ts`. **Patikslinimas pagal `grep`:** produktų
literalai (`BRAND_000000_SUB`, `BRANDADDON_000000_SUB`, `'BRAND'`, `'PWA'`,
`oto2_addon_weekly`, `trial1..special_free`) yra įrašyti ir į kitas funkcijas – daugiausia
[`solidgate_checkout_core_is_canonical`](../../../supabase/migrations/00001_baseline.sql#L2862)
(pilna `internal slug → offering code` lentelė) ir
[`prevent_solidgate_entitlement_replay`](../../../supabase/migrations/00001_baseline.sql#L2150),
taip pat į `guard_solidgate_*`, `open_solidgate_main_checkout`, `finalize_solidgate_main_checkout`,
`open_solidgate_pwa_purchase`, `grant_solidgate_*`, `write_*_vault_monotonic`,
`reconcile_solidgate_legacy_order_identity`, `claim/consume_solidgate_intro_offer`,
`solidgate_special_free_card_ready`, `apply_solidgate_subscription_entitlement_lifecycle`
ir `record_solidgate_pwa_*`. Keičiant katalogą 2 skyrius yra pradžia, bet ne pabaiga.

Išraiškos indeksas
[`idx_orders_solidgate_one_live_oto_step`](../../../supabase/migrations/00001_baseline.sql#L569)
(„vienas gyvas užsakymas per (environment, session, OTO žingsnis)“) yra sudarytas virš
`solidgate_oto_step_from_product_slug(product_slug)`. Pakeitus šią funkciją indeksą reikia
`REINDEX`, kitaip garantija tyliai nustoja galioti naujiems kodams (komentaras
[L563](../../../supabase/migrations/00001_baseline.sql#L563)).

### `solidgate_oto_step_from_product_slug(p_product_slug TEXT) RETURNS INTEGER`

[Baseline L73](../../../supabase/migrations/00001_baseline.sql#L73). Deklaracija: `LANGUAGE sql`,
`IMMUTABLE STRICT`, `SET search_path = ''`, be `SECURITY` sakinio (INVOKER). Teisės:
`service_role`.

Solidgate pasiūlymo kodą (`BRANDLIFETIME_000000_SUB` → 1, `BRANDADDON_000000_SUB` → 2, keturi
`BRANDBUNDLE*_000000_PDF` → 3, `BRANDPDF4..7_000000_PDF` → 4–7) paverčia OTO žingsniu; kitaip
grąžina `NULL`. Tai raktas visai „vienas užsakymas per žingsnį“ logikai: indeksas
`idx_orders_solidgate_one_live_oto_step`, trigger'is `guard_solidgate_oto_payable_order`
([L1596](../../../supabase/migrations/00001_baseline.sql#L1596),
[L1660](../../../supabase/migrations/00001_baseline.sql#L1660),
[L1762](../../../supabase/migrations/00001_baseline.sql#L1762)),
`open_solidgate_oto_order_v2`, `resume_solidgate_oto_order_after_absent_reconcile`,
`advance_solidgate_oto_progress` ([L6030](../../../supabase/migrations/00001_baseline.sql#L6030)),
`grant_solidgate_oto_entitlement` ([L6562](../../../supabase/migrations/00001_baseline.sql#L6562)).
Klaidų nekelia. Lentelių nerašo. Iš TS kodo nekviečiama (tik SQL viduje); testas
[`solidgate_round2_concurrency.sql#L835`](../../../supabase/tests/solidgate_round2_concurrency.sql#L835)
naudoja ją tvirtinimams.

### `solidgate_oto_step_from_internal_slug(p_internal_slug TEXT) RETURNS INTEGER`

[Baseline L98](../../../supabase/migrations/00001_baseline.sql#L98). Deklaracija: `sql`,
`IMMUTABLE STRICT`, `search_path = ''`, INVOKER pagal numatymą. Teisės: `service_role`.

Vidinį produkto id (raktas `PRICE_MAP`: `oto1_lifetime`, `oto2_addon_weekly`,
`oto3_bundle_all|_1|_2|_3`, `oto4_pdf..oto7_pdf`) paverčia žingsniu. Naudojama ten, kur
`solidgate_order_id` antras segmentas (`<session>:<internal_slug>:<attempt>`) turi sutapti su
`product_slug` žingsniu: `guard_solidgate_oto_payable_order`
([L1661](../../../supabase/migrations/00001_baseline.sql#L1661)), `open_solidgate_oto_order_v2`
([L3930](../../../supabase/migrations/00001_baseline.sql#L3930),
[L4029](../../../supabase/migrations/00001_baseline.sql#L4029)), `grant_solidgate_oto_entitlement`
([L6590](../../../supabase/migrations/00001_baseline.sql#L6590)). Klaidų nekelia, nerašo. Tik SQL
viduje.

### `solidgate_persisted_oto_step(p_last_oto_step TEXT) RETURNS INTEGER`

[Baseline L125](../../../supabase/migrations/00001_baseline.sql#L125). Deklaracija: `sql`,
`IMMUTABLE` (ne `STRICT`, nes `NULL` yra reikšmingas), `search_path = ''`, INVOKER pagal
numatymą. Teisės: `service_role`.

`sessions.last_oto_step` yra `TEXT`; funkcija `NULL` verčia į 1 („grandinė nepradėta“),
`'1'..'8'` į sveiką skaičių, bet ką kita į `NULL`. Kviečia `guard_solidgate_oto_payable_order`
([L1726](../../../supabase/migrations/00001_baseline.sql#L1726)) ir `open_solidgate_oto_order_v2`
([L3994](../../../supabase/migrations/00001_baseline.sql#L3994)); abu `NULL` rezultatą paverčia
klaida `23514 'invalid persisted OTO step'`. Klaidų nekelia, nerašo. Tik SQL viduje.

### `solidgate_pwa_product_code(p_offer_slug TEXT) RETURNS TEXT`

[Baseline L143](../../../supabase/migrations/00001_baseline.sql#L143). Deklaracija: `sql`,
`IMMUTABLE STRICT PARALLEL SAFE SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

Member-area pasiūlymo id verčia į pasiūlymo kodą (`oto2_addon_weekly` → `BRANDADDON_000000_SUB`,
`oto3_bundle_*` → `BRANDBUNDLE*_000000_PDF`, `oto4..7_pdf` → `BRANDPDF4..7_000000_PDF`).
`oto1_lifetime` čia nėra – iš aplikacijos jo nusipirkti negalima. Visos PWA funkcijos ją
naudoja kaip `p_product_slug` autoritetą: `guard_solidgate_pwa_payable_order`
([L1843](../../../supabase/migrations/00001_baseline.sql#L1843)), `open_solidgate_pwa_purchase`
([L4367](../../../supabase/migrations/00001_baseline.sql#L4367)), `finalize_solidgate_pwa_form`
([L5151](../../../supabase/migrations/00001_baseline.sql#L5151)),
`record_solidgate_pwa_submission_result` ([L5369](../../../supabase/migrations/00001_baseline.sql#L5369)),
`resume_solidgate_pwa_submission_after_absent_reconcile`
([L5607](../../../supabase/migrations/00001_baseline.sql#L5607)),
`record_solidgate_pwa_confirmed_capture` ([L5741](../../../supabase/migrations/00001_baseline.sql#L5741)).
Klaidų nekelia, nerašo. Tik SQL viduje.

### `solidgate_main_checkout_amount(p_offer_slug TEXT, p_currency TEXT) RETURNS INTEGER`

[Baseline L186](../../../supabase/migrations/00001_baseline.sql#L186). Deklaracija: `sql`,
`IMMUTABLE PARALLEL SAFE SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

Serverinis pagrindinio checkout kainos autoritetas (CLAUDE.md taisyklė 4): bruto suma
minor units pagal intro tier (`trial1..trial4`, `special_1eur`, `special_free`) ir valiutą
(10 valiutų; `special_free` visur 0). Naršyklės atsiųsta suma tikrinama prieš ją trijose
vietose: `guard_solidgate_main_payable_order` INSERT metu
([L1530](../../../supabase/migrations/00001_baseline.sql#L1530)) – neatitikimas baigiasi
`23514 'invalid Solidgate main original amount'`; `open_solidgate_main_checkout`
([L3140](../../../supabase/migrations/00001_baseline.sql#L3140)) ir
`finalize_solidgate_main_checkout` ([L3727](../../../supabase/migrations/00001_baseline.sql#L3727)) –
`22023`. Lentelė turi būti identiška `PRICE_MAP`; tai pina
[`sql-price-grid-parity.test.ts`](../../../packages/shared/src/__tests__/sql-price-grid-parity.test.ts#L88),
kuris parsina šios funkcijos kūną iš baseline (testas atsirado po realaus DKK/JPY dreifo).
Klaidų nekelia, nerašo. Tik SQL viduje.

## Trigger funkcijos (6 skyrius) ir trigger'iai (8 skyrius)

Baseline komentaras ([L1322](../../../supabase/migrations/00001_baseline.sql#L1322)): čia gyvena
kiekvienas pinigų invariantas, kurio negalima išreikšti `CHECK`. Nė viena šių funkcijų
nepasiekiama per `.rpc()`; „nenaudojamų funkcijų“ paieška jas rodys kaip mirusias, bet ištrynus
bet kurią dingsta apsauga, o aplikacijos testai lieka žali
([L9274](../../../supabase/migrations/00001_baseline.sql#L9274)). Visi trigger'iai yra
`FOR EACH ROW`. Kelios funkcijos skaito tranzakcijos lygio GUC („fence“) reikšmes, kurias nustato
tik RPC per `set_config(..., TRUE)`: `app.solidgate_customer_email` ir dar trys identiteto
raktai, `app.solidgate_identity_reconcile_order`, `app.solidgate_session_vault_source_write`,
`app.solidgate_vault_source_write`. Tiesioginis `service_role` `UPDATE` tų reikšmių neturi, todėl
atsimuša į trigger'į.

### Lentelė: trigger'is → funkcija

| Trigger'is | Lentelė, įvykis | Funkcija |
|---|---|---|
| [`orders_updated_at_trigger`](../../../supabase/migrations/00001_baseline.sql#L9283) | `orders`, `BEFORE UPDATE` | `bump_orders_updated_at` |
| [`guard_solidgate_checkout_identity_trigger`](../../../supabase/migrations/00001_baseline.sql#L9289) | `orders`, `BEFORE INSERT OR UPDATE OF psp, solidgate_customer_email, solidgate_checkout_locale, solidgate_product_id, solidgate_payment_action, solidgate_checkout_identity_bound_at, solidgate_checkout_identity_legacy` | `guard_solidgate_checkout_identity` |
| [`guard_solidgate_main_payable_order_trigger`](../../../supabase/migrations/00001_baseline.sql#L9303) | `orders`, `BEFORE INSERT OR UPDATE OF` 17 stulpelių (status, sumos, valiuta, `created_at`, aplinka, sesija, psp, produktas, `solidgate_order_id`, payment/refund/chargeback laukai, `tracking_metadata`) | `guard_solidgate_main_payable_order` |
| [`guard_solidgate_oto_payable_order_trigger`](../../../supabase/migrations/00001_baseline.sql#L9327) | `orders`, `BEFORE INSERT OR UPDATE OF` 18 stulpelių (kaip aukščiau plius identiteto stulpeliai, be refund/chargeback ir `created_at`) | `guard_solidgate_oto_payable_order` |
| [`guard_solidgate_pwa_payable_order_trigger`](../../../supabase/migrations/00001_baseline.sql#L9352) | `orders`, `BEFORE INSERT OR UPDATE OF` 13 stulpelių (įskaitant `user_id`) | `guard_solidgate_pwa_payable_order` |
| [`prevent_solidgate_entitlement_replay`](../../../supabase/migrations/00001_baseline.sql#L9372) | `entitlements`, `BEFORE INSERT OR UPDATE OF status, revoked_at, order_id, payment_environment, user_id, product_slug, solidgate_subscription_id` | `prevent_solidgate_entitlement_replay` |
| [`solidgate_subscription_token_sync_entitlement_trigger`](../../../supabase/migrations/00001_baseline.sql#L9387) | `entitlements`, `AFTER INSERT OR UPDATE OF payment_environment, user_id, order_id, solidgate_subscription_id, status, revoked_at` | `enqueue_solidgate_subscription_token_sync_from_entitlement` |
| [`guard_solidgate_session_vault_card_source_insert_trigger`](../../../supabase/migrations/00001_baseline.sql#L9404) | `solidgate_session_vault`, `BEFORE INSERT` | `guard_solidgate_session_vault_card_source` |
| [`guard_solidgate_session_vault_card_source_update_trigger`](../../../supabase/migrations/00001_baseline.sql#L9411) | `solidgate_session_vault`, `BEFORE UPDATE OF customer_account_id, card_token, card_brand, card_last4, card_source_order_id, card_source_created_at, card_source_sequence, card_source_legacy` | `guard_solidgate_session_vault_card_source` |
| [`guard_solidgate_session_vault_payment_method_insert_trigger`](../../../supabase/migrations/00001_baseline.sql#L9427) | `solidgate_session_vault`, `BEFORE INSERT` | `guard_solidgate_session_vault_payment_method` |
| [`guard_solidgate_session_vault_payment_method_update_trigger`](../../../supabase/migrations/00001_baseline.sql#L9434) | `solidgate_session_vault`, `BEFORE UPDATE OF card_original_payment_method, card_source_order_id, card_source_created_at, card_source_sequence, card_source_legacy` | `guard_solidgate_session_vault_payment_method` |
| [`guard_solidgate_account_vault_card_source_insert_trigger`](../../../supabase/migrations/00001_baseline.sql#L9447) | `solidgate_account_vault`, `BEFORE INSERT` | `guard_solidgate_account_vault_card_source` |
| [`guard_solidgate_account_vault_card_source_update_trigger`](../../../supabase/migrations/00001_baseline.sql#L9454) | `solidgate_account_vault`, `BEFORE UPDATE OF card_token, card_brand, card_last4, card_source_kind, card_source_created_at, card_source_sequence, card_source_id` | `guard_solidgate_account_vault_card_source` |
| [`guard_solidgate_account_vault_payment_method_insert_trigger`](../../../supabase/migrations/00001_baseline.sql#L9469) | `solidgate_account_vault`, `BEFORE INSERT` | `guard_solidgate_account_vault_payment_method` |
| [`guard_solidgate_account_vault_payment_method_update_trigger`](../../../supabase/migrations/00001_baseline.sql#L9476) | `solidgate_account_vault`, `BEFORE UPDATE OF card_original_payment_method, card_source_kind, card_source_created_at, card_source_sequence, card_source_id` | `guard_solidgate_account_vault_payment_method` |

Vault trigger'iai suskaidyti į insert/update variantus todėl, kad `UPDATE` variantas turi
išvardyti tik tuos stulpelius, kurie gali perkelti kortelės šaltinį; bendras `BEFORE UPDATE`
atmestų nesusijusius įrašus ([L9400](../../../supabase/migrations/00001_baseline.sql#L9400)).

### `bump_orders_updated_at() RETURNS TRIGGER`

[Baseline L1327](../../../supabase/migrations/00001_baseline.sql#L1327). Deklaracija: `plpgsql`,
be `SECURITY` ir be `search_path`. Teisės: tik `REVOKE` ([L9511](../../../supabase/migrations/00001_baseline.sql#L9511)).

Kiekvienam `orders` `UPDATE` nustato `NEW.updated_at := NOW()`. Vienintelė trigger funkcija
be jokių patikrų. Klaidų nekelia; rašo tik į `NEW` eilutę.

### `guard_solidgate_checkout_identity() RETURNS TRIGGER`

[Baseline L1335](../../../supabase/migrations/00001_baseline.sql#L1335). Deklaracija: `plpgsql`,
`SECURITY INVOKER`, `search_path = ''`. Teisės: tik `REVOKE`.

Saugo nekintamą Solidgate checkout identiteto „nuotrauką“ kiekviename `psp = 'solidgate'`
`orders` įraše: `solidgate_customer_email`, `solidgate_checkout_locale`,
`solidgate_product_id`, `solidgate_payment_action`, `solidgate_checkout_identity_bound_at`,
`solidgate_checkout_identity_legacy`. INSERT metu reikšmes ima iš `NEW` arba iš tranzakcijos
GUC (`app.solidgate_customer_email` ir kt., kuriuos nustato `open_*_v2`), normalizuoja
(`LOWER(BTRIM)`), tikrina el. pašto formą (≤320 simb.), locale iš 15 leidžiamų, veiksmą
`auth_settle|auth_0_amount`, o prenumeratos užsakymui (`BRAND_000000_SUB` arba `price_id`
metaduomenyse) reikalauja `solidgate_product_id`. UPDATE metu leidžia keisti identitetą tik
legacy eilutei (`solidgate_checkout_identity_legacy = TRUE`, visi laukai `NULL`) ir tik kai
GUC `app.solidgate_identity_reconcile_order` lygus `OLD.id` – t. y. tik iš
`reconcile_solidgate_legacy_order_identity`.

Klaidos: `23514 'Solidgate order PSP identity is immutable'`;
`23514 'Solidgate checkout identity is immutable'`;
`22023 'invalid Solidgate checkout identity reconciliation'`;
`22023 'Solidgate order requires a valid immutable checkout identity'`;
`22023 'invalid Solidgate payment action snapshot'`;
`22023 'invalid Solidgate provider product identity'`;
`22023 'Solidgate subscription order requires an immutable provider product id'`.
Rašo tik į `NEW`. Testas: tiesioginis `UPDATE orders SET solidgate_customer_email` turi baigtis
`check_violation` – [`solidgate_payment_identity.sql#L178`](../../../supabase/tests/solidgate_payment_identity.sql#L178).

### `guard_solidgate_main_payable_order() RETURNS TRIGGER`

[Baseline L1476](../../../supabase/migrations/00001_baseline.sql#L1476). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: tik `REVOKE`.

Taikoma pagrindinės prenumeratos (`product_slug = product_name = 'BRAND_000000_SUB'`,
`session_id IS NOT NULL`) užsakymams. UPDATE: surišimo stulpeliai (`psp`, aplinka, sesija,
`solidgate_order_id`, produktas, valiuta, `created_at`, `tracking_metadata`) nekintami;
`solidgate_original_amount_cents` gali būti užpildytas tik iš `NULL`, tik legacy eilutei ir tik
su reconcile GUC. INSERT: `amount_cents` turi lygiai sutapti su
`solidgate_main_checkout_amount(tracking_metadata->>'product_slug', currency)` – tai CLAUDE.md
taisyklės 4 vykdymo vieta; funkcija pati įrašo `solidgate_original_amount_cents`. Kai eilutė
tampa `pending`, paima `pg_advisory_xact_lock(hash(env:session:product))` ir atmeta, jei tam
pačiam raktui jau yra užsakymas, kuris nėra terminaliai nepavykęs (`failed` + `auth_failed|declined|void_ok`).

Klaidos: `23514 'Solidgate main order identity binding is immutable'`;
`23514 'Solidgate main original amount is immutable'`;
`23514 'invalid Solidgate main original amount'`;
`23514 'Solidgate main original amount is required'`;
`23505 'a Solidgate main checkout is already payable or settled'`.
Rašo tik į `NEW`. Testai:
[`solidgate_round2_concurrency.sql#L1351`](../../../supabase/tests/solidgate_round2_concurrency.sql#L1351)
(bruto nekintamumas po įrašymo),
[`sql-price-grid-parity.test.ts`](../../../packages/shared/src/__tests__/sql-price-grid-parity.test.ts#L1)
(kainų tinklelio paritetas).

### `guard_solidgate_oto_payable_order() RETURNS TRIGGER`

[Baseline L1580](../../../supabase/migrations/00001_baseline.sql#L1580). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: tik `REVOKE`.

Taikoma OTO užsakymams (`session_id IS NOT NULL`, `product_slug` ne pagrindinis,
`solidgate_order_id IS NOT NULL`). UPDATE: surišimas, originalus bruto ir kliento identitetas
nekintami (išimtis – legacy eilutė su reconcile GUC). INSERT ir UPDATE: kanoninis surišimas –
`solidgate_order_id = '<session>:<internal_slug>:<attempt>'`, `product_slug` žingsnis lygus
`internal_slug` žingsniui, `product_name = product_slug`, `tracking_metadata` turi
`session_id`, `product_slug`, `funnel_code = 'BRAND'`, `funnel_variant = 'oto<n>'`; 2 žingsnis
(pasikartojantis priedas) reikalauja `price_id` ir `solidgate_product_id`, kiti – `locale`
(lygaus `solidgate_checkout_locale`) ir be `price_id`; `solidgate_payment_action = 'auth_settle'`;
INSERT metu `amount_cents = solidgate_original_amount_cents`. INSERT papildomai paima
advisory lock `env:session:oto-step:<n>`, užrakina `sessions` eilutę `FOR UPDATE`, tikrina
`solidgate_persisted_oto_step(last_oto_step) = žingsnis`, pirmą kartą **įrašo**
`sessions.solidgate_oto_environment` ir atmeta kitą aplinką. Galiausiai (INSERT ir UPDATE)
atmeta, jei tam žingsniui jau yra kitas gyvas užsakymas (ne `failed`+0+terminalus statusas).

Klaidos: `23514 'Solidgate OTO order binding is immutable'`;
`23514 'Solidgate OTO original gross is immutable'`;
`23514 'Solidgate OTO customer identity is immutable'`;
`23514 'invalid canonical Solidgate OTO step binding'`;
`23514 'invalid persisted OTO step'`; `23514 'oto_progress_environment_mismatch'`;
`23514 'oto_progress_conflict'`;
`23505 'a Solidgate OTO step is already payable, settled, or uncertain'`.
Rašo: `sessions.solidgate_oto_environment`, `sessions.updated_at`; kitaip tik `NEW`.
Testas: tiesioginis INSERT šalia neaiškaus OTO užsakymo turi baigtis `unique_violation` su šia
žinute – [`solidgate_round2_concurrency.sql#L633`](../../../supabase/tests/solidgate_round2_concurrency.sql#L633);
visi OTO3 variantai dalijasi vienu žingsniu –
[`#L898`](../../../supabase/tests/solidgate_round2_concurrency.sql#L898).

### `guard_solidgate_pwa_payable_order() RETURNS TRIGGER`

[Baseline L1781](../../../supabase/migrations/00001_baseline.sql#L1781). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: tik `REVOKE`.

Taikoma member-area užsakymams (`session_id IS NULL`, `user_id IS NOT NULL`,
`tracking_metadata->>'funnel_code' = 'PWA'`). UPDATE: surišimo stulpeliai (įskaitant
`user_id`) nekintami; originalus bruto užpildomas tik legacy eilutei su reconcile GUC ir tik
teigiama reikšme. INSERT/UPDATE: `solidgate_order_id = 'u-<user>:<offer_slug>:<attempt>'`,
`product_slug = product_name = solidgate_pwa_product_code(offer_slug)` (UPDATE metu –
`OLD.product_slug`), `funnel_variant = 'member_area'`, `session_id` metaduomenyse = `u-<user>`;
`oto2_addon_weekly` reikalauja `price_id` be `locale`, kiti – `locale` be `price_id`. INSERT:
`amount_cents > 0`, funkcija pati įrašo `solidgate_original_amount_cents := amount_cents`,
`solidgate_payment_status := 'creating'`, `solidgate_submission_token := gen_random_uuid()`,
`solidgate_submission_started_at := NOW()` (jei nepaduota), paima advisory lock
`solidgate:pwa:env:user:product` ir atmeta, jei jau yra kitas neužbaigtas to paties produkto
užsakymas (leidžiami tik `failed`+0+terminalus statusas arba `canceled|expired|refunded`).

Klaidos: `23514 'Solidgate PWA order identity binding is immutable'`;
`23514 'Solidgate PWA original amount is immutable'`;
`23514 'invalid canonical Solidgate PWA order binding'`;
`23514 'invalid Solidgate PWA add-on price binding'`;
`23514 'invalid Solidgate PWA library locale binding'`;
`23514 'invalid Solidgate PWA original amount'`; `23514 'invalid Solidgate PWA gross amount'`;
`23505 'a Solidgate PWA order is already payable or uncertain'`.
Rašo tik į `NEW`. Testai:
[`solidgate_round2_concurrency.sql#L1947`](../../../supabase/tests/solidgate_round2_concurrency.sql#L1947)
(PSP perrišimas ir metaduomenų keitimas atmetami).

### `guard_solidgate_session_vault_card_source() RETURNS TRIGGER`

[Baseline L1933](../../../supabase/migrations/00001_baseline.sql#L1933). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: tik `REVOKE`.

Neleidžia rašyti `solidgate_session_vault` kortelės šaltinio stulpelių (`customer_account_id`,
`card_token`, `card_brand`, `card_last4`, `card_source_order_id`, `card_source_created_at`,
`card_source_sequence`, `card_source_legacy`) niekam, išskyrus monotoninį rašytoją: GUC
`app.solidgate_session_vault_source_write` turi būti lygus `NEW.card_source_order_id::TEXT`.
Vienintelė kita leidžiama operacija – operatoriaus legacy išvalymas (`OLD.card_source_legacy`,
visi šaltinio laukai `NULL`, GUC `'operator-clear:<session_id>'`), kurį nustato tik
`clear_solidgate_legacy_session_vault`. UPDATE, kuris neliečia šių stulpelių, praleidžiamas.

Klaida: `23514 'Solidgate session vault token requires an exact-order monotonic writer'`.
Rašo tik į `NEW`. Testas: [`solidgate_card_update_state.sql#L1026`](../../../supabase/tests/solidgate_card_update_state.sql#L1026),
[`solidgate_payment_identity.sql#L562`](../../../supabase/tests/solidgate_payment_identity.sql#L562)
(fikstūra turi laikinai išjungti trigger'į, kad įrašytų legacy eilutę).

### `guard_solidgate_session_vault_payment_method() RETURNS TRIGGER`

[Baseline L1982](../../../supabase/migrations/00001_baseline.sql#L1982). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: tik `REVOKE`.

Saugo `card_original_payment_method` (žetono kilmė: `card`, `apple-pay`, ...) sesijos
saugykloje. Kai UPDATE keičia šaltinio stulpelius, funkcija **pati nunulina**
`NEW.card_original_payment_method` (kilmė galioja tik tai kartai). Jei kilmė keičiama, reikia
to paties GUC fence kaip šaltinio guard'e; operatoriaus legacy išvalymas leidžiamas tik su
`card_original_payment_method IS NULL`.

Klaida: `23514 'Solidgate session vault payment method requires an exact-order monotonic writer'`.
Rašo tik į `NEW`. Testas: [`solidgate_token_origin_payment_type.sql#L155`](../../../supabase/tests/solidgate_token_origin_payment_type.sql#L155).

### `guard_solidgate_account_vault_card_source() RETURNS TRIGGER`

[Baseline L2047](../../../supabase/migrations/00001_baseline.sql#L2047). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: tik `REVOKE`.

Tas pats principas paskyros saugyklai `solidgate_account_vault`: INSERT arba šaltinio
stulpelių UPDATE leidžiamas tik kai GUC `app.solidgate_vault_source_write` lygus
`NEW.card_source_kind || ':' || NEW.card_source_id`. Nustato tik
`write_solidgate_account_vault_monotonic`, `write_solidgate_account_vault_with_method` ir
`promote_solidgate_session_vault_with_method`.

Klaida: `23514 'Solidgate account vault token requires a monotonic source writer'`.
Rašo tik į `NEW`. Testas: tiesioginis `UPDATE`/`INSERT` į `solidgate_account_vault` –
[`solidgate_card_update_state.sql#L450`](../../../supabase/tests/solidgate_card_update_state.sql#L450).

### `guard_solidgate_account_vault_payment_method() RETURNS TRIGGER`

[Baseline L2086](../../../supabase/migrations/00001_baseline.sql#L2086). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: tik `REVOKE`.

Paskyros saugyklos `card_original_payment_method` atitikmuo: šaltinio pasikeitimas nunulina
kilmę, kilmės keitimui reikia `kind:id` fence.

Klaida: `23514 'Solidgate account vault payment method requires a monotonic source writer'`.
Rašo tik į `NEW`. Testas: [`solidgate_token_origin_payment_type.sql#L277`](../../../supabase/tests/solidgate_token_origin_payment_type.sql#L277).

### `prevent_solidgate_entitlement_replay() RETURNS TRIGGER`

[Baseline L2125](../../../supabase/migrations/00001_baseline.sql#L2125). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `REVOKE` + `GRANT ... service_role`
([L9531](../../../supabase/migrations/00001_baseline.sql#L9531)) – vienintelė trigger funkcija
su GRANT; praktinės reikšmės tai neturi, nes trigger funkcijos `.rpc()` nekviečiamos.

Saugo `entitlements` nuo pakartotinio/neteisėto suteikimo. Taisyklės: (1) atšaukta
(`revoked_at` arba `status = 'canceled'`) teisė negali būti reaktyvuota su tuo pačiu
`order_id` – tombstone; (2) `special_free` (tik zero-auth karta, `auth_0_amount`) kilmė
„lipni“: negalima atkabinti `order_id`, negalima suteikti be `order_id`, negalima perrišti prie
kitokio užsakymo be naujo įrodyto `special_free` pirkimo; (3) kiekvienas gyvas grantas užrakina
savo užsakymą `FOR SHARE` ir atmeta, jei aplinka nesutampa arba užsakymas terminalus
(`canceled|refunded|disputed`, `void_ok`, chargeback); (4) `special_free` aktyvavimui reikia
`solidgate_special_free_card_ready(order)` – daugkartinio kortelės žetono įrodymo. Komentaras
[L2143](../../../supabase/migrations/00001_baseline.sql#L2143): nuo 2026-07-29 `special_free`
apmoka €1 ir čia nebelaikomas ypatingu, todėl išskirtinė logika taikoma tik `auth_0_amount`.

Klaidos: `P0001 'cannot reactivate a revoked entitlement with the same order'`;
`23514 'cannot detach a special_free entitlement from its verified order'`;
`23514 'cannot grant detached special_free access'`;
`P0001 'entitlement grant order does not exist'`;
`P0001 'entitlement and order payment environments do not match'`;
`P0001 'cannot grant entitlement for a terminal Solidgate order'`;
`23514 'cannot rebind a special_free entitlement without a new verified special_free purchase'`;
`23514 'cannot grant special_free entitlement without exact reusable-card proof'`.
Rašo tik į `NEW`; SQL viduje kviečia `solidgate_special_free_card_ready`
([L2278](../../../supabase/migrations/00001_baseline.sql#L2278),
[L2308](../../../supabase/migrations/00001_baseline.sql#L2308)). Testai:
[`solidgate_subscription_renewals.sql#L274`](../../../supabase/tests/solidgate_subscription_renewals.sql#L274)
(tombstone), [`solidgate_token_origin_payment_type.sql#L323`](../../../supabase/tests/solidgate_token_origin_payment_type.sql#L323)
(`special_free` kilmės riba).

### `enqueue_solidgate_subscription_token_sync_from_entitlement() RETURNS TRIGGER`

[Baseline L2321](../../../supabase/migrations/00001_baseline.sql#L2321). Deklaracija:
`plpgsql`, `SECURITY DEFINER` (rašo į `solidgate_subscription_token_sync_jobs`, kurios
`service_role` nemato), `search_path = ''`. Teisės: tik `REVOKE`.

`AFTER` trigger'is `entitlements` lentelėje: kai teisė yra gyva prenumerata (`active|past_due`,
`revoked_at IS NULL`, yra `solidgate_subscription_id`), patikrina paskyros saugyklą. Jei
saugykloje yra `main_order`/`pwa_order` šaltinis be žetono, kviečia
`fence_solidgate_subscription_token_sync_for_tokenless_source` ([L2344](../../../supabase/migrations/00001_baseline.sql#L2344))
– darbas pažymimas `awaiting_token`; kitaip `enqueue_solidgate_subscription_token_sync`
([L2353](../../../supabase/migrations/00001_baseline.sql#L2353)). Tikslas: vėluojantis grantas
vis tiek užregistruoja naujesnę kortelę prenumeratai. Klaidų pati nekelia. Rašo per kviečiamas
funkcijas į `solidgate_subscription_token_sync_jobs`. Testas: vėluojantis grantas turi
įtraukti griežtai naujesnę kortelę –
[`solidgate_card_update_state.sql#L98`](../../../supabase/tests/solidgate_card_update_state.sql#L98).

## Webhook inbox ir entity tvarka

Solidgate webhook'as (Deno funkcija
[`supabase/functions/solidgate-webhooks/index.ts`](../../../supabase/functions/solidgate-webhooks/index.ts))
kiekvieną callback'ą pirmiausia „užima“ inbox lentelėje `solidgate_webhook_events`, tada
serializuoja apdorojimą pagal esybę (`solidgate_entity_watermarks`) ir pabaigoje pažymi
`completed`/`failed`. Visos šios funkcijos yra `SECURITY INVOKER`, nes `service_role` turi
tiesiogines teises į abi lenteles ([L817](../../../supabase/migrations/00001_baseline.sql#L817),
[L838](../../../supabase/migrations/00001_baseline.sql#L838)).

### `claim_solidgate_webhook_event(p_event_id TEXT, p_type TEXT, p_event_created_at TIMESTAMPTZ, p_environment TEXT, p_payload JSONB, p_lease_seconds INTEGER DEFAULT 300) RETURNS BOOLEAN`

[Baseline L2374](../../../supabase/migrations/00001_baseline.sql#L2374). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`
([L9536](../../../supabase/migrations/00001_baseline.sql#L9536)).

Legacy (v1) inbox užėmimas: `INSERT ... ON CONFLICT (environment, event_id) DO UPDATE`, kuris
perima eilutę tik kai ji `failed` arba `processing` su pasibaigusia nuoma
(`processing_started_at < NOW() - GREATEST(p_lease_seconds, 30)`). Grąžina `TRUE`, jei
užėmė. Perimdama eilutę nunulina `claim_token` ir didina `claim_generation`, todėl v2
worker'io fence tampa negaliojantis. Klaidų nekelia. Rašo `solidgate_webhook_events`.

Kvietėjai: **nebekviečiama iš kodo** – `index.ts` naudoja tik `_v2`. Funkcija palikta
sąmoningai: [`webhook.test.ts#L1234`](../../../supabase/functions/solidgate-webhooks/__tests__/webhook.test.ts#L1234)
tvirtina, kad baseline jos neištrina, o
[`solidgate_round2_concurrency.sql#L24`](../../../supabase/tests/solidgate_round2_concurrency.sql#L24)
pina v1/v2 serializaciją ir kad legacy perėmimas anuliuoja v2 fence
([`#L174`](../../../supabase/tests/solidgate_round2_concurrency.sql#L174)). README
([`supabase/tests/README.md`](../../../supabase/tests/README.md#L163)): trinant v1 reikia
trinti ir tuos scenarijus.

### `claim_solidgate_webhook_event_v2(p_event_id TEXT, p_type TEXT, p_event_created_at TIMESTAMPTZ, p_environment TEXT, p_payload JSONB, p_lease_seconds INTEGER DEFAULT 300) RETURNS TABLE (claim_state TEXT, claim_token UUID, claim_generation BIGINT)`

[Baseline L2449](../../../supabase/migrations/00001_baseline.sql#L2449). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

Tas pats upsert, bet su fence: sugeneruoja `claim_token`, didina `claim_generation` ir grąžina
`'claimed'` su abiem; jei perimti nepavyko, perskaito eilutę (ON CONFLICT serializuoja ant PK)
ir grąžina `'completed'` (dublikatas jau apdorotas) arba `'busy'` (kitas worker'is dar laiko
nuomą). Kitokia būsena laikoma neįmanoma.

Klaidos: `22023 'invalid Solidgate webhook claim'` (tušti parametrai, aplinka ne
`production|sandbox`); `P0001 'unexpected Solidgate webhook inbox state % for %/%'`.
Rašo `solidgate_webhook_events`. Kvietėjas:
[`index.ts#L887` `claimEvent()`](../../../supabase/functions/solidgate-webhooks/index.ts#L887).
Testai: [`solidgate_round2_concurrency.sql#L82`](../../../supabase/tests/solidgate_round2_concurrency.sql#L82).

### `complete_solidgate_webhook_event_v2(p_environment TEXT, p_event_id TEXT, p_claim_token UUID, p_claim_generation BIGINT) RETURNS BOOLEAN`

[Baseline L2567](../../../supabase/migrations/00001_baseline.sql#L2567). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

Pažymi įvykį `completed` tik jei eilutė vis dar `processing` **ir** `claim_token` bei
`claim_generation` sutampa – worker'is, kurio nuomą kažkas perėmė, negali „užbaigti“ svetimo
darbo. Grąžina `TRUE`, kai atnaujinta lygiai viena eilutė. Klaida:
`22023 'invalid Solidgate webhook completion claim'`. Rašo `solidgate_webhook_events`.
Kvietėjas: [`index.ts#L931` `completeEvent()`](../../../supabase/functions/solidgate-webhooks/index.ts#L931).
Testas: [`solidgate_round2_concurrency.sql#L122`](../../../supabase/tests/solidgate_round2_concurrency.sql#L122).

### `fail_solidgate_webhook_event_v2(p_environment TEXT, p_event_id TEXT, p_claim_token UUID, p_claim_generation BIGINT, p_last_error TEXT) RETURNS BOOLEAN`

[Baseline L2609](../../../supabase/migrations/00001_baseline.sql#L2609). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

Simetriška `complete`: su tuo pačiu fence pažymi `failed`, įrašo `last_error`
(`LEFT(..., 4000)`), nunulina nuomą, kad kitas pristatymas galėtų perimti. Klaida:
`22023 'invalid Solidgate webhook failure claim'` (taip pat kai `p_last_error` tuščias).
Rašo `solidgate_webhook_events`. Kvietėjas:
[`index.ts#L953` `failEvent()`](../../../supabase/functions/solidgate-webhooks/index.ts#L953).

### `claim_solidgate_entity_event(p_entity_type TEXT, p_entity_id TEXT, p_event_created_at TIMESTAMPTZ, p_event_id TEXT, p_lease_seconds INTEGER DEFAULT 300) RETURNS TEXT`

[Baseline L2652](../../../supabase/migrations/00001_baseline.sql#L2652). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

Esybės (užsakymo, prenumeratos) lygio tvarkos sargas `solidgate_entity_watermarks`: sukuria
eilutę, užrakina `FOR UPDATE`, grąžina `'stale'`, jei `p_event_created_at` senesnis už
`last_event_created_at` (lygus laikas **praleidžiamas** – skirtingi callback'ai su vienoda
žyma abu turi pasiekti idempotentiškus handler'ius, komentaras
[L2685](../../../supabase/migrations/00001_baseline.sql#L2685)); `'busy'`, jei kitas
`processing_event_id` dar laiko nuomą; kitaip įrašo `processing_*` ir grąžina `'claimed'`.
Klaida: `22023 'invalid Solidgate entity event claim'`. Rašo `solidgate_entity_watermarks`.
Kvietėjas: [`index.ts#L993` `withEntityOrdering()`](../../../supabase/functions/solidgate-webhooks/index.ts#L993).
Testas: [`solidgate_round2_concurrency.sql#L268`](../../../supabase/tests/solidgate_round2_concurrency.sql#L268).

### `complete_solidgate_entity_event(p_entity_type TEXT, p_entity_id TEXT, p_event_created_at TIMESTAMPTZ, p_event_id TEXT) RETURNS VOID`

[Baseline L2710](../../../supabase/migrations/00001_baseline.sql#L2710). Deklaracija:
`LANGUAGE sql`, `SECURITY INVOKER`, `search_path = ''` (be `public.` prefikso pavadinime,
bet sukuriama `public` schemoje). Teisės: `service_role`.

Perkelia `processing_*` į `last_event_created_at`/`last_event_id` tik jei
`processing_event_id = p_event_id`. Klaidų nekelia; nesutapimas – tyliai 0 eilučių. Rašo
`solidgate_entity_watermarks`. Kvietėjas:
[`index.ts#L1007`](../../../supabase/functions/solidgate-webhooks/index.ts#L1007).

### `release_solidgate_entity_event(p_entity_type TEXT, p_entity_id TEXT, p_event_id TEXT) RETURNS VOID`

[Baseline L2733](../../../supabase/migrations/00001_baseline.sql#L2733). Deklaracija:
`sql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

Atlaisvina nuomą nepakeldama watermark'o (handler'is nepavyko – įvykis bus pristatytas dar
kartą). Klaidų nekelia. Rašo `solidgate_entity_watermarks`. Kvietėjas:
[`index.ts#L1015`](../../../supabase/functions/solidgate-webhooks/index.ts#L1015).

## Eilės (outbox claim)

Trys `FOR UPDATE SKIP LOCKED` claim funkcijos: paima iki `p_limit` eilučių (`pending|failed`
su `next_attempt_at <= NOW()` arba `processing` su pasibaigusia nuoma), pažymi `processing`,
padidina `attempts` ir grąžina jas. Klaidų nė viena nekelia.

### `claim_solidgate_analytics_outbox(p_environment TEXT, p_limit INTEGER DEFAULT 25, p_lease_seconds INTEGER DEFAULT 300) RETURNS SETOF public.solidgate_analytics_outbox`

[Baseline L2753](../../../supabase/migrations/00001_baseline.sql#L2753). Deklaracija: `sql`,
`SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`. Limitas apkarpomas į `1..100`,
nuoma – bent 30 s; rikiuoja pagal `created_at`. Rašo `solidgate_analytics_outbox`.
Kvietėjas: [`index.ts#L786` `drainAnalyticsOutbox()`](../../../supabase/functions/solidgate-webhooks/index.ts#L786)
(PostHog pristatymas). Užbaigimą/klaidą webhook'as rašo tiesioginiais `.from('solidgate_analytics_outbox')`
`UPDATE`, ne RPC ([`index.ts#L815`](../../../supabase/functions/solidgate-webhooks/index.ts#L815),
[`#L842`](../../../supabase/functions/solidgate-webhooks/index.ts#L842)).

### `claim_solidgate_fulfillment_outbox(p_environment TEXT, p_limit INTEGER DEFAULT 10, p_lease_seconds INTEGER DEFAULT 120) RETURNS SETOF public.solidgate_fulfillment_outbox`

[Baseline L2789](../../../supabase/migrations/00001_baseline.sql#L2789). Deklaracija: `sql`,
`SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`. Skirtumai nuo analitikos:
limitas `1..50`, rikiuoja `created_at, id`, kiekvienai eilutei sugeneruoja `claim_token`
(worker'is jį naudoja fence). Rašo `solidgate_fulfillment_outbox`. Kvietėjas:
[`solidgate-fulfillment.ts#L945` `drainSolidgateFulfillmentOutbox()`](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L945),
kurį paleidžia vidinis maršrutas
[`api/internal/solidgate-fulfillment/route.ts#L26`](../../../apps/funnel/src/app/api/internal/solidgate-fulfillment/route.ts#L26).

### `claim_meta_capi_event(p_environment TEXT, p_event_name TEXT, p_event_id TEXT, p_ip_hash TEXT, p_session_id UUID, p_window_seconds INTEGER DEFAULT 600, p_max_events INTEGER DEFAULT 40) RETURNS BOOLEAN`

[Baseline L9036](../../../supabase/migrations/00001_baseline.sql#L9036). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Ne outbox, o Meta CAPI įėjimo ribotuvas ir dedup ledger'is `meta_capi_event_claims`: ištrina
senesnius nei 30 d. įrašus, paima advisory lock `env:ip_hash`, suskaičiuoja pastarojo lango
įvykius iš to paties IP hash ir grąžina `FALSE`, jei viršytas `p_max_events`; kitaip
`INSERT ... ON CONFLICT (environment, event_name, event_id) DO NOTHING` ir grąžina, ar
įterpta. Aplinkos vardai čia kiti – `production|preview|development` (Vercel, ne mokėjimų
aplinka). Neteisingi parametrai grąžina `FALSE`, ne klaidą. Rašo `meta_capi_event_claims`.
Kvietėjas: [`api/meta/capi/route.ts#L175`](../../../apps/funnel/src/app/api/meta/capi/route.ts#L175).

## Pagrindinis checkout (funnel, `BRAND_000000_SUB`)

Srautas: [`api/solidgate/create-session/route.ts`](../../../apps/funnel/src/app/api/solidgate/create-session/route.ts)
skaito esamą identitetą (`get_solidgate_main_checkout_identity`), atidaro arba pakartotinai
panaudoja užsakymą (`open_solidgate_main_checkout_v2`), sukuria Solidgate `paymentIntent` ir
išsaugo užšifruotą `merchant_data` (`finalize_solidgate_main_checkout_v2`). Užsakymo id formatas:
`<session_id>:<offer_slug>:<attempt>`. Būsena laikoma `solidgate_main_checkout_states`
(vienas įrašas per `(environment, session, product_slug)`).

### `solidgate_checkout_core_is_canonical(p_order public.orders) RETURNS BOOLEAN`

[Baseline L2830](../../../supabase/migrations/00001_baseline.sql#L2830). Deklaracija:
`plpgsql`, `IMMUTABLE`, `search_path = ''`, be `SECURITY` sakinio (INVOKER). Teisės: atimta
ir iš `service_role` ([L9561](../../../supabase/migrations/00001_baseline.sql#L9561)) – tik SQL viduje.

Grynas (be lentelių skaitymo) kanoniškumo patikrinimas visai `orders` eilutei: `psp`, aplinka,
`product_name = product_slug`, `tracking_metadata` – tik string reikšmės; vidinis slug'as iš
metaduomenų atitinka pasiūlymo kodą pagal **funkcijoje įrašytą lentelę**
([L2862](../../../supabase/migrations/00001_baseline.sql#L2862): `trial1..4`, `trial_monthly`,
`special_1eur`, `special_free` → `BRAND_000000_SUB`, `oto1_lifetime` →
`BRANDLIFETIME_000000_SUB` ir t. t.); `solidgate_order_id` prefiksas = `session_id` arba
`u-<user_id>`, antras segmentas = vidinis slug'as, trečias – `1..999999999`, ketvirto nėra;
`funnel_code` `BRAND`/`PWA`, `funnel_variant` (`main`, `special_1eur`, `special_free`, `oto<n>`,
`member_area`); katalogo prenumeratos (`BRAND_000000_SUB`, `BRANDADDON_000000_SUB`) turi
`price_id` be `locale`, kiti – atvirkščiai. Klaidų nekelia, nerašo. Kviečia:
`record_solidgate_pwa_confirmed_capture` ([L5799](../../../supabase/migrations/00001_baseline.sql#L5799),
[L5831](../../../supabase/migrations/00001_baseline.sql#L5831)),
`reconcile_solidgate_legacy_order_identity` ([L6117](../../../supabase/migrations/00001_baseline.sql#L6117)),
`solidgate_special_free_card_ready` ([L6312](../../../supabase/migrations/00001_baseline.sql#L6312)),
`solidgate_subscription_token_sync_is_billable` ([L8411](../../../supabase/migrations/00001_baseline.sql#L8411)).
Pastaba: `trial_monthly` čia yra, bet `solidgate_main_checkout_amount` ir `open_solidgate_main_checkout`
jo nepriima – tai tik istorinių eilučių pripažinimas.

### `get_solidgate_main_checkout_identity(p_payment_environment TEXT, p_session_id UUID, p_product_slug TEXT) RETURNS TABLE (order_db_id UUID, offer_slug TEXT, customer_email TEXT, checkout_locale TEXT, solidgate_product_id TEXT, solidgate_payment_action TEXT, amount_cents INTEGER, currency TEXT, tracking_metadata JSONB, user_id UUID)`

[Baseline L2933](../../../supabase/migrations/00001_baseline.sql#L2933). Deklaracija:
`plpgsql`, `STABLE`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

Grąžina nekintamą jau atidaryto pagrindinio checkout identitetą, kad pakartotinis
`create-session` naudotų **istorinę** el. pašto/locale/kainos nuotrauką, o ne dabartinius
mutuojamus sesijos duomenis. Jei būsenos įrašo nėra – tuščias rezultatas; jei būsena rodo į
terminaliai nepavykusį užsakymą (`failed` + `auth_failed|declined|void_ok`) – taip pat tuščia
(kviečiantysis atidarys naują bandymą). Legacy eilutei (be identiteto) kelia klaidą, kad
niekas neatkurtų identiteto iš mutuojamų šaltinių.

Klaidos: `23514 'legacy Solidgate main checkout identity requires provider reconciliation'`;
`INTO STRICT` – `P0002`, jei būsena rodo į neegzistuojantį/nesutampantį užsakymą. Nerašo.
Kvietėjas: [`create-session/route.ts#L289`](../../../apps/funnel/src/app/api/solidgate/create-session/route.ts#L289).
Testai: [`solidgate_payment_identity.sql#L146`](../../../supabase/tests/solidgate_payment_identity.sql#L146)
(profilio pakeitimas nekeičia grąžinamo identiteto),
[`#L553`](../../../supabase/tests/solidgate_payment_identity.sql#L553) (legacy eilutė → `check_violation`).

### `open_solidgate_main_checkout(p_payment_environment TEXT, p_session_id UUID, p_offer_slug TEXT, p_product_slug TEXT, p_amount_cents INTEGER, p_currency TEXT, p_product_name TEXT, p_tracking_metadata JSONB, p_builder_token UUID, p_user_id UUID DEFAULT NULL) RETURNS TABLE (order_db_id, solidgate_order_id, bound_session_id, bound_payment_environment, bound_product_slug, bound_product_name, bound_offer_slug, bound_amount_cents, bound_currency, bound_order_status, bound_payment_status, bound_tracking_metadata, is_new, should_build, merchant_data)`

[Baseline L3081](../../../supabase/migrations/00001_baseline.sql#L3081). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: atimta iš `service_role`
([L9569](../../../supabase/migrations/00001_baseline.sql#L9569)) – **nebekviečiama iš kodo**;
vienintelis kvietėjas – `open_solidgate_main_checkout_v2`
([L3630](../../../supabase/migrations/00001_baseline.sql#L3630)), kai būsenos įrašo dar nėra.

Atominis v1 atidarytojas. Validuoja parametrus (tier iš šešių, `p_product_slug =
'BRAND_000000_SUB'`, suma lygi `solidgate_main_checkout_amount`, metaduomenys su
`session_id`/`product_slug`/`funnel_code='BRAND'`/`funnel_variant`/`price_id`), paima advisory
lock `env:session:product`, pereina per visus sesijos užsakymus tam produktui arba su tuo
pačiu id prefiksu `FOR UPDATE`: legacy eilutei užpildo `solidgate_original_amount_cents`,
tikrina surišimą, skaičiuoja didžiausią `attempt`, `pending` eilutę pasirenka kaip atvirą
(daugiau nei viena – klaida), `failed` privalo turėti terminalų PSP statusą, bet kokia kita
būsena (`completed`, `active`, `refunded`...) reiškia „nebeperkamas“. Jei atvirų nėra –
įterpia `pending` užsakymą su `attempt = max + 1` (sąmoningai be `ON CONFLICT`: dublikatas
reiškia sulaužytą invariantą ir turi nepavykti). Tada upsert'ina
`solidgate_main_checkout_states`; jei būsena rodė į kitą (pasenusį) užsakymą – perrašo ją ir
nunulina `merchant_data`; nustato `should_build` (statytojas tas pats arba nuoma senesnė nei
30 s).

Klaidos: `22023 'invalid canonical Solidgate main checkout binding'`;
`23514 'existing Solidgate main order binding mismatch'`;
`23514 'invalid existing Solidgate main order id'`;
`23514 'inconsistent terminal Solidgate main order state'`;
`23514 'failed Solidgate main order is not terminal'`;
`23505 'multiple payable Solidgate main orders already exist'`;
`23514 'Solidgate main checkout is not retryable'`;
`22003 'Solidgate main checkout attempt exhausted'`;
`23514 'Solidgate main checkout offer binding mismatch'`.
Rašo `orders`, `solidgate_main_checkout_states`. Testas:
[`solidgate_payment_identity.sql#L80`](../../../supabase/tests/solidgate_payment_identity.sql#L80)
(ACL).

### `open_solidgate_main_checkout_v2(..., p_builder_token UUID, p_customer_email TEXT, p_checkout_locale TEXT, p_solidgate_product_id TEXT, p_solidgate_payment_action TEXT, p_user_id UUID DEFAULT NULL) RETURNS TABLE (... + bound_customer_email, bound_checkout_locale, bound_solidgate_product_id, bound_solidgate_payment_action ...)`

[Baseline L3391](../../../supabase/migrations/00001_baseline.sql#L3391). Pirmi devyni parametrai
tokie patys kaip v1. Deklaracija: `plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės:
`service_role`.

Identiteto atidarytojas, kurį **realiai kviečia TypeScript**. Normalizuoja ir validuoja
identitetą (el. paštas, locale iš 15, `solidgate_product_id` privalomas, `payment_action`
`auth_settle|auth_0_amount`, o `p_amount_cents = 0` ⇔ `auth_0_amount`), nustato tranzakcijos
GUC `app.solidgate_customer_email|checkout_locale|product_id|payment_action`, kuriuos
`guard_solidgate_checkout_identity` įrašo į INSERT'inamą eilutę. Paima tą patį advisory lock,
užrakina būsenos įrašą: (a) būsena yra ir užsakymas gyvas – griežtai lygina visą nuotrauką
(įskaitant identitetą ir `tracking_metadata`) su parametrais, atnaujina builder nuomą;
(b) būsena yra, bet užsakymas terminaliai nepavykęs – įsitikina, kad nėra kitų neterminalių
eilučių, įterpia naują `attempt = max + 1` ir perrašo būseną; (c) būsenos nėra – deleguoja v1.
Pabaigoje perskaito užsakymą `FOR SHARE` ir atmeta legacy identitetą; GUC išvalo.

Klaidos: `22023 'invalid Solidgate main checkout identity'`;
`23514 'existing Solidgate main checkout snapshot mismatch'`;
`23514 'Solidgate main checkout is not retryable'`;
`22003 'Solidgate main checkout attempt exhausted'`;
`23514 'legacy Solidgate main checkout identity requires provider reconciliation'`;
plius visos v1 ir `guard_*` klaidos. Rašo `orders`, `solidgate_main_checkout_states`.
Kvietėjas: [`create-session/route.ts#L604`](../../../apps/funnel/src/app/api/solidgate/create-session/route.ts#L604).
Testai: [`solidgate_payment_identity.sql#L112`](../../../supabase/tests/solidgate_payment_identity.sql#L112),
[`solidgate_round2_concurrency.sql#L1050`](../../../supabase/tests/solidgate_round2_concurrency.sql#L1050)
(RPC ir tiesioginis rašytojas serializuojasi abiem tvarkomis; pasibaigusi nuoma perimama
tik tam pačiam užsakymui; terminalus bandymas eina tiksliai į `N+1`).

### `finalize_solidgate_main_checkout(p_payment_environment TEXT, p_session_id UUID, p_offer_slug TEXT, p_product_slug TEXT, p_order_db_id UUID, p_solidgate_order_id TEXT, p_amount_cents INTEGER, p_currency TEXT, p_builder_token UUID, p_merchant_data JSONB) RETURNS JSONB`

[Baseline L3692](../../../supabase/migrations/00001_baseline.sql#L3692). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: atimta iš `service_role`
([L9574](../../../supabase/migrations/00001_baseline.sql#L9574)) – **nebekviečiama iš kodo**;
kvietėjas tik `finalize_solidgate_main_checkout_v2` ([L3854](../../../supabase/migrations/00001_baseline.sql#L3854)).

Išsaugo užšifruotą Solidgate formos payload'ą (`merchant`, `paymentIntent`, `signature` –
visi privalomi string'ai) į `solidgate_main_checkout_states.merchant_data`. Po advisory lock
užrakina užsakymą ir būseną, tikrina, kad užsakymas nepasikeitė (`pending`, ne terminalus PSP
statusas, sumos/valiuta/id sutampa) ir kad būsena vis dar priklauso šiam `builder_token`. Jei
`merchant_data` jau yra ir identiškas – idempotentiškai grąžina; jei kitoks – klaida.

Klaidos: `22023 'invalid Solidgate main merchant data finalization'`;
`23514 'Solidgate main order changed before finalization'`;
`40001 'Solidgate main checkout builder lost ownership'`;
`23514 'Solidgate main checkout already finalized differently'`.
Rašo `solidgate_main_checkout_states`. Testas:
[`solidgate_round2_concurrency.sql#L1286`](../../../supabase/tests/solidgate_round2_concurrency.sql#L1286)
(išstumtas statytojas gauna `serialization_failure`).

### `finalize_solidgate_main_checkout_v2(..., p_merchant_data JSONB, p_customer_email TEXT, p_checkout_locale TEXT) RETURNS JSONB`

[Baseline L3813](../../../supabase/migrations/00001_baseline.sql#L3813). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Plonas apvalkalas: užrakina užsakymą `FOR SHARE`, patikrina, kad įrašytas identitetas (ne
legacy, el. paštas ir locale) sutampa su tuo, kurį maršrutas naudojo kurdamas
`paymentIntent`, ir deleguoja v1. Klaida:
`23514 'Solidgate main checkout identity changed before finalization'`; `INTO STRICT` –
`P0002`, jei užsakymo su tokiu id/sesija nėra. Rašo per v1. Kvietėjas:
[`create-session/route.ts#L718`](../../../apps/funnel/src/app/api/solidgate/create-session/route.ts#L718).

### `reconcile_solidgate_legacy_order_identity(p_payment_environment TEXT, p_solidgate_order_id TEXT, p_customer_email TEXT, p_customer_account_id TEXT, p_order_description TEXT, p_solidgate_product_id TEXT, p_original_amount_cents INTEGER, p_currency TEXT, p_order_metadata JSONB, p_card_token TEXT, p_card_brand TEXT, p_card_last4 TEXT) RETURNS BOOLEAN`

[Baseline L6053](../../../supabase/migrations/00001_baseline.sql#L6053). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: atimta iš `service_role`
([L9607](../../../supabase/migrations/00001_baseline.sql#L9607)) – **operatoriaus (`postgres`)
įrankis, iš kodo nekviečiama**.

Vienintelis būdas legacy užsakymui (`solidgate_checkout_identity_legacy = TRUE`) gauti
identitetą: operatorius paduoda **tiekėjo įrodymus** (Solidgate užsakymo `customer_email`,
`customer_account_id`, `order_description`, `product_id`, suma, valiuta, metaduomenys, kortelės
žetonas). Funkcija užrakina užsakymą, išveda locale iš aprašymo prefikso (`LT_` → `lt`, `TW_`
→ `zh-TW`, ...), reikalauja `product_id` tik katalogo prenumeratoms, tikrina kanoniškumą
(`solidgate_checkout_core_is_canonical`), metaduomenų lygybę, `customer_account_id` (PWA –
grynas `user_id`, be `u-`), aprašymą (`<PREFIX>_<product_name>` arba su ` o:<PREFIX>_BRAND_000000_SUB`
priedu), sumas. Tada nustato GUC `app.solidgate_identity_reconcile_order = order.id`, kad
`guard_*` trigger'iai praleistų šį vienintelį UPDATE, ir įrašo identitetą. Jei tai pagrindinis
užsakymas su žetonu – su `app.solidgate_session_vault_source_write` fence perriša
`solidgate_session_vault` eilutę su tuo pačiu žetonu prie šio užsakymo (tik jei ji legacy
arba jos šaltinis senesnis).

Klaidos: `23514 'provider evidence does not match legacy Solidgate order'`; `INTO STRICT` –
`P0002`, jei legacy užsakymo nėra. Rašo `orders`, `solidgate_session_vault`. Testai:
[`solidgate_payment_identity.sql#L102`](../../../supabase/tests/solidgate_payment_identity.sql#L102)
(ACL), [`#L573`](../../../supabase/tests/solidgate_payment_identity.sql#L573) (neteisingas
`product_id` atmetamas, tikslūs įrodymai suriša identitetą ir žetoną, `u-` prefiksas PWA
`customer_account_id` atmetamas).

## OTO (funnel upsell, žingsniai 1–8)

Srautas: [`api/solidgate/charge-oto/route.ts`](../../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts)
atidaro užsakymą (`open_solidgate_oto_order_v2`), vieno paspaudimo mokėjimą siunčia į
Solidgate su sesijos saugyklos žetonu, o po sėkmės suteikia teisę (`grant_solidgate_oto_entitlement`)
ir pastumia checkpoint'ą (`advance_solidgate_oto_progress` su `p_allow_catch_up = TRUE`).
Praleidimą be pirkimo daro [`api/solidgate/advance-oto/route.ts`](../../../apps/funnel/src/app/api/solidgate/advance-oto/route.ts).
OTO neturi atskiros būsenų lentelės: nuoma laikoma pačiame `orders` įraše
(`solidgate_submission_token`, `solidgate_submission_started_at`, `solidgate_payment_status = 'creating'`).

### `open_solidgate_oto_order_v2(p_payment_environment TEXT, p_session_id UUID, p_product_slug TEXT, p_order_prefix TEXT, p_amount_cents INTEGER, p_currency TEXT, p_product_name TEXT, p_tracking_metadata JSONB, p_customer_email TEXT, p_checkout_locale TEXT, p_builder_token UUID, p_user_id UUID DEFAULT NULL, p_solidgate_product_id TEXT DEFAULT NULL, p_solidgate_payment_action TEXT DEFAULT 'auth_settle') RETURNS TABLE (order_db_id UUID, solidgate_order_id TEXT, order_status TEXT, solidgate_payment_status TEXT, is_new BOOLEAN, should_submit BOOLEAN, needs_reconcile BOOLEAN, claim_token UUID, bound_original_amount_cents INTEGER, bound_currency TEXT, bound_tracking_metadata JSONB, bound_customer_email TEXT, bound_checkout_locale TEXT, bound_solidgate_product_id TEXT, bound_solidgate_payment_action TEXT)`

[Baseline L3869](../../../supabase/migrations/00001_baseline.sql#L3869). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`. V1 atitikmens
baseline nėra – v2 identitetą rašo tiesiai į INSERT stulpelius (komentaras
[L1415](../../../supabase/migrations/00001_baseline.sql#L1415)).

Atominis OTO atidarytojas. `p_order_prefix = '<session>:<internal_slug>'`; žingsnis iš
`internal_slug` turi sutapti su žingsniu iš `p_product_slug`; metaduomenys – `funnel_code='BRAND'`,
`funnel_variant='oto<n>'`; 2 žingsniui privalomi `price_id` ir `p_solidgate_product_id`, kitiems
– `locale` (lygus `p_checkout_locale`) ir jokio `product_id`; `payment_action` tik `auth_settle`.
Paima advisory lock `env:session:oto-step:<n>`, užrakina `sessions` eilutę, tikrina
`solidgate_persisted_oto_step`, įrašo/tikrina `sessions.solidgate_oto_environment`. Skenuoja
**visą žingsnį** (ne tik prašomą produktą – OTO3 variantai dalijasi žingsniu): gyvas užsakymas
kitam variantui → `oto_step_already_bound`; gyvas tas pats produktas → pakartotinis
panaudojimas; jei gyvų nėra – `persisted_step` privalo būti lygus prašomam (kitaip
`oto_progress_conflict`) ir įterpiamas naujas `pending`/`creating` užsakymas su
`attempt = max + 1`, pilnu identitetu ir `solidgate_submission_token = p_builder_token`.
Esamam `pending`+`creating` užsakymui, kurio nuoma senesnė nei 120 s, perima nuomą ir grąžina
`needs_reconcile = TRUE` (maršrutas privalo patikrinti Solidgate, ar užsakymas ten egzistuoja,
prieš siųsdamas iš naujo). Gyvai eilutei lyginami tik nekintami jos laukai – šviežias sesijos
el. paštas/locale sąmoningai nelyginami ([L4070](../../../supabase/migrations/00001_baseline.sql#L4070)).

Klaidos: `22023 'invalid canonical Solidgate OTO binding'`;
`23514 'invalid persisted OTO step'`; `23514 'oto_progress_environment_mismatch'`;
`23514 'existing Solidgate OTO order binding mismatch'`;
`23514 'existing Solidgate OTO immutable binding mismatch'`;
`23505 'oto_step_already_bound'`;
`23514 'existing Solidgate OTO user binding mismatch'`;
`23505 'multiple payable or uncertain Solidgate OTO step orders already exist'`;
`23514 'oto_progress_conflict'`; `22003 'Solidgate OTO attempt exhausted'`.
Rašo `orders`, `sessions` (`solidgate_oto_environment`). Kvietėjas:
[`charge-oto/route.ts#L1197`](../../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L1197).
Testai: [`solidgate_round2_concurrency.sql#L370`](../../../supabase/tests/solidgate_round2_concurrency.sql#L370)
(RPC ir tiesioginis INSERT ima tą patį lock; pasibaigusi nuoma – tik reconcile),
[`solidgate_oto_progress.sql#L141`](../../../supabase/tests/solidgate_oto_progress.sql#L141).

### `resume_solidgate_oto_order_after_absent_reconcile(p_payment_environment TEXT, p_session_id UUID, p_product_slug TEXT, p_order_db_id UUID, p_solidgate_order_id TEXT, p_builder_token UUID) RETURNS BOOLEAN`

[Baseline L4250](../../../supabase/migrations/00001_baseline.sql#L4250). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

Kai maršrutas gavo `needs_reconcile` ir Solidgate patvirtino, kad užsakymo ten **nėra**,
ši funkcija leidžia tam pačiam nuomos savininkui siųsti iš naujo: atnaujina
`solidgate_submission_started_at`, bet tik jei eilutė vis dar `pending`+`creating`, žetonas
sutampa ir nuoma jaunesnė nei 120 s. Grąžina `TRUE` tik atnaujinus lygiai vieną eilutę.
Klaida: `22023 'invalid Solidgate OTO resume binding'`. Rašo `orders`. Kvietėjas:
[`charge-oto/route.ts#L1324`](../../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L1324).
Testas: [`solidgate_round2_concurrency.sql#L517`](../../../supabase/tests/solidgate_round2_concurrency.sql#L517).

### `advance_solidgate_oto_progress(p_payment_environment TEXT, p_session_id UUID, p_current_step INTEGER, p_allow_catch_up BOOLEAN DEFAULT FALSE) RETURNS TABLE (persisted_step INTEGER, advanced BOOLEAN, conflict BOOLEAN)`

[Baseline L5913](../../../supabase/migrations/00001_baseline.sql#L5913). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

Vienintelis `sessions.last_oto_step` rašytojas. Tikslas `p_current_step + 1` (1→2 ... 7→8).
Užrakina sesiją, įrašo/tikrina `solidgate_oto_environment`. Jei persistuotas žingsnis jau ≥
tikslo – idempotentiškai `advanced = FALSE, conflict = FALSE` (niekada nejuda atgal). Jei
persistuotas žingsnis mažesnis už `p_current_step` (praleistas checkpoint'as) – be
`p_allow_catch_up` grąžina `conflict = TRUE`; tik patikimas charge maršrutas po tiekėjo
priimto pirkimo gali „pasivyti“. Paprastas praleidimas atmetamas (`conflict`), jei tam
žingsniui yra gyvas/neaiškus užsakymas – naršyklė negali peršokti mokėtino užsakymo, o
atidarytojas, pamatęs pastumtą checkpoint'ą, atsisako kalti užsakymą (abu serializuojasi ant
sesijos eilutės, komentaras [L6019](../../../supabase/migrations/00001_baseline.sql#L6019)).

Klaidos: `22023 'invalid_payment_environment'`; `22023 'invalid_oto_current_step'`;
`P0002 'oto_progress_session_not_found'`; `23514 'oto_progress_environment_mismatch'`;
`23514 'invalid_persisted_oto_step'`. Rašo `sessions`. Kvietėjai:
[`advance-oto/route.ts#L56`](../../../apps/funnel/src/app/api/solidgate/advance-oto/route.ts#L56)
(praleidimas), [`charge-oto/route.ts#L419`](../../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L419)
(po pirkimo, su catch-up). Testai:
[`solidgate_oto_progress.sql#L7`](../../../supabase/tests/solidgate_oto_progress.sql#L7)
(grandinė neregresuoja, aplinkos nesutapimas kelia `oto_progress_environment_mismatch`),
[`solidgate_round2_concurrency.sql#L845`](../../../supabase/tests/solidgate_round2_concurrency.sql#L845).

## PWA pirkimai (member area)

Srautas: [`apps/pwa/src/app/api/solidgate/purchase/route.ts`](../../../apps/pwa/src/app/api/solidgate/purchase/route.ts)
atidaro pirkimą dviem režimais – `saved_card` (mokėjimas paskyros žetonu per `/recurring`) arba
`hosted_form` (Solidgate forma su `merchant_data`); rezultatą įrašo
`record_solidgate_pwa_submission_result`; [`purchase/confirm/route.ts`](../../../apps/pwa/src/app/api/solidgate/purchase/confirm/route.ts)
ir webhook'as publikuoja patvirtintą capture (`record_solidgate_pwa_confirmed_capture`) ir
suteikia teisę. Užsakymo id: `u-<user_id>:<offer_slug>:<attempt>`. Būsena –
`solidgate_pwa_purchase_states` (vienas įrašas per `(environment, user, product_slug)`), su
`claim_kind` ∈ `build_form|submit_card|reconcile|NULL` ir `last_result_*` laukais.

### `get_solidgate_pwa_checkout_identity(p_payment_environment TEXT, p_user_id UUID, p_product_slug TEXT) RETURNS TABLE (order_db_id UUID, offer_slug TEXT, customer_email TEXT, checkout_locale TEXT, solidgate_product_id TEXT, solidgate_payment_action TEXT, amount_cents INTEGER, currency TEXT, tracking_metadata JSONB, purchase_mode TEXT)`

[Baseline L3003](../../../supabase/migrations/00001_baseline.sql#L3003). Deklaracija:
`plpgsql`, `STABLE`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

PWA atitikmuo pagrindinio identiteto getter'iui. Tuščia, jei būsenos nėra arba dabartinis
užsakymas nebeperkamas (`canceled|expired|refunded` arba `failed` su nuline neto suma ir
terminaliu statusu). Legacy eilutė – klaida. Papildomai grąžina `purchase_mode`.
Klaidos: `23514 'legacy Solidgate PWA checkout identity requires provider reconciliation'`;
`INTO STRICT` – `P0002`. Nerašo. Kvietėjas:
[`purchase/route.ts#L591`](../../../apps/pwa/src/app/api/solidgate/purchase/route.ts#L591).
Testas: [`solidgate_payment_identity.sql#L267`](../../../supabase/tests/solidgate_payment_identity.sql#L267).

### `open_solidgate_pwa_purchase(p_payment_environment TEXT, p_user_id UUID, p_offer_slug TEXT, p_product_slug TEXT, p_amount_cents INTEGER, p_currency TEXT, p_tracking_metadata JSONB, p_requested_mode TEXT, p_claim_token UUID) RETURNS TABLE (order_db_id, solidgate_order_id, bound_payment_environment, bound_user_id, bound_offer_slug, bound_product_slug, bound_product_name, bound_amount_cents, bound_currency, bound_order_status, bound_payment_status, bound_tracking_metadata, purchase_mode, solidgate_subscription_id, verify_url, last_result_kind, last_result_net_amount_cents, is_new, should_build, should_submit, needs_reconcile, claim_token, merchant_data)`

[Baseline L4305](../../../supabase/migrations/00001_baseline.sql#L4305). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: atimta iš `service_role`
([L9585](../../../supabase/migrations/00001_baseline.sql#L9585)) – **nebekviečiama iš kodo**;
kviečia tik `open_solidgate_pwa_purchase_v2` ([L5059](../../../supabase/migrations/00001_baseline.sql#L5059)).

V1 atidarytojas: validuoja (`p_product_slug = solidgate_pwa_product_code(offer)`, suma > 0,
`funnel_code='PWA'`, `funnel_variant='member_area'`, `session_id = 'u-<user>'`,
`oto2_addon_weekly` – `price_id` be `locale`, kiti – atvirkščiai, režimas `saved_card|hosted_form`),
paima advisory lock `solidgate:pwa:env:user:product`, pereina per vartotojo užsakymus tam
produktui: „retired“ yra `failed`+0+terminalus arba `canceled|expired|refunded`; gyvas
užsakymas privalo turėti tą pačią sumą/valiutą/kainos surišimą (`price_id` arba `locale`),
daugiau nei vienas gyvas – klaida. Ypatingas atvejis (komentaras
[L4512](../../../supabase/migrations/00001_baseline.sql#L4512)): `saved_card` režime `failed`
eilutė su **pilna** suma ir `NULL|creating` statusu nėra terminalus atmetimas – ji vėl
padaroma `pending`+`creating` su nauja nuoma ir `needs_reconcile = TRUE`. Naujam užsakymui
`attempt = max + 1`, `solidgate_payment_status = 'creating'`, `submission_token = p_claim_token`.
Upsert'ina būseną (`claim_kind` pagal režimą), pasenusią būseną perrašo ir išvalo
`merchant_data`/`last_result_*`; jei užsakymas jau turi tiekėjo rezultatą, nuomą nuima.
Perėmimo taisyklės: `hosted_form` be `merchant_data` – po 30 s arba be `claim_kind`;
`saved_card` – be `claim_kind` arba po 120 s, ir tada tik `needs_reconcile`.

Klaidos: `22023 'invalid canonical Solidgate PWA purchase binding'`;
`22023 'invalid Solidgate PWA add-on price binding'`;
`22023 'invalid Solidgate PWA library locale binding'`;
`23514 'existing Solidgate PWA order binding mismatch'`;
`23514 'invalid existing Solidgate PWA order id'`;
`23514 'current Solidgate PWA order binding mismatch'`;
`23505 'multiple payable or uncertain Solidgate PWA orders already exist'`;
`22003 'Solidgate PWA purchase attempt exhausted'`;
`23514 'existing Solidgate PWA purchase mode or offer mismatch'`.
Rašo `orders`, `solidgate_pwa_purchase_states`. Testas:
[`solidgate_payment_identity.sql#L92`](../../../supabase/tests/solidgate_payment_identity.sql#L92) (ACL).

### `open_solidgate_pwa_purchase_v2(..., p_claim_token UUID, p_customer_email TEXT, p_checkout_locale TEXT, p_solidgate_product_id TEXT, p_solidgate_payment_action TEXT) RETURNS TABLE (... + bound_customer_email, bound_checkout_locale, bound_solidgate_product_id, bound_solidgate_payment_action ...)`

[Baseline L4779](../../../supabase/migrations/00001_baseline.sql#L4779). Pirmi devyni parametrai
kaip v1. Deklaracija: `plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Identiteto atidarytojas, kurį **kviečia TypeScript**. Validuoja el. paštą/locale,
`solidgate_product_id` ⇔ `price_id` metaduomenyse, `payment_action` tik `auth_settle`; nustato
tuos pačius GUC kaip pagrindinis v2; užrakina būseną ir jos užsakymą: gyvam užsakymui griežtai
lygina nuotrauką (įskaitant identitetą), pakartoja v1 „adoptuoto failed“ ir nuomos perėmimo
logiką (`hosted_form` – 30 s arba tas pats `claim_token`, `saved_card` – 120 s); jei būsenos
nėra arba užsakymas retired – deleguoja v1. Pabaigoje `FOR SHARE` patikrina, kad įrašytas
identitetas nėra legacy.

Klaidos: `22023 'invalid Solidgate PWA checkout identity'`;
`22023 'invalid Solidgate PWA provider product identity'`;
`22023 'invalid Solidgate PWA payment action'`;
`23514 'existing Solidgate PWA purchase snapshot mismatch'`;
`23514 'legacy Solidgate PWA checkout identity requires provider reconciliation'`; plius v1 ir
`guard_solidgate_pwa_payable_order` klaidos. Rašo `orders`, `solidgate_pwa_purchase_states`.
Kvietėjas: [`purchase/route.ts#L811`](../../../apps/pwa/src/app/api/solidgate/purchase/route.ts#L811).
Testai: [`solidgate_round2_concurrency.sql#L1834`](../../../supabase/tests/solidgate_round2_concurrency.sql#L1834)
(du atidarytojai serializuojasi, vienas tiekėjo id, vienas `saved_card` siuntėjas; režimo
keitimas atmetamas), [`solidgate_card_update_state.sql#L101`](../../../supabase/tests/solidgate_card_update_state.sql#L101),
[`solidgate_pwa_3ds_alias_conflict.sql#L30`](../../../supabase/tests/solidgate_pwa_3ds_alias_conflict.sql#L30).

### `finalize_solidgate_pwa_form(p_payment_environment TEXT, p_user_id UUID, p_offer_slug TEXT, p_product_slug TEXT, p_order_db_id UUID, p_solidgate_order_id TEXT, p_amount_cents INTEGER, p_currency TEXT, p_claim_token UUID, p_merchant_data JSONB) RETURNS JSONB`

[Baseline L5127](../../../supabase/migrations/00001_baseline.sql#L5127). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: atimta iš `service_role`
([L9590](../../../supabase/migrations/00001_baseline.sql#L9590)) – **nebekviečiama iš kodo**;
kviečia tik `finalize_solidgate_pwa_form_v2` ([L5326](../../../supabase/migrations/00001_baseline.sql#L5326)).

`hosted_form` režimo `merchant_data` publikavimas. Užrakina užsakymą ir būseną, tikrina
surišimą (būsena `hosted_form`, rodo į šį užsakymą). Jei `merchant_data` jau yra – grąžina jį
tik tam pačiam `claim_token` su identišku payload'u ir kol užsakymas vis dar `pending`+`creating`.
Kitaip reikalauja, kad `claim_kind = 'build_form'` ir žetonai sutaptų; įrašo `merchant_data`,
nuima nuomą ir išvalo užsakymo `submission_token` (formos kelias siuntimo nuomos nebenaudoja).

Klaidos: `22023 'invalid Solidgate PWA form finalization'`;
`23514 'Solidgate PWA form binding changed before finalization'`;
`40001 'Solidgate PWA form builder lost ownership'`;
`40001 'Solidgate PWA form order changed after finalization'`;
`40001 'Solidgate PWA form order changed during finalization'`; `INTO STRICT` – `P0002`.
Rašo `solidgate_pwa_purchase_states`, `orders`. Testas:
[`solidgate_round2_concurrency.sql#L2158`](../../../supabase/tests/solidgate_round2_concurrency.sql#L2158)
(pasenęs statytojas gauna `serialization_failure`, sekėjai gauna cached payload'ą).

### `finalize_solidgate_pwa_form_v2(..., p_merchant_data JSONB, p_customer_email TEXT, p_checkout_locale TEXT) RETURNS JSONB`

[Baseline L5284](../../../supabase/migrations/00001_baseline.sql#L5284). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Kaip pagrindinio checkout v2: `FOR SHARE` patikrina identitetą (ne legacy, el. paštas ir locale
sutampa) ir deleguoja v1. Klaida: `23514 'Solidgate PWA checkout identity changed before finalization'`;
`INTO STRICT` – `P0002`. Kvietėjas:
[`purchase/route.ts#L891`](../../../apps/pwa/src/app/api/solidgate/purchase/route.ts#L891).
Testai: [`solidgate_payment_identity.sql#L277`](../../../supabase/tests/solidgate_payment_identity.sql#L277),
[`solidgate_card_update_state.sql#L101`](../../../supabase/tests/solidgate_card_update_state.sql#L101).

### `record_solidgate_pwa_submission_result(p_payment_environment TEXT, p_user_id UUID, p_offer_slug TEXT, p_product_slug TEXT, p_order_db_id UUID, p_solidgate_order_id TEXT, p_amount_cents INTEGER, p_currency TEXT, p_claim_token UUID, p_result_kind TEXT, p_provider_status TEXT, p_net_amount_cents INTEGER, p_subscription_id TEXT, p_verify_url TEXT) RETURNS BOOLEAN`

[Baseline L5341](../../../supabase/migrations/00001_baseline.sql#L5341). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

`saved_card` režimo rezultato publikavimas po `/recurring` atsakymo. `p_result_kind` ∈
`pending|requires_action|captured|terminal_failure`, o kiekvienam griežtos sąlygos:
`terminal_failure` – statusas `auth_failed|declined|void_ok|request_rejected`, neto 0, be
prenumeratos ir be URL (`request_rejected` leidžiamas tik iš maršruto claim-fenced
„tiekėjas užsakymo neturi“ šakos, komentaras [L5397](../../../supabase/migrations/00001_baseline.sql#L5397));
`captured` – `settle_ok|partial_settled`, neto = bruto, `oto2_addon_weekly` privalo turėti
`subscription_id`, kiti – ne; `requires_action` – `created|processing|auth_ok|3ds_verify` su
`https://` `verify_url` (komentaras [L5425](../../../supabase/migrations/00001_baseline.sql#L5425):
`/recurring` gali grąžinti `verify_url` dar prieš `3ds_verify`); `pending` – tie patys statusai
plius `partial_settled`, be URL (`3ds_verify` be URL yra teisėtas fail-closed stebėjimas, kuris
išvalo cached ACS URL, [L5437](../../../supabase/migrations/00001_baseline.sql#L5437)). Po lock
užrakina užsakymą ir būseną; jei kurio nėra – `FALSE`. Idempotencija: tas pats savininkas su
identišku jau įrašytu rezultatu gauna `TRUE`, jei užsakymas vis dar tiksliai tą rezultatą
atspindi. Kitaip reikalauja `pending`+`creating` su sutampančiu žetonu ir `claim_kind ∈
submit_card|reconcile`, atnaujina užsakymą (terminalui – `failed`, `amount_cents = 0`, bruto
lieka `solidgate_original_amount_cents`) ir būseną (`last_result_*`, nuoma nuimama).

Klaidos: `22023 'invalid Solidgate PWA submission result'`;
`22023 'invalid terminal Solidgate PWA submission result'`;
`22023 'invalid captured Solidgate PWA submission result'`;
`22023 'invalid actionable Solidgate PWA submission result'`;
`22023 'invalid pending Solidgate PWA submission result'`;
`23514 'Solidgate PWA submission result binding mismatch'`;
`40001 'Solidgate PWA result fence changed during publication'`.
Rašo `orders`, `solidgate_pwa_purchase_states`. Kvietėjas:
[`purchase/route.ts#L937`](../../../apps/pwa/src/app/api/solidgate/purchase/route.ts#L937).
Testai: [`solidgate_round2_concurrency.sql#L2017`](../../../supabase/tests/solidgate_round2_concurrency.sql#L2017)
(nenulinis terminalus rezultatas, `request_rejected` su prenumerata arba URL atmetami –
[`#L2050`](../../../supabase/tests/solidgate_round2_concurrency.sql#L2050)),
[`solidgate_pwa_3ds_alias_conflict.sql#L57`](../../../supabase/tests/solidgate_pwa_3ds_alias_conflict.sql#L57),
[`solidgate_payment_identity.sql#L422`](../../../supabase/tests/solidgate_payment_identity.sql#L422).

### `resume_solidgate_pwa_submission_after_absent_reconcile(p_payment_environment TEXT, p_user_id UUID, p_offer_slug TEXT, p_product_slug TEXT, p_order_db_id UUID, p_solidgate_order_id TEXT, p_amount_cents INTEGER, p_currency TEXT, p_claim_token UUID) RETURNS BOOLEAN`

[Baseline L5584](../../../supabase/migrations/00001_baseline.sql#L5584). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

PWA atitikmuo OTO `resume`: po `needs_reconcile`, kai Solidgate patvirtino užsakymo nebuvimą,
perjungia būsenos `claim_kind` iš `reconcile` į `submit_card` (tik tam pačiam žetonui, nuoma
jaunesnė nei 120 s) ir atnaujina užsakymo `submission_started_at`. `FALSE`, jei fence
nesutampa. Klaidos: `22023 'invalid Solidgate PWA reconcile claim'`;
`23514 'Solidgate PWA reconcile binding mismatch'`;
`40001 'Solidgate PWA reconcile fence changed during resume'`. Rašo
`solidgate_pwa_purchase_states`, `orders`. Kvietėjas:
[`purchase/route.ts#L1066`](../../../apps/pwa/src/app/api/solidgate/purchase/route.ts#L1066).
Testas: [`solidgate_round2_concurrency.sql#L1995`](../../../supabase/tests/solidgate_round2_concurrency.sql#L1995).

### `record_solidgate_pwa_confirmed_capture(p_payment_environment TEXT, p_user_id UUID, p_offer_slug TEXT, p_product_slug TEXT, p_order_db_id UUID, p_solidgate_order_id TEXT, p_amount_cents INTEGER, p_currency TEXT, p_provider_status TEXT, p_subscription_id TEXT) RETURNS TEXT`

[Baseline L5717](../../../supabase/migrations/00001_baseline.sql#L5717). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Publikuoja patvirtintą capture į būsenų lentelę, kad `confirm` maršrutas ir webhook'as
sutartų, kuriuo režimu užsakymas buvo apmokėtas. Grąžina `'saved_card'`, `'hosted_form'`,
`'stale'` (būsena jau rodo į **griežtai naujesnį** to paties produkto užsakymą) arba
`'invalid'` (užsakymo/būsenos nėra, `last_result_*` prieštarauja). Prieš tai užsakymas turi
būti kanoniškas (`solidgate_checkout_core_is_canonical`), be grąžinimų/chargeback, su
`settle_ok|partial_settled`, statusu `active` (prenumerata) arba `completed`, o
`tracking_metadata.price_id` lygus `solidgate_product_id`. `saved_card` režime įrašo
`last_result_kind = 'captured'` tik iš `NULL|pending|requires_action|terminal_failure`;
`hosted_form` reikalauja `merchant_data` ir įrašo `captured` tik iš `NULL`.

Klaidos: `22023 'invalid confirmed Solidgate PWA capture'`;
`23514 'confirmed Solidgate PWA capture binding mismatch'`;
`23514 'confirmed Solidgate PWA state binding mismatch'`;
`23514 'confirmed Solidgate PWA current state is not newer'`.
Rašo `solidgate_pwa_purchase_states`. Kvietėjai:
[`purchase/confirm/route.ts#L939`](../../../apps/pwa/src/app/api/solidgate/purchase/confirm/route.ts#L939),
[`index.ts#L2689`](../../../supabase/functions/solidgate-webhooks/index.ts#L2689). Testai:
[`solidgate_payment_identity.sql#L290`](../../../supabase/tests/solidgate_payment_identity.sql#L290)
(identiškas replay idempotentiškas, kitokia suma ir grąžinta eilutė – `check_violation`,
senesnis užsakymas prie naujesnės būsenos – `stale`),
[`solidgate_card_update_state.sql#L136`](../../../supabase/tests/solidgate_card_update_state.sql#L136).

## Teisės (entitlements)

Visi grantai yra `SECURITY INVOKER` (`service_role` turi teises į `entitlements` ir `orders`)
ir grąžina `BOOLEAN`: `FALSE` reiškia „užsakymas dar/jau netinkamas“, ne klaidą – kviečiantysis
bando vėliau. Kiekvienas INSERT/UPDATE į `entitlements` papildomai praeina
`prevent_solidgate_entitlement_replay` ir `enqueue_solidgate_subscription_token_sync_from_entitlement`
trigger'ius.

### `solidgate_special_free_card_ready(p_order_id UUID) RETURNS BOOLEAN`

[Baseline L6241](../../../supabase/migrations/00001_baseline.sql#L6241). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Zero-auth `special_free` (`auth_0_amount`, suma 0, `auth_ok`, `trialing|active|past_due`,
yra `solidgate_subscription_id` ir `solidgate_card_source_sequence`) prieigos sargas: `TRUE`
tik jei sesijos saugykloje yra **daugkartinis** žetonas (`card_original_payment_method ∈
card|apple-pay|google-pay|network-token`; `click-to-pay` neužtenka), kurio šaltinis yra šis
užsakymas arba naujesnis kanoniškas pagrindinis užsakymas (`settle_ok|partial_settled` pilna
suma, dalinis refund arba kitas zero-auth). Klaidų nekelia; `NULL`/neradus – `FALSE`. Nerašo
(užrakina `FOR SHARE`). Kvietėjai:
[`grant/route.ts#L699`](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L699),
[`index.ts#L1959`](../../../supabase/functions/solidgate-webhooks/index.ts#L1959),
[`index.ts#L2789`](../../../supabase/functions/solidgate-webhooks/index.ts#L2789); SQL viduje –
`prevent_solidgate_entitlement_replay`, `grant_solidgate_main_entitlement`
([L6428](../../../supabase/migrations/00001_baseline.sql#L6428)). Testas:
[`solidgate_token_origin_payment_type.sql#L323`](../../../supabase/tests/solidgate_token_origin_payment_type.sql#L323)
(Click to Pay ir trūkstama kilmė netenkina, Apple Pay – tenkina).

### `grant_solidgate_main_entitlement(p_payment_environment TEXT, p_order_id UUID, p_user_id UUID, p_product_slug TEXT, p_subscription_id TEXT, p_amount_cents INTEGER, p_fallback_expires_at TIMESTAMPTZ) RETURNS BOOLEAN`

[Baseline L6363](../../../supabase/migrations/00001_baseline.sql#L6363). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

Pagrindinės prenumeratos (`p_product_slug = 'BRAND_000000_SUB'`) teisės suteikimas. Užsakymas
(`FOR UPDATE`) turi būti `completed|trialing|active`, be grąžinimų/chargeback/`void_ok`, su
sutampančia suma ir `solidgate_subscription_id`, statusu `settle_ok|partial_settled` (arba
`auth_ok` su suma 0); zero-auth `special_free` papildomai – `solidgate_special_free_card_ready`.
Jei užsakymas dar be `user_id` – prisiskiria jį ir `claimed_at`; kitas vartotojas – `FALSE`.
Esamą teisę perrašo tik jei jos užsakymas senesnis (`created_at`); tas pats užsakymas –
idempotentiškas `TRUE`. Įrašo `access_level = 'full'`, `status = 'active'`,
`source = 'solidgate_grant'`, `expires_at = p_fallback_expires_at`.

Klaida: `22023 'invalid Solidgate main entitlement grant'`. Rašo `entitlements`, `orders`
(`user_id`, `claimed_at`). Kvietėjai:
[`grant/route.ts#L1527`](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1527),
[`index.ts#L1051`](../../../supabase/functions/solidgate-webhooks/index.ts#L1051),
[`entitlement-backfill.ts#L70` `backfillOrderEntitlement()`](../../../packages/shared/src/auth/entitlement-backfill.ts#L70)
(iš [`verify-otp.ts#L182`](../../../packages/shared/src/auth/verify-otp.ts#L182) ir
[`claim-purchase.ts#L126`](../../../packages/shared/src/auth/claim-purchase.ts#L126)). Testai:
[`solidgate_subscription_renewals.sql#L133`](../../../supabase/tests/solidgate_subscription_renewals.sql#L133),
[`solidgate_round2_concurrency.sql#L1467`](../../../supabase/tests/solidgate_round2_concurrency.sql#L1467).

### `grant_solidgate_oto_entitlement(p_payment_environment TEXT, p_order_db_id UUID, p_user_id UUID, p_product_slug TEXT, p_access_level TEXT, p_expires_at TIMESTAMPTZ, p_solidgate_subscription_id TEXT, p_source TEXT) RETURNS BOOLEAN`

[Baseline L6534](../../../supabase/migrations/00001_baseline.sql#L6534). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

OTO produkto teisė. Užsakymas turi būti pilnai kanoniškas OTO užsakymas (žingsniai iš
`product_slug` ir `solidgate_order_id` sutampa, metaduomenys, ne legacy identitetas,
`auth_settle`), o **vietinis neto lygus nekintamam bruto** (`amount_cents =
solidgate_original_amount_cents`, `refunded = 0`, komentaras
[L6626](../../../supabase/migrations/00001_baseline.sql#L6626)) – tai atmeta under-capture ir
bet kokį refund'ą prieš vėluojantį naršyklės atsakymą. `BRANDADDON_000000_SUB` (pasikartojantis
priedas): `trialing|active`, `auth_ok|settle_ok|partial_settled`, `access_level = 'trial'`,
privalomi `expires_at` ir sutampantis `subscription_id`; kiti: `completed`,
`settle_ok|partial_settled`, `full`, be prenumeratos ir be `expires_at`. Tas pats užsakymas
– užpildo tik `NULL` laukus (`expires_at`, `source`, `subscription_id`) ir niekada neatstato
`canceled`/`past_due` (komentaras [L6730](../../../supabase/migrations/00001_baseline.sql#L6730));
kitas užsakymas – perrašo tik jei esamas senesnis pagal `(created_at, id)`.

Klaida: `22023 'invalid Solidgate OTO entitlement grant'`. Rašo `entitlements`, `orders`
(`user_id`, `claimed_at`). Kvietėjai:
[`charge-oto/route.ts#L1767`](../../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L1767),
[`index.ts#L1061`](../../../supabase/functions/solidgate-webhooks/index.ts#L1061).
SQL testų nėra (tik `charge-oto-attribution.test.ts`, `charge-oto-replay.test.ts` mock'ai).

### `grant_solidgate_pwa_entitlement(p_payment_environment TEXT, p_order_db_id UUID, p_user_id UUID, p_product_slug TEXT, p_access_level TEXT, p_expires_at TIMESTAMPTZ, p_solidgate_subscription_id TEXT, p_source TEXT) RETURNS BOOLEAN`

[Baseline L6798](../../../supabase/migrations/00001_baseline.sql#L6798). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

Member-area pirkimo teisė: `p_access_level` tik `'full'`; užsakymas – PWA (`session_id IS NULL`,
`funnel_code='PWA'`, `funnel_variant='member_area'`), ne legacy, neto = bruto > 0, `refunded = 0`,
`settle_ok|partial_settled`, be chargeback. `BRANDADDON_000000_SUB`: `active`, su
`solidgate_product_id`, `price_id`, `subscription_id`, `expires_at`; kiti: `completed`, be
`product_id`/prenumeratos/`expires_at`. Toliau – ta pati „tas pats užsakymas užpildo tik
`NULL`, naujesnis perrašo“ logika kaip OTO.

Klaida: `22023 'invalid Solidgate PWA entitlement grant'`. Rašo `entitlements`. Kvietėjai:
[`purchase/confirm/route.ts#L965`](../../../apps/pwa/src/app/api/solidgate/purchase/confirm/route.ts#L965),
[`index.ts#L1072`](../../../supabase/functions/solidgate-webhooks/index.ts#L1072). Testas:
[`solidgate_card_update_state.sql#L210`](../../../supabase/tests/solidgate_card_update_state.sql#L210).

### `apply_solidgate_subscription_entitlement_lifecycle(p_payment_environment TEXT, p_order_db_id UUID, p_user_id UUID, p_product_slug TEXT, p_solidgate_subscription_id TEXT, p_access_level TEXT, p_status TEXT, p_expires_at TIMESTAMPTZ, p_source TEXT) RETURNS TEXT`

[Baseline L6972](../../../supabase/migrations/00001_baseline.sql#L6972). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: `service_role`.

Prenumeratos gyvavimo ciklo (atnaujinimas, dunning, atsigavimas) taikymas esamai teisei.
`p_access_level ∈ full|trial|grace`, `p_status ∈ active|past_due` (`active` reikalauja
`p_expires_at`). Grąžina: `'invalid'` (užsakymas/teisė nesutampa), `'reversed'` (užsakymas
`canceled|refunded|disputed`, `void_ok`, chargeback), `'stale'` (teisė priklauso naujesniam
užsakymui: pagrindiniam – pagal `created_at`, kitiems – `(created_at, id)`),
`'lifecycle_owned'` (teisė `canceled` arba `revoked_at` – tombstone), `'applied'`. Rašydama
niekada netrumpina apmokėto laikotarpio: `active → active` ima `GREATEST(p_expires_at,
esamas)` ir neleidžia `full` virsti `trial`; atsigavimas iš `past_due` ima faktinį apmokėtą
terminą, ne grace (komentaras [L7065](../../../supabase/migrations/00001_baseline.sql#L7065)).

Klaida: `22023 'invalid Solidgate subscription lifecycle mutation'`. Rašo `entitlements`.
Kvietėjas: [`index.ts#L1146` `applySolidgateSubscriptionLifecycle()`](../../../supabase/functions/solidgate-webhooks/index.ts#L1146).
Testai: [`solidgate_subscription_renewals.sql#L105`](../../../supabase/tests/solidgate_subscription_renewals.sql#L105)
(pasibaigęs trial → pilnas apmokėtas laikotarpis, dublikatas neprideda laikotarpio, senesnis
callback'as `stale`, aplinkos nesutapimas `invalid`, tombstone `lifecycle_owned`, refund
`reversed`), [`solidgate_payment_identity.sql#L729`](../../../supabase/tests/solidgate_payment_identity.sql#L729).

## Kortelių saugyklos (session vault / account vault)

Dvi lentelės: `solidgate_session_vault` (anoniminės funnel sesijos žetonas, raktas
`(environment, session_id)`) ir `solidgate_account_vault` (prisijungusio vartotojo žetonas,
raktas `(environment, user_id)`). Abi rašomos **tik** per žemiau esančias `SECURITY DEFINER`
funkcijas, kurios nustato GUC fence trigger'iams. Monotoniškumo raktas – seka
`solidgate_card_source_sequence` ([L36](../../../supabase/migrations/00001_baseline.sql#L36)):
naujesnis šaltinis turi didesnį numerį; paskyros saugykloje dar galioja prioritetas
`card_update (3) > pwa_order (2) > main_order (1)`. Grąžinamos reikšmės: `'written'`, `'same'`
(idempotentiškas pakartojimas), `'stale'` (senesnis šaltinis), `'invalid'` (šaltinis
neįrodytas), `'missing'` (tik promote). TS apvalkalai
([`session-vault.ts`](../../../packages/shared/src/solidgate/session-vault.ts#L53),
[`account-vault.ts`](../../../packages/shared/src/solidgate/account-vault.ts#L64)) `'invalid'`
verčia į klaidą.

### `write_solidgate_session_vault_monotonic(p_payment_environment TEXT, p_session_id UUID, p_source_order_id UUID, p_customer_account_id TEXT, p_card_token TEXT, p_card_brand TEXT, p_card_last4 TEXT) RETURNS TEXT`

[Baseline L7092](../../../supabase/migrations/00001_baseline.sql#L7092). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Sesijos saugyklos rašytojas su tiksliu šaltiniu – pagrindinis užsakymas (`FOR SHARE`, ne
legacy, turi `card_source_sequence`). Šaltinis įrodytas, kai: `pending` + `auth_ok` +
`auth_settle` pilna suma (priimtas autorizavimas, kurio capture dar vyksta – leidžia OTO1
apmokėti vienu paspaudimu dar prieš settle, komentaras
[L7139](../../../supabase/migrations/00001_baseline.sql#L7139)); arba ne `pending` su
`settle_ok|partial_settled` pilna suma; arba dalinis `refunded`; arba zero-auth `auth_ok`.
Bet koks `void_ok`/chargeback – `'invalid'`. Su advisory lock `solidgate-session-vault:env:session`
užrakina esamą eilutę: tas pats šaltinis su kitu žetonu – klaida; jau turi žetoną arba
pakartojimas be žetono – `'same'`; be žetono → su žetonu – užpildo (`'written'`); senesnė ar
lygi seka – `'stale'`; kitaip upsert'ina su `card_source_legacy = FALSE`. Žetonas gali būti
`NULL` – tada įrašomas tik chronologijos watermark'as.

Klaidos: `22023 'invalid Solidgate session vault source write'`;
`23514 'same Solidgate main order returned a different session token'`; `INTO STRICT` – `P0002`.
Rašo `solidgate_session_vault`. Iš TS nekviečiama tiesiogiai (tik per `_with_method`,
[L7746](../../../supabase/migrations/00001_baseline.sql#L7746)). Testai:
[`solidgate_card_update_state.sql#L922`](../../../supabase/tests/solidgate_card_update_state.sql#L922),
[`solidgate_payment_identity.sql#L218`](../../../supabase/tests/solidgate_payment_identity.sql#L218).

### `write_solidgate_account_vault_monotonic(p_payment_environment TEXT, p_user_id UUID, p_source_kind TEXT, p_source_id UUID, p_source_claim_token UUID, p_card_token TEXT, p_card_brand TEXT, p_card_last4 TEXT) RETURNS TEXT`

[Baseline L7301](../../../supabase/migrations/00001_baseline.sql#L7301). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Paskyros saugyklos rašytojas su trimis šaltinių rūšimis: `card_update` (kortelės atnaujinimo
bandymas, būsena `applying`, `apply_token = p_source_claim_token`, žetonas privalomas);
`pwa_order` (`hosted_form` PWA užsakymas su `last_result_kind = 'captured'`, pilna arba
dalinai grąžinta suma); `main_order` (pagrindinis užsakymas su `session_id`, tie patys
įrodymai kaip sesijos saugykloje, be `pending`+`auth_ok` šakos). Su advisory lock
`solidgate-account-vault:env:user`: tas pats šaltinis su kitu žetonu – klaida; jau turi
žetoną – `'same'` ir `enqueue_solidgate_subscription_token_sync`; pakartojimas be žetono –
`fence_...` ir `'same'`; be žetono → su žetonu – užpildo, tada `enqueue`; senesnis pagal
`(sequence, priority, id)` – `'stale'` (bet vis tiek `enqueue` dabartiniam nugalėtojui);
kitaip upsert'ina ir, priklausomai nuo žetono buvimo, `fence` arba `enqueue`. Kiekvienas
kelias baigiasi prenumeratų žetono sinchronizacijos eile.

Klaidos: `22023 'invalid Solidgate account vault source write'`;
`23514 'same Solidgate vault source returned a different token'`; `INTO STRICT` – `P0002`.
Rašo `solidgate_account_vault`, per kviečiamas funkcijas –
`solidgate_subscription_token_sync_jobs`. Iš TS nekviečiama tiesiogiai; SQL viduje –
`promote_solidgate_session_vault_monotonic` ([L7698](../../../supabase/migrations/00001_baseline.sql#L7698)),
`write_solidgate_account_vault_with_method` ([L7842](../../../supabase/migrations/00001_baseline.sql#L7842)).
Testai: [`solidgate_card_update_state.sql#L198`](../../../supabase/tests/solidgate_card_update_state.sql#L198)
(šaltinių chronologija, `awaiting_token` watermark'as, tas pats šaltinis vėliau užpildo
žetoną), [`solidgate_payment_identity.sql#L338`](../../../supabase/tests/solidgate_payment_identity.sql#L338).

### `promote_solidgate_session_vault_monotonic(p_payment_environment TEXT, p_user_id UUID, p_session_id UUID) RETURNS TEXT`

[Baseline L7653](../../../supabase/migrations/00001_baseline.sql#L7653). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Perkelia sesijos saugyklos kortelę į paskyrą, kai pirkimas susiejamas su auth vartotoju.
`'missing'`, jei sesijos įrašo nėra, jis legacy arba be šaltinio, arba šaltinio užsakymas
nepriklauso `p_user_id`; kitaip kviečia `write_solidgate_account_vault_monotonic('main_order', ...)`
su sesijos žetonu (gali būti `NULL` – tada perkeliamas tik watermark'as). Klaidų pati nekelia.
Iš TS nekviečiama tiesiogiai; SQL viduje – `promote_solidgate_session_vault_with_method`
([L7917](../../../supabase/migrations/00001_baseline.sql#L7917)). Testas:
[`solidgate_card_update_state.sql#L937`](../../../supabase/tests/solidgate_card_update_state.sql#L937).

### `write_solidgate_session_vault_with_method(..., p_card_last4 TEXT, p_original_payment_method TEXT) RETURNS TEXT`

[Baseline L7711](../../../supabase/migrations/00001_baseline.sql#L7711). Pirmi septyni parametrai
kaip `_monotonic`. Deklaracija: `plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės:
`service_role`.

Apvalkalas, kuris po monotoninio rašymo dar įrašo žetono kilmę
`card_original_payment_method` (`card|apple-pay|google-pay|network-token|click-to-pay`; be
žetono kilmė neleidžiama). Kilmę rašo tik jei rezultatas `written|same`, eilutės šaltinis yra
šis užsakymas ir kilmė dar `NULL`; kitokia jau įrašyta kilmė – klaida.

Klaidos: `22023 'invalid Solidgate session token origin'`;
`23514 'Solidgate session token origin has no exact token'`;
`23514 'same Solidgate session token has conflicting origins'`. Rašo `solidgate_session_vault`.
Kvietėjai: [`session-vault.ts#L74` `upsertSessionVault()`](../../../packages/shared/src/solidgate/session-vault.ts#L74)
(iš [`grant/route.ts#L1001`](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1001) ir
[`#L1309`](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1309)),
[`index.ts#L2753`](../../../supabase/functions/solidgate-webhooks/index.ts#L2753). Testas:
[`solidgate_token_origin_payment_type.sql#L65`](../../../supabase/tests/solidgate_token_origin_payment_type.sql#L65)
(ACL), [`#L138`](../../../supabase/tests/solidgate_token_origin_payment_type.sql#L138)
(prieštaringa kilmė – `check_violation`, kilmė be žetono – `invalid_parameter_value`).

### `write_solidgate_account_vault_with_method(..., p_card_last4 TEXT, p_original_payment_method TEXT) RETURNS TEXT`

[Baseline L7805](../../../supabase/migrations/00001_baseline.sql#L7805). Pirmi aštuoni parametrai
kaip `_monotonic`. Deklaracija: `plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės:
`service_role`.

Paskyros saugyklos atitikmuo: kilmė rašoma tik eilutei su `card_source_kind:card_source_id`
lygiu paduotam šaltiniui. Klaidos: `22023 'invalid Solidgate account token origin'`;
`23514 'Solidgate account token origin has no exact token'`;
`23514 'same Solidgate account token has conflicting origins'`. Rašo `solidgate_account_vault`
(+ token sync eilė per `_monotonic`). Kvietėjai:
[`purchase/confirm/route.ts#L1008`](../../../apps/pwa/src/app/api/solidgate/purchase/confirm/route.ts#L1008)
(`pwa_order`), [`billing/update-card/route.ts#L481`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L481)
(`card_update`), [`index.ts#L2721`](../../../supabase/functions/solidgate-webhooks/index.ts#L2721).
Apvalkalas [`account-vault.ts#L64` `upsertAccountVault()`](../../../packages/shared/src/solidgate/account-vault.ts#L64)
eksportuojamas, bet ne testų kode niekur nekviečiamas. Testai:
[`solidgate_token_origin_payment_type.sql#L75`](../../../supabase/tests/solidgate_token_origin_payment_type.sql#L75)
(ACL), [`#L269`](../../../supabase/tests/solidgate_token_origin_payment_type.sql#L269).

### `promote_solidgate_session_vault_with_method(p_payment_environment TEXT, p_user_id UUID, p_session_id UUID) RETURNS TEXT`

[Baseline L7902](../../../supabase/migrations/00001_baseline.sql#L7902). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Kviečia `promote_solidgate_session_vault_monotonic`, tada perkelia sesijos žetono kilmę į
paskyros eilutę `main_order:<order_id>` (tik jei ten kilmė `NULL`; kitokia – klaida). Klaidos:
`23514 'Solidgate promoted token origin has no exact token'`;
`23514 'promoted Solidgate token has conflicting origins'`. Rašo `solidgate_account_vault`.
Kvietėjai: [`account-vault.ts#L120` `promoteSessionVaultToAccount()`](../../../packages/shared/src/solidgate/account-vault.ts#L120)
(iš [`grant/route.ts#L1456`](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1456),
[`verify-otp.ts#L196`](../../../packages/shared/src/auth/verify-otp.ts#L196),
[`claim-purchase.ts#L47`](../../../packages/shared/src/auth/claim-purchase.ts#L47) ir
[`#L138`](../../../packages/shared/src/auth/claim-purchase.ts#L138)),
[`index.ts#L1322`](../../../supabase/functions/solidgate-webhooks/index.ts#L1322). Testas:
[`solidgate_token_origin_payment_type.sql#L242`](../../../supabase/tests/solidgate_token_origin_payment_type.sql#L242)
(kilmė išgyvena saugų perkėlimą).

### `clear_solidgate_legacy_session_vault(p_payment_environment TEXT, p_session_id UUID) RETURNS BOOLEAN`

[Baseline L7981](../../../supabase/migrations/00001_baseline.sql#L7981). Deklaracija:
`plpgsql`, `SECURITY INVOKER`, `search_path = ''`. Teisės: atimta iš `service_role`
([L9642](../../../supabase/migrations/00001_baseline.sql#L9642)) – **operatoriaus įrankis,
iš kodo nekviečiama**.

Vienintelis būdas išvalyti legacy (`card_source_legacy = TRUE`) sesijos žetoną: nustato fence
`app.solidgate_session_vault_source_write = 'operator-clear:<session_id>'`, kurį
`guard_solidgate_session_vault_card_source` priima tik su visiškai tuščiu tikslu, ir nunulina
žetoną bei šaltinį. Grąžina, ar buvo eilutė. Klaida:
`22023 'invalid Solidgate legacy session-vault clear'`. Rašo `solidgate_session_vault`. Testai:
[`solidgate_card_update_state.sql#L1006`](../../../supabase/tests/solidgate_card_update_state.sql#L1006),
[`solidgate_payment_identity.sql#L107`](../../../supabase/tests/solidgate_payment_identity.sql#L107) (ACL).

## Kortelės atnaujinimas (`solidgate_card_update_attempts`)

Zero-auth kortelės pakeitimo būsenų mašina member area, srautas
[`apps/pwa/src/app/api/solidgate/billing/update-card/route.ts`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts).
Lentelė `service_role` neprieinama ([L1242](../../../supabase/migrations/00001_baseline.sql#L1242)),
todėl visos septynios funkcijos yra `SECURITY DEFINER` ir suteiktos `service_role`. Būsenos:
`building → issued → applying → completed | failed`; `is_current` žymi naujausią bandymą – senas
grįžimo URL negali perrašyti prenumeratos (lentelės komentaras
[L1245](../../../supabase/migrations/00001_baseline.sql#L1245)). Užsakymo id formatas
`u-<user>:card_update:<n>`. Visus scenarijus pina
[`solidgate_card_update_state.sql`](../../../supabase/tests/solidgate_card_update_state.sql#L69).

### `open_solidgate_card_update_attempt(p_payment_environment TEXT, p_user_id UUID, p_candidate_order_id TEXT, p_customer_email TEXT, p_checkout_locale TEXT, p_builder_token UUID) RETURNS TABLE (attempt_id UUID, solidgate_order_id TEXT, bound_customer_email TEXT, bound_checkout_locale TEXT, attempt_state TEXT, merchant_data JSONB, is_new BOOLEAN, should_build BOOLEAN)`

[Baseline L8029](../../../supabase/migrations/00001_baseline.sql#L8029). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Su advisory lock `solidgate-card-update:env:user` užrakina dabartinį bandymą. Jei jis
`building|issued|applying` – grąžina jį (`is_new = FALSE`); `building` su nuoma senesne nei
30 s perimamas (`should_build = TRUE`). Kitaip (nėra, `completed`, `failed`) sena eilutė
pažymima `is_current = FALSE` ir įterpiamas naujas `building` bandymas su normalizuotu el.
paštu ir locale. Klaida: `22023 'invalid Solidgate card-update attempt binding'`. Rašo
`solidgate_card_update_attempts`. Kvietėjas:
[`update-card/route.ts#L547`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L547).

### `finalize_solidgate_card_update_attempt(p_payment_environment TEXT, p_user_id UUID, p_attempt_id UUID, p_solidgate_order_id TEXT, p_builder_token UUID, p_merchant_data JSONB) RETURNS BOOLEAN`

[Baseline L8163](../../../supabase/migrations/00001_baseline.sql#L8163). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

`building → issued` su `merchant_data`. Idempotentiška: `issued` su identišku payload'u –
`TRUE`; kitas statytojas arba kita būsena – `FALSE`. Klaidos:
`22023 'invalid Solidgate card-update merchant data'`; `INTO STRICT` – `P0002`. Rašo
`solidgate_card_update_attempts`. Kvietėjas:
[`update-card/route.ts#L600`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L600).

### `claim_solidgate_card_update_attempt(p_payment_environment TEXT, p_user_id UUID, p_solidgate_order_id TEXT, p_apply_token UUID) RETURNS TEXT`

[Baseline L8214](../../../supabase/migrations/00001_baseline.sql#L8214). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Grįžus iš Solidgate formos, užima bandymą taikymui: `'rejected'` (nėra, ne `is_current`,
`failed` arba dar `building`), `'completed'`, `'busy'` (kitas `apply_token` jaunesnis nei
30 s), kitaip `applying` su `p_apply_token` ir `'acquired'`. Klaida:
`22023 'missing Solidgate card-update apply token'`. Rašo `solidgate_card_update_attempts`.
Kvietėjas: [`update-card/route.ts#L448`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L448).
Testas: senas URL grąžina `rejected` –
[`solidgate_card_update_state.sql#L445`](../../../supabase/tests/solidgate_card_update_state.sql#L445).

### `get_solidgate_card_update_attempt(p_payment_environment TEXT, p_user_id UUID, p_solidgate_order_id TEXT) RETURNS TABLE (attempt_id UUID, bound_customer_email TEXT, bound_checkout_locale TEXT, source_created_at TIMESTAMPTZ, attempt_state TEXT, is_current BOOLEAN)`

[Baseline L8266](../../../supabase/migrations/00001_baseline.sql#L8266). Deklaracija: `sql`,
`STABLE`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Vienintelis skaitymo kelias į lentelę – maršrutas pagal grįžimo URL užsakymo id gauna
bandymo identitetą ir būseną. Klaidų nekelia, nerašo. Kvietėjas:
[`update-card/route.ts#L359`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L359).

### `release_solidgate_card_update_attempt(p_payment_environment TEXT, p_user_id UUID, p_solidgate_order_id TEXT, p_apply_token UUID, p_provider_status TEXT) RETURNS BOOLEAN`

[Baseline L8297](../../../supabase/migrations/00001_baseline.sql#L8297). Deklaracija: `sql`,
`SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

`applying → issued` (taikymas nepavyko laikinai), tik su sutampančiu `apply_token`; įrašo
`last_provider_status`. Grąžina `TRUE`/`NULL` (be eilutės – `NULL`, ne `FALSE`). Klaidų nekelia.
Rašo `solidgate_card_update_attempts`. Kvietėjas:
[`update-card/route.ts#L469`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L469).

### `complete_solidgate_card_update_attempt(p_payment_environment TEXT, p_user_id UUID, p_solidgate_order_id TEXT, p_apply_token UUID, p_provider_status TEXT) RETURNS BOOLEAN`

[Baseline L8324](../../../supabase/migrations/00001_baseline.sql#L8324). Deklaracija: `sql`,
`SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

`applying → completed` su `completed_at`, tik su sutampančiu `apply_token`. Klaidų nekelia.
Rašo `solidgate_card_update_attempts`. Kvietėjas:
[`update-card/route.ts#L504`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L504)
(po sėkmingo `write_solidgate_account_vault_with_method('card_update', ...)`).

### `record_solidgate_card_update_attempt_status(p_payment_environment TEXT, p_user_id UUID, p_solidgate_order_id TEXT, p_provider_status TEXT, p_terminal BOOLEAN DEFAULT FALSE) RETURNS BOOLEAN`

[Baseline L8352](../../../supabase/migrations/00001_baseline.sql#L8352). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Įrašo tiekėjo statusą į `issued|applying` bandymą; su `p_terminal = TRUE` pažymi `failed` ir
nunulina abi nuomas. Grąžina `FOUND`. Klaidų nekelia. Rašo `solidgate_card_update_attempts`.
Kvietėjas: [`update-card/route.ts#L408`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L408).
SQL testų nėra (tik `update-card/route.test.ts` mock'ai).

## Tokenų sinchronizacija (`solidgate_subscription_token_sync_jobs`)

Kai paskyros saugykloje atsiranda naujesnė kortelė, kiekviena gyva („billable“) Solidgate
prenumerata turi būti perjungta į tą žetoną per Solidgate API. Eilė yra „newest generation“:
vienas darbas per `(environment, user, subscription)`, `desired_source_*` visada rodo į
naujausią įrodytą šaltinį, būsenos `pending|processing|failed|awaiting_token|applied`.
Lentelė `service_role` neprieinama ([L1287](../../../supabase/migrations/00001_baseline.sql#L1287)).
Worker'is – [`subscription-token-sync.ts` `drainSolidgateSubscriptionTokenSync()`](../../../packages/shared/src/solidgate/subscription-token-sync.ts#L171),
kurį paleidžia [`grant/route.ts#L1605`](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1605),
[`purchase/confirm/route.ts#L173`](../../../apps/pwa/src/app/api/solidgate/purchase/confirm/route.ts#L173),
[`update-card/route.ts#L155`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L155)
ir [`internal/solidgate-fulfillment/route.ts#L27`](../../../apps/funnel/src/app/api/internal/solidgate-fulfillment/route.ts#L27).
Visus scenarijus pina [`solidgate_card_update_state.sql`](../../../supabase/tests/solidgate_card_update_state.sql#L84).

### `solidgate_subscription_token_sync_is_billable(p_payment_environment TEXT, p_user_id UUID, p_solidgate_subscription_id TEXT) RETURNS BOOLEAN`

[Baseline L8382](../../../supabase/migrations/00001_baseline.sql#L8382). Deklaracija: `sql`,
`STABLE`, `SECURITY DEFINER`, `search_path = ''`. Teisės: atimta iš `service_role`
([L9665](../../../supabase/migrations/00001_baseline.sql#L9665)) – tik SQL viduje.

`TRUE`, jei yra gyva teisė (`active|past_due`, ne revoked) su šia prenumerata, kurios
užsakymas irgi `trialing|active|past_due`, ne legacy, kanoniškas
(`solidgate_checkout_core_is_canonical`), be `void_ok`/chargeback (dalinis refund išlaiko
billable, komentaras [L8412](../../../supabase/migrations/00001_baseline.sql#L8412)). Klaidų
nekelia, nerašo. Kviečia `enqueue_...` ([L8492](../../../supabase/migrations/00001_baseline.sql#L8492)),
`fence_...` ([L8663](../../../supabase/migrations/00001_baseline.sql#L8663)),
`read_claimed_...` ([L8745](../../../supabase/migrations/00001_baseline.sql#L8745)),
`complete_...` ([L8796](../../../supabase/migrations/00001_baseline.sql#L8796)).

### `enqueue_solidgate_subscription_token_sync(p_payment_environment TEXT, p_user_id UUID) RETURNS INTEGER`

[Baseline L8421](../../../supabase/migrations/00001_baseline.sql#L8421). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: atimta iš `service_role`
([L9667](../../../supabase/migrations/00001_baseline.sql#L9667)) – tik SQL viduje.

Jei paskyros saugykloje yra žetonas (ne `legacy`), kiekvienai billable prenumeratai, kurios
užsakymo `solidgate_card_source_sequence` **griežtai mažesnis** už saugyklos seką (lygus –
perteklinis, senesnis – nurideno prenumeratą atgal, komentaras
[L8486](../../../supabase/migrations/00001_baseline.sql#L8486)), upsert'ina `pending` darbą.
`ON CONFLICT` perrašo tik jei naujas šaltinis didesnis pagal `(sequence, priority, id)`
arba tas pats šaltinis su `failed|awaiting_token` būsena; `processing` darbas išlaiko savo
`claim_token`. Grąžina paveiktų eilučių skaičių. Klaidų nekelia. Rašo
`solidgate_subscription_token_sync_jobs`. Kviečia `write_solidgate_account_vault_monotonic`
(keturios vietos, [L7506](../../../supabase/migrations/00001_baseline.sql#L7506)–[L7644](../../../supabase/migrations/00001_baseline.sql#L7644))
ir `enqueue_solidgate_subscription_token_sync_from_entitlement`
([L2353](../../../supabase/migrations/00001_baseline.sql#L2353)). Testas:
[`solidgate_card_update_state.sql#L89`](../../../supabase/tests/solidgate_card_update_state.sql#L89) (ACL).

### `fence_solidgate_subscription_token_sync_for_tokenless_source(p_payment_environment TEXT, p_user_id UUID, p_source_kind TEXT, p_source_created_at TIMESTAMPTZ, p_source_sequence BIGINT, p_source_id TEXT) RETURNS INTEGER`

[Baseline L8549](../../../supabase/migrations/00001_baseline.sql#L8549). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: atimta iš `service_role`
([L9669](../../../supabase/migrations/00001_baseline.sql#L9669)) – tik SQL viduje.

Kai naujesnis šaltinis (`main_order|pwa_order`) įrodytas, bet žetono dar nėra, ši funkcija
apsaugo nuo senesnio worker'io: visus vartotojo darbus su šaltiniu ≤ šio pažymi
`awaiting_token` ir nuima `claim_token` (dabar apdorojantis worker'is prarandą fence), o
trūkstamiems billable prenumeratoms įterpia `awaiting_token` darbus. Veikia tik jei
saugykloje tikrai yra būtent toks be-žetono šaltinis. Grąžina pakeistų + įterptų skaičių.
Klaidų nekelia. Rašo `solidgate_subscription_token_sync_jobs`. Kviečia
`write_solidgate_account_vault_monotonic` ([L7516](../../../supabase/migrations/00001_baseline.sql#L7516),
[L7635](../../../supabase/migrations/00001_baseline.sql#L7635)) ir
`enqueue_solidgate_subscription_token_sync_from_entitlement`
([L2344](../../../supabase/migrations/00001_baseline.sql#L2344)). Testas: README aprašyta
lenktynė – naujesnis šaltinis be žetono atominiu būdu užtveria seną worker'į
([`supabase/tests/README.md#L184`](../../../supabase/tests/README.md#L184)).

### `claim_solidgate_subscription_token_sync(p_payment_environment TEXT, p_limit INTEGER DEFAULT 10, p_lease_seconds INTEGER DEFAULT 300, p_user_id UUID DEFAULT NULL) RETURNS SETOF public.solidgate_subscription_token_sync_jobs`

[Baseline L8675](../../../supabase/migrations/00001_baseline.sql#L8675). Deklaracija: `sql`,
`SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Outbox claim kaip kiti, bet: neima `awaiting_token` darbų, nuoma bent 180 s, galima
apriboti vienu `p_user_id` (maršrutai po savo veiksmo nusausina tik savo vartotoją), limitas
`1..50`, kiekvienam darbui naujas `claim_token`. Klaidų nekelia. Rašo
`solidgate_subscription_token_sync_jobs`. Kvietėjas:
[`subscription-token-sync.ts#L184`](../../../packages/shared/src/solidgate/subscription-token-sync.ts#L184).

### `read_claimed_solidgate_subscription_token_sync(p_payment_environment TEXT, p_user_id UUID, p_solidgate_subscription_id TEXT, p_claim_token UUID) RETURNS TABLE (desired_source_kind TEXT, desired_source_created_at TIMESTAMPTZ, desired_source_sequence BIGINT, desired_source_id TEXT, card_token TEXT, subscription_is_billable BOOLEAN)`

[Baseline L8720](../../../supabase/migrations/00001_baseline.sql#L8720). Deklaracija: `sql`,
`STABLE`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Worker'iui grąžina žetoną **tik** jei darbas vis dar `processing` su jo `claim_token` ir
paskyros saugykla vis dar rodo į tiksliai tą patį `desired_source_*` su nepanaudotu tuščiu
žetonu – t. y. žetonas skaitomas per fence, ne iš atminties. Kartu grąžina, ar prenumerata
tebėra billable. Klaidų nekelia, nerašo. Kvietėjas:
[`subscription-token-sync.ts#L67`](../../../packages/shared/src/solidgate/subscription-token-sync.ts#L67).
Testas: [`solidgate_card_update_state.sql#L293`](../../../supabase/tests/solidgate_card_update_state.sql#L293).

### `complete_solidgate_subscription_token_sync(p_payment_environment TEXT, p_user_id UUID, p_solidgate_subscription_id TEXT, p_claim_token UUID, p_desired_source_kind TEXT, p_desired_source_id TEXT, p_require_nonbillable BOOLEAN DEFAULT FALSE) RETURNS BOOLEAN`

[Baseline L8766](../../../supabase/migrations/00001_baseline.sql#L8766). Deklaracija: `sql`,
`SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

`processing → applied` tik su sutampančiu `claim_token` **ir** sutampančiu norimu šaltiniu
(jei tuo metu `fence`/`enqueue` pakeitė šaltinį – `NULL`, darbas lieka naujam nugalėtojui).
`p_require_nonbillable = TRUE` leidžia „užbaigti“ kaip nebereikalingą tik jei prenumerata
tikrai nebe billable (worker'is negali našlaičiu palikti gyvos prenumeratos). Klaidų nekelia.
Rašo `solidgate_subscription_token_sync_jobs`. Kvietėjas:
[`subscription-token-sync.ts#L83`](../../../packages/shared/src/solidgate/subscription-token-sync.ts#L83).
Testas: [`solidgate_card_update_state.sql#L355`](../../../supabase/tests/solidgate_card_update_state.sql#L355).

### `fail_solidgate_subscription_token_sync(p_payment_environment TEXT, p_user_id UUID, p_solidgate_subscription_id TEXT, p_claim_token UUID, p_desired_source_kind TEXT, p_desired_source_id TEXT, p_last_error TEXT) RETURNS BOOLEAN`

[Baseline L8805](../../../supabase/migrations/00001_baseline.sql#L8805). Deklaracija: `sql`,
`SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

`processing → failed` su tuo pačiu fence; `next_attempt_at` – eksponentinis atidėjimas
`5 * 2^min(attempts, 8)` s, ne daugiau 1800 s; `last_error` apkarpomas iki 2000 simbolių.
Klaidų nekelia. Rašo `solidgate_subscription_token_sync_jobs`. Kvietėjas:
[`subscription-token-sync.ts#L103`](../../../packages/shared/src/solidgate/subscription-token-sync.ts#L103).

## Intro ribojimas (`solidgate_intro_claims`)

Vienas intro pasiūlymas vienam el. paštui (`email_hash` – SHA-256 iš
[`intro-offer.ts`](../../../packages/shared/src/solidgate/intro-offer.ts#L2)). Lentelė turi
`(environment, email_hash)` unikalumą; funkcijos `SECURITY DEFINER`, suteiktos `service_role`.
Scenarijus pina [`solidgate_intro_claims.sql`](../../../supabase/tests/solidgate_intro_claims.sql#L18)
(šis testas commit'ina fikstūras ir nepakartojamas be DB reset).

### `claim_solidgate_intro_offer(p_payment_environment TEXT, p_email_hash TEXT, p_session_id UUID, p_tier TEXT) RETURNS TEXT`

[Baseline L8841](../../../supabase/migrations/00001_baseline.sql#L8841). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Prieš `open_solidgate_main_checkout_v2` rezervuoja el. paštą sesijai ir tier'ui. Grąžina:
`'already_used'` (`state = 'consumed'`), `'claimed'` (naujas įrašas arba re-key), `'retry'`
(ta pati sesija ir tier), `'in_progress'` (kita sesija/tier, o esamos sesijos užsakymas jau
„pajudino pinigus“). Pinigų klausimas yra vienintelis blokas (komentaras
[L8895](../../../supabase/migrations/00001_baseline.sql#L8895)): blokuoja užsakymas, kurio
`status` ne `pending|failed`, arba `pending` su `auth_ok|3ds_verify|processing|settle_ok|partial_settled`.
Apleistas `pending` be tiekėjo statuso **neblokuoja ir nuomos laukti nereikia** – ankstesnė
60 min nuomos taisyklė užrakindavo grįžtančius pirkėjus (Solidgate UAT pastaba).
`lease_expires_at` vis dar rašomas, bet nebeskaitomas.

Klaida: `P0001 'invalid Solidgate intro-offer claim'` (be `ERRCODE`). Rašo
`solidgate_intro_claims`. Kvietėjas:
[`create-session/route.ts#L486`](../../../apps/funnel/src/app/api/solidgate/create-session/route.ts#L486).
Testas: [`solidgate_intro_claims.sql#L18`](../../../supabase/tests/solidgate_intro_claims.sql#L18).

### `consume_solidgate_intro_offer(p_payment_environment TEXT, p_email_hash TEXT, p_session_id UUID, p_tier TEXT, p_subscription_id TEXT) RETURNS TEXT`

[Baseline L8946](../../../supabase/migrations/00001_baseline.sql#L8946). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Po apmokėjimo pažymi claim'ą `consumed` su `solidgate_subscription_id` (seed'ina įrašą, jei
legacy checkout jo neturėjo). Grąžina: `'consumed'` (pirmas arba idempotentiškas tas pats
`subscription_id` – išlieka ir po GDPR `session_id` nunulinimo), `'superseded'` (jau
consumed su **kita** prenumerata – pirkėjui realiai apmokėta antra prenumerata; id
pridedamas prie `superseded_subscription_ids`, teisė vis tiek suteikiama, refund'as
rankinis), `'reassigned'` (claim'as rodė į kitą sesiją/tier, bet apmokėjo šis – viena
prenumerata, refund'o **nereikia**; atskirta nuo `superseded` būtent tam, kad niekas
neautomatizuotų atšaukimo).

Klaida: `P0001 'invalid Solidgate intro-offer consumption'`. Rašo `solidgate_intro_claims`.
Kvietėjai: [`grant/route.ts#L1386`](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1386),
[`index.ts#L662` `consumeIntroOffer()`](../../../supabase/functions/solidgate-webhooks/index.ts#L662).
Testas: [`solidgate_intro_claims.sql#L88`](../../../supabase/tests/solidgate_intro_claims.sql#L88).

### View `solidgate_intro_claims_needing_refund`

[Baseline L1301](../../../supabase/migrations/00001_baseline.sql#L1301). Teisės: `SELECT`
tik `service_role` ([L1318](../../../supabase/migrations/00001_baseline.sql#L1318)).

Operatoriaus sąrašas: `solidgate_intro_claims` eilutės, kurių
`cardinality(superseded_subscription_ids) > 0`, su `granted_subscription_id`,
`duplicate_subscription_ids`, `duplicate_count`, `consumed_at`, `updated_at`, rikiuota pagal
`updated_at DESC`. Tuščias rezultatas – sveika būsena. Repozitorijoje nėra kodo, kuris šį
view skaitytų arba automatiškai grąžintų pinigus: grep randa tik komentarą
[`intro-offer.ts#L24`](../../../packages/shared/src/solidgate/intro-offer.ts#L24), sugeneruotus
tipus ir testą [`solidgate_intro_claims.sql#L113`](../../../supabase/tests/solidgate_intro_claims.sql#L113),
kuris tikrina, kad `superseded` atveju view turi lygiai vieną eilutę.

## Atribucija

### `persist_user_acquisition_attribution(p_payment_environment TEXT, p_user_id UUID, p_source_session_id UUID, p_source_order_id UUID, p_captured_at TIMESTAMPTZ, p_utm_source TEXT DEFAULT NULL, p_utm_medium TEXT DEFAULT NULL, p_utm_campaign TEXT DEFAULT NULL, p_utm_content TEXT DEFAULT NULL, p_utm_term TEXT DEFAULT NULL) RETURNS BOOLEAN`

[Baseline L9108](../../../supabase/migrations/00001_baseline.sql#L9108). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Vienas UTM įrašas per `(environment, user)` lentelėje `user_acquisition_attribution`.
Jei visi UTM laukai tušti – `FALSE` be rašymo. `INSERT ... ON CONFLICT DO UPDATE` perrašo
esamą tik jei naujas `captured_at` **ankstesnis** – laimi pirmoji žinoma įsigijimo sesija,
vėlesni callback'ai ir vėlyvi pakartojimai ignoruojami. Laukai apkarpomi iki 380 simbolių.
Klaida: `P0001 'invalid Solidgate acquisition attribution'`. Rašo
`user_acquisition_attribution`. Kvietėjai:
[`grant/route.ts#L1466`](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1466),
[`index.ts#L757` `persistAccountAcquisition()`](../../../supabase/functions/solidgate-webhooks/index.ts#L757).
SQL testų nėra; `round2` README mini, kad vėlyva UTM atribucija ignoruojama esamam bandymui
([`README.md#L157`](../../../supabase/tests/README.md#L157)).

## Kita

### `find_auth_user_id_by_email(p_email text) RETURNS uuid`

[Baseline L9187](../../../supabase/migrations/00001_baseline.sql#L9187) (vienintelė funkcija,
parašyta mažosiomis raidėmis). Deklaracija: `plpgsql`, `security definer`, `stable`,
`search_path = ''`. Teisės: `service_role` ([L9697](../../../supabase/migrations/00001_baseline.sql#L9697)).

Indeksuota `auth.users` paieška pagal el. paštą (`lower(trim)`), tik pagrindiniame
`instance_id`. Jei sutampa daugiau nei vienas vartotojas (SSO), kelia klaidą, o ne pasirenka
– kad apmokėta prieiga nebūtų suteikta ne tam identitetui. Atsirado vietoj
`auth.admin.listUsers()`, kuris skaito tik pirmą puslapį ir nustojo rasti vartotojus po 200
paskyrų ([`session/persist/route.ts#L138`](../../../apps/funnel/src/app/api/session/persist/route.ts#L138)).
Klaida: `P0001 'ambiguous auth user email'`. Nerašo. Kvietėjai:
[`create-session/route.ts#L243`](../../../apps/funnel/src/app/api/solidgate/create-session/route.ts#L243),
[`session/persist/route.ts#L142`](../../../apps/funnel/src/app/api/session/persist/route.ts#L142),
[`index.ts#L1364`](../../../supabase/functions/solidgate-webhooks/index.ts#L1364),
[`index.ts#L1887`](../../../supabase/functions/solidgate-webhooks/index.ts#L1887).

### `revoke_user_auth_sessions(p_user_id UUID) RETURNS INTEGER`

[Baseline L9224](../../../supabase/migrations/00001_baseline.sql#L9224). Deklaracija:
`plpgsql`, `SECURITY DEFINER`, `search_path = ''`. Teisės: `service_role`.

Ištrina vartotojo `auth.refresh_tokens` (pagal `user_id::TEXT`, nes GoTrue ten laiko
`VARCHAR`) ir `auth.sessions`; grąžina ištrintų sesijų skaičių. Naudojama, kai teisė
atšaukiama ir vartotojas turi būti išmestas iš PWA. Klaida:
`P0001 'invalid user id for session revocation'`. Rašo `auth.refresh_tokens`, `auth.sessions`.
Kvietėjas: [`index.ts#L1258` `revokeAuthSessions()`](../../../supabase/functions/solidgate-webhooks/index.ts#L1258).

### `bump_user_app_open(p_user_id UUID, p_default_locale TEXT) RETURNS TABLE (app_open_count INTEGER, last_active_at TIMESTAMPTZ)`

[Baseline L9253](../../../supabase/migrations/00001_baseline.sql#L9253). Deklaracija:
`LANGUAGE sql`, be `SECURITY` (INVOKER) ir be `search_path`. Teisės: 9 skyriuje nėra jokio
`REVOKE`/`GRANT` – lieka numatytoji `EXECUTE` `PUBLIC`.

Ne mokėjimų funkcija: member-area atidarymo skaitiklis. `INSERT ... ON CONFLICT (user_id) DO
UPDATE` į `user_prefs` (`app_open_count + 1`, `last_active_at = now()`, locale tik pirmą
kartą), grąžina naują skaitiklį pirmo/n-tojo paleidimo patirtims. Klaidų nekelia. Rašo
`user_prefs`. Kvietėjas: [`apps/pwa/.../api/app-open/route.ts#L36`](../../../apps/pwa/src/app/api/app-open/route.ts#L36).

## Funkcija → kvietėjai

Visos 76 funkcijos baseline tvarka. „Kvietėjai“ – ne testų TS/Deno failai, kuriuose yra
`.rpc('<name>'` (arba tipizuotas `rpc(` apvalkalas su tuo pačiu vardu); „tik SQL viduje“ –
kviečia tik kitos baseline funkcijos arba trigger'is; „nekviečiama“ – nei kodas, nei SQL
(išskyrus testus). Trigger funkcijos pažymėtos „trigger“.

| Funkcija | Kvietėjai |
|---|---|
| [`solidgate_oto_step_from_product_slug`](../../../supabase/migrations/00001_baseline.sql#L73) | tik SQL viduje (indeksas `idx_orders_solidgate_one_live_oto_step`, `guard_solidgate_oto_payable_order`, `open_solidgate_oto_order_v2`, `resume_solidgate_oto_order_after_absent_reconcile`, `advance_solidgate_oto_progress`, `grant_solidgate_oto_entitlement`) |
| [`solidgate_oto_step_from_internal_slug`](../../../supabase/migrations/00001_baseline.sql#L98) | tik SQL viduje (`guard_solidgate_oto_payable_order`, `open_solidgate_oto_order_v2`, `grant_solidgate_oto_entitlement`) |
| [`solidgate_persisted_oto_step`](../../../supabase/migrations/00001_baseline.sql#L125) | tik SQL viduje (`guard_solidgate_oto_payable_order`, `open_solidgate_oto_order_v2`) |
| [`solidgate_pwa_product_code`](../../../supabase/migrations/00001_baseline.sql#L143) | tik SQL viduje (`guard_solidgate_pwa_payable_order`, visos `*_pwa_*` RPC) |
| [`solidgate_main_checkout_amount`](../../../supabase/migrations/00001_baseline.sql#L186) | tik SQL viduje (`guard_solidgate_main_payable_order`, `open_solidgate_main_checkout`, `finalize_solidgate_main_checkout`); parsina [`sql-price-grid-parity.test.ts`](../../../packages/shared/src/__tests__/sql-price-grid-parity.test.ts#L88) |
| [`bump_orders_updated_at`](../../../supabase/migrations/00001_baseline.sql#L1327) | trigger `orders_updated_at_trigger` |
| [`guard_solidgate_checkout_identity`](../../../supabase/migrations/00001_baseline.sql#L1335) | trigger `guard_solidgate_checkout_identity_trigger` |
| [`guard_solidgate_main_payable_order`](../../../supabase/migrations/00001_baseline.sql#L1476) | trigger `guard_solidgate_main_payable_order_trigger` |
| [`guard_solidgate_oto_payable_order`](../../../supabase/migrations/00001_baseline.sql#L1580) | trigger `guard_solidgate_oto_payable_order_trigger` |
| [`guard_solidgate_pwa_payable_order`](../../../supabase/migrations/00001_baseline.sql#L1781) | trigger `guard_solidgate_pwa_payable_order_trigger` |
| [`guard_solidgate_session_vault_card_source`](../../../supabase/migrations/00001_baseline.sql#L1933) | trigger `guard_solidgate_session_vault_card_source_{insert,update}_trigger` |
| [`guard_solidgate_session_vault_payment_method`](../../../supabase/migrations/00001_baseline.sql#L1982) | trigger `guard_solidgate_session_vault_payment_method_{insert,update}_trigger` |
| [`guard_solidgate_account_vault_card_source`](../../../supabase/migrations/00001_baseline.sql#L2047) | trigger `guard_solidgate_account_vault_card_source_{insert,update}_trigger` |
| [`guard_solidgate_account_vault_payment_method`](../../../supabase/migrations/00001_baseline.sql#L2086) | trigger `guard_solidgate_account_vault_payment_method_{insert,update}_trigger` |
| [`prevent_solidgate_entitlement_replay`](../../../supabase/migrations/00001_baseline.sql#L2125) | trigger `prevent_solidgate_entitlement_replay` |
| [`enqueue_solidgate_subscription_token_sync_from_entitlement`](../../../supabase/migrations/00001_baseline.sql#L2321) | trigger `solidgate_subscription_token_sync_entitlement_trigger` |
| [`claim_solidgate_webhook_event`](../../../supabase/migrations/00001_baseline.sql#L2374) | nekviečiama (v1; tik [`webhook.test.ts#L1234`](../../../supabase/functions/solidgate-webhooks/__tests__/webhook.test.ts#L1234) ir [`solidgate_round2_concurrency.sql#L24`](../../../supabase/tests/solidgate_round2_concurrency.sql#L24)) |
| [`claim_solidgate_webhook_event_v2`](../../../supabase/migrations/00001_baseline.sql#L2449) | [`index.ts#L887`](../../../supabase/functions/solidgate-webhooks/index.ts#L887) |
| [`complete_solidgate_webhook_event_v2`](../../../supabase/migrations/00001_baseline.sql#L2567) | [`index.ts#L931`](../../../supabase/functions/solidgate-webhooks/index.ts#L931) |
| [`fail_solidgate_webhook_event_v2`](../../../supabase/migrations/00001_baseline.sql#L2609) | [`index.ts#L953`](../../../supabase/functions/solidgate-webhooks/index.ts#L953) |
| [`claim_solidgate_entity_event`](../../../supabase/migrations/00001_baseline.sql#L2652) | [`index.ts#L993`](../../../supabase/functions/solidgate-webhooks/index.ts#L993) |
| [`complete_solidgate_entity_event`](../../../supabase/migrations/00001_baseline.sql#L2710) | [`index.ts#L1007`](../../../supabase/functions/solidgate-webhooks/index.ts#L1007) |
| [`release_solidgate_entity_event`](../../../supabase/migrations/00001_baseline.sql#L2733) | [`index.ts#L1015`](../../../supabase/functions/solidgate-webhooks/index.ts#L1015) |
| [`claim_solidgate_analytics_outbox`](../../../supabase/migrations/00001_baseline.sql#L2753) | [`index.ts#L786`](../../../supabase/functions/solidgate-webhooks/index.ts#L786) |
| [`claim_solidgate_fulfillment_outbox`](../../../supabase/migrations/00001_baseline.sql#L2789) | [`solidgate-fulfillment.ts#L945`](../../../apps/funnel/src/lib/payment/solidgate-fulfillment.ts#L945) |
| [`solidgate_checkout_core_is_canonical`](../../../supabase/migrations/00001_baseline.sql#L2830) | tik SQL viduje (`record_solidgate_pwa_confirmed_capture`, `reconcile_solidgate_legacy_order_identity`, `solidgate_special_free_card_ready`, `solidgate_subscription_token_sync_is_billable`) |
| [`get_solidgate_main_checkout_identity`](../../../supabase/migrations/00001_baseline.sql#L2933) | [`create-session/route.ts#L289`](../../../apps/funnel/src/app/api/solidgate/create-session/route.ts#L289) |
| [`get_solidgate_pwa_checkout_identity`](../../../supabase/migrations/00001_baseline.sql#L3003) | [`purchase/route.ts#L591`](../../../apps/pwa/src/app/api/solidgate/purchase/route.ts#L591) |
| [`open_solidgate_main_checkout`](../../../supabase/migrations/00001_baseline.sql#L3081) | tik SQL viduje (`open_solidgate_main_checkout_v2` [L3630](../../../supabase/migrations/00001_baseline.sql#L3630)); nebekviečiama iš kodo |
| [`open_solidgate_main_checkout_v2`](../../../supabase/migrations/00001_baseline.sql#L3391) | [`create-session/route.ts#L604`](../../../apps/funnel/src/app/api/solidgate/create-session/route.ts#L604) |
| [`finalize_solidgate_main_checkout`](../../../supabase/migrations/00001_baseline.sql#L3692) | tik SQL viduje (`finalize_solidgate_main_checkout_v2` [L3854](../../../supabase/migrations/00001_baseline.sql#L3854)); nebekviečiama iš kodo |
| [`finalize_solidgate_main_checkout_v2`](../../../supabase/migrations/00001_baseline.sql#L3813) | [`create-session/route.ts#L718`](../../../apps/funnel/src/app/api/solidgate/create-session/route.ts#L718) |
| [`open_solidgate_oto_order_v2`](../../../supabase/migrations/00001_baseline.sql#L3869) | [`charge-oto/route.ts#L1197`](../../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L1197) |
| [`resume_solidgate_oto_order_after_absent_reconcile`](../../../supabase/migrations/00001_baseline.sql#L4250) | [`charge-oto/route.ts#L1324`](../../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L1324) |
| [`open_solidgate_pwa_purchase`](../../../supabase/migrations/00001_baseline.sql#L4305) | tik SQL viduje (`open_solidgate_pwa_purchase_v2` [L5059](../../../supabase/migrations/00001_baseline.sql#L5059)); nebekviečiama iš kodo |
| [`open_solidgate_pwa_purchase_v2`](../../../supabase/migrations/00001_baseline.sql#L4779) | [`purchase/route.ts#L811`](../../../apps/pwa/src/app/api/solidgate/purchase/route.ts#L811) |
| [`finalize_solidgate_pwa_form`](../../../supabase/migrations/00001_baseline.sql#L5127) | tik SQL viduje (`finalize_solidgate_pwa_form_v2` [L5326](../../../supabase/migrations/00001_baseline.sql#L5326)); nebekviečiama iš kodo |
| [`finalize_solidgate_pwa_form_v2`](../../../supabase/migrations/00001_baseline.sql#L5284) | [`purchase/route.ts#L891`](../../../apps/pwa/src/app/api/solidgate/purchase/route.ts#L891) |
| [`record_solidgate_pwa_submission_result`](../../../supabase/migrations/00001_baseline.sql#L5341) | [`purchase/route.ts#L937`](../../../apps/pwa/src/app/api/solidgate/purchase/route.ts#L937) |
| [`resume_solidgate_pwa_submission_after_absent_reconcile`](../../../supabase/migrations/00001_baseline.sql#L5584) | [`purchase/route.ts#L1066`](../../../apps/pwa/src/app/api/solidgate/purchase/route.ts#L1066) |
| [`record_solidgate_pwa_confirmed_capture`](../../../supabase/migrations/00001_baseline.sql#L5717) | [`purchase/confirm/route.ts#L939`](../../../apps/pwa/src/app/api/solidgate/purchase/confirm/route.ts#L939), [`index.ts#L2689`](../../../supabase/functions/solidgate-webhooks/index.ts#L2689) |
| [`advance_solidgate_oto_progress`](../../../supabase/migrations/00001_baseline.sql#L5913) | [`advance-oto/route.ts#L56`](../../../apps/funnel/src/app/api/solidgate/advance-oto/route.ts#L56), [`charge-oto/route.ts#L419`](../../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L419) |
| [`reconcile_solidgate_legacy_order_identity`](../../../supabase/migrations/00001_baseline.sql#L6053) | nekviečiama (operatoriaus `postgres` įrankis; [`solidgate_payment_identity.sql#L573`](../../../supabase/tests/solidgate_payment_identity.sql#L573)) |
| [`solidgate_special_free_card_ready`](../../../supabase/migrations/00001_baseline.sql#L6241) | [`grant/route.ts#L699`](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L699), [`index.ts#L1959`](../../../supabase/functions/solidgate-webhooks/index.ts#L1959), [`index.ts#L2789`](../../../supabase/functions/solidgate-webhooks/index.ts#L2789); SQL viduje – `prevent_solidgate_entitlement_replay`, `grant_solidgate_main_entitlement` |
| [`grant_solidgate_main_entitlement`](../../../supabase/migrations/00001_baseline.sql#L6363) | [`grant/route.ts#L1527`](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1527), [`index.ts#L1051`](../../../supabase/functions/solidgate-webhooks/index.ts#L1051), [`entitlement-backfill.ts#L70`](../../../packages/shared/src/auth/entitlement-backfill.ts#L70) |
| [`grant_solidgate_oto_entitlement`](../../../supabase/migrations/00001_baseline.sql#L6534) | [`charge-oto/route.ts#L1767`](../../../apps/funnel/src/app/api/solidgate/charge-oto/route.ts#L1767), [`index.ts#L1061`](../../../supabase/functions/solidgate-webhooks/index.ts#L1061) |
| [`grant_solidgate_pwa_entitlement`](../../../supabase/migrations/00001_baseline.sql#L6798) | [`purchase/confirm/route.ts#L965`](../../../apps/pwa/src/app/api/solidgate/purchase/confirm/route.ts#L965), [`index.ts#L1072`](../../../supabase/functions/solidgate-webhooks/index.ts#L1072) |
| [`apply_solidgate_subscription_entitlement_lifecycle`](../../../supabase/migrations/00001_baseline.sql#L6972) | [`index.ts#L1146`](../../../supabase/functions/solidgate-webhooks/index.ts#L1146) |
| [`write_solidgate_session_vault_monotonic`](../../../supabase/migrations/00001_baseline.sql#L7092) | tik SQL viduje (`write_solidgate_session_vault_with_method`); suteikta `service_role`, bet iš kodo nekviečiama |
| [`write_solidgate_account_vault_monotonic`](../../../supabase/migrations/00001_baseline.sql#L7301) | tik SQL viduje (`promote_solidgate_session_vault_monotonic`, `write_solidgate_account_vault_with_method`); suteikta `service_role`, bet iš kodo nekviečiama |
| [`promote_solidgate_session_vault_monotonic`](../../../supabase/migrations/00001_baseline.sql#L7653) | tik SQL viduje (`promote_solidgate_session_vault_with_method`); suteikta `service_role`, bet iš kodo nekviečiama |
| [`write_solidgate_session_vault_with_method`](../../../supabase/migrations/00001_baseline.sql#L7711) | [`session-vault.ts#L74`](../../../packages/shared/src/solidgate/session-vault.ts#L74) (← [`grant/route.ts#L1001`](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1001), [`#L1309`](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1309)), [`index.ts#L2753`](../../../supabase/functions/solidgate-webhooks/index.ts#L2753) |
| [`write_solidgate_account_vault_with_method`](../../../supabase/migrations/00001_baseline.sql#L7805) | [`purchase/confirm/route.ts#L1008`](../../../apps/pwa/src/app/api/solidgate/purchase/confirm/route.ts#L1008), [`update-card/route.ts#L481`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L481), [`index.ts#L2721`](../../../supabase/functions/solidgate-webhooks/index.ts#L2721), [`account-vault.ts#L84`](../../../packages/shared/src/solidgate/account-vault.ts#L84) (apvalkalas be ne testų kvietėjų) |
| [`promote_solidgate_session_vault_with_method`](../../../supabase/migrations/00001_baseline.sql#L7902) | [`account-vault.ts#L120`](../../../packages/shared/src/solidgate/account-vault.ts#L120) (← [`grant/route.ts#L1456`](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1456), [`verify-otp.ts#L196`](../../../packages/shared/src/auth/verify-otp.ts#L196), [`claim-purchase.ts#L47`](../../../packages/shared/src/auth/claim-purchase.ts#L47), [`#L138`](../../../packages/shared/src/auth/claim-purchase.ts#L138)), [`index.ts#L1322`](../../../supabase/functions/solidgate-webhooks/index.ts#L1322) |
| [`clear_solidgate_legacy_session_vault`](../../../supabase/migrations/00001_baseline.sql#L7981) | nekviečiama (operatoriaus įrankis; [`solidgate_card_update_state.sql#L1006`](../../../supabase/tests/solidgate_card_update_state.sql#L1006)) |
| [`open_solidgate_card_update_attempt`](../../../supabase/migrations/00001_baseline.sql#L8029) | [`update-card/route.ts#L547`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L547) |
| [`finalize_solidgate_card_update_attempt`](../../../supabase/migrations/00001_baseline.sql#L8163) | [`update-card/route.ts#L600`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L600) |
| [`claim_solidgate_card_update_attempt`](../../../supabase/migrations/00001_baseline.sql#L8214) | [`update-card/route.ts#L448`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L448) |
| [`get_solidgate_card_update_attempt`](../../../supabase/migrations/00001_baseline.sql#L8266) | [`update-card/route.ts#L359`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L359) |
| [`release_solidgate_card_update_attempt`](../../../supabase/migrations/00001_baseline.sql#L8297) | [`update-card/route.ts#L469`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L469) |
| [`complete_solidgate_card_update_attempt`](../../../supabase/migrations/00001_baseline.sql#L8324) | [`update-card/route.ts#L504`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L504) |
| [`record_solidgate_card_update_attempt_status`](../../../supabase/migrations/00001_baseline.sql#L8352) | [`update-card/route.ts#L408`](../../../apps/pwa/src/app/api/solidgate/billing/update-card/route.ts#L408) |
| [`solidgate_subscription_token_sync_is_billable`](../../../supabase/migrations/00001_baseline.sql#L8382) | tik SQL viduje (`enqueue_`, `fence_`, `read_claimed_`, `complete_solidgate_subscription_token_sync`) |
| [`enqueue_solidgate_subscription_token_sync`](../../../supabase/migrations/00001_baseline.sql#L8421) | tik SQL viduje (`write_solidgate_account_vault_monotonic`, trigger funkcija `enqueue_..._from_entitlement`) |
| [`fence_solidgate_subscription_token_sync_for_tokenless_source`](../../../supabase/migrations/00001_baseline.sql#L8549) | tik SQL viduje (`write_solidgate_account_vault_monotonic`, trigger funkcija `enqueue_..._from_entitlement`) |
| [`claim_solidgate_subscription_token_sync`](../../../supabase/migrations/00001_baseline.sql#L8675) | [`subscription-token-sync.ts#L184`](../../../packages/shared/src/solidgate/subscription-token-sync.ts#L184) |
| [`read_claimed_solidgate_subscription_token_sync`](../../../supabase/migrations/00001_baseline.sql#L8720) | [`subscription-token-sync.ts#L67`](../../../packages/shared/src/solidgate/subscription-token-sync.ts#L67) |
| [`complete_solidgate_subscription_token_sync`](../../../supabase/migrations/00001_baseline.sql#L8766) | [`subscription-token-sync.ts#L83`](../../../packages/shared/src/solidgate/subscription-token-sync.ts#L83) |
| [`fail_solidgate_subscription_token_sync`](../../../supabase/migrations/00001_baseline.sql#L8805) | [`subscription-token-sync.ts#L103`](../../../packages/shared/src/solidgate/subscription-token-sync.ts#L103) |
| [`claim_solidgate_intro_offer`](../../../supabase/migrations/00001_baseline.sql#L8841) | [`create-session/route.ts#L486`](../../../apps/funnel/src/app/api/solidgate/create-session/route.ts#L486) |
| [`consume_solidgate_intro_offer`](../../../supabase/migrations/00001_baseline.sql#L8946) | [`grant/route.ts#L1386`](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1386), [`index.ts#L662`](../../../supabase/functions/solidgate-webhooks/index.ts#L662) |
| [`claim_meta_capi_event`](../../../supabase/migrations/00001_baseline.sql#L9036) | [`meta/capi/route.ts#L175`](../../../apps/funnel/src/app/api/meta/capi/route.ts#L175) |
| [`persist_user_acquisition_attribution`](../../../supabase/migrations/00001_baseline.sql#L9108) | [`grant/route.ts#L1466`](../../../apps/funnel/src/app/api/solidgate/grant/route.ts#L1466), [`index.ts#L757`](../../../supabase/functions/solidgate-webhooks/index.ts#L757) |
| [`find_auth_user_id_by_email`](../../../supabase/migrations/00001_baseline.sql#L9187) | [`create-session/route.ts#L243`](../../../apps/funnel/src/app/api/solidgate/create-session/route.ts#L243), [`session/persist/route.ts#L142`](../../../apps/funnel/src/app/api/session/persist/route.ts#L142), [`index.ts#L1364`](../../../supabase/functions/solidgate-webhooks/index.ts#L1364), [`index.ts#L1887`](../../../supabase/functions/solidgate-webhooks/index.ts#L1887) |
| [`revoke_user_auth_sessions`](../../../supabase/migrations/00001_baseline.sql#L9224) | [`index.ts#L1258`](../../../supabase/functions/solidgate-webhooks/index.ts#L1258) |
| [`bump_user_app_open`](../../../supabase/migrations/00001_baseline.sql#L9253) | [`app-open/route.ts#L36`](../../../apps/pwa/src/app/api/app-open/route.ts#L36) |

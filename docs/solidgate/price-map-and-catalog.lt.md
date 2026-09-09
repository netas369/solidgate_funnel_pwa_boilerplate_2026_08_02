# Kaip veikia `price-map.ts` ir Solidgate katalogas

> **Dokumento paskirtis:** originalaus `/Users/Netas/Projects/theastrologist` projekto kodo analizė, atlikta **2026-09-09**. Pavyzdžiai aprašo tą projektą ir nėra šio boilerplate veikimo patvirtinimas. Boilerplate jau turi bendrinę produktų konfigūraciją; jos atitikimas šiai analizei čia netikrintas. Tikri Solidgate UUID ir produkto konfigūracija į vykdomą boilerplate kodą neperkeliami.
>
> Darbinis pasirinkimas pagal komandos perduotą Solidgate rekomendaciją: **v1 / Billing 1.0**. V2 tyrimas sandbox aplinkoje yra atskiras galimas darbas. Šiam dokumentui išoriniai API nekviesti ir jokie produktai nekeisti.

`price-map.ts` atsako, **kokią sumą aplikacija priskiria pasirinktam pasiūlymui ir locale**. `solidgate/catalog.ts` papildomai apibrėžia **produktų kodus, subscription sąlygas ir providerio katalogui skirtas kainas pagal valiutą**. Tikri Solidgate produktų ir kainų identifikatoriai laikomi trečiame faile — `catalog-ids.json`. Duomenų bazė dar turi atskirą leistinų main checkout sumų patikrinimą.

## 1. Penki sluoksniai, kurių nereikia suplakti

| Sluoksnis | Kas jame laikoma | Kam naudojamas |
| --- | --- | --- |
| `price-map.ts` | Pasiūlymas × locale → suma, senasis produkto pavadinimas, neprivaloma palyginamoji suma; locale → valiuta | Kainai parodyti UI ir naujo pirkimo sumai išrinkti serveryje |
| `solidgate/catalog.ts` | Canonical produktų kodai, display names, sumos pagal valiutą, subscription periodai ir trial sąlygos | Solidgate adapteriui, analytics, prieigos susiejimui ir katalogo paruošimui |
| Tikras katalogas Solidgate pusėje | Per API sukurti produkto ir jo kainų objektai | Provideriui vykdyti subscription apmokestinimą pagal nustatytas sąlygas |
| `catalog-ids.json` | Vietinis pasiūlymas → provider product UUID; valiuta → provider price UUID | Konkrečiam Solidgate produktui ir kainai parinkti checkout metu |
| SQL funkcijos ir order snapshot | Leistinos naujo main checkout sumos ir konkretaus pradėto pirkimo užfiksuoti duomenys | Neteisingam order atmesti ir retry metu išsaugoti tą patį pirkimą |

Pakeitus vietinį TypeScript failą, jau egzistuojantis Solidgate katalogas savaime nepasikeičia. Pakeitus kainą Solidgate pusėje, vietinis `PRICE_MAP` savaime nepasikeičia. Sutapimą reikia užtikrinti aiškia katalogo atnaujinimo ir tikrinimo procedūra.

Šaltiniai: [price-map.ts](/Users/Netas/Projects/theastrologist/packages/shared/src/price-map.ts:48), [catalog.ts](/Users/Netas/Projects/theastrologist/packages/shared/src/solidgate/catalog.ts:422), [seed scriptas](/Users/Netas/Projects/theastrologist/scripts/solidgate-seed-catalog.ts:134), [checkout parinkimas](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/solidgate/create-session/route.ts:416).

## 2. Ką tiksliai daro `price-map.ts`

Pagrindinio objekto forma yra `PRICE_MAP[productId][locale]`. Čia `productId` reiškia aplikacijos raktažodį, pavyzdžiui, `trial1`, o ne Solidgate UUID.

| Laukas arba eksportas | Reikšmė ir naudojimas |
| --- | --- |
| `amountCents` | Sveiku skaičiumi išreikšta suma mažiausiais valiutos vienetais. EUR atveju `500` reiškia €5. JPY atveju `926` reiškia ¥926; todėl žodis „cents“ šiame pavadinime nėra tikslus visoms valiutoms. |
| `productName` | Originaliame projekte išlikęs senas locale prefiksą turintis produkto kodas. Tai nėra Solidgate product UUID ir nėra patikimas dabartinio vartotojui rodomo pavadinimo šaltinis. |
| `compareAtCents` | Neprivaloma palyginamoji kaina UI, pavyzdžiui, perbrauktai kainai. Ji pati nesukuria nei prenumeratos, nei būsimo mokėjimo. |
| `ProductId` | `keyof typeof PRICE_MAP`: leidžiami aplikacijos kainų raktažodžiai. Tai TypeScript tipas. |
| `SellableProductId` | Dabartiniame faile tiesiog `ProductId` alias. Pavadinimas pats nepatvirtina, kad kiekvienas raktas priimamas kiekviename checkout route. |
| `LOCALE_CURRENCY_MAP` | Tiesioginis locale susiejimas su valiuta, pavyzdžiui, `lt → eur`, `en → usd`, `ja → jpy`. |
| `ZERO_DECIMAL_CURRENCIES` / `isZeroDecimalCurrency()` | Padeda žinoti, kurioms valiutoms suma jau išreikšta sveikais pagrindiniais vienetais ir jos nereikia dalinti iš 100. |
| `resolveProductPrice()` | Sujungia kainos įrašą su locale valiuta ir grąžina vieną `ResolvedPrice` objektą. |

Funkcija neatlieka valiutos konvertavimo pagal rinkos kursą. Ji tiesiog perskaito iš anksto suvestą sumą ir valiutą. Dabartiniame projekte EN sumos sutampa skaičiumi su EUR sumomis, tačiau EN parinkta USD valiuta. Tai konfigūracijos sprendimas, o ne automatinė EUR → USD konversija.

`resolveProductPrice()` taip pat nedaro savo runtime fallback ir netikrina savavališkai gauto rakto. Ji tiesiogiai skaito `PRICE_MAP[productId][locale]`, todėl route turi prieš tai patikrinti kliento įvestį. Main checkout atskirai tikrina, ar `productId` priklauso kainų map ir leidžiamų checkout pasiūlymų rinkiniui.

Šaltiniai: [tipai ir laukai](/Users/Netas/Projects/theastrologist/packages/shared/src/price-map.ts:48), [ProductId ir valiutos](/Users/Netas/Projects/theastrologist/packages/shared/src/price-map.ts:362), [resolveProductPrice](/Users/Netas/Projects/theastrologist/packages/shared/src/price-map.ts:401), [route validacija](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/solidgate/create-session/route.ts:259).

### Tikslus `trial1` ir `lt` pavyzdys

Tai originalaus projekto pavyzdys supratimui, ne naujo boilerplate produkto konfigūracija:

```ts
resolveProductPrice('trial1', 'lt')

// Grąžina:
{
  amountCents: 500,
  currency: 'eur',
  productName: 'LT_THEASTRL_260513_SUB',
  compareAtCents: 5900,
}
```

Objektas sako: šiam pasiūlymui ir locale priskirta €5 suma, EUR valiuta, senasis lokalizuotas produkto kodas ir €59 palyginamoji suma. **Jame nėra nei 7 dienų trial trukmės, nei būsimo €59 mokėjimo kas 30 dienų taisyklės.** Šios subscription sąlygos apibrėžtos `SOLIDGATE_PRODUCTS` ir perduodamos providerio katalogui.

Šaltiniai: [trial1 LT įrašas](/Users/Netas/Projects/theastrologist/packages/shared/src/price-map.ts:71), [LT valiuta](/Users/Netas/Projects/theastrologist/packages/shared/src/price-map.ts:376), [subscription apibrėžimas](/Users/Netas/Projects/theastrologist/packages/shared/src/solidgate/catalog.ts:472).

### Kur kaina naudojama UI

Offer UI `computeTierPrices()` iš `resolveProductPrice()` pasiima sumą ir palyginamąją kainą. Tada iš jų apskaičiuoja bei suformatuoja UI reikalingas bendras ir periodui priskirtas kainas. Kiti offer ir OTO komponentai taip pat naudoja tą pačią kainų funkciją.

UI skaičiavimas savaime nėra mokėjimo patvirtinimas. Main checkout serveris kainą išsirenka pats; kliento body perduoda pasiūlymo raktą ir sesijos ID, o ne patikimą mokėtiną sumą. [UI kainų skaičiavimas](/Users/Netas/Projects/theastrologist/apps/funnel/src/features/offer/components/offer-sections.tsx:61), [serverio input](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/solidgate/create-session/route.ts:259).

### Kodėl `productName` atrodo kaip techninis kodas

Tai istorinio Stripe modelio palikimas: locale prefiksas, produkto šeima ir senas versijos žymuo vienoje eilutėje. Naujesnis Solidgate kodas turi atskirą `PRODUCT_ID_TO_CODE` ir `PRODUCT_ID_TO_DISPLAY_NAME`.

Senasis `productName` vis dar dalyvauja suderinamumo logikoje. `entitlements.ts` kuria atgalinį susiejimą tiek iš `PRICE_MAP.productName`, tiek iš Solidgate canonical kodų, kad seni order pavadinimai galėtų būti suprasti. Todėl pavadinimų keitimą reikia vertinti kartu su istorinių order ir prieigos įrašų atpažinimu. Bendriniame modulyje verta turėti aiškiai atskirtus `offerKey`, `productCode`, `displayName` ir legacy aliases. [Istorinių pavadinimų susiejimas](/Users/Netas/Projects/theastrologist/packages/shared/src/entitlements.ts:15).

## 3. Ką tiksliai daro `solidgate/catalog.ts`

Šiame faile sudėta daugiau nei viena atsakomybė. Viena dalis skirta visų parduodamų produktų atpažinimui, kita — sumoms, trečia — tik Solidgate subscription produktų sukūrimui.

| Eksportas | Ką apibrėžia |
| --- | --- |
| `SOLIDGATE_BATCH` | Originalaus projekto produktų kodų versijos / partijos žymuo. Tai nėra API versija. |
| `SOLIDGATE_PRODUCT_CODES` | Canonical verslo produktų kodus. Skirtingi pagrindinio trial pasiūlymai gali suteikti tą pačią produkto prieigą, todėl dalijasi vienu canonical kodu. |
| `PRODUCT_ID_TO_CODE` | Aplikacijos pasiūlymo rakto susiejimą su canonical produktu. Pavyzdžiui, visi pagrindinio trial variantai susiejami su `main`. |
| `PRODUCT_ID_TO_DISPLAY_NAME` | Žmogui suprantamus produktų pavadinimus, naudojamus bendrame commerce ir analytics kontekste. |
| `CurrencyAmounts` | Tipo reikalavimą turėti sumas pagal valiutą. |
| `CATALOG_AMOUNTS` | Kainų map pagal `productId × currency`. Tai atskiras pažodinis sumų objektas, ne tiesioginis runtime perskaitymas iš `PRICE_MAP`. |
| `SolidgateProductDef` | Subscription apibrėžimo formą: raktas, canonical kodas, display name, rebill sumos, billing periodas ir neprivalomos trial sąlygos. |
| `ADVISORY_TRIAL_INTRO_AMOUNTS` | Atskirą advisory trial pradinę kainą. Ji skiriasi nuo `oto2_advisory_monthly` recurring sumos. |
| `SOLIDGATE_PRODUCTS` | Aštuonių recurring pasiūlymų deklaracijas, kurias naudoja seed scriptas. |
| `ONE_TIME_PRODUCT_IDS` | Devynis vienkartinių pasiūlymų raktus, kuriems šioje integracijoje nekuriamas subscription katalogo produktas. |
| `CATALOG_CURRENCIES` | 17 valiutų, kurioms katalogo paruošimas tikisi sukurti kainas. Dalis jų paruošta anksčiau nei įjungiamos atitinkamos locale. |

`catalog.ts` pradžios komentaras sako, kad sumos generuotos iš `PRICE_MAP`. Tačiau pačiame vykdomame faile `CATALOG_AMOUNTS` įrašytas atskirai ir `PRICE_MAP` runtime neimportuojamas — importuojami tik tipai. Todėl tiksliau sakyti: **tai atskira kainų kopija, kurios sutapimą su kainų map tikrina testai**. Negalima iš komentaro daryti išvados, kad pakeistas `PRICE_MAP` automatiškai atnaujins katalogą.

Šaltiniai: [kodai ir display names](/Users/Netas/Projects/theastrologist/packages/shared/src/solidgate/catalog.ts:19), [CATALOG_AMOUNTS](/Users/Netas/Projects/theastrologist/packages/shared/src/solidgate/catalog.ts:78), [subscription tipas](/Users/Netas/Projects/theastrologist/packages/shared/src/solidgate/catalog.ts:422), [vienkartiniai pasiūlymai ir valiutos](/Users/Netas/Projects/theastrologist/packages/shared/src/solidgate/catalog.ts:526).

### Ką reiškia subscription apibrėžimo laukai

| Laukas | Paskirtis |
| --- | --- |
| `key` | Vietinis konkretaus pasiūlymo raktas; pagal jį sujungiama deklaracija ir gauti providerio ID. |
| `productCode` | Koks verslo produktas / prieiga parduodama. Tai nėra providerio UUID. |
| `displayName` | Katalogo produktui paruošiamas pavadinimas. |
| `rebillAmounts` | Periodinių mokėjimų sumos pagal valiutą. |
| `billingPeriod.unit` ir `.value` | Kaip dažnai kartojamas mokėjimas. Šiame projekte pagrindinis planas yra kas 30 dienų, advisory — kas savaitę. |
| `trial.paymentAction` | Trial apmokestinimo veiksmas: šiose dabartinėse deklaracijose `auth_settle` reiškia apmokamą intro; tipas taip pat leidžia `auth_0_amount`. |
| `trial.period.unit` ir `.value` | Kiek laiko galioja pradinis trial etapas. |
| `trial.amounts` | Apmokamo trial pradžioje mokamos sumos pagal valiutą. |

### Kodėl yra aštuoni recurring katalogo įrašai

| Vietiniai katalogo raktai | Kiekis | Deklaruojama EUR eiga |
| --- | --- | --- |
| `trial1`, `trial2`, `trial3`, `trial4` | 4 | Skirtinga pradinė suma: €5 / €9 / €13 / €17,67; 7 dienų trial, tada €59 kas 30 dienų |
| `special_1eur`, `special_free` | 2 | Dabartinėse deklaracijose abu turi €1 pradžią; 7 dienų trial, tada €59 kas 30 dienų |
| `advisory_trial` | 1 | €1 pradžia, 7 dienų trial, tada €49 kas savaitę |
| `advisory_direct` | 1 | €49 už pirmą savaitę iš karto, be trial, toliau €49 kas savaitę |

Pirmi šeši įrašai turi tą patį canonical main produkto kodą, tačiau atskirus providerio subscription pasiūlymus dėl skirtingų intro sąlygų. Advisory atveju prieiga taip pat ta pati, o katalogo produktai atskiri dėl trial ir tiesioginio apmokėjimo skirtumo.

`trial_monthly` yra rebill sumų šaltinis, bet nėra devintas atskirai seedinamas `SOLIDGATE_PRODUCTS` įrašas. Devyni vienkartiniai OTO pasiūlymai irgi neįeina į šį aštuonetą. Tokie purchase keliai siunčia konkrečią sumą ir valiutą vienkartiniam nurašymui iš išsaugoto mokėjimo metodo.

Šaltiniai: [main subscription ir advisory deklaracijos](/Users/Netas/Projects/theastrologist/packages/shared/src/solidgate/catalog.ts:472), [vienkartinio ir subscription charge atskyrimas](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/solidgate/charge-oto/route.ts:1457), [PWA provider ID pasirinkimas](/Users/Netas/Projects/theastrologist/apps/pwa/src/app/api/solidgate/purchase/route.ts:703).

## 4. Seederis, tikras providerio katalogas ir `catalog-ids.json`

Katalogo paruošimo scriptas skaito `SOLIDGATE_PRODUCTS` ir `CATALOG_CURRENCIES`. Iš kiekvienos deklaracijos jis paruošia providerio produkto payload, o kiekvienai valiutai — kainos payload:

```text
SOLIDGATE_PRODUCTS pasiūlymas
  → produkto payload: billing_period, trial, product metadata
  → valiutos kainos payload:
       product_price ← rebillAmounts[currency]
       trial_price   ← trial.amounts[currency], jei trial apmokamas
  → Solidgate sukurtas produkto ID ir kainos ID
  → catalog-ids.json vietinis susiejimas
```

`catalog-ids.json` struktūros pavyzdys su vietaženkliais:

```json
{
  "example_intro": {
    "product_id": "<šio projekto ir aplinkos provider produkto ID>",
    "prices": {
      "eur": "<šio produkto EUR kainos ID>",
      "usd": "<šio produkto USD kainos ID>"
    }
  }
}
```

Tai ryšių registras, o ne kainoraštis: jame nėra sumų ar billing periodų. Checkout pagal šį registrą pasirenka konkretų providerio objektą. Kito projekto arba kitos aplinkos UUID kopijavimas neatlieka produktų sukūrimo naujam projektui.

Originalus scriptas turi `--apply`, `--verify` ir `--out` režimus. Jo tikras vykdymas yra atskiras aplinką keičiantis arba tikrinantis veiksmas; šiame darbe scriptas tik perskaitytas. Jo konfigūracijos skaitymo vietos ir išimtys yra originalaus projekto, todėl prieš naudojant kitame projekte jas reikia pritaikyti bendrinei jo konfigūracijai.

`--verify` kode palyginamos iš providerio perskaitytos kainos su lokaliomis deklaracijomis: sumos, trial sumos, valiutos, default kainos skaičius ir ID susiejimai. Šis patikrinimas padeda aptikti providerio ir kodo skirtumus. Vis dėlto šioje funkcijoje nematyti pilno produkto billing / trial periodo objekto patikrinimo, todėl vien jos sėkmės nepakaktų teigti, kad visos subscription sąlygos patikrintos.

Šaltiniai: [script konfigūracija](/Users/Netas/Projects/theastrologist/scripts/solidgate-seed-catalog.ts:29), [produkto payload](/Users/Netas/Projects/theastrologist/scripts/solidgate-seed-catalog.ts:101), [kainos payload](/Users/Netas/Projects/theastrologist/scripts/solidgate-seed-catalog.ts:134), [verify realizacija](/Users/Netas/Projects/theastrologist/scripts/solidgate-seed-catalog.ts:148), [ID įrašymas](/Users/Netas/Projects/theastrologist/scripts/solidgate-seed-catalog.ts:389).

## 5. Visas naujo main checkout kelias

Toliau aprašomas originalaus projekto `create-session` route. Tai svarbu, nes vien UI kainos perskaitymas dar neparodo visos pinigų judėjimo logikos.

1. **Klientas pasirenka pasiūlymą.** Siunčiamas `productId` ir `sessionId`; serveris patikrina, ar šis main checkout pasiūlymas leidžiamas.
2. **Serveris perskaito sesiją ir ankstesnį checkout.** Jei jau yra pradėtas pirkimas, tikrinama, kad jis susietas su tuo pačiu pasiūlymu.
3. **Naujam checkout parenkama locale.** Ji imama iš DB sesijos. Šiame route įjungtų locale sąrašą riboja `ENABLED_CHECKOUT_LOCALES`; neįjungta locale naujam order pakeičiama į `en`.
4. **Naujam order parenkama suma ir valiuta.** Suma ateina iš `resolveProductPrice(tier, effectiveLocale)`, valiuta — iš locale map.
5. **Parenkamas providerio produktas ir kaina.** `catalog-ids.json[tier].product_id` ir `prices[currency]` nurodo konkrečius providerio objektus. Jei jų nėra, route checkout nestartuoja.
6. **Užfiksuojama pirkimo tapatybė.** Atomic RPC perduodama suma, valiuta, pasiūlymas, canonical produktas, customer, locale, providerio product ID ir tracking metadata su kainos ID.
7. **Sukuriami formos duomenys.** Solidgate payload gauna dabar mokėtiną `amount`, `currency`, `product_id`, `product_price_id` ir order metadata. Providerio produkto / kainos konfigūracija aprašo subscription tęsinį.
8. **Pakartojus tą patį pirkimą naudojami jo išsaugoti duomenys.** Route neleidžia naujausioms kainoms, sesijos locale ar customer pakeitimui tyliai pakeisti jau pradėto order.

EUR `trial1` atveju iš to gaunasi tokia deklaruojama eiga: **€5 dabar → 7 dienų pradinis laikotarpis → €59 kas 30 dienų**, jei locale checkout įjungta ir providerio katalogas atitinka vietines deklaracijas. Šis dokumentas nepatvirtina gyvos providerio konfigūracijos.

Šaltiniai: [input validacija](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/solidgate/create-session/route.ts:259), [ankstesnė identity ir locale](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/solidgate/create-session/route.ts:294), [kainos bei UUID parinkimas](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/solidgate/create-session/route.ts:416), [RPC argumentai](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/solidgate/create-session/route.ts:586), [Solidgate formos payload](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/solidgate/create-session/route.ts:678).

### Kodėl pradėto order kainos snapshot yra būtinas

Tarkime, žmogus pradėjo checkout už €5 ir užstrigo 3DS žingsnyje. Tuo metu komanda pakeitė naujų pirkimų kainą į €6. Grįžimas į tą patį order turi tikrinti ir tęsti jo užfiksuotą €5 kainą, kad abiejų pusių supratimas apie tą mokėjimą liktų vienodas.

Todėl naujo pasiūlymo konfigūracija ir istorinis order snapshot turi skirtingas paskirtis. Kainoraštis parenka sąlygas naujam pirkimui; order išsaugo, kokiomis sąlygomis konkretus pirkimas pradėtas. Originaliame route `existingIdentity` turi pirmenybę parenkant sumą, valiutą, providerio produktą ir price ID. [Retry snapshot naudojimas](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/solidgate/create-session/route.ts:437).

## 6. Kam dar kainos įrašytos SQL

Originaliame projekte main checkout suma yra trijose vietose:

| Vieta | Forma | Paskirtis |
| --- | --- | --- |
| `PRICE_MAP` | Pasiūlymas × locale | UI ir serverio kainos parinkimas |
| `CATALOG_AMOUNTS` | Pasiūlymas × valiuta | Providerio katalogo deklaravimas |
| `solidgate_main_checkout_amount()` | SQL `CASE` pagal pasiūlymą ir valiutą | Naujo main order leistinos sumos tikrinimas DB |

DB patikrinimas atlieka papildomą apsaugą: naujo main order įterpimo metu triggeris iš pasiūlymo ir valiutos gauna tikėtiną sumą. Nežinomą derinį arba nesutampantį `amount_cents` jis atmeta. Priimtą originalią sumą įrašo į `solidgate_original_amount_cents`.

Pavyzdžiui, dabartinėje migracijoje `solidgate_main_checkout_amount('trial1', 'eur')` grąžina `500`. Jei serverio nauja kaina jau `600`, o SQL liko `500`, checkout nepavyks. Tai pagrindžia, kodėl vienos kainos taisymas viename faile čia nėra baigtas pakeitimas.

Šaltiniai: [dabartinis SQL kainų resolveris](/Users/Netas/Projects/theastrologist/supabase/migrations/20260908110000_wave2_currency_amounts.sql:20), [INSERT sumos tikrinimas](/Users/Netas/Projects/theastrologist/supabase/migrations/20260721124000_solidgate_payment_identity.sql:367).

### Ką užtikrina testai ir ko jie neįrodo

`solidgate-catalog.test.ts` tikrina, kad tos pačios valiutos locale turi vienodas sumas ir kad `CATALOG_AMOUNTS` atitinka `PRICE_MAP`. `solidgate-sql-amounts.test.ts` suranda naujausią kainų resolverį apibrėžiančią migraciją, perskaito jos `CASE` reikšmes ir palygina jas su katalogu.

Tai naudingi patikrinimai, bet jie neįrodo, kad migracija pritaikyta gyvai DB ar kad gyvas Solidgate produktas turi teisingą billing periodą ir kainas. Be to, jie neapima kiekvieno ranka įrašyto skaičiaus visuose route. Šio dokumento rengimo metu tie testai nebuvo papildomai paleisti; čia aprašyta jų perskaityta realizacija.

Šaltiniai: [kainų map ir catalog testas](/Users/Netas/Projects/theastrologist/packages/shared/src/__tests__/solidgate-catalog.test.ts:16), [SQL ir catalog testas](/Users/Netas/Projects/theastrologist/packages/shared/src/__tests__/solidgate-sql-amounts.test.ts:26).

## 7. Dabartiniai pavadinimai ir vietos, kurios gali klaidinti

| Vieta | Ką reikia suprasti |
| --- | --- |
| `productId` | Aplikacijos kode dažnai reiškia `trial1` tipo raktą; providerio payload `product_id` reiškia Solidgate UUID. |
| `product_slug` | Order laukelyje gali būti canonical produkto kodas, o `order_metadata.product_slug` — konkretus pasiūlymas, pavyzdžiui, `trial1`. Lauko kontekstą reikia skaityti kartu su reikšme. |
| `productName` | Kainų map išlikęs senasis techninis kodas; naujesnis display name laikomas atskirai. |
| `trial_monthly` | Pagrindinės prenumeratos deklaracija yra kas 30 dienų; vien iš „monthly“ negalima daryti išvados apie kalendorinį mėnesį. |
| `oto2_advisory_monthly` | Dabartiniame kataloge advisory periodas yra savaitė. Rakto pavadinimas neatitinka šios trukmės. |
| `special_free` | Dabartinė vietinė konfigūracija turi apmokamą €1 arba vietinės valiutos intro. `free` pavadinimas yra istorinis. |
| Lifetime produkto `_SUB` kodas | Originaliame verslo kode šis suffix nereiškia, kad checkout periodiškai nurašo pinigus; lifetime įrašytas tarp one-time pasiūlymų. |
| `amountCents` | Tai minor units laukas; ne visoms valiutoms galioja dalyba iš 100. |
| API route naudojamų RPC `_v2` vardai | Vietinės SQL funkcijos versija pati savaime nereiškia Solidgate Billing v2. |

Šaltiniai: [pasiūlymas order metadata](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/solidgate/create-session/route.ts:553), [canonical produktas RPC](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/solidgate/create-session/route.ts:586), [periodai ir istorinis free](/Users/Netas/Projects/theastrologist/packages/shared/src/solidgate/catalog.ts:438), [one-time rinkinys](/Users/Netas/Projects/theastrologist/packages/shared/src/solidgate/catalog.ts:526), [vietinis finalize RPC](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/solidgate/create-session/route.ts:744).

### Advisory neatitikimas: statinio patikrinimo tęsinys

Skaitant originalų kodą aptikta vieta, kurią reikia patikrinti atskirai prieš pernaudojant advisory srautą:

- `initialAmount()` advisory atveju jau ima kainą iš `ADVISORY_TRIAL_INTRO_AMOUNTS`; EUR reikšmė ten yra `100`.
- Toliau tame pačiame OTO route `subscribeSavedCard()` vis dar gauna `expectedAmount: 0` ir šalia turi seną nemokamo trial komentarą.
- `otoProductContext()` analytics kontekste numatytoji advisory initial suma vis dar yra `0`, jei neperduota faktinė suma.

Tai **patvirtintas vietinio kodo reikšmių nesuderinamumas**, bet ši analizė nepatvirtina jo poveikio production ar faktinio providerio nurašymo. Reikia išsekti šių reikšmių naudojimą iki galutinės charge / status validacijos ir patikrinti visą sandbox eigą. Šiame dokumentavimo darbe kodas netaisytas.

Šaltiniai: [initialAmount](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/solidgate/charge-oto/route.ts:249), [subscribeSavedCard expectedAmount](/Users/Netas/Projects/theastrologist/apps/funnel/src/app/api/solidgate/charge-oto/route.ts:1459), [analytics default suma](/Users/Netas/Projects/theastrologist/apps/funnel/src/features/analytics/lib/checkout-context.ts:123).

## 8. Ką siūloma supaprastinti bendriniame modulyje

Toliau yra **projektavimo pasiūlymas, ne įgyvendinto boilerplate aprašymas**. Prieš keičiant tikslinį projektą jį reikia palyginti su ten jau esančia bendrine produktų konfigūracija.

Prasminga turėti vieną autoritetingą pasiūlymų manifestą, kuriame aiškiai atskirti:

- stabilus verslo produkto kodas ir konkretaus pasiūlymo raktas;
- žmogui rodomas pavadinimas ir neprivalomi legacy aliases;
- vienkartinis arba periodinis billing tipas;
- pradinė suma ir jos periodas;
- periodinė suma ir tikslus billing periodas;
- valiutų kainos ir atskira rinkos / locale valiutos parinkimo politika;
- neprivaloma palyginamoji kaina, naudojama UI;
- kokią prieigą suteikia produktas.

Iš šio manifesto būtų gaunami UI kainų duomenys ir Solidgate produktų payload. DB kainų validacijai reikėtų pasirinkti vieną apgalvotą modelį: versijuotas DB pasiūlymų kainas arba iš manifesto generuojamus DB duomenis / migracijas. Tikslas — išlaikyti DB apsaugą ir išvengti rankinio tos pačios sumos įvedimo trijose vietose.

Providerio ID registras turėtų likti atskiras, nes ID sukuriami konkrečiam projektui, aplinkai ir providerio kanalui. Užsakymo snapshot irgi lieka atskiras: jis išsaugo istorinio pirkimo sąlygas net po manifesto pakeitimo. Tokio atskyrimo poreikis nereiškia, kad būtina turėti tris nepriklausomus ranka prižiūrimus kainoraščius.

Prieš aktyvuojant naują pasiūlymą verta patikrinti vieną sutartį: **UI parodyta suma ir periodai = serverio pasirinktos sąlygos = DB užfiksuotos sąlygos = providerio pasirinkto produkto ir kainos sąlygos**. Tada patikrinti retry eigą, kad pradėtas order išlaiko ankstesnę sutartį po naujos kainos paskelbimo.

## 9. Ką kitam agentui iš šios analizės laikyti taisyklėmis

Šis dokumentas padeda suprasti istorinio projekto sprendimus. Jis nėra nurodymas perkelti jo prekių ženklą, produktų kodus, kainas, realius UUID, specialias providerio kanalo išimtis ar visą seną kainų map į boilerplate.

Tolesniam darbui svarbu išlaikyti šias ribas:

1. Naujo projekto konfigūraciją skaityti tiksliniame projekte ir jos veikimą patikrinti atskirai.
2. Aiškiai atskirti pasiūlymą, verslo produktą, providerio produktą, providerio kainą ir istorinio order sąlygas.
3. Naujo pirkimo sumą rinkti serveryje iš leidžiamos konfigūracijos, o pradėto pirkimo retry tęsti pagal jo snapshot.
4. Trial, rebill ir palyginamąją kainą laikyti atskiromis sąvokomis, net jeigu dalis jų skaičių sutampa.
5. Kodo sutapimo testus, DB migracijų pritaikymą ir gyvo providerio katalogo patikrą laikyti trimis atskirais įrodymais.
6. Tęsti su v1 pagal priimtą kryptį; vietinių funkcijų pavadinimų `_v2` nelaikyti sprendimu naudoti Solidgate Billing v2.


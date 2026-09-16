# Naujo appso mokėjimų diegimas: 01–05

Vietinis vedlys: **`http://localhost:3205/documentation/setup`**. Visi žingsniai yra appse, naudoja shadcn ir juodai baltą temą. Dokumentacijos forma tik paruošia agento užduotį. Užpildyti laukai ar nukopijuotas promptas nereiškia, kad providerio katalogas, DB arba mokėjimai jau patikrinti.

## Vykdymo seka ir perdavimas

| Žingsnis | Instrukcija | Privalomas rezultatas kitam agentui |
| --- | --- | --- |
| 01 | [Produktų kūrimas](01-product-creation.lt.md) | `docs/payments/setup/01-provider-manifest.json`: pasirinkti main variantai ir vienas OTO2 produktas, tikri kainų ID, versijos ir patikros būsenos |
| 02 | [Katalogas ir OTO](02-catalog-integration.lt.md) | `02-commerce-contract.json` ir `02-catalog-report.md`: main + OTO, kainos, locale, prieiga, pasirinkta versija, TS ir paruošti SQL pakeitimai |
| 03 | [DB ir webhook](03-database-webhooks.lt.md) | `03-backend-report.md`: migracijų / webhook / worker / pinigų žurnalo ir atribucijos skaitytojų patikra |
| 04 | [Checkout ir OTO](04-checkout-oto.lt.md) | `04-checkout-report.md`: mokėjimo UI ir serveris, 3DS / retry, OTO seka, pilnos atribucijos rašymas |
| 05 | [Sandbox patikra](05-sandbox-verification.lt.md) | `05-verification-report.md`: įrodymų matrica, klaidos ir pakartotinė patikra, aiškiai išvardyti likę nebandyti keliai |

Visi 02–05 rezultatai laikomi target repo `docs/payments/setup/`. Formoje galima pasirinkti kitą 01 manifesto kelią; jis lieka autoritetingas ir kitose instrukcijose pakeičia numatytą kelią, nereikalaujant kopijuoti failo. Skirtingoms aplinkoms / kanalams naudojami atskiri darbo artefaktų rinkiniai. Vėlesnis agentas sutikrina app, aplinką, kanalą, konkrečią `catalog_version` ir ankstesnių ataskaitų aktualumą.

01 formą pildome po kartą kiekvienam norimam main trial variantui ir vienam OTO2 produktui. Kitas vykdymas papildo manifestą, išlaikydamas istorinius įrašus. 02 formoje nurodoma visa pasirinkta pirkimų seka. Vienkartinių OTO kainos pateikiamos aiškiame repo kainyne; failo nuoroda pati savaime kainų nepatvirtina. Jų neįrašius agentas komercinių sumų neišgalvoja.

02–05 laukai bendri ir saugomi tik dabartinėje naršyklėje. Mygtukas „Perimti 01 laukus“ perkelia appso / aplinkos duomenis iš išsaugotos pirmo žingsnio formos; jis neimportuoja providerio rezultatų ir nepakeičia tikro manifesto. Keičiant jau įgyvendintą pasiūlymų planą reikia grįžti į 02 ir iš naujo patikrinti priklausomus žingsnius.

## Vienoda mokėjimų sutartis

- Main variantai yra pagrindinės prenumeratos pasiūlymai, bendrinantys vieną stabilią main prieigą.
- Tarp OTO tik OTO2 yra subscription, turinti atskirą prieigą, subscription_id, trial / renewal ir cancellation. OTO1 bei OTO3–7 yra one_time. OTO3 gali turėti alternatyvius pasirinkimus; OTO8 yra santrauka be mokėjimo.
- Visi main, OTO, PWA, trial ir renewal produktai naudoja tik statinį kanalo / connector Descriptor. Užklausos nesiunčia `dynamic_descriptor` ar produkto suffix; produkto kodas ir locale `order_description` išlieka atskirai.
- Katalogo `offer_key` / `catalog_key` ir `runtime_product_slug` yra atskiri. Pavyzdys: `addon_trial → oto2_addon_weekly`. `_SUB` galūnė pati nenustato mokėjimo tipo.
- Vienas providerio produktas pasiūlymui turi kelių valiutų kainas; locale priskiriama konkrečiam pirkimui pagal galutinį svetainės maršrutą. Istorinės versijos neištrinamos, naujam appso katalogui pasirenkama konkreti versija be latest / first fallback.
- Main Payment Form siunčia produkto ir pasirinktos kainos ID. OTO2 `/recurring` siunčia produkto ID ir valiutą; sumos pagrindu apmokami vienkartiniai OTO siunčia amount ir currency be fiktyvių providerio UUID.
- OTO1 numatyta `after_purchase: grant_only`. Tik aiški lifetime taisyklė leidžia `cancel_main_after_capture`, ir tik po patvirtinto capture bei patikimai išsaugotos to pirkėjo lifetime prieigos. Main cancellation webhook negali panaikinti lifetime prieigos ar OTO2 prenumeratos.
- 03 paruošia DB ir atribucijos skaitytojus, 04 prijungia rašymą. DB laikomi pilni leidžiami first-touch / last-touch ir kanoniniai UTM; providerio metadata telpa į 10 laukų ir 380 simbolių ribas. Ilgam UTM siunčiama tik jau išsaugoto snapshot nuoroda.
- Auth ir Settle nedubliuoja pajamų. Dublikatai bei neaiškūs retry neturi sukurti papildomo nurašymo ar finansinio judėjimo. Teisėtas pakartotinis 3DS grįžimas suderinamas su tuo pačiu order.
- 05 atskiria vietinę logiką, sintetinius įvykius ir realų Solidgate sandbox. Handler testas neįrodo providerio renewal planuoklio. Production diegimas yra atskiras veiksmas.

## Instrukcijų nuoseklumo priežiūra

02–05 turinio šaltinis yra `apps/funnel/src/features/documentation/setup/integration-steps.ts`. Appse rodomas ir kopijuojamas promptas naudoja tą patį tekstą. Markdown failai generuojami vietoje:

```sh
npm run docs:setup:build
npm run docs:setup:check
```

`docs:setup:check` tikrina ir step URL / navigacijos atitikmenis. Jis nepakeičia semantinės mokėjimų peržiūros ar realaus sandbox patikros. 01 dinaminis promptas yra `setup/model.ts`, 02–05 bendro konteksto ir main / OTO taisyklės — `setup/integration-model.ts`.

Nuoseklumo peržiūra: [2026-09-15 rezultatas](CONSISTENCY_2026-09-15.lt.md).

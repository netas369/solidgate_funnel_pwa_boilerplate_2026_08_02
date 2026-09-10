# Quiz backend perdavimas programuotojui

Šis dokumentas paprastai paaiškina, kaip veikia Quiz dalis ir ką reikia pakeisti kuriant naują projektą iš šio boilerplate.

## Kas priklauso Quiz daliai

Quiz dalis atsakinga už:

- vienos quiz sesijos sukūrimą;
- visų dabartinių atsakymų išsaugojimą;
- dabartinio žingsnio išsaugojimą;
- quiz pratęsimą po puslapio perkrovimo;
- atsakymų patikrinimą;
- galutinio rezultato apskaičiavimą serveryje;
- svarbių quiz įvykių įrašymą;
- anoniminės sesijos saugumą.

Quiz dalis neatsakinga už Payment, Solidgate, OTO veikimą, PWA, Support, Admin ekranus, API Gate ar PMC Hub.

## Duomenų bazė

Naudojamos tik dvi lentelės:

```text
sessions
funnel_events
```

`sessions` saugo dabartinę quiz būseną. Viena quiz kelionė visada turi vieną eilutę.

Visi atsakymai laikomi viename `quiz_answers` JSON objekte. Atsakius į naują klausimą, sena eilutė atnaujinama. Nauja atsakymo eilutė nekuriama.

Pavyzdys:

```json
{
  "gender": "female",
  "primaryGoal": "a",
  "challenges": ["o1", "o2"]
}
```

`funnel_events` saugo svarbių veiksmų istoriją. Čia viena nauja eilutė yra normali, nes tai istorija, o ne dabartiniai atsakymai.

Pavyzdžiai:

```text
quiz_started
step_completed
lead_captured
quiz_completed
results_viewed
offer_viewed
offer_accepted
offer_declined
oto_viewed
oto_accepted
oto_declined
checkout_completed
```

Kiekvieno atsakymo paspaudimo į `funnel_events` rašyti nereikia.

## Paprastas veikimo kelias

```text
1. Žmogus atidaro quiz.
2. Backend sukuria vieną sessions eilutę.
3. Žmogus atsako į klausimą.
4. Frontend siunčia visus dabartinius atsakymus.
5. Backend patikrina atsakymus ir atnaujina tą pačią sessions eilutę.
6. Žmogus gali perkrauti puslapį ir tęsti nuo išsaugoto žingsnio.
7. Pabaigoje backend dar kartą patikrina atsakymus.
8. Backend apskaičiuoja rezultatą ir pažymi sesiją kaip completed.
9. Galutinis rezultatas lieka toje pačioje sessions eilutėje.
```

Žodis „snapshot“ Quiz API nebenaudojamas. `save` paprasčiausiai reiškia esamos `sessions` eilutės atnaujinimą.

## Meta botų filtravimas

Tikram lankytojui sesija sukuriama iškart, kai aktyvuojamas Quiz ekranas. Nereikia laukti pirmo mygtuko paspaudimo. Todėl žmogus, kuris atidarė Quiz ir išėjo nieko nepaspaudęs, lieka matomas pirmo ekrano drop-off statistikoje.

Prieš kuriant sesiją backend patikrina `User-Agent`. Žinomi Meta crawleriai, pavyzdžiui `facebookexternalhit`, `meta-webindexer`, `meta-externalads`, `meta-externalagent`, `meta-externalfetcher` ir senas `Facebot`, gauna tuščią `204` atsakymą. Jiems nekuriama `sessions` eilutė, slapukas arba `quiz_started` įvykis.

Tikri žmonės, atidarę reklamą Facebook arba Instagram vidinėje naršyklėje, nėra blokuojami. `fbclid`, Meta referrer, `FBAN`, `FBAV` ir `Instagram` nėra laikomi boto įrodymu.

Šis filtras skirtas švaresnei analitikai, o ne saugumui. Botas gali apsimesti įprasta naršykle, todėl sesijos autorizacija, rate limiting ir kitos apsaugos vis tiek turi veikti atskirai.

## Quiz API

```text
POST /api/quiz/session/create
GET  /api/quiz/session/read
POST /api/quiz/session/save
POST /api/quiz/session/complete
POST /api/quiz/session/link-user
```

- `create` sukuria vieną sesiją.
- `read` saugiai grąžina išsaugotus atsakymus ir dabartinį žingsnį.
- `save` atnaujina visus dabartinius atsakymus toje pačioje eilutėje.
- `complete` patikrina quiz, apskaičiuoja rezultatą ir užbaigia sesiją.
- `link-user` prijungia anoniminę sesiją prie prisijungusio vartotojo.

## Kodėl naudojamas `revision`

Kiekvienas sėkmingas išsaugojimas padidina `revision` skaičių. Tai neleidžia senesnei interneto užklausai perrašyti naujesnių atsakymų.

Jeigu frontend turi `revision = 3`, o duomenų bazėje jau yra `revision = 4`, senas pakeitimas atmetamas. Frontend perskaito naujausius duomenis, sujungia dar neišsaugotus atsakymus ir pabando vieną kartą dar.

## Saugumas

Anoniminė sesija gauna pasirašytą HTTP-only slapuką. Vien sesijos ID neužtenka svetimiems atsakymams perskaityti arba pakeisti.

Reikalingas atskiras aplinkos kintamasis:

```env
QUIZ_SESSION_COOKIE_SECRET=mažiausiai_32_atsitiktiniai_simboliai
```

Jis negali būti toks pats kaip `PAYMENT_COOKIE_SECRET`. Quiz ir Payment turi veikti kaip atskiri moduliai.

## El. pašto perdavimas

Quiz išsaugo el. paštą, sutikimo informaciją ir nustato `welcome_email_pending = true`.

Quiz tiesiogiai nekviečia ActiveCampaign, Resend ar kito tiekėjo. Atskirai el. pašto daliai priklausantis worker turi paimti laukiančius įrašus, išsiųsti arba perduoti kontaktą ir tik po sėkmės nuimti `welcome_email_pending` požymį.

Naršyklėje saugoma nebaigto Quiz būsena automatiškai laikoma nebegaliojančia po 7 dienų. Jei el. pašto išsaugojimas nepavyksta, ekranas lieka atidarytas pakartojimui; atskira nuolatinė el. pašto ir atsakymų kopija nekuriama.

## Ką keisti naujame projekte

Naujo produkto programuotojas turi:

1. Pakeisti klausimų konfigūraciją.
2. Naudoti pastovius, neverčiamus klausimų ir atsakymų kodus.
3. Sukurti naują `quiz_variant` versiją.
4. Pakeisti serverio scoring taisykles.
5. Nustatyti naują `QUIZ_SESSION_COOKIE_SECRET`.
6. Nuspręsti duomenų saugojimo ir ištrynimo terminus.
7. Paleisti automatinius ir duomenų bazės testus.

Jau naudotos `quiz_variant` versijos klausimų reikšmių ir scoring taisyklių tyliai keisti negalima. Seni vartotojai turi būti vertinami pagal tą versiją, su kuria pradėjo quiz.

## Ką patikrinti prieš perdavimą

- Naujas quiz sukuria tik vieną `sessions` eilutę.
- Tikro lankytojo sesija sukuriama nelaukiant pirmo paspaudimo.
- Žinomas Meta crawleris nesukuria sesijos ar `quiz_started` įvykio.
- Facebook ir Instagram vidinės naršyklės nėra klaidingai užblokuojamos.
- Dešimt atsakymų vis tiek palieka tik vieną sesijos eilutę.
- Perkrovus puslapį atsakymai ir žingsnis atsistato.
- Greiti išsaugojimai nepraranda naujausių atsakymų.
- Svetimas session ID be tinkamo slapuko neveikia.
- Quiz pabaiga apskaičiuojama serveryje.
- Pakartotinis `complete` nesukuria antro `quiz_completed` įvykio.
- Quiz kodas nenaudoja Payment slapuko, Solidgate katalogo arba ActiveCampaign kliento.

Tikslūs testai ir jų būsena aprašyti `ACCEPTANCE_CHECKLIST.md` ir `IMPLEMENTATION_STATUS.md`.

## Darbai, priklausantys kitoms komandoms

- Payment backend turi patikimai įrašyti `checkout_completed` tik po mokėjimo tiekėjo patvirtinimo.
- Offer ir OTO dalys turi perkelti savo seną tiesioginį naršyklės įrašymą į saugų backend kelią.
- El. pašto dalis turi apdoroti `welcome_email_pending`.
- API Gate vėliau nuskaitys reikalingus duomenis PMC Hub sistemai.

Šių darbų nereikia įgyvendinti Quiz modulyje, bet jų negalima pamesti bendro projekto perdavimo metu.

# Solidgate auditas ir pataisos

`evidence/` yra nekintantys pradinio audito įrodymai; visi SHA-256 atitinka manifestą. Jo reproduction runner aprašo būseną prieš pataisas ir nėra dabartinio kodo release gate.

`fixes/` saugo pataisyto kodo testus, švaraus diegimo ir senų duomenų migracijos patikras. Pataisų regresijos yra repo Vitest ir SQL testuose.

Aktuali ataskaita: [FIXES_2026-09-14.lt.md](../../docs/solidgate/FIXES_2026-09-14.lt.md).

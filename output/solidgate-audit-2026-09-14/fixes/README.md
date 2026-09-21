# Pataisų patikra — 2026-09-14

**Praėjo:** 1642 Vitest testai (funnel 1032, PWA 249, shared 361), abiejų app TypeScript ir webhook Deno patikros. Tikroje izoliuotoje PostgreSQL DB praėjo visi 11 SQL rinkinių; du konkurencijos rinkiniai pakartoti — iš viso 13 SQL vykdymų. Švarus baseline + abi papildomos migracijos ir atskira migracija su senais duomenimis / pakartojimas patikrinti.

- [Galutinė suvestinė](summary.json)
- [Galutinės SQL patikros](local-sql-20260914T073604Z/summary.json)
- [Senų duomenų migracija](legacy-upgrade-20260914T073603Z/summary.json)
- `funnel-tests.log`, `pwa-tests.log`, `shared-tests.log`: pilni aplikacijų testų rezultatai.
- `funnel-types.log`, `pwa-types.log`: tušti failai reiškia sėkmingą `tsc --noEmit`.
- `webhook-types.log`: `deno check --no-config --no-lock supabase/functions/solidgate-webhooks/index.ts`.

Ankstesni vietinių patikrų katalogai palikti diagnostikai; galutiniai yra aukščiau nurodyti. Schema / testų įėjimo failai ir jų SHA-256 išsaugoti SQL patikros kataloge. Pradinio audito įrodymai atskirti kataloge `../evidence/` ir jų pirminės kontrolinės sumos išliko.

Testai naudojo vietinę DB ir imituotus provider/auth klientus. Production ir realios kortelės nekeistos.

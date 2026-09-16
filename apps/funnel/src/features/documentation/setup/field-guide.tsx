import { ArrowRight, BookOpen, Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';

const fields = [
  { name: 'app_key', purpose: 'Mūsų vidinis appso raktas. Padeda atskirti skirtingų appsų katalogus tame pačiame kanale. Tai mūsų metadata susitarimas, ne privalomas standartinis Solidgate produkto laukas.', example: 'carnivore' },
  { name: 'PRODNAME', purpose: 'Brando / produkto šeimos dalis kode. Ji gali būti bendra keliems trial pasiūlymams; locale ir data pridedami atskirai.', example: 'CARNIVORE → SK_CARNIVORE_260307_SUB' },
  { name: 'offer_key', purpose: 'Providerio produkto katalogo raktas mūsų mappinge. Jis atskiria trial1, trial2 ar kitus pasiūlymus. Checkout slug gali sutapti, tačiau tai nėra privaloma.', example: 'addon_trial' },
  { name: 'product_slug', purpose: 'Checkout pasiūlymo raktas, perduodamas transakcijos metadata. Ryšį su katalogo offer_key išsaugome manifeste; esamam OTO2 šie raktai skiriasi.', example: 'addon_trial → oto2_addon_weekly' },
  { name: 'Prenumeratos vaidmuo / prieiga', purpose: 'Main variantai suteikia vieną stabilią main prieigą. OTO2 turi atskirą addon šeimą ir nepriklausomą prenumeratą. Kiti OTO yra one-time ir pildomi 02 žingsnyje.', example: 'main → main; OTO2 → addon' },
  { name: 'Name', purpose: 'Solidgate produkto pavadinimas kataloge. Ankstesnis labelis „Klientui rodomas pavadinimas“ buvo per platus: šis laukas savaime nekeičia appso kainodaros UI.', example: 'TheAstrologist Monthly (trial1)' },
  { name: 'Public description', purpose: 'Neprivalomas klientui skirtas produkto aprašymas. Solidgate dokumentacija nurodo jo perdavimą bankams ir naudojimą klientų išrašuose bei Solidgate el. pašto kvituose. Tai atskiras laukas nuo Descriptor.', example: 'TheAstrologist Monthly (trial1)' },
];

const metadataExample = JSON.stringify({
  funnel_code: 'funnel_carnivore_v1',
  funnel_variant: 'main',
  price_id: '<selected_price_id>',
  product_code: 'SK_CARNIVORE_260307_SUB',
  product_slug: 'carni_plan_1_week',
  session_id: '<session_id>',
  utm: JSON.stringify({ utm_source: 'facebook', utm_medium: 'paid_social', utm_campaign: 'launch', utm_content: 'video_01', utm_term: 'broad' }),
}, null, 2);

export function SetupFieldGuide() {
  return (
    <div className="mb-8 space-y-6">
      <Card id="setup-field-guide" role="region" aria-labelledby="setup-field-guide-title">
        <CardHeader><CardDescription>LAUKŲ ŽODYNAS</CardDescription><CardTitle><h2 id="setup-field-guide-title">Kas yra šie laukai?</h2></CardTitle><CardDescription className="leading-6">Produkto katalogo nustatymai, konkretaus pirkimo metadata ir banko išrašo tekstas turi atskiras paskirtis.</CardDescription></CardHeader>
        <CardContent className="space-y-5">
          <div className="hidden md:block"><Table><TableHeader><TableRow><TableHead>Laukas</TableHead><TableHead>Ką jis reiškia</TableHead><TableHead>Pavyzdys</TableHead></TableRow></TableHeader><TableBody>{fields.map((field) => <TableRow key={field.name}><TableHead className="align-top" scope="row"><code>{field.name}</code></TableHead><TableCell className="min-w-64 whitespace-normal align-top leading-6">{field.purpose}</TableCell><TableCell className="min-w-44 whitespace-normal align-top"><code>{field.example}</code></TableCell></TableRow>)}</TableBody></Table></div>
          <dl className="space-y-5 md:hidden">{fields.map((field) => <div key={field.name} className="space-y-2 border-b pb-5 last:border-0 last:pb-0"><dt className="text-sm font-semibold"><code>{field.name}</code></dt><dd className="space-y-2 text-sm leading-6"><p>{field.purpose}</p><p className="text-muted-foreground">Pavyzdys: <code className="break-words">{field.example}</code></p></dd></div>)}</dl>
          <p className="text-xs leading-6 text-muted-foreground">Public description paskirtis: <a className="underline underline-offset-4" href="https://docs.solidgate.com/billing/manage-products/products/" target="_blank" rel="noreferrer">Solidgate produkto laukų dokumentacija</a>.</p>
          <Alert><Info /><AlertTitle>Vienas pasiūlymas — vienas Solidgate produktas</AlertTitle><AlertDescription><p><code>trial1</code>, <code>trial2</code> ir <code>special_1eur</code> gali turėti skirtingus produkto UUID ir trial kainas, bet bendrą šeimos kodą <code>THEASTRL_260523_SUB</code>. Kiekviename produkte saugomos jo EUR, USD, TWD, JPY ir kitos kainos.</p><p>SK ir LT gali naudoti tą patį EUR kainos įrašą. Skiriasi pirkimo kodas pagal svetainę: <code>SK_…</code> arba <code>LT_…</code>. Vien dėl locale naujas providerio produktas nekuriamas.</p></AlertDescription></Alert>
          <div className="flex flex-wrap items-center gap-2 text-xs"><Badge variant="outline">Pasiūlymas</Badge><ArrowRight className="size-3.5" /><Badge variant="outline">Solidgate produktas</Badge><ArrowRight className="size-3.5" /><Badge variant="outline">Valiutos kaina</Badge><ArrowRight className="size-3.5" /><Badge>Svetainės locale → pirkimo kodas</Badge></div>
        </CardContent>
      </Card>

      <Card id="setup-transaction-example" role="region" aria-labelledby="setup-transaction-example-title">
        <CardHeader><CardDescription>KATALOGAS IR TRANSAKCIJA</CardDescription><CardTitle><h2 id="setup-transaction-example-title">Kaip perskaityti tavo Hub pavyzdžius</h2></CardTitle><CardDescription className="leading-6">TheAstrologist pavyzdys parodo produkto struktūrą, o Carnivore — pirkimo įrašą. Tai skirtingų appsų pavyzdžiai.</CardDescription></CardHeader>
        <CardContent className="space-y-6">
          <div className="grid gap-5 xl:grid-cols-2">
            <div className="space-y-3"><h3 className="font-semibold">Produkto viduje</h3><dl className="space-y-3 text-sm"><div><dt className="text-muted-foreground">Name</dt><dd>TheAstrologist Monthly (trial1)</dd></div><div><dt className="text-muted-foreground">Description</dt><dd>TheAstrologist Monthly (trial1) — <code>THEASTRL_260523_SUB</code></dd></div><div><dt className="text-muted-foreground">Public description</dt><dd>TheAstrologist Monthly (trial1)</dd></div><div><dt className="text-muted-foreground">Sąlygos</dt><dd>7 dienų mokamas trial, po jo — mokėjimas kas 30 dienų.</dd></div></dl></div>
            <div className="space-y-3"><h3 className="font-semibold">Konkrečiame pirkime</h3><dl className="space-y-3 text-sm"><div><dt className="text-muted-foreground">Description / order_description</dt><dd><code>SK_CARNIVORE_260307_SUB</code></dd></div><div><dt className="text-muted-foreground">Descriptor</dt><dd><code>PMC/CARNIVORE</code> — šio pavyzdžio statinis kanalo banko išrašo identifikatorius, bendras jo produktams.</dd></div><div><dt className="text-muted-foreground">product_slug</dt><dd><code>carni_plan_1_week</code> — pasirinktas pasiūlymas.</dd></div><div><dt className="text-muted-foreground">Auth 5 EUR → Settle 5 EUR</dt><dd>Tai vieno 5 EUR mokėjimo autorizavimas ir užbaigimas. Pajamoms jų nesudedame į 10 EUR.</dd></div></dl></div>
          </div>
          <Table><TableHeader><TableRow><TableHead>To paties trial1 produkto kaina</TableHead><TableHead>Trial → API vienetai</TableHead><TableHead>Renewal → API vienetai</TableHead></TableRow></TableHeader><TableBody>
            <TableRow><TableHead scope="row">EUR</TableHead><TableCell>5.00 → <code>500</code></TableCell><TableCell>59.00 → <code>5900</code></TableCell></TableRow>
            <TableRow><TableHead scope="row">TWD</TableHead><TableCell>185.00 → <code>18500</code></TableCell><TableCell>2182.00 → <code>218200</code></TableCell></TableRow>
            <TableRow><TableHead scope="row">JPY</TableHead><TableCell>926 → <code>926</code></TableCell><TableCell>10932 → <code>10932</code></TableCell></TableRow>
            <TableRow><TableHead scope="row">KRW</TableHead><TableCell>7900 → <code>7900</code></TableCell><TableCell>92900 → <code>92900</code></TableCell></TableRow>
          </TableBody></Table>
          <p className="text-xs leading-6 text-muted-foreground">Tai pateikto produkto kainos, ne numatytasis naujo appso kainoraštis. Tikslinį kanalą, kainas ir ID agentas tikrina atskirai. <a className="underline underline-offset-4" href="https://docs.solidgate.com/payments/payments-insights/supported-currencies/" target="_blank" rel="noreferrer">Valiutų API vienetai</a>.</p>
          <Alert><BookOpen /><AlertTitle>Visiems produktams — tik statinis Descriptor</AlertTitle><AlertDescription>Naudojame vieną statinį kanalo / connector banko išrašo pavadinimą main, OTO, PWA ir renewal mokėjimams. Mokėjimo užklausose dynamic_descriptor ir produkto suffix nesiunčiame. Public description bei locale order_description lieka atskiri laukai; jie nekeičia statinio Descriptor. <a className="underline underline-offset-4" href="https://docs.solidgate.com/payments/payments-insights/billing-descriptor/" target="_blank" rel="noreferrer">Solidgate descriptor taisyklės</a>.</AlertDescription></Alert>
          <div className="space-y-3"><h3 className="font-semibold">Transakcijos metadata ir UTM</h3><p className="text-sm leading-6 text-muted-foreground">Katalogo prenumeratos pirkimui paliekame tavo šešis metadata laukus. Penkis tikrus UTM galima perduoti viename <code>utm</code> tekstiniame lauke kaip JSON — tuomet turime 7 laukus. Žemiau UTM reikšmės yra tik iliustracinės; tikrus duomenis surenka checkout. Trūkstamų UTM neišgalvojame.</p><Textarea aria-label="Transakcijos metadata pavyzdys" value={metadataExample} readOnly rows={13} className="min-h-80 font-mono text-xs leading-6" /></div>
          <Alert><Info /><AlertTitle>API riba: 10 laukų, iki 380 simbolių kiekvienoje reikšmėje</AlertTitle><AlertDescription><p>Šeši esami laukai ir penki atskiri UTM sudarytų 11. Serializuotą <code>utm</code> būtina tikrinti pagal 380 simbolių ribą. Jei netelpa, pirmiausia pilną atribuciją išsaugome DB, tada į Hub siunčiame <code>attribution_id</code> nuorodą į tą įrašą. JSON nekarpome ir atribucijos neprarandame.</p><p><code>traffic_source</code> yra atskiras API laukas šaltiniui, pvz. <code>facebook</code>. Pilni first-touch ir last-touch duomenys turi būti DB; renewal išlaiko pradinio pirkimo ryšį. DB paliekame kanoninius <code>utm_*</code>, o checkout, grant ir webhook skaitytojai turi palaikyti seną bei naują providerio formatą. Tai būsimo checkout žingsnio užduotis.</p></AlertDescription></Alert>
          <p className="text-xs leading-6 text-muted-foreground"><a className="underline underline-offset-4" href="https://docs.solidgate.com/payments/integrate/payment-form/create-your-payment-form/" target="_blank" rel="noreferrer">Oficialus order_metadata ir traffic_source kontraktas</a>. Dabartinis boilerplate dar siunčia 5 fiksuotus metadata laukus ir 5 UTM; pilno product_code ir serverio first/last-touch snapshot papildymą įtraukiame į būsimą checkout žingsnį. Ši forma to runtime pakeitimo neatlieka.</p>
        </CardContent>
      </Card>
    </div>
  );
}

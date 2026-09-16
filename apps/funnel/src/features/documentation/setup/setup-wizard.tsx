'use client';

import { useMemo, useRef, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowRight, Check, CircleCheck, Copy, Download, FlaskConical, FolderOpen, Globe2, Plus, RotateCcw, Save, Sparkles, Trash2 } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { NativeSelect, NativeSelectOption } from '@/components/ui/native-select';
import { Separator } from '@/components/ui/separator';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import { setupCopy as copy } from './copy';
import {
  CURRENCIES, LOCALE_PRESETS, buildAgentPrompt, createExampleSetupConfig, createInitialSetupConfig,
  createLocaleRow, makeBaseProductCode, makeProductCode, parseMoneyToMinor, resolvePurchaseLocale, validateSetupConfig,
  type Currency, type SetupConfig, type SetupLocaleRow, type SetupPriceRow,
} from './model';

const periodLabels = { day: 'dienos', week: 'savaitės', month: 'kalendoriniai mėnesiai', year: 'metai' } as const;
const DRAFT_KEY = 'solidgate-documentation-setup-v2';
const LEGACY_DRAFT_KEY = 'solidgate-documentation-setup-v1';

function isSetupDraft(value: unknown): value is Omit<SetupConfig, 'defaultCurrency'> & { defaultCurrency?: Currency } {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (!['appName', 'appKey', 'productName', 'batchDate', 'offerKey', 'displayName', 'publicDescription', 'channelReference'].every((key) => typeof candidate[key] === 'string')) return false;
  if (!['sandbox', 'production'].includes(String(candidate.environment)) || typeof candidate.includePayPal !== 'boolean') return false;
  if (candidate.defaultCurrency !== undefined && !CURRENCIES.some((currency) => currency.code === candidate.defaultCurrency)) return false;
  if (candidate.subscriptionRole !== undefined && !['main', 'oto'].includes(String(candidate.subscriptionRole))) return false;
  for (const field of ['checkoutProductSlug', 'entitlementKey']) {
    if (candidate[field] !== undefined && typeof candidate[field] !== 'string') return false;
  }
  for (const field of ['websiteUrl', 'funnelCode', 'funnelVariant', 'billingDescriptor']) {
    if (candidate[field] !== undefined && typeof candidate[field] !== 'string') return false;
  }
  if (candidate.additionalPrices !== undefined) {
    if (!Array.isArray(candidate.additionalPrices)) return false;
    const priceIds = new Set<string>();
    for (const price of candidate.additionalPrices) {
      if (typeof price !== 'object' || price === null || !['id', 'introMajor', 'renewalMajor'].every((field) => typeof price[field] === 'string')) return false;
      if (!price.id || priceIds.has(price.id) || !CURRENCIES.some((currency) => currency.code === price.currency)) return false;
      priceIds.add(price.id);
    }
  }
  for (const field of ['billing', 'trial']) {
    const period = candidate[field] as Record<string, unknown> | null;
    if (!period || !Object.hasOwn(periodLabels, String(period.unit)) || typeof period.count !== 'number' || !Number.isFinite(period.count)) return false;
  }
  if (!['paid', 'free', 'none'].includes(String((candidate.trial as Record<string, unknown>).kind))) return false;
  if (!Array.isArray(candidate.locales) || !candidate.locales.length) return false;
  const ids = new Set<string>();
  return candidate.locales.every((row: unknown) => {
    if (typeof row !== 'object' || row === null) return false;
    const locale = row as Record<string, unknown>;
    if (!['id', 'urlSegment', 'internalLocale', 'codePrefix', 'introMajor', 'renewalMajor'].every((key) => typeof locale[key] === 'string')) return false;
    if (!Array.isArray(locale.aliases) || !locale.aliases.every((alias) => typeof alias === 'string') || !CURRENCIES.some((currency) => currency.code === locale.currency)) return false;
    if (!locale.id || ids.has(locale.id as string)) return false;
    ids.add(locale.id as string);
    return true;
  });
}

function Field({ id, label, hint, children, wide = false }: { id: string; label: string; hint?: string; children: ReactNode; wide?: boolean }) {
  return <div className={`setup-field${wide ? ' is-wide' : ''}`}><Label htmlFor={id}>{label}</Label>{children}{hint ? <small id={`${id}-hint`}>{hint}</small> : null}</div>;
}

function MoneyPreview({ value, currency }: { value: string; currency: Currency }) {
  if (!value.trim()) return <span className="setup-minor-placeholder">Įrašyk sumą</span>;
  let minor: number | null = null;
  try { minor = parseMoneyToMinor(value, currency); } catch { /* An incomplete amount is a normal form state. */ }
  return minor === null ? <span className="setup-minor-invalid">Patikrink sumos formatą</span> : <span><strong>{minor}</strong> <small>minor units</small></span>;
}

function productCode(config: SetupConfig, row: SetupLocaleRow) {
  try { return makeProductCode(config, row); } catch { return `${row.codePrefix || '{LOCALE}'}_${config.productName || '{PRODNAME}'}_{YYMMDD}_SUB`; }
}

function baseProductCode(config: SetupConfig) {
  try { return makeBaseProductCode(config); } catch { return `${config.productName || '{PRODNAME}'}_{YYMMDD}_SUB`; }
}

function downloadFile(content: string, name: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function SetupWizard() {
  const [config, setConfig] = useState(createInitialSetupConfig);
  const [status, setStatus] = useState('');
  const [draftStatus, setDraftStatus] = useState('Laukus gali išsaugoti šioje naršyklėje ir atkurti kitą kartą.');
  const [nextLocale, setNextLocale] = useState('lt');
  const [nextCurrency, setNextCurrency] = useState<Currency>('EUR');
  const [testPath, setTestPath] = useState('/cz/quiz');
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const validation = useMemo(() => validateSetupConfig(config), [config]);
  const prompt = useMemo(() => validation.valid ? buildAgentPrompt(config) : '', [config, validation.valid]);
  const baseCode = baseProductCode(config);
  const proposedDescription = `${config.displayName.trim() || '{Name}'} — ${baseCode}`;
  const currencyCount = new Set([...config.locales, ...(config.additionalPrices ?? [])].map((row) => row.currency)).size;
  const resolvedLocale = resolvePurchaseLocale(testPath, config.locales, { defaultLocale: 'en', unprefixedPaths: ['/quiz', '/offer', '/checkout'] });

  function issueContext(path: string) {
    if (path.startsWith('prices.')) return `${path.slice(7)} bendra valiutos kaina: `;
    const priceParts = /^additionalPrices\.(\d+)\.(.+)$/.exec(path);
    if (priceParts) {
      const row = config.additionalPrices?.[Number(priceParts[1])];
      const amount = priceParts[2] === 'introMajor' ? ' · pradinis mokėjimas' : priceParts[2] === 'renewalMajor' ? ' · pratęsimas' : '';
      return `${row?.currency ?? `Kaina ${Number(priceParts[1]) + 1}`}${amount}: `;
    }
    const parts = /^locales\.(\d+)\.(.+)$/.exec(path);
    if (!parts) return '';
    const row = config.locales[Number(parts[1])];
    if (!row) return '';
    const amount = parts[2] === 'introMajor' ? ' · pradinis mokėjimas' : parts[2] === 'renewalMajor' ? ' · pratęsimas' : '';
    return `${row.codePrefix || `Locale ${Number(parts[1]) + 1}`} / ${row.currency}${amount}: `;
  }

  function update(values: Partial<SetupConfig>) {
    setConfig((previous) => ({ ...previous, ...values }));
    setStatus('');
  }

  function updateLocale(id: string, values: Partial<SetupLocaleRow>) {
    setConfig((previous) => ({ ...previous, locales: previous.locales.map((row) => row.id === id ? { ...row, ...values } : row) }));
    setStatus('');
  }

  function updatePrice(id: string, values: Partial<SetupPriceRow>) {
    setConfig((previous) => ({ ...previous, additionalPrices: (previous.additionalPrices ?? []).map((row) => row.id === id ? { ...row, ...values } : row) }));
    setStatus('');
  }

  function saveDraft() {
    try {
      window.localStorage.setItem(DRAFT_KEY, JSON.stringify({ version: 2, config }));
      setDraftStatus('Išsaugota šioje naršyklėje. Pakeitus laukus, išsaugok dar kartą.');
    } catch {
      setDraftStatus('Naršyklė neleido išsaugoti. Užpildytą konfigūraciją gali atsisiųsti kaip JSON.');
    }
  }

  function restoreDraft() {
    try {
      const raw = window.localStorage.getItem(DRAFT_KEY) ?? window.localStorage.getItem(LEGACY_DRAFT_KEY);
      if (!raw) { setDraftStatus('Šioje naršyklėje išsaugotų laukų dar nėra.'); return; }
      const saved: unknown = JSON.parse(raw);
      if (typeof saved !== 'object' || saved === null || !('version' in saved) || (saved.version !== 1 && saved.version !== 2) || !('config' in saved) || !isSetupDraft(saved.config) || (saved.version === 2 && saved.config.defaultCurrency === undefined)) {
        setDraftStatus('Išsaugotų laukų formatas neatitinka šio vedlio. Dabartiniai laukai nepakeisti.');
        return;
      }
      setConfig({ ...createInitialSetupConfig(), ...saved.config, defaultCurrency: saved.config.defaultCurrency ?? 'EUR' });
      setStatus('');
      setDraftStatus(saved.config.subscriptionRole === undefined
        ? 'Atkurtas ankstesnis juodraštis. Prenumeratos vaidmuo nustatytas į main: patikrink vaidmenį, checkout slug, prieigos šeimą ir numatytąją valiutą prieš vykdydamas promptą.'
        : saved.version === 1
        ? 'Atkurtas ankstesnis juodraštis: visi tavo laukai ir kainos išsaugoti. Dabar vienas pasiūlymas yra vienas Solidgate produktas. Patikrink vienodas valiutų kainas ir naują numatytąją EUR valiutą, tada išsaugok iš naujo.'
        : 'Atkurti šioje naršyklėje išsaugoti laukai.');
    } catch {
      setDraftStatus('Nepavyko perskaityti išsaugotų laukų. Dabartiniai laukai nepakeisti.');
    }
  }

  function clearDraft() {
    setConfig(createInitialSetupConfig());
    setStatus('');
    try { window.localStorage.removeItem(DRAFT_KEY); window.localStorage.removeItem(LEGACY_DRAFT_KEY); setDraftStatus('Laukai ir šioje naršyklėje išsaugoti juodraščiai išvalyti.'); }
    catch { setDraftStatus('Puslapio laukai išvalyti. Naršyklė neleido pašalinti išsaugoto juodraščio.'); }
  }

  async function copyPrompt() {
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setStatus('Promptas nukopijuotas. Gali perduoti jį agentui.');
    } catch {
      promptRef.current?.focus();
      promptRef.current?.select();
      try {
        if (document.execCommand('copy')) { setStatus('Promptas nukopijuotas. Gali perduoti jį agentui.'); return; }
      } catch { /* The selected textarea remains available for manual copying. */ }
      setStatus('Pažymėjome promptą. Nukopijuok su Ctrl+C arba ⌘C.');
    }
  }

  return (
    <>
      <form className="setup-form" onSubmit={(event) => event.preventDefault()}>
        <Card role="region" id="setup-fields" className="setup-panel" aria-labelledby="setup-fields-title"><CardContent className="setup-panel-content">
          <div className="setup-panel-header"><div><span className="setup-kicker">A · PASIŪLYMAS</span><h2 id="setup-fields-title">Produkto laukai</h2><p>Vienas pildymas skirtas vienam pasiūlymui ir vienam Solidgate produktui su keliomis valiutų kainomis. Kitas trial variantas turi atskirą <code>offer_key</code>, bet gali naudoti tą patį <code>PRODNAME</code>.</p></div><div className="setup-form-actions"><Button variant="outline" type="button" onClick={() => { setConfig(createExampleSetupConfig()); setTestPath('/cz/quiz'); setDraftStatus('Įkeltas pavyzdys. Įrašyk savo Solidgate kanalą ir pakeisk laukus pagal savo appsą.'); setStatus(''); }}><Sparkles size={16} />Įkelti pavyzdį</Button><Button variant="ghost" size="sm" className="setup-reset" type="button" onClick={clearDraft}><RotateCcw size={15} />Išvalyti</Button></div></div>
          <div className="setup-draft-bar"><Button variant="ghost" type="button" onClick={saveDraft}><Save size={15} />Išsaugoti laukus</Button><Button variant="ghost" type="button" onClick={restoreDraft}><FolderOpen size={15} />Atkurti išsaugotus</Button><span role="status" aria-live="polite">{draftStatus}</span></div>
          <div className="setup-fields-grid">
            <Field id="setup-app-name" label="Appso pavadinimas" hint="Naudojamas konfigūracijai ir agento kontekstui."><Input id="setup-app-name" value={config.appName} onChange={(event) => update({ appName: event.target.value })} placeholder="MyApp" autoComplete="off" required /></Field>
            <Field id="setup-app-key" label="Vidinis appso kodas (app_key)" hint="Boilerplate identifikatorius, pvz. CARNIVORE. Padeda nepernaudoti kito appso produktų; tai nėra privalomas Solidgate API laukas."><Input id="setup-app-key" value={config.appKey} onChange={(event) => update({ appKey: event.target.value })} placeholder="MYAPP" autoComplete="off" spellCheck={false} required /></Field>
            <Field id="setup-product-name" label="Prekės ženklo / produkto šeimos kodas (PRODNAME)" hint="Pvz. CARNIVORE arba THEASTRL. Tas pats kodas gali būti keliems trial variantams; variantą atskiria offer_key."><Input id="setup-product-name" value={config.productName} onChange={(event) => update({ productName: event.target.value })} placeholder="MEMREPL" autoComplete="off" spellCheck={false} required /></Field>
            <Field id="setup-batch-date" label="Katalogo data" hint="2026-05-10 → 260510. Tai fiksuota versijos data."><Input id="setup-batch-date" type="date" value={config.batchDate} onChange={(event) => update({ batchDate: event.target.value })} required /></Field>
            <Field id="setup-role" label="Prenumeratos vaidmuo" hint="Šią formą pakartok main variantams ir vienam OTO2 produktui. Kiti OTO yra vienkartiniai; juos aprašysi 02 žingsnyje."><NativeSelect id="setup-role" className="w-full" value={config.subscriptionRole ?? 'main'} onChange={(event) => { const subscriptionRole = event.target.value as 'main' | 'oto'; update({ subscriptionRole, entitlementKey: subscriptionRole === 'oto' ? 'addon' : 'main', checkoutProductSlug: subscriptionRole === 'oto' ? 'oto2_addon_weekly' : '' }); }}><NativeSelectOption value="main">Main — pagrindinė prenumerata</NativeSelectOption><NativeSelectOption value="oto">OTO2 — atskira prenumerata</NativeSelectOption></NativeSelect></Field>
            <Field id="setup-offer-key" label="Katalogo pasiūlymo raktas (offer_key)" hint="Solidgate produkto catalog_key mūsų mappinge. Main atveju gali sutapti su checkout slug; OTO2 pavyzdys: addon_trial."><Input id="setup-offer-key" value={config.offerKey} onChange={(event) => update({ offerKey: event.target.value })} placeholder="carni_plan_1_week" autoComplete="off" spellCheck={false} required /></Field>
            <Field id="setup-checkout-slug" label="Checkout pasiūlymas (product_slug)" hint="Transakcijos metadata raktas. Main palikus tuščią naudojamas offer_key. OTO2 nurodyk atskirai, pvz. oto2_addon_weekly."><Input id="setup-checkout-slug" value={config.checkoutProductSlug ?? ''} onChange={(event) => update({ checkoutProductSlug: event.target.value })} placeholder={config.subscriptionRole === 'oto' ? 'oto2_addon_weekly' : config.offerKey} autoComplete="off" spellCheck={false} /></Field>
            <Field id="setup-entitlement" label="Stabili prieigos šeima" hint="Main trial variantai bendrina main prieigą. OTO2 naudoja kitą šeimą, pvz. addon, ir turi atskirą subscription_id."><Input id="setup-entitlement" value={config.entitlementKey ?? 'main'} onChange={(event) => update({ entitlementKey: event.target.value })} placeholder="main arba addon" autoComplete="off" spellCheck={false} required /></Field>
            <Field id="setup-display-name" label="Solidgate produkto pavadinimas (Name)" hint="Produkto Name laukas Solidgate Hub, pvz. Carnivore trial1. Tai nėra transakcijos kodas."><Input id="setup-display-name" value={config.displayName} onChange={(event) => update({ displayName: event.target.value })} placeholder="MyApp Premium" autoComplete="off" required /></Field>
            <Field id="setup-description" label="Viešas produkto aprašymas (Public description, neprivalomas)" hint="Iki 100 simbolių. Gali būti naudojamas bankų, klientų išrašuose ir kvituose. Atskiras laukas nuo transakcijos order_description ir banko descriptor nustatymo." wide><Textarea id="setup-description" value={config.publicDescription} onChange={(event) => update({ publicDescription: event.target.value })} placeholder="MyApp Premium prenumerata" rows={2} maxLength={100} /></Field>
            <Field id="setup-environment" label="Solidgate aplinka"><NativeSelect className="w-full" id="setup-environment" value={config.environment} onChange={(event) => update({ environment: event.target.value as SetupConfig['environment'] })}><NativeSelectOption value="sandbox">Sandbox — testavimui</NativeSelectOption><NativeSelectOption value="production">Production — realiems mokėjimams</NativeSelectOption></NativeSelect></Field>
            <Field id="setup-channel" label="Solidgate kanalas" hint="Kanalo pavadinimas arba ID iš Hub. API raktų čia nereikia."><Input id="setup-channel" value={config.channelReference} onChange={(event) => update({ channelReference: event.target.value })} placeholder="Kanalo pavadinimas arba ID" autoComplete="off" spellCheck={false} required /></Field>
            <Field id="setup-default-currency" label="Numatytoji produkto valiuta (Default currency)" hint="Turi turėti kainą šiame plane. Tai nėra taisyklė visiems klientams mokėti ta pačia valiuta."><NativeSelect className="w-full" id="setup-default-currency" value={config.defaultCurrency} onChange={(event) => update({ defaultCurrency: event.target.value as Currency })}>{CURRENCIES.map((currency) => <NativeSelectOption key={currency.code} value={currency.code}>{currency.code} · {currency.label}</NativeSelectOption>)}</NativeSelect></Field>
            <Field id="setup-base-code" label="Bazinis kodas be locale" hint="Bendra produkto šeimos ir katalogo versija. Trial variantą papildomai identifikuoja offer_key."><Input id="setup-base-code" value={baseCode} readOnly spellCheck={false} /></Field>
            <Field id="setup-internal-description" label="Siūlomas vidinis produkto aprašymas (Description)" hint="Sugeneruota iš Name ir bazinio kodo. Public description aukščiau yra atskiras laukas." wide><Input id="setup-internal-description" value={proposedDescription} readOnly /></Field>
          </div>
          <Collapsible><CollapsibleTrigger render={<Button type="button" variant="ghost" className="h-auto justify-start whitespace-normal text-left" />}><ArrowDown size={15} />Papildomas svetainės ir funnel kontekstas</CollapsibleTrigger><CollapsibleContent><div className="setup-fields-grid setup-optional-fields">
            <Field id="setup-website-url" label="Svetainės URL" hint="Nebūtina. Produkto svetainė, pvz. https://example.com."><Input id="setup-website-url" type="url" value={config.websiteUrl ?? ''} onChange={(event) => update({ websiteUrl: event.target.value })} placeholder="https://example.com" autoComplete="off" /></Field>
            <Field id="setup-funnel-code" label="Funnel kodas (funnel_code)" hint="Nebūtina produkto kūrimui. Checkout metadata kontekstas, ne naujas Solidgate produktas."><Input id="setup-funnel-code" value={config.funnelCode ?? ''} onChange={(event) => update({ funnelCode: event.target.value })} placeholder="main_funnel" autoComplete="off" spellCheck={false} /></Field>
            <Field id="setup-funnel-variant" label="Funnel variantas (funnel_variant)" hint="Nebūtina. Piltuvėlio variantas, pvz. a arba quiz_v2."><Input id="setup-funnel-variant" value={config.funnelVariant ?? ''} onChange={(event) => update({ funnelVariant: event.target.value })} placeholder="a" autoComplete="off" spellCheck={false} /></Field>
            <Field id="setup-billing-descriptor" label="Statinis kanalo descriptor" hint="Nebūtina. Laukiamas statinis banko išrašo pavadinimas, bendras visiems šio kanalo produktams. Tik patikros nuoroda; mokėjimo request jo nesiunčia ir neprideda produkto suffix."><Input id="setup-billing-descriptor" value={config.billingDescriptor ?? ''} onChange={(event) => update({ billingDescriptor: event.target.value })} placeholder="Banke laukiamas pavadinimas" autoComplete="off" /></Field>
          </div></CollapsibleContent></Collapsible>
          <div className="setup-period-grid">
            <fieldset className="setup-period"><legend>Pratęsimas</legend><div className="setup-period-controls"><Field id="setup-billing-count" label="Kas"><Input id="setup-billing-count" type="number" min={1} step={1} value={config.billing.count || ''} onChange={(event) => update({ billing: { ...config.billing, count: Number(event.target.value) } })} required /></Field><Field id="setup-billing-unit" label="Laikotarpis"><NativeSelect className="w-full" id="setup-billing-unit" value={config.billing.unit} onChange={(event) => update({ billing: { ...config.billing, unit: event.target.value as SetupConfig['billing']['unit'] } })}>{Object.entries(periodLabels).map(([value, label]) => <NativeSelectOption value={value} key={value}>{label}</NativeSelectOption>)}</NativeSelect></Field></div><p>30 dienų ir 1 kalendorinis mėnuo yra skirtingi periodai.</p></fieldset>
            <fieldset className="setup-period"><legend>Trial / pradinis periodas</legend><Field id="setup-trial-kind" label="Pradžios sąlygos"><NativeSelect className="w-full" id="setup-trial-kind" value={config.trial.kind} onChange={(event) => { const kind = event.target.value as SetupConfig['trial']['kind']; update({ trial: { ...config.trial, kind }, ...(kind !== 'paid' ? { locales: config.locales.map((row) => ({ ...row, introMajor: kind === 'free' ? '0' : '' })), additionalPrices: (config.additionalPrices ?? []).map((row) => ({ ...row, introMajor: kind === 'free' ? '0' : '' })) } : {}) }); }}><NativeSelectOption value="paid">Mokamas pradinis periodas</NativeSelectOption><NativeSelectOption value="free">Nemokamas trial</NativeSelectOption><NativeSelectOption value="none">Be trial — įprasta kaina iškart</NativeSelectOption></NativeSelect></Field>{config.trial.kind !== 'none' ? <div className="setup-period-controls"><Field id="setup-trial-count" label="Trukmė"><Input id="setup-trial-count" type="number" min={1} step={1} value={config.trial.count || ''} onChange={(event) => update({ trial: { ...config.trial, count: Number(event.target.value) } })} required /></Field><Field id="setup-trial-unit" label="Laikotarpis"><NativeSelect className="w-full" id="setup-trial-unit" value={config.trial.unit} onChange={(event) => update({ trial: { ...config.trial, unit: event.target.value as SetupConfig['trial']['unit'] } })}>{Object.entries(periodLabels).map(([value, label]) => <NativeSelectOption value={value} key={value}>{label}</NativeSelectOption>)}</NativeSelect></Field></div> : <p>Pirmas mokėjimas lygus žemiau nurodytai pratęsimo kainai.</p>}</fieldset>
          </div>
          <div className="setup-checkbox"><Checkbox id="setup-paypal" checked={config.includePayPal} onCheckedChange={(checked) => update({ includePayPal: checked })} /><div><Label htmlFor="setup-paypal">Numatyti ir PayPal</Label><p>TWD, HUF ir RSD PayPal sumos turi būti sveiki pagrindiniai vienetai, pvz. 100, o ne 100.50.</p></div></div>
          <Alert role="note"><FlaskConical size={17} /><AlertDescription>{config.environment === 'sandbox' ? 'Pradedame sandbox aplinkoje. Šis puslapis paruošia tekstinę užduotį agentui.' : 'Pasirinkta production aplinka. Promptas nurodys agentui patikrinti realų kanalą prieš produktų kūrimą.'}</AlertDescription></Alert>
        </CardContent></Card>

        <Card role="region" id="setup-locales" className="setup-panel" aria-labelledby="setup-locales-title"><CardContent className="setup-panel-content">
          <div className="setup-panel-header"><div><span className="setup-kicker">B · LOCALE IR VALIUTŲ ATITIKMENYS</span><h2 id="setup-locales-title">Vienas produktas, keli checkout locale</h2><p>Locale parenka valiutos kainą ir transakcijos kodo prefiksą. Jei keli locale naudoja tą pačią valiutą, jų kainos turi sutapti — Solidgate sukuriama viena tos valiutos kaina. Sumoms naudok tašką: <code>5.99</code>.</p></div><Badge variant="outline">{config.locales.length} locale</Badge></div>
          <div className="setup-product-summary" aria-label="Kuriamo katalogo santrauka"><Badge>1 Solidgate produktas</Badge><Badge variant="outline">{currencyCount} valiutų kainos</Badge><Badge variant="outline">{config.locales.length} checkout locale</Badge></div>
          <div className="setup-locale-list">
            {config.locales.map((row, index) => (
              <Card className="setup-locale-card" key={row.id}><CardContent><fieldset className="setup-locale-group">
                <legend><Globe2 size={16} /> Checkout locale {String(index + 1).padStart(2, '0')}</legend>
                <div className="setup-locale-top"><code>{productCode(config, row)}</code><Button variant="ghost" size="sm" className="setup-remove" type="button" aria-label={`Pašalinti locale ${row.codePrefix || index + 1}`} onClick={() => update({ locales: config.locales.filter((item) => item.id !== row.id) })} disabled={config.locales.length === 1}><Trash2 size={15} /><span>Pašalinti</span></Button></div>
                <div className="setup-locale-fields">
                  <Field id={`${row.id}-url`} label="URL locale" hint="Be /, pvz. cz."><Input id={`${row.id}-url`} value={row.urlSegment} onChange={(event) => updateLocale(row.id, { urlSegment: event.target.value })} placeholder="cz" autoComplete="off" spellCheck={false} required /></Field>
                  <Field id={`${row.id}-internal`} label="Vidinis appso locale" hint="Pvz. cs arba zh-TW."><Input id={`${row.id}-internal`} value={row.internalLocale} onChange={(event) => updateLocale(row.id, { internalLocale: event.target.value })} placeholder="cs" autoComplete="off" spellCheck={false} required /></Field>
                  <Field id={`${row.id}-prefix`} label="Transakcijos kodo prefiksas" hint="Iš website locale, pvz. CZ. Solidgate produkto UUID nuo locale nesikeičia."><Input id={`${row.id}-prefix`} value={row.codePrefix} onChange={(event) => updateLocale(row.id, { codePrefix: event.target.value })} placeholder="CZ" autoComplete="off" spellCheck={false} required /></Field>
                  <Field id={`${row.id}-currency`} label="Valiuta"><NativeSelect className="w-full" id={`${row.id}-currency`} value={row.currency} onChange={(event) => updateLocale(row.id, { currency: event.target.value as Currency })}>{CURRENCIES.map((currency) => <NativeSelectOption key={currency.code} value={currency.code}>{currency.code} · {currency.label}</NativeSelectOption>)}</NativeSelect></Field>
                  <Field id={`${row.id}-aliases`} label="Papildomi URL atitikmenys" hint="Nebūtina. Atskirk kableliais, pvz. cs."><Input id={`${row.id}-aliases`} value={row.aliases.join(', ')} onChange={(event) => updateLocale(row.id, { aliases: event.target.value.trim() === '' ? [] : event.target.value.split(',').map((alias) => alias.trim()) })} placeholder="cs" autoComplete="off" spellCheck={false} /></Field>
                  <Field id={`${row.id}-intro`} label={config.trial.kind === 'none' ? 'Pirmas mokėjimas' : 'Pradinio periodo kaina'} hint={config.trial.kind === 'none' ? 'Sutampa su pratęsimo kaina.' : config.trial.kind === 'free' ? 'Nemokamas trial: 0.' : `Pagrindiniais ${row.currency} vienetais.`}><Input id={`${row.id}-intro`} inputMode="decimal" value={config.trial.kind === 'none' ? row.renewalMajor : config.trial.kind === 'free' ? '0' : row.introMajor} onChange={(event) => updateLocale(row.id, { introMajor: event.target.value })} readOnly={config.trial.kind !== 'paid'} placeholder="5.00" autoComplete="off" required /></Field>
                  <Field id={`${row.id}-renewal`} label="Pratęsimo kaina" hint={`Pagrindiniais ${row.currency} vienetais.`}><Input id={`${row.id}-renewal`} inputMode="decimal" value={row.renewalMajor} onChange={(event) => updateLocale(row.id, { renewalMajor: event.target.value })} placeholder="29.00" autoComplete="off" required /></Field>
                </div>
                <Separator /><div className="setup-minor-preview"><span>Solidgate API <ArrowRight size={14} /></span><div><small>Pirmas mokėjimas</small><MoneyPreview value={config.trial.kind === 'none' ? row.renewalMajor : config.trial.kind === 'free' ? '0' : row.introMajor} currency={row.currency} /></div><div><small>Pratęsimas</small><MoneyPreview value={row.renewalMajor} currency={row.currency} /></div><Badge variant="outline">{row.currency}</Badge></div>
              </fieldset></CardContent></Card>
            ))}
          </div>
          <div className="setup-add-locale"><Label htmlFor="setup-add-preset">Pridėti locale</Label><NativeSelect className="w-full" id="setup-add-preset" value={nextLocale} onChange={(event) => setNextLocale(event.target.value)}>{LOCALE_PRESETS.map((preset) => <NativeSelectOption key={preset.urlSegment} value={preset.urlSegment}>/{preset.urlSegment} · {preset.codePrefix} · {preset.currency}</NativeSelectOption>)}</NativeSelect><Button variant="outline" type="button" onClick={() => { const preset = LOCALE_PRESETS.find((item) => item.urlSegment === nextLocale); update({ locales: [...config.locales, { ...createLocaleRow(preset), id: `locale-${crypto.randomUUID()}` }] }); }}><Plus size={16} />Pridėti</Button></div>
          <Separator />
          <section className="setup-additional-prices" aria-labelledby="setup-additional-prices-title">
            <div className="setup-section-heading"><h3 id="setup-additional-prices-title">Papildomos valiutų kainos</h3><p>Gali iškart paruošti visas produkto valiutas, net jei joms dar nėra atskiro svetainės locale. Papildoma kaina priklauso tam pačiam Solidgate produktui.</p></div>
            <div className="setup-extra-price-list">{(config.additionalPrices ?? []).map((row, index) => <Card key={row.id}><CardContent><fieldset className="setup-locale-group"><legend>Papildoma kaina {index + 1}</legend><div className="setup-extra-price-fields">
              <Field id={`${row.id}-currency`} label="Valiuta"><NativeSelect className="w-full" id={`${row.id}-currency`} value={row.currency} onChange={(event) => updatePrice(row.id, { currency: event.target.value as Currency })}>{CURRENCIES.map((currency) => <NativeSelectOption key={currency.code} value={currency.code}>{currency.code} · {currency.label}</NativeSelectOption>)}</NativeSelect></Field>
              <Field id={`${row.id}-intro`} label={config.trial.kind === 'none' ? 'Pirmas mokėjimas' : 'Pradinio periodo kaina'} hint={config.trial.kind === 'none' ? 'Sutampa su pratęsimo kaina.' : config.trial.kind === 'free' ? 'Nemokamas trial: 0.' : `Pagrindiniais ${row.currency} vienetais.`}><Input id={`${row.id}-intro`} value={config.trial.kind === 'none' ? row.renewalMajor : config.trial.kind === 'free' ? '0' : row.introMajor} onChange={(event) => updatePrice(row.id, { introMajor: event.target.value })} readOnly={config.trial.kind !== 'paid'} inputMode="decimal" placeholder="5.00" autoComplete="off" /></Field>
              <Field id={`${row.id}-renewal`} label="Pratęsimo kaina" hint={`Pagrindiniais ${row.currency} vienetais.`}><Input id={`${row.id}-renewal`} value={row.renewalMajor} onChange={(event) => updatePrice(row.id, { renewalMajor: event.target.value })} inputMode="decimal" placeholder="29.00" autoComplete="off" /></Field>
              <Button variant="ghost" size="sm" type="button" aria-label={`Pašalinti papildomą ${row.currency} kainą`} onClick={() => update({ additionalPrices: (config.additionalPrices ?? []).filter((price) => price.id !== row.id) })}><Trash2 size={15} />Pašalinti</Button>
            </div><Separator /><div className="setup-minor-preview"><span>Solidgate API <ArrowRight size={14} /></span><div><small>Pirmas mokėjimas</small><MoneyPreview value={config.trial.kind === 'none' ? row.renewalMajor : config.trial.kind === 'free' ? '0' : row.introMajor} currency={row.currency} /></div><div><small>Pratęsimas</small><MoneyPreview value={row.renewalMajor} currency={row.currency} /></div><Badge variant="outline">{row.currency}</Badge></div></fieldset></CardContent></Card>)}</div>
            <div className="setup-add-locale"><Label htmlFor="setup-add-currency">Pridėti valiutos kainą</Label><NativeSelect className="w-full" id="setup-add-currency" value={nextCurrency} onChange={(event) => setNextCurrency(event.target.value as Currency)}>{CURRENCIES.map((currency) => <NativeSelectOption key={currency.code} value={currency.code}>{currency.code} · {currency.label}</NativeSelectOption>)}</NativeSelect><Button variant="outline" type="button" onClick={() => update({ additionalPrices: [...(config.additionalPrices ?? []), { id: `price-${crypto.randomUUID()}`, currency: nextCurrency, introMajor: config.trial.kind === 'free' ? '0' : '', renewalMajor: '' }] })}><Plus size={16} />Pridėti kainą</Button></div>
          </section>
          {validation.prices.length > 0 ? <section className="setup-price-summary" aria-labelledby="setup-price-summary-title"><h3 id="setup-price-summary-title">Vieno produkto valiutų kainų suvestinė</h3><p>Vienodos tos pačios valiutos kainos sujungiamos. Skirtingos sumos tai pačiai valiutai blokuoja prompto kūrimą.</p><Table><TableHeader><TableRow><TableHead>Valiuta</TableHead><TableHead>Pirmas mokėjimas (minor units)</TableHead><TableHead>Pratęsimas (minor units)</TableHead><TableHead>Checkout locale</TableHead></TableRow></TableHeader><TableBody>{validation.prices.map((price) => <TableRow key={price.currency}><TableHead scope="row">{price.currency} {price.isDefault ? <Badge variant="outline">Default</Badge> : null}</TableHead><TableCell><code>{price.initialPaymentMinor}</code></TableCell><TableCell><code>{price.renewalMinor}</code></TableCell><TableCell>{price.locales.length ? price.locales.join(', ') : 'Paruošta be locale'}</TableCell></TableRow>)}</TableBody></Table></section> : null}
          <Separator /><div className="setup-url-test"><div><h3>Pasitikrink produkto parinkimą</h3><p>Tikriname galutinį URL po appso nukreipimų. Tuomet kelias be prefikso <code>/quiz</code> atitinka numatytąją anglų locale. Nežinomas locale neturi tyliai tapti EN.</p></div><Field id="setup-test-path" label="Svetainės kelias"><Input id="setup-test-path" value={testPath} onChange={(event) => setTestPath(event.target.value)} placeholder="/cz/quiz" autoComplete="off" spellCheck={false} /></Field><div className="setup-route-result" aria-live="polite">{resolvedLocale ? <><span><Check size={16} /> {resolvedLocale.internalLocale} <ArrowRight size={14} /> {resolvedLocale.codePrefix}</span><code>{productCode(config, resolvedLocale)}</code></> : <span>Šiam keliui pasirinktuose locale nėra atitikmens.</span>}</div></div>
        </CardContent></Card>
      </form>

      <Card role="region" id="setup-currencies" className="setup-panel setup-currency-panel" aria-labelledby="setup-currencies-title"><CardContent className="setup-panel-content">
        <div className="setup-section-heading"><span className="setup-kicker">C · KAINŲ VIENETAI</span><h2 id="setup-currencies-title">Ekrane — kaina. API — sveikasis skaičius.</h2><p>Solidgate sumos siunčiamos mažiausiais valiutos vienetais (minor units). Valiutos eksponentas nurodo, kiek yra skaitmenų po kablelio.</p></div>
        <div className="setup-currency-table-wrap"><Table><TableHeader><TableRow><TableHead>Valiuta</TableHead><TableHead>Kliento mokama suma</TableHead><TableHead>Eksponentas</TableHead><TableHead>Solidgate API suma</TableHead></TableRow></TableHeader><TableBody>{copy.currencyExamples.map((row) => <TableRow key={row.code} className={row.code === 'TWD' ? 'bg-muted/50' : undefined}><TableHead scope="row">{row.code}{row.code === 'TWD' ? <Badge variant="outline" className="ml-2">Svarbu</Badge> : null}</TableHead><TableCell>{row.amount}</TableCell><TableCell>× 10<sup>{row.exponent}</sup></TableCell><TableCell><code>{row.minor}</code></TableCell></TableRow>)}</TableBody></Table></div>
        <Alert role="note"><AlertTitle>TWD nėra valiuta be centinių vienetų.</AlertTitle><AlertDescription><p>Net jei klientui rodome <code>NT$100</code>, į Solidgate siunčiame <code>10000</code>. JPY ir KRW eksponentas yra 0: <code>100 JPY → 100</code>, <code>100 KRW → 100</code>. Valiutos simbolis ir kainos rodymas nekeičia API sumos.</p><p>PayPal atveju TWD, HUF ir RSD kainos turi būti sveiki pagrindiniai vienetai. Pavyzdžiui, <code>100 TWD → 10000</code>; <code>100.50 TWD</code> netinka PayPal. Įjungus PayPal lauką, vedlys tai tikrina.</p></AlertDescription></Alert>
        <p className="setup-money-rule">Visos sumos konvertuojamos tiksliai iš teksto, be <code>parseFloat × 100</code> ir be tylaus apvalinimo. Kainos kitomis valiutomis įvedamos atskirai.</p>
        <div className="setup-sources" aria-label="Valiutų ir produktų taisyklių šaltiniai">{copy.sources.map((source) => <Button key={source.href} variant="link" nativeButton={false} render={<a href={source.href} target="_blank" rel="noreferrer" />}>{source.label}<ArrowRight size={13} /></Button>)}</div>
      </CardContent></Card>

      <Card role="region" id="setup-prompt" className="setup-panel setup-prompt-panel" aria-labelledby="setup-prompt-title"><CardContent className="setup-panel-content">
        <div className="setup-panel-header"><div><span className="setup-kicker">D · PERDUOK AGENTUI</span><h2 id="setup-prompt-title">01. Produktų kūrimo promptas</h2><p>Promptas sujungia laukus, metadata, locale taisykles ir patikras. Jis atsinaujina pakeitus konfigūraciją.</p></div><Badge variant={validation.valid ? 'default' : 'outline'}>{validation.valid ? <><CircleCheck size={15} />Paruošta</> : 'Laukiama laukų'}</Badge></div>
        {validation.valid ? <Alert role="status"><CircleCheck size={18} /><AlertDescription>Konfigūracija tinkama: 1 Solidgate produktas, {validation.prices.length} valiutų kainos, {validation.products.length} checkout locale. Agentas sukurs arba suderins vieną produktą bei jo kainas ir patikrins locale atitikmenis.</AlertDescription></Alert> : <Collapsible className="setup-validation"><CollapsibleTrigger render={<Button variant="outline" className="h-auto w-full justify-start whitespace-normal text-left" />} >Prieš kopijuojant liko užpildyti arba patikrinti {validation.issues.length} laukų <ArrowDown size={15} /></CollapsibleTrigger><CollapsibleContent><ul>{validation.issues.map((issue, index) => <li key={`${issue.path}-${index}`}><strong>{issueContext(issue.path)}</strong>{issue.message}</li>)}</ul></CollapsibleContent></Collapsible>}
        <Label className="setup-prompt-label" htmlFor="setup-prompt-text">Pilnas promptas agentui</Label>
        <Textarea ref={promptRef} id="setup-prompt-text" className="setup-prompt-text" value={prompt} readOnly spellCheck={false} rows={16} placeholder="Užpildyk produkto tapatybę, datą, Solidgate kanalą ir kiekvieno locale kainas. Čia atsiras pilnas promptas, kurį galėsi iškart nukopijuoti agentui." />
        <div className="setup-prompt-actions"><Button variant="default" type="button" disabled={!validation.valid} onClick={() => void copyPrompt()}><Copy size={17} />Kopijuoti promptą</Button><Button variant="outline" type="button" disabled={!validation.valid} onClick={() => downloadFile(prompt, `01-solidgate-${config.appKey.toLowerCase()}-products.md`, 'text/markdown;charset=utf-8')}><Download size={16} />Promptas .md</Button><Button variant="ghost" type="button" disabled={!validation.valid} onClick={() => downloadFile(JSON.stringify(config, null, 2), `solidgate-${config.appKey.toLowerCase()}-setup.json`, 'application/json;charset=utf-8')}><Download size={16} />Konfigūracija .json</Button></div>
        <p className="setup-copy-status" role="status" aria-live="polite">{status || 'Konfigūraciją gali išsaugoti šioje naršyklėje virš formos arba atsisiųsti JSON vėlesniems žingsniams.'}</p>
      </CardContent></Card>
    </>
  );
}

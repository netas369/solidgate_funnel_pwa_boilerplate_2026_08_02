// ─── OTO PDF Delivery Email ─────────────────────────────────────────────────
// Sent via Resend after a successful OTO charge that grants downloadable PDFs.
// Used by OTO3 (bundles) and OTO4-7 (single PDFs). Includes signed download
// URLs (Supabase storage, 100-year TTL) for each entitled file.
//
// Design: paper/ink/serif aesthetic that matches the funnel offer page  -
// `--paper #ffffff`, `--paper-soft #fafaf7`, `--ink #111111`,
// `--hairline rgba(0,0,0,0.12)`, `--hairline-strong rgba(0,0,0,0.18)`.
// Square ink CTA with ✦ flanking each download label.

import { getLocaleDir, type Locale } from '@repo/i18n/routing';
import { BOILERPLATE_BRAND } from '../boilerplate-brand';

export interface PdfDownloadItem {
  /** Display title shown above the download button. */
  title: string;
  /** Time-limited Supabase signed URL. */
  url: string;
}

export interface Oto3PdfEmailParams {
  email: string;
  locale?: Locale | string | null;
  /** One or more downloads  -  Ultra Pack sends 3, single bundles send 1. */
  downloads: ReadonlyArray<PdfDownloadItem>;
  /** e.g. "Ultra Pack" / "Soul Mission Report"  -  used in subject + heading. */
  productLabel: string;
}

interface Copy {
  /** {label} placeholder = productLabel. */
  subject: string;
  eyebrow: string;
  /** {label} placeholder = productLabel. */
  heading: string;
  greeting: string;
  buttonLabel: string;
  expiry: string;
  /** {brand} = brand short name. {support} = support email. */
  footerHelp: string;
}

const COPY_EN: Copy = {
  subject: 'Your {label} is ready to download',
  eyebrow: 'Your downloads',
  heading: 'Your {label} is ready.',
  greeting: 'Thank you for your purchase. Tap the button under each title to download your PDF.',
  buttonLabel: 'Download PDF',
  expiry: 'Save the files to your device  -  these download links never expire.',
  footerHelp: 'Need help? Reply to this email or write to {support}.',
};

const COPY: Record<Locale, Copy> = {
  en: COPY_EN,
  ja: {
    subject: '{label}のダウンロード準備が整いました',
    eyebrow: 'ダウンロード',
    heading: '{label}の準備が整いました。',
    greeting:
      'ご購入ありがとうございます。各タイトルの下にあるボタンをタップして、PDFをダウンロードしてください。',
    buttonLabel: 'PDFをダウンロード',
    expiry: 'ファイルは端末に保存してください。ダウンロードリンクの有効期限はありません。',
    footerHelp: 'ご不明な点がございましたら、このメールにご返信いただくか、{support}までご連絡ください。',
  },
  cs: {
    subject: 'Váš {label} je připraven ke stažení',
    eyebrow: 'Vaše soubory ke stažení',
    heading: 'Váš {label} je připraven.',
    greeting: 'Děkujeme za nákup. Klepnutím na tlačítko pod každým názvem si stáhnete svůj PDF soubor.',
    buttonLabel: 'Stáhnout PDF',
    expiry: 'Uložte si soubory do zařízení  -  tyto odkazy ke stažení nikdy nevyprší.',
    footerHelp: 'Potřebujete pomoc? Odpovězte na tento e-mail nebo napište na {support}.',
  },
  hu: {
    subject: 'A(z) {label} készen áll a letöltésre',
    eyebrow: 'Letöltéseid',
    heading: 'A(z) {label} készen áll.',
    greeting: 'Köszönjük a vásárlásodat. Koppints az egyes címek alatti gombra a PDF letöltéséhez.',
    buttonLabel: 'PDF letöltése',
    expiry: 'Mentsd el a fájlokat az eszközödre  -  ezek a letöltési linkek sosem járnak le.',
    footerHelp: 'Segítségre van szükséged? Válaszolj erre az e-mailre, vagy írj ide: {support}.',
  },
  sk: {
    subject: 'Váš {label} je pripravený na stiahnutie',
    eyebrow: 'Vaše súbory na stiahnutie',
    heading: 'Váš {label} je pripravený.',
    greeting: 'Ďakujeme za nákup. Klepnite na tlačidlo pod každým názvom a stiahnite si svoj PDF súbor.',
    buttonLabel: 'Stiahnuť PDF',
    expiry: 'Uložte si súbory do zariadenia  -  tieto odkazy na stiahnutie nikdy nevypršia.',
    footerHelp: 'Potrebujete pomoc? Odpovedzte na tento e-mail alebo napíšte na {support}.',
  },
  ro: {
    subject: '{label} este gata de descărcat',
    eyebrow: 'Descărcările tale',
    heading: '{label} este gata.',
    greeting: 'Îți mulțumim pentru achiziție. Apasă butonul de sub fiecare titlu pentru a descărca PDF-ul.',
    buttonLabel: 'Descarcă PDF',
    expiry: 'Salvează fișierele pe dispozitivul tău  -  aceste linkuri de descărcare nu expiră niciodată.',
    footerHelp: 'Ai nevoie de ajutor? Răspunde la acest e-mail sau scrie la {support}.',
  },
  lt: {
    subject: 'Jūsų {label} paruoštas atsisiųsti',
    eyebrow: 'Jūsų atsisiuntimai',
    heading: 'Jūsų {label} paruoštas.',
    greeting: 'Ačiū už pirkinį. Spustelėkite mygtuką po kiekvienu pavadinimu, kad atsisiųstumėte PDF.',
    buttonLabel: 'Atsisiųsti PDF',
    expiry: 'Išsaugokite failus savo įrenginyje  -  šios atsisiuntimo nuorodos niekada nesibaigia.',
    footerHelp: 'Reikia pagalbos? Atsakykite į šį el. laišką arba parašykite adresu {support}.',
  },
  ru: {
    subject: 'Ваш {label} готов к скачиванию',
    eyebrow: 'Ваши загрузки',
    heading: 'Ваш {label} готов.',
    greeting: 'Спасибо за покупку. Нажмите кнопку под каждым названием, чтобы скачать PDF.',
    buttonLabel: 'Скачать PDF',
    expiry: 'Сохраните файлы на свое устройство  -  эти ссылки для скачивания никогда не истекают.',
    footerHelp: 'Нужна помощь? Ответьте на это письмо или напишите на {support}.',
  },
  lv: {
    subject: 'Jūsu {label} ir gatavs lejupielādei',
    eyebrow: 'Jūsu lejupielādes',
    heading: 'Jūsu {label} ir gatavs.',
    greeting: 'Paldies par pirkumu. Pieskarieties pogai zem katra nosaukuma, lai lejupielādētu PDF.',
    buttonLabel: 'Lejupielādēt PDF',
    expiry: 'Saglabājiet failus savā ierīcē  -  šīm lejupielādes saitēm nekad nebeidzas termiņš.',
    footerHelp: 'Vajadzīga palīdzība? Atbildiet uz šo e-pastu vai rakstiet uz {support}.',
  },
  'zh-TW': {
    subject: '你的 {label} 已可下載',
    eyebrow: '你的下載內容',
    heading: '你的 {label} 已準備好。',
    greeting: '感謝你的購買。請點選每個標題下方的按鈕以下載 PDF。',
    buttonLabel: '下載 PDF',
    expiry: '請將檔案儲存到你的裝置  -  這些下載連結永不過期。',
    footerHelp: '需要協助嗎？請回覆這封電子郵件，或寫信至 {support}。',
  },
  el: {
    subject: 'Το {label} σου είναι έτοιμο για λήψη',
    eyebrow: 'Οι λήψεις σου',
    heading: 'Το {label} σου είναι έτοιμο.',
    greeting: 'Σε ευχαριστούμε για την αγορά σου. Πάτησε το κουμπί κάτω από κάθε τίτλο για να κατεβάσεις το PDF.',
    buttonLabel: 'Λήψη PDF',
    expiry: 'Αποθήκευσε τα αρχεία στη συσκευή σου  -  αυτοί οι σύνδεσμοι λήψης δεν λήγουν ποτέ.',
    footerHelp: 'Χρειάζεσαι βοήθεια; Απάντησε σε αυτό το email ή γράψε στο {support}.',
  },
  he: {
    subject: '{label} שלך מוכן להורדה',
    eyebrow: 'ההורדות שלך',
    heading: '{label} שלך מוכן.',
    greeting: 'תודה על הרכישה. יש ללחוץ על הכפתור שמתחת לכל כותרת כדי להוריד את ה-PDF.',
    buttonLabel: 'הורדת PDF',
    expiry: 'שמרי את הקבצים במכשיר שלך  -  קישורי ההורדה האלה לעולם לא יפוגו.',
    footerHelp: 'צריכה עזרה? השיבי לאימייל הזה או כתבי אל {support}.',
  },
  pl: {
    subject: 'Twój {label} jest gotowy do pobrania',
    eyebrow: 'Twoje pliki do pobrania',
    heading: 'Twój {label} jest gotowy.',
    greeting: 'Dziękujemy za zakup. Kliknij przycisk pod każdym tytułem, aby pobrać PDF.',
    buttonLabel: 'Pobierz PDF',
    expiry: 'Zapisz pliki na swoim urządzeniu  -  te linki do pobrania nigdy nie wygasają.',
    footerHelp: 'Potrzebujesz pomocy? Odpowiedz na tego e-maila albo napisz na {support}.',
  },
  hr: {
    subject: 'Vaš {label} spreman je za preuzimanje',
    eyebrow: 'Vaša preuzimanja',
    heading: 'Vaš {label} je spreman.',
    greeting: 'Hvala na kupnji. Dodirnite gumb ispod svakog naslova kako biste preuzeli PDF.',
    buttonLabel: 'Preuzmi PDF',
    expiry: 'Spremite datoteke na svoj uređaj  -  ove poveznice za preuzimanje nikada ne istječu.',
    footerHelp: 'Trebate pomoć? Odgovorite na ovaj e-mail ili pišite na {support}.',
  },
  da: {
    subject: 'Din {label} er klar til download',
    eyebrow: 'Dine downloads',
    heading: 'Din {label} er klar.',
    greeting: 'Tak for dit køb. Tryk på knappen under hver titel for at downloade din PDF.',
    buttonLabel: 'Download PDF',
    expiry: 'Gem filerne på din enhed  -  disse downloadlinks udløber aldrig.',
    footerHelp: 'Har du brug for hjælp? Svar på denne e-mail, eller skriv til {support}.',
  },
};

function copyFor(locale?: Locale | string | null): Copy {
  if (!locale) return COPY_EN;
  return COPY[locale as Locale] ?? COPY_EN;
}

function fillCopy(c: Copy, productLabel: string): Copy {
  const support = BOILERPLATE_BRAND.supportEmail;
  const brand = BOILERPLATE_BRAND.shortName;
  const sub = (s: string) =>
    s.replaceAll('{label}', productLabel).replaceAll('{brand}', brand).replaceAll('{support}', support);
  return {
    subject: sub(c.subject),
    eyebrow: sub(c.eyebrow),
    heading: sub(c.heading),
    greeting: sub(c.greeting),
    buttonLabel: sub(c.buttonLabel),
    expiry: sub(c.expiry),
    footerHelp: sub(c.footerHelp),
  };
}

export function getOto3PdfEmailSubject(productLabel: string, locale?: Locale | string | null): string {
  return fillCopy(copyFor(locale), productLabel).subject;
}

export function buildOto3PdfEmailHtml(params: Oto3PdfEmailParams): string {
  const c = fillCopy(copyFor(params.locale), params.productLabel);
  const dir = getLocaleDir(String(params.locale ?? 'en'));

  const items = params.downloads
    .map((d, i) => {
      const isLast = i === params.downloads.length - 1;
      const borderStyle = isLast ? '' : 'border-bottom:1px solid rgba(0,0,0,0.12);';
      return `
      <tr><td style="padding:20px 0;${borderStyle}">
        <p style="margin:0 0 14px 0;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.4;color:#111111;font-weight:500;">${escapeHtml(d.title)}</p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr><td style="background-color:#111111;border:1px solid #111111;">
            <a href="${escapeAttr(d.url)}" target="_blank" style="display:inline-block;padding:12px 22px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:12px;letter-spacing:0.18em;text-transform:uppercase;font-weight:600;color:#ffffff;text-decoration:none;">
              <span style="opacity:0.7;">&#10022;</span>&nbsp;&nbsp;${escapeHtml(c.buttonLabel)}&nbsp;&nbsp;<span style="opacity:0.7;">&#10022;</span>
            </a>
          </td></tr>
        </table>
      </td></tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="${escapeAttr(String(params.locale ?? 'en'))}" dir="${dir}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${escapeHtml(c.subject)}</title>
</head>
<body dir="${dir}" style="margin:0;padding:0;background-color:#fafaf7;font-family:Georgia,'Times New Roman',serif;color:#111111;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fafaf7;">
  <tr><td align="center" style="padding:48px 16px;">

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background-color:#ffffff;border:1px solid rgba(0,0,0,0.18);">
      <tr><td style="padding:48px 40px 40px 40px;">

        <!-- Sigil -->
        <p style="margin:0 0 14px 0;text-align:center;font-size:28px;letter-spacing:0.4em;color:#111111;font-family:Georgia,'Times New Roman',serif;">&#10022;</p>

        <!-- Eyebrow -->
        <p style="margin:0 0 28px 0;text-align:center;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:10px;letter-spacing:0.32em;text-transform:uppercase;color:rgba(17,17,17,0.55);">${escapeHtml(c.eyebrow)}</p>

        <!-- Heading -->
        <h1 style="margin:0 0 20px 0;text-align:center;font-family:Georgia,'Times New Roman',serif;font-weight:500;font-size:24px;line-height:1.25;color:#111111;">${escapeHtml(c.heading)}</h1>

        <!-- Hairline divider -->
        <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 28px auto;"><tr><td style="width:56px;height:1px;background-color:rgba(17,17,17,0.4);font-size:0;line-height:0;">&nbsp;</td></tr></table>

        <!-- Greeting -->
        <p style="margin:0 0 12px 0;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.6;color:#1a1a1a;">${escapeHtml(c.greeting)}</p>

        <!-- Downloads list -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${items}</table>

        <!-- Expiry / save-locally note -->
        <p style="margin:28px 0 0 0;text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:13px;line-height:1.5;color:rgba(17,17,17,0.6);font-style:italic;">${escapeHtml(c.expiry)}</p>

      </td></tr>
    </table>

    <!-- Footer -->
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
      <tr><td align="center" style="padding:24px 16px 8px 16px;">
        <p style="margin:0;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:rgba(17,17,17,0.5);">${escapeHtml(BOILERPLATE_BRAND.shortName)}</p>
      </td></tr>
      <tr><td align="center" style="padding:0 16px 32px 16px;">
        <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:11px;line-height:1.5;color:rgba(17,17,17,0.5);">${escapeHtml(c.footerHelp)}</p>
      </td></tr>
    </table>

  </td></tr>
</table>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

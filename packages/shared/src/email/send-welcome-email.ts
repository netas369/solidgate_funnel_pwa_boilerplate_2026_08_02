// Welcome email  -  Node TS sender. Mirrors the design in
// supabase/functions/solidgate-webhooks/_welcome_email.ts (Deno). Used by the funnel
// /api/payment/grant route, which fires immediately after a new auth user is
// created (isNewUser=true). Webhook keeps its own Deno-friendly copy as a
// fallback for the abandon-and-resume path where /api/payment/grant never
// runs.
//
// Design: paper/ink/serif aesthetic that matches the funnel offer page  -
// `--paper #ffffff`, `--paper-soft #fafaf7`, `--ink #111111`,
// `--hairline rgba(0,0,0,0.18)`. Square ink button links to ${pwaUrl}/login.

import { BOILERPLATE_BRAND } from '../boilerplate-brand';
import { getLocaleDir } from '@repo/i18n/routing';

export interface SendWelcomeEmailParams {
  email: string;
  pwaUrl: string;
  locale?: string | null;
  signal?: AbortSignal;
  /** Stable per-purchase key for retry-safe delivery through Resend. */
  idempotencyKey?: string;
}

export interface PreparedWelcomeEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
}

export type WelcomeEmailSendResult =
  | { status: 'sent' }
  | { status: 'definite_failure'; error: string }
  | { status: 'ambiguous'; error: string };

/** Welcome email is best-effort and must never hold a paid redirect open. */
export const WELCOME_EMAIL_TIMEOUT_MS = 5_000;

const RESEND_API_URL = 'https://api.resend.com/emails';

const SUPPORTED_LOCALES = new Set([
  'en', 'cs', 'hu', 'sk', 'ro', 'lt', 'ru', 'lv',
  'zh-TW', 'el', 'he', 'pl', 'hr', 'da', 'ja',
]);

interface Copy {
  subject: string;
  eyebrow: string;
  title: string;
  greeting: string;
  body: string;
  buttonLabel: string;
  signInNote: string;
  footerTagline: string;
  footerAuto: string;
}

export const WELCOME_EMAIL_COPY: Record<string, Copy> = {
  en: {
    subject: 'Welcome to {brand} — your account is ready',
    eyebrow: 'Welcome aboard',
    title: 'Your account is ready.',
    greeting:
      'Thank you for joining {brand}. Your purchase is confirmed, and your member area is ready.',
    body:
      'To get started, sign in with the email address this message was sent to ({email}). We’ll send you a one-time code to verify it’s you — no password needed.',
    buttonLabel: 'Access your account',
    signInNote: 'Use {email} to sign in.',
    footerTagline: '{brand}',
    footerAuto: 'This is an automated message from {host}.',
  },
  cs: {
    subject: '{brand}: můžete se přihlásit ke svému účtu',
    eyebrow: 'Váš přístup je aktivní',
    title: 'Váš účet je připraven.',
    greeting:
      'Vaše objednávka byla potvrzena. Členská sekce {brand} je pro vás připravena.',
    body:
      'Pro začátek se přihlaste pomocí e-mailové adresy, na kterou jsme tuto zprávu poslali ({email}). Pro ověření, že jste to opravdu vy, vám pošleme jednorázový kód – heslo není potřeba.',
    buttonLabel: 'Přihlásit se k účtu',
    signInNote: 'K přihlášení použijte adresu {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Toto je automatická zpráva od {host}.',
  },
  hu: {
    subject: '{brand}: már beléphetsz a fiókodba',
    eyebrow: 'A hozzáférésed aktív',
    title: 'A fiókod készen áll.',
    greeting:
      'Vásárlásodat visszaigazoltuk. A {brand} tagi felülete már elérhető számodra.',
    body:
      'A kezdéshez jelentkezz be azzal az e-mail-címmel, amelyre ezt az üzenetet küldtük ({email}). Küldünk egy egyszer használatos kódot annak ellenőrzésére, hogy valóban te vagy-e – jelszóra nincs szükség.',
    buttonLabel: 'Belépés a fiókba',
    signInNote:
      'A bejelentkezéshez használd ezt az e-mail-címet: {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Ez egy automatikus üzenet. Feladó: {host}.',
  },
  sk: {
    subject: '{brand}: môžete sa prihlásiť do svojho účtu',
    eyebrow: 'Váš prístup je aktívny',
    title: 'Váš účet je pripravený.',
    greeting:
      'Vaša objednávka bola potvrdená. Členská sekcia {brand} je pre vás pripravená.',
    body:
      'Ak chcete začať, prihláste sa pomocou e-mailovej adresy, na ktorú sme túto správu poslali ({email}). Aby sme overili, že ste to naozaj vy, pošleme vám jednorazový kód – heslo nie je potrebné.',
    buttonLabel: 'Prihlásiť sa do účtu',
    signInNote: 'Na prihlásenie použite adresu {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Toto je automatická správa od {host}.',
  },
  ro: {
    subject: '{brand}: te poți autentifica în contul tău',
    eyebrow: 'Accesul tău este activ',
    title: 'Contul tău este gata.',
    greeting:
      'Achiziția ta a fost confirmată. Ai acum acces la zona rezervată membrilor {brand}.',
    body:
      'Pentru a începe, autentifică-te folosind adresa de e-mail la care ai primit acest mesaj ({email}). Îți vom trimite un cod de unică folosință pentru a-ți confirma identitatea – nu ai nevoie de parolă.',
    buttonLabel: 'Accesează-ți contul',
    signInNote:
      'Autentifică-te folosind adresa de e-mail {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Acesta este un mesaj automat de la {host}.',
  },
  lt: {
    subject: '{brand}: galite prisijungti prie savo paskyros',
    eyebrow: 'Galite prisijungti',
    title: 'Jūsų paskyra paruošta.',
    greeting:
      'Jūsų užsakymas patvirtintas. Dabar galite naudotis savo {brand} paskyra.',
    body:
      'Norėdami pradėti, prisijunkite naudodami el. pašto adresą, kuriuo gavote šį laišką ({email}). Atsiųsime vienkartinį kodą jūsų tapatybei patvirtinti – slaptažodžio nereikia.',
    buttonLabel: 'Prisijungti prie paskyros',
    signInNote:
      'Prisijunkite naudodami el. pašto adresą {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Šį automatinį pranešimą išsiuntė {host}.',
  },
  ru: {
    subject: '{brand}: ваш аккаунт готов',
    eyebrow: 'Доступ к аккаунту',
    title: 'Ваш аккаунт готов.',
    greeting:
      'Ваша покупка подтверждена. Ваш личный кабинет {brand} уже готов к работе.',
    body:
      'Чтобы начать, войдите, используя адрес электронной почты, на который было отправлено это письмо ({email}). Для подтверждения личности мы пришлём одноразовый код — пароль не понадобится.',
    buttonLabel: 'Войти в аккаунт',
    signInNote: 'Для входа используйте {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Это автоматическое сообщение от {host}.',
  },
  lv: {
    subject: '{brand}: jūsu konts ir gatavs',
    eyebrow: 'Piekļuve kontam',
    title: 'Jūsu konts ir gatavs.',
    greeting:
      'Jūsu pirkums ir apstiprināts. Jūsu {brand} konts ir gatavs lietošanai.',
    body:
      'Lai sāktu, pierakstieties, izmantojot e-pasta adresi, uz kuru tika nosūtīta šī ziņa ({email}). Mēs nosūtīsim vienreiz lietojamu kodu, lai apstiprinātu jūsu identitāti — parole nav nepieciešama.',
    buttonLabel: 'Piekļūt savam kontam',
    signInNote: 'Lai pierakstītos, izmantojiet {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Šis ir automātisks ziņojums no {host}.',
  },
  'zh-TW': {
    subject: '{brand}：您的帳戶已準備就緒',
    eyebrow: '歡迎加入',
    title: '您的帳戶已準備就緒。',
    greeting: '您已成功完成購買，專屬的 {brand} 會員專區也已準備就緒。',
    body:
      '請使用收到這封信的電子郵件地址（{email}）登入，即可開始使用。我們會寄送一次性驗證碼來確認是您本人，無須使用密碼。',
    buttonLabel: '登入您的帳戶',
    signInNote: '請使用 {email} 登入。',
    footerTagline: '{brand}',
    footerAuto: '此郵件由 {host} 自動寄送。',
  },
  el: {
    subject: '{brand}: ο λογαριασμός σου είναι έτοιμος',
    eyebrow: 'Καλώς ήρθες',
    title: 'Ο λογαριασμός σου είναι έτοιμος.',
    greeting:
      'Η αγορά σου επιβεβαιώθηκε. Ο προσωπικός σου χώρος στο {brand} είναι έτοιμος.',
    body:
      'Για να ξεκινήσεις, συνδέσου χρησιμοποιώντας τη διεύθυνση email στην οποία στάλθηκε αυτό το μήνυμα ({email}). Θα σου στείλουμε έναν κωδικό μίας χρήσης για να επιβεβαιώσουμε ότι είσαι εσύ — δεν χρειάζεται κωδικός πρόσβασης.',
    buttonLabel: 'Σύνδεση στον λογαριασμό σου',
    signInNote: 'Για να συνδεθείς, χρησιμοποίησε το {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Το μήνυμα αυτό στάλθηκε αυτόματα από το {host}.',
  },
  he: {
    subject: '{brand}: החשבון שלך מוכן',
    eyebrow: 'ברוכים הבאים',
    title: 'החשבון שלך מוכן.',
    greeting:
      'הרכישה שלך אושרה, והאזור האישי שלך ב־{brand} כבר מוכן.',
    body:
      'כדי להתחיל, יש להתחבר באמצעות כתובת האימייל שאליה נשלחה הודעה זו ({email}). נשלח אליך קוד חד־פעמי כדי לאמת את זהותך — אין צורך בסיסמה.',
    buttonLabel: 'כניסה לחשבון שלך',
    signInNote: 'יש להתחבר באמצעות {email}.',
    footerTagline: '{brand}',
    footerAuto: 'הודעה זו נשלחה אוטומטית על ידי {host}.',
  },
  pl: {
    subject: '{brand}: Twoje konto jest gotowe',
    eyebrow: 'Dostęp do konta',
    title: 'Twoje konto jest gotowe.',
    greeting:
      'Twój zakup został potwierdzony. Twoje konto {brand} jest już gotowe.',
    body:
      'Aby rozpocząć, zaloguj się za pomocą adresu e-mail, na który wysłaliśmy tę wiadomość ({email}). Na ten adres wyślemy jednorazowy kod weryfikacyjny — hasło nie będzie potrzebne.',
    buttonLabel: 'Przejdź do swojego konta',
    signInNote: 'Zaloguj się za pomocą adresu {email}.',
    footerTagline: '{brand}',
    footerAuto: 'To automatyczna wiadomość od {host}.',
  },
  hr: {
    subject: '{brand}: vaš je korisnički račun spreman',
    eyebrow: 'Pristup računu',
    title: 'Vaš je korisnički račun spreman.',
    greeting:
      'Vaša je kupnja potvrđena. Vaš korisnički račun za {brand} spreman je za upotrebu.',
    body:
      'Za početak se prijavite pomoću adrese e-pošte na koju je poslana ova poruka ({email}). Poslat ćemo vam jednokratni kod kako bismo potvrdili da ste to vi — lozinka nije potrebna.',
    buttonLabel: 'Pristupite svom računu',
    signInNote: 'Za prijavu upotrijebite adresu {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Ovo je automatska poruka koju šalje {host}.',
  },
  ja: {
    subject: '{brand}へようこそ — アカウントの準備が整いました',
    eyebrow: 'ようこそ',
    title: 'アカウントの準備が整いました。',
    greeting:
      '{brand}をご利用いただきありがとうございます。ご購入を確認いたしました。お客様専用の会員ページはすでにご利用いただけます。',
    body:
      'このメールを受信したメールアドレス（{email}）でサインインしてください。ご本人確認用のワンタイムコードをお送りします。パスワードは必要ありません。',
    buttonLabel: 'アカウントにサインイン',
    signInNote: 'サインインには{email}をご使用ください。',
    footerTagline: '{brand}',
    footerAuto: 'このメールは{host}から自動送信されています。',
  },
  da: {
    subject: '{brand}: din konto er klar',
    eyebrow: 'Adgang til din konto',
    title: 'Din konto er klar.',
    greeting:
      'Dit køb er bekræftet. Din konto hos {brand} er klar til brug.',
    body:
      'For at komme i gang skal du logge ind med den e-mailadresse, som denne besked blev sendt til ({email}). Vi sender dig en engangskode, så vi kan bekræfte, at det er dig — du behøver ikke en adgangskode.',
    buttonLabel: 'Log ind på din konto',
    signInNote: 'Log ind med {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Dette er en automatisk besked fra {host}.',
  },
};

function copyFor(locale: string): Copy {
  return WELCOME_EMAIL_COPY[locale] ?? WELCOME_EMAIL_COPY.en;
}

function normalizeLocale(locale?: string | null): string {
  if (!locale) return 'en';
  return SUPPORTED_LOCALES.has(locale) ? locale : 'en';
}

function getAppHost(pwaUrl: string): string {
  try {
    return new URL(pwaUrl).host;
  } catch {
    return 'app.example.com';
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHtml(filled: Copy, loginUrl: string, lang: string): string {
  const esc = escapeHtml;
  const dir = getLocaleDir(lang);
  return `<!DOCTYPE html>
<html lang="${esc(lang)}" dir="${dir}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${esc(filled.subject)}</title>
</head>
<body dir="${dir}" style="margin:0;padding:0;background-color:#fafaf7;font-family:Georgia,'Times New Roman',serif;color:#111111;-webkit-font-smoothing:antialiased;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#fafaf7;">
  <tr><td align="center" style="padding:48px 16px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;background-color:#ffffff;border:1px solid rgba(0,0,0,0.18);">
      <tr><td style="padding:48px 40px 40px 40px;">
        <p style="margin:0 0 14px 0;text-align:center;font-size:28px;letter-spacing:0.4em;color:#111111;font-family:Georgia,'Times New Roman',serif;">&#10022;</p>
        <p style="margin:0 0 28px 0;text-align:center;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:10px;letter-spacing:0.32em;text-transform:uppercase;color:rgba(17,17,17,0.55);">${esc(filled.eyebrow)}</p>
        <h1 style="margin:0 0 20px 0;text-align:center;font-family:Georgia,'Times New Roman',serif;font-weight:500;font-size:26px;line-height:1.2;color:#111111;">${esc(filled.title)}</h1>
        <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 28px auto;"><tr><td style="width:56px;height:1px;background-color:rgba(17,17,17,0.4);font-size:0;line-height:0;">&nbsp;</td></tr></table>
        <p style="margin:0 0 16px 0;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.6;color:#1a1a1a;">${esc(filled.greeting)}</p>
        <p style="margin:0 0 32px 0;font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.6;color:#1a1a1a;">${esc(filled.body)}</p>
        <table role="presentation" align="center" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 28px auto;">
          <tr><td style="background-color:#111111;border:1px solid #111111;">
            <a href="${esc(loginUrl)}" target="_blank" style="display:inline-block;padding:16px 28px;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:13px;letter-spacing:0.18em;text-transform:uppercase;font-weight:600;color:#ffffff;text-decoration:none;">
              <span style="opacity:0.7;">&#10022;</span>&nbsp;&nbsp;${esc(filled.buttonLabel)}&nbsp;&nbsp;<span style="opacity:0.7;">&#10022;</span>
            </a>
          </td></tr>
        </table>
        <p style="margin:0;text-align:center;font-family:Georgia,'Times New Roman',serif;font-size:13px;line-height:1.5;color:rgba(17,17,17,0.6);font-style:italic;">${esc(filled.signInNote)}</p>
      </td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
      <tr><td align="center" style="padding:24px 16px 8px 16px;">
        <p style="margin:0;font-family:'SFMono-Regular',Menlo,Consolas,monospace;font-size:10px;letter-spacing:0.22em;text-transform:uppercase;color:rgba(17,17,17,0.5);">${esc(filled.footerTagline)}</p>
      </td></tr>
      <tr><td align="center" style="padding:0 16px 32px 16px;">
        <p style="margin:0;font-family:Georgia,'Times New Roman',serif;font-size:11px;line-height:1.5;color:rgba(17,17,17,0.5);">${esc(filled.footerAuto)}</p>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

function isAmbiguousResendResponse(status: number): boolean {
  return status >= 500 || status === 409 || status === 408;
}

/** Build the exact Resend body so a durable worker can persist it before send. */
export function prepareWelcomeEmail(
  params: Pick<SendWelcomeEmailParams, 'email' | 'pwaUrl' | 'locale'>,
): PreparedWelcomeEmail {
  // TODO(new product): set RESEND_FROM_ADDRESS to a verified sending domain.
  // The fallback is a placeholder and will bounce.
  const fromAddress =
    process.env.RESEND_FROM_ADDRESS ||
    `${BOILERPLATE_BRAND.shortName} <no-reply@example.com>`;

  const lang = normalizeLocale(params.locale);
  const rawCopy = copyFor(lang);
  const brand = BOILERPLATE_BRAND.shortName;
  const host = getAppHost(params.pwaUrl);
  const fill = (s: string) =>
    s
      .replaceAll('{brand}', brand)
      .replaceAll('{host}', host)
      .replaceAll('{email}', params.email);
  const filled: Copy = {
    subject: fill(rawCopy.subject),
    eyebrow: fill(rawCopy.eyebrow),
    title: fill(rawCopy.title),
    greeting: fill(rawCopy.greeting),
    body: fill(rawCopy.body),
    buttonLabel: fill(rawCopy.buttonLabel),
    signInNote: fill(rawCopy.signInNote),
    footerTagline: fill(rawCopy.footerTagline),
    footerAuto: fill(rawCopy.footerAuto),
  };

  const loginUrl = `${params.pwaUrl}/login`;
  const html = buildHtml(filled, loginUrl, lang);
  return {
    from: fromAddress,
    to: params.email,
    subject: filled.subject,
    html,
  };
}

export async function sendPreparedWelcomeEmailDetailed(params: {
  resendApiKey: string;
  message: PreparedWelcomeEmail;
  idempotencyKey?: string;
  signal?: AbortSignal;
}): Promise<WelcomeEmailSendResult> {
  const { resendApiKey, message, idempotencyKey, signal } = params;
  try {
    const res = await fetch(RESEND_API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify(message),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => 'no body');
      console.error('[welcome-email] resend failed:', res.status, body);
      return {
        status: isAmbiguousResendResponse(res.status) ? 'ambiguous' : 'definite_failure',
        error: `Resend HTTP ${res.status}: ${body}`,
      };
    }
    console.log('[welcome-email] sent to', message.to);
    return { status: 'sent' };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error('[welcome-email] fetch error:', error);
    return { status: 'ambiguous', error };
  }
}

export async function sendWelcomeEmail(
  params: SendWelcomeEmailParams,
): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('[welcome-email] RESEND_API_KEY not set, skipping');
    return false;
  }
  const message = prepareWelcomeEmail(params);
  const controller = new AbortController();
  const relayAbort = () => controller.abort(params.signal?.reason);
  if (params.signal?.aborted) relayAbort();
  else params.signal?.addEventListener('abort', relayAbort, { once: true });
  const timeout = setTimeout(
    () => controller.abort(new DOMException('Welcome email timed out', 'TimeoutError')),
    WELCOME_EMAIL_TIMEOUT_MS,
  );

  try {
    const result = await sendPreparedWelcomeEmailDetailed({
      resendApiKey: apiKey,
      message,
      idempotencyKey: params.idempotencyKey,
      signal: controller.signal,
    });
    return result.status === 'sent';
  } finally {
    clearTimeout(timeout);
    params.signal?.removeEventListener('abort', relayAbort);
  }
}

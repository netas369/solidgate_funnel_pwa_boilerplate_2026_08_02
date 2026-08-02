// Welcome email copy for the Solidgate webhook (Deno + vitest).
// Keep this module dependency-free so vitest can import it directly, and keep
// it in sync with packages/shared/src/email/send-welcome-email.ts — a test
// asserts the two never drift.
//
// ADDING A LOCALE is one object literal: add the tag to WelcomeLocale and
// WELCOME_LOCALES, then the matching entry to WELCOME_EMAIL_COPY. Anything not
// listed falls back to `en` rather than throwing, so shipping a new routing
// locale never breaks the purchase flow while its copy is being translated.

export type WelcomeLocale =
  | 'en'
  | 'cs'
  | 'hu'
  | 'sk'
  | 'ro'
  | 'lt'
  | 'ru'
  | 'lv'
  | 'zh-TW'
  | 'el'
  | 'he'
  | 'pl'
  | 'hr'
  | 'ja'
  | 'da';

export type WelcomeEmailCopy = {
  subject: string;
  eyebrow: string;
  title: string;
  /** Use {brand} placeholder for the brand short name. */
  greeting: string;
  /** Use {email} placeholder for the recipient email. */
  body: string;
  buttonLabel: string;
  /** Use {email} placeholder for the recipient email. */
  signInNote: string;
  /** Use {brand} placeholder for the brand short name. */
  footerTagline: string;
  /** Use {host} placeholder for the PWA host (auto-derived from pwaUrl). */
  footerAuto: string;
};

export const WELCOME_LOCALES: WelcomeLocale[] = [
  'en', 'cs', 'hu', 'sk', 'ro', 'lt', 'ru', 'lv', 'zh-TW', 'el', 'he', 'pl', 'hr', 'ja', 'da',
];

export const WELCOME_EMAIL_COPY: Record<WelcomeLocale, WelcomeEmailCopy> = {
  en: {
    subject: 'Welcome to {brand} — your account is ready',
    eyebrow: 'Welcome aboard',
    title: 'Your account is ready.',
    greeting: 'Thank you for joining {brand}. Your purchase is confirmed, and your member area is ready.',
    body: 'To get started, sign in with the email address this message was sent to ({email}). We’ll send you a one-time code to verify it’s you — no password needed.',
    buttonLabel: 'Access your account',
    signInNote: 'Use {email} to sign in.',
    footerTagline: '{brand}',
    footerAuto: 'This is an automated message from {host}.',
  },
  cs: {
    subject: '{brand}: můžete se přihlásit ke svému účtu',
    eyebrow: 'Váš přístup je aktivní',
    title: 'Váš účet je připraven.',
    greeting: 'Vaše objednávka byla potvrzena. Členská sekce {brand} je pro vás připravena.',
    body: 'Pro začátek se přihlaste pomocí e-mailové adresy, na kterou jsme tuto zprávu poslali ({email}). Pro ověření, že jste to opravdu vy, vám pošleme jednorázový kód – heslo není potřeba.',
    buttonLabel: 'Přihlásit se k účtu',
    signInNote: 'K přihlášení použijte adresu {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Toto je automatická zpráva od {host}.',
  },
  hu: {
    subject: '{brand}: már beléphetsz a fiókodba',
    eyebrow: 'A hozzáférésed aktív',
    title: 'A fiókod készen áll.',
    greeting: 'Vásárlásodat visszaigazoltuk. A {brand} tagi felülete már elérhető számodra.',
    body: 'A kezdéshez jelentkezz be azzal az e-mail-címmel, amelyre ezt az üzenetet küldtük ({email}). Küldünk egy egyszer használatos kódot annak ellenőrzésére, hogy valóban te vagy-e – jelszóra nincs szükség.',
    buttonLabel: 'Belépés a fiókba',
    signInNote: 'A bejelentkezéshez használd ezt az e-mail-címet: {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Ez egy automatikus üzenet. Feladó: {host}.',
  },
  sk: {
    subject: '{brand}: môžete sa prihlásiť do svojho účtu',
    eyebrow: 'Váš prístup je aktívny',
    title: 'Váš účet je pripravený.',
    greeting: 'Vaša objednávka bola potvrdená. Členská sekcia {brand} je pre vás pripravená.',
    body: 'Ak chcete začať, prihláste sa pomocou e-mailovej adresy, na ktorú sme túto správu poslali ({email}). Aby sme overili, že ste to naozaj vy, pošleme vám jednorazový kód – heslo nie je potrebné.',
    buttonLabel: 'Prihlásiť sa do účtu',
    signInNote: 'Na prihlásenie použite adresu {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Toto je automatická správa od {host}.',
  },
  ro: {
    subject: '{brand}: te poți autentifica în contul tău',
    eyebrow: 'Accesul tău este activ',
    title: 'Contul tău este gata.',
    greeting: 'Achiziția ta a fost confirmată. Ai acum acces la zona rezervată membrilor {brand}.',
    body: 'Pentru a începe, autentifică-te folosind adresa de e-mail la care ai primit acest mesaj ({email}). Îți vom trimite un cod de unică folosință pentru a-ți confirma identitatea – nu ai nevoie de parolă.',
    buttonLabel: 'Accesează-ți contul',
    signInNote: 'Autentifică-te folosind adresa de e-mail {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Acesta este un mesaj automat de la {host}.',
  },
  lt: {
    subject: '{brand}: galite prisijungti prie savo paskyros',
    eyebrow: 'Galite prisijungti',
    title: 'Jūsų paskyra paruošta.',
    greeting: 'Jūsų užsakymas patvirtintas. Dabar galite naudotis savo {brand} paskyra.',
    body: 'Norėdami pradėti, prisijunkite naudodami el. pašto adresą, kuriuo gavote šį laišką ({email}). Atsiųsime vienkartinį kodą jūsų tapatybei patvirtinti – slaptažodžio nereikia.',
    buttonLabel: 'Prisijungti prie paskyros',
    signInNote: 'Prisijunkite naudodami el. pašto adresą {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Šį automatinį pranešimą išsiuntė {host}.',
  },
  ru: {
    subject: '{brand}: ваш аккаунт готов',
    eyebrow: 'Доступ к аккаунту',
    title: 'Ваш аккаунт готов.',
    greeting: 'Ваша покупка подтверждена. Ваш личный кабинет {brand} уже готов к работе.',
    body: 'Чтобы начать, войдите, используя адрес электронной почты, на который было отправлено это письмо ({email}). Для подтверждения личности мы пришлём одноразовый код — пароль не понадобится.',
    buttonLabel: 'Войти в аккаунт',
    signInNote: 'Для входа используйте {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Это автоматическое сообщение от {host}.',
  },
  lv: {
    subject: '{brand}: jūsu konts ir gatavs',
    eyebrow: 'Piekļuve kontam',
    title: 'Jūsu konts ir gatavs.',
    greeting: 'Jūsu pirkums ir apstiprināts. Jūsu {brand} konts ir gatavs lietošanai.',
    body: 'Lai sāktu, pierakstieties, izmantojot e-pasta adresi, uz kuru tika nosūtīta šī ziņa ({email}). Mēs nosūtīsim vienreiz lietojamu kodu, lai apstiprinātu jūsu identitāti — parole nav nepieciešama.',
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
    body: '請使用收到這封信的電子郵件地址（{email}）登入，即可開始使用。我們會寄送一次性驗證碼來確認是您本人，無須使用密碼。',
    buttonLabel: '登入您的帳戶',
    signInNote: '請使用 {email} 登入。',
    footerTagline: '{brand}',
    footerAuto: '此郵件由 {host} 自動寄送。',
  },
  el: {
    subject: '{brand}: ο λογαριασμός σου είναι έτοιμος',
    eyebrow: 'Καλώς ήρθες',
    title: 'Ο λογαριασμός σου είναι έτοιμος.',
    greeting: 'Η αγορά σου επιβεβαιώθηκε. Ο προσωπικός σου χώρος στο {brand} είναι έτοιμος.',
    body: 'Για να ξεκινήσεις, συνδέσου χρησιμοποιώντας τη διεύθυνση email στην οποία στάλθηκε αυτό το μήνυμα ({email}). Θα σου στείλουμε έναν κωδικό μίας χρήσης για να επιβεβαιώσουμε ότι είσαι εσύ — δεν χρειάζεται κωδικός πρόσβασης.',
    buttonLabel: 'Σύνδεση στον λογαριασμό σου',
    signInNote: 'Για να συνδεθείς, χρησιμοποίησε το {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Το μήνυμα αυτό στάλθηκε αυτόματα από το {host}.',
  },
  he: {
    subject: '{brand}: החשבון שלך מוכן',
    eyebrow: 'ברוכים הבאים',
    title: 'החשבון שלך מוכן.',
    greeting: 'הרכישה שלך אושרה, והאזור האישי שלך ב־{brand} כבר מוכן.',
    body: 'כדי להתחיל, יש להתחבר באמצעות כתובת האימייל שאליה נשלחה הודעה זו ({email}). נשלח אליך קוד חד־פעמי כדי לאמת את זהותך — אין צורך בסיסמה.',
    buttonLabel: 'כניסה לחשבון שלך',
    signInNote: 'יש להתחבר באמצעות {email}.',
    footerTagline: '{brand}',
    footerAuto: 'הודעה זו נשלחה אוטומטית על ידי {host}.',
  },
  pl: {
    subject: '{brand}: Twoje konto jest gotowe',
    eyebrow: 'Dostęp do konta',
    title: 'Twoje konto jest gotowe.',
    greeting: 'Twój zakup został potwierdzony. Twoje konto {brand} jest już gotowe.',
    body: 'Aby rozpocząć, zaloguj się za pomocą adresu e-mail, na który wysłaliśmy tę wiadomość ({email}). Na ten adres wyślemy jednorazowy kod weryfikacyjny — hasło nie będzie potrzebne.',
    buttonLabel: 'Przejdź do swojego konta',
    signInNote: 'Zaloguj się za pomocą adresu {email}.',
    footerTagline: '{brand}',
    footerAuto: 'To automatyczna wiadomość od {host}.',
  },
  hr: {
    subject: '{brand}: vaš je korisnički račun spreman',
    eyebrow: 'Pristup računu',
    title: 'Vaš je korisnički račun spreman.',
    greeting: 'Vaša je kupnja potvrđena. Vaš korisnički račun za {brand} spreman je za upotrebu.',
    body: 'Za početak se prijavite pomoću adrese e-pošte na koju je poslana ova poruka ({email}). Poslat ćemo vam jednokratni kod kako bismo potvrdili da ste to vi — lozinka nije potrebna.',
    buttonLabel: 'Pristupite svom računu',
    signInNote: 'Za prijavu upotrijebite adresu {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Ovo je automatska poruka koju šalje {host}.',
  },
  ja: {
    subject: '{brand}へようこそ — アカウントの準備が整いました',
    eyebrow: 'ようこそ',
    title: 'アカウントの準備が整いました。',
    greeting: '{brand}をご利用いただきありがとうございます。ご購入を確認いたしました。お客様専用の会員ページはすでにご利用いただけます。',
    body: 'このメールを受信したメールアドレス（{email}）でサインインしてください。ご本人確認用のワンタイムコードをお送りします。パスワードは必要ありません。',
    buttonLabel: 'アカウントにサインイン',
    signInNote: 'サインインには{email}をご使用ください。',
    footerTagline: '{brand}',
    footerAuto: 'このメールは{host}から自動送信されています。',
  },
  da: {
    subject: '{brand}: din konto er klar',
    eyebrow: 'Adgang til din konto',
    title: 'Din konto er klar.',
    greeting: 'Dit køb er bekræftet. Din konto hos {brand} er klar til brug.',
    body: 'For at komme i gang skal du logge ind med den e-mailadresse, som denne besked blev sendt til ({email}). Vi sender dig en engangskode, så vi kan bekræfte, at det er dig — du behøver ikke en adgangskode.',
    buttonLabel: 'Log ind på din konto',
    signInNote: 'Log ind med {email}.',
    footerTagline: '{brand}',
    footerAuto: 'Dette er en automatisk besked fra {host}.',
  },
};

/**
 * Right-to-left routing locales. Deliberately matched against the RAW locale
 * rather than the normalized one: a locale can be RTL before its copy has been
 * translated, and an RTL reader must not get an LTR layout just because they
 * are currently reading the English fallback.
 */
const RTL_LOCALES = new Set(['he', 'ar', 'fa', 'ur']);

export function normalizeWelcomeLocale(locale?: string | null): WelcomeLocale {
  return WELCOME_LOCALES.includes(locale as WelcomeLocale)
    ? (locale as WelcomeLocale)
    : 'en';
}

export function getWelcomeEmailCopy(locale?: string | null): WelcomeEmailCopy {
  return WELCOME_EMAIL_COPY[normalizeWelcomeLocale(locale)];
}

export function getWelcomeEmailDir(locale?: string | null): 'ltr' | 'rtl' {
  return locale != null && RTL_LOCALES.has(locale) ? 'rtl' : 'ltr';
}

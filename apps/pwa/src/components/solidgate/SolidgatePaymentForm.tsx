"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import Payment, { SdkLoader } from "@solidgate/react-sdk";
import type { SdkMessage } from "@solidgate/react-sdk";
import type { MerchantData } from "@/lib/solidgate/checkout";

/**
 * The Solidgate hosted form, dressed for the member area.
 *
 * The member area runs on the dark surface while the funnel checkout is light,
 * so the form gets its own skin. It is an iframe: it owns the card fields, 3DS
 * and tokenisation, and we only listen.
 */

// Solidgate's white-label CDN. Module scope: SdkLoader dedupes on first call, so
// this must win before any <Payment> mounts. SSR-safe (resolves null on server).
SdkLoader.load("https://cdn.charge-auth.com/js/form.js");

// The Solidgate SDK styles an IFRAME, so it cannot read our CSS custom
// properties — these must be literal values. Keep them in step with the
// [data-surface="dark"] block in dashboard/_components/theme.css, or the form
// will visibly not belong to the sheet it is mounted in.
const PAPER = "#131519";
const PAPER_SOFT = "#1c1f25";
const INK = "#eceef1";
const INK_SOFT = "#a8aeb8";
const HAIRLINE = "rgba(255,255,255,0.22)";
const DANGER = "#ff6b5e";
const SANS = "system-ui, -apple-system, 'Segoe UI', sans-serif";

const INPUT = {
  "background-color": PAPER_SOFT,
  color: INK,
  border: `1px solid ${HAIRLINE}`,
  "border-radius": "0px",
  padding: "13px 14px",
  "font-size": "15px",
  "font-family": SANS,
  height: "48px",
  ":focus": { "border-color": INK, outline: "none", "box-shadow": "none" },
  "::placeholder": { color: "rgba(236,238,241,0.38)" },
} as const;

// Field keys (card_number, expiry_date, …) style the WRAPPER that also holds
// the label — bare CSS there draws a second box around label+input and the
// 48px input overflows it. Target the children instead.
const FIELD = {
  input: INPUT,
  ".label": {
    color: INK_SOFT,
    "font-size": "10px",
    "font-weight": "600",
    "text-transform": "uppercase",
    "letter-spacing": "0.18em",
    "margin-bottom": "6px",
  },
  ".error input": { "border-color": DANGER },
  ".error .label": { color: DANGER },
} as const;

const FORM_STYLES: Record<string, unknown> = {
  form_body: { "background-color": PAPER, "font-family": SANS, color: INK_SOFT },
  input_group: { margin: "0 0 14px 0" },
  card_number: FIELD,
  expiry_date: FIELD,
  card_cvv: FIELD,
  card_holder: FIELD,
  submit_button: {
    // Inverted on the dark surface: ivory button, near-black label.
    "background-color": INK,
    color: PAPER,
    border: `1px solid ${INK}`,
    "border-radius": "0px",
    width: "100%",
    padding: "16px 18px",
    "font-size": "15px",
    "letter-spacing": "0.06em",
    "font-weight": "600",
    "font-family": SANS,
    cursor: "pointer",
    ":disabled": { "background-color": "rgba(255,255,255,0.22)", cursor: "not-allowed" },
  },
  body_errors: { color: DANGER, "font-size": "13px", "text-align": "center", "margin-top": "8px" },
};

// The iframe cannot use next/font, so a web font has to reach it by URL.
// TODO(new product): point this at the brand face (and drop it entirely if the
// system stack above is good enough — one less third-party request).
const GOOGLE_FONT_LINK =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap";

export interface SolidgatePaymentFormProps {
  merchantData: MerchantData;
  orderId: string;
  buttonText: string;
  /**
   * After submission, SDK success/fail/error all request confirmation here.
   * They are browser claims; the caller must confirm this exact `orderId`
   * server-side before unlocking anything.
   */
  onPaid: (orderId: string) => void;
  onFail: (message: string) => void;
  /** Enable only on purchase forms whose intent carries Apple merchant data. */
  enableApplePay?: boolean;
  /** Point-of-payment credential-on-file disclosure supplied in the UI locale. */
  savedMethodDisclosure?: string;
}

export function SolidgatePaymentForm({
  orderId,
  ...props
}: SolidgatePaymentFormProps) {
  // Key the latch, not merely the SDK iframe. Parent rerenders and refreshed
  // merchant data for the same provider identity must never revive a submitted
  // form; only a genuinely different N+1 identity may do that.
  return <LatchedSolidgatePaymentForm key={orderId} orderId={orderId} {...props} />;
}

function LatchedSolidgatePaymentForm({
  merchantData,
  orderId,
  buttonText,
  onPaid,
  onFail,
  enableApplePay = false,
  savedMethodDisclosure,
}: SolidgatePaymentFormProps) {
  const submitted = useRef(false);
  const confirmationRequested = useRef(false);
  const [inert, setInert] = useState(false);

  const confirmSameOrderOnce = useCallback(() => {
    if (confirmationRequested.current) return;
    confirmationRequested.current = true;
    setInert(true);
    onPaid(orderId);
  }, [onPaid, orderId]);

  const handleSubmit = useCallback(() => {
    submitted.current = true;
  }, []);

  const handleSuccess = useCallback(() => {
    // Success necessarily follows a provider submission even if a wallet/SDK
    // version omitted the submit event. It is still only a browser claim.
    confirmSameOrderOnce();
  }, [confirmSameOrderOnce]);

  const handleFail = useCallback((event: SdkMessage["fail"]) => {
    if (submitted.current) {
      // A post-submit "fail" can race a successful 3DS/settlement callback.
      // Re-read the same server-bound order instead of declaring a decline.
      confirmSameOrderOnce();
      return;
    }
    onFail(event.message ?? event.code ?? "payment_failed");
  }, [confirmSameOrderOnce, onFail]);

  const handleError = useCallback(() => {
    if (submitted.current) {
      confirmSameOrderOnce();
      return;
    }
    onFail("payment_error");
  }, [confirmSameOrderOnce, onFail]);

  const formParams = useMemo(
    () => ({
      enabled: true,
      submitButtonText: buttonText,
      googleFontLink: GOOGLE_FONT_LINK,
      isCardHolderVisible: false,
      headerText: "",
      titleText: "",
    }),
    [buttonText],
  );

  return (
    <div
      aria-busy={inert}
      inert={inert ? true : undefined}
      style={{ pointerEvents: inert ? "none" : "auto", opacity: inert ? 0.6 : 1 }}
    >
      <Payment
        merchantData={merchantData}
        styles={FORM_STYLES}
        formParams={formParams}
        applePayButtonParams={enableApplePay
          ? { enabled: true, integrationType: "js" }
          : { enabled: false }}
        googlePayButtonParams={{ enabled: false }}
        paypalButtonParams={{ enabled: false }}
        pixButtonParams={{ enabled: false }}
        upiButtonParams={{ enabled: false }}
        pixQrButtonParams={{ enabled: false }}
        bizumButtonParams={{ enabled: false }}
        blikButtonParams={{ enabled: false }}
        mbwayButtonParams={{ enabled: false }}
        cashAppButtonParams={{ enabled: false }}
        pixAutomaticoButtonParams={{ enabled: false }}
        clickToPayButtonParams={{ enabled: false }}
        width="100%"
        onSubmit={handleSubmit}
        onSuccess={handleSuccess}
        onFail={handleFail}
        onError={handleError}
      />
      {savedMethodDisclosure && (
        <p style={{ margin: "10px 0 0", textAlign: "center", fontSize: 12, lineHeight: 1.5, color: "var(--ink-soft)" }}>
          {savedMethodDisclosure}
        </p>
      )}
    </div>
  );
}

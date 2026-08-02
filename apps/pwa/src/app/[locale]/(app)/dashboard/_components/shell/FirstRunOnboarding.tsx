"use client";

import * as React from "react";
import { useTranslations } from "next-intl";
import { IconHome, IconLibrary, IconProfile } from "../icons/nav";
import { BrandMark } from "@/components/BrandMark";
import styles from "./FirstRunOnboarding.module.css";

export const ONBOARDING_STORAGE_KEY = "app_onboarding_complete";

type OnboardingMode = "auto" | "replay";
type StepId = "welcome" | "explore" | "learn" | "preparing";
type DestinationId = "home" | "library" | "profile";

const STEPS: readonly StepId[] = ["welcome", "explore", "learn", "preparing"];

const DESTINATIONS: readonly {
  id: DestinationId;
  icon: React.ComponentType<{ size?: number; filled?: boolean }>;
}[] = [
  { id: "home", icon: IconHome },
  { id: "library", icon: IconLibrary },
  { id: "profile", icon: IconProfile },
];

/**
 * Hero slot for the welcome step.
 *
 * TODO(new product): put the real hero here (a product screenshot, an
 * illustration, a live preview of what the member just bought). It is a plain
 * CSS composition on purpose — the boilerplate ships no artwork, so anything
 * referencing an image file would 404.
 */
function WelcomeFigure() {
  return <div className={styles.heroPlate} aria-hidden="true" />;
}

function LearningFigure() {
  return (
    <div className={styles.learningPlate} aria-hidden="true">
      <div className={styles.learningHero}>
        <div className={styles.learningLine} style={{ inlineSize: "44%" }} />
        <div className={styles.learningLine} />
        <div className={styles.learningLine} />
      </div>
      <div className={styles.learningRows}>
        {["72%", "58%", "81%"].map((width) => (
          <div key={width} className={styles.learningRow}>
            <span className={styles.learningRowDiamond} />
            <span
              className={styles.learningRowLine}
              style={{ "--line-width": width } as React.CSSProperties}
            />
            <span className={styles.learningRowArrow}>→</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function PreparingFigure({
  ready,
  preparingLabel,
  readyLabel,
}: {
  ready: boolean;
  preparingLabel: string;
  readyLabel: string;
}) {
  return (
    <div className={styles.preparingFigure}>
      <div className={styles.orbitStatus} aria-hidden="true">
        {[
          { inset: "0px", opacity: 0.58 },
          { inset: "28px", opacity: 0.42 },
          { inset: "55px", opacity: 0.3 },
        ].map(({ inset, opacity }) => (
          <span
            key={inset}
            className={styles.orbitRing}
            style={
              {
                "--ring-inset": inset,
                "--ring-opacity": opacity,
              } as React.CSSProperties
            }
          />
        ))}
        {!ready &&
          [
            { inset: "4px", speed: "8s", size: "9px" },
            { inset: "32px", speed: "5s", size: "7px" },
            { inset: "59px", speed: "3s", size: "6px" },
          ].map(({ inset, speed, size }) => (
            <span
              key={inset}
              className={styles.orbitPlanetTrack}
              style={
                {
                  "--planet-inset": inset,
                  "--planet-speed": speed,
                  "--planet-size": size,
                } as React.CSSProperties
              }
            >
              <span className={styles.orbitPlanet} />
            </span>
          ))}
        <span className={styles.orbitSun} />
        {ready && <span className={styles.readyMark}>✓</span>}
      </div>
      <p className={styles.status} role="status" aria-live="polite">
        {ready ? readyLabel : preparingLabel}
      </p>
    </div>
  );
}

function DestinationFigure() {
  const t = useTranslations("pwa.onboarding.steps.explore");
  const tNav = useTranslations("pwa.nav");

  return (
    <div className={styles.destinationGrid}>
      {DESTINATIONS.map(({ id, icon: Icon }) => (
        <div key={id} className={styles.destination}>
          <span className={styles.destinationIcon} aria-hidden="true">
            <Icon size={19} />
          </span>
          <div>
            <h3 className={styles.destinationTitle}>{tNav(id)}</h3>
            <p className={styles.destinationDescription}>{t(`items.${id}`)}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

export function FirstRunOnboarding({
  mode,
  ready,
  returnFocusRef,
  onClose,
}: {
  mode: OnboardingMode;
  /** True once the member's first-visit content has finished loading. Drives
   *  the "preparing" step, which exists so a slow first provisioning does not
   *  look like a broken app. Pass `true` when nothing has to be prepared. */
  ready: boolean;
  returnFocusRef?: React.RefObject<HTMLButtonElement | null>;
  onClose: () => void;
}) {
  const t = useTranslations("pwa.onboarding");
  const tTopnav = useTranslations("pwa.topnav");
  const [stepIndex, setStepIndex] = React.useState(0);
  // Keep the server-rendered tour hidden until storage has been checked. The
  // dashboard remains visible beneath it, so returning members never see a
  // full-screen onboarding flash while the client bundle hydrates.
  const [visible, setVisible] = React.useState(true);
  const [storageChecked, setStorageChecked] = React.useState(mode === "replay");
  const dismissedInteractivelyRef = React.useRef(false);
  const dialogRef = React.useRef<HTMLDivElement | null>(null);
  const titleRef = React.useRef<HTMLHeadingElement | null>(null);
  const total = STEPS.length;
  const stepId = STEPS[stepIndex];
  const isLast = stepIndex === total - 1;

  React.useEffect(() => {
    if (mode === "replay") return;

    let completed = false;
    try {
      completed = localStorage.getItem(ONBOARDING_STORAGE_KEY) !== null;
    } catch {
      // Storage may be blocked. The tour still works for this visit.
    }

    if (completed) {
      setVisible(false);
      onClose();
      return;
    }
    setStorageChecked(true);
  }, [mode, onClose]);

  const dismiss = React.useCallback(() => {
    dismissedInteractivelyRef.current = true;
    try {
      localStorage.setItem(ONBOARDING_STORAGE_KEY, "true");
    } catch {
      // Completion remains non-blocking when storage is unavailable.
    }
    setVisible(false);
    onClose();
  }, [onClose]);

  React.useEffect(() => {
    if (!visible) return;

    const previousFocus =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const fallbackFocus = returnFocusRef?.current ?? null;
    titleRef.current?.focus({ preventScroll: true });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        dismiss();
        return;
      }
      if (event.key !== "Tab") return;

      const focusables = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      ).filter((element) => !element.hasAttribute("hidden"));

      if (focusables.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const activeElement =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (
        event.shiftKey &&
        (activeElement === first ||
          activeElement === titleRef.current ||
          !dialogRef.current?.contains(activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      const previousFocusIsUsable =
        previousFocus?.isConnected &&
        previousFocus !== document.body &&
        !previousFocus.closest('[aria-hidden="true"], [inert]');
      const focusTarget = previousFocusIsUsable
        ? previousFocus
        : dismissedInteractivelyRef.current
          ? fallbackFocus
          : null;
      if (focusTarget?.isConnected) {
        focusTarget.focus({ preventScroll: true });
      }
    };
  }, [dismiss, returnFocusRef, visible]);

  React.useEffect(() => {
    if (!visible) return;
    titleRef.current?.focus({ preventScroll: true });
  }, [stepIndex, visible]);

  if (!visible) return null;

  const titleId = "first-run-onboarding-title";
  const descriptionId = "first-run-onboarding-description";

  return (
    <div
      className={`${styles.layer} ${storageChecked ? styles.layerReady : ""}`}
    >
      <div
        ref={dialogRef}
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label={t("dialogLabel")}
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <header className={styles.header}>
          <div className={styles.brand}>
            <BrandMark size={20} />
            <span className={`${styles.brandName} display`}>{tTopnav("brand")}</span>
          </div>
          <button type="button" className={styles.quietButton} onClick={dismiss}>
            {mode === "replay" ? t("close") : t("skip")}
          </button>
        </header>

        <div className={styles.body}>
          <section
            key={stepId}
            className={styles.step}
          >
            <div className={styles.copy}>
              <div className={styles.kicker}>{t(`steps.${stepId}.kicker`)}</div>
              <h2
                ref={titleRef}
                id={titleId}
                className={styles.title}
                tabIndex={-1}
              >
                {t(`steps.${stepId}.title`)}
              </h2>
              <p id={descriptionId} className={styles.description}>
                {t(`steps.${stepId}.body`)}
              </p>
              {stepId === "preparing" && (
                <p className={styles.description}>
                  {t("steps.preparing.keepBrowsing")}
                </p>
              )}
            </div>

            <div className={styles.figure}>
              {stepId === "welcome" && <WelcomeFigure />}
              {stepId === "explore" && <DestinationFigure />}
              {stepId === "learn" && <LearningFigure />}
              {stepId === "preparing" && (
                <PreparingFigure
                  ready={ready}
                  preparingLabel={t("statusPreparing")}
                  readyLabel={t("statusReady")}
                />
              )}
            </div>
          </section>
        </div>

        <footer className={styles.footer}>
          <button
            type="button"
            className={styles.backButton}
            disabled={stepIndex === 0}
            onClick={() => setStepIndex((current) => Math.max(0, current - 1))}
          >
            {t("back")}
          </button>

          <div
            className={styles.progress}
            role="progressbar"
            aria-valuemin={1}
            aria-valuemax={total}
            aria-valuenow={stepIndex + 1}
            aria-valuetext={t("progress", { current: stepIndex + 1, total })}
          >
            <span className={styles.progressCount} aria-hidden="true">
              <bdi dir="ltr">
                {String(stepIndex + 1).padStart(2, "0")} / {String(total).padStart(2, "0")}
              </bdi>
            </span>
            <span className={styles.progressDiamonds} aria-hidden="true">
              {STEPS.map((step, index) => (
                <span
                  key={step}
                  className={`${styles.progressDiamond} ${
                    index === stepIndex ? styles.progressDiamondActive : ""
                  }`}
                />
              ))}
            </span>
          </div>

          <button
            type="button"
            className={styles.nextButton}
            onClick={() => {
              if (isLast) {
                dismiss();
                return;
              }
              setStepIndex((current) => Math.min(total - 1, current + 1));
            }}
          >
            {isLast ? t("finish") : t("next")}
          </button>
        </footer>
      </div>
    </div>
  );
}

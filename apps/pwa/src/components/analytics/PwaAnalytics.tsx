"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { capturePwaEvent, capturePwaPageView } from "@/lib/analytics/internal";
import type { AcquisitionUtm } from "@/lib/analytics/acquisition";

const INSTALLED_KEY_PREFIX = "internal-analytics:pwa-installed:";

export function PwaAnalytics({
  userId,
  locale,
  acquisition,
}: {
  userId: string;
  locale: string;
  acquisition?: AcquisitionUtm;
}) {
  const pathname = usePathname();

  useEffect(() => {
    if (!pathname) return;
    void capturePwaPageView(pathname, locale, acquisition);
  }, [acquisition, locale, pathname]);

  useEffect(() => {
    void capturePwaEvent(
      "first_login",
      { locale, ...acquisition },
      { eventKey: `first-login:${userId}` },
    );
  }, [acquisition, locale, userId]);

  useEffect(() => {
    const storageKey = `${INSTALLED_KEY_PREFIX}${userId}`;
    const recordInstall = () => {
      try {
        if (localStorage.getItem(storageKey)) return;
      } catch {
        // Continue without device-level deduplication when storage is blocked.
      }
      void capturePwaEvent(
        "installed_pwa",
        { locale },
        { eventKey: `installed-pwa:${userId}` },
      ).then((captured) => {
        if (!captured) return;
        try {
          localStorage.setItem(storageKey, "1");
        } catch {
          // Non-fatal: the database event key still deduplicates retries.
        }
      });
    };

    window.addEventListener("appinstalled", recordInstall);
    if (window.matchMedia("(display-mode: standalone)").matches) recordInstall();
    return () => window.removeEventListener("appinstalled", recordInstall);
  }, [locale, userId]);

  return null;
}

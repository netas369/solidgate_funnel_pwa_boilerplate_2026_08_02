"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import {
  capturePwaPageView,
  initializePwaAnalytics,
} from "@/lib/analytics/posthog";
import type { AcquisitionUtm } from "@/lib/analytics/acquisition";

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
    if (initializePwaAnalytics(userId, locale, acquisition) && pathname) {
      capturePwaPageView(pathname, locale);
    }
  }, [acquisition, locale, pathname, userId]);

  return null;
}

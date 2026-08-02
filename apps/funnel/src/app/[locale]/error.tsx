"use client";

import { useEffect } from "react";
import { Link } from '@repo/i18n/navigation';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center bg-si-surface">
      <div className="max-w-md p-8 text-center">
        <h1 className="font-[family-name:var(--font-sans)] font-bold text-2xl text-si-primary">
          Something went wrong
        </h1>
        <p className="text-si-on-surface-variant text-sm mt-3">
          We encountered an unexpected error. Please try again.
        </p>
        <button
          onClick={reset}
          className="mt-6 bg-si-primary text-si-on-primary px-6 py-3 rounded-lg font-medium hover:bg-si-primary-container transition-colors"
        >
          Try again
        </button>
        <div className="mt-2">
          <Link
            href="/"
            className="text-si-secondary underline text-sm"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

'use client';

import { Link, useRouter } from '@repo/i18n/navigation';

export function BackLink({ label }: { label: string }) {
  const router = useRouter();

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault();
    if (typeof window !== 'undefined' && window.history.length > 1) {
      window.history.back();
    } else {
      router.push('/');
    }
  };

  return (
    <Link
      href="/"
      onClick={handleClick}
      className="mb-8 inline-flex items-center gap-1 text-sm text-si-on-surface-variant hover:text-si-primary transition-colors cursor-pointer"
    >
      &larr; {label}
    </Link>
  );
}

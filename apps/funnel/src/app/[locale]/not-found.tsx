import { Link } from '@repo/i18n/navigation';

export default function NotFound() {
  return (
    <div className="min-h-[60vh] flex items-center justify-center bg-si-surface">
      <div className="text-center">
        <p className="font-[family-name:var(--font-sans)] text-6xl font-extrabold text-si-primary-fixed-dim">
          404
        </p>
        <h1 className="font-[family-name:var(--font-sans)] font-bold text-2xl text-si-primary mt-4">
          Page not found
        </h1>
        <p className="text-si-on-surface-variant text-sm mt-2 max-w-sm text-center">
          The page you are looking for does not exist or has been moved.
        </p>
        <Link
          href="/"
          className="mt-6 inline-block bg-si-primary text-si-on-primary px-6 py-3 rounded-lg font-medium hover:bg-si-primary-container transition-colors"
        >
          Back to home
        </Link>
      </div>
    </div>
  );
}

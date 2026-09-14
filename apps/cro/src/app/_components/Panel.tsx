import type { ReactNode } from 'react';
import Link from 'next/link';

/**
 * One tile. Every panel carries a plain-English heading and, where a fuller view
 * exists, a link to it.
 *
 * `minBody` keeps a panel's shape when its query comes back nearly empty. With
 * 17 people in the database the grid otherwise collapses into a ragged edge of
 * different-height tiles, which is most of why sparse data looked broken rather
 * than quiet.
 *
 * `min-w-0` on the section and the body is not tidying. Panels are GRID ITEMS,
 * and a grid item's default `min-width: auto` refuses to shrink below its
 * content's intrinsic width — which, for anything holding a `truncate`
 * (`white-space: nowrap`), is the whole unbroken string. Without it a long label
 * widens the panel past its track instead of ellipsing.
 *
 * It was NOT what caused the production overflow, though the symptom looked
 * identical: that one was `.row`'s unlayered `align-items: center` overriding an
 * `items-stretch` utility inside BarList, which left the line centred and sized
 * to max-content. See the note there and in globals.css. Both are needed —
 * truncation cannot engage until every ancestor between the text and the sized
 * box is both allowed to shrink AND actually filling its parent.
 */
export function Panel({
  title,
  hint,
  href,
  linkLabel = 'See all',
  children,
  className = '',
  minBody = 0,
}: {
  title: string;
  hint?: string;
  href?: string;
  linkLabel?: string;
  children: ReactNode;
  className?: string;
  minBody?: number;
}) {
  return (
    <section className={`card flex min-w-0 flex-col ${className}`}>
      <div className="flex items-start justify-between gap-3 border-b border-hairline px-4 py-3">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-ink">{title}</h3>
          {hint ? <p className="mt-1 text-xs text-ink-faint">{hint}</p> : null}
        </div>
        {href ? (
          <Link
            href={href}
            className="shrink-0 text-xs font-medium text-ink-faint hover:text-ink"
          >
            {linkLabel}
          </Link>
        ) : null}
      </div>
      <div className="min-w-0 flex-1" style={minBody ? { minHeight: minBody } : undefined}>
        {children}
      </div>
    </section>
  );
}

/** Shown inside a panel when its query came back empty. Centred so the tile still reads as intentional. */
export function PanelEmpty({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center px-4 py-8">
      <p className="text-center text-xs text-ink-faint">{children}</p>
    </div>
  );
}

'use client';

import { formatPrice } from '@repo/shared/format-price';
import { PRICE_MAP, type Currency, type Locale, type ProductId } from '@repo/shared/price-map';
import { CheckCircle, Package } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';

// Reverse map: product_name (from any currency) → product slug.
// Used to resolve translated names for legacy orders that lack product_slug.
const PRODUCT_NAME_TO_SLUG: ReadonlyMap<string, ProductId> = (() => {
  const map = new Map<string, ProductId>();
  for (const [slug, byCurrency] of Object.entries(PRICE_MAP)) {
    for (const entry of Object.values(byCurrency)) {
      if (entry?.productName) {
        map.set(entry.productName, slug as ProductId);
      }
    }
  }
  return map;
})();

export interface Order {
  id: string;
  product_name: string;
  product_slug: string | null;
  amount_cents: number;
  currency: string;
}

interface Props {
  orders: Order[];
}

export function OrderSummaryCard({ orders }: Props) {
  const t = useTranslations('success');
  const locale = useLocale() as Locale;

  if (orders.length === 0) {
    return (
      <section className="rounded-xl border border-si-outline-variant/10 bg-white p-6 shadow-sm">
        <div className="flex items-center gap-3">
          <Package className="h-5 w-5 text-si-secondary" />
          <h2 className="text-lg font-bold text-si-primary">{t('order.heading')}</h2>
        </div>
        <p className="mt-4 text-sm text-si-on-surface-variant">
          {t('order.loading')}
        </p>
      </section>
    );
  }

  const total = orders.reduce((s, o) => s + o.amount_cents, 0);
  const currency = orders[0]?.currency ?? 'eur';

  return (
    <section className="overflow-hidden rounded-xl border border-si-outline-variant/10 bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-si-outline-variant/10 bg-si-surface-container-low px-6 py-4">
        <Package className="h-5 w-5 text-si-secondary" />
        <h2 className="font-bold text-si-primary">{t('order.heading')}</h2>
      </div>

      {/* Items */}
      <div className="space-y-0 divide-y divide-si-outline-variant/10 px-6">
        {orders.map((order) => {
          // Resolve slug: prefer DB product_slug, fall back to reverse map from product_name.
          const slug = order.product_slug || PRODUCT_NAME_TO_SLUG.get(order.product_name) || null;
          const displayName = slug && t.has(`orderProducts.${slug}`)
            ? t(`orderProducts.${slug}`)
            : order.product_name;

          return (
          <div key={order.id} className="flex items-center justify-between gap-4 py-4">
            <div className="flex items-center gap-3">
              <CheckCircle className="h-4 w-4 shrink-0 text-si-secondary" />
              <p className="text-sm font-semibold text-si-on-surface">{displayName}</p>
            </div>
            <span className="shrink-0 text-sm font-medium text-si-primary">
              {formatPrice(order.amount_cents, order.currency.toLowerCase() as Currency, locale)}
            </span>
          </div>
          );
        })}
      </div>

      {/* Total */}
      <div className="mx-6 flex items-center justify-between border-t border-si-outline-variant/20 py-5">
        <span className="text-lg font-bold text-si-primary">{t('order.totalPaid')}</span>
        <span
          className="font-heading text-2xl font-extrabold text-si-primary"
          data-testid="total-paid"
        >
          {formatPrice(total, currency.toLowerCase() as Currency, locale)}
        </span>
      </div>
    </section>
  );
}

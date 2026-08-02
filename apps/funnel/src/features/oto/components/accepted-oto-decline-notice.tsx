'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuizStore } from '@/stores/quiz-store';
import {
  ACCEPTED_OTO_DECLINED_EVENT,
  declinedAcceptedOtoKey,
  dismissDeclinedAcceptedOtoOrders,
  readDeclinedAcceptedOtoOrders,
  type DeclinedAcceptedOtoOrder,
} from '../lib/accepted-oto-recovery';

/**
 * Durable banner for accepted-then-declined one-click purchases.
 *
 * A 202 `processing` charge advances the buyer immediately; when the provider
 * later declines it, the recovery sweep retires the order and records a
 * declined notice. Without this banner the buyer walked the rest of the chain
 * believing they bought the product (live repro: an OTO2 subscription declined with
 * 5.04 in production — buyer advanced, Advisors locked, no explanation).
 * Mounted once in the /oto layout so it follows the buyer across pages until
 * dismissed.
 */
export function AcceptedOtoDeclineNotice() {
  const t = useTranslations('oto.common');
  const sessionId = useQuizStore((s) => s.sessionId);
  const [declined, setDeclined] = useState<DeclinedAcceptedOtoOrder[]>([]);

  useEffect(() => {
    if (!sessionId) return;
    const refresh = () => setDeclined(readDeclinedAcceptedOtoOrders(sessionId));

    const onChanged = (event: Event) => {
      if (event instanceof StorageEvent) {
        if (event.key !== declinedAcceptedOtoKey(sessionId)) return;
      } else {
        const detail = (event as CustomEvent<{ sessionId?: string }>).detail;
        if (detail?.sessionId !== sessionId) return;
      }
      refresh();
    };

    refresh();
    window.addEventListener('storage', onChanged);
    window.addEventListener(ACCEPTED_OTO_DECLINED_EVENT, onChanged);
    return () => {
      window.removeEventListener('storage', onChanged);
      window.removeEventListener(ACCEPTED_OTO_DECLINED_EVENT, onChanged);
    };
  }, [sessionId]);

  if (!sessionId || declined.length === 0) return null;

  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 120,
        background: '#ffffff',
        borderTop: '1px solid #d92d20',
        boxShadow: '0 -4px 16px rgba(17, 17, 17, 0.08)',
        padding: '14px 18px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {declined.map((order) => (
          <p
            key={order.orderId}
            style={{ margin: 0, fontSize: 13.5, lineHeight: 1.45, color: '#b42318', fontWeight: 600 }}
          >
            {t('acceptedDeclined', { product: t(`products.${order.productSlug}`) })}
          </p>
        ))}
      </div>
      <button
        type="button"
        onClick={() => dismissDeclinedAcceptedOtoOrders(sessionId)}
        style={{
          flexShrink: 0,
          background: 'none',
          border: '1px solid #11111133',
          color: '#111111',
          fontSize: 13,
          fontWeight: 600,
          padding: '8px 14px',
          cursor: 'pointer',
        }}
      >
        {t('acceptedDeclinedDismiss')}
      </button>
    </div>
  );
}

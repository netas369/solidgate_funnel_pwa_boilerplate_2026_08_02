'use client';

import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  CircleDollarSign,
  Clipboard,
  Download,
  Headphones,
  KeyRound,
  Loader2,
  Mail,
  RefreshCw,
  Search,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import {
  useCallback,
  useId,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import {
  formatSupportAmount,
  formatSupportAmounts,
  formatSupportDate,
  humanizeSupportValue,
} from '@/features/admin/support/format';
import type {
  SupportActionName,
  SupportActionResult,
  SupportReport,
  SupportTone,
} from '@/features/admin/support/types';

type TabId = 'summary' | 'payments' | 'access' | 'activity' | 'actions';

const TABS = [
  { id: 'summary' as const, label: 'Summary', icon: UserRound },
  { id: 'payments' as const, label: 'Payments', icon: CircleDollarSign },
  { id: 'access' as const, label: 'Access', icon: KeyRound },
  { id: 'activity' as const, label: 'Activity', icon: Activity },
  { id: 'actions' as const, label: 'Actions', icon: ShieldCheck },
];

const TONE_CLASSES: Record<SupportTone, string> = {
  positive: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-800',
  critical: 'border-red-200 bg-red-50 text-red-700',
  neutral: 'border-neutral-200 bg-neutral-50 text-neutral-600',
};

const STATUS_TONE: Record<string, SupportTone> = {
  active: 'positive',
  completed: 'positive',
  paid: 'positive',
  trialing: 'positive',
  success: 'positive',
  past_due: 'critical',
  disputed: 'critical',
  failed: 'critical',
  manual_review: 'critical',
  refunded: 'warning',
  canceled: 'warning',
  pending: 'warning',
  processing: 'warning',
  refused: 'warning',
};

function Badge({ tone = 'neutral', children }: { tone?: SupportTone; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}

function statusTone(status: string): SupportTone {
  return STATUS_TONE[status.toLowerCase()] ?? 'neutral';
}

function Panel({
  title,
  subtitle,
  children,
  action,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
      <header className="flex flex-col gap-3 border-b border-neutral-100 px-4 py-4 sm:flex-row sm:items-start sm:justify-between sm:px-5">
        <div>
          <h2 className="text-sm font-semibold text-neutral-950">{title}</h2>
          {subtitle ? <p className="mt-1 text-xs leading-5 text-neutral-500">{subtitle}</p> : null}
        </div>
        {action}
      </header>
      <div className="p-4 sm:p-5">{children}</div>
    </section>
  );
}

function Empty({ children = 'No records found.' }: { children?: ReactNode }) {
  return <p className="py-5 text-center text-sm text-neutral-400">{children}</p>;
}

function Reference({ children }: { children: string | null }) {
  if (!children) return <span className="text-neutral-400">—</span>;
  return (
    <code title={children} className="block max-w-56 truncate text-[11px] text-neutral-500">
      {children}
    </code>
  );
}

function MetricCard({
  label,
  value,
  detail,
  icon: Icon,
}: {
  label: string;
  value: string | number;
  detail: string;
  icon: typeof UserRound;
}) {
  return (
    <div className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-medium text-neutral-500">{label}</p>
          <p className="mt-2 text-xl font-bold tracking-tight text-neutral-950">{value}</p>
        </div>
        <span className="grid size-9 place-items-center rounded-xl bg-sky-50 text-sky-700">
          <Icon size={17} aria-hidden="true" />
        </span>
      </div>
      <p className="mt-2 text-[11px] text-neutral-400">{detail}</p>
    </div>
  );
}

export function SupportConsole({
  allowedActions,
}: {
  allowedActions: readonly SupportActionName[];
}) {
  const inputId = useId();
  const requestSequence = useRef(0);
  const [email, setEmail] = useState('');
  const [searchedEmail, setSearchedEmail] = useState('');
  const [report, setReport] = useState<SupportReport | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('summary');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const loadReport = useCallback(async (value: string, successNotice?: string) => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError('');
    setNotice('');
    try {
      const response = await fetch('/api/admin/support/lookup', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: value }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        report?: SupportReport;
        error?: string;
      };
      if (!response.ok || !body.report) {
        throw new Error(body.error ?? 'The customer report could not be generated.');
      }
      if (requestId !== requestSequence.current) return;
      setReport(body.report);
      setSearchedEmail(body.report.email);
      setEmail(body.report.email);
      setActiveTab('summary');
      if (successNotice) setNotice(successNotice);
    } catch (caught) {
      if (requestId !== requestSequence.current) return;
      setReport(null);
      setError(caught instanceof Error ? caught.message : 'The lookup failed.');
    } finally {
      if (requestId === requestSequence.current) setLoading(false);
    }
  }, []);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void loadReport(email);
  }

  async function copySummary() {
    if (!report) return;
    try {
      await navigator.clipboard.writeText(report.summary);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
    window.setTimeout(() => setCopyState('idle'), 1_800);
  }

  function downloadReport() {
    if (!report) return;
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `customer-support-${report.emailHash.slice(0, 10)}-${report.generatedAt.slice(0, 10)}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <header className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-700">Operations</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-neutral-950">Customer support</h1>
          <p className="mt-1 max-w-2xl text-sm text-neutral-500">
            Search one exact email to inspect identity, payments, access, and fulfillment history.
          </p>
        </div>
        <Badge>Read-only until an action is explicitly confirmed</Badge>
      </header>

      <form onSubmit={submit} className="rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm sm:p-5">
        <label htmlFor={inputId} className="text-xs font-semibold uppercase tracking-[0.12em] text-neutral-500">
          Customer email
        </label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <div className="relative flex-1">
            <Mail className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={16} aria-hidden="true" />
            <input
              id={inputId}
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="customer@example.com"
              autoComplete="off"
              required
              className="w-full rounded-xl border border-neutral-300 bg-white py-2.5 pl-10 pr-3 text-sm text-neutral-950 outline-none transition focus:border-sky-500 focus:ring-2 focus:ring-sky-100"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !email.trim()}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-neutral-950 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {loading ? <Loader2 className="animate-spin" size={16} aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
            {loading ? 'Building report…' : 'Search customer'}
          </button>
          {report ? (
            <button
              type="button"
              onClick={() => void loadReport(searchedEmail)}
              disabled={loading}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-neutral-300 bg-white px-4 py-2.5 text-sm font-semibold text-neutral-700 transition hover:bg-neutral-50 disabled:opacity-50"
            >
              <RefreshCw size={15} aria-hidden="true" />
              Refresh
            </button>
          ) : null}
        </div>
        <p className="mt-2 text-xs text-neutral-400">
          Exact match only. Lookups do not write to the database. All timestamps are UTC.
        </p>
      </form>

      {error ? (
        <p role="alert" className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </p>
      ) : null}

      {!report && !loading && !error ? (
        <div className="grid min-h-64 place-items-center rounded-2xl border border-dashed border-neutral-300 bg-white/60 px-6 text-center">
          <div>
            <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-neutral-100 text-neutral-500">
              <Headphones size={22} aria-hidden="true" />
            </span>
            <p className="mt-4 text-sm font-semibold text-neutral-700">Customer evidence will appear here</p>
            <p className="mt-1 text-xs text-neutral-400">No provider requests or database writes happen before a search.</p>
          </div>
        </div>
      ) : null}

      {report ? (
        <>
          <section className={`rounded-2xl border p-5 ${TONE_CLASSES[report.answer.tone]}`}>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex items-start gap-3">
                {report.answer.tone === 'positive' ? (
                  <CheckCircle2 className="mt-0.5 shrink-0" size={20} aria-hidden="true" />
                ) : report.answer.tone === 'critical' || report.answer.tone === 'warning' ? (
                  <AlertTriangle className="mt-0.5 shrink-0" size={20} aria-hidden="true" />
                ) : (
                  <UserRound className="mt-0.5 shrink-0" size={20} aria-hidden="true" />
                )}
                <div>
                  <h2 className="font-semibold">{report.answer.headline}</h2>
                  <p className="mt-1 text-sm opacity-80">{report.answer.detail}</p>
                </div>
              </div>
              <div className="flex shrink-0 flex-wrap gap-2">
                <button type="button" onClick={() => void copySummary()} className="inline-flex items-center gap-2 rounded-lg border border-current/20 bg-white/70 px-3 py-2 text-xs font-semibold hover:bg-white">
                  <Clipboard size={14} aria-hidden="true" />
                  {copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy summary'}
                </button>
                <button type="button" onClick={downloadReport} className="inline-flex items-center gap-2 rounded-lg border border-current/20 bg-white/70 px-3 py-2 text-xs font-semibold hover:bg-white">
                  <Download size={14} aria-hidden="true" />
                  JSON
                </button>
              </div>
            </div>
          </section>

          {report.warnings.length > 0 ? (
            <section className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-amber-900">
              <p className="text-sm font-semibold">Partial-data warnings</p>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs">
                {report.warnings.map((warning, index) => (
                  <li key={`${warning.source}-${index}`}>{warning.message}</li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
            <MetricCard label="Customer" value={humanizeSupportValue(report.customerStatus)} detail={`${report.accounts.length} linked account${report.accounts.length === 1 ? '' : 's'}`} icon={UserRound} />
            <MetricCard label="Captured" value={formatSupportAmounts(report.metrics.captured)} detail={`${report.metrics.orders} order${report.metrics.orders === 1 ? '' : 's'}`} icon={CircleDollarSign} />
            <MetricCard label="Subscriptions" value={report.metrics.activeSubscriptions} detail="Active, trialing, or past due" icon={RefreshCw} />
            <MetricCard label="Active access" value={report.metrics.activeEntitlements} detail="Non-expired entitlements" icon={KeyRound} />
            <MetricCard label="Needs review" value={report.metrics.paymentFailures + report.metrics.operationalFailures} detail="Payment and fulfillment issues" icon={AlertTriangle} />
          </section>

          <section className="overflow-hidden rounded-2xl border border-neutral-200 bg-white shadow-sm">
            <div role="tablist" aria-label="Customer support sections" className="flex gap-1 overflow-x-auto border-b border-neutral-200 bg-neutral-50/80 px-3 pt-2">
              {TABS.map((item) => {
                const Icon = item.icon;
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="tab"
                    id={`support-tab-${item.id}`}
                    aria-controls={`support-panel-${item.id}`}
                    aria-selected={activeTab === item.id}
                    onClick={() => setActiveTab(item.id)}
                    className={activeTab === item.id ? 'inline-flex shrink-0 items-center gap-2 border-b-2 border-sky-600 px-3 py-2.5 text-sm font-semibold text-sky-700' : 'inline-flex shrink-0 items-center gap-2 border-b-2 border-transparent px-3 py-2.5 text-sm font-medium text-neutral-500 hover:text-neutral-900'}
                  >
                    <Icon size={15} aria-hidden="true" />
                    {item.label}
                  </button>
                );
              })}
            </div>
            <div role="tabpanel" id={`support-panel-${activeTab}`} aria-labelledby={`support-tab-${activeTab}`} className="bg-neutral-50/40 p-4 sm:p-5">
              {activeTab === 'summary' ? <Summary report={report} /> : null}
              {activeTab === 'payments' ? <Payments report={report} /> : null}
              {activeTab === 'access' ? <Access report={report} /> : null}
              {activeTab === 'activity' ? <ActivityPanel report={report} /> : null}
              {activeTab === 'actions' ? (
                <Actions
                  report={report}
                  allowedActions={allowedActions}
                  onComplete={(message) => {
                    void loadReport(
                      report.email,
                      `${message} The customer report was refreshed.`,
                    );
                  }}
                />
              ) : null}
            </div>
          </section>
        </>
      ) : null}
    </div>
  );
}

function Summary({ report }: { report: SupportReport }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Panel title="Account identity" subtitle="Authentication data and project-neutral member activity.">
        {report.accounts.length === 0 ? <Empty>No registered account matches this email.</Empty> : (
          <div className="space-y-5">
            {report.accounts.map((account) => (
              <dl key={account.userId} className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                <dt className="text-neutral-500">Email</dt><dd className="text-right font-medium text-neutral-900">{account.email}</dd>
                <dt className="text-neutral-500">User ID</dt><dd className="text-right"><Reference>{account.userId}</Reference></dd>
                <dt className="text-neutral-500">Created</dt><dd className="text-right text-neutral-700">{formatSupportDate(account.createdAt)}</dd>
                <dt className="text-neutral-500">Email confirmed</dt><dd className="text-right text-neutral-700">{formatSupportDate(account.emailConfirmedAt)}</dd>
                <dt className="text-neutral-500">Last sign-in</dt><dd className="text-right text-neutral-700">{formatSupportDate(account.lastSignInAt)}</dd>
                <dt className="text-neutral-500">Last app activity</dt><dd className="text-right text-neutral-700">{formatSupportDate(account.lastActiveAt)}</dd>
                <dt className="text-neutral-500">Locale / country</dt><dd className="text-right text-neutral-700">{[account.locale, account.country].filter(Boolean).join(' · ') || '—'}</dd>
                <dt className="text-neutral-500">App opens</dt><dd className="text-right text-neutral-700">{account.appOpenCount}</dd>
              </dl>
            ))}
          </div>
        )}
      </Panel>
      <Panel title="Funnel sessions" subtitle="The most recent journeys linked by exact email or account ID.">
        {report.sessions.length === 0 ? <Empty /> : (
          <div className="max-h-[420px] space-y-2 overflow-y-auto pr-1">
            {report.sessions.map((session) => (
              <div key={session.id} className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-semibold text-neutral-800">{humanizeSupportValue(session.source)}</span>
                  <span className="text-xs text-neutral-400">{formatSupportDate(session.createdAt)}</span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Badge>{session.locale.toUpperCase()}</Badge>
                  {session.resultSegment ? <Badge>{session.resultSegment}</Badge> : null}
                  {session.currentStepId ? <Badge>Step {session.currentStepId}</Badge> : null}
                  {session.lastOtoStep ? <Badge>Offer {session.lastOtoStep}</Badge> : null}
                </div>
                <div className="mt-2"><Reference>{session.id}</Reference></div>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Payments({ report }: { report: SupportReport }) {
  return (
    <div className="space-y-4">
      <Panel title="Orders" subtitle="Stored provider-neutral payment attempts. No card data or checkout payloads are selected.">
        {report.orders.length === 0 ? <Empty /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[900px] text-left text-xs">
              <thead className="text-neutral-400"><tr><th className="pb-3 font-medium">Created</th><th className="pb-3 font-medium">Product</th><th className="pb-3 font-medium">Amount</th><th className="pb-3 font-medium">Status</th><th className="pb-3 font-medium">Provider</th><th className="pb-3 font-medium">Environment</th><th className="pb-3 font-medium">Reference</th></tr></thead>
              <tbody className="divide-y divide-neutral-100">
                {report.orders.map((order) => (
                  <tr key={order.id}>
                    <td className="py-3 pr-4 text-neutral-500">{formatSupportDate(order.createdAt)}</td>
                    <td className="py-3 pr-4"><p className="font-semibold text-neutral-800">{order.product}</p><Reference>{order.productCode}</Reference></td>
                    <td className="py-3 pr-4 font-medium text-neutral-800">{formatSupportAmount(order.amountCents, order.currency)}{order.refundedAmountCents + order.chargebackAmountCents > 0 ? <span className="block text-[11px] text-red-600">{formatSupportAmount(order.refundedAmountCents + order.chargebackAmountCents, order.currency)} reversed</span> : null}</td>
                    <td className="py-3 pr-4"><Badge tone={statusTone(order.status)}>{humanizeSupportValue(order.status)}</Badge></td>
                    <td className="py-3 pr-4 text-neutral-600">{humanizeSupportValue(order.provider)}</td>
                    <td className="py-3 pr-4"><Badge>{humanizeSupportValue(order.environment)}</Badge></td>
                    <td className="py-3"><Reference>{order.orderId ?? order.id}</Reference></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      <Panel title="Renewals" subtitle="Recurring payment ledger entries linked through provider subscription or order IDs.">
        {report.renewals.length === 0 ? <Empty /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-xs">
              <thead className="text-neutral-400"><tr><th className="pb-3 font-medium">Event</th><th className="pb-3 font-medium">Product</th><th className="pb-3 font-medium">Term</th><th className="pb-3 font-medium">Amount</th><th className="pb-3 font-medium">Status</th><th className="pb-3 font-medium">Invoice</th></tr></thead>
              <tbody className="divide-y divide-neutral-100">
                {report.renewals.map((renewal) => (
                  <tr key={renewal.id}><td className="py-3 pr-4 text-neutral-500">{formatSupportDate(renewal.eventCreatedAt ?? renewal.createdAt)}</td><td className="py-3 pr-4 text-neutral-700">{renewal.productCode ?? 'Recurring product'}</td><td className="py-3 pr-4 text-neutral-700">{renewal.termNumber ?? '—'}</td><td className="py-3 pr-4 font-medium text-neutral-800">{formatSupportAmount(renewal.amountCents, renewal.currency)}</td><td className="py-3 pr-4"><Badge tone={statusTone(renewal.status)}>{humanizeSupportValue(renewal.status)}</Badge></td><td className="py-3"><Reference>{renewal.invoiceId}</Reference></td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}

function Access({ report }: { report: SupportReport }) {
  return (
    <Panel title="Entitlements" subtitle="The application access records linked to the registered account.">
      {report.entitlements.length === 0 ? <Empty>No entitlement records found.</Empty> : (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {report.entitlements.map((entitlement) => (
            <article key={entitlement.id} className="rounded-xl border border-neutral-200 bg-neutral-50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div><p className="text-sm font-semibold text-neutral-900">{entitlement.productCode}</p><p className="mt-1 text-xs text-neutral-400">{humanizeSupportValue(entitlement.accessLevel)}</p></div>
                <Badge tone={entitlement.active ? 'positive' : statusTone(entitlement.status)}>{entitlement.active ? 'Active' : humanizeSupportValue(entitlement.status)}</Badge>
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-y-2 text-xs"><dt className="text-neutral-400">Granted</dt><dd className="text-right text-neutral-600">{formatSupportDate(entitlement.grantedAt)}</dd><dt className="text-neutral-400">Expires</dt><dd className="text-right text-neutral-600">{formatSupportDate(entitlement.expiresAt)}</dd><dt className="text-neutral-400">Environment</dt><dd className="text-right text-neutral-600">{humanizeSupportValue(entitlement.environment)}</dd><dt className="text-neutral-400">Source</dt><dd className="text-right text-neutral-600">{entitlement.source ? humanizeSupportValue(entitlement.source) : '—'}</dd></dl>
            </article>
          ))}
        </div>
      )}
    </Panel>
  );
}

function ActivityPanel({ report }: { report: SupportReport }) {
  return (
    <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
      <Panel title="Customer timeline" subtitle="Newest first across account, funnel, payment, access, and support events.">
        {report.timeline.length === 0 ? <Empty /> : (
          <ol className="max-h-[680px] space-y-0 overflow-y-auto pr-2">
            {report.timeline.map((event, index) => (
              <li key={event.id} className="relative grid grid-cols-[18px_1fr] gap-3 pb-5">
                {index < report.timeline.length - 1 ? <span className="absolute left-[8px] top-4 h-full w-px bg-neutral-200" aria-hidden="true" /> : null}
                <span className={`relative mt-1.5 size-[17px] rounded-full border-4 border-white ${event.tone === 'positive' ? 'bg-emerald-500' : event.tone === 'critical' ? 'bg-red-500' : event.tone === 'warning' ? 'bg-amber-500' : 'bg-neutral-300'}`} aria-hidden="true" />
                <div><div className="flex flex-wrap items-baseline justify-between gap-2"><p className="text-sm font-semibold text-neutral-800">{event.label}</p><time className="text-[11px] text-neutral-400">{formatSupportDate(event.at)}</time></div><p className="mt-0.5 text-xs text-neutral-500">{humanizeSupportValue(event.category)}{event.detail ? ` · ${event.detail}` : ''}</p></div>
              </li>
            ))}
          </ol>
        )}
      </Panel>
      <Panel title="Fulfillment operations" subtitle="Background effects linked to this customer's provider orders.">
        {report.fulfillment.length === 0 ? <Empty>No linked fulfillment jobs.</Empty> : (
          <div className="space-y-3">
            {report.fulfillment.map((item) => (
              <article key={item.id} className="rounded-xl border border-neutral-200 bg-neutral-50 p-3">
                <div className="flex items-start justify-between gap-3"><p className="text-sm font-semibold text-neutral-800">{humanizeSupportValue(item.effect)}</p><Badge tone={statusTone(item.status)}>{humanizeSupportValue(item.status)}</Badge></div>
                <p className="mt-2 text-xs text-neutral-500">Attempts: {item.attempts} · Updated {formatSupportDate(item.updatedAt)}</p>
                {item.lastError ? <p className="mt-2 rounded-lg bg-red-50 p-2 text-xs text-red-700">{item.lastError}</p> : null}
              </article>
            ))}
          </div>
        )}
      </Panel>
    </div>
  );
}

function Actions({
  report,
  allowedActions,
  onComplete,
}: {
  report: SupportReport;
  allowedActions: readonly SupportActionName[];
  onComplete: (message: string) => void;
}) {
  const [confirmLogin, setConfirmLogin] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [busy, setBusy] = useState<SupportActionName | null>(null);
  const [message, setMessage] = useState<{ tone: 'positive' | 'critical'; text: string } | null>(null);
  const disabledReason = !report.mutationsAllowed
    ? report.customerStatus === 'ambiguous'
      ? 'Actions are disabled because multiple identities match this email.'
      : 'Actions require exactly one registered account.'
    : null;

  async function run(action: SupportActionName) {
    setBusy(action);
    setMessage(null);
    try {
      const response = await fetch('/api/admin/support/actions', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          email: report.email,
          confirm: true,
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const body = (await response.json().catch(() => ({}))) as { result?: SupportActionResult; error?: string };
      if (!response.ok || !body.result) throw new Error(body.error ?? 'The support action failed.');
      setMessage({ tone: 'positive', text: body.result.message });
      setConfirmLogin(false);
      setConfirmRevoke(false);
      onComplete(body.result.message);
    } catch (caught) {
      setMessage({ tone: 'critical', text: caught instanceof Error ? caught.message : 'The support action failed.' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-neutral-200 bg-white p-4 text-sm text-neutral-600">
        Every action is re-authorized on the server, resolves the account again from the exact email, and writes a durable audit record. Product entitlements, refunds, and subscription cancellation are intentionally not generic actions.
      </div>
      {disabledReason ? <p className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">{disabledReason}</p> : null}
      {message ? <p role={message.tone === 'critical' ? 'alert' : 'status'} className={`rounded-xl border px-4 py-3 text-sm ${TONE_CLASSES[message.tone]}`}>{message.text}</p> : null}
      <div className="grid gap-4 lg:grid-cols-2">
        {allowedActions.includes('send_login_code') ? (
        <Panel title="Send login code" subtitle="Uses the same passwordless email flow as the member sign-in screen.">
          <fieldset disabled={Boolean(disabledReason) || busy !== null} className="space-y-4 disabled:opacity-50">
            <label className="flex items-start gap-3 text-sm text-neutral-600"><input type="checkbox" checked={confirmLogin} onChange={(event) => setConfirmLogin(event.target.checked)} className="mt-0.5 size-4 accent-sky-600" /><span>The customer requested a login code and <strong>{report.email}</strong> is the correct address.</span></label>
            <button type="button" onClick={() => void run('send_login_code')} disabled={!confirmLogin || busy !== null} className="inline-flex items-center gap-2 rounded-xl bg-neutral-950 px-4 py-2.5 text-sm font-semibold text-white hover:bg-neutral-800 disabled:opacity-40">{busy === 'send_login_code' ? <Loader2 className="animate-spin" size={15} aria-hidden="true" /> : <Mail size={15} aria-hidden="true" />}Send login code</button>
          </fieldset>
        </Panel>
        ) : null}
        {allowedActions.includes('revoke_sessions') ? (
        <Panel title="Revoke active sessions" subtitle="Signs the customer out on every device without changing access or billing.">
          <fieldset disabled={Boolean(disabledReason) || busy !== null} className="space-y-4 disabled:opacity-50">
            <label className="flex items-start gap-3 text-sm text-neutral-600"><input type="checkbox" checked={confirmRevoke} onChange={(event) => setConfirmRevoke(event.target.checked)} className="mt-0.5 size-4 accent-red-600" /><span>I understand the customer will need a new login code on every device.</span></label>
            <button type="button" onClick={() => void run('revoke_sessions')} disabled={!confirmRevoke || busy !== null} className="inline-flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-2.5 text-sm font-semibold text-red-700 hover:bg-red-100 disabled:opacity-40">{busy === 'revoke_sessions' ? <Loader2 className="animate-spin" size={15} aria-hidden="true" /> : <ShieldCheck size={15} aria-hidden="true" />}Revoke sessions</button>
          </fieldset>
        </Panel>
        ) : null}
      </div>
      {allowedActions.length === 0 ? (
        <p className="rounded-xl border border-neutral-200 bg-neutral-50 px-4 py-3 text-sm text-neutral-600">
          Your role has read-only support access. No customer actions are available.
        </p>
      ) : null}
      {report.supportActions.length > 0 ? (
        <Panel title="Recent support actions" subtitle="Audit history for this customer email hash.">
          <div className="space-y-2">{report.supportActions.map((action) => <div key={action.id} className="flex items-center justify-between gap-3 rounded-lg border border-neutral-100 bg-neutral-50 px-3 py-2 text-xs"><span className="font-medium text-neutral-700">{humanizeSupportValue(action.action)}</span><span className="flex items-center gap-2"><Badge tone={statusTone(action.outcome)}>{humanizeSupportValue(action.outcome)}</Badge><time className="text-neutral-400">{formatSupportDate(action.completedAt ?? action.createdAt)}</time></span></div>)}</div>
        </Panel>
      ) : null}
    </div>
  );
}

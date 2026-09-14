import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ subscriptions: vi.fn(), otos: vi.fn() }));
vi.mock('../../_actions/refetch-subscriptions', () => ({ refetchSubscriptions: mocks.subscriptions }));
vi.mock('../../_actions/refetch-otos', () => ({ refetchOtos: mocks.otos }));
import { SubscriptionsClient, type SubscriptionsPayload } from '../SubscriptionsClient';
import { OtosClient, type OtosPayload } from '../OtosClient';
const subscriptions: SubscriptionsPayload = {
  cohort: { cohortSize: 10, converted: 2, ratePct: 20 }, rolling: { numerator: 2, denominator: 8, ratePct: 25 },
  recurringOto: { activeCount: 0, estimatedMrrEurCents: null, renewalRevenueEurCents: 0 },
  statusBreakdown: { trialing: 8, active: 2, pastDue: 0, canceled: 0, other: 0, total: 10 },
  variantBreakdown: { main: 10, special1eur: 0, specialFree: 0, legacy: 0, total: 10 },
};
const otos: OtosPayload = { counts: [{ offer: 'Weekly add-on', pattern: '%ADDON%', count: 5, amountEurCents: 1234 }], rates: [] };
describe('admin report refresh failures', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it('labels retained subscription values as the previous range when refresh fails', async () => {
    mocks.subscriptions.mockRejectedValue(new Error('database unavailable'));
    render(<SubscriptionsClient initialData={subscriptions} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The previous range is still shown');
    expect(screen.getByText('20.0%')).toBeInTheDocument();
    mocks.subscriptions.mockResolvedValue({ ...subscriptions, cohort: { cohortSize: 10, converted: 5, ratePct: 50 } });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Apply' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByText('50.0%')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
  it('labels retained OTO values as the previous range when refresh fails', async () => {
    mocks.otos.mockRejectedValue(new Error('database unavailable'));
    render(<OtosClient initialData={otos} />);
    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The previous range is still shown');
    expect(screen.getByText('Weekly add-on')).toBeInTheDocument();
  });
});

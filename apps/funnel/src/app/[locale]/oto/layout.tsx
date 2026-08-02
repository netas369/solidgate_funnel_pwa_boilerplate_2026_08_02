import { AcceptedOtoDeclineNotice } from '@/features/oto/components/accepted-oto-decline-notice';

// Shared frame for /oto/1..8: mounts the accepted-then-declined purchase
// banner once, so a decline discovered by the recovery sweep follows the buyer
// across the chain instead of being swallowed silently.
export default function OtoLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <AcceptedOtoDeclineNotice />
    </>
  );
}

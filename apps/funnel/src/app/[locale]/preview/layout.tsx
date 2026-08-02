import type { Metadata } from 'next';
import { PreviewBar } from './_components/preview-bar';

// Preview routes are an internal UI-review tool: copies of the offer + OTO
// pages reachable WITHOUT completing the quiz or paying. They must never be
// indexed by search engines  -  they are "unlisted", shared only by URL.
export const metadata: Metadata = {
  robots: { index: false, follow: false, nocache: true },
};

export default function PreviewLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <PreviewBar />
    </>
  );
}

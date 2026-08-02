import { OtoTemplate } from '@/features/oto/components/oto-template';
import { OTO_CONFIG } from '@/features/oto/config/oto-config';

export default function Page() {
  return <OtoTemplate config={OTO_CONFIG[5]} />;
}

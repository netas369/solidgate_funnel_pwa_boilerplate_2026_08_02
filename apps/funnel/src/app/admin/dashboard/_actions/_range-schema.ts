// D-19: shared zod schema for all 4 refetch-* server actions.
// Enforces ISO-8601 datetimes and from < to (T-06-02).
// `from` inclusive, `to` exclusive — matches _queries/_shared.ts DateRange.

import { z } from 'zod';

export const RangeSchema = z
  .object({
    from: z.string().datetime(),
    to: z.string().datetime(),
  })
  .refine((r) => r.from < r.to, { message: 'from must be before to' });

export type Range = z.infer<typeof RangeSchema>;

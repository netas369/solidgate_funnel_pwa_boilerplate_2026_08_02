// Server-only admin authorization shared by pages and /api/admin routes.

import { createClient } from '@repo/shared/supabase/server';
import {
  getAdminAccessForEmail,
  hasAdminCapability,
  type AdminCapability,
} from '@repo/admin-core/access';

export async function getAuthenticatedAdminUser(requiredCapability?: AdminCapability) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;
  const adminAccess = getAdminAccessForEmail(user.email);
  if (!adminAccess || (requiredCapability && !hasAdminCapability(adminAccess, requiredCapability))) {
    return null;
  }
  return { ...user, adminAccess };
}

import { redirect } from 'next/navigation';
import { getAuthenticatedAdminUser } from './_queries/admin-access';
import { adminLandingPathForEmail } from './_queries/_shared';

export default async function AdminIndex() {
  const principal = await getAuthenticatedAdminUser();
  redirect(adminLandingPathForEmail(principal?.email));
}

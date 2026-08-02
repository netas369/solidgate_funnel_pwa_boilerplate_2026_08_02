import { handleLogout } from "@repo/shared/auth/logout";

export async function POST() {
  return handleLogout();
}

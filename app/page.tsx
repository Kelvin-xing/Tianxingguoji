import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import {
  isRequestAccessContextError,
  resolveRequestAccessContext,
} from "@/modules/access/server";
import { SESSION_COOKIE_NAME } from "@/modules/identity/server";

export default async function Home() {
  const secret = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  if (!secret) redirect("/login");

  try {
    const access = await resolveRequestAccessContext({ cookieSecret: secret });
    redirect(access.workspaceCapabilities.includes("today.read") ? "/today" : "/tasks");
  } catch (error) {
    if (
      isRequestAccessContextError(error, "REQUEST_ACCESS_UNAUTHENTICATED") ||
      isRequestAccessContextError(error, "REQUEST_ACCESS_FORBIDDEN")
    ) {
      redirect("/login");
    }
    throw error;
  }
}

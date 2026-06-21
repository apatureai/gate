import { NextResponse } from "next/server";
import { SESSION_COOKIE, env } from "@/lib/env";

/** Clear the session cookie and return to the landing page. */
export function POST(): NextResponse {
  const res = NextResponse.redirect(`${env.baseUrl()}/`, { status: 303 });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}

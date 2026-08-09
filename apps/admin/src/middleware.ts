import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "./lib/session";

/**
 * The gate. Everything except the login page and static assets requires a valid
 * session — including server actions, which POST to the page they were defined
 * on and would otherwise be reachable without one.
 */
export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const authenticated = await isValidSessionToken(
    request.cookies.get(SESSION_COOKIE)?.value,
  ).catch(() => false);

  if (pathname === "/login") {
    if (authenticated) return NextResponse.redirect(new URL("/", request.url));
    return NextResponse.next();
  }

  if (authenticated) return NextResponse.next();

  const login = new URL("/login", request.url);
  // Come back to where you were headed after logging in — but only ever to a
  // path on this host, never to an absolute URL an attacker supplied.
  if (pathname !== "/") login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

import Link from "next/link";
import { logout } from "../actions";
import { NavLink } from "@/components/nav-link";

export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="mx-auto max-w-5xl px-6 py-8">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        <div className="flex items-center gap-6">
          <Link href="/" className="text-sm font-semibold tracking-tight text-zinc-100">
            Jarvis
            <span className="ml-2 font-normal text-zinc-500">admin</span>
          </Link>
          <nav className="flex items-center gap-1">
            <NavLink href="/">Overview</NavLink>
            <NavLink href="/mcp">MCP servers</NavLink>
            <NavLink href="/connectors">Connectors</NavLink>
          </nav>
        </div>
        <form action={logout}>
          <button
            type="submit"
            className="rounded-md border border-zinc-800 px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200"
          >
            Log out
          </button>
        </form>
      </header>
      <main className="space-y-6">{children}</main>
    </div>
  );
}

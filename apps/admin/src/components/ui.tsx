import type { ReactNode } from "react";

/**
 * The shared vocabulary of the admin UI. Small on purpose: a handful of
 * primitives used everywhere beats a component library for six pages.
 */

export function Card({
  title,
  subtitle,
  actions,
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-zinc-800 px-5 py-4">
          <div className="min-w-0">
            {title && <h2 className="font-medium text-zinc-100">{title}</h2>}
            {subtitle && <p className="mt-1 text-sm text-zinc-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="px-5 py-4">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-sm font-medium text-zinc-300">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}

const CONTROL =
  "w-full rounded-md border border-zinc-700 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 " +
  "placeholder:text-zinc-600 focus:border-teal-600 focus:outline-none focus:ring-1 focus:ring-teal-600/50";

export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={`${CONTROL} ${props.className ?? ""}`} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={`${CONTROL} font-mono ${props.className ?? ""}`} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={`${CONTROL} ${props.className ?? ""}`} />;
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "good" | "warn" | "bad";
  children: ReactNode;
}) {
  const tones = {
    neutral: "border-zinc-700 bg-zinc-800/60 text-zinc-400",
    good: "border-teal-800 bg-teal-950/60 text-teal-300",
    warn: "border-amber-800 bg-amber-950/50 text-amber-300",
    bad: "border-red-900 bg-red-950/50 text-red-300",
  } as const;
  return (
    <span
      className={`inline-flex items-center rounded border px-2 py-0.5 text-xs font-medium ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-zinc-500">{children}</p>;
}

/** Errors we could not attribute to a form — a dead orchestrator, mostly. */
export function ErrorBox({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-red-900 bg-red-950/40 px-4 py-3">
      <p className="text-sm font-medium text-red-200">{title}</p>
      {children && <div className="mt-1 text-sm text-red-300/80">{children}</div>}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[0.8125rem] text-zinc-400">{children}</code>;
}

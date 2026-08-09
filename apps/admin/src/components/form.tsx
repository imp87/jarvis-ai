"use client";

import { useActionState, useEffect, useRef, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import type { ActionResult } from "@/lib/action-result";

/**
 * Every mutation in this UI is a server action inside a plain `<form>`, so the
 * page keeps working without client JS and there is no fetch/loading/error
 * plumbing to write per form.
 */

export function SubmitButton({
  children,
  tone = "primary",
  confirm,
}: {
  children: ReactNode;
  tone?: "primary" | "ghost" | "danger";
  confirm?: string;
}) {
  const { pending } = useFormStatus();
  const tones = {
    primary: "bg-teal-700 text-white hover:bg-teal-600 border-teal-700",
    ghost: "bg-zinc-800 text-zinc-200 hover:bg-zinc-700 border-zinc-700",
    danger: "bg-transparent text-red-300 hover:bg-red-950/60 border-red-900",
  } as const;

  return (
    <button
      type="submit"
      disabled={pending}
      // Destructive actions are one click away from a populated registry;
      // deleting a connector takes its endpoints with it.
      onClick={(event) => {
        if (confirm && !window.confirm(confirm)) event.preventDefault();
      }}
      className={`inline-flex items-center justify-center rounded-md border px-3 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${tones[tone]}`}
    >
      {pending ? "…" : children}
    </button>
  );
}

export function Message({ state }: { state: ActionResult }) {
  if (state.error) {
    return (
      <div className="rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-200">
        {state.error}
        {state.details && state.details.length > 0 && (
          <ul className="mt-1 list-inside list-disc text-red-300/80">
            {state.details.map((d) => (
              <li key={`${d.path}-${d.message}`}>
                {d.path ? `${d.path}: ` : ""}
                {d.message}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }
  if (state.success) {
    return (
      <div className="rounded-md border border-teal-800 bg-teal-950/40 px-3 py-2 text-sm text-teal-200">
        {state.success}
      </div>
    );
  }
  return null;
}

/**
 * A form that clears on success and keeps what you typed on failure.
 *
 * React resets an uncontrolled form once its action resolves, which is right
 * after a successful submit and wrong after a rejected one. Passing `children`
 * a function lets each field read the echoed value back out of the action
 * result and hand it to `defaultValue`, so the reset restores the input instead
 * of blanking it.
 */
export function ActionForm({
  action,
  children,
  className,
}: {
  action: (state: ActionResult, formData: FormData) => Promise<ActionResult>;
  children: ReactNode | ((state: ActionResult) => ReactNode);
  className?: string;
}) {
  const [state, formAction] = useActionState(action, {});
  const ref = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state.success) ref.current?.reset();
  }, [state.success]);

  return (
    <form ref={ref} action={formAction} className={className}>
      {typeof children === "function" ? children(state) : children}
      <Message state={state} />
    </form>
  );
}

/** For single-button forms (toggle, delete, reload) that need no fields. */
export function ActionButton({
  action,
  children,
  tone = "ghost",
  confirm,
  fields,
}: {
  action: (state: ActionResult, formData: FormData) => Promise<ActionResult>;
  children: ReactNode;
  tone?: "primary" | "ghost" | "danger";
  confirm?: string;
  fields?: Record<string, string>;
}) {
  const [state, formAction] = useActionState(action, {});
  return (
    <form action={formAction} className="inline-flex flex-col items-end gap-1">
      {Object.entries(fields ?? {}).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton tone={tone} {...(confirm ? { confirm } : {})}>
        {children}
      </SubmitButton>
      {state.error && <span className="text-xs text-red-300">{state.error}</span>}
    </form>
  );
}

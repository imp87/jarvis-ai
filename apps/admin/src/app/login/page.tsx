import { login } from "../actions";
import { ActionForm, SubmitButton } from "@/components/form";
import { Field, Input } from "@/components/ui";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <div className="flex min-h-screen items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-lg font-semibold tracking-tight text-zinc-100">Jarvis admin</h1>
        <p className="mb-6 text-sm text-zinc-500">
          The service token stays on the server. This password only decides whether the server acts
          on your behalf.
        </p>
        <ActionForm action={login} className="space-y-4">
          <input type="hidden" name="next" value={next ?? "/"} />
          <Field label="Password">
            <Input name="password" type="password" autoComplete="current-password" autoFocus required />
          </Field>
          <SubmitButton>Log in</SubmitButton>
        </ActionForm>
      </div>
    </div>
  );
}

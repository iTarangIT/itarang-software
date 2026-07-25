import { Suspense } from "react";
import ResetPasswordClient from "./ResetPasswordClient";

// Server shell. The split from ResetPasswordClient is NOT cosmetic: the form
// needs useSearchParams() to read ?token=, and in Next 16 a client page calling
// that on a statically-prerenderable route fails `npm run build` with
// "useSearchParams() should be wrapped in a suspense boundary". Route-segment
// config can't be exported from a 'use client' file, so the boundary lives
// here. (app/request-action/[id]/page.tsx gets away with a bare
// useSearchParams() only because [id] makes that route dynamic.)
//
// The (auth) group does not affect the URL — this is still /reset-password,
// which is what buildResetLink() emits and what middleware whitelists.

export const metadata = { title: "Reset password — iTarang" };

export default function ResetPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-[#F5F7FA]">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-200 border-t-[#005596]" />
        </div>
      }
    >
      <ResetPasswordClient />
    </Suspense>
  );
}

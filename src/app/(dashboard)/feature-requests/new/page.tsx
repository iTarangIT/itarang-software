"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { ArrowLeft, Loader2 } from "lucide-react";

import { api, postJson } from "@/components/feature-requests/api";
import { FeatureRequestForm, type FeatureRequestValues } from "@/components/feature-requests/FeatureRequestForm";
import type { Seat } from "@/lib/feature-requests/workflow";

export default function NewFeatureRequestPage() {
  const router = useRouter();
  const meta = useQuery({
    queryKey: ["feature-requests-meta"],
    queryFn: () => api<{ me: { seat: Seat } }>("/api/feature-requests/meta"),
  });

  const create = useMutation({
    mutationFn: ({ v, ids }: { v: FeatureRequestValues; ids: string[] }) =>
      postJson<{ id: string; code: string }>("/api/feature-requests", { ...v, attachmentIds: ids }),
    onSuccess: (r) => {
      toast.success(`${r.code} sent to the Product Head for review`);
      router.push(`/feature-requests/${r.id}`);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-12">
      <Link href="/feature-requests" className="inline-flex items-center gap-1 text-sm text-gray-500 hover:text-gray-800">
        <ArrowLeft className="h-4 w-4" /> Feature Requests
      </Link>
      <div>
        <h1 className="text-2xl font-bold text-gray-900">New Feature Request</h1>
        <p className="mt-1 text-sm text-gray-500">It goes to the Product Head first, then the Tech Head.</p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        {meta.isLoading ? (
          <div className="flex justify-center py-10 text-gray-500">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : meta.data?.me.seat !== "requester" ? (
          <p className="text-sm text-gray-600">Only the CEO can raise new feature requests.</p>
        ) : (
          <FeatureRequestForm
            submitLabel="Submit for Product Review"
            busy={create.isPending}
            onSubmit={(v, ids) => create.mutate({ v, ids })}
            onCancel={() => router.push("/feature-requests")}
          />
        )}
      </div>
    </div>
  );
}

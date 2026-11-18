"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/** Looks again every few seconds while the check runs. */
export function KeepRefreshing({ every = 6000 }: { every?: number }) {
  const router = useRouter();
  useEffect(() => {
    const t = setInterval(() => router.refresh(), every);
    return () => clearInterval(t);
  }, [router, every]);
  return null;
}

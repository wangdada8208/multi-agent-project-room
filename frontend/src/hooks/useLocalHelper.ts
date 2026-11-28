import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import { isMobileBrowser, probeHelper, type HelperProbe } from "../lib/localHelper";

const probeKey = ["helper", "probe"] as const;

interface ProbeResult {
  probe: HelperProbe;
  failures: number;
  checkedAt: number;
}

export interface LocalHelperProbeStatus {
  state: HelperProbe["state"];
  checkedAt: number;
  failures: number;
}

export interface UseLocalHelperOptions {
  trackWait?: boolean;
  waitStartedAt?: number;
}

export function useLocalHelper(enabled = true, { trackWait = false, waitStartedAt }: UseLocalHelperOptions = {}) {
  const isMobile = isMobileBrowser();
  const query = useQuery({
    queryKey: probeKey,
    queryFn: async ({ client }): Promise<ProbeResult> => {
      const previous = client.getQueryData<ProbeResult>(probeKey);
      const probe = await probeHelper();
      return {
        probe,
        failures: probe.state === "running" ? 0 : (previous?.failures ?? 0) + 1,
        checkedAt: Date.now(),
      };
    },
    enabled: enabled && !isMobile,
    staleTime: 1000,
    retry: false,
    refetchIntervalInBackground: false,
    refetchInterval: ({ state }) => state.data?.probe.state === "running" ? 5000
      : Math.min(3000 * 2 ** Math.max(0, (state.data?.failures ?? 1) - 1), 30000),
  });

  const waitingSupported = trackWait && enabled && !isMobile;
  const [fallbackStartedAt, setFallbackStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [manualRetrying, setManualRetrying] = useState(false);

  useEffect(() => {
    if (!waitingSupported) {
      setFallbackStartedAt(null);
      return;
    }
    setFallbackStartedAt((current) => current ?? Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [waitingSupported]);

  const retryNow = useCallback(async () => {
    if (!enabled || isMobile) return undefined;
    setManualRetrying(true);
    try {
      return await query.refetch({ cancelRefetch: true });
    } finally {
      setManualRetrying(false);
    }
  }, [enabled, isMobile, query.refetch]);

  const probe = query.data?.probe ?? null;
  const lastProbe: LocalHelperProbeStatus | null = query.data ? {
    state: query.data.probe.state,
    checkedAt: query.data.checkedAt,
    failures: query.data.failures,
  } : null;
  const effectiveStartedAt = waitStartedAt ?? fallbackStartedAt;
  const waitingSeconds = trackWait && effectiveStartedAt !== null && effectiveStartedAt !== undefined
    ? Math.max(0, Math.floor((now - effectiveStartedAt) / 1000))
    : 0;

  if (isMobile) return {
    available: false,
    reason: "mobile",
    probe: null,
    refresh: undefined,
    updatedAt: 0,
    lastProbe: null,
    retryNow: undefined,
    manualRetrying: false,
    waitingSeconds: 0,
    waitingStartedAt: null,
  } as const;

  return {
    available: probe?.state === "running",
    reason: probe?.state ?? "probing",
    probe,
    refresh: query.refetch,
    updatedAt: query.dataUpdatedAt,
    lastProbe,
    retryNow,
    manualRetrying,
    waitingSeconds,
    waitingStartedAt: effectiveStartedAt,
  };
}

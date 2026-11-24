import { useQuery } from "@tanstack/react-query";
import { isMobileBrowser, probeHelper, type HelperProbe } from "../lib/localHelper";

const probeKey = ["helper", "probe"] as const;
interface ProbeResult {
  probe: HelperProbe;
  failures: number;
}

export function useLocalHelper(enabled = true) {
  const isMobile = isMobileBrowser();
  const query = useQuery({
    queryKey: probeKey,
    queryFn: async ({ client }): Promise<ProbeResult> => {
      const previous = client.getQueryData<ProbeResult>(probeKey);
      const probe = await probeHelper();
      return { probe, failures: probe.state === "running" ? 0 : (previous?.failures ?? 0) + 1 };
    },
    enabled: enabled && !isMobile,
    retry: false,
    refetchIntervalInBackground: false,
    refetchInterval: ({ state }) => state.data?.probe.state === "running" ? 5000
      : Math.min(3000 * 2 ** Math.max(0, (state.data?.failures ?? 1) - 1), 30000),
  });

  if (isMobile) return { available: false, reason: "mobile", probe: null, refresh: undefined, updatedAt: 0 } as const;
  const probe = query.data?.probe ?? null;
  return {
    available: probe?.state === "running",
    reason: probe?.state ?? "probing",
    probe,
    refresh: query.refetch,
    updatedAt: query.dataUpdatedAt,
  };
}

import { useCallback } from "react";
import { useAuthStore } from "../stores/authStore";
import { apiFetch } from "../lib/api";

export function useAnalytics() {
  const track = useCallback(async (eventType: string, roomId?: string, metadata?: Record<string, unknown>) => {
    try {
      await apiFetch("/api/v1/analytics/track", {
        method: "POST",
        body: JSON.stringify({ event_type: eventType, room_id: roomId, metadata }),
      });
    } catch {
      // Silent fail — don't block user actions for analytics
    }
  }, []);

  return { track };
}

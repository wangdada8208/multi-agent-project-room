import React, { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import {
  buildConnectUrl,
  type ConnectClientRequest,
} from "../lib/connectClient";

export interface ConnectButtonProps extends ConnectClientRequest {
  gatewayUrl?: string;
  className?: string;
  buttonText?: string;
  onSuccess: (data: { grant: unknown; signature: string; payload: unknown }) => void;
  onError?: (err: Error) => void;
}

export function ConnectButton({
  appId,
  scope,
  purpose,
  redirectUri,
  constraints,
  gatewayUrl = "http://127.0.0.1:8787",
  className = "",
  buttonText = "Connect with MAPR",
  onSuccess,
  onError,
}: ConnectButtonProps) {
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    function handleMessage(event: MessageEvent) {
      if (event.data?.type === "MAPR_CONNECT_RESPONSE") {
        setConnecting(false);
        if (event.data.ok) {
          onSuccess({
            grant: event.data.grant,
            signature: event.data.signature,
            payload: event.data.payload,
          });
        } else {
          onError?.(new Error(event.data.reason || "Authorization denied"));
        }
      }
    }
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onSuccess, onError]);

  function handleClick() {
    setConnecting(true);
    const authUrl = buildConnectUrl(gatewayUrl, {
      appId,
      scope,
      purpose,
      redirectUri,
      constraints,
    });
    const width = 540;
    const height = 640;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    const popup = window.open(
      authUrl,
      "mapr_connect_auth",
      `width=${width},height=${height},left=${left},top=${top},status=no,resizable=yes`
    );

    if (!popup) {
      setConnecting(false);
      window.location.href = authUrl;
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={connecting}
      className={`inline-flex items-center gap-2 rounded-xl border border-sky-500/40 bg-gradient-to-r from-sky-600 to-blue-700 px-4 py-2 font-medium text-white shadow-sm transition hover:from-sky-500 hover:to-blue-600 disabled:opacity-50 ${className}`}
    >
      <ShieldCheck className="h-4 w-4" />
      <span>{connecting ? "连接中..." : buttonText}</span>
    </button>
  );
}

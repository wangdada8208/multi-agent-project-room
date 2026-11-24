import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Laptop } from "lucide-react";
import { listMyHelpers, revokeHelper } from "../../lib/localHelper";
import { Button } from "../ui/Button";
import { ConfirmInline } from "../ui/ConfirmInline";

export const helpersKey = ["helper", "devices"];

export function PairedDevices() {
  const [confirm, setConfirm] = useState<string>();
  const client = useQueryClient();
  const devices = useQuery({ queryKey: helpersKey, queryFn: listMyHelpers, retry: false });
  const revoke = useMutation({
    mutationFn: revokeHelper,
    onSuccess: async () => {
      setConfirm(undefined);
      await client.invalidateQueries({ queryKey: ["helper"] });
    },
  });
  return <section id="paired-devices" className="wb-device-list">
    <h3><Laptop size={17} />已配对的电脑设备</h3>
    <p>吊销后，对应电脑上的席位将随助手下次心跳停止。</p>
    {devices.isPending && <p className="wb-muted">正在读取设备…</p>}
    {devices.isSuccess && !devices.data.length && <p className="wb-muted">暂无已配对设备。</p>}
    {(devices.error || revoke.error) && <p className="wb-error" role="alert">{(devices.error || revoke.error)?.message}</p>}
    {devices.data?.map((device) => <article key={device.id} className="wb-seat">
      <div className="wb-seat__info"><strong>{device.device_name}</strong>
        <small>{device.platform} · {device.revoked ? "已吊销" : device.last_seen_at ? `最近在线 ${new Date(device.last_seen_at).toLocaleString("zh-CN")}` : "从未在线"}</small>
      </div>
      {!device.revoked && (confirm === device.id ? <ConfirmInline
        loading={revoke.isPending} confirmLabel="吊销" onCancel={() => { setConfirm(undefined); revoke.reset(); }} onConfirm={() => revoke.mutate(device.id)}>
        吊销「{device.device_name}」后，这台电脑上的席位会一并移出。
      </ConfirmInline> : <Button variant="danger" size="sm" disabled={revoke.isPending} onClick={() => setConfirm(device.id)}>吊销</Button>)}
    </article>)}
  </section>;
}

import { Laptop, RefreshCw } from "lucide-react";
import { HelperLink } from "../HelperLink";
import { Button } from "../ui/Button";

export function HelperStatusStrip({ version, device, rescanning, onRescan, onManage }: {
  version?: string;
  device?: string;
  rescanning: boolean;
  onRescan: () => void;
  onManage?: () => void;
}) {
  return <div className="wb-helper-strip">
    <Laptop size={18} />
    <div><strong>{version ? "电脑助手已连接" : "正在检查电脑助手…"}</strong>{version && <small>{device && `${device} · `}v{version} · 在线</small>}</div>
    {version && <>
      <Button variant="secondary" size="sm" disabled={rescanning} onClick={onRescan}><RefreshCw size={13} />重新扫描</Button>
      {onManage ? <Button variant="secondary" size="sm" onClick={onManage}>管理设备</Button>
        : <HelperLink className="ui-button ui-button--secondary ui-button--sm" action="console">打开电脑助手</HelperLink>}
    </>}
  </div>;
}

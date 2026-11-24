import type { RoomTemplateInfo } from "../../lib/api";
import { TemplateIcon } from "./templateMeta";

export interface TemplatePickerProps {
  templates: readonly RoomTemplateInfo[];
  selectedKey: string | null;
  onSelect: (template: RoomTemplateInfo | null) => void;
}

export function TemplatePicker({ templates, selectedKey, onSelect }: TemplatePickerProps) {
  return (
    <div className="wb-tpl-list" role="radiogroup" aria-label="选择协作模板">
      {templates.map((tpl) => (
        <button
          key={tpl.key}
          type="button"
          role="radio"
          aria-checked={selectedKey === tpl.key}
          className="wb-tpl-opt"
          onClick={() => onSelect(tpl)}
        >
          <span className="wb-tpl-opt__icon">
            <TemplateIcon templateKey={tpl.key} name={tpl.name} size={16} />
          </span>
          <span className="wb-tpl-opt__copy">
            <strong>{tpl.name}</strong>
            <small>{tpl.description || "预置多角色协作分工"}</small>
          </span>
        </button>
      ))}
      <button
        type="button"
        role="radio"
        aria-checked={selectedKey === null}
        className="wb-tpl-opt"
        onClick={() => onSelect(null)}
      >
        <span className="wb-tpl-opt__icon">
          <TemplateIcon templateKey={null} size={16} />
        </span>
        <span className="wb-tpl-opt__copy">
          <strong>空白房间</strong>
          <small>不预置规则，适合任意讨论</small>
        </span>
      </button>
    </div>
  );
}

import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import {
  createRoom,
  createRoomFromTemplate,
  fetchTemplates,
  type HouseRuleDecision,
  type HouseRules,
  type RoomTemplateInfo,
} from "../../lib/api";
import { useAnalytics } from "../../hooks/useAnalytics";
import { useViewportWidth } from "../../hooks/useViewportWidth";
import type { Room } from "../../types/chat";
import { Button } from "../ui/Button";
import { Drawer } from "../ui/Drawer";
import { Sheet } from "../ui/Sheet";
import { TemplatePicker } from "./TemplatePicker";
import { TemplateRulesPreview } from "./TemplateRulesPreview";
import {
  defaultRoomName,
  draftFromTemplate,
  type TemplateOverrideDraft,
} from "./templateMeta";

export interface CreateRoomDrawerProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (room: Room) => void;
}

export function buildTemplateOverrides(draft: TemplateOverrideDraft) {
  return {
    house_rules: {
      scopes: Object.fromEntries(
        Object.entries(draft.house_rules.scopes)
          .map(([k, v]) => [k.trim().toLowerCase(), v] as const)
          .filter(([k]) => k),
      ) as Record<string, HouseRuleDecision>,
      notes: draft.house_rules.notes.map((n) => n.trim()).filter(Boolean),
    } satisfies HouseRules,
    team_config_markdown: draft.team_config_markdown,
    ...(draft.default_max_rounds ? { default_max_rounds: draft.default_max_rounds } : {}),
  };
}

export function CreateRoomDrawer({ open, onClose, onCreated }: CreateRoomDrawerProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { track } = useAnalytics();
  const mobile = useViewportWidth() < 768;

  const templatesQuery = useQuery({
    queryKey: ["templates"],
    queryFn: fetchTemplates,
    enabled: open,
    staleTime: 60_000,
  });
  const templates = templatesQuery.data ?? [];

  const [selectedTplKey, setSelectedTplKey] = useState<string | null>(null);
  const [initialized, setInitialized] = useState(false);
  const [roomName, setRoomName] = useState(() => defaultRoomName(null));
  const [nameEdited, setNameEdited] = useState(false);
  const [roomDesc, setRoomDesc] = useState("");
  const [customizing, setCustomizing] = useState(false);
  const [overrideDraft, setOverrideDraft] = useState<TemplateOverrideDraft | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) {
      setInitialized(false);
      setError("");
      setCustomizing(false);
      setNameEdited(false);
      return;
    }
    if (!initialized && templates.length > 0) {
      const first = templates[0];
      setSelectedTplKey(first.key);
      setOverrideDraft(draftFromTemplate(first));
      setRoomName(defaultRoomName(first.name));
      setInitialized(true);
    }
  }, [open, initialized, templates]);

  function handleSelectTemplate(tpl: RoomTemplateInfo | null) {
    setError("");
    if (!tpl) {
      setSelectedTplKey(null);
      setCustomizing(false);
      setOverrideDraft(null);
      if (!nameEdited) setRoomName(defaultRoomName(null));
      return;
    }
    setSelectedTplKey(tpl.key);
    setOverrideDraft(draftFromTemplate(tpl));
    if (!nameEdited) setRoomName(defaultRoomName(tpl.name));
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmedName = roomName.trim();
    if (!trimmedName) {
      setError("请输入房间名称。");
      return;
    }
    setCreating(true);
    setError("");
    try {
      const overrides =
        selectedTplKey && customizing && overrideDraft
          ? buildTemplateOverrides(overrideDraft)
          : undefined;

      const created = selectedTplKey
        ? await createRoomFromTemplate(selectedTplKey, trimmedName, overrides)
        : await createRoom(trimmedName, roomDesc.trim() || undefined);

      track("room_create", created.id, {
        via: selectedTplKey ? "home_template_drawer" : "home_blank_drawer",
      });
      await queryClient.invalidateQueries({ queryKey: ["rooms"] });
      onClose();
      if (onCreated) {
        onCreated(created);
      } else {
        navigate(`/rooms/${encodeURIComponent(created.id)}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建房间失败，请重试。");
    } finally {
      setCreating(false);
    }
  }

  const selectedTemplate = templates.find((t) => t.key === selectedTplKey) ?? null;
  const Container = mobile ? Sheet : Drawer;

  return (
    <Container
      open={open}
      onClose={() => {
        if (!creating) onClose();
      }}
      title="新建房间"
      className="wb-create-drawer"
    >
      <form className="wb-create-drawer__form" onSubmit={handleSubmit}>
        <div className="wb-create-drawer__scroll">
          <div className="wb-create-drawer__field">
            <span className="wb-create-drawer__label">选择模板</span>
            {templatesQuery.isLoading ? (
              <div className="wb-rooms-state">
                <span className="ui-spinner" aria-hidden="true" />
                <p>正在加载协作模板…</p>
              </div>
            ) : (
              <TemplatePicker
                templates={templates}
                selectedKey={selectedTplKey}
                onSelect={handleSelectTemplate}
              />
            )}
          </div>

          <TemplateRulesPreview
            template={selectedTemplate}
            draft={overrideDraft}
            customizing={customizing}
            onToggleCustomizing={() => setCustomizing((v) => !v)}
            onChangeDraft={(updater) =>
              setOverrideDraft((prev) =>
                prev ? updater(prev) : selectedTemplate ? updater(draftFromTemplate(selectedTemplate)) : prev,
              )
            }
          />

          <div className="wb-create-drawer__field">
            <label className="wb-create-drawer__label" htmlFor="wb-create-room-name">
              房间名称
            </label>
            <input
              id="wb-create-room-name"
              className="wb-create-drawer__input"
              value={roomName}
              onChange={(e) => {
                setRoomName(e.target.value);
                setNameEdited(true);
              }}
              placeholder="例如：代码评审 · 11月25日"
              required
            />
          </div>

          {selectedTplKey === null && (
            <div className="wb-create-drawer__field">
              <label className="wb-create-drawer__label" htmlFor="wb-create-room-desc">
                房间简介（可选）
              </label>
              <input
                id="wb-create-room-desc"
                className="wb-create-drawer__input"
                value={roomDesc}
                onChange={(e) => setRoomDesc(e.target.value)}
                placeholder="一句话说明本房间的房间目标"
              />
            </div>
          )}

          {error && (
            <div className="wb-create-drawer__error" role="alert">
              {error}
            </div>
          )}
        </div>

        <footer className="wb-create-drawer__foot">
          <span className="wb-create-drawer__note">
            <Lock size={14} strokeWidth={2} aria-hidden="true" />
            <span>创建后自动开启端到端加密</span>
          </span>
          <Button variant="ghost" disabled={creating} onClick={onClose}>
            取消
          </Button>
          <Button type="submit" variant="primary" loading={creating} disabled={!roomName.trim()}>
            创建并进入
          </Button>
        </footer>
      </form>
    </Container>
  );
}

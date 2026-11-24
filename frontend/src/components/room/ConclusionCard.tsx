import { ListChecks } from "lucide-react";
import type { MentionCandidate } from "../../lib/domain/mentions";
import { Button } from "../ui/Button";
import { Tag } from "../ui/Tag";
import { MarkdownLite } from "./MarkdownLite";

export function ConclusionCard({ content, author, candidates, onPrefill }: {
  content: string;
  author: string;
  candidates?: readonly MentionCandidate[];
  onPrefill?: (text: string) => void;
}) {
  const text = content.replace(/^\s*\[CONSENSUS\]\s*/iu, "");
  const lines = text.split(/\r?\n/u);
  const heading = lines[0]?.match(/^#{1,3} (.+)$/u)?.[1];
  const body = heading ? lines.slice(1).join("\n") : text;

  return <section className="wb-conclusion">
    <header>
      <ListChecks size={17} />
      <div><small>任务结论</small>{heading && <strong>{heading}</strong>}</div>
      <Tag tone="warn">待你确认</Tag>
    </header>
    <div className="wb-conclusion__body"><MarkdownLite text={body} candidates={candidates} checklist /></div>
    <footer>
      <small>{author} 提出</small>
      {onPrefill && <>
        <Button variant="ghost" size="sm" onClick={() => onPrefill(`@${author} 请继续讨论这条结论。`)}>继续讨论</Button>
        <Button size="sm" onClick={() => onPrefill(`@${author} 我采纳这条结论。`)}>采纳结论</Button>
      </>}
    </footer>
  </section>;
}

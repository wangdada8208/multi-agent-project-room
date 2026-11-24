import { Fragment } from "react";
import { Check } from "lucide-react";
import type { MentionCandidate } from "../../lib/domain/mentions";
import { describeEnvelope } from "../../lib/envelopeView";
import { CopyButton } from "../CopyButton";

function inline(text: string, mentions: ReadonlyMap<string, MentionCandidate["actor"]>, pattern: RegExp) {
  return text.split(pattern).map((part, index) => (
    <Fragment key={index}>{part.startsWith("`") && part.endsWith("`")
      ? <code>{part.slice(1, -1)}</code>
      : part.startsWith("@") && part.length > 1 ? <mark data-actor={mentions.get(part.slice(1))}>{part}</mark> : part}</Fragment>
  ));
}

export function MarkdownLite({ text, candidates = [], checklist = false }: {
  text: string;
  candidates?: readonly MentionCandidate[];
  checklist?: boolean;
}) {
  const envelope = describeEnvelope(text);
  if (envelope) return <p>{envelope}</p>;

  const mentions = new Map(candidates.map(({ name, actor }) => [name, actor]));
  const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const names = [...mentions.keys()].filter(Boolean).sort((left, right) => right.length - left.length).map(escape);
  const pattern = new RegExp("(`[^`\\n]+`|@(?:" + [...names, "[\\p{L}\\p{N}_.-]+"].join("|") + "))", "gu");
  const format = (value: string) => inline(value, mentions, pattern);
  const output = [];
  const lines = text.split(/\r?\n/u);
  let index = 0;
  while (index < lines.length) {
    const start = index;
    const line = lines[index++];
    if (!line.trim()) continue;
    if (line.startsWith("```")) {
      const body = [];
      while (index < lines.length && !lines[index].startsWith("```")) body.push(lines[index++]);
      if (index < lines.length) index++;
      const code = body.join("\n");
      output.push(<div className="wb-code" key={start}>
        <header>{line.slice(3).trim() || "代码"}<CopyButton text={code} label="复制" /></header>
        <pre><code>{code}</code></pre>
      </div>);
    } else if (/^(?:[-*]|\d+\.) /u.test(line)) {
      const pattern = /^\d+\. /u.test(line) ? /^\d+\. /u : /^[-*] /u;
      const List = /^\d+\. /u.test(line) ? "ol" : "ul";
      const items = [line];
      while (index < lines.length && pattern.test(lines[index])) items.push(lines[index++]);
      output.push(<List key={start} className={checklist ? "wb-checklist" : undefined}>{items.map((item, offset) => <li key={offset}>{checklist && <Check size={14} />}<span>{format(item.replace(pattern, ""))}</span></li>)}</List>);
    } else if (/^#{1,3} /u.test(line)) {
      output.push(<h4 key={start}>{format(line.replace(/^#{1,3} /u, ""))}</h4>);
    } else {
      const paragraph = [line];
      while (index < lines.length && lines[index].trim() && !/^(?:```|#{1,3} |[-*] |\d+\. )/u.test(lines[index])) paragraph.push(lines[index++]);
      output.push(<p key={start}>{format(paragraph.join("\n"))}</p>);
    }
  }
  return <div className="wb-markdown">{output}</div>;
}

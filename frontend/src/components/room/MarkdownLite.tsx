import { Fragment, type ReactNode } from "react";
import { Check } from "lucide-react";
import type { MentionCandidate } from "../../lib/domain/mentions";
import { describeEnvelope } from "../../lib/envelopeView";
import { CopyButton } from "../CopyButton";

type InlineNode =
  | { kind: "text"; text: string }
  | { kind: "code"; text: string }
  | { kind: "mention"; name: string }
  | { kind: "strong"; children: InlineNode[] }
  | { kind: "em"; children: InlineNode[] }
  | { kind: "link"; href: string; children: InlineNode[] };

type ParseResult = {
  nodes: InlineNode[];
  next: number;
  closed: boolean;
};

const MAX_INLINE_DEPTH = 8;
const ASCII_WORD = /[A-Za-z0-9_]/u;
const WHITESPACE = /\s/u;

function safeHttpUrl(raw: string): string | null {
  if (!/^https?:\/\//iu.test(raw) || WHITESPACE.test(raw)) return null;
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname ? raw : null;
  } catch {
    return null;
  }
}

function canOpenDelimiter(text: string, index: number, delimiter: "*" | "**", boundaryBefore: string) {
  const before = index === 0 ? boundaryBefore : text[index - 1] ?? "";
  const after = text[index + delimiter.length] ?? "";
  if (!after || WHITESPACE.test(after)) return false;
  if (delimiter === "*" && before === "*") return false;
  return !(before && ASCII_WORD.test(before) && ASCII_WORD.test(after));
}

function canCloseDelimiter(text: string, index: number) {
  const before = text[index - 1] ?? "";
  return Boolean(before && !WHITESPACE.test(before) && before !== "*");
}

function readInlineCode(chunk: string) {
  if (!chunk.startsWith("`")) return null;
  const end = chunk.indexOf("`", 1);
  if (end <= 1) return null;
  const text = chunk.slice(1, end);
  if (text.includes("\n")) return null;
  return { text, length: end + 1 };
}

function readMention(chunk: string, mentionNames: readonly string[]) {
  if (!chunk.startsWith("@")) return null;
  const rest = chunk.slice(1);
  for (const name of mentionNames) {
    if (rest.startsWith(name)) return { name, length: name.length + 1 };
  }
  const generic = /^[\p{L}\p{N}_.-]+/u.exec(rest);
  if (!generic) return null;
  return { name: generic[0], length: generic[0].length + 1 };
}

function readAutolink(chunk: string) {
  const match = /^https?:\/\/[^\s<>"'`\[\]]+/iu.exec(chunk);
  if (!match) return null;
  const raw = match[0];
  const trailingMatch = /^(.*?)([.,;:!?，。；：！？、)\]}'"”’]+)$/u.exec(raw);
  const url = trailingMatch && trailingMatch[1].length > "https://".length ? trailingMatch[1] : raw;
  const trailing = url.length < raw.length ? raw.slice(url.length) : "";
  return safeHttpUrl(url) ? { href: url, trailing, length: raw.length } : null;
}

function readMarkdownLink(chunk: string, mentionNames: readonly string[], depth: number) {
  if (!chunk.startsWith("[")) return null;
  const labelEnd = chunk.indexOf("]", 1);
  if (labelEnd <= 1 || chunk[labelEnd + 1] !== "(") return null;
  const hrefEnd = chunk.indexOf(")", labelEnd + 2);
  if (hrefEnd <= labelEnd + 2) return null;
  const href = safeHttpUrl(chunk.slice(labelEnd + 2, hrefEnd).trim());
  if (!href) return null;
  const label = chunk.slice(1, labelEnd);
  const children = depth + 1 >= MAX_INLINE_DEPTH
    ? [{ kind: "text", text: label } satisfies InlineNode]
    : parseInline(label, mentionNames, undefined, depth + 1).nodes;
  return { href, children, length: hrefEnd + 1 };
}

function parseInline(
  text: string,
  mentionNames: readonly string[],
  endDelimiter?: "*" | "**",
  depth = 0,
  boundaryBefore = "",
): ParseResult {
  const nodes: InlineNode[] = [];
  let buffer = "";
  let index = 0;
  const flush = () => {
    if (!buffer) return;
    nodes.push({ kind: "text", text: buffer });
    buffer = "";
  };

  while (index < text.length) {
    if (endDelimiter && text.startsWith(endDelimiter, index) && canCloseDelimiter(text, index)) {
      flush();
      return { nodes, next: index + endDelimiter.length, closed: true };
    }

    const chunk = text.slice(index);
    const code = readInlineCode(chunk);
    if (code) {
      flush();
      nodes.push({ kind: "code", text: code.text });
      index += code.length;
      continue;
    }

    const markdownLink = readMarkdownLink(chunk, mentionNames, depth);
    if (markdownLink) {
      flush();
      nodes.push({ kind: "link", href: markdownLink.href, children: markdownLink.children });
      index += markdownLink.length;
      continue;
    }

    if (depth < MAX_INLINE_DEPTH && chunk.startsWith("**") && canOpenDelimiter(text, index, "**", boundaryBefore)) {
      const inner = parseInline(text.slice(index + 2), mentionNames, "**", depth + 1, "*");
      if (inner.closed) {
        flush();
        nodes.push({ kind: "strong", children: inner.nodes });
        index += 2 + inner.next;
        continue;
      }
    }

    if (
      depth < MAX_INLINE_DEPTH &&
      chunk.startsWith("*") &&
      !chunk.startsWith("**") &&
      canOpenDelimiter(text, index, "*", boundaryBefore)
    ) {
      const inner = parseInline(text.slice(index + 1), mentionNames, "*", depth + 1, "*");
      if (inner.closed) {
        flush();
        nodes.push({ kind: "em", children: inner.nodes });
        index += 1 + inner.next;
        continue;
      }
    }

    const mention = readMention(chunk, mentionNames);
    if (mention) {
      flush();
      nodes.push({ kind: "mention", name: mention.name });
      index += mention.length;
      continue;
    }

    const autolink = readAutolink(chunk);
    if (autolink) {
      flush();
      nodes.push({
        kind: "link",
        href: autolink.href,
        children: [{ kind: "text", text: autolink.href }],
      });
      if (autolink.trailing) nodes.push({ kind: "text", text: autolink.trailing });
      index += autolink.length;
      continue;
    }

    buffer += text[index];
    index += 1;
  }

  flush();
  return { nodes, next: index, closed: false };
}

function renderInline(nodes: readonly InlineNode[], mentions: ReadonlyMap<string, MentionCandidate["actor"]>): ReactNode[] {
  return nodes.map((node, index) => {
    switch (node.kind) {
      case "text":
        return <Fragment key={index}>{node.text}</Fragment>;
      case "code":
        return <code key={index}>{node.text}</code>;
      case "mention":
        return <mark key={index} data-actor={mentions.get(node.name)}>@{node.name}</mark>;
      case "strong":
        return <strong key={index}>{renderInline(node.children, mentions)}</strong>;
      case "em":
        return <em key={index}>{renderInline(node.children, mentions)}</em>;
      case "link":
        return (
          <a key={index} href={node.href} target="_blank" rel="noopener noreferrer">
            {renderInline(node.children, mentions)}
          </a>
        );
      default: {
        const exhaustive: never = node;
        return exhaustive;
      }
    }
  });
}

export function MarkdownLite({ text, candidates = [], checklist = false }: {
  text: string;
  candidates?: readonly MentionCandidate[];
  checklist?: boolean;
}) {
  const envelope = describeEnvelope(text);
  if (envelope) return <p>{envelope}</p>;

  const mentions = new Map(candidates.map(({ name, actor }) => [name, actor]));
  const mentionNames = [...mentions.keys()].filter(Boolean).sort((left, right) => right.length - left.length);
  const format = (value: string) => renderInline(parseInline(value, mentionNames).nodes, mentions);
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

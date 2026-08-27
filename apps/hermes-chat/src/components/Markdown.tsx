import { createElement, Fragment, type ReactNode } from "react";

// A small, dependency-free Markdown renderer. Renders to React elements (never
// dangerouslySetInnerHTML) so agent/user content can't inject markup. Covers the
// subset that shows up in Paperclip issues: headings, bold/italic, inline code,
// fenced code blocks, links, ordered/unordered lists, blockquotes, hr, and
// paragraphs with hard line breaks.

let keySeq = 0;
const nextKey = () => `md${keySeq++}`;

// Inline formatting: bold, italic, `code`, [text](url), and bare autolinks.
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // Order matters: code first (so its contents aren't re-parsed), then links, then emphasis.
  const pattern =
    /(`[^`]+`)|(\[[^\]]+\]\([^)]+\))|(\*\*[^*]+\*\*)|(__[^_]+__)|(\*[^*]+\*)|(_[^_]+_)|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) {
      nodes.push(
        <code key={nextKey()} className="md-code">
          {tok.slice(1, -1)}
        </code>,
      );
    } else if (tok.startsWith("[")) {
      const inner = /\[([^\]]+)\]\(([^)]+)\)/.exec(tok);
      if (inner) {
        nodes.push(
          <a
            key={nextKey()}
            href={inner[2] ?? "#"}
            target="_blank"
            rel="noreferrer noopener"
            className="md-link"
          >
            {inner[1] ?? ""}
          </a>,
        );
      } else nodes.push(tok);
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      nodes.push(
        <strong key={nextKey()}>{renderInline(tok.slice(2, -2))}</strong>,
      );
    } else if (tok.startsWith("*") || tok.startsWith("_")) {
      nodes.push(<em key={nextKey()}>{renderInline(tok.slice(1, -1))}</em>);
    } else if (tok.startsWith("http")) {
      nodes.push(
        <a
          key={nextKey()}
          href={tok}
          target="_blank"
          rel="noreferrer noopener"
          className="md-link"
        >
          {tok}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function renderLinesWithBreaks(lines: string[]): ReactNode[] {
  const out: ReactNode[] = [];
  lines.forEach((line, i) => {
    if (i > 0) out.push(<br key={nextKey()} />);
    out.push(<Fragment key={nextKey()}>{renderInline(line)}</Fragment>);
  });
  return out;
}

export function Markdown({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const blocks: ReactNode[] = [];
  const lines = (text ?? "").replace(/\r\n/g, "\n").split("\n");
  let i = 0;

  const flushList = (ordered: boolean, items: string[]) => {
    const children = items.map((item) => (
      <li key={nextKey()}>{renderInline(item)}</li>
    ));
    blocks.push(
      ordered ? (
        <ol key={nextKey()} className="md-list">
          {children}
        </ol>
      ) : (
        <ul key={nextKey()} className="md-list">
          {children}
        </ul>
      ),
    );
  };

  const at = (n: number): string => lines[n] ?? "";

  while (i < lines.length) {
    const line = at(i);

    // Fenced code block
    if (/^```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(at(i))) code.push(at(i++));
      i++; // closing fence
      blocks.push(
        <pre key={nextKey()} className="md-pre">
          <code>{code.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    // Blank line
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Horizontal rule
    if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push(<hr key={nextKey()} className="md-hr" />);
      i++;
      continue;
    }

    // Heading
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = (heading[1] ?? "#").length;
      const content = renderInline(heading[2] ?? "");
      const tag = `h${Math.min(level + 1, 6)}`;
      blocks.push(
        createElement(tag, { key: nextKey(), className: "md-h" }, content),
      );
      i++;
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(at(i)))
        quote.push(at(i++).replace(/^>\s?/, ""));
      blocks.push(
        <blockquote key={nextKey()} className="md-quote">
          {renderLinesWithBreaks(quote)}
        </blockquote>,
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(at(i)))
        items.push(at(i++).replace(/^\s*[-*+]\s+/, ""));
      flushList(false, items);
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(at(i)))
        items.push(at(i++).replace(/^\s*\d+\.\s+/, ""));
      flushList(true, items);
      continue;
    }

    // Paragraph (consume until blank line or a block starter)
    const para: string[] = [];
    while (
      i < lines.length &&
      at(i).trim() !== "" &&
      !/^```/.test(at(i)) &&
      !/^(#{1,6})\s+/.test(at(i)) &&
      !/^>\s?/.test(at(i)) &&
      !/^\s*[-*+]\s+/.test(at(i)) &&
      !/^\s*\d+\.\s+/.test(at(i)) &&
      !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(at(i))
    ) {
      para.push(at(i++));
    }
    blocks.push(
      <p key={nextKey()} className="md-p">
        {renderLinesWithBreaks(para)}
      </p>,
    );
  }

  return (
    <div className={className ? `markdown ${className}` : "markdown"}>
      {blocks}
    </div>
  );
}

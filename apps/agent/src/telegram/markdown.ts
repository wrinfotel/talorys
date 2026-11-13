/**
 * The agent answers in Markdown (the web chat renders it); Telegram needs its own
 * HTML subset (parse_mode: "HTML"). This module converts one into the other: bold,
 * italic, strikethrough, inline and fenced code, links, headings and blockquotes
 * survive; everything else becomes escaped plain text, so a reply can never fail
 * Telegram's parser with markup it did not intend.
 */

/** Telegram accepts 4096 characters per message; chunks are built under it with room for tags. */
export const TELEGRAM_HTML_CHUNK = 3500;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** One Markdown block: a paragraph, a fenced code block or a run of blockquote lines. */
interface Block {
  kind: "text" | "code" | "quote";
  lines: string[];
}

const FENCE = /^\s*```/;

/** Splits markdown into blocks at blank lines and code fences; tags never span blocks. */
function splitBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let text: string[] = [];
  let quote: string[] | null = null;
  const pushText = () => {
    if (text.length) blocks.push({ kind: "text", lines: text });
    text = [];
  };
  const pushQuote = () => {
    if (quote) {
      blocks.push({ kind: "quote", lines: quote });
      quote = null;
    }
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (FENCE.test(line)) {
      pushText();
      pushQuote();
      const code: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i]!)) code.push(lines[i++]!);
      blocks.push({ kind: "code", lines: code });
      continue;
    }
    if (!line.trim()) {
      pushText();
      pushQuote();
      continue;
    }
    if (/^>\s?/.test(line)) {
      pushText();
      quote ??= [];
      quote.push(line.replace(/^>\s?/, ""));
      continue;
    }
    pushQuote();
    text.push(line);
  }
  pushText();
  pushQuote();
  return blocks;
}

/** Inline markup on text that carries no code spans: links, bold, strikethrough, italic. */
function inlineText(md: string): string {
  let out = escapeHtml(md);
  // An image becomes a link to the picture; Telegram cannot show it inline.
  out = out.replace(/!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g, (_m, alt: string, url: string) => `<a href="${url}">${alt || url}</a>`);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${url}">${label}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>").replace(/__(.+?)__/g, "<b>$1</b>");
  out = out.replace(/~~([^~]+)~~/g, "<s>$1</s>");
  // Single markers only where they cannot be arithmetic (`2*3*4`) or snake_case.
  out = out.replace(/(^|[^\w*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>");
  out = out.replace(/(^|[^\w])_([^_\n]+)_(?!\w)/g, "$1<i>$2</i>");
  return out;
}

/** Inline markup with code spans protected from the formatting around them. */
function inline(md: string): string {
  return md
    .split(/(`[^`\n]+`)/)
    .map((part) => {
      const code = /^`([^`\n]+)`$/.exec(part);
      return code ? `<code>${escapeHtml(code[1]!)}</code>` : inlineText(part);
    })
    .join("");
}

/**
 * Hard-splits a line into escaped plain-text pieces of at most `max` characters.
 * The raw text is sliced first and each slice escaped on its own: slicing after
 * escaping could cut an entity ("&amp;" becoming "&am|p;") at a chunk boundary.
 */
function plainSlices(line: string, max: number): string[] {
  const escapedLength = (c: string) => (c === "&" ? 5 : c === "<" || c === ">" ? 4 : 1);
  const slices: string[] = [];
  let start = 0;
  let length = 0;
  for (let i = 0; i < line.length; i++) {
    const size = escapedLength(line[i]!);
    if (length + size > max && i > start) {
      slices.push(escapeHtml(line.slice(start, i)));
      start = i;
      length = 0;
    }
    length += size;
  }
  if (start < line.length) slices.push(escapeHtml(line.slice(start)));
  return slices;
}

/**
 * Turns one block into independent HTML pieces, each at most `max` characters.
 * Oversized blocks fall back to per-line pieces (or escaped slices for a pathologically
 * long line) so that no tag is ever cut in half.
 */
function blockPieces(block: Block, max: number): string[] {
  if (block.kind === "code") {
    const open = "<pre><code>";
    const close = "</code></pre>";
    const pieces: string[] = [];
    let run: string[] = [];
    let length = open.length + close.length;
    const flush = () => {
      if (run.length) pieces.push(`${open}${run.map(escapeHtml).join("\n")}${close}`);
      run = [];
      length = open.length + close.length;
    };
    for (const line of block.lines) {
      const escapedLength = escapeHtml(line).length + 1;
      if (length + escapedLength > max && run.length) flush();
      // A single line too long for a whole code block: escaped slices, each fenced.
      if (escapedLength > max) {
        flush();
        for (const slice of plainSlices(line, max - open.length - close.length)) pieces.push(`${open}${slice}${close}`);
        continue;
      }
      run.push(line);
      length += escapedLength;
    }
    flush();
    return pieces;
  }
  if (block.kind === "quote") {
    const whole = `<blockquote>${block.lines.map(inline).join("\n")}</blockquote>`;
    if (whole.length <= max) return [whole];
    // Too big as one quote: per-line quotes; a too-long line degrades to plain text.
    return block.lines.flatMap((line) => {
      const piece = `<blockquote>${inline(line)}</blockquote>`;
      if (piece.length <= max) return [piece];
      return plainSlices(line, max);
    });
  }
  const pieces: string[] = [];
  for (const line of block.lines) {
    if (/^\s*(?:[-*_]\s*){3,}$/.test(line)) continue; // a horizontal rule has no Telegram form
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const piece = heading ? `<b>${inline(heading[1]!)}</b>` : inline(line);
    if (piece.length <= max) pieces.push(piece);
    else pieces.push(...plainSlices(line, max));
  }
  return pieces;
}

/**
 * Chunks a Markdown reply into Telegram-ready HTML strings, each within `max`.
 * Chunk boundaries sit between blocks, so a chunk is always valid HTML on its own.
 */
export function telegramHtmlChunks(markdown: string, max = TELEGRAM_HTML_CHUNK): string[] {
  const chunks: string[] = [];
  let current = "";
  const append = (piece: string) => {
    if (current && current.length + 1 + piece.length > max) {
      chunks.push(current);
      current = piece;
    } else {
      current = current ? `${current}\n${piece}` : piece;
    }
  };
  for (const block of splitBlocks(markdown)) for (const piece of blockPieces(block, max)) append(piece);
  if (current) chunks.push(current);
  return chunks;
}

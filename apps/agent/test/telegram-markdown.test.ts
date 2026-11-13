import { describe, expect, it } from "vitest";
import { TELEGRAM_HTML_CHUNK, telegramHtmlChunks } from "../src/telegram/markdown";

describe("telegram markdown conversion", () => {
  it("converts bold, italic, code and links to Telegram HTML", () => {
    const [html] = telegramHtmlChunks("**bold** *italic* ~~gone~~ `x < y` see [docs](https://example.com/a?b=1&c=2)");
    expect(html).toBe(
      '<b>bold</b> <i>italic</i> <s>gone</s> <code>x &lt; y</code> see <a href="https://example.com/a?b=1&amp;c=2">docs</a>',
    );
  });

  it("escapes raw HTML so a reply cannot inject markup", () => {
    const [html] = telegramHtmlChunks("hello <script>alert(1)</script> & friends");
    expect(html).toBe("hello &lt;script&gt;alert(1)&lt;/script&gt; &amp; friends");
  });

  it("leaves arithmetic asterisks and snake_case alone", () => {
    const [html] = telegramHtmlChunks("2*3*4 and snake_case_word stay as written");
    expect(html).toBe("2*3*4 and snake_case_word stay as written");
  });

  it("renders a fenced code block with its content escaped", () => {
    const [html] = telegramHtmlChunks('Before.\n\n```js\nif (a < b && b > c) {}\n```\n\nAfter.');
    expect(html).toBe("Before.\n\n<pre><code>if (a &lt; b &amp;&amp; b &gt; c) {}</code></pre>\n\nAfter.");
  });

  it("turns headings into bold lines and quotes into blockquotes", () => {
    const [html] = telegramHtmlChunks("## Plan\n\n> one\n> two\n\nbody");
    expect(html).toBe("<b>Plan</b>\n\n<blockquote>one\ntwo</blockquote>\n\nbody");
  });

  it("turns an image into a link to the picture", () => {
    const [html] = telegramHtmlChunks("![a cat](https://example.com/cat.png)");
    expect(html).toBe('<a href="https://example.com/cat.png">a cat</a>');
  });

  it("drops horizontal rules that have no Telegram equivalent", () => {
    const [html] = telegramHtmlChunks("above\n\n---\n\nbelow");
    expect(html).toBe("above\n\nbelow");
  });

  it("keeps every chunk within the limit and never cuts a tag", () => {
    const markdown = Array.from({ length: 300 }, (_, i) => `Paragraph **${i}** with a [link](https://example.com/${i}) and \`code\`.`).join("\n\n");
    const chunks = telegramHtmlChunks(markdown);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_HTML_CHUNK);
      for (const tag of ["b", "i", "code", "a"]) {
        expect((chunk.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length).toBe((chunk.match(new RegExp(`</${tag}>`, "g")) ?? []).length);
      }
    }
  });

  it("splits an oversized code block into separately fenced pieces", () => {
    const markdown = `\`\`\`\n${"x".repeat(5000)}\n\`\`\``;
    const chunks = telegramHtmlChunks(markdown);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith("<pre><code>")).toBe(true);
      expect(chunk.endsWith("</code></pre>")).toBe(true);
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_HTML_CHUNK);
    }
    expect(chunks.join("")).toContain("xxxxx");
  });

  it("hard-splits a pathologically long line as escaped plain text", () => {
    const chunks = telegramHtmlChunks(`start ${"a&".repeat(4000)} end`, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(1000);
      // No entity is ever cut in half by a chunk boundary.
      expect(chunk).not.toMatch(/&(?!amp;|lt;|gt;)/);
    }
    expect(chunks.join("")).toContain("&amp;");
  });
});

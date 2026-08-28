/**
 * markdown.js 单测：语法覆盖 + 安全钉点。
 * 重点：模型/用户内容注入 <script> 不得产生可执行节点（HTML 路径被转义；
 * DOM 路径只走 textContent —— 用「innerHTML setter 抛错」的假 document 证明）。
 */
import { describe, expect, it } from 'vitest';
import {
  escapeHtml,
  safeHref,
  parseInline,
  parseMarkdown,
  markdownToHtml,
  markdownToDOM,
} from '../../src/ui/web/markdown.js';

// ---------------------------------------------------------------------------
// escapeHtml / safeHref
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('转义五个危险字符', () => {
    expect(escapeHtml('<a b="c">\'&')).toBe('&lt;a b=&quot;c&quot;&gt;&#39;&amp;');
  });
  it('数字和其他文案原样', () => {
    expect(escapeHtml('1 + 1 = 2')).toBe('1 + 1 = 2');
  });
});

describe('safeHref', () => {
  it('允许 http/https/mailto', () => {
    expect(safeHref('https://example.com')).toBe('https://example.com');
    expect(safeHref('http://a.cn/x')).toBe('http://a.cn/x');
    expect(safeHref('mailto:a@b.cn')).toBe('mailto:a@b.cn');
  });
  it('拒绝 javascript:/data:/vbscript:/file:/相对路径', () => {
    expect(safeHref('javascript:alert(1)')).toBeNull();
    expect(safeHref('JaVaScRiPt:alert(1)')).toBeNull();
    expect(safeHref('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHref('vbscript:msgbox')).toBeNull();
    expect(safeHref('file:///etc/passwd')).toBeNull();
    expect(safeHref('/relative/path')).toBeNull();
    expect(safeHref('//example.com')).toBeNull();
    expect(safeHref('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 行内解析
// ---------------------------------------------------------------------------

describe('parseInline', () => {
  it('识别 code/strong/em/del/link/nested', () => {
    const tokens = parseInline(
      '运行 `cmd --help` 与 **重要** 和 *斜体* 与 ~~删~~ [链](https://a.b)',
    );
    expect(tokens.map((t: { type: string }) => t.type)).toEqual([
      'text',
      'code',
      'text',
      'strong',
      'text',
      'em',
      'text',
      'del',
      'text',
      'link',
    ]);
    expect(tokens[1].text).toBe('cmd --help');
    expect(tokens[3].children[0].text).toBe('重要');
    expect(tokens[9].href).toBe('https://a.b');
  });

  it('加粗内容可含斜体（一层嵌套）', () => {
    const tokens = parseInline('**a *b* c**');
    expect(tokens[0].type).toBe('strong');
    expect(tokens[0]!.children.map((t: { type: string }) => t.type)).toEqual([
      'text',
      'em',
      'text',
    ]);
  });

  it('行内代码内的 * 不作为强调', () => {
    const t = parseInline('a `*b*` c');
    expect(t).toEqual([
      { type: 'text', text: 'a ' },
      { type: 'code', text: '*b*' },
      { type: 'text', text: ' c' },
    ]);
  });

  it('无法配对定界符降级为普通文本', () => {
    expect(
      parseInline('**未闭合')
        .map((t: { text: string }) => t.text)
        .join(''),
    ).toBe('**未闭合');
  });
});

// ---------------------------------------------------------------------------
// 块级解析 + HTML 渲染
// ---------------------------------------------------------------------------

describe('parseMarkdown / markdownToHtml', () => {
  it('标题 1..6 级', () => {
    const blocks = parseMarkdown('# 一\n## 二\n### 三\n#### 四\n##### 五\n###### 六');
    expect(blocks.map((b: { level: number }) => b.level)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(markdownToHtml('# 一')).toBe('<h1>一</h1>');
  });

  it('围栏代码块带 lang，内容转义', () => {
    const html = markdownToHtml('```bash\necho "<a>" && rm -rf /\n```');
    expect(html).toContain('<pre><code class="lang-bash">');
    expect(html).toContain('echo &quot;&lt;a&gt;&quot; &amp;&amp; rm -rf /');
    expect(html).not.toContain('<a>');
  });

  it('段落：行内语法全渲染', () => {
    const html = markdownToHtml('这是 **粗** 与 `c` 与 https://example.com 链接');
    expect(html).toContain('<strong>粗</strong>');
    expect(html).toContain('<code>c</code>');
  });

  it('段落内单换行为 <br>（模型常用硬换行）', () => {
    expect(markdownToHtml('第一行\n第二行')).toContain('第一行<br>第二行');
  });

  it('链接：安全 URL 出 <a>，带 rel noopener', () => {
    const html = markdownToHtml('[点我](https://a.b/c)');
    expect(html).toBe(
      '<p><a href="https://a.b/c" target="_blank" rel="noopener noreferrer">点我</a></p>',
    );
  });

  it('链接 URL 属性转义（& 与引号）', () => {
    const html = markdownToHtml('[x](https://a.b/?a=1&b="2")');
    expect(html).toContain('a=1&amp;b=&quot;2&quot;'); // href 内 &、引号转义
  });

  it('无序/有序列表', () => {
    const html = markdownToHtml('- 甲\n- 乙\n\n1. 一\n2. 二');
    expect(html).toContain('<ul><li>甲</li><li>乙</li></ul>');
    expect(html).toContain('<ol><li>一</li><li>二</li></ol>');
  });

  it('引用块与分隔线', () => {
    const html = markdownToHtml('> 引用\n> 继续\n\n---');
    expect(html).toContain('<blockquote><p>引用\n继续</p></blockquote>'.replace('\n', '<br>'));
    expect(html).toContain('<hr>');
  });

  it('图片降级为链接文本（且 url 过白名单）', () => {
    expect(markdownToHtml('![alt](https://a.b/i.png)')).toContain('<a href="https://a.b/i.png"');
    expect(markdownToHtml('![alt](javascript:alert(1))')).not.toContain('<a');
    expect(markdownToHtml('![alt](javascript:alert(1))')).toContain('alt'); // 文本仍在
  });

  it('表格无语法 → 按段落原样转义输出', () => {
    const html = markdownToHtml('| a | b |\n|---|---|');
    expect(html).not.toContain('<table');
    expect(html).toContain('| a | b |');
  });
});

// ---------------------------------------------------------------------------
// XSS 安全钉点（重要）
// ---------------------------------------------------------------------------

describe('XSS 钉点：模型内容注入 script 不执行', () => {
  const evil = '<script>alert("xss")</script>';
  const ALLOWED_TAGS = [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'pre',
    'code',
    'strong',
    'em',
    'del',
    'a',
    'ul',
    'ol',
    'li',
    'blockquote',
    'br',
    'hr',
  ];

  function tagsOf(html: string): string[] {
    return [...html.matchAll(/<([a-zA-Z0-9]+)/g)].map((m) => m[1]!);
  }

  [
    ['plain paragraph', evil],
    ['inside strong', `**${evil}**`],
    ['正文夹杂', `正文 ${evil} 完。`],
    ['inline code', `\`${evil}\``],
    ['code fence', `\`\`\`\n${evil}\n\`\`\``],
    ['link text', `[${evil}](https://example.com)`],
    ['heading', `# ${evil}`],
    ['list item', `- ${evil}`],
    ['quote', `> ${evil}`],
    ['blank-text payload', '<script src=x></script>'],
  ].forEach(([name, md]) => {
    it(`${name}：script 被转义成字符`, () => {
      const html = markdownToHtml(md as string);
      expect(html).toContain('&lt;script');
      expect(html).not.toContain('<script');
      // 输出里只允许本渲染器的白名单标签
      expect(tagsOf(html).every((t) => ALLOWED_TAGS.includes(t))).toBe(true);
    });
  });

  it('javascript: 链接丢弃链接语义，只留文本', () => {
    const html = markdownToHtml(`[点我](javascript:alert(1))`);
    expect(html).not.toContain('<a');
    expect(html).not.toContain('javascript');
    expect(html).toContain('点我');
  });

  it('data:/vbscript: 链接同样丢弃链接语义', () => {
    for (const href of ['data:text/html,<script>alert(1)</script>', 'vbscript:msgbox(1)']) {
      const html = markdownToHtml(`[x](${href})`);
      expect(html).not.toContain('<a');
      expect(html).not.toContain('<script');
    }
  });

  it('href 中的双引号被属性转义（无法闭合属性）', () => {
    const html = markdownToHtml('[x](https://evil.example.com/" onclick="alert(1))');
    expect(html).toContain('&quot;'); // 但能保证没有裸引号逃逸
    expect(html).not.toContain('<a href="https://evil.example.com/" onclick');
  });

  it('属性注入 <img onerror> 被整体转义为字符', () => {
    const html = markdownToHtml('<img src=x onerror=alert(1)>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('iframe/object/embed/form 全部转义', () => {
    for (const md of ['<iframe src=x>', '<object data=x>', '<embed src=x>', '<form action=/x>']) {
      const html = markdownToHtml(md);
      expect(tagsOf(html).every((t) => ALLOWED_TAGS.includes(t))).toBe(true);
    }
  });

  it('链接文本内的引号/尖括号不破坏 DOM 结构', () => {
    const html = markdownToHtml('[<b>"x"</b>](https://a.b)');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;b&gt;');
  });
});

// ---------------------------------------------------------------------------
// DOM 路径：假 document（innerHTML 抛错）证明不走 innerHTML
// ---------------------------------------------------------------------------

function makeFakeDoc() {
  const ops: string[] = [];
  function el(tag: string) {
    const node: any = {
      nodeName: tag,
      children: [],
      attributes: {} as Record<string, string>,
      textContent: '',
      className: '',
      classList: {
        add: (c: string) => {
          ops.push(`${tag}.classList.add(${c})`);
        },
        toggle: () => undefined,
      },
      setAttribute: (k: string, v: string) => {
        ops.push(`${tag}.setAttribute(${k},${v})`);
        node.attributes[k] = v;
      },
      appendChild: (c: any) => {
        node.children.push(c);
        return c;
      },
      replaceChildren: (...cs: any[]) => {
        ops.push(`${tag}.replaceChildren`);
        node.children.length = 0;
        node.children.push(...cs);
        return node;
      },
      set innerHTML(_v: string) {
        throw new Error('innerHTML 被调用 —— XSS 违规');
      },
      querySelector: () => null,
    };
    return node;
  }
  const doc: any = {
    createElement: (tag: string) => el(tag),
    createTextNode: (t: string) => ({ nodeType: 3, textContent: t }),
    ops,
  };
  return doc;
}

function collectText(node: any): string {
  if (node.nodeType === 3) return node.textContent;
  // 叶子节点的内容在假 document 里落在 textContent 属性（与真实 DOM 一致的语义）
  if (!node.children?.length) return node.textContent ?? '';
  let out = '';
  for (const c of node.children ?? []) out += collectText(c);
  return out;
}

describe('markdownToDOM（文本节点路径）', () => {
  it('模型注入 <script> 渲染为纯文本字符（textContent 路径）', () => {
    const doc = makeFakeDoc();
    const container = doc.createElement('div');
    markdownToDOM(container, '**前**<script>alert(1)</script>\n\n```\n<img src=x>\n```', { doc });
    const text = collectText(container);
    expect(text).toContain('<script>alert(1)</script>'); // 字符层面原样显示
    expect(text).toContain('<img src=x>');
    // 任何节点（含 a 元素）都没有 innerHTML 被调用
    expect(doc.ops.join('\n')).not.toContain('innerHTML');
  });

  it('安全 href 生 <a>；javascript: 链接保持纯文本', () => {
    const doc = makeFakeDoc();
    const container = doc.createElement('div');
    markdownToDOM(container, '[ok](https://a.b) [bad](javascript:alert(1))', { doc });
    const anchors = container.children[0].children.filter((c: any) => c.nodeName === 'a');
    expect(anchors).toHaveLength(1);
    expect(anchors[0].attributes.href).toBe('https://a.b');
    // 文本内容保留两个链接的文字
    const text = collectText(container);
    expect(text).toContain('bad');
  });

  it('无 document 环境抛明确错误（node 下不被误用）', () => {
    // simulate bare node: temporary remove globalThis.document
    const saved = (globalThis as any).document;
    (globalThis as any).document = undefined;
    expect(() => markdownToDOM({}, 'x', { doc: undefined })).toThrow(/document/);
    (globalThis as any).document = saved;
  });
});

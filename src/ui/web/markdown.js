/**
 * # markdown.js — 手写安全 Markdown 渲染器（纯逻辑，node 可直接 import）
 *
 * ## 安全契约（XSS 纪律）
 * 1. **所有**进入输出的文本都在渲染时经过 escapeHtml，无一例外（含代码块、行内码、
 *    链接文本、标题、列表项、引用、粗斜体内容）。
 * 2. 链接 href 走 `safeHref` 白名单：仅 http/https/mailto；其余一律丢弃链接语义
 *    （渲染成纯文本）。杜绝 javascript:/data:/vbscript:。
 * 3. `markdownToDOM` 只用 `document.createElement` + `textContent` 建节点，
 *    从不使用 innerHTML —— 模型内容即使写 `<script>` 也只会显示为字符。
 *    （HTML 串路径 `markdownToHtml` 仅用于纯环境渲染/单测断言。）
 * 4. 不渲染 <img>（外部图片是跟踪/协议面），图片语法降级为链接文本。
 *
 * ## 支持语法（够用即止，不追完整 CommonMark）
 * 块级：#~###### 标题 / ``` 围栏代码块（含 lang）/ *-+ 无序列表 / 数字有序列表 /
 *         > 引用（可嵌套）/ --- 分隔线 / 段落（合并没有空行的行）。
 * 行内：`code`、**bold**、_em_、*em*、__bold__、~~del~~、[text](url)、![alt](url)降级。
 * 不支持表格等：会按普通段落显示（escape 后），不会失真也不会注入。
 *
 * 限制：仅输出 DOM 节点（浏览器）或 HTML 字符串（测试）；无运行时依赖。
 */

// ---------------------------------------------------------------------------
// 基础转义
// ---------------------------------------------------------------------------

/** HTML 文本转义（& < > " '）。调用点统一在「渲染时」，绝不在解析前二次转义。 */
export function escapeHtml(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** 属性值转义（在 escapeHtml 基础上不额外转义，HTML 属性用双引号包裹即可）。 */
export function escapeAttr(text) {
  return escapeHtml(text);
}

const SAFE_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * URL 白名单。返回安全的 URL 或 null（丢弃链接语义，渲染成纯文本）。
 * 显式拒绝：javascript:、data:、vbscript:、file:、空/相对路径（模型给的相对链接
 * 在父子域导航上不值当，一律按纯文本）。
 */
export function safeHref(url) {
  const raw = String(url ?? '').trim();
  if (raw === '') return null;
  // 只允许带合法协议的绝对 URL；无协议冒号的一律拒绝
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(raw);
  if (!m) return null;
  const scheme = m[1].toLowerCase(); // 'https' / 'javascript' …
  if (!SAFE_SCHEMES.has(scheme + ':')) return null;
  return raw;
}

// ---------------------------------------------------------------------------
// 行内解析：text | code | strong | em | del | link
// ---------------------------------------------------------------------------
// 返回 token 列表：[{type:'text',text} | {type:'code',text} | {type:'strong',children}
// | {type:'em',children} | {type:'del',children} | {type:'link',children,href}]

const MAX_INLINE_DEPTH = 4;

/** 在位置 i 尝试匹配一条行内规则（按优先级：code → link → image → strong → del → em）。 */
function matchInline(text, i, depth) {
  const rest = text.slice(i);
  // 行内代码：优先，内容不再解析
  let m = /^`([^`\n]+)`/.exec(rest);
  if (m) return { type: 'code', text: m[1], next: i + m[0].length };

  // 图片 → 降级为链接文本（不生成外部资源请求）
  m = /^!\[([^\]\n]*)\]\(([^)\s]*)\)/.exec(rest);
  if (m) {
    return {
      type: 'link',
      href: m[2],
      children: [{ type: 'text', text: m[1] || 'image' }],
      next: i + m[0].length,
    };
  }

  // 链接 [text](url) —— url 不允许空白与右括号
  m = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
  if (m) {
    return {
      type: 'link',
      href: m[2],
      children: parseInline(m[1], depth + 1),
      next: i + m[0].length,
    };
  }

  // 加粗 **x** / __x__：内容允许含单个 * 或 _（可嵌套斜体），故按「找闭合定界符」解析
  const delimiter = /^\*\*/.test(rest)
    ? { open: '**', close: '**' }
    : /^__/.test(rest)
      ? { open: '__', close: '__' }
      : /^~~/.test(rest)
        ? { open: '~~', close: '~~' }
        : null;
  if (delimiter) {
    const end = rest.indexOf(delimiter.close, delimiter.open.length);
    if (end > delimiter.open.length - 1) {
      const content = rest.slice(delimiter.open.length, end);
      if (!content.includes('\n')) {
        return {
          type: delimiter.open === '~~' ? 'del' : 'strong',
          children: parseInline(content, depth + 1),
          next: i + end + delimiter.close.length,
        };
      }
    }
    return null; // 未闭合：作为普通文本走失
  }

  // 斜体 *x* / _x_（不跨行；前后需非字母数字，避免"snake_case_word"被误伤）
  if (rest.startsWith('*') && !rest.startsWith('**')) {
    const end = rest.indexOf('*', 1);
    const before = text[i - 1] ?? '';
    const after = rest[end + 1] ?? '';
    if (end >= 2 && !/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) {
      const content = rest.slice(1, end);
      if (!content.includes('\n')) {
        return { type: 'em', children: parseInline(content, depth + 1), next: i + end + 1 };
      }
    }
  }
  if (rest.startsWith('_') && !rest.startsWith('__')) {
    const end = rest.indexOf('_', 1);
    const before = text[i - 1] ?? '';
    const after = rest[end + 1] ?? '';
    if (end >= 2 && !/[A-Za-z0-9]/.test(before) && !/[A-Za-z0-9]/.test(after)) {
      const content = rest.slice(1, end);
      if (!content.includes('\n')) {
        return { type: 'em', children: parseInline(content, depth + 1), next: i + end + 1 };
      }
    }
  }
  return null;
}

/**
 * 解析行内 markdown → token 数组。depth 越大越不尝试嵌套（防病态输入）。
 * 输入保持原始文本；转义全部发生在渲染期 —— 不会出现双重转义。
 */
export function parseInline(text, depth = 0) {
  const tokens = [];
  let i = 0;
  const src = String(text ?? '');
  while (i < src.length) {
    if (depth >= MAX_INLINE_DEPTH) {
      tokens.push({ type: 'text', text: src.slice(i) });
      break;
    }
    const matched = matchInline(src, i, depth);
    if (!matched) {
      const firstChar = src[i];
      i += 1;
      const last = tokens[tokens.length - 1];
      if (last && last.type === 'text') {
        last.text += firstChar; // 与上一段文本片合并，保持输出紧凑
      } else {
        tokens.push({ type: 'text', text: firstChar });
      }
      continue;
    }
    // 注意：matchInline 内部携带 next 字段，出参必须摘除（token 是公共数据结构）
    if (matched.type === 'code') {
      tokens.push({ type: 'code', text: matched.text });
    } else if (matched.type === 'link') {
      tokens.push({ type: 'link', href: matched.href, children: matched.children });
    } else {
      tokens.push({ type: matched.type, children: matched.children });
    }
    i = matched.next;
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// 块级解析
// ---------------------------------------------------------------------------

/** 块：heading/paragraph/code/list/quote/hr 。list.item.text 是原始行文本（含续行）。 */
export function parseMarkdown(md, depth = 0) {
  const source = String(md ?? '').replace(/\r\n?/g, '\n');
  const lines = source.split('\n');
  const blocks = [];
  const MAX_BLOCK_DEPTH = 3;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 空行
    if (/^\s*$/.test(line)) {
      i += 1;
      continue;
    }

    // 围栏代码块 ```lang … ```
    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const lang = fence[1] || '';
      const codeLines = [];
      i += 1;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        codeLines.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过收尾 ```
      blocks.push({ type: 'code', lang, code: codeLines.join('\n') });
      continue;
    }

    // ATX 标题 #~######
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(heading[2]) });
      i += 1;
      continue;
    }

    // 分隔线 --- / *** / ___
    if (/^(---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push({ type: 'hr' });
      i += 1;
      continue;
    }

    // 引用 > …（连续行），去掉前缀后递归解析
    if (/^\s*>/.test(line)) {
      const quoteLines = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''));
        i += 1;
      }
      blocks.push({
        type: 'quote',
        blocks: parseMarkdown(quoteLines.join('\n'), Math.min(depth + 1, MAX_BLOCK_DEPTH)),
      });
      continue;
    }

    // 列表
    const listMatcher = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (listMatcher) {
      const ordered = /\d+[.)]/.test(listMatcher[2]);
      const items = [];
      // 首行
      items.push({ indent: listMatcher[1].length, text: listMatcher[3] });
      i += 1;
      while (i < lines.length) {
        const next = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (next) {
          items.push({ indent: next[1].length, text: next[3] });
          i += 1;
          continue;
        }
        if (/^\s*$/.test(lines[i])) {
          // 列表内部空行：若后面是**同类型**列表项则允许续段，否则中断（防止 ul/ol 粘连）
          let j = i + 1;
          while (j < lines.length && /^\s*$/.test(lines[j])) j += 1;
          const nxt = /^\s*([-*+]|\d+[.)])\s+/.exec(lines[j] ?? '');
          if (nxt) {
            const nextOrdered = /\d+[.)]/.test(nxt[1]);
            if (nextOrdered === ordered) {
              i = j;
              continue;
            }
          }
          break;
        }
        // 续行（列表项的折行文本）
        if (/^\s{2,}/.test(lines[i])) {
          items[items.length - 1].text += '\n' + lines[i].trim();
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({
        type: 'list',
        ordered,
        items: items.map((it) => ({ inline: parseInline(it.text) })),
      });
      continue;
    }

    // 段落：连续非空行聚合（遇到其他块起始行即停 —— 由外层循环重新分派）
    const paraLines = [line];
    i += 1;
    while (i < lines.length) {
      const l = lines[i];
      if (
        /^\s*$/.test(l) ||
        /^(#{1,6})\s+/.test(l) ||
        /^```/.test(l) ||
        /^(\s*)([-*+]|\d+[.)])\s+/.test(l) ||
        /^\s*>/.test(l) ||
        /^(---|\*\*\*|___)\s*$/.test(l)
      ) {
        break;
      }
      paraLines.push(l);
      i += 1;
    }
    // 段落内单独一行且不包含行内语法时按原样换行（render 层处理 <br> 语义）
    blocks.push({ type: 'paragraph', inline: parseInline(paraLines.join('\n')) });
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// HTML 串渲染（纯环境：node 单测 / 无 DOM 场景）。输出已被完全转义。
// ---------------------------------------------------------------------------

function renderInlineHtml(tokens) {
  let out = '';
  for (const t of tokens) {
    switch (t.type) {
      case 'text':
        out += escapeHtml(t.text);
        break;
      case 'code':
        out += `<code>${escapeHtml(t.text)}</code>`;
        break;
      case 'strong':
        out += `<strong>${renderInlineHtml(t.children)}</strong>`;
        break;
      case 'em':
        out += `<em>${renderInlineHtml(t.children)}</em>`;
        break;
      case 'del':
        out += `<del>${renderInlineHtml(t.children)}</del>`;
        break;
      case 'link': {
        const href = safeHref(t.href);
        if (href === null) {
          out += renderInlineHtml(t.children); // 不安全的链接 → 只剩文本，无可交互目标
        } else {
          out += `<a href="${escapeAttr(href)}" target="_blank" rel="noopener noreferrer">${renderInlineHtml(t.children)}</a>`;
        }
        break;
      }
      default:
        out += escapeHtml(t.text ?? '');
    }
  }
  return out;
}

function renderBlockHtml(b) {
  switch (b.type) {
    case 'heading': {
      const lvl = Math.min(6, Math.max(1, b.level));
      return `<h${lvl}>${renderInlineHtml(b.inline)}</h${lvl}>`;
    }
    case 'paragraph':
      // 段落内单个换行 → <br>（模型常用硬换行）
      return `<p>${renderInlineHtml(b.inline).replaceAll('\n', '<br>')}</p>`;
    case 'code':
      return `<pre><code${b.lang ? ` class="lang-${escapeAttr(b.lang)}"` : ''}>${escapeHtml(b.code)}</code></pre>`;
    case 'list': {
      const tag = b.ordered ? 'ol' : 'ul';
      const items = b.items
        .map((it) => `<li>${renderInlineHtml(it.inline).replaceAll('\n', '<br>')}</li>`)
        .join('');
      return `<${tag}>${items}</${tag}>`;
    }
    case 'quote':
      return `<blockquote>${b.blocks.map(renderBlockHtml).join('')}</blockquote>`;
    case 'hr':
      return '<hr>';
    default:
      return '';
  }
}

/** Markdown → 转义安全 HTML 字符串（每条内容 escapeHtml 一次；链接过白名单）。 */
export function markdownToHtml(md) {
  return parseMarkdown(md).map(renderBlockHtml).join('\n');
}

// ---------------------------------------------------------------------------
// DOM 渲染（浏览器）：只 createElement / textContent，杜绝 innerHTML。
// ---------------------------------------------------------------------------

function docOf(opts) {
  const doc = opts?.doc ?? globalThis.document;
  if (!doc) throw new Error('markdownToDOM 需要浏览器 document（node 下请用 markdownToHtml）');
  return doc;
}

function appendInline(parent, tokens, doc) {
  for (const t of tokens) {
    switch (t.type) {
      case 'text': {
        const el = doc.createTextNode(t.text);
        parent.appendChild(el);
        break;
      }
      case 'code': {
        const code = doc.createElement('code');
        code.textContent = t.text;
        parent.appendChild(code);
        break;
      }
      case 'strong': {
        const el = doc.createElement('strong');
        appendInline(el, t.children, doc);
        parent.appendChild(el);
        break;
      }
      case 'em': {
        const el = doc.createElement('em');
        appendInline(el, t.children, doc);
        parent.appendChild(el);
        break;
      }
      case 'del': {
        const el = doc.createElement('del');
        appendInline(el, t.children, doc);
        parent.appendChild(el);
        break;
      }
      case 'link': {
        const href = safeHref(t.href);
        if (href === null) {
          appendInline(parent, t.children, doc); // 不安全的链接 → 纯文本
          break;
        }
        const a = doc.createElement('a');
        a.setAttribute('href', href);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        appendInline(a, t.children, doc);
        parent.appendChild(a);
        break;
      }
      default: {
        // 未知 token（防御）：同样只落文本
        parent.appendChild(doc.createTextNode(String(t.text ?? '')));
      }
    }
  }
}

function appendBlock(parent, b, doc, opts) {
  switch (b.type) {
    case 'heading': {
      const el = doc.createElement('h' + Math.min(6, Math.max(1, b.level)));
      appendInline(el, b.inline, doc);
      parent.appendChild(el);
      break;
    }
    case 'paragraph': {
      const el = doc.createElement('p');
      // 段落内的单换行按 <br> 语义显示（模型常用硬换行）
      const parts = splitInlineByNewline(b.inline);
      parts.forEach((part, idx) => {
        if (idx > 0) el.appendChild(doc.createElement('br'));
        appendInline(el, part, doc);
      });
      parent.appendChild(el);
      break;
    }
    case 'code': {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      if (b.lang) code.classList.add('lang-' + String(b.lang).replace(/[^a-zA-Z0-9_-]/g, ''));
      code.textContent = b.code;
      pre.appendChild(code);
      if (opts?.addCopyButton && !b.code.includes('\n')) {
        // 无运行时依赖的复制按钮仅对单行短代码块提供，避免交互噪音
        const btn = doc.createElement('button');
        btn.className = 'copy-btn';
        btn.type = 'button';
        btn.textContent = '复制';
        pre.appendChild(btn);
      }
      parent.appendChild(pre);
      break;
    }
    case 'list': {
      const list = doc.createElement(b.ordered ? 'ol' : 'ul');
      for (const it of b.items) {
        const li = doc.createElement('li');
        const wrap = doc.createElement('span');
        wrap.className = 'li-text';
        const parts = splitInlineByNewline(it.inline);
        parts.forEach((part, j) => {
          if (j > 0) wrap.appendChild(doc.createElement('br'));
          appendInline(wrap, part, doc);
        });
        li.appendChild(wrap);
        list.appendChild(li);
      }
      parent.appendChild(list);
      break;
    }
    case 'quote': {
      const q = doc.createElement('blockquote');
      for (const child of b.blocks) appendBlock(q, child, doc, opts);
      parent.appendChild(q);
      break;
    }
    case 'hr': {
      parent.appendChild(doc.createElement('hr'));
      break;
    }
    default:
      parent.appendChild(doc.createTextNode(String(b?.text ?? '')));
  }
}

/** 将 inline token 列表按「文本中的 \n」切片（用于段落内单换行 → <br>）。 */
function splitInlineByNewline(tokens) {
  const parts = [[]];
  for (const t of tokens) {
    if (t.type === 'text') {
      const segs = t.text.split('\n');
      segs.forEach((seg, i) => {
        if (i > 0) parts.push([]);
        if (seg) parts[parts.length - 1].push({ ...t, text: seg });
      });
    } else {
      parts[parts.length - 1].push(t);
    }
  }
  return parts;
}

/**
 * 把 markdown 渲染进容器（清空后重建）。只使用 createElement/textContent —— XSS 安全。
 * 返回 container（便于链式）。opts.doc 可注入（测试用假 document）。
 */
export function markdownToDOM(container, md, opts = {}) {
  const doc = docOf(opts);
  container.replaceChildren?.();
  for (const b of parseMarkdown(md)) {
    appendBlock(container, b, doc, opts);
  }
  return container;
}

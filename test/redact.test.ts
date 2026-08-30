/**
 * # test/redact：机密脱敏（接缝 S11，src/core/tools/redact.ts）
 *
 * 纪律（研究 §8D 机密脱敏行 —【一手要求】redact secrets；正则集【经验值】）：
 * - 只做常见凭据形态（AKIA/ghp_/sk-/Bearer/私钥块/Basic），不追求穷尽；
 * - 用例一律用真实形态样本（长度、字符集与真实凭据一致）；
 * - Base64 判别取舍：不做「裸 base64 雷区」判别 —— 只有 `Basic <token>` 形态才进入
 *   base64 判别，且 token 须满足「可解码 + 含冒号 + 全可打印 ASCII」；误杀风险及
 *   未覆盖形态（裸 base64 文本块）的取舍记录在模块头注释。
 */
import { describe, expect, it } from 'vitest';

import { redactSecrets } from '../src/core/tools/redact.js';

const AWS_KEY = 'AKIAIOSFODNN7EXAMPLE'; // AKIA + 16（真实形态：20 字符）
const AWS_TEMP = 'ASIA' + 'ABCDEFGHIJKLMNOP'; // ASIA + 16（临时凭据同形）
const GITHUB_TOKEN = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0'; // 40 字符（真实形态）
const GITHUB_OAUTH = 'gho_' + 'x'.repeat(40);
const OPENAI_KEY = 'sk-' + 'abcXYZ1234'.repeat(4); // sk- + 40 字符
const OPENAI_PROJ_KEY = 'sk-proj-' + 'abcXYZ1234'.repeat(5);
const JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
const PRIVATE_KEY_BLOCK = [
  '-----BEGIN PRIVATE KEY-----',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDCqR1i5ZtK3m8x',
  'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDCqR1i5ZtK3m8x',
  '-----END PRIVATE KEY-----',
].join('\n');

/** Basic base64：真实凭据编码（user:pass 文档形态）。 */
function basicAuthHeader(credential: string): string {
  return `Authorization: Basic ${Buffer.from(credential, 'latin1').toString('base64')}`;
}

describe('redactSecrets：默认形态集（切片 a）', () => {
  it('AWS 访问密钥：AKIA + 16 位打码为 aws-access-key', () => {
    const r = redactSecrets(`aws_access_key_id="${AWS_KEY}"`);
    expect(r).toBe('aws_access_key_id="[REDACTED:aws-access-key]"');
  });

  it('AWS 临时凭据：ASIA + 16 位同样命中', () => {
    expect(redactSecrets(`x=${AWS_TEMP}`)).toBe('x=[REDACTED:aws-access-key]');
  });

  it('GitHub ghp_（40 字符）→ github-token', () => {
    expect(redactSecrets(`GITHUB_TOKEN=${GITHUB_TOKEN}`)).toBe(
      'GITHUB_TOKEN=[REDACTED:github-token]',
    );
  });

  it('GitHub gho_（OAuth token）→ github-token', () => {
    expect(redactSecrets(`oauth=${GITHUB_OAUTH}`)).toBe('oauth=[REDACTED:github-token]');
  });

  it('OpenAI sk- + 40 字符 → openai-key；sk-proj- 前缀同样命中', () => {
    expect(redactSecrets(`OPENAI_API_KEY=${OPENAI_KEY}`)).toBe(
      'OPENAI_API_KEY=[REDACTED:openai-key]',
    );
    expect(redactSecrets(`alt=${OPENAI_PROJ_KEY}`)).toBe('alt=[REDACTED:openai-key]');
  });

  it('VT2-2：真实 DeepSeek 形态（sk- + 32hex = 35 符）命中（旧阈值 36 恰好漏掉——脱敏漏 real key）', () => {
    const deepseekReal = 'sk-' + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6'; // 32 hex
    expect(deepseekReal).toHaveLength(35);
    expect(redactSecrets(`DEV_MATE_API_KEY=${deepseekReal}`)).toBe(
      'DEV_MATE_API_KEY=[REDACTED:openai-key]',
    );
  });

  it('VT2-2：sk- + 24..34 符（通用低阈区间）命中；<24 不命中', () => {
    for (const n of [24, 29, 34]) {
      const key = 'sk-' + 'a1b2c3d4'.repeat(Math.ceil(n / 8)).slice(0, n);
      expect(key).toHaveLength(n + 3);
      expect(redactSecrets(`k=${key}`)).toBe('k=[REDACTED:openai-key]');
    }
    const tooShort = 'sk-' + 'a1b2c3d4'.repeat(3).slice(0, 23); // sk- + 23 符
    expect(tooShort).toHaveLength(26);
    expect(redactSecrets(`k=${tooShort}`)).toBe(`k=${tooShort}`);
  });

  it('短于最小长度的类 token 不误杀（sk- 最小 24 位）', () => {
    expect(redactSecrets('token=sk-short')).toBe('token=sk-short');
    expect(redactSecrets('token=sk-' + 'a'.repeat(23))).toBe('token=sk-' + 'a'.repeat(23));
  });

  it('Bearer <JWT>（Authorization 头）→ bearer-token', () => {
    const r = redactSecrets(`curl -H "Authorization: Bearer ${JWT}" https://api.example.com`);
    expect(r).toBe('curl -H "Authorization: [REDACTED:bearer-token]" https://api.example.com');
  });

  it('Bearer 前缀大小写不敏感（/i）；短 token 不误杀', () => {
    expect(redactSecrets(`auth: BEARER ${JWT}`)).toBe(`auth: [REDACTED:bearer-token]`);
    expect(redactSecrets('auth: Bearer tokens are nice')).toBe('auth: Bearer tokens are nice');
  });

  it('BEGIN PRIVATE KEY 整块（含内容行）→ 单个 private-key 标记', () => {
    const r = redactSecrets(`secrets: ${PRIVATE_KEY_BLOCK} before`);
    expect(r).toBe('secrets: [REDACTED:private-key] before');
  });

  it('BEGIN RSA PRIVATE KEY 变体同样命中', () => {
    const block = PRIVATE_KEY_BLOCK.replace(/PRIVATE KEY/g, 'RSA PRIVATE KEY');
    expect(redactSecrets(block)).toBe('[REDACTED:private-key]');
  });

  it('Basic base64（判别通过：解码含冒号）→ basic-auth', () => {
    const r = redactSecrets(basicAuthHeader('user:pass'));
    expect(r).toBe('Authorization: [REDACTED:basic-auth]');
  });

  it('Basic base64 带 padding（14 字节凭据，含 pad）同样命中；裸 b64 无 Basic 前缀不打码', () => {
    const token = Buffer.from('user:password!', 'latin1').toString('base64');
    expect(token.endsWith('=')).toBe(true); // 14 字节 → 1 个 pad
    expect(redactSecrets(`Authorization: Basic ${token}`)).toBe(
      'Authorization: [REDACTED:basic-auth]',
    );
    // 裸 b64 是无 Basic 前缀的原始 blob：不做 base64 判别（取舍见模块头注释）
    expect(redactSecrets(`h=${token}`)).toBe(`h=${token}`);
  });

  it('Basic 判别拒杀：码值非 user:pass 形态（解码无冒号或含二进制）原样保留', () => {
    // 可解码但无冒号 → 不是 Basic 凭据
    expect(redactSecrets('This is basic information for developers')).toBe(
      'This is basic information for developers',
    );
    // 解码含冒号但字节含非打印字符（0xfe）→ 视为二进制 blob，不判为凭据
    const binary = Buffer.from('u:s\xfe', 'latin1').toString('base64');
    expect(redactSecrets(`Authorization: Basic ${binary}`)).toBe(`Authorization: Basic ${binary}`);
  });

  it('裸 base64 文本块（无 Basic 前缀）不打码（只做常见凭据形态，不追求穷尽）', () => {
    const blob = Buffer.from('user:pass').toString('base64');
    expect(redactSecrets(`key: ${blob}`)).toBe(`key: ${blob}`);
  });
});

describe('redactSecrets：标记稳定与幂等（切片 b）', () => {
  const kitchenSink = [
    'AWS_ACCESS_KEY_ID=' + AWS_KEY,
    'GITHUB_TOKEN=' + GITHUB_TOKEN,
    'OPENAI_API_KEY=' + OPENAI_KEY,
    'curl -H "Authorization: Bearer ' + JWT + '" https://api.example.com',
    'DATABASE_URL=mysql://root:secretpw@db.example.com:5432/app',
    PRIVATE_KEY_BLOCK,
  ].join('\n');

  it('同输入同输出（无随机、无共享状态）', () => {
    expect(redactSecrets(kitchenSink)).toBe(redactSecrets(kitchenSink));
  });

  it('已打码内容不二次打码（一遍再跑输出完全不变）', () => {
    const once = redactSecrets(kitchenSink);
    expect(redactSecrets(once)).toBe(once);
    expect(redactSecrets(redactSecrets(kitchenSink))).toBe(once);
  });

  it('输出中残留的原始凭据字符为零，每类仅剩一个稳定标记', () => {
    const out = redactSecrets(kitchenSink);
    expect(out).not.toContain(AWS_KEY);
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('sk-');
    expect(out).not.toContain(JWT);
    expect(out).not.toContain('secretpw');
    expect(out).not.toContain('BEGIN PRIVATE KEY');
    expect(out).not.toContain('END PRIVATE KEY');
    const markers = out.match(/\[REDACTED:[a-z-]+\]/g);
    expect(markers).toEqual([
      '[REDACTED:aws-access-key]',
      '[REDACTED:github-token]',
      '[REDACTED:openai-key]',
      '[REDACTED:bearer-token]',
      '[REDACTED:url-credentials]',
      '[REDACTED:private-key]',
    ]);
  });
});

describe('redactSecrets：边界（切片 c）', () => {
  it('无 secret 的文本逐字不动（含 AKIA 片段与 task- 之类前缀单词）', () => {
    const text =
      'AKIA 只是前缀说明。翻看 task-1234 与 sk-prefix 这类普通词组不应命中；' +
      '本例没有任何真实凭据。Basic 是大写开头。';
    expect(redactSecrets(text)).toBe(text);
  });

  it('空串与无匹配文本原样返回', () => {
    expect(redactSecrets('')).toBe('');
    expect(redactSecrets('plain code `const a = 1`')).toBe('plain code `const a = 1`');
  });

  it('bearer 边界：16 字符 token 命中打码；常用英文词（<16 字符）原样——无 guard，纯长度门限', () => {
    expect(redactSecrets(`Authorization: Bearer ${'a'.repeat(16)}`)).toBe(
      'Authorization: [REDACTED:bearer-token]',
    );
    expect(redactSecrets('Authorization: Bearer value')).toBe('Authorization: Bearer value');
    expect(redactSecrets('auth: Bearer token examples')).toBe('auth: Bearer token examples');
  });

  it('CRLF（\\r\\n）私钥块整体打码', () => {
    const crlfBlock = PRIVATE_KEY_BLOCK.split('\n').join('\r\n');
    expect(redactSecrets(crlfBlock)).toBe('[REDACTED:private-key]');
  });

  it('同一文本两块私钥 → 各自独立一个标记（非贪婪，不跨块吞并）', () => {
    const text = [PRIVATE_KEY_BLOCK, 'separator', PRIVATE_KEY_BLOCK].join('\n');
    expect(redactSecrets(text)).toBe('[REDACTED:private-key]\nseparator\n[REDACTED:private-key]');
  });

  it('URL 中明文 user:pass@host → 密码段整段打码（保留 scheme/@host）', () => {
    const r = redactSecrets('git clone https://user:pass@host/repo.git');
    expect(r).toBe('git clone https://[REDACTED:url-credentials]@host/repo.git');
  });

  it('URL 中 token 形态用户名（ghp_@，无冒号）→ github-token（token 模式兜住）', () => {
    const r = redactSecrets(`git clone https://${GITHUB_TOKEN}@github.com/owner/repo.git`);
    expect(r).toBe(`git clone https://[REDACTED:github-token]@github.com/owner/repo.git`);
  });

  it('URL user:pass@ 不含 case：user:pass 与入口主机名拆开的 port URL 不动', () => {
    expect(redactSecrets('fetch https://example.com:8080/path')).toBe(
      'fetch https://example.com:8080/path',
    );
    // 单独用户名（无冒号密码段）不算明码凭据，记录取舍：不打码
    expect(redactSecrets('fetch https://user@example.com/path')).toBe(
      'fetch https://user@example.com/path',
    );
  });

  it('可配置：自定义 pattern 追加生效', () => {
    const r = redactSecrets('hello SECRET-1234 there', {
      patterns: [{ type: 'internal-id', regex: /SECRET-1234/g }],
    });
    expect(r).toBe('hello [REDACTED:internal-id] there');
  });

  it('可配置：同 type 覆盖默认（更宽阈值生效）', () => {
    const shortGhp = 'ghp_' + 'a'.repeat(10); // 默认 {20,} 不命中
    expect(redactSecrets(shortGhp)).toBe(shortGhp);
    const r = redactSecrets(shortGhp, {
      patterns: [{ type: 'github-token', regex: /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g }],
    });
    expect(r).toBe('[REDACTED:github-token]');
  });

  it('可配置：guard 返回 false 时不打码（自定义口径）', () => {
    const r = redactSecrets('id=PWD-AB12-CONSOLE', {
      patterns: [
        { type: 'internal', regex: /PWD-[A-Z0-9-]+/g, guard: (m) => !m.includes('CONSOLE') },
      ],
    });
    expect(r).toBe('id=PWD-AB12-CONSOLE');
  });
});

describe('redactSecrets：性能粗测（切片 e，不设严格基准）', () => {
  it('1MB 长文本（含点缀凭据）线性完成', () => {
    const lines: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      if (i % 999 === 0) {
        lines.push(`const cfg${i} = "${GITHUB_TOKEN}"`);
      } else {
        lines.push(
          `const v${i} = ${JSON.stringify(
            `framework? no: level ${i} but kept plain and code-y ` +
              '--padding for an ordinary 100-byte line lorem ipsum dolor sit amet',
          )};`,
        );
      }
    }
    const big = lines.join('\n');
    expect(big.length).toBeGreaterThan(1_000_000);

    const start = performance.now();
    const out = redactSecrets(big);
    const elapsed = performance.now() - start;
    // 量级说明见汇报：纯正则单遍扫描，100 行内遇到 10 个 ghp_ 全长命中
    expect(out).toContain('[REDACTED:github-token]');
    expect((out.match(/\[REDACTED:github-token\]/g) ?? []).length).toBeGreaterThan(5);
    expect(elapsed).toBeLessThan(2_000); // 宽松上限：只断言「不灾难」
  });

  it('超长单字符运行（base64/填充文本——100KB+ 同字符）不灾难：url 模式回溯有界（VT-3/VT-1 落盘点）', () => {
    // 存储层脱敏（jsonl-file.ts）对每次 tool 落盘都跑 redactSecrets——工具结果常含
    // 大段单一字符运行；旧 regex `[a-zA-Z0-9+.-]*://` 贪婪无界 → O(n²)（100KB 5.7s）。
    const run = 'x'.repeat(150 * 1024);
    const start = performance.now();
    const out = redactSecrets(run);
    const elapsed = performance.now() - start;
    expect(out).toBe(run); // 无凭据：内容原样（幂等/无损伤）
    expect(elapsed).toBeLessThan(1_000);
  });
});

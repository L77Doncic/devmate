/**
 * # ui/web：原生 Web UI（零依赖、零构建）
 *
 * 零依赖原生 HTML/CSS/ES Modules，作为内置静态资源由与 core 同进程的 local server
 * 提供（ADR-0007）：事件经 HTTP SSE 推流到浏览器，UI 只是会话（Session）的一个视图。
 *
 * 入口是原生脚本 `./app.js`（浏览器直接执行，不走 tsc 编译），与同目录的
 * `index.html` / `style.css` / `sse.js` / `markdown.js` / `messages.js` /
 * `settings.js` / `format.js` 一起作为静态文件发布；本文件仅保留 tsc 骨架占位，
 * headless/CI 模式永不加载整个目录。
 *
 * 设计/测试说明见 ./README-UI.md；纯逻辑模块在 test/ui-web/*.test.ts 有单测。
 */
export {};

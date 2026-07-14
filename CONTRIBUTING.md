# 贡献指南

感谢你关注 RLog。RLog 是一个零运行时依赖的 Node.js TypeScript 日志与流捕获库；提交时请优先保证日志顺序、资源关闭和错误交付的可预测性。

## 开发环境

- Node.js 20 或更高版本（与 `package.json` 的 `engines` 一致）。
- npm（使用随 Node.js 提供的版本即可）。
- Git。

克隆仓库后执行：

```bash
npm ci
npm run build
npm test
```

`npm ci` 使用锁文件进行干净安装；不要在没有必要时修改 `package-lock.json`。本项目不使用运行时第三方依赖。如确需引入依赖，请在提交说明中解释它无法由 Node.js 内置模块替代的原因。

## 提交改动

1. 先阅读相关实现和已有测试，避免把已稳定的生命周期语义改回去。
2. 保持改动范围聚焦；不要顺手重排无关代码或删除用户已有功能。
3. 为行为变化补充 `node:test` 回归用例。新增测试文件会被 `node --test` 自动发现。
4. 同步更新 README 和对应的 `docs/` 中文文档。破坏性改动必须说明迁移方式。
5. 使用清晰、简短的提交信息，例如 `fix: 修复 Capture 关闭时的数据遗漏`。

提交前至少执行：

```bash
npm run build
npm test
npm pack --dry-run
git diff --check
```

涉及覆盖率或发布前核验时，再执行：

```bash
npm run test:coverage
```

## 代码与兼容性约束

- 保持 CommonJS 使用方式 `const Rlog = require("rlog-js")`，并保持 TypeScript 默认导入可用。
- 类型声明与运行时导出必须一致。新增命名导出时，需同时验证 CommonJS 运行时和 TypeScript 消费项目。
- 根 Logger、`screen`、`text`、`jsonl` facade 的等级方法必须维持统一的 console 风格 `...args` 语义。
- `rlog.file` 是 `rlog.text` 的兼容别名；新 API 使用 `text`，不要在新文档或示例中推荐 `file`。
- `at(timestamp)` 是唯一的显式时间 API。等级方法的第二个参数必须始终是普通日志参数。
- JSONL 的基础字段、schema 和版本是对机器消费者的契约。修改字段名、语义或序列化方式前，必须评估迁移影响并补充测试。

## 文件、Capture 与生命周期

这些模块容易出现跨平台和竞态问题，修改时请特别留意：

- 文件操作必须经过受控的串行队列；`flush()` 与 `close()` 必须等待此前写入和轮转。
- Windows 上必须先关闭文件流再重命名。轮转测试不得因操作系统而跳过。
- 文件错误须遵循 `fileErrorPolicy`，且不能让一个失败目标阻断其他目标。
- Capture 不拥有调用者的子进程；关闭 Logger 或 Capture 默认不能杀死被捕获进程。
- Capture 需要正确处理 UTF-8 跨 chunk、未换行尾行、背压、长行上限、取消和已接受队列的收尾。
- 慢 Writable、回调错误与 `error` 事件不能产生未处理 rejection、未处理 error 或 listener 泄漏。

对这些区域的改动应补充相应回归测试，并在 Windows 兼容路径、并发写入或关闭竞态上至少覆盖一种边界情况。

## 文档与发布

README 和 `docs/` 中的正式说明使用中文，代码、配置名、错误码和 API 名称保留原样。Capture 文件可能包含敏感外部输出，任何新增示例都应说明安全边界。

仓库不维护 `CHANGELOG.md`。每次正式版本的用户可见变更、破坏性变更、迁移说明和 Node.js 版本要求写入对应 GitHub Release 正文。发布前应确认：

```bash
npm ci
npm run build
npm test
npm run test:coverage
npm pack --dry-run
```

GitHub Actions 会在 Ubuntu、Windows、macOS 的 Node.js 20 与 22 上运行构建、测试和打包核验；Ubuntu Node.js 24 为实验矩阵。npm 发布和 GitHub Release 创建是独立操作，必须获得明确授权后再执行。

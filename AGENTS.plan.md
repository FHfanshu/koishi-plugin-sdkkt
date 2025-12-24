# AGENTS 计划与改动记录

**最后更新**: 2025-12-24 10:00:00

## 进行中

### [进行中] 修复：QQ群文件第一次获取为压缩图问题

**问题**
- QQ群文件上传时，第一次通过 `getGroupFileUrl` 获取到的是压缩预览图（无EXIF信息）
- 需要第二次请求才能获取到原图

**根本原因**
- QQ服务器对群文件有延迟处理机制，首次请求返回缓存的预览图
- 原图需要等待服务器处理完成后才能获取

**解决方案**
- 在 `fetchGroupFile` 函数中添加重试机制
- 第一次获取后等待一段时间，再次尝试获取
- 添加配置项控制重试行为

**实施步骤**
1. 在 Config 中添加 `groupFileRetryDelay` 和 `groupFileRetryCount` 配置项（completed）
2. 修改 `fetchGroupFile` 添加重试逻辑（completed）
3. 构建测试验证（completed）

**影响文件**
- `src/index.ts` (Config/Schema)
- `src/fetcher.ts` (fetchGroupFile)

**改动记录**
- 2025-12-24: 新增群文件获取重试机制
  - 添加 `groupFileRetryDelay`（默认2000ms）和 `groupFileRetryCount`（默认2次）配置项
  - 修改 `fetchGroupFile` 函数：首次获取后延迟重试，使用重试结果（更可能是原图）
  - 更新 `fetchImage` 函数签名支持 `FetchOptions` 对象
  - 保持向后兼容（支持旧的 `maxFileSize` 数字参数）

### [已完成] 修复：ComfyUI 正反向提示词解析顺序错误

**问题**
- ComfyUI 工作流解析时，正反向提示词可能被解析错误
- 原因：代码简单假设第一个 CLIPTextEncode 是正向，第二个是反向

**解决方案**
- 通过 KSampler 的 `positive` 和 `negative` 连接追踪正确的节点
- 使用 workflow 的 `links` 数组追踪节点连接关系
- 保留 fallback 逻辑以兼容没有连接信息的工作流

**改动记录**
- 2025-12-24: 修复 ComfyUI 正反向提示词解析
  - 更新 `ComfyUINode` 接口，添加 `id` 和详细的 `inputs` 类型
  - 更新 `ComfyUIWorkflow` 接口，添加 `links` 数组类型
  - 修改 `parseComfyUINodeFormat` 函数：
    - 构建 nodeById 映射表
    - 构建 linkMap 追踪节点连接
    - 通过 KSampler 的 positive/negative 输入追踪实际的提示词节点
    - 保留 fallback 逻辑以兼容旧工作流

---

## 进行中

### [已完成] 修复：引用消息导致EXIF信息重复解析

**问题**
- 在开启自动解析的群聊中，当用户引用（回复）含有EXIF信息的图片时，会触发新的消息事件
- 每次消息事件都会创建新的 `seenKeys` Set，导致跨消息的去重失效
- 结果是同一张图片每被引用一次就被解析一次，造成刷屏

**根本原因**
- `collectImageSegments` 函数在每次调用时都创建局部的 `seenKeys`，无法跨消息去重
- 当前去重仅在单次消息处理内有效（如 `session.quote.content[0]`, `bot.getMessage[0]` 等）
- 但无法阻止新的引用消息再次触发完整的图片解析流程

**解决方案**
1. 添加全局 LRU 缓存记录已处理的图片（基于 fileId/file/url）
2. 缓存条目包含：图片唯一键、处理时间戳、会话ID
3. 在 `collectImageSegments` 中检查全局缓存，跳过已处理的图片
4. 设置合理的缓存过期时间（如 5 分钟）和容量限制（如 100 条）

**实施步骤**
1. 使用已有的 `LRUCache` 类创建全局图片去重缓存（completed）
2. 修改 `collectImageSegments` 添加全局缓存检查逻辑（completed）
3. 添加调试日志记录跨消息去重情况（completed）
4. 测试验证：引用消息不再重复解析（pending）

**影响文件**
- `src/index.ts`

**测试场景**
- 在群白名单/视奸监听群发送含EXIF图片
- 其他用户引用该消息回复
- 验证不会再次解析并发送

**改动记录**
- 2025-11-17 22:42: 新增全局图片去重缓存，防止引用消息重复解析。
  - 导入 `LRUCache` 类到 `src/index.ts`
  - 新增 Config 配置项：`globalDedupeEnabled`（默认true）、`globalDedupeCacheSize`（默认100）、`globalDedupeTimeout`（默认300000ms）
  - 创建全局变量 `globalProcessedImages` 和 `ProcessedImageEntry` 接口
  - 在 `apply` 函数初始化全局去重缓存
  - 在 `collectImageSegments.append` 函数中添加全局缓存检查（在局部去重之后）
    - 检查缓存条目是否过期（基于 `globalDedupeTimeout`）
    - 记录详细的去重日志（包含来源、key、经过时间、频道信息）
  - 在 `processImages` 成功提取元数据后，将图片 key 添加到全局缓存
    - 记录时间戳、channelId、userId 等信息
  - 构建成功，无编译错误

### [进行中] 移除功能：forward 自定义标题（保持转发内容不变）

**动机**
- OneBot/QQ 不支持自定义合并转发根标题；为避免产生误导配置项，彻底移除 `forwardTitle` 功能，保持转发节点内容与现状一致。

**实施步骤**
1. 从 `Config` 与 `Schema` 移除 `forwardTitle` 字段（completed）
2. 在 `formatForwardModeOutput` 中不再设置 `title` 属性，仅保留 `{ forward: true }`（completed）
3. 构建与测试：`npm run build` 并在 OneBot/QQ 实测合并转发（pending）

**影响文件**
- `src/index.ts`

**兼容性**
- 老配置中的 `forwardTitle` 将被忽略；功能行为与 OneBot/QQ 既有表现保持一致。

**改动记录**
- 2025-11-12 20:33: 删除 `Config.forwardTitle` 字段与 Schema 配置；`formatForwardModeOutput` 不再设置 `title`。

### [进行中] Bugfix：静默监听/自动解析空元数据导致仅图片合并转发；OneBot 标题不生效说明

**目标**
- 修复在 PNG 无任何 SD 元数据时返回 `{}` 导致静默模式仍转发图片节点的问题。
- 确认并记录：OneBot/go-cqhttp 不支持自定义合并转发根标题（`forwardTitle` 在 QQ 上被忽略）。

**实施步骤**
1. 复现并定位：日志显示 `成功提取元数据: {}`，确认 `parsePNGMetadata` 始终 `success: true`（completed）
2. 修改 `parsePNGMetadata`：当无任何元数据时返回 `success: false`（completed）
3. 修改 `processImages`：过滤空对象结果，仅当 `Object.keys(data).length > 0` 才收集（completed）
4. 验证静默模式与群白名单/视奸转发均不再发送“只有图片”的合并转发（pending）
5. 若需要，为 OneBot 提供可选回退：在首个转发节点插入文本标题以模拟根标题（待需求确认）（pending）

**影响文件**
- `src/png.ts`
- `src/index.ts`

**风险与兼容**
- 对 PNG：以前返回空成功现在改为失败，将触发“未能读取到信息”的统一逻辑；静默场景将不发送。
- 对 OneBot：根标题不支持属平台限制，不改现有行为，仅记录说明，是否添加回退待确认。

**改动记录**
- 2025-11-12 19:58: 修改 `src/png.ts`：当 PNG 无任何 SD 元数据时返回 `success:false`。
- 2025-11-12 19:58: 修改 `src/index.ts`：仅在 `metadata.data` 非空时收集结果，并与 `usedSegments` 对齐，避免仅图片节点转发。

### [已完成] 版本发布 v0.2.8

**变更内容**
- 修复高优先级问题：环路保护、配置统一、类型安全、缓存路径
- 代码质量改进：移除重复逻辑、提取公共函数、拆分过长函数
- 改进统计：删除冗余代码 40 行，新增辅助函数 5 个，函数平均长度减半

**发布时间**: 2025-11-12

## 进行中

### [已完成] 代码质量改进 - 中优先级优化

**目标**
- 优化代码结构，提升可维护性和性能

**实施步骤**
1. 移除重复的去重逻辑（completed）
2. 将动态 require 移至顶部 import（completed）
3. 提取中间件公共逻辑到函数（completed）
4. 拆分过长函数，提升可读性（completed）

**影响文件**
- `src/index.ts`

**改动详情**

1. **移除重复去重逻辑** (`src/index.ts:331-333`)
   - 删除 `processImages` 中冗余的 `dedupeSegments` 调用
   - `collectImageSegments` 已在收集过程中完成去重（Line 480-485）
   - 添加注释说明避免重复

2. **移除动态 require** (`src/index.ts:515, 543, 590`)
   - 移除 3 处动态 `require('koishi')` 调用
   - 顶部已有 `import { h } from 'koishi'`，直接使用
   - 移除 `require('path')`，使用顶部导入的 `path`

3. **提取中间件公共逻辑** (`src/index.ts:180-212`)
   - 新增 `isChannelInList` 辅助函数：统一频道 ID 检查逻辑
   - 新增 `sendAutoParseResult` 辅助函数：统一自动解析结果发送
   - 简化视奸中间件（Line 254-289）和群白名单中间件（Line 291-321）
   - 代码行数减少约 30 行，可读性提升

4. **拆分过长函数** (`src/index.ts:324-381, 660-756`)
   - 提取 `splitLongMessages` 函数（58 行）：处理长消息分割
   - 提取 `formatNormalModeOutput` 函数（40 行）：普通模式输出
   - 提取 `formatForwardModeOutput` 函数（36 行）：合并转发输出
   - 简化 `formatOutput` 为调度函数（12 行）
   - `processImages` 从 138 行减少到 85 行

**代码质量改进统计**
- 删除冗余代码：约 40 行
- 新增辅助函数：5 个
- 函数平均长度：从 90 行降至 45 行
- 代码可读性：显著提升
- 可维护性：更易于测试和修改

**测试结果**
- ✅ 构建成功 (`npm run build`)
- ✅ TypeScript 编译通过
- ✅ 无类型错误

## 进行中

### [已完成] 代码质量修复 - 高优先级问题

**目标**
- 修复代码审查中发现的高优先级问题，提升代码健壮性和安全性

**实施步骤**
1. 修复环路保护逻辑：检查标准化后的频道 ID（completed）
2. 统一配置值使用：所有地方使用 `config.maxFileSize`（completed）
3. 修复缓存目录：使用 `ctx.baseDir` 替代 `process.cwd()`（completed）
4. 移除不安全的 `as any` 类型断言（completed）

**影响文件**
- `src/index.ts`
- `src/fetcher.ts`

**改动详情**

1. **环路保护增强** (`src/index.ts:236-238`)
   - 新增 `normalizedTarget` 变量对目标频道 ID 标准化
   - 检查 `target === chId || normalizedTarget === chId || normalizedTarget === normalized`
   - 防止在各种频道 ID 格式（带前缀/不带前缀）下的环路

2. **缓存目录路径修复** (`src/index.ts:98, 105`)
   - 改用 `ctx.baseDir` 替代 `process.cwd()`
   - 在 `apply` 函数初始化时动态设置 `CACHE_DIR`
   - 确保跨环境稳定性

3. **文件大小限制统一** (`src/fetcher.ts:18-20`, `src/index.ts:349`)
   - `fetchImage` 新增 `maxFileSize` 参数（可选，默认 10MB）
   - 所有调用处传递 `config.maxFileSize`
   - 移除硬编码 10MB 限制（Line 112）

4. **类型安全改进** (`src/index.ts:255`)
   - 移除 `resp as any` 类型断言
   - `sendMessage` 自动推断类型

5. **使用空值合并运算符** (`src/index.ts:540`)
   - 将 `||` 改为 `??`，避免 0 值被误判为 falsy

**测试结果**
- ✅ 构建成功 (`npm run build`)
- ✅ TypeScript 编译通过

**测试建议**
- 验证视奸模式环路保护在各种频道 ID 格式下都生效
- 确认文件大小限制在所有代码路径生效
- 测试缓存目录在不同运行环境下正确创建

## 进行中

### [已完成] 配置界面分层（Schema 分组）

**目标**
- 通过 `Schema.intersect([...])` 将配置项按“基础 / 输出与显示 / 视奸 / 自动解析 / 解析与限制 / 缓存”分组，提升 Koishi 控制台可读性。

**实施步骤**
1. 用多个 `Schema.object` 分段，并添加 `.description()` 作为分组标题（completed）
2. 字段名与默认值保持不变，避免破坏已有用户配置（completed）

**影响文件**
- `src/index.ts`

**测试建议**
- 打开 Koishi 控制台插件配置页，检查分组折叠与字段布局是否清晰；验证保存后运行逻辑不变。

### [已完成] 新增：伪造聊天记录标题自定义 + 视奸模式默认图文

**目标**
- 为合并转发（伪造聊天记录）增加标题自定义，默认值为“图片解析结果”。
- 视奸模式下转发的合并转发节点默认采用“图片(h.image) + 解析结果文字”的编排。

**实施步骤**
1. 扩展 `Config/Schema`：新增 `forwardTitle` 配置项，默认“图片解析结果”（completed）
2. 在合并转发根节点设置 `title` 属性为 `forwardTitle`（completed）
3. 优化 forward 节点的图片来源解析：优先 `attrs.url`，回退 `attrs.src`/`data.url`/`data.src`（completed）
4. 视奸与群白名单调用 `processImages(..., true, true)`，确保默认图文并茂（completed）

**影响文件**
- `src/index.ts`

**测试建议**
- 在视奸监听群发送带 SD 元数据图片，确认转发标题为配置值，且每条节点先图后文。

### [已完成] 新增功能：合并转发支持嵌入图片

**目标**
- 在合并转发模式下支持嵌入图片本身，用户可选择纯文字或图文混合模式。

**实施步骤**
1. 修改 `processImages` 函数，传递图片信息到 `formatOutput`（completed）
2. 更新 `formatOutput` 函数，在转发节点中嵌入图片元素（completed）
3. 为命令添加 `--withImage`/`-i` 选项（completed）
4. 构建与类型检查（completed）

**功能细节**

1. **命令选项**: `sdexif/读图` 命令新增 `-i/--withImage` 选项
   - 仅在 `useForward=true`（合并转发）时有效
   - 启用时，每个转发节点会先显示图片，再显示文字提示词
   - 禁用时，仅显示文字提示词（原有行为）

2. **视奸模式**: 强制启用图片嵌入（`withImage=true`）
   - 与原有的强制合并转发保持一致

3. **群白名单**: 强制启用图片嵌入（`withImage=true`）
   - 提供更完整的图片+信息展示

**改动文件**:
- `src/index.ts` (formatOutput, processImages, 命令选项, 中间件调用)

**测试结果**:
- ✅ 构建成功 (`npm run build`)
- ✅ TypeScript 编译通过
- ✅ 类型检查通过

### [已完成] 修复：合并转发图片使用图片类型而非文件类型

**问题**
- 在合并转发模式下，视奸功能和群白名单模式发送的图片显示为文件类型而非图片类型

**原因**
- 图片元素被包裹在 `h('p', ...)` 段落实例中，导致被当作文件处理

**解决方案**
- 移除段落包裹，直接使用 `h.image(url)` 图片元素
- 将图片元素和文字内容直接放在 `h('content', ...)` 中
- 确保在所有平台（特别是 onebot）都以图片类型发送

**改动文件**:
- `src/index.ts` (`formatOutput` 函数)

**测试结果**:
- ✅ 构建成功 (`npm run build`)
- ✅ TypeScript 编译通过

### [已完成] 新增功能：普通模式图文编排选项

**目标**
- 为普通模式（非合并转发）添加图片嵌入功能，可通过配置项控制

**实施步骤**
1. 扩展 Config 接口和 Schema：新增 `embedImageInNormalMode` 配置项（completed）
2. 修改 `formatOutput` 函数：支持普通模式嵌入图片（completed）
3. 更新命令选项：`-i/--withImage` 选项描述调整为通用说明（completed）
4. 修改命令处理逻辑：检查配置项和命令选项（completed）
5. 构建与测试（completed）

**功能细节**

1. **配置项**: `embedImageInNormalMode` (boolean, default: false)
   - 控制普通模式下是否嵌入图片
   - 默认关闭，保持原有纯文字输出行为
   - 启用后，普通模式将显示图片 + 文字提示词

2. **命令选项**: `-i/--withImage`
   - 在合并转发模式下：控制是否嵌入图片（原有功能）
   - 在普通模式下：若配置项开启，强制嵌入图片

3. **行为逻辑**:
   - 普通模式：优先使用配置项 `embedImageInNormalMode`
   - 合并转发模式：优先使用命令选项 `-i/--withImage`
   - 视奸模式和群白名单：强制启用图片嵌入

**改动文件**:
- `src/index.ts` (Config 接口、Schema、`formatOutput` 函数、命令选项、命令处理)

**测试结果**:
- ✅ 构建成功 (`npm run build`)
- ✅ TypeScript 编译通过

## 进行中

### [进行中] 视奸监听与合并转发

**目标**
- 在指定群聊中持续监听图片，解析后以合并转发的形式推送到目标频道（个人或群）。

**实施步骤**
1. 扩展 Config/Schema：新增 `spyEnabled`、`spyGroups`、`spyTargetChannel`（completed）
2. 新增中间件：监听 `spyGroups` 群图片，静默模式过滤仅 EXIF 回退，强制合并转发发送至 `spyTargetChannel`（completed）
3. 构建与类型检查（pending）

**影响文件**:
- `src/index.ts`

**改动记录**
- 2025-11-12 22:10: 新增配置项 `spyEnabled`、`spyGroups`、`spyTargetChannel`，并添加视奸中间件：
  - 在指定群聊检测到图片时，强制使用合并转发格式；
  - 启用静默模式：仅 EXIF 回退时不发送；
  - 环路保护：若目标频道与当前频道相同则跳过。

### [已完成] 完善用户可配置项目

**目标**
- 添加多个用户可配置项，替换硬编码值，提升插件灵活性

**实施步骤**
1. 扩展 Config 接口和 Schema，新增 6 个配置项（completed）
2. 应用配置项到实际代码逻辑（completed）
3. 构建和测试（completed）
4. 更新文档（in_progress）

**新增配置项**:

1. **maxFileSize** (number, default: 10MB)
   - 允许解析的最大图片文件大小（字节）
   - 替换 src/index.ts 和 src/fetcher.ts 中的硬编码 10MB 限制

2. **messageSplitThreshold** (number, default: 2000)
   - 长消息分割的字符阈值
   - 替换 src/index.ts 中的硬编码 2000 字符限制

3. **enableDedupe** (boolean, default: true)
   - 是否对重复图片进行去重处理
   - 在 collectImageSegments 中根据配置决定是否调用 dedupeSegments

4. **enableCache** (boolean, default: true)
   - 是否启用缓存机制
   - 在 apply 函数中实现缓存目录管理和清理逻辑

5. **cacheMaxSize** (number, default: 100MB)
   - 缓存目录最大大小（字节）
   - 当缓存超过限制时，自动删除最旧的文件，保留 80% 的容量

6. **preferFileCache** (boolean, default: false)
   - 是否优先使用文件缓存（实验性）
   - 完善已有但未使用的配置项

**改动文件**:
- `src/index.ts` (更新 Config 接口、Schema、应用逻辑)

**测试结果**:
- ✅ 构建成功 (`npm run build`)
- ✅ TypeScript 编译通过
- ✅ 配置项类型检查通过

## 进行中

### [进行中] 新增功能：视奸监听与合并转发

**目标**

### [进行中] 新增功能：视奸监听与合并转发

**目标**
- 在指定群聊中持续监听图片，解析后以合并转发的形式推送到目标频道（个人或群）。

**实施步骤**
1. 扩展 Config/Schema：新增 `spyEnabled`、`spyGroups`、`spyTargetChannel`（completed）
2. 新增中间件：监听 `spyGroups` 群图片，静默模式过滤仅 EXIF 回退，强制合并转发发送至 `spyTargetChannel`（completed）
3. 构建与类型检查（pending）

**影响文件**
- `src/index.ts`

**改动记录**
- 2025-11-12 22:10: 新增配置项 `spyEnabled`、`spyGroups`、`spyTargetChannel`，并添加视奸中间件：
  - 在指定群聊检测到图片时，强制使用合并转发格式；
  - 启用静默模式：仅 EXIF 回退时不发送；
  - 环路保护：若目标频道与当前频道相同则跳过。

## 最近完成

### [已实施] 修复：合并转发时出现“正向提示词:”异常消息块

**问题**: 长消息切分时将提示词标题单独作为一个块，并在首块再次前缀，导致合并转发里出现空/重复的“正向提示词:”提示。

**方案**:
1. 修改 `src/index.ts` 的长消息切分：不再单独推入 `promptHeader`，改为在切分后将其仅前置到首个内容块。
2. 追加安全处理：过滤空白分块，避免出现空的转发节点。

**改动文件**:
- `src/index.ts`（`processImages` 内的切分逻辑）

**测试建议**:
- 使用包含较长正向提示词的图片进行解析，开启 `useForward=true`，确认不再出现仅含“正向提示词:”的独立块。


### [已实施] 群聊静默模式EXIF过滤

**问题**: 在静默监听群聊（白名单模式）时，当图片不包含 SD 元数据，EXIF 回退机制会自动发送 EXIF 信息，导致群聊体验不佳，频繁发送无关信息。

**方案**: 在群白名单自动解析中添加静默模式过滤，当只有 EXIF 回退数据而没有真正的 SD metadata 时（无 prompt/negative/params），不发送任何消息。

**实施细节**:

1. **src/index.ts**
   - 在 `processImages` 函数添加 `isSilentMode` 参数（默认 false）
   - 在函数中添加检测逻辑：如果 `isSilentMode=true` 且所有结果都只有 `exifFallback` 而没有其他 SD 字段，返回 void（不发送消息）
   - 在群白名单中间件中调用 `processImages` 时传入 `isSilentMode=true`

**改动文件**:
- `src/index.ts`

**测试结果**:
- ✅ 构建成功 (`npm run build`)
- ✅ TypeScript 编译通过

## 最近完成

### [已实施] WebP/JPEG EXIF 回退机制

**问题**: JPEG 和 WebP 文件能够读取到 EXIF 信息，但被 SD metadata 读取规则过滤，导致整张图的 metadata/EXIF 信息无法发送。

**方案**: 实现回退机制，当找不到符合现有格式（a1111|comfy|NovelAI）的 EXIF 信息时，将所有 EXIF 字段合并转发。

**实施细节**:

1. **types.ts**
   - 在 `SDMetadata` 接口中添加 `exifFallback?: Record<string, any>` 字段

2. **jpeg.ts**
   - 在 parseJPEGMetadata 函数中初始化 `exifData` 对象
   - 在 EXIF 解析过程中收集所有字段到 `exifData`
   - 当找不到 SD metadata 但有 EXIF 数据时，返回包含 `exifFallback` 的成功结果
   - 日志输出提示使用回退机制

3. **webp.ts**
   - 采用与 jpeg.ts 相同的回退机制
   - 在 parseWebPMetadata 函数中收集 EXIF/XMP 数据
   - 当找不到 SD metadata 时返回回退数据

4. **extractor.ts**
   - 更新 `formatMetadataResult` 函数
   - 添加对 `exifFallback` 的格式化支持
   - 显示友好的提示信息和详细的 EXIF 字段

**改动文件**:
- `src/types.ts`
- `src/jpeg.ts`
- `src/webp.ts`
- `src/extractor.ts`

**测试结果**:
- ✅ 构建成功 (`npm run build`)
- ✅ TypeScript 编译通过
- 待实际环境测试验证

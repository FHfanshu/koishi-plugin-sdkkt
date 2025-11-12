# koishi-plugin-sdkkt

[![npm](https://img.shields.io/npm/v/koishi-plugin-sdkkt?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-sdkkt)

读取 Stable Diffusion 生成图片中的 EXIF 信息（prompt、参数等）的 Koishi 插件。

## 功能特性

- 🖼️ 读取 Stable Diffusion 生成图片的元数据
- 📁 **新增：支持群文件图片自动解析**
- 📝 支持多种 SD 格式：
  - AUTOMATIC1111 WebUI
  - NovelAI
  - ComfyUI
- 🖼️ 支持多种图片格式：PNG、WebP、JPEG/JPG
- 💬 支持普通消息和合并转发两种发送格式
- 🔧 简单易用的配置
- 🐞 调试日志功能，方便排查问题

## 安装

```bash
# 使用 npm
npm install koishi-plugin-sdkkt

# 使用 yarn
yarn add koishi-plugin-sdkkt

# 使用 pnpm
pnpm add koishi-plugin-sdkkt
```

## 使用方法

### 基本用法

1. 在 Koishi 中启用本插件
2. 发送包含 `sdexif` 或 `读图` 指令的消息，并附带图片
3. Bot 会自动解析并返回图片中的 Stable Diffusion 信息

### 群文件图片自动解析

**新增功能**：当用户在群聊中上传图片文件时，插件可以自动检测并解析，无需发送命令！

#### 配置方法
在插件配置中添加群白名单：
```json
{
  "groupAutoParseWhitelist": ["123456", "789012"]
}
```

#### 使用条件
- 群聊必须在白名单中
- 文件大小 ≤ 10MB
- 支持的图片格式：JPG、PNG、WebP、GIF、BMP、TIFF、HEIC、HEIF
- 非图片文件自动跳过

### 示例

```
sdexif [图片]
```

或者

```
读图 [图片]
```

### 输出示例

```
正向提示词:
masterpiece, best quality, 1girl, solo, beautiful

负向提示词:
lowres, bad anatomy, bad hands, text, error

参数:
Steps: 20
Sampler: Euler a
CFG Scale: 7
Seed: 123456789
Size: 512x768
Model: AnythingV5
```

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| useForward | boolean | false | 是否使用合并转发格式发送消息 |
| enableDebugLog | boolean | false | 是否启用调试日志（用于排查图片接收问题） |
| privateOnly | boolean | false | 是否仅在私聊中启用 |
| groupAutoParseWhitelist | string[] | [] | **新增**：群聊白名单，在这些群聊中自动解析群文件图片（无需命令） |
| preferFileCache | boolean | false | **新增**：是否优先使用文件缓存（默认使用内存Buffer，性能更好） |

### useForward 说明

- `false`：以普通文本消息形式发送，适合单个或少量图片
- `true`：使用合并转发格式，适合多张图片或内容较长的情况

### enableDebugLog 说明

- `false`：正常运行模式，只输出警告和错误信息
- `true`：启用详细调试日志，包括：
  - 接收到的消息详情（平台、频道、用户、内容）
  - 消息元素分析（元素类型、数量、图片元素详情）
  - 图片 URL 提取过程
  - HTTP 请求和响应详情
  - PNG 格式验证
  - 元数据提取过程

**建议**：当遇到图片接收问题（特别是 QQ OneBot 平台）时，启用此选项以获取详细的调试信息，帮助定位问题。

### preferFileCache 说明

- `false`（默认）：直接使用内存 Buffer 处理图片，性能更好，适合大多数情况
- `true`：优先使用临时文件缓存，适合内存受限的环境或大文件处理

**建议**：保持默认 `false` 即可，除非遇到内存不足的问题。

## 支持的格式

### 图片格式

- **PNG**：完整支持，通过 PNG text chunks 读取元数据
- **WebP**：支持，通过 EXIF/XMP 数据读取元数据
- **JPEG/JPG**：支持，通过 EXIF/XMP 数据读取元数据

### SD 工具格式

#### AUTOMATIC1111 WebUI

完整支持 A1111 WebUI 生成的图片，包括：
- Prompt（正向提示词）
- Negative Prompt（负向提示词）
- Steps（步数）
- Sampler（采样器）
- CFG Scale（提示词相关性）
- Seed（种子）
- Size（尺寸）
- Model（模型）

#### NovelAI

支持 NovelAI 生成的图片格式。

#### ComfyUI

支持 ComfyUI 的 workflow 格式，会尝试提取：
- Prompt
- Negative Prompt
- 采样参数

## 注意事项

1. 支持 PNG、WebP、JPEG/JPG 格式的图片
2. 只能读取包含元数据的图片（未经压缩或转换）
3. 如果图片被社交平台压缩，可能会丢失元数据：
   - PNG 格式：压缩后通常会丢失 text chunks
   - WebP/JPEG 格式：压缩后可能保留 EXIF 数据，但也可能被移除
4. 图片下载有 30 秒超时限制
5. 建议使用原图以获取最佳结果

## 常见问题

### Q: 为什么读取不到信息？

A: 可能的原因：
- 图片被压缩或转换，丢失了元数据
- 图片不是由 Stable Diffusion 生成的
- 图片格式不在支持范围内（仅支持 PNG/WebP/JPEG）
- 对于 WebP/JPEG 格式，SD 工具可能没有将参数写入 EXIF 数据

### Q: 支持哪些平台的图片？

A: 理论上支持所有可以通过 URL 访问的图片，但需要注意：
- QQ/微信等平台会压缩图片，建议使用原图
- 某些平台的图片可能有防盗链限制
- PNG 格式的元数据保存最完整，WebP/JPEG 可能会在传输过程中被移除 EXIF 数据

### Q: QQ OneBot 平台收不到图片怎么办？

A: 请按以下步骤排查：

1. **启用调试日志**：在插件配置中将 `enableDebugLog` 设置为 `true`
2. **发送测试消息**：发送 `sdexif` 或 `读图` 命令并附带图片
3. **查看日志输出**：检查 Koishi 控制台的日志，重点关注：
   - `收到消息` - 确认消息被接收
   - `消息元素分析` - 查看 `elementTypes` 数组中是否包含 `img` 或 `image` 类型
   - `imageElementDetails` - 查看图片元素的 `attrs` 属性，确认是否有 `src` 或 `url` 字段
4. **常见问题**：
   - 如果 `elementTypes` 为空或不包含图片类型，可能是 OneBot 适配器的问题
   - 如果图片元素存在但 `attrs` 中没有 URL，可能需要检查 OneBot 协议版本
   - 如果有 URL 但下载失败，可能是网络或权限问题

5. **反馈问题**：如果以上步骤无法解决，请将调试日志提供给开发者

## 开发

```bash
# 克隆项目
git clone https://github.com/yourusername/koishi-plugin-sdexif.git

# 安装依赖
npm install

# 构建
npm run build
```

## 相关项目

- [stable-diffusion-inspector](https://github.com/Akegarasu/stable-diffusion-inspector) - 参考项目

## 许可证

MIT License

## 更新日志

### 1.2.0 (2025-11-11)

- 📁 **新增群文件图片自动解析功能**
  - 支持监听群文件上传事件
  - 自动检测 10MB 以下的图片文件
  - 支持的格式：JPG、PNG、WebP、GIF、BMP、TIFF、HEIC、HEIF
  - 通过 `groupAutoParseWhitelist` 配置启用
  - 无需发送命令，自动解析并发送结果
- 🔧 增强文件处理能力
  - 改进 `collectImageSegments` 函数，支持群文件事件
  - 增强 `fetchImageBuffer` 函数，支持群文件下载
  - 集成 OneBot `get_group_file_url` 接口调用
- 🛡️ 安全限制
  - 10MB 文件大小限制，防止内存溢出
  - 非图片文件自动跳过
  - 完善的错误处理和日志记录

### 1.1.1 (2025-11-10)

- 🔧 **[重要修复]** 修复 PNG 元数据读取问题
  - 实现手动 PNG chunks 解析（tEXt、iTXt、zTXt）
  - 修复 `pngjs` 库默认不解析文本块的问题
  - 支持更多 AI 图片生成工具的元数据格式
  - 提升 PNG 图片的元数据提取成功率
- 📝 详细修复说明请查看 [FIX_NOTES.md](FIX_NOTES.md)

### 1.1.0

- 🎉 新增多格式图片支持：PNG、WebP、JPEG/JPG
- 🐞 新增调试日志功能（`enableDebugLog` 配置项）
- 🔧 改进图片格式检测机制
- 📝 完善 QQ OneBot 平台故障排查文档

### 1.0.0

- 初始版本
- 支持 A1111、NovelAI、ComfyUI 格式
- 支持合并转发配置

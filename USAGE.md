# 使用指南

## 快速开始

### 1. 安装插件

在你的 Koishi 项目中安装本插件：

```bash
npm install koishi-plugin-sdexif
# 或
yarn add koishi-plugin-sdexif
# 或
pnpm add koishi-plugin-sdexif
```

### 2. 在 Koishi 中启用插件

#### 方式一：使用配置文件（koishi.yml）

```yaml
plugins:
  sdexif:
    useForward: false  # 是否使用合并转发
```

#### 方式二：使用 Koishi 控制台

1. 启动 Koishi
2. 打开控制台（默认 http://localhost:5140）
3. 在"插件配置"中找到 `sdexif`
4. 启用插件并配置选项

### 3. 使用插件

在聊天中发送：

```
sdexif [图片]
```

或者

```
读图 [图片]
```

## 详细功能

### 支持的图片格式

- ✅ PNG（推荐，最常见）
- ✅ 包含元数据的 PNG 文件
- ❌ JPEG（通常不包含 SD 元数据）
- ❌ 被压缩过的图片

### 支持的 SD 工具

#### AUTOMATIC1111 WebUI

**完全支持**，可以读取：
- Prompt（正向提示词）
- Negative Prompt（负向提示词）
- Steps（步数）
- Sampler（采样器）
- CFG Scale（提示词相关性）
- Seed（种子）
- Size（图片尺寸）
- Model（使用的模型）

#### NovelAI

**支持**，可以读取：
- Description（提示词）
- Comment（包含参数的 JSON）

#### ComfyUI

**部分支持**，会尝试从 workflow 中提取：
- Prompt
- Negative Prompt
- 采样参数

## 配置说明

### useForward

控制消息发送格式。

**false（默认）** - 普通文本消息：
```
正向提示词:
masterpiece, best quality, 1girl

负向提示词:
lowres, bad quality

参数:
Steps: 20
Sampler: Euler a
CFG Scale: 7
```

**true** - 合并转发格式：

适合处理：
- 多张图片
- 内容很长的提示词
- 需要整理归档的情况

## 常见使用场景

### 场景 1：查看图片参数用于学习

```
用户：这张图真好看！想知道用的什么参数
用户：[发送图片]
用户：sdexif

Bot：正向提示词:
masterpiece, best quality, 1girl, solo...
[完整参数]
```

### 场景 2：批量读取多张图片

```
用户：读图 [图片1] [图片2] [图片3]

Bot：图片 1:
---
[图片1的参数]

===

图片 2:
---
[图片2的参数]

===

图片 3:
---
[图片3的参数]
```

### 场景 3：使用合并转发（配置 useForward: true）

```
用户：sdexif [图片]

Bot：[合并转发消息]
```

## 故障排查

### 问题：读取不到信息

**可能原因：**

1. **图片不是 PNG 格式**
   - 解决：确保图片是 PNG 格式
   
2. **图片被压缩了**
   - 解决：使用原图，避免通过会压缩图片的平台（如微信、QQ）转发
   
3. **图片不是由 SD 生成的**
   - 解决：确认图片确实是由 Stable Diffusion 生成的
   
4. **元数据被移除了**
   - 解决：某些图片处理软件会移除元数据，使用原始生成的图片

### 问题：只能读取到部分信息

**可能原因：**

1. **不同 SD 工具的格式不同**
   - 说明：本插件已支持主流格式，但某些自定义格式可能无法完全解析
   
2. **ComfyUI 的 workflow 很复杂**
   - 说明：ComfyUI 的 workflow 格式多变，插件只能提取常见节点的信息

### 问题：图片下载失败

**可能原因：**

1. **图片 URL 失效**
   - 解决：确保图片链接有效
   
2. **网络问题**
   - 解决：检查网络连接
   
3. **防盗链限制**
   - 解决：某些平台的图片有防盗链，可能无法直接访问

## 高级用法

### 与其他插件配合

可以与其他 Koishi 插件配合使用，例如：

- **图片搜索插件**：先搜图，再读取参数
- **图片存储插件**：读取后归档参数
- **数据库插件**：存储常用的参数组合

### 开发扩展

如果需要支持更多格式或自定义输出，可以：

1. Fork 本项目
2. 修改 `extractSDMetadata` 函数以支持新格式
3. 修改 `formatOutput` 函数以自定义输出格式

## 技术细节

### PNG Metadata 读取原理

Stable Diffusion 通常在 PNG 文件的 tEXt chunks 中存储元数据：

- **AUTOMATIC1111**：存储在 `parameters` 字段
- **NovelAI**：存储在 `Description` 和 `Comment` 字段
- **ComfyUI**：存储在 `workflow` 或 `prompt` 字段（JSON 格式）

本插件使用 `pngjs` 库读取这些 chunks 并解析其中的信息。

### 数据解析流程

1. 下载图片（通过 axios）
2. 验证是否为 PNG 格式
3. 使用 pngjs 解析 PNG
4. 读取 text chunks
5. 根据不同格式解析元数据
6. 格式化输出

## 参考资料

- [Stable Diffusion Inspector](https://github.com/Akegarasu/stable-diffusion-inspector) - 参考项目
- [PNG Specification](http://www.libpng.org/pub/png/spec/1.2/PNG-Contents.html) - PNG 格式规范
- [Koishi 文档](https://koishi.chat) - Koishi 官方文档

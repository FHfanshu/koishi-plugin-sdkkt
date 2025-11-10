# koishi-plugin-sdexif

[![npm](https://img.shields.io/npm/v/koishi-plugin-sdexif?style=flat-square)](https://www.npmjs.com/package/koishi-plugin-sdexif)

读取 Stable Diffusion 生成图片中的 EXIF 信息（prompt、参数等）的 Koishi 插件。

## 功能特性

- 🖼️ 读取 Stable Diffusion 生成图片的元数据
- 📝 支持多种 SD 格式：
  - AUTOMATIC1111 WebUI
  - NovelAI
  - ComfyUI
- 💬 支持普通消息和合并转发两种发送格式
- 🔧 简单易用的配置

## 安装

```bash
# 使用 npm
npm install koishi-plugin-sdexif

# 使用 yarn
yarn add koishi-plugin-sdexif

# 使用 pnpm
pnpm add koishi-plugin-sdexif
```

## 使用方法

### 基本用法

1. 在 Koishi 中启用本插件
2. 发送包含 `sdexif` 或 `读图` 指令的消息，并附带图片
3. Bot 会自动解析并返回图片中的 Stable Diffusion 信息

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

### useForward 说明

- `false`：以普通文本消息形式发送，适合单个或少量图片
- `true`：使用合并转发格式，适合多张图片或内容较长的情况

## 支持的格式

### AUTOMATIC1111 WebUI

完整支持 A1111 WebUI 生成的图片，包括：
- Prompt（正向提示词）
- Negative Prompt（负向提示词）
- Steps（步数）
- Sampler（采样器）
- CFG Scale（提示词相关性）
- Seed（种子）
- Size（尺寸）
- Model（模型）

### NovelAI

支持 NovelAI 生成的图片格式。

### ComfyUI

支持 ComfyUI 的 workflow 格式，会尝试提取：
- Prompt
- Negative Prompt
- 采样参数

## 注意事项

1. 只支持 PNG 格式的图片（SD 通常生成 PNG）
2. 只能读取包含元数据的图片（未经压缩或转换）
3. 如果图片被社交平台压缩，可能无法读取到信息
4. 图片下载有 30 秒超时限制

## 常见问题

### Q: 为什么读取不到信息？

A: 可能的原因：
- 图片不是 PNG 格式
- 图片被压缩或转换，丢失了元数据
- 图片不是由 Stable Diffusion 生成的
- 图片格式不在支持范围内

### Q: 支持哪些平台的图片？

A: 理论上支持所有可以通过 URL 访问的图片，但需要注意：
- QQ/微信等平台会压缩图片，建议使用原图
- 某些平台的图片可能有防盗链限制

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

### 1.0.0

- 初始版本
- 支持 A1111、NovelAI、ComfyUI 格式
- 支持合并转发配置

# 项目概览

## koishi-plugin-sdexif

一个用于读取 Stable Diffusion 生成图片 EXIF 信息的 Koishi 插件。

## 项目结构

```
exif/
├── src/                    # 源代码目录
│   ├── index.ts           # 主插件代码
│   └── pngjs.d.ts         # pngjs 类型声明
├── lib/                    # 编译输出（自动生成）
│   ├── index.js           # 编译后的 JS 文件
│   └── index.d.ts         # 类型声明文件
├── example/                # 示例配置
│   └── koishi.yml         # Koishi 配置示例
├── node_modules/           # 依赖包（自动生成）
├── .gitignore             # Git 忽略文件
├── LICENSE                # MIT 许可证
├── package.json           # 项目配置
├── tsconfig.json          # TypeScript 配置
├── README.md              # 项目说明
├── USAGE.md               # 使用指南
└── PROJECT_SUMMARY.md     # 项目概览（本文件）
```

## 核心功能

### 1. 图片 EXIF 读取
- 支持从 PNG 图片中读取 SD 元数据
- 自动识别不同 SD 工具的格式

### 2. 多格式支持
- **AUTOMATIC1111 WebUI**：完全支持
- **NovelAI**：支持
- **ComfyUI**：部分支持

### 3. 灵活的输出格式
- 普通文本消息
- 合并转发消息（可配置）

### 4. 命令系统
- `sdexif [图片]`：读取图片信息
- `读图 [图片]`：命令别名

## 技术栈

- **运行环境**：Node.js
- **开发语言**：TypeScript
- **框架**：Koishi v4
- **主要依赖**：
  - `pngjs`：PNG 图片解析
  - `axios`：HTTP 请求
  - `koishi`：机器人框架

## 配置项

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| useForward | boolean | false | 是否使用合并转发格式 |

## 工作流程

```
用户发送消息（包含图片 + sdexif 指令）
    ↓
中间件捕获消息
    ↓
提取图片 URL
    ↓
下载图片
    ↓
验证 PNG 格式
    ↓
解析 PNG metadata
    ↓
识别 SD 格式
    ↓
提取参数信息
    ↓
格式化输出
    ↓
发送给用户
```

## 核心代码说明

### index.ts

主要包含以下部分：

1. **配置定义**
   ```typescript
   export interface Config {
     useForward: boolean
   }
   ```

2. **主插件函数**
   ```typescript
   export function apply(ctx: Context, config: Config)
   ```

3. **命令注册**
   - `sdexif` 命令
   - 中间件（自动处理包含图片的消息）

4. **核心功能函数**
   - `extractSDMetadata`：提取 SD 元数据
   - `parseA1111Parameters`：解析 A1111 格式
   - `extractComfyUIMetadata`：解析 ComfyUI 格式
   - `formatOutput`：格式化输出

### pngjs.d.ts

为 `pngjs` 库提供 TypeScript 类型声明。

## 构建说明

### 开发

```bash
# 安装依赖
npm install

# 构建
npm run build

# 输出目录：lib/
```

### 发布

```bash
# 发布到 npm
npm publish
```

## 使用方式

### 安装

```bash
npm install koishi-plugin-sdexif
```

### 配置

在 `koishi.yml` 中：

```yaml
plugins:
  sdexif:
    useForward: false
```

### 使用

在聊天中：

```
sdexif [图片]
```

## 扩展建议

### 可能的增强功能

1. **支持更多格式**
   - 添加对其他 SD 工具的支持
   - 支持 JPEG EXIF

2. **输出定制**
   - 允许用户自定义输出格式
   - 支持只显示特定字段

3. **批处理优化**
   - 并发处理多张图片
   - 进度提示

4. **数据存储**
   - 缓存已读取的图片信息
   - 参数收藏功能

5. **图片分析**
   - 提供参数建议
   - 与其他图片生成插件集成

## 相关资源

- [Koishi 官方文档](https://koishi.chat)
- [Stable Diffusion Inspector](https://github.com/Akegarasu/stable-diffusion-inspector)
- [PNG 规范](http://www.libpng.org/pub/png/spec/)

## 维护说明

### 代码规范

- 使用 TypeScript strict 模式
- 遵循 Koishi 插件开发规范
- 保持代码注释清晰

### 测试建议

1. 测试不同格式的 SD 图片
2. 测试错误处理（无效图片、网络错误等）
3. 测试合并转发功能
4. 测试多图片处理

### 问题反馈

如遇到问题，请提供：
- Koishi 版本
- 插件版本
- 错误日志
- 测试图片（如果可能）

## 开发历史

- **v1.0.0**：初始版本
  - 基础功能实现
  - 支持 A1111、NovelAI、ComfyUI
  - 合并转发配置

## 许可证

MIT License - 详见 LICENSE 文件

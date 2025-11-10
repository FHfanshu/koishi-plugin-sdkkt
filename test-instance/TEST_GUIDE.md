# 测试指南

## ✅ Koishi 实例已启动

你的 Koishi 测试实例已经在运行！

### 🌐 访问控制台

**地址**: http://localhost:5140

浏览器应该已经自动打开，如果没有，请手动访问上述地址。

## 🧪 测试步骤

### 1. 准备测试图片

你需要准备一张由 Stable Diffusion 生成的 PNG 图片。可以通过以下方式获取：

#### 方式 A：自己生成（推荐）
- 使用 AUTOMATIC1111 WebUI 生成任何图片
- 保存为 PNG 格式
- 确保未被压缩或转换

#### 方式 B：从网上下载
- 访问 [Civitai](https://civitai.com)
- 选择任意模型或图片
- 点击下载（确保是原图，而不是预览图）
- 确保是 PNG 格式

#### 方式 C：使用测试样例
- 可以搜索 "stable diffusion example png with metadata"
- 下载包含元数据的测试图片

### 2. 进入沙盒环境

1. 在 Koishi 控制台左侧菜单，找到 **"沙盒"** 选项
2. 点击进入沙盒环境
3. 沙盒是一个模拟的聊天环境，可以直接测试指令

### 3. 测试插件功能

在沙盒聊天框中：

#### 测试 1：基本功能
```
sdexif [点击上传图片按钮，选择你的 SD 图片]
```

或者使用别名：
```
读图 [上传图片]
```

#### 预期输出
如果图片包含 SD 元数据，会显示：
```
正向提示词:
[提示词内容]

负向提示词:
[负向提示词内容]

参数:
Steps: 20
Sampler: Euler a
CFG Scale: 7
Seed: 123456789
Size: 512x768
Model: AnythingV5
```

#### 测试 2：多图片
```
sdexif [图片1] [图片2]
```

应该会分别显示每张图片的信息。

#### 测试 3：合并转发模式

1. 停止当前实例（在终端按 Ctrl+C）
2. 修改 `koishi.yml`：
   ```yaml
   ~sdexif:t8c0uy:
     $path: ../lib
     useForward: true  # 改为 true
   ```
3. 重新启动：`npm start`
4. 在沙盒中再次测试，消息应该以合并转发格式显示

### 4. 测试不同格式的图片

尝试测试以下格式的图片：

- ✅ **A1111 WebUI** 生成的图片（应该完全支持）
- ✅ **NovelAI** 生成的图片（应该支持）
- ✅ **ComfyUI** 生成的图片（部分支持）
- ❌ **压缩过的图片**（可能读取不到）
- ❌ **JPEG 图片**（不支持）

## 🐛 问题排查

### 问题 1：控制台打不开

**检查**：
```bash
# 查看 Koishi 进程
tasklist | findstr node

# 查看端口占用
netstat -ano | findstr :5140
```

**解决**：
- 如果端口被占用，修改 `koishi.yml` 中的 `port`
- 重新启动实例

### 问题 2：找不到 sdexif 插件

**检查日志**，应该看到类似：
```
[I] loader apply plugin ~sdexif:t8c0uy
```

**解决**：
1. 确保插件已编译：
   ```bash
   cd ..
   npm run build
   ```
2. 检查 `koishi.yml` 中的路径是否正确：
   ```yaml
   ~sdexif:t8c0uy:
     $path: ../lib  # 应该指向编译后的 lib 目录
   ```

### 问题 3：发送图片后没有反应

**可能原因**：
- 图片不是 PNG 格式
- 图片不包含 SD 元数据
- 图片被压缩过

**调试方法**：
1. 查看终端日志，是否有错误信息
2. 修改 `koishi.yml`，增加日志级别：
   ```yaml
   logLevel: 3  # 显示更详细的日志
   ```
3. 重启并再次测试

### 问题 4：读取到的信息不完整

**说明**：
- ComfyUI 格式比较复杂，可能只能提取部分信息
- 某些自定义格式可能无法完全解析

**这是正常现象**，插件已尽力支持主流格式。

## 📊 测试检查清单

完成以下测试项：

- [ ] Koishi 控制台能够正常打开
- [ ] 沙盒环境可以访问
- [ ] `sdexif` 指令能够识别
- [ ] 可以成功读取 A1111 格式的图片
- [ ] 可以读取多张图片
- [ ] 合并转发模式正常工作
- [ ] 错误处理正常（如无效图片）

## 🎯 下一步

测试通过后：

### 1. 发布到 npm
```bash
cd ..
npm publish
```

### 2. 在生产环境使用
```bash
npm install koishi-plugin-sdexif
```

### 3. 配置生产环境
```yaml
plugins:
  sdexif:
    useForward: false
```

## 📝 测试反馈

如果发现问题，请记录：
- 使用的图片来源（A1111/NovelAI/ComfyUI）
- 错误信息（查看终端日志）
- 预期行为 vs 实际行为

## 💡 提示

- 沙盒环境支持直接拖拽图片
- 可以在控制台的"日志"标签查看详细日志
- 修改代码后需要重新编译：`cd .. && npm run build`
- 重启插件比重启整个实例更快（在控制台的插件管理中操作）

## 🔗 相关资源

- 测试实例配置：`test-instance/koishi.yml`
- 插件源代码：`src/index.ts`
- 编译输出：`lib/index.js`
- 项目文档：`README.md`、`USAGE.md`

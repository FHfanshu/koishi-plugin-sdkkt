# Koishi 测试实例

这是用于测试 `koishi-plugin-sdexif` 插件的本地 Koishi 实例。

## 启动方式

### 方式 1：使用 npm 脚本

```bash
npm start
```

### 方式 2：直接使用 koishi 命令

```bash
npx koishi start
```

## 测试步骤

1. **启动实例**
   ```bash
   npm start
   ```

2. **打开控制台**
   - 浏览器会自动打开 http://localhost:5140
   - 或手动访问该地址

3. **进入沙盒**
   - 在 Koishi 控制台左侧菜单找到"沙盒"
   - 点击进入沙盒环境

4. **测试插件**
   
   在沙盒中发送：
   ```
   sdexif [图片]
   ```
   
   或者：
   ```
   读图 [图片]
   ```

## 测试图片准备

你需要准备一些带有 SD 元数据的 PNG 图片进行测试：

### 获取测试图片的方法

1. **使用 AUTOMATIC1111 WebUI 生成**
   - 生成任何图片
   - 保存为 PNG 格式
   - 直接使用该图片测试

2. **从网上下载**
   - 在 Civitai、Pixiv 等站点下载包含 metadata 的图片
   - 注意：某些平台会压缩图片，导致元数据丢失

3. **测试样例**
   - 可以从 [Civitai](https://civitai.com) 下载带参数的图片
   - 确保下载的是原图（通常需要点击"Download"而不是右键保存）

## 配置说明

### koishi.yml

```yaml
plugins:
  # 控制台插件
  console:
    port: 5140        # 控制台端口
    open: true        # 是否自动打开浏览器

  # 沙盒插件（用于测试）
  sandbox:
    enabled: true

  # SD EXIF 插件
  ~sdexif:
    $path: '../lib'   # 指向编译后的插件
    useForward: false # 是否使用合并转发
```

### 修改配置

如果要测试合并转发功能：

```yaml
~sdexif:
  $path: '../lib'
  useForward: true  # 改为 true
```

修改后需要重启实例。

## 常见问题

### Q: 提示找不到插件？

A: 确保父目录的插件已编译：
```bash
cd ..
npm run build
```

### Q: 控制台打不开？

A: 检查端口是否被占用，可以修改 `koishi.yml` 中的 `port`。

### Q: 图片无法读取？

A: 检查：
- 图片是否为 PNG 格式
- 图片是否包含 SD 元数据
- 沙盒环境是否能访问图片 URL

## 调试技巧

### 查看日志

启动时会在终端显示日志，包括：
- 插件加载信息
- 错误信息
- 调试信息

### 修改日志级别

在 `koishi.yml` 中：

```yaml
logLevel: 3  # 0: silent, 1: error, 2: warning, 3: info, 4: debug
```

### 插件热重载

修改插件代码后：
1. 重新编译：`cd .. && npm run build`
2. 在控制台重启插件（无需重启整个实例）

## 目录结构

```
test-instance/
├── koishi.yml         # 配置文件
├── package.json       # 依赖配置
├── node_modules/      # 依赖包
└── README.md          # 本文件
```

## 生产环境部署

测试通过后，要在生产环境使用：

1. 发布插件到 npm：
   ```bash
   cd ..
   npm publish
   ```

2. 在生产环境安装：
   ```bash
   npm install koishi-plugin-sdexif
   ```

3. 配置：
   ```yaml
   plugins:
     sdexif:
       useForward: false
   ```

## 更多资源

- [Koishi 官方文档](https://koishi.chat)
- [插件开发指南](https://koishi.chat/guide/plugin/)
- [控制台使用说明](https://koishi.chat/guide/console/)

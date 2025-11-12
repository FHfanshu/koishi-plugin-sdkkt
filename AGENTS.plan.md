# AGENTS 计划与改动记录

**最后更新**: 2025-11-12 22:00:00

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

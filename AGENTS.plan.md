# AGENTS 计划与改动记录

**最后更新**: 2025-11-12 12:35:00

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

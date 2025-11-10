# 快速修复：无法访问控制台

## 问题：ERR_CONNECTION_REFUSED

### 原因：Koishi 需要时间启动

控制台通常需要 **10-20 秒** 才能完全启动。

## 解决步骤

### 1. 查看终端日志

在运行 Koishi 的终端窗口中，等待看到：

```
[I] app server listening at http://127.0.0.1:5140
```

**如果还没看到这行**，说明还在启动中，请继续等待。

### 2. 等待后重试

- 等待 20 秒
- 刷新浏览器（按 F5）
- 或重新访问：http://localhost:5140

### 3. 如果还是不行

#### 检查端口
```bash
netstat -ano | findstr :5140
```

#### 完全重启
1. 在 Koishi 终端按 `Ctrl + C`
2. 等待进程停止
3. 重新运行：`npm start`
4. 等待 20 秒后访问

### 4. 修改端口（如果 5140 被占用）

编辑 `koishi.yml`：
```yaml
console:k2vxbg:
  port: 5141  # 改为 5141
  open: true
```

重启后访问：http://localhost:5141

## 当前状态

Koishi 实例应该正在运行。请：

1. **等待 15-20 秒**
2. 访问：**http://localhost:5140**
3. 如果不行，按 Ctrl+C 停止，然后 `npm start` 重启

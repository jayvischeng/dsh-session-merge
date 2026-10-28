# dsh-session-merge

**把多个已有的 DSH 会话合并成一个新会话，然后在新会话里继续。**
Merge several existing DeepSeek Harness sessions into one new session and continue there.

---

## 为什么需要它

DeepSeek Harness 本身没有「多会话合并」能力：

| 途径 | 能力 | 缺口 |
| --- | --- | --- |
| DSH 核心 | 会话独立管理 | 没有合并 / 引用命令 |
| `dsh-context` | 上下文洞察、跨会话统计 | 只看统计，不能引用内容 |
| `dsh-chat-import` | 导入**单个**会话继续 | 不支持一次合并多个 |

实测确认：`dsh-chat-import` 的 `sessionId` 参数不会把多次导入汇聚到同一个目标会话——每次导入都会生成独立的 `import-*` 会话。

本插件补上这个缺口：**勾选任意多个历史会话 → 合并 → 得到一个完整包含全部历史的新会话**。

---

## 安装

### 从插件商店 / npm

在 DSH 的 **添加插件** 向导里搜索 `dsh-session-merge` 并安装。

### 用 dsh CLI

```sh
dsh plugin --profile desktop add dsh-session-merge
```

### 本地开发安装

把本目录放到 `$DSH_HOME/plugins/dsh-session-merge`，然后在 profile 里注册：

`$DSH_HOME/profiles/<profile>/package.json`

```json
{
  "dependencies": {
    "dsh-session-merge": "file:C:/Users/<you>/.dsh/plugins/dsh-session-merge"
  },
  "dsh": {
    "profile": {
      "bundles": ["...", "dsh-session-merge"]
    }
  }
}
```

`$DSH_HOME/profiles/<profile>/cordis.patch.yml`

```yaml
- id: dsh-session-merge
  name: "dsh-session-merge"
  config: {}
```

然后**重启 DSH**（宿主与客户端两半都需要重新加载）。

---

## 使用

1. 在任意会话的输入框下方，点状态栏里的 **「合并会话」**。
2. 面板列出当前 profile 的**全部会话**（按创建时间倒序，可按 id / 工作目录过滤）。
3. 勾选要合并的会话（可多选）。
4. 点 **「合并 N 个会话」**。
5. 成功后显示新会话 id：**刷新页面（或重启 app）**，在会话列表里打开它——里面就是全部历史，可以直接继续对话。

> 为什么需要刷新：插件通过宿主的 `sessionPersistence.create()` 落盘，这是「持久化但不广播」的路径，新会话不会立刻出现在前端的会话列表里。会话数据本身已经完整写好，刷新即可见。

---

## 合并规则（透明说明）

合并不是简单拼接文本，而是合并**事件流**：

1. 通过宿主 `sessionPersistence` 服务读取每个源会话的完整事件流（自动处理多帧 zstd，不手工解压）。
2. 丢弃每个源会话的 `session` header 事件（新会话使用全新的 header）。
3. 按勾选顺序拼接事件；每个源会话的 `seq` 按累计偏移量平移，保证合并后 `seq` 严格递增。
4. **同步平移会话内的 seq 引用**，避免引用失效：
   - `tool/result` 上的 `sourceEventSeqs`（指向对应的 `tool/call`）；
   - `surfaceOp` 的 `startSeq` / `endSeq`（V4 拼写）或 `start` / `end`（旧拼写）。
5. 新会话 header 字段：`version: 4`、`id: session-merge-<uuid>`、`createdAt: 现在`、`isSeeded: false`、`delegationDepth: 0`，`cwd` / `agentPreset` 继承第一个源会话。
6. `time` / `turn` / `step` 等**展示性**字段原样保留（事件流的真实顺序由 `seq` 决定）。

### 合并后的效果

- ✅ 用户消息、助手回复、工具调用与结果、附件、todo、计划等**全部保留**。
- ✅ 新会话可以正常继续对话（投影会从合并后的事件流重建）。
- ⚠️ `turn` / `step` 编号来自源会话、**不重新编号**，所以时间线上可能出现重复的 turn 序号；对话内容与顺序不受影响。
- ⚠️ 合并大量长会话会得到一个很大的新会话（上下文可能超出窗口），建议只合并必要的会话。

---

## 宿主 API

插件在 web server 上注册两个路由，可脚本化调用：

```http
GET /dsh-session-merge/list
→ { "ok": true, "sessions": [ { "id", "version", "cwd", "createdAt", "isSeeded", "sizeBytes" } ] }

POST /dsh-session-merge/merge
Content-Type: application/json

{ "sessionIds": ["session-a", "session-b"], "cwd": "C:\\optional\\override" }
→ { "ok": true, "sessionId": "session-merge-<uuid>", "eventCount": 1234, "sources": ["session-a","session-b"] }
```

限制：一次最多 **16** 个会话；源会话必须可读（不存在 / 无内容会报错）。

---

## 故障排查

| 现象 | 原因与处理 |
| --- | --- |
| 点「合并会话」没反应 | 客户端插件需要**重启 app** 才加载；确认 profile 的 `bundles` 与 `cordis.patch.yml` 都已注册 |
| 合并成功但列表里找不到新会话 | 刷新页面（或重启 app）；见上文「为什么需要刷新」 |
| `sessionPersistence 不可用` | 宿主版本过旧，或插件宿主半边未加载；查看 DSH 日志 |
| 「合并后事件为空」 | 源会话没有可合并的事件（例如空会话） |
| 新会话打开后显示异常 | 请提 issue 并附上源会话 id 与 DSH 版本；合并逻辑见上文规则 |

---

## 开发与测试

纯 JS，无构建步骤（客户端是手写的 DSH client bundle 格式）。

```sh
# 语法检查
node --check lib/index.js
node --check lib/client.js

# 单元测试（合并算法是纯函数，可离线测）
node test/merge.test.mjs
```

`lib/index.js` 导出的 `mergeEvents(groups)` 是纯函数，测试覆盖：
事件数、`seq` 平移、`sourceEventSeqs` 平移、`surfaceOp` 平移、header 事件剔除。

---

## License

MIT

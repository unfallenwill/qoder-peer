# qoder-peer

与 [Qoder CLI](https://qoder.com) 会话通信的 TypeScript 工具。既可以驱动 Qoder 会话执行任务
并把结果取回来，也可以让 Qoder 会话主动找到你。

Qoder CLI 的**跨会话消息**功能让同一台机器上的会话互相发现并投递消息：每个会话绑定一个私有
Unix socket，把自己的信息登记到会话注册表，其他会话读注册表发现彼此后直连通信。本工具实现了
这套协议，因此对 Qoder 而言它就是一个普通的 peer，反之亦然。

> 该功能目前为 beta，需要 `QODER_FEATURE_CROSS_SESSION=1`（可写入 `~/.qoder/.env`），
> 且仅在 macOS / Linux 可用。

---

## 协议

以下为本工具所依赖的协议行为。

### 发现

每个会话在 `${QODER_CONFIG_DIR:-~/.qoder}/sessions/<pid>.json` 写一条记录：

```json
{
  "pid": 376989,
  "procStart": 1791923894721,
  "startedAt": 1791923896172,
  "cwd": "/home/caosen/GitHub/autopoilot",
  "sessionId": "33aa0f37-b63a-482f-b4d6-1426a1040817",
  "name": "…",
  "kind": "interactive",
  "status": "idle",
  "messagingSocketPath": "/run/user/1000/qoder-socks/376989.sock",
  "peerProtocol": 1
}
```

- 目录 `0700`、记录文件 `0600`；写入采用临时文件 + `rename` 原子替换。
- `kind` ∈ `interactive | bg | daemon | daemon-worker`；`status` ∈ `busy | shell | idle | waiting`。
- 存活判定 = socket 探活（裸 `connect()`，250ms 超时）配合进程存活检查；
  进程已退出的记录会被自动清理。

### Socket 路径

```
${XDG_RUNTIME_DIR:-/tmp}/qoder-socks/<pid>.sock
```

目录 `0700`，socket `0600`。路径必须绝对、不含 `://`、**必须以 `.sock` 结尾** ——
不以 `.sock` 结尾的回信地址会被对端静默丢弃，这会导致「明明投递成功却收不到回复」。
`sun_path` 上限 104 字节，超长时回退到 `/tmp/qoder-socks-<uid>/`。

也可用隐藏参数 `--messaging-socket-path <path>` 显式指定，或设 `QODER_MESSAGING_SOCKET`。

### 传输

Unix domain socket 上的 **NDJSON**：帧以 `\n` (`0x0a`) 分隔，单片上限 **1 MiB**，超限直接断连。
写方是「连上就写、写完即 `end()`」的一次性连接；服务端以 `allowHalfOpen` 监听，
因此可以在同一连接上回写。

### 外层帧

```jsonc
// 投递任务
{
  "type": "user",
  "msg_id": "<uuid>",
  "priority": "next",              // "now" | "later" | "next"，默认 next
  "message": { "role": "user", "content": "<信封字符串>" },
  "from": "uds:/run/user/1000/qoder-socks/12345.sock",
  "self_token": "<uuid>",
  "file_attachments": [{ "name": "a.txt", "path": "/abs/a.txt" }]
}

// 投递回执（对端通过新建连接发回发送方的 socket）
{
  "type": "control",
  "action": "peer_message_status",
  "status": "delivered",           // delivered | held | denied | expired
  "from": "uds:/run/user/1000/qoder-socks/376989.sock",
  "orig_msg_id": "<发送方的 msg_id>"
}
```

### 内层信封

`message.content` 是一个字符串，属性顺序固定，正文中形似标签的 `<` 会被转义为 `<\`：

```
<cross-session-message from="uds:/abs/our.sock" hop-chain="<24hex>" from-name="名称" from-mode="prompting">
正文
</cross-session-message>
```

- `hop-chain`：地址哈希的前 24 位十六进制，逗号分隔，最多 32 项，用于环检测。
- `from-mode` ∈ `bypass | prompting`。

### 派生标识

| 标识 | 算法 | 样例 |
|---|---|---|
| handle | `sha256("session:" + socketPath).slice(0,2)` | `-38` |
| ref | `sha256("session:" + socketPath).slice(0,6)` | `3851d1` |
| hopId | `sha256(address).slice(0,24)` | `9861b0f7…` |
| address | `"uds:" + percentEncode(socketPath)` | `uds:/run/…` |

`/peers` 与 `qpeer list` 展示的就是 handle 与 ref。handle 在整个会话生命周期内稳定，
显示名可能随会话内容变化。

### 安全模型

- `security.crossSessionInbound` ∈ `accept | hold | refuse`，控制入站消息的处置方式。
- 未设置时取决于接收方权限模式：权限直通的会话 `hold`，仍会弹出审批的会话 `accept`。
- 通过显式 socket 路径启动的非交互会话默认 `refuse`（便于发送方立刻拿到答复），
  除非显式设为 `accept`。
- 项目级配置只能收紧，不能放宽。
- socket 所在目录 `0700`、socket 本身 `0600`，仅同一用户可访问。

### 回复是自然动作，不需要特殊措辞

对端收到的消息会被框架为「另一个 Qoder 会话发来的消息」，并说明这并非来自其用户、
但很可能代表用户在行事，应当作队友的请求、在本会话自身的权限范围内处理。
消息在回合中途到达时，还会附加一句提示建议通过 `SendMessage` 回信；作为新回合送达时则不加 ——
因为此时消息本身就是 prompt，回信是模型的自然动作。实测纯自然语言的问候也能得到自动回复。

⚠️ **唯一要避免的是在消息里禁止使用工具。** `SendMessage` 本身就是一个工具，
一句「不要用任何工具」会让对端只能把答案打印在自己的界面上，从而永远收不到回复。
正常描述你要什么即可，不需要点名要求它调用某个工具。

---

## 构建

```bash
npm install
npm run build
```

## CLI

```bash
# 列出可达会话
node dist/cli.js list

# 发指令并等它回复（进程保持监听，收到回信后退出）
node dist/cli.js send -38 "帮我跑一下这个仓库的测试，把结果告诉我"

# 常驻，打印所有入站消息与回执
node dist/cli.js watch

# 查看自己的身份（handle / socket / address）
node dist/cli.js self
```

目标可以是 handle（`-38`）、`名称 [ref]`、会话名、socket 路径或完整 `uds:` 地址。

常用选项：`--socket <path>` 指定自己的 socket，`--reply-ms <ms>` / `--receipt-ms <ms>`
控制等待时长，`--no-reply` / `--no-receipt` 跳过等待，`--json` 输出机器可读结果。

> handle 形如 `-38`，与命令行选项语法冲突，CLI 会自动插入 `--` 分隔符，
> 因此**选项要写在目标之前**。

退出码：`0` 成功，`1` 其他错误，`2` 找不到匹配的活跃会话。

## 库

```ts
import { PeerDaemon, resolveTarget } from "qoder-peer";

const daemon = new PeerDaemon({ name: "orchestrator" });
await daemon.start();                     // 绑定 socket + 自注册

const peers = await daemon.listPeers();
const target = resolveTarget(peers[0].ref, peers).peer!;

daemon.on("message", (m) => console.log(m.fromName, m.body));
daemon.on("receipt", (r) => console.log(r.status, r.origMsgId));

await daemon.send(target, "跑一下测试，把结果告诉我");

await daemon.stop();                      // 注销 + 清理 socket
```

`PeerDaemon` 会在 `~/.qoder/sessions/` 中注册自己，因此 Qoder 会话的 `/peers`
能看见本工具，也能主动发消息过来。

---

## 开发

```bash
npm run typecheck   # tsc --noEmit，同时覆盖 src 与 test
npm test            # 先 build，再用 node:test 跑单测
npm run check       # 两者串跑（CI 跑的就是这个）
```

单测直接跑在 TypeScript 源码上（依赖 Node 的类型擦除），因此源码刻意不使用
parameter property 这类需要代码生成的语法。CI 在 ubuntu 与 macOS 上覆盖 Node 22 / 24。

## 已知限制

- 仅在 macOS / Linux 可用（依赖 Unix domain socket）。
- Qoder CLI 的跨会话消息仍是 beta，协议随时可能变化。
- 文件附件（`file_attachments`）字段已按协议实现，但未经实测。
- `hold` 策略下的审批流程未做端到端验证。

## License

MIT

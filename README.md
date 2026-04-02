# agentdispatch

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](./LICENSE)

本地 HTTP 入口网关，将应用请求按可配置策略分发到 [agentproxy](https://github.com/nulluna/agent-proxy) 池中的某个节点，并通过内部 HTTPS relay 透明转发到目标上游。

## 网络拓扑

```mermaid
graph LR
    subgraph 本地网络
        App[应用程序]
        AD[agentdispatch]
    end

    subgraph 代理池 — 公网 / 边缘节点
        AP1[agentproxy-1]
        AP2[agentproxy-2]
        AP3[agentproxy-N]
    end

    Upstream[目标上游]

    App -- "HTTP<br/>GET /ssl/api.example.com/..." --> AD
    AD -- "HTTPS<br/>/relay/&lt;secret&gt;/proxyssl/..." --> AP1
    AD -. "HTTPS<br/>poll / hash 选择" .-> AP2
    AD -. "HTTPS<br/>poll / hash 选择" .-> AP3
    AP1 -- "HTTPS<br/>api.example.com/..." --> Upstream
    AP2 -. "HTTP/HTTPS" .-> Upstream
    AP3 -. "HTTP/HTTPS" .-> Upstream

    style App fill:#e8f5e9,stroke:#43a047
    style AD fill:#e3f2fd,stroke:#1e88e5
    style AP1 fill:#fff3e0,stroke:#fb8c00
    style AP2 fill:#fff3e0,stroke:#fb8c00
    style AP3 fill:#fff3e0,stroke:#fb8c00
    style Upstream fill:#fce4ec,stroke:#e53935
```

**协议说明：**

| 段落 | 协议 | 说明 |
|------|------|------|
| 应用 → agentdispatch | HTTP | 本地回环，无需加密 |
| agentdispatch → agentproxy | HTTPS | 内部 relay，携带 `DISPATCH_SECRET` |
| agentproxy → 目标上游 | HTTP / HTTPS | 由请求路径前缀决定（`proxy/` = HTTP，`proxyssl/` = HTTPS） |

## 路由语义

```
/<site>/<path>?query        →  http://<site>/<path>?query
/ssl/<site>/<path>?query    →  https://<site>/<path>?query
```

agentdispatch 接收到请求后，根据分发策略选中一个 agentproxy 节点，将请求改写为内部 relay 路径：

```
# HTTP 上游
GET /example.com/search?q=test
  → https://<agentproxy>/relay/<DISPATCH_SECRET>/proxy/example.com/search?q=test

# HTTPS 上游
POST /ssl/api.openai.com/v1/responses
  → https://<agentproxy>/relay/<DISPATCH_SECRET>/proxyssl/api.openai.com/v1/responses
```

## 分发策略

### `poll`（轮询）

- 按 `AGENTPROXY_POOL` 配置顺序依次选择节点
- 游标仅保存在当前 agentdispatch 实例内存中
- 轮转至池尾后回绕到第一个节点

### `hash`（哈希）

- 以 `target site + Authorization` 计算稳定索引
- 缺失 `Authorization` 时以空字符串参与哈希
- 池长度或顺序变化会导致映射重排（非一致性哈希）

## 配置项

| 环境变量 | 必填 | 说明 |
|---------|------|------|
| `AGENTPROXY_POOL` | 是 | 逗号分隔的 agentproxy 节点列表，例如 `https://a.internal,https://b.internal` |
| `DISPATCH_SECRET` | 是 | 与所有 agentproxy 节点共享的 relay secret |
| `DISPATCH_STRATEGY` | 否 | `poll`（默认）或 `hash` |
| `RELAY_CONNECT_TIMEOUT_MS` | 否 | 内部 relay 连接超时（毫秒） |
| `RELAY_RESPONSE_TIMEOUT_MS` | 否 | 内部 relay 响应流超时（毫秒） |

## 透明转发边界

agentdispatch 会尽量保留以下内容：

**请求侧**
- 原始 HTTP method、path、query string
- `Authorization`、`Cookie`、`User-Agent` 等端到端请求头
- 请求 body 流

**响应侧**
- 状态码、`Set-Cookie`、响应头
- 流式响应 body（含 SSE）

hop-by-hop 头部（`Connection`、`Transfer-Encoding`、`Host`、`Content-Length`）不会继续转发，以维持标准代理语义。

## 失败语义

- 选中节点连接失败或内部 relay 异常时，当前请求直接返回错误
- 不会自动 failover 到池中的下一个节点
- 响应流在 relay 阶段超时后会直接中断

## 快速开始

```bash
npm install
npm test
```

常用命令：

```bash
npm run dev          # 本地开发
npm run typecheck    # TypeScript 类型检查
npm test             # 运行测试
npm run build        # Wrangler dry-run 构建
```

## 迁移指南

1. 在所有 agentproxy 节点配置相同的 `DISPATCH_SECRET`，确认 `/relay/<secret>/proxyssl/...` 可用
2. 部署 agentdispatch，配置 `AGENTPROXY_POOL`、`DISPATCH_STRATEGY` 和超时参数
3. 将应用入口从"直连 agentproxy"切换到"访问本地 agentdispatch 的 `/<site>/...` 或 `/ssl/<site>/...`"
4. 切换完成后，直接访问 agentproxy 的旧 `/proxy`、`/proxyssl` 入口将持续返回 `404`

## 使用说明与免责声明

- 本项目主要面向个人学习、研究与技术交流场景
- 使用者在部署、修改或集成本项目时，应自行确认其用途符合适用法律法规、目标平台政策以及所在组织的安全与合规要求
- 作者与维护者不对因使用、误用或二次分发本项目产生的直接或间接损失、合规风险或第三方争议承担责任
- 本节为使用说明，具体授权范围仍以项目许可证为准

## License

本项目采用 [GPL-3.0](./LICENSE) 许可证。

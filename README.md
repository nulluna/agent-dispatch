# agent-dispatch

`agent-dispatch` 是一个本地/边缘前置 web 代理，负责把外部 `/s|/h` 入口请求分发到多个 `agent-proxy` backend。

## 核心能力

- 对外提供 `/s/<host>/<path>`、`/h/<host>/<path>` 代理入口
- 将请求转发到多个 `agent-proxy` backend
- 默认使用轮询分流，并在失败时自动切换到下一个 backend
- 对短时间内失败的 backend 做被动冷却，减少连续命中故障节点
- 重写上游 `3xx` 响应中的 `Location` / `Refresh`
- 保留状态码、响应头、`Set-Cookie` 与流式 body
- 提供健康检查端点：`/healthz`、`/readyz`

## 路由协议

### HTTPS 上游

```text
/s/<host>/<path>
```

示例：

```text
/s/api.openai.com/v1/responses
/s/example.com%3A8443/login/start
```

### HTTP 上游

```text
/h/<host>/<path>
```

示例：

```text
/h/internal.service.local/status
```

## 运行配置

通过环境变量配置：

- `PORT`
  - 默认：`8787`
  - 本地监听端口
- `DISPATCH_SECRET`
  - 必填
  - 与所有 `agent-proxy` backend 共用的 relay secret
- `AGENT_PROXY_URLS`
  - 必填
  - 多个 backend URL，逗号分隔
  - 例如：`https://proxy-a.example,https://proxy-b.example/base`
- `REQUEST_TIMEOUT_MS`
  - 默认：`5000`
  - 单个 backend 尝试的超时时间
- `FAILOVER_COOLDOWN_MS`
  - 默认：`3000`
  - backend 因超时/可重试网络错误失败后进入被动冷却的时长

## 启动

安装依赖：

```bash
npm install
```

复制示例配置：

```bash
cp .env.example .env
```

按需修改 `.env` 后启动开发模式：

```bash
npm run dev
```

构建：

```bash
npm run build
```

运行测试：

```bash
npm run typecheck
npm test
```

## 健康检查

```text
GET /healthz
GET /readyz
```

返回：

```json
{"ok":true}
```

## 转发协议

`agent-dispatch` 会把外部请求转换为 `agent-proxy` 可识别的内部 relay URL：

```text
<agent-proxy-base>/relay/<DISPATCH_SECRET>/<s|h>/<authority>/<path>
```

例如：

```text
https://proxy-a.example/relay/relay-secret/s/api.openai.com/v1/responses
```

## 验证示例

假设本地启动在 `8787`：

```bash
curl -i "http://127.0.0.1:8787/healthz"
curl -i "http://127.0.0.1:8787/s/example.com/login/start"
```

## 边界

- 当前实现为最小可用版本，不包含主动健康检查、权重调度、粘性会话
- backend 健康策略为被动冷却，不做独立探活
- `Location` / `Refresh` 仅对可解析的 `http(s)` 目标做重写

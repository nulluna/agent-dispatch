# agent-dispatch

`agent-dispatch` 是一个本地或边缘前置 web 代理，负责把显式 `/s|/h` 入口或透明入口请求分发到多个 `agent-proxy` backend。

## 核心能力

- 对外提供 `/s/<host>/<path>`、`/h/<host>/<path>` 显式代理入口
- 提供独立的透明代理端口，用于 `caddy/nginx -> http cleartext -> agent-dispatch` 接入
- 将请求转换为 `agent-proxy` 兼容的 `/relay/<DISPATCH_SECRET>/<s|h>/<authority>/<path>` 协议
- 支持 `consistent-hashing` 与 `round-robin` 两种 backend 选择策略
- 默认使用 `consistent-hashing`，并在可重试网络失败时自动切换到下一个 backend
- 对短时间内失败的 backend 做被动冷却，减少连续命中故障节点
- 显式入口会重写上游 `3xx` 响应中的 `Location` / `Refresh`
- 透明入口不改写重定向，尽量保持浏览器无感访问目标站点
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
  - 无默认监听端口
  - 可选；未设置则不监听显式代理入口
  - 显式代理端口，服务 `/s/<host>/<path>` 与 `/h/<host>/<path>`
- `TRANSPARENT_PORT`
  - 可选，例如：`8788`
  - 未设置则不监听 transparent 入口
  - 透明代理专用端口；该端口上的请求按 `https://<host><path>?<query>` 出口转发
  - transparent 模式不做 `Location` / `Refresh` rewrite
- `DISPATCH_SECRET`
  - 必填
  - 与所有 `agent-proxy` backend 共用的 relay secret
- `AGENT_PROXY_URLS`
  - 必填
  - 多个 backend URL，逗号分隔
  - 例如：`https://proxy-a.example,https://proxy-b.example/base`
- `BACKEND_SELECTION_STRATEGY`
  - 默认：`consistent-hashing`
  - 可选：`consistent-hashing`、`round-robin`
  - 控制首次命中的 backend 选择策略
- `REQUEST_TIMEOUT_MS`
  - 默认：`5000`
  - 单个 backend 尝试的超时时间
- `FAILOVER_COOLDOWN_MS`
  - 默认：`3000`
  - backend 因超时或可重试网络错误失败后进入被动冷却的时长

## 入口模式

### 显式代理模式

继续使用：

```text
/s/<host>/<path>
/h/<host>/<path>
```

### 透明代理模式

当前置反代把流量转发到 `TRANSPARENT_PORT` 时：

- 请求路径保持原样，例如 `/api/user/self`
- 目标 host 优先取自 `X-Dispatch-Target-Host`，其次才是 `X-Forwarded-Host`
- 默认按 `https` 出口
- 不做 `Location` / `Refresh` rewrite
- 适合本地 `/etc/hosts` + TLS 前置终止场景
- 示例配置见：
  - `examples/Caddyfile`
  - `examples/nginx-transparent.conf`

推荐前置反代转发时至少设置：

```text
X-Dispatch-Target-Host: <original-host>
X-Forwarded-Host: <original-host>
X-Forwarded-Proto: https
```

这样 dispatch 不会误把本地监听地址当成真实 target host。

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

当前 `dev` 脚本会通过 `tsx --env-file=.env` 自动加载 `.env`。

构建：

```bash
npm run build
```

运行测试：

```bash
npm run typecheck
npm test
```

## 本地透明代理验证

1. 生成本地域名证书，例如使用 `mkcert`。
2. 在 `/etc/hosts` 中把目标域名指向本机，例如 `127.0.0.1 anyrouter.top`。
3. 启动 `agent-dispatch`，至少配置：

```text
TRANSPARENT_PORT=8788
DISPATCH_SECRET=<shared-secret>
AGENT_PROXY_URLS=https://proxy-a.example,https://proxy-b.example
```

4. 使用 `examples/Caddyfile` 启动本地 Caddy，让它终止 TLS 并把 cleartext HTTP 转发到 `127.0.0.1:8788`。
5. 浏览器访问 `https://anyrouter.top/path?query`，请求会被转换为某个 `agent-proxy` backend 的：

```text
/relay/<DISPATCH_SECRET>/s/anyrouter.top/path?query
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

## 显式调试示例

假设显式入口启动在 `8787`：

```bash
curl -i "http://127.0.0.1:8787/healthz"
curl -i "http://127.0.0.1:8787/s/example.com/login/start"
```

## 边界

- 当前实现为最小可用版本，不包含主动健康检查、权重调度
- `consistent-hashing` 使用 `protocol + host + pathname` 作为稳定路由 key
- backend 健康策略为被动冷却，不做独立探活
- 透明模式固定按 `https` 出站；如果需要透明 `http` 出站，应单独扩展
- `Location` / `Refresh` 仅在显式代理模式下对可解析的 `http(s)` 目标做重写

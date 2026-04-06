# agent-dispatch

一个独立的 Node.js 分发服务，用短路径把请求转发到上游站点，并通过多个 relay/proxy 节点做失败切换。

## 功能概览

- 解析 `/s/...` 与 `/h/...` 路由并还原目标上游 URL
- 将请求转发到 `AGENT_PROXY_URLS` 中配置的 relay 节点
- 当某个 relay 节点超时或出现可重试网络错误时，自动切换到下一个节点
- 可选通过 SOCKS5 代理建立对 relay 节点的出站连接
- 重写响应头中的 `Location` 与 `Refresh`，保持后续跳转仍走 dispatch 路由

## 路由格式

- HTTPS 上游：`/s/<encoded-host>/<path>`
- HTTP 上游：`/h/<encoded-host>/<path>`

说明：

- `s` 表示目标协议为 `https`
- `h` 表示目标协议为 `http`
- `encoded-host` 需要做 URL 编码，例如 `example.com` 或 `example.com:8443`
- 查询字符串直接跟在路径后面

示例：

```text
/s/example.com/api/users?id=1
/h/internal.service.local/status
/s/example.com%3A8443/login?next=%2Fapp
```

## 运行方式

先安装依赖：

```bash
npm install
```

本地开发前，必须在仓库根目录提供 `.env`，并至少配置 `DISPATCH_SECRET` 与 `AGENT_PROXY_URLS`。当前开发脚本会按 `tsx watch --env-file-if-exists=.env src/server.ts` 的方式启动，并读取该文件；如果缺少必填变量，服务仍会启动失败。

开发模式：

```bash
npm run dev
```

构建：

```bash
npm run build
```

构建后启动：

```bash
npm run start
```

默认监听端口为 `8787`，可通过环境变量覆盖。

## 环境变量

### 必填

- `DISPATCH_SECRET`：拼接 relay URL 时使用的共享 secret
- `AGENT_PROXY_URLS`：relay 节点列表，逗号分隔，仅支持 `http/https`

### 可选

- `PORT`：监听端口，默认 `8787`
- `REQUEST_TIMEOUT_MS`：单个 relay 节点请求超时，默认 `5000`
- `SOCKS5_PROXY_HOST`：SOCKS5 代理主机
- `SOCKS5_PROXY_PORT`：SOCKS5 代理端口
- `SOCKS5_PROXY_USERNAME`：SOCKS5 用户名
- `SOCKS5_PROXY_PASSWORD`：SOCKS5 密码

示例：

```bash
PORT=8787 \
DISPATCH_SECRET=local-dev-secret \
AGENT_PROXY_URLS=http://127.0.0.1:9001,http://127.0.0.1:9002 \
REQUEST_TIMEOUT_MS=5000 \
npm run dev
```

## 失败切换与 SOCKS5

服务会按顺序尝试 `AGENT_PROXY_URLS` 中的节点：

- 如果节点超时，或出现可重试网络错误，会自动尝试下一个节点
- 如果所有节点都失败，则返回 502
- 如果配置了 SOCKS5，dispatch 到 relay 的出站请求会通过该代理发送

这里的 SOCKS5 是出站网络层代理，用来控制 dispatch 服务访问 relay 节点时的网络路径；它不会改变 `/s`、`/h` 这两种应用层路由格式。

## 质量检查

类型检查：

```bash
npm run typecheck
```

测试：

```bash
npm test
```

构建：

```bash
npm run build
```

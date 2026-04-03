const dns = require('node:dns')

const dnsServerValue = process.env.AGENT_DISPATCH_DNS_SERVER?.trim()

if (dnsServerValue) {
  const servers = dnsServerValue
    .split(',')
    .map((server) => server.trim())
    .filter(Boolean)

  if (servers.length > 0) {
    dns.setServers(servers)
    console.info(`[agent-dispatch] dns servers set: ${servers.join(', ')}`)
  }
}

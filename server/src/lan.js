import os from 'node:os'

// The address a phone on the same network should use to reach this terminal.
// Shared by everything that puts this address on a phone, which must agree: a link
// built against one address and a code minted against another would be a
// support call nobody could diagnose from the logs.
export function lanIp() {
  const nets = Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
  return nets[0]?.address ?? 'localhost'
}

import os from 'node:os'
import { execFileSync } from 'node:child_process'

const NULL_MAC = '00:00:00:00:00:00'
const MACOS_MASKED_MAC = '02:00:00:00:00:00'

const readMacFromNetworksetup = (name) => {
  try {
    const output = execFileSync('/usr/sbin/networksetup', ['-getmacaddress', name], { encoding: 'utf8', timeout: 5000 })
    const match = output.match(/Ethernet Address:\s*([0-9a-f]{2}(?::[0-9a-f]{2}){5})/i)
    return match ? match[1].toLowerCase() : null
  } catch {
    return null
  }
}

const resolveMac = (name, mac) => {
  if (process.platform === 'darwin' && mac === MACOS_MASKED_MAC) return readMacFromNetworksetup(name)
  return mac
}

// Picks the first non-internal IPv4 interface with a real MAC address.
export const getSelfNetworkInfo = () => {
  const interfaces = os.networkInterfaces()

  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family !== 'IPv4' || info.internal || !info.mac || info.mac === NULL_MAC) continue
      const mac = resolveMac(name, info.mac)
      if (!mac || mac === NULL_MAC || mac === MACOS_MASKED_MAC) continue
      // 멀티홈 환경(VPN·가상 어댑터 등)에서는 열거 순서에 따라 엉뚱한 인터페이스가
      // 선택될 수 있으므로, 페어링 전에 어떤 인터페이스를 골랐는지 남긴다.
      console.log(`네트워크 인터페이스 선택: ${name} (MAC: ${mac}, IP: ${info.address})`)
      return { macAddress: mac, ipAddress: info.address }
    }
  }

  return null
}

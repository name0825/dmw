import os from 'node:os'

const NULL_MAC = '00:00:00:00:00:00'

// Picks the first non-internal IPv4 interface with a real MAC address.
export const getSelfNetworkInfo = () => {
  const interfaces = os.networkInterfaces()

  for (const name of Object.keys(interfaces)) {
    for (const info of interfaces[name] || []) {
      if (info.family === 'IPv4' && !info.internal && info.mac && info.mac !== NULL_MAC) {
        // 멀티홈 환경(VPN·가상 어댑터 등)에서는 열거 순서에 따라 엉뚱한 인터페이스가
        // 선택될 수 있으므로, 페어링 전에 어떤 인터페이스를 골랐는지 남긴다.
        console.log(`네트워크 인터페이스 선택: ${name} (MAC: ${info.mac}, IP: ${info.address})`)
        return { macAddress: info.mac, ipAddress: info.address }
      }
    }
  }

  return null
}

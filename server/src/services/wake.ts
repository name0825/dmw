import wol from 'wake_on_lan'

// WOL 표준 포트. 매직 넘버를 상수로 분리해 의도를 명확히 한다.
const WOL_PORT = 9

/**
 * IPv4 주소의 서브넷 브로드캐스트 주소를 계산한다.
 * 가정: /24 네트워크 (DMW가 관리하는 LAN 환경 기준).
 * @param {string} ipv4 - 예: '192.168.0.20'
 * @returns {string} 브로드캐스트 주소, 예: '192.168.0.255'
 */
export const subnetBroadcast = (ipv4: string): string =>
  `${ipv4.split('.').slice(0, 3).join('.')}.255`

/**
 * 지정된 MAC 주소로 Wake-on-LAN 패킷을 브로드캐스트로 전송한다.
 * @param {string} macAddress - 대상 MAC 주소 (정규화된 형태)
 * @param {string} ipv4 - 대상 기기의 IPv4 주소 (브로드캐스트 계산에 사용)
 * @throws {Error} WOL 패킷 전송 실패 시
 */
export const sendWakePacket = (macAddress: string, ipv4: string): Promise<void> =>
  new Promise((resolve, reject) => {
    wol.wake(macAddress, { address: subnetBroadcast(ipv4), port: WOL_PORT }, (error?: Error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })

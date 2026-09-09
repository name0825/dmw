import wol from 'wake_on_lan'

import { WOL_BROADCAST_ADDRESS } from '../config.js'
import { WOL_PORT } from '../config/constants.js'
import { isValidIp } from '../utils/validation.js'

/**
 * IPv4 주소의 서브넷 브로드캐스트 주소를 계산한다.
 * 가정: /24 네트워크 (DMW가 관리하는 LAN 환경 기준).
 * @param {string} ipv4 - 예: '192.168.0.20'
 * @returns {string} 브로드캐스트 주소, 예: '192.168.0.255'
 */
export const subnetBroadcast = (ipv4: string): string =>
  `${ipv4.split('.').slice(0, 3).join('.')}.255`

/**
 * WOL 패킷을 보낼 브로드캐스트 주소를 결정한다.
 * WOL_BROADCAST_ADDRESS 가 설정돼 있으면 그 값을 쓰고, 없으면 /24 를 가정해
 * 대상 기기 IP 에서 유도한다.
 * @param {string} ipv4 - 대상 기기의 IPv4 주소
 * @returns {string} 브로드캐스트 주소
 * @throws {Error} WOL_BROADCAST_ADDRESS 가 유효한 IPv4 가 아닐 때
 */
export const resolveBroadcastAddress = (ipv4: string): string => {
  if (!WOL_BROADCAST_ADDRESS) {
    return subnetBroadcast(ipv4)
  }

  // 오설정된 주소로 조용히 패킷을 흘려보내면 WOL 이 실패해도 원인이 드러나지
  // 않으므로, 설정값이 IPv4 형식이 아니면 전송 자체를 막는다.
  if (!isValidIp(WOL_BROADCAST_ADDRESS)) {
    throw new Error(`WOL_BROADCAST_ADDRESS is not a valid IPv4 address: ${WOL_BROADCAST_ADDRESS}`)
  }

  return WOL_BROADCAST_ADDRESS
}

/**
 * 지정된 MAC 주소로 Wake-on-LAN 패킷을 브로드캐스트로 전송한다.
 * @param {string} macAddress - 대상 MAC 주소 (정규화된 형태)
 * @param {string} ipv4 - 대상 기기의 IPv4 주소 (브로드캐스트 계산에 사용)
 * @throws {Error} WOL 패킷 전송 실패 시
 */
export const sendWakePacket = (macAddress: string, ipv4: string): Promise<void> =>
  new Promise((resolve, reject) => {
    let broadcastAddress: string
    try {
      broadcastAddress = resolveBroadcastAddress(ipv4)
    } catch (error) {
      reject(error)
      return
    }

    wol.wake(macAddress, { address: broadcastAddress, port: WOL_PORT }, (error?: Error) => {
      if (error) {
        reject(error)
        return
      }
      resolve()
    })
  })

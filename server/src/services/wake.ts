import os from 'node:os'
import wol from 'wake_on_lan'

import { WOL_BROADCAST_ADDRESS } from '../config.js'
import { WOL_PORT } from '../config/constants.js'
import { isValidIp } from '../utils/validation.js'

const ipToLong = (ipv4: string): number =>
  ipv4.split('.').reduce((acc, octet) => (acc << 8) + Number(octet), 0) >>> 0

const longToIp = (long: number): string =>
  [(long >>> 24) & 0xff, (long >>> 16) & 0xff, (long >>> 8) & 0xff, long & 0xff].join('.')

const warnedFallbackIps = new Set<string>()

/**
 * IPv4 주소의 서브넷 브로드캐스트 주소를 계산한다.
 * 실제 네트워크 인터페이스 목록에서 대상 IP 와 같은 서브넷(주소 & 넷마스크)에
 * 속하는, internal 이 아닌 IPv4 인터페이스를 찾아 그 넷마스크로 브로드캐스트
 * 주소를 유도한다. 일치하는 인터페이스가 없으면(대상이 다른 서브넷에 있는
 * 경우) /24 를 가정하던 이전 방식으로 되돌아가고, WOL_BROADCAST_ADDRESS 설정을
 * 권장하는 경고를 한 번 출력한다.
 * @param {string} ipv4 - 예: '192.168.0.20'
 * @param {NodeJS.Dict<os.NetworkInterfaceInfo[]>} [interfaces] - 테스트 주입용. 기본값은 os.networkInterfaces()
 * @returns {string} 브로드캐스트 주소, 예: '192.168.0.255'
 */
export const subnetBroadcast = (
  ipv4: string,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string => {
  const target = ipToLong(ipv4)

  let best: { broadcast: string; prefix: number } | undefined
  for (const infos of Object.values(interfaces)) {
    for (const info of infos ?? []) {
      if (info.internal || info.family !== 'IPv4') continue
      const address = ipToLong(info.address)
      const netmask = ipToLong(info.netmask)
      if ((address & netmask) === (target & netmask)) {
        const prefix = netmask.toString(2).replace(/0/g, '').length
        if (!best || prefix > best.prefix) {
          best = { broadcast: longToIp((address & netmask) | (~netmask >>> 0)), prefix }
        }
      }
    }
  }
  if (best) return best.broadcast

  if (!warnedFallbackIps.has(ipv4)) {
    warnedFallbackIps.add(ipv4)
    console.warn(
      `No local network interface matches the subnet of ${ipv4}; assuming a /24 network for the WOL broadcast address. Set WOL_BROADCAST_ADDRESS to avoid this.`
    )
  }
  return `${ipv4.split('.').slice(0, 3).join('.')}.255`
}

/**
 * WOL 패킷을 보낼 브로드캐스트 주소를 결정한다.
 * WOL_BROADCAST_ADDRESS 가 설정돼 있으면 그 값을 쓰고, 없으면 대상 기기 IP 와
 * 로컬 네트워크 인터페이스의 넷마스크로 유도한다 (subnetBroadcast 참고).
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

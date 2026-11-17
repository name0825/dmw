import { requestJson } from './http.js'
import { getSelfNetworkInfo } from './network.js'
import { currentVersion } from './update.js'

export const pairWithServer = async (serverUrl, pairingCode, name) => {
  const netInfo = getSelfNetworkInfo()
  if (!netInfo) {
    throw new Error('사용 가능한 네트워크 인터페이스(IPv4/MAC)를 찾을 수 없습니다.')
  }

  const payload = {
    pairingCode,
    macAddress: netInfo.macAddress,
    ipAddress: netInfo.ipAddress,
    ...(name ? { name } : {}),
  }

  return requestJson(`${serverUrl}/agent/pair`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export const sendHeartbeat = (serverUrl, apiKey, metrics, updateReport) =>
  requestJson(`${serverUrl}/agent/heartbeat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ ...metrics, agentVersion: currentVersion, ...(updateReport ? { updateReport } : {}) }),
  })

export const unpairFromServer = (serverUrl, apiKey) =>
  requestJson(`${serverUrl}/agent/unpair`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: '{}',
    signal: AbortSignal.timeout(15000),
  })

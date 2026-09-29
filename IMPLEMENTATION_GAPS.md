# 미구현 · 구현 미비 항목

`project.md`(v0.5) 계획과 실제 코드를 대조한 결과입니다. 기준일: 2026-09-29, 브랜치 `fix/lan-api-url-and-ci`.
계획서의 P0/P1 항목과 P2 SSH 원격 명령은 모두 코드로 구현되었고, 아래는 그 밖에 남은 부분만 정리했습니다.

## 1. 남은 항목

| 구분 | 항목 | 현황 |
|---|---|---|
| M4 운영 | Docker CI 잡 첫 통과 확인 | `.github/workflows/ci.yml`의 `docker` 잡(compose 빌드·기동 → 장치 생성 → `docker compose restart server` → 장치 유지 확인)을 추가했으나 아직 GitHub에서 실행되지 않았습니다. |
| M4 운영 | 홈서버 상시 배포, 실사용 테스트 | 코드 작업이 아닌 운영 작업입니다(`project.md` §10, §13). |
| 테스트 | 브라우저 E2E ("새로고침 없이 상태 변경") | 서버 측 WS push(`integration-realtime.test.ts`)만 자동화되어 있고 브라우저 레벨 검증은 없습니다. |
| SSH | 실기기 수동 검증 | 실제 SSH 경로는 mock 전송으로만 검증했습니다. `uptime` 실행, 잘못된 호스트 키 지문 거부, `sleep 40` 타임아웃을 실기기에서 확인해야 합니다. |

`project.md` §12에서 자동화된 항목: 서버 재시작 후 디바이스 유지(`integration-restart.test.ts`), Agent 상태 서버 반영, WS 최신 상태 전달. 컨테이너 관련 3건은 Docker CI 잡 첫 통과 후 체크합니다.

## 2. 참고 — 테스트 전용 export

아래 export는 운영 코드에서는 쓰지 않지만 테스트가 import하므로 유지합니다.

- `agent/src/autostart.js`: `autostartEntry`
- `agent/src/update.js`: `isNewerVersion`, `validateBundle`
- `server/src/routes/auth.ts`: `handleLogin`, `handleRefresh`, `handleLogout`
- `server/src/services/wake.ts`: `subnetBroadcast`, `resolveBroadcastAddress`
- `server/src/services/ws.ts`: `selectWebSocketProtocol`, `authorizeWebSocketProtocols`, `sendStateToClient`

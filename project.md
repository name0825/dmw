# 프로젝트 계획서

## 1. 개요

- **프로젝트명**: DMW (Device Manager Web)
- **한 줄 요약**: 홈 네트워크 상의 디바이스들을 웹 UI에서 한 번에 관리하고, WOL과 실시간 리소스 모니터링을 제공하는 개인용 디바이스 관리 웹 서비스
- **시작일 / 목표 완료일**: '26. 08. 14. / '26. 09. 04.
- **버전**: v0.7
- **구현 갭 / 실행 방법**: 남은 구현 갭은 `IMPLEMENTATION_GAPS.md`, 실행/배포 방법은 `README.md` 참고

---

## 2. 배경 및 동기

### 왜 이 프로젝트를 시작하는가?

홈서버/개인 네트워크에 PC, NAS, 서버 등의 디바이스가 여러 대 존재하며, 매번 개별 접속하여 전원을 켜거나 상태를 확인하는 과정이 번거롭다.

DMW는 이를 하나의 웹 UI로 통합하여 다음 작업을 간단하게 수행하는 것을 목표로 한다.

- 디바이스 목록 및 상태 확인
- WOL을 이용한 원격 부팅
- CPU / 메모리 / 디스크 사용량 모니터링
- 디바이스의 온라인 / 오프라인 상태 확인

### 어떤 문제를 해결하는가?

1. 원격지에서 PC 전원을 켤 때 별도 WOL 앱이나 명령어를 사용해야 하는 불편
2. 여러 디바이스의 CPU / MEM / Disk 상태를 개별 SSH 또는 별도 모니터링 도구로 확인해야 하는 비효율
3. Node.js / TypeScript 기반 백엔드와 실시간 모니터링 웹 서비스 개발 경험 확보 및 포트폴리오 제작

### 유사한 기존 솔루션과의 차이

- **Netdata / Glances**: 상태 모니터링 기능은 강력하지만 WOL 중심의 개인 홈랩 관리에는 기능이 많음
- **Homepage / Homarr**: 대시보드 및 링크 관리에 강점이 있으나 실시간 하드웨어 상태 및 WOL 통합에는 한계가 있음
- **WOL 전용 앱**: 매직 패킷 전송은 가능하지만 디바이스 상태 모니터링 기능이 없음

→ DMW는 **WOL + 디바이스 상태 모니터링**을 하나의 가벼운 개인용 웹 서비스로 통합하는 것을 차별점으로 한다.

---

## 3. 목표

### 핵심 목표 (P0)

다음 항목이 모두 동작하면 v0.4의 핵심 목표를 달성한 것으로 판단한다.

1. 웹에서 등록된 디바이스 목록을 확인하고 등록 / 수정 / 삭제할 수 있다.
2. 관리자 로그인 기능이 정상 동작한다.
3. 로그인 비밀번호는 평문으로 저장하지 않으며 bcrypt로 해싱한다.
4. 로그인 성공 후 Access Token(JWT)과 Refresh Token을 발급하고, 인증이 필요한 API는 Access Token 검증을 수행한다.
5. Access Token 만료 시 Refresh Token으로 재발급받을 수 있다.
6. 웹 UI에서 디바이스 등록 시 서버가 **일회용 페어링 코드**를 발급한다.
7. Agent는 최초 설치 시 사용자가 입력한 서버 IP와 페어링 코드로 서버와 연결하여 API Key를 발급받는다.
8. 서버는 페어링 완료 여부(`agent_paired`)를 디바이스별로 관리하며, 페어링되지 않은 디바이스는 별도 상태로 구분해 표시한다.
9. 등록된 디바이스에 WOL 매직 패킷을 전송할 수 있다.
10. WOL 요청 후 일정 시간 내 상태가 변경되지 않으면 실패 상태를 사용자에게 표시한다.
11. 최소 1개 OS를 지원하는 Agent가 CPU / MEM / Disk 정보를 서버로 주기적으로 전송한다.
12. Agent는 **10초 주기**로 heartbeat 및 상태 정보를 서버에 push한다.
13. 서버는 Agent의 마지막 heartbeat를 기준으로 온라인 / 오프라인 상태를 판정한다.
14. Agent가 **30초 이상 heartbeat를 보내지 않으면 OFFLINE**으로 판정한다.
15. 웹 UI에서 최신 CPU / MEM / Disk 상태를 확인할 수 있다.
16. Agent → 서버 통신에는 API Key 인증을 적용한다.
17. 최신 상태 데이터는 `device_metrics_latest` 별도 테이블로 관리한다.
18. Docker 컨테이너로 홈서버에 배포하고 재시작 후에도 설정 및 디바이스 정보가 유지된다.

### 선택 목표 (P1)

1. Windows 등 추가 OS용 Agent 지원 (완료)
2. CPU / MEM / Disk 상태 이력 그래프 (완료)
3. 상태 이력 데이터 7일 보존 및 자동 삭제 (완료)
4. 디바이스 오프라인 / 리소스 임계치 초과 알림 (완료)
5. Discord / Slack 웹훅 및 Telegram 알림 연동 (완료)

### 보류 목표 (P2)

1. SSH 기반 원격 명령 실행 (구현됨: 서버 ssh2 직접 접속, 관리자 비밀번호 재입력 필요)

### 하지 않을 것 (Non-goals)

1. 다중 사용자 / 역할 기반 권한 관리
2. 인터넷에 직접 공개하는 서비스 운영
3. 별도의 네이티브 모바일 앱 개발
4. 원격 데스크톱 / GUI 스트리밍 기능
5. v0.4에서의 다중 OS Agent 동시 지원
6. 복잡한 홈 네트워크 구성 자동화

### 네트워크 전제조건

- DMW 서버는 홈 네트워크 내부에 설치된 Mac Mini에서 실행한다.
- WOL 대상 디바이스와 DMW 서버는 기본적으로 동일한 LAN / WOL이 허용된 네트워크 구간에 존재한다고 가정한다.
- 외부에서 사용할 경우 DMW를 인터넷에 직접 노출하지 않고 VPN을 통해 홈 네트워크에 접속한다.
- WOL 동작 여부는 대상 디바이스의 BIOS / UEFI, NIC, OS 종료 설정 및 네트워크 장비의 브로드캐스트 정책에 영향을 받을 수 있다.

---

## 4. 사용자 / 사용 시나리오

### 누가 쓰는가?

본인 1명이 사용하는 개인 홈랩 관리 서비스

### 대표 사용 시나리오

#### 1. Agent 최초 설치 및 페어링

새 디바이스를 DMW에 등록하는 상황에서:

1. 웹 UI에서 디바이스 이름 / MAC / IP를 입력해 등록
2. 서버가 일회용 페어링 코드(예: 8자리, 유효시간 10분)를 발급하고 화면에 표시
3. 대상 디바이스에서 Agent 설치 후 실행
4. Agent 실행 시 서버 IP와 페어링 코드를 입력
5. Agent가 서버에 `POST /agent/pair` 요청 (IP + 코드)
6. 서버가 코드 유효성 및 만료 여부 확인 후 해당 디바이스에 대한 API Key 발급
7. 서버는 `agent_paired = true`, `paired_at`을 기록하고 페어링 코드를 폐기
8. 이후 Agent는 발급받은 API Key로 heartbeat 전송

#### 2. 외부에서 PC 원격 부팅

외출 중 집의 PC가 꺼져 있는 상황에서:

1. VPN을 통해 홈 네트워크에 접속
2. 스마트폰 브라우저로 DMW 접속
3. 로그인
4. 대상 PC의 `Wake` 버튼 클릭
5. 서버가 WOL 매직 패킷 전송
6. Agent heartbeat가 다시 수신되면 상태를 `ONLINE`으로 변경
7. 사용자는 원격 접속 수행

#### 3. 디바이스 상태 확인

홈서버 여러 대가 실행 중인 상황에서:

1. DMW 대시보드 접속
2. 디바이스별 상태(`NOT_PAIRED` / `ONLINE` / `OFFLINE`) 확인
3. CPU / MEM / Disk 사용량 확인
4. 특정 디바이스의 리소스 사용량이 높을 경우 상세 화면 확인
5. P1 구현 시 상태 이력 그래프로 변화 추이 확인

#### 4. WOL 실패

Wake 요청 이후:

1. 서버가 WOL 패킷 전송
2. 서버는 최대 **3분 동안** 대상 디바이스의 온라인 전환 여부를 확인
3. 온라인 전환 시 `ONLINE` 상태로 표시
4. 3분 내 heartbeat가 수신되지 않으면 `WAKE_TIMEOUT` 상태 또는 사용자 경고 표시
5. UI에서 BIOS / NIC / WOL 설정 확인을 유도
6. 대상 디바이스가 애초에 `NOT_PAIRED` 상태인 경우, WOL 실패가 아닌 "Agent 미설치/미페어링" 안내를 별도로 표시

---

## 5. 기능 명세

### 수정된 핵심 기능

#### WAKE_TIMEOUT 상태 판정 개선 (P0)
- **문제**: WAKE_TIMEOUT 상태에서 `last_seen` 기준으로 시간을 계산하여, 오래된 디바이스에 대해 즉시 OFFLINE로 판단되는 문제가 있었습니다.
- **해결**: WAKE_TIMEOUT 상태에서는 `updated_at` 기준으로 시간을 계산하여 3분 대기 시간을 올바르게 적용합니다.

#### JWT 시크릿 보안 강화 (P0)
- **문제**: 프로덕션 환경에서 `JWT_SECRET` 기본값 `"change-me-in-production"`이 검증되지 않아 보안 위험이 있었습니다.
- **해결**: `validateRuntimeConfig` 함수에 `"change-me-in-production"`도 체크하도록 수정하여, 실제 시크릿이 설정되지 않은 경우 서버가 시작되지 않도록 했습니다.

#### 알림 디바운스 (P1)
- **문제**: CPU 사용량이 85% 이상인 상태가 지속되는 동안 10초마다 같은 알림이 반복적으로 전송되어 스팸이 발생할 수 있었습니다.
- **해결**: 각 디바이스별 메트릭에 대해 5분 간격으로 알림을 필터링하고, 오프라인 알림은 `ONLINE` 또는 `WAKE_TIMEOUT`에서 `OFFLINE`으로 전환될 때만 기록·전송하여 중복 알림을 방지합니다.

#### Telegram 알림 (P1)
- **해결**: `TELEGRAM_BOT_TOKEN`과 `TELEGRAM_CHAT_ID`를 모두 설정하면 기존 Discord/Slack 웹훅과 독립적으로 Telegram 알림을 전송합니다. 둘 중 하나라도 비어 있으면 Telegram 전송을 시도하지 않습니다.

#### 프론트엔드 빌드 설정 문서화 (P1)
- **문제**: VPN 접속 시 `VITE_API_BASE` 기본값이 `localhost:3001`로 설정되어, 브라우저가 로컬 서버가 아닌 자신의 로컬 주소를 호출하여 API 호출이 실패하는 문제가 있었습니다.
- **해결**: README.md에 프론트엔드 빌드 설정 및 VPN 접속 시 필요한 `.env` 설정 방법을 명시했습니다.

--- 

| 우선순위 | 기능 | 설명 | 상태 |
|---|---|---|---|
| P0 | 사용자 인증 | 로그인, bcrypt 비밀번호 해싱, Access/Refresh Token 발급 및 검증 | 완료 |
| P0 | 디바이스 등록/관리 | 이름, MAC, IP 등록·수정·삭제 | 완료 |
| P0 | Agent 페어링 | 디바이스 등록 시 일회용 페어링 코드 발급, Agent 최초 연결 시 API Key 발급 | 완료 |
| P0 | WOL 매직패킷 전송 | 등록된 디바이스에 UDP 매직 패킷 전송 | 완료 |
| P0 | WOL 결과 판정 | 요청 후 최대 3분 동안 heartbeat/상태 변화 확인, 실패 시 경고 | 완료 |
| P0 | Agent 인증 | Agent → Server 요청에 API Key 인증 적용 | 완료 |
| P0 | Agent heartbeat | Agent가 10초마다 heartbeat 전송 | 완료 |
| P0 | 리소스 모니터링 | CPU / MEM / Disk 사용량 수집 및 전송 | 완료 |
| P0 | 온/오프라인 판정 | 마지막 heartbeat 기준 30초 미수신 시 OFFLINE | 완료 |
| P0 | WebSocket 실시간 반영 | 서버가 최신 상태를 브라우저에 WebSocket으로 push | 완료 |
| P1 | 추가 OS Agent | Windows 등 타 OS 지원 | 완료 |
| P1 | 상태 이력 그래프 | 시간별 CPU / MEM / Disk 추이 표시 | 완료 |
| P1 | 이력 보존 정책 | 상태 이력 최대 7일 보존 후 자동 삭제 | 완료 |
| P1 | 알림 기능 | OFFLINE / 리소스 임계치 초과 시 알림 | 완료 |
| P2 | SSH 원격 명령 | 재부팅 등 간단한 원격 명령 실행 | 구현됨 (실기기 수동 검증 대기) |

### 상태 판정 기준

- Agent heartbeat 주기: **10초**
- `NOT_PAIRED`: 디바이스는 등록되었으나 Agent 페어링이 완료되지 않은 상태
- `ONLINE`: 정상적인 heartbeat가 확인되는 상태
- `OFFLINE`: 페어링은 완료되었으나 마지막 heartbeat 이후 **30초 이상** 경과
- `WAKE_TIMEOUT`: 페어링된 디바이스에 WOL 요청 후 최대 **3분** 동안 ONLINE 전환이 확인되지 않은 상태
- 일시적인 heartbeat 지연으로 인한 오탐을 줄이기 위해 단일 요청 실패가 아닌 마지막 heartbeat 시간 기준으로 판정

---

## 6. 데이터 및 통신 설계

### Agent가 서버에 전송하는 기본 데이터

Agent는 10초마다 다음 정보를 서버로 전송한다.

```text
deviceId
timestamp
cpuUsage
memoryUsage
diskUsage
agentVersion
```

예시:

```json
{
  "deviceId": "device-001",
  "timestamp": "2026-08-14T11:00:00Z",
  "cpuUsage": 32.4,
  "memoryUsage": 48.1,
  "diskUsage": 71.2,
  "agentVersion": "0.4.0"
}
```

> **실제 구현 상태**: Agent가 `POST /agent/heartbeat`로 실제 전송하는 값은 `cpuUsage` / `memoryUsage` / `diskUsage`뿐이다. `deviceId`는 요청 바디가 아닌 API Key로 서버가 식별하고, `timestamp`는 Agent가 보내는 값이 아니라 서버가 수신한 시각을 기록한다. `agentVersion`은 선택 값으로 heartbeat에 실려 오면 검증 후 `devices.agent_version`에 저장하고 UI 장치 카드에 표시한다.

### 서버에서 관리하는 상태

서버는 Agent 데이터와 별도로 다음 값을 관리한다.

```text
deviceId
agentPaired
pairedAt
lastSeen
status
```

- `agentPaired`: Agent 페어링 완료 여부
- `pairedAt`: 페어링 완료 시각
- `lastSeen`: 마지막 정상 Agent 통신 시각
- `status`: NOT_PAIRED / ONLINE / OFFLINE
- 리소스 데이터: `device_metrics_latest` 테이블에서 최신 측정값을 별도로 관리

### Agent 페어링 흐름

```text
[웹 UI] 디바이스 등록
  ↓
서버: 일회용 페어링 코드 발급 (유효시간 10분)
  ↓
[Agent] 서버 IP + 페어링 코드 입력
  ↓
Agent → POST /agent/pair (ip, pairingCode)
  ↓
서버: 코드 유효성 / 만료 확인
  ↓
서버: API Key 발급, agent_paired = true, paired_at 기록
  ↓
페어링 코드 즉시 폐기 (1회용)
  ↓
Agent: 발급받은 API Key로 이후 heartbeat 전송
```

- 페어링 코드는 디바이스 등록 시에만 발급되며, 서버 IP를 안다고 해서 임의의 기기가 등록될 수 없도록 코드 검증을 필수로 한다.
- 페어링 코드는 1회 사용 후 폐기하고, 유효시간 내 미사용 시 만료 처리한다.
- 페어링이 완료되지 않은 디바이스는 `NOT_PAIRED` 상태로 표시되며 WOL 실패와 구분한다.

### 인증

#### 사용자 → 서버

```text
Browser
  ↓
Login
  ↓
Fastify
  ↓
bcrypt 비밀번호 검증
  ↓
Access Token(JWT) + Refresh Token 발급
  ↓
Authorization: Bearer <Access Token>
```

- 로그인 비밀번호는 bcrypt로 해싱하여 저장
- 로그인 성공 후 서버가 **Access Token**과 **Refresh Token**을 발급
  - Access Token 유효기간: **1일**
  - Refresh Token은 서버 DB에 저장하여 관리하며, 탈취 시 개별 무효화가 가능하도록 한다
  - Refresh Token은 `httpOnly` 쿠키로 저장하여 XSS로부터 보호한다
- Access Token 만료 시 `POST /auth/refresh`로 재발급
- 로그아웃 시 `POST /auth/logout`으로 Refresh Token을 서버에서 무효화
- 인증이 필요한 REST API는 Access Token 검증
- JWT 내부에는 최소한의 식별 정보만 포함
- JWT Secret은 환경변수로 관리하고 소스 코드에 하드코딩하지 않는다.

#### Agent → 서버

```text
Agent
  ↓
Authorization: Bearer <API Key>
  ↓
Agent API
  ↓
API Key 검증
```

- Agent별 API Key는 페어링 완료 시 발급
- 서버에서는 가능한 경우 API Key 자체를 평문으로 저장하지 않고 해시 형태로 관리
- 유효하지 않은 API Key 요청은 거부
- Agent API는 일반 사용자용 Access Token 인증 API와 분리

---

## 7. 기술 스택 및 아키텍처

### 기술 스택

- **언어**: TypeScript
- **백엔드**: Node.js + Fastify
- **프론트엔드**: React + Vite
- **데이터베이스**: SQLite
- **실시간 통신**: `ws`
- **WOL**: `wake_on_lan` 또는 직접 UDP 매직 패킷 구현
- **Agent 상태 수집**: `systeminformation`
- **인증**: `bcrypt` + `jsonwebtoken`
- **SSH**: `ssh2` (P2, 구현됨)
- **배포**: Docker Compose (`network_mode: host`, 서버는 `BIND_HOST=127.0.0.1`로 로컬에만 바인딩하고 web 컨테이너의 nginx가 `/api/` → `127.0.0.1:3001`, `/ws` → `127.0.0.1:3002`로 프록시). HTTPS는 `docker-compose.https.yml`을 함께 적용하는 옵션(기본 `WEB_HTTPS_PORT=8443`, `COOKIE_SECURE=true`)으로 제공한다.
- **호스트**: Mac Mini M2 8GB
- **Agent 자동 업데이트/자동 시작**: Agent는 GitHub Releases 기반 자체 업데이트(`agent/src/update.js`, `.github/workflows/agent-release.yml`)와 OS 자동 시작 등록(`agent/src/autostart.js`)을 지원한다.

### 시스템 구조

```text
┌───────────────────────────────┐
│          Browser              │
│       React + Vite            │
└──────────────┬────────────────┘
               │
          REST / WebSocket
               │
┌──────────────▼────────────────┐
│       DMW Server               │
│        Node.js + Fastify       │
│                                │
│  Auth / Device / Pairing /     │
│  WOL / Agent Service /         │
│  WebSocket                     │
└───────┬───────────┬────────────┘
        │           │
        │           └──────────────┐
        │                          │
      SQLite                 Agent API
        │                          │
        │                    ┌─────▼─────┐
        │                    │   Agent   │
        │                    │  Pairing  │
        │                    │  10 sec   │
        │                    │ heartbeat │
        │                    └─────┬─────┘
        │                          │
        │                   CPU / MEM / Disk
        │
        └──── UDP Magic Packet
                    │
              ┌─────▼─────┐
              │ Target NIC │
              │    WOL     │
              └────────────┘
```

### 내부 서버 구조

구현 시 다음과 같은 책임 분리를 기본 구조로 한다. (아래는 실제 `server/src` 디렉터리 구조다.)

```text
server/src/
├── routes/
│   ├── auth.ts
│   ├── devices.ts
│   ├── pairing.ts
│   └── agent.ts
├── services/
│   ├── devices.ts
│   ├── pairing.ts
│   ├── agent.ts
│   ├── wake.ts
│   ├── monitoring.ts
│   ├── notifications.ts
│   └── ws.ts
├── database/
│   ├── index.ts
│   ├── schema.ts
│   └── auth.ts
├── middleware/
│   └── auth.ts
├── utils/
│   ├── crypto.ts
│   └── validation.ts
├── config/
│   └── constants.ts
├── types/
├── auth.ts
├── alerts.ts
├── deviceStatus.ts
├── config.ts
├── routes.ts
└── index.ts
```

목표는 HTTP 라우트에 비즈니스 로직을 직접 넣지 않고 Service 단위로 분리하는 것이며, 당초 계획했던 별도 `repositories/`, `plugins/` 계층은 두지 않고 `database/`가 그 역할을 겸한다.

---

## 8. 주요 API 책임

세부 API 명세는 개발 시작 시 별도로 작성하되, 다음 책임을 기본으로 한다.

### 사용자 인증

```text
POST /auth/login
POST /auth/refresh
POST /auth/logout
```

- ID / 비밀번호 검증
- Access Token(JWT) + Refresh Token 발급
- Refresh Token으로 Access Token 재발급
- 로그아웃 시 Refresh Token 무효화

### 디바이스 관리

```text
GET    /dashboard
GET    /devices
GET    /devices/:id/history
GET    /alerts
POST   /devices
PATCH  /devices/:id
DELETE /devices/:id
POST   /devices/:id/wake
```

- `POST /devices` 등록 시 일회용 페어링 코드를 함께 응답으로 반환
- `GET /devices/:id/history`: 상태 이력(P1) 조회, `GET /alerts`: 알림(P1) 조회, `GET /dashboard`: 대시보드용 요약 데이터 조회

### 페어링 코드 발급

```text
POST /pairing-codes
```

- 이미 등록된 디바이스에 대해 재페어링용 코드를 추가 발급할 때 사용

### Agent 페어링

```text
POST /agent/pair
POST /agent/unpair
```

- 서버 IP로 수신한 요청에서 페어링 코드 검증
- 코드 유효 시 API Key 발급, `agent_paired = true` 기록
- 코드 만료/불일치 시 거부
- `POST /agent/unpair`: 페어링 해제(재설치/재페어링 대비)

### WOL

```text
POST /devices/:id/wake
```

- 대상 디바이스 조회 (페어링 여부 확인)
- WOL 매직 패킷 전송
- Wake 요청 상태 기록
- 이후 heartbeat로 ONLINE 전환 확인

### Agent

```text
POST /agent/heartbeat
```

- API Key 검증 (Key로 대상 디바이스 식별)
- 마지막 heartbeat 갱신
- CPU / MEM / Disk 최신값을 `device_metrics_latest`에 저장
- WebSocket 이벤트 발생

### SSH 원격 명령

```text
GET    /ssh/public-key
POST   /devices/:id/ssh/scan
PUT    /devices/:id/ssh
DELETE /devices/:id/ssh
POST   /devices/:id/commands
GET    /devices/:id/commands
```

- 서버가 `ssh2`로 대상 기기에 직접 접속하며, 서버 전용 ed25519 키만 사용한다(비밀번호 인증 없음, `SSH_KEY_PATH`)
- 호스트 키는 스캔 후 사용자가 지문을 확인해 저장하는 TOFU 방식이다
- 자유 명령 실행과 SSH 설정 저장/해제는 매번 관리자 비밀번호 재입력이 필요하다(실패 시 403)
- 실행 기록은 `command_runs`, 설정 변경·재인증 실패는 `ssh_audit`에 감사 기록으로 남긴다

### 기타

```text
GET /health
```

- 헬스체크용 엔드포인트 (Docker healthcheck에서 사용)

---

## 9. 데이터베이스 기본 구조

### devices

```text
id
name
mac_address
ip_address
agent_key_hash
agent_paired
agent_version
ssh_username
ssh_port
ssh_host_key
paired_at
last_seen
status
created_at
updated_at
```

### pairing_codes

```text
id
device_id
code
expires_at
used_at
created_at
```

- 페어링 코드는 발급 후 10분간 유효
- 1회 사용 후 `used_at` 기록 및 즉시 무효화

### 최신 상태 데이터 (device_metrics_latest)

```text
device_id
cpu_usage
memory_usage
disk_usage
updated_at
```

- 최신 상태 데이터는 `devices`와 분리된 별도 테이블로 관리한다.

### refresh_tokens

```text
id
user_id
token_hash
lookup_id
issued_at
expires_at
revoked
revoked_at
replaced_by
```

- Refresh Token은 평문이 아닌 해시로 저장
- `lookup_id`로 토큰 조회, `replaced_by`로 회전(rotate) 이력을 추적해 로그아웃 시 후속 세션까지 함께 무효화
- 로그아웃 또는 탈취 의심 시 `revoked` / `revoked_at` 처리

### 상태 이력 (P1)

```text
device_metrics_history
  id
  device_id
  timestamp
  cpu_usage
  memory_usage
  disk_usage
```

- 최대 7일 보존 (`HISTORY_RETENTION_MS`, `server/src/services/monitoring.ts`)
- 주기적인 정리 작업으로 오래된 데이터 삭제

### 알림 (P1, alerts)

```text
id
device_id
level
metric
value
message
created_at
```

- OFFLINE / 리소스 임계치 초과 알림 기록을 저장하며 `GET /alerts`로 조회한다
- 보존 기간: 30일 (`ALERT_RETENTION_MS`)

---

## 10. 일정 (마일스톤)

| 마일스톤 | 내용 | 목표일 | 완료 여부 |
|---|---|---|---|
| M1 | 환경 세팅, 프로젝트 구조, DB 스키마, 기본 Fastify 서버, 로그인/Access·Refresh Token | '26. 08. 17. | ☑ |
| M2-a | 디바이스 CRUD, 페어링 코드 발급/검증, WOL 전송, WOL 실패 상태 설계 | '26. 08. 21. | ☑ |
| M2-b | 단일 OS Agent 개발, 페어링 연동, 10초 heartbeat, CPU/MEM/Disk 수집 | '26. 08. 25. | ☑ |
| M3-a | Server ↔ Agent 통합, NOT_PAIRED/ONLINE/OFFLINE 판정, WebSocket 상태 반영 | '26. 08. 27. | ☑ |
| M3-b | UI 개선, 에러 핸들링, WOL 실패 UX, 기본 테스트 | '26. 08. 31. | ☑ |
| M4 | Docker 배포, 재시작 복구 검증, 실사용 테스트, 홈서버 상시 배포 | '26. 09. 04. | ☐ |

---

## 11. 리스크 및 제약사항

### WOL

- 대상 디바이스의 BIOS / UEFI에서 WOL을 활성화해야 한다.
- NIC가 WOL을 지원해야 한다.
- OS 종료 방식에 따라 WOL 가능 여부가 달라질 수 있다.
- 네트워크 장비에서 필요한 브로드캐스트 패킷 전달이 허용되어야 한다.
- 기본적으로 DMW 서버와 대상 디바이스가 동일한 WOL 가능 네트워크에 존재하는 것을 전제로 한다.
- 브로드캐스트 주소는 실제 로컬 네트워크 인터페이스의 넷마스크를 기준으로 계산하며, 대상 IP와 일치하는 인터페이스가 없을 때만 경고와 함께 `/24`를 가정한다. `WOL_BROADCAST_ADDRESS` 환경변수로 직접 지정해 이 가정을 우회할 수 있다.

### Agent

- OS별로 CPU / MEM / Disk 메트릭 수집 방식이 다를 수 있다.
- v0.4에서는 단일 OS만 공식 지원하여 구현 범위를 제한한다.
- Agent 설치 및 실행 방법을 문서화해야 한다.
- Agent 페어링 시 서버 IP를 잘못 입력하거나 페어링 코드가 만료된 경우의 에러 메시지를 명확히 제공해야 한다.

### 페어링 / 보안

- 페어링 코드가 없는 상태에서는 임의의 기기가 서버 IP만으로 Agent Key를 발급받을 수 없다.
- 페어링 코드 유효시간(10분) 내 미사용 시 자동 만료된다.
- Refresh Token은 해시로 저장하며, 탈취 의심 시 즉시 무효화할 수 있어야 한다.

### SQLite

- Agent 수가 적은 개인 홈랩 환경을 전제로 SQLite를 사용한다.
- Agent 수 또는 이력 데이터가 크게 증가하여 동시 쓰기 병목이 발생할 경우 MariaDB/PostgreSQL 등으로 전환을 검토한다.

### 인증 / 보안

- 로그인 비밀번호는 bcrypt 해싱
- JWT Secret은 환경변수 관리
- Access Token 유효기간 1일, Refresh Token은 DB에서 해시로 관리
- Agent API Key 인증 적용
- 인증 실패 요청 거부
- DMW 서버를 인터넷에 직접 공개하지 않고 VPN을 통한 외부 접속을 권장

### 시스템 자원

- 배포 대상은 Mac Mini M2 8GB
- 불필요하게 무거운 프레임워크 대신 Fastify + `ws` + SQLite를 사용하여 자원 사용량을 최소화한다.

---

## 12. 테스트 기준

### 인증

- [x] 정상 계정으로 로그인할 수 있다.
- [x] 잘못된 비밀번호로 로그인할 수 없다.
- [x] 로그인 비밀번호가 DB에 평문으로 저장되지 않는다.
- [x] 로그인 성공 시 Access Token과 Refresh Token이 발급된다.
- [x] Access Token 만료 후 Refresh Token으로 재발급받을 수 있다.
- [x] 로그아웃 시 Refresh Token이 무효화되어 재사용할 수 없다.
- [x] 유효하지 않은 Access Token으로 보호된 API 접근이 거부된다.

### 디바이스 / 페어링

- [x] 디바이스를 등록할 수 있다.
- [x] 디바이스 등록 시 일회용 페어링 코드가 발급된다.
- [x] 올바른 페어링 코드로 Agent가 서버와 페어링되고 API Key를 발급받는다.
- [x] 만료되거나 잘못된 페어링 코드로는 페어링이 거부된다.
- [x] 페어링 코드는 1회 사용 후 재사용할 수 없다.
- [x] 디바이스를 수정할 수 있다.
- [x] 디바이스를 삭제할 수 있다.
- [x] 서버 재시작 후 디바이스 정보가 유지된다. (`integration-restart.test.ts`)

### WOL

- [x] 등록된 디바이스에 WOL 패킷을 전송할 수 있다.
- [x] WOL 성공 후 Agent heartbeat가 다시 수신된다.
- [x] 3분 내 상태 회복이 없으면 사용자에게 `WAKE_TIMEOUT` 상태가 표시된다.
- [x] 페어링되지 않은(`NOT_PAIRED`) 디바이스는 WOL 실패가 아닌 별도 안내가 표시된다.

### Agent

- [x] Agent가 API Key 인증을 통과한다.
- [x] 잘못된 API Key 요청이 거부된다.
- [x] Agent가 10초마다 heartbeat를 전송한다.
- [x] CPU / MEM / Disk 데이터가 정상적으로 수집된다.
- [x] 마지막 heartbeat 이후 30초 이상 지나면 OFFLINE으로 변경된다.
- [x] Agent가 다시 heartbeat를 보내면 ONLINE으로 복구된다.

### 실시간 UI

- [x] Agent가 보낸 최신 상태가 서버에 반영된다.
- [x] WebSocket으로 브라우저에 최신 상태가 전달된다.
- [ ] 브라우저 새로고침 없이 상태가 변경된다. (서버 측 WS push는 `integration-realtime.test.ts`로 자동화, 브라우저 E2E는 없음)

### 배포

- [ ] Docker 컨테이너로 실행된다.
- [ ] 컨테이너 재시작 후 서비스가 정상 복구된다.
- [ ] 컨테이너 재시작 후 DB 데이터가 유지된다. (CI `docker` 잡 추가, 첫 실행 대기)

---

## 13. 완료 기준 (Definition of Done)

- [x] 웹 UI에서 디바이스를 등록 / 수정 / 삭제할 수 있다.
- [x] 로그인 기능이 정상 동작한다.
- [x] 비밀번호는 평문으로 저장되지 않는다.
- [x] 로그인 성공 시 Access/Refresh Token이 발급되고, 보호된 API가 Access Token으로 인증된다.
- [x] Access Token 만료 시 Refresh Token으로 재발급이 가능하다.
- [x] 디바이스 등록 시 발급된 페어링 코드로 Agent가 서버와 정상 페어링된다.
- [x] 페어링되지 않은 디바이스는 `NOT_PAIRED` 상태로 명확히 구분되어 표시된다.
- [x] 등록된 디바이스에 WOL 패킷을 전송해 실제로 전원을 켤 수 있다.
- [x] WOL 요청 후 3분 내 상태 변화가 없으면 실패 상태가 표시된다.
- [x] 최소 1대 이상의 디바이스에서 Agent를 통해 CPU / MEM / Disk 상태가 수집된다.
- [x] Agent는 10초 주기로 heartbeat를 전송한다.
- [x] heartbeat가 30초 이상 끊기면 디바이스가 OFFLINE으로 판정된다.
- [x] Agent ↔ Server 통신에 API Key 인증이 적용되어 있다.
- [x] 최신 상태 데이터가 `device_metrics_latest` 별도 테이블에서 관리된다.
- [x] 웹 UI에서 최신 상태가 WebSocket으로 실시간 반영된다.
- [ ] Docker 컨테이너로 홈서버에 상시 배포되어 있다.
- [x] 서버 재시작 후 디바이스 정보가 유지된다. (컨테이너 재시작은 CI `docker` 잡 첫 실행 대기)

---

## 14. 참고자료

- Wake-on-LAN: https://en.wikipedia.org/wiki/Wake-on-LAN
- `systeminformation`: https://www.npmjs.com/package/systeminformation
- `jsonwebtoken`: https://www.npmjs.com/package/jsonwebtoken
- `bcrypt`: https://www.npmjs.com/package/bcrypt
- `ssh2`: https://www.npmjs.com/package/ssh2
- Homepage: https://gethomepage.dev
- Netdata: https://www.netdata.cloud
- 남은 구현 갭 목록: `IMPLEMENTATION_GAPS.md`
- 설치/실행/배포 방법: `README.md`

---

## 15. 변경 이력

### v0.7 ('26. 09. 29.)

- 실제 코드 기준 재동기화: SSH 원격 명령(P2) 구현 반영(§8 API, §9 `devices` 컬럼), `agentVersion` 전송·저장 반영(§6)
- 서버 재시작 유지(`integration-restart`)와 WS push(`integration-realtime`) 자동화를 §12에 표기, CI `docker` 잡 추가(첫 실행 대기)
- 남은 항목: Docker CI 첫 통과, SSH 실기기 검증, 브라우저 E2E, 홈서버 상시 배포(M4), P2 잔여(다중 사용자/권한, React Native 앱, Docker Hub 배포)

### v0.6 ('26. 09. 28.)

- 문서를 실제 코드 기준으로 재동기화 (§6~9, §11, §14)
- §6 heartbeat 페이로드에 실제 구현 상태를 명시: `deviceId`는 API Key로 식별, `timestamp`는 서버 수신 시각 기록, `agentVersion`은 전송/저장되지 않음 (구현 미비)
- §7 내부 서버 구조를 실제 `server/src` 디렉터리(`database/`, `middleware/`, `utils/`, `config/` 등)에 맞게 수정하고, Docker Compose 배포 구조(`network_mode: host`, nginx 프록시, HTTPS 옵션)와 Agent 자체 업데이트/자동 시작 기능을 추가 기술
- §8 API 목록에 실제 존재하는 `GET /dashboard`, `GET /devices/:id/history`, `GET /alerts`, `POST /agent/unpair`, `POST /pairing-codes`, `GET /health`를 반영
- §9 `refresh_tokens`에 `lookup_id`/`replaced_by` 등 실제 컬럼을 반영하고, `alerts` 테이블 설명 추가
- §11 WOL 브로드캐스트 주소가 실제 인터페이스 넷마스크 기반으로 계산되며 `/24` 가정은 매칭 실패 시의 폴백임을 명시
- §1, §14에 `IMPLEMENTATION_GAPS.md`, `README.md` 참조 추가
- §12/§13 체크박스는 자동화된 검증 근거를 찾지 못해 변경하지 않음 (현재 server 87건, agent 20건의 자동 테스트가 `npm test`로 통과하나, 재시작 유지/실시간 UI/배포 항목을 직접 검증하는 자동화는 없음)

### v0.5 ('26. 09. 16.)

- 이 문서의 상태 표시(§5 기능 표, §10 일정, §12 테스트 기준, §13 DoD)를 실제 코드/자동 테스트 기준으로 동기화
- 페어링 코드를 특정 대상 디바이스에 바인딩하여 재페어링 시 다른 기기가 코드를 가로채지 못하도록 개선 (PR #2)
- 서버/웹/개발 서버 포트 설정을 `dmw.conf` (`SERVER_PORT`, `WS_PORT`, `WEB_DEV_PORT`, `WEB_PREVIEW_PORT`)로 통합 관리
- 로그아웃 시 회전된(rotate) Refresh Token의 살아있는 후속 세션까지 함께 무효화
- Discord/Slack 웹훅과 별개로 Telegram 봇 알림(`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`) 지원 추가
- 인증 / 페어링 / WOL / Agent 흐름에 대한 통합 테스트(`integration-auth`, `integration-devices`, `integration-wake`, `integration-agent`) 추가
- 웹 UI에 `NOT_PAIRED` 상태에서 WOL 요청 시 안내 문구(wake notice) 추가
- `npm test` 실행 전 `dist` 산출물을 삭제 후 재빌드하도록 변경하여 낡은 빌드로 인한 테스트 오탐 방지

### v0.4

- Agent 최초 설치 시 서버 IP + 일회용 페어링 코드를 통한 페어링 흐름 추가
- 디바이스 상태에 `NOT_PAIRED`를 추가하여 "Agent 미설치"와 "WOL 실패/OFFLINE"을 구분
- `devices` 테이블에 `agent_paired`, `paired_at` 컬럼 추가
- `pairing_codes` 테이블 추가 (코드, 만료시간, 사용여부 관리)
- 최신 상태 데이터를 `device_metrics_latest` 별도 테이블로 확정 (기존 devices 통합 옵션 제거)
- 사용자 인증에 Refresh Token 도입 (Access Token 유효기간 1일, Refresh Token은 해시로 DB 저장, httpOnly 쿠키 사용)
- `POST /auth/refresh`, `POST /auth/logout`, `POST /agent/pair` API 추가
- `refresh_tokens` 테이블 추가
- 관련 테스트 기준 및 완료 기준(DoD) 업데이트
- 서버 구조에 `pairing` 서비스 추가

### v0.3

- 기존 v0.2의 모호한 "실시간" 표현을 **10초 heartbeat 주기**로 구체화
- 온라인 / 오프라인 판정 기준을 **마지막 heartbeat 30초 초과 미수신**으로 명시
- JWT 방식으로 사용자 인증 확정
- Agent 인증과 사용자 인증의 책임을 분리
- WOL 성공 / 실패 판정 기준을 **최대 3분**으로 명시
- VPN을 통한 외부 접속을 네트워크 전제로 명시
- Agent → Server 통신 데이터 형식 추가
- 기본 API 책임 추가
- 기본 DB 구조 추가
- WebSocket을 이용한 최신 상태 반영 흐름 구체화
- 서버 구조를 Routes / Services / Repositories / WebSocket으로 분리
- 테스트 기준 추가
- Docker 재시작 후 데이터 유지 검증 추가
- `디스크(ROM)` 표현을 `Disk`로 통일
- M3를 통합 / UI / 테스트 단계로 세분화

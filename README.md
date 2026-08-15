# DMW (Device Manager Web)

DMW는 로컬 네트워크 내 장치를 웹 UI에서 관리하고, Wake-on-LAN, 에이전트 기반 상태 수집, 실시간 리소스 모니터링, 알림을 통합 제공하는 개인용 디바이스 관리 서비스입니다.

## 프로젝트 개요

- 목적: 홈/사무실 네트워크 장치 관리 간소화
- 핵심 기능: 장치 등록, 페어링, 상태 모니터링, WOL 전원 제어, 실시간 대시보드, 임계치 알림
- 기술 스택: Node.js, TypeScript, Fastify, React, Vite, SQLite, WebSocket, JWT, bcrypt
- 실행 환경: 로컬 개발, Docker Compose, 프로덕션 배포용 런타임 스크립트 준비

## 주요 기능

- 관리자 로그인 및 JWT 기반 인증
- Refresh Token 저장 및 rotation 처리
- 디바이스 등록 / 수정 / 삭제
- 일회용 페어링 코드 발급 및 만료 처리
- 에이전트 페어링 및 API Key 기반 인증
- WOL 매직 패킷 전송
- heartbeat 기반 온라인 / 오프라인 / WAKE_TIMEOUT 판단
- CPU / Memory / Disk 사용량 수집 및 최근 추세 표시
- 임계치 기반 경고 평가 및 webhook 알림
- WebSocket 실시간 상태 전달
- SQLite 기반 데이터 저장 및 영속화
- Linux/macOS, Windows 에이전트 데모 지원

## 저장소 구조

```text
DMW/
├── server/
│   ├── src/
│   │   ├── alerts.ts
│   │   ├── auth.ts
│   │   ├── config.ts
│   │   ├── db.ts
│   │   ├── deviceStatus.ts
│   │   ├── index.ts
│   │   ├── monitoring.ts
│   │   ├── ws.ts
│   │   └── *.test.ts
│   ├── .env.example
│   ├── package.json
│   └── tsconfig.json
├── web/
│   └── src/
├── agent-demo/
│   ├── agent.js
│   ├── agent-win.js
│   └── .env.example
├── docker-compose.yml
├── start-prod.sh
├── start-prod.ps1
├── start-prod.cmd
├── project.md
├── package.json
├── README.md
└── .gitignore
```

## 빠른 시작

### 1) 의존성 설치

```bash
npm install
```

### 2) 환경 변수 준비

```bash
copy server\.env.example server\.env
```

개발 환경에서는 아래 값이 기본으로 사용됩니다.

- `ADMIN_EMAIL=admin@dmw.local`
- `ADMIN_PASSWORD=admin123`
- `JWT_SECRET=dev-secret`

> 운영 환경에서는 반드시 강한 비밀값으로 교체해야 합니다.

### 3) 로컬 실행

```bash
npm run dev:server
npm run dev:web
```

### 4) 브라우저 접속

- Frontend: http://localhost:5173
- Backend: http://localhost:3001

## 기본 관리자 계정

개발 환경 기본값:

- 이메일: `admin@dmw.local`
- 비밀번호: `admin123`

> 프로덕션에서는 설정 파일 또는 환경 변수로 반드시 변경하세요.

## 프로덕션 실행

Linux / macOS:

```bash
./start-prod.sh
```

Windows CMD:

```cmd
start-prod.cmd
```

Windows PowerShell:

```powershell
./start-prod.ps1
```

## 테스트

아래 명령으로 서버 빌드와 테스트를 실행할 수 있습니다.

```bash
npm test
```

현재 검증 상태:

- `deviceStatus` 상태 판정 테스트 통과
- 프로덕션 보안 설정 검증 테스트 통과
- 전체 Node 테스트 통과

## 운영 환경 설정

프로덕션에서는 최소한 아래 항목을 반드시 설정해야 합니다.

```env
NODE_ENV=production
JWT_SECRET=your-strong-random-secret
ADMIN_EMAIL=admin@dmw.local
ADMIN_PASSWORD=strong-admin-password
PORT=3001
```

선택 항목:

```env
ALERT_CPU_THRESHOLD=85
ALERT_MEMORY_THRESHOLD=80
ALERT_DISK_THRESHOLD=90
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

## 프론트엔드 빌드 설정

프론트엔드는 Vite를 사용하여 빌드되며, API 호출 주소는 `VITE_API_BASE` 환경 변수에 의해 결정됩니다. VPN을 통해 접속하는 경우, 브라우저가 로컬 네트워크의 서버에 요청을 보내야 하므로 반드시 `.env` 파일에 실제 서버 IP를 설정해야 합니다.

예:

```env
VITE_API_BASE=http://192.168.1.100:3001
VITE_WS_BASE=ws://192.168.1.100:3001
```

기본값은 `http://localhost:3001`로, 로컬 개발 환경에서만 작동합니다.

```env
ALERT_CPU_THRESHOLD=85
ALERT_MEMORY_THRESHOLD=80
ALERT_DISK_THRESHOLD=90
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

## API 흐름 개요

### 관리자 로그인

- `POST /auth/login`
- 이메일/비밀번호 검증
- JWT access token 발급
- Refresh token은 HttpOnly 쿠키와 DB hash로 관리

### 디바이스 관리

- `GET /devices`
- `POST /devices`
- `PATCH /devices/:id`
- `DELETE /devices/:id`

### 페어링

- `POST /agent/pair`
- 일회용 pairing code 검증
- agent API key 발급
- device 상태를 `ONLINE`으로 전환

### Heartbeat

- `POST /agent/heartbeat`
- `Authorization: Bearer <apiKey>` 사용
- CPU / Memory / Disk 값을 수집
- metrics latest, history 저장
- WebSocket 방송

### WOL

- `POST /devices/:id/wake`
- 대상 장치의 IP, MAC 기반 매직 패킷 전송
- 성공 시 `WAKE_TIMEOUT` 상태로 전환

## Agent 실행

### Linux / macOS

```bash
cd agent-demo
node agent.js
```

### Windows

```powershell
cd .\agent-demo
node .\agent-win.js
```

환경 파일 예시:

```env
SERVER_URL=http://localhost:3001
PAIRING_CODE=ABCD1234
HEARTBEAT_INTERVAL_MS=10000
```

## Docker 실행

```bash
copy server\.env.example server\.env
docker compose up --build -d
```

접속 주소:

- Frontend: http://localhost:5173
- Backend: http://localhost:3001

## Docker 동작 원리

- backend 와 frontend 분리 실행
- SQLite 파일은 volume으로 유지
- healthcheck 추가
- local 및 production 비슷한 환경 구성

## 현재 구현 상태

현재 저장소는 MVP 수준으로 다음 기능이 포함되어 있습니다.

- [x] 관리자 인증
- [x] 장치 CRUD
- [x] 페어링 흐름
- [x] heartbeat 메트릭
- [x] 상태 판정
- [x] WOL 전원 제어
- [x] WebSocket 실시간 반영
- [x] Alert 평가
- [x] Docker 구성
- [x] Windows Agent 데모
- [x] 로컬 테스트 통과

## 참고 사항

- WOL은 네트워크 환경과 대상 장치의 BIOS/NIC 설정에 따라 동작 여부가 달라집니다.
- 실제 운영 배포 전에는 `JWT_SECRET`, `ADMIN_PASSWORD`, webhook URL, 네트워크 보안 정책을 반드시 재검토해야 합니다.
- 현재 구현은 개인/소규모 네트워크용 관리 도구로 설계되었으며, 대규모 다중 사용자 운영을 위해서는 사용자 관리와 권한 모델을 추가하는 것이 좋습니다.

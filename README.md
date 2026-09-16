# DMW (Device Manager Web)

DMW 는 로컬 네트워크 내 장치를 웹 UI 에서 관리하고, Wake-on-LAN, 에이전트 기반 상태 수집, 실시간 리소스 모니터링, 임계치 알림을 통합 제공하는 개인용 디바이스 관리 웹 서비스입니다.

## 📋 프로젝트 개요

| 항목 | 설명 |
|------|------|
| **목적** | 홈/사무실 네트워크 장치 관리 간소화 |
| **핵심 기능** | 장치 등록/수정/삭제, WOL 전원 제어, 실시간 대시보드, 임계치 알림 |
| **기술 스택** | Node.js, TypeScript, Fastify, React, Vite, SQLite, WebSocket, JWT, bcrypt |
| **실행 환경** | 로컬 개발, Docker Compose, 프로덕션 배포용 런타임 스크립트 |
| **버전** | v0.4 |

## 🚀 주요 기능

### 인증 및 보안
- **JWT 기반 인증**: Access Token (1 일 유효) + Refresh Token (7 일 쿠키 저장)
- **Refresh Token Rotation**: 보안 강화 및 만료 처리
- **bcrypt 해싱**: 비밀번호 평문 저장 방지

### 디바이스 관리
- **CRUD 연동**: 등록 / 수정 / 삭제 (에이전트 없이 WOL 만 쓰는 기기도 수동 등록 가능, 중복 MAC 은 거부)
- **일회용 페어링 코드**: 기기와 무관하게 발급, 10 분 자동 만료
- **에이전트 페어링**: 에이전트가 서버 주소 + 페어링 코드로 접속해 자신의 MAC/IP 를 직접 보고하면, 그 시점에 서버가 기기를 생성(또는 같은 MAC 의 기존 기기를 갱신). 코드 발급만으로 장치가 등록되지는 않음
- **에이전트 연결 관리**: `--unpair`로 현재 서버와의 페어링을 해제하고, `--repair --server ... --code ...`로 다른 서버에 연결 가능
- **로그인 자동 실행**: 첫 성공 페어링 뒤 사용자 로그인 시 에이전트를 다시 실행하도록 OS별 시작 항목을 등록
- **GitHub 자동 업데이트**: 시작 시와 6시간마다 `name0825/dmw` 최신 안정 릴리스를 SHA256 검증 후 확인
- **API Key 인증**: 에이전트 간 통신 보안 (bcrypt 기반 키 힌트 최적화)
- **OS별 에이전트**: Unix 계열과 Windows에서 CPU / 메모리 / 디스크 메트릭 수집 지원

### 상태 모니터링
- **WOL 매직 패킷 전송**: 포트 9 브로드캐스트
- **heartbeat 기반 상태 판정**:
  - ONLINE: 마지막 heartbeat 10 초 이내
  - OFFLINE: 30 초 이상 heartbeat 미보내
  - WAKE_TIMEOUT: WOL 후 3 분 이내 상태 변경 없음
- **CPU / 메모리 / 디스크 사용량**: 10 초 간격 수집, 7 일간 이력 보존 및 자동 정리
- **상태 이력 그래프**: 디바이스별 최근 CPU / 메모리 / 디스크 추이를 웹 UI에서 확인
- **WebSocket 실시간 전달**: JWT 인증(서브프로토콜로 액세스 토큰 전달) 후 클라이언트 자동 업데이트 (`PORT + 1` 에서 리슨, Docker 기본값 `3002`)
- **WOL 브로드캐스트 주소 지정**: `WOL_BROADCAST_ADDRESS` 미설정 시 대상 IP 의 /24 로 유도

### 알림 시스템
- **임계치 기반 경보**: 환경 변수로 커스터마이징 가능, `alerts` 테이블에 이력 저장
  - CPU: 85% 초과 → critical
  - 메모리: 80% 초과 → warning
  - 디스크: 90% 초과 → warning
- **5 분 쿨다운**: 스팸 알림 방지
- **Discord/Slack 웹훅**: 선택 사항 (미설정이어도 DB 기록은 남음)
- **오프라인 전환 알림**: `ONLINE` 또는 `WAKE_TIMEOUT`에서 `OFFLINE`으로 바뀌는 순간 한 번만 기록·전송
- **Telegram 알림**: `TELEGRAM_BOT_TOKEN`과 `TELEGRAM_CHAT_ID`를 모두 설정하면 웹훅과 독립적으로 전송

## 📦 기술적 특징

- **모듈화된 라우트 아키텍처**: 인증/기기/에이전트 도메인 분리 (SRP 준수)
- **입력 검증**: MAC/IP 정규화, 유효값 범위 체크 (0~100)
- **Rate Limiting**: 공개 라우트 DoS 방어
- **Docker Compose**: 서버 + 프론트엔드 한 번으로 실행
- **Health Check**: 컨테이너 자동 재시작 지원
- **Graceful Error Handling**: 500 오류 시 내부 정보 누출 방지

## 📁 저장소 구조

```
DMW/
├── server/                     # Fastify 백엔드
│   ├── src/
│   │   ├── alerts.ts           # 임계치 기반 경보 평가
│   │   ├── auth.ts             # JWT 토큰 발급/검증, 공개 라우트 정의
│   │   ├── config.ts           # 환경 변수 로드, 런타임 보안 검증
│   │   ├── deviceStatus.ts     # ONLINE/OFFLINE/WAKE_TIMEOUT 상태 판정
│   │   ├── index.ts            # 앱 초기화 (라우트 등록 + 스케줄러)
│   │   ├── routes.ts           # 라우트 등록 취합
│   │   ├── config/
│   │   │   └── constants.ts   # 포트/TTL/rate limit 등 상수
│   │   ├── database/
│   │   │   ├── index.ts       # Barrel module (db + ensureAdmin)
│   │   │   ├── auth.ts        # 인증 관련 DB 헬퍼
│   │   │   └── schema.ts      # 7 테이블 생성 (users, devices, pairing_codes, device_metrics_latest, device_metrics_history, refresh_tokens, alerts)
│   │   ├── middleware/
│   │   │   └── auth.ts        # 요청 인증 미들웨어
│   │   ├── routes/             # 도메인별 라우트
│   │   │   ├── auth.ts        # /auth/login/refresh/logout
│   │   │   ├── devices.ts     # /dashboard/devices/wake/alerts
│   │   │   ├── agent.ts       # /agent/pair/heartbeat
│   │   │   └── pairing.ts     # /pairing-codes (관리자 인증 필요)
│   │   ├── services/           # 도메인별 비즈니스 로직
│   │   │   ├── agent.ts       # 에이전트 페어링/heartbeat 처리
│   │   │   ├── devices.ts     # 기기 CRUD
│   │   │   ├── monitoring.ts  # 상태 업데이트 + 경보 모니터링 스케줄러
│   │   │   ├── notifications.ts # Discord/Slack 웹훅 및 Telegram 발송
│   │   │   ├── pairing.ts     # 페어링 코드 발급
│   │   │   ├── wake.ts        # WOL 매직 패킷 전송
│   │   │   └── ws.ts          # WebSocket 클라이언트 관리 + 브로드캐스트
│   │   ├── utils/
│   │   │   ├── crypto.ts      # API Key 생성
│   │   │   └── validation.ts  # MAC/IP 입력 정규화 유효성 검사
│   │   └── *.test.ts           # Unit 테스트
│   ├── Dockerfile
│   ├── package.json
│   └── tsconfig.json
├── web/                        # React 프론트엔드 (Vite)
│   ├── src/
│   │   ├── App.tsx             # 메인 앱
│   │   ├── api.ts              # API 호출 헬퍼
│   │   ├── constants.ts        # 상수 정의
│   │   ├── main.tsx            # 앱 진입점
│   │   ├── styles.css          # 스타일
│   │   ├── types.ts            # TypeScript 타입
│   │   └── vite-env.d.ts       # Vite 환경 타입 선언
│   ├── Dockerfile
│   ├── nginx.conf              # 프론트엔드 역프록시 설정
│   ├── vite.config.ts
│   ├── package.json
│   └── tsconfig.json
├── agent/                      # 런타임 의존성 없는 Node ESM 에이전트 CLI (자세한 사용법은 agent/README.md)
│   ├── src/
│   │   ├── index.js            # 진입점 (CLI 인자 파싱, 페어링/heartbeat 루프)
│   │   ├── client.js           # 서버 API 호출
│   │   ├── config.js           # 인자/환경 변수 설정 로드
│   │   ├── credentials.js      # 자격 증명 캐시 (agent/data/)
│   │   ├── autostart.js        # OS별 사용자 로그인 자동 실행
│   │   ├── http.js             # HTTP 요청 헬퍼
│   │   ├── network.js          # MAC/IP 조회
│   │   ├── retry.js            # 재시도 로직
│   │   └── update.js            # GitHub 릴리스 업데이트 및 SHA256 검증
│   ├── scripts/build-release.js # 릴리스 JSON/SHA256 생성
│   ├── package.json
│   └── README.md
├── docker-compose.yml          # 서버 + 프론트엔드 컨테이너 오케스트레이션
├── start.sh                   # 통합 스타트업 스크립트 (Linux/macOS): start.sh [dev|prod|agent]
├── start.ps1                  # 통합 스타트업 스크립트 (Windows PowerShell): .\start.ps1 [dev|prod|agent]
├── start.cmd                  # 통합 스타트업 스크립트 (Windows CMD): start.cmd [dev|prod|agent]
├── project.md                  # 상세 기획서
├── REFACTOR_LOG.md             # 최근 리팩토링 및 버그 수정 로그
├── package.json                # 루트 workspaces
├── README.md                   # 이 파일
└── .gitignore
```

## 🏃 빠른 시작

### 1️⃣ 의존성 설치

```bash
npm install
```

운영 모드(`start.sh prod`, `start.ps1 prod`, `start.cmd prod`)는 `server/.env`를 준비한 뒤 `npm ci`로 잠금 파일 기준 의존성을 설치하고 빌드합니다.

### 2️⃣ 환경 변수 준비

```bash
copy server\.env.example server\.env
```

개발 환경 기본값:

| 환경 변수 | 기본값 | 설명 |
|----------|--------|------|
| `ADMIN_EMAIL` | `admin@dmw.local` | 관리자 이메일 |
| `ADMIN_PASSWORD` | `admin123` | 관리자 비밀번호 |
| `JWT_SECRET` | `dev-secret` | JWT 서명 비밀키 |
| `CORS_ORIGIN` | `http://localhost:5173,http://127.0.0.1:5173` | 프론트엔드 허용_origin |
| `COOKIE_SECURE` | `true`(production) | HTTPS 전용 쿠키 (로컬 개발 시 `false` 로 변경 가능) |

> **운영 환경**: 반드시 강력한 `JWT_SECRET` 과 `ADMIN_PASSWORD` 로 교체 후 실행하세요.  
> `validateRuntimeConfig()` 가 production 모드에서 미설정/기본값인 경우 에러를 던집니다.

### 3️⃣ 로컬 실행

```bash
npm run dev:server
npm run dev:web
```

### 4️⃣ 브라우저 접속

| 서비스 | URL |
|--------|-----|
| 프론트엔드 | http://localhost:5173 |
| 백엔드 | http://localhost:3001 |

### 5️⃣ 에이전트 실행

웹의 대시보드에서 페어링 코드를 발급한 뒤, 관리 대상 PC 에서 에이전트를 실행합니다.

```bash
npm run agent
```

인자·환경 변수 등 상세 사용법은 [`agent/README.md`](./agent/README.md) 를 참고하세요.

에이전트 릴리스는 `agent/package.json`의 버전을 `X.Y.Z`로 올리고 같은 버전의 `agent-vX.Y.Z` 태그를 GitHub에 push하면 `.github/workflows/agent-release.yml`이 에이전트 테스트를 실행하고 JSON 및 SHA256 자산을 생성해 GitHub Release에 게시합니다. 로컬에서 전체 테스트는 `npm test`, 에이전트만은 `node --test agent/test/*.test.js`로 실행합니다.

## 🔧 개발 환경 설정

### Docker Compose 로 실행

```bash
docker-compose up
```

컨테이너 재시작 후에도 데이터는 `dmw_data` 볼륨으로 영속화됩니다.

### 모니터링 및 경보 환경 변수

```bash
ALERT_CPU_THRESHOLD=85    # CPU 임계치 (초과 시 critical 경보)
ALERT_MEMORY_THRESHOLD=80 # 메모리 임계치 (초과 시 warning 경보)
ALERT_DISK_THRESHOLD=90   # 디스크 임계치 (초과 시 warning 경보)
```

Telegram 알림을 사용하려면 BotFather에서 발급한 봇 토큰과 알림을 받을 채팅 ID를 둘 다 설정합니다. 둘 중 하나라도 비어 있으면 Telegram 전송은 시도하지 않습니다.

```dotenv
TELEGRAM_BOT_TOKEN=123456789:replace-with-bot-token
TELEGRAM_CHAT_ID=-1001234567890
```

프로젝트 루트의 `.env`에 값을 넣으면 Docker Compose가 두 값을 서버 컨테이너로 전달합니다.

```bash
docker compose up --build
```

## 📊 데이터 모델

| 테이블 | 설명 | 주요 필드 |
|--------|------|----------|
| `users` | 관리자 계정 | `email` (UNIQUE), `password_hash` (bcrypt), `role` |
| `devices` | 관리 대상 기기 | `mac_address`, `ip_address`, `agent_key_hash`, `agent_paired`, `status` |
| `pairing_codes` | 일회용 페어링 코드 (기기 무지정 또는 특정 기기 지정 발급) | `code` (8 자 16 진수), `expires_at` (10 분), `used_at`, `target_device_id` (nullable, 발급 시 지정된 기기), `device_id` (nullable, 소진 시 기록되는 감사 필드) |
| `device_metrics_latest` | 최신 상태 데이터 | `cpu_usage`, `memory_usage`, `disk_usage` |
| `device_metrics_history` | 상태 이력 데이터 (heartbeat 마다 기록, 7 일 보존) | `device_id`, `timestamp`, `cpu_usage`, `memory_usage`, `disk_usage` |
| `refresh_tokens` | 리프레시 토큰 | `token_hash` (bcrypt), `lookup_id` (16 자 힌트), `revoked` |
| `alerts` | 임계치 초과 경보 이력 | `device_id`, `level`, `metric`, `value`, `message` |

## 🛡️ 보안 특징

- **비밀 키 해싱**: 비밀번호 (bcrypt 10 rounds), Refresh Token (bcrypt 10 rounds), API Key (bcrypt 해시 + 12 자 힌트 DB 인덱싱)
- **JWT 1 일 유효**: Access Token 만료 시 Refresh Token 으로 재발급
- **HTTPS 전용 쿠키**: production 모드의 `COOKIE_SECURE=true` 로 리프레시 토큰이 평면 HTTP 로 유출되지 않음
- **Rate Limiting**: 인증/에이전트 라우트별 분당 요청 횟수 제한, 초과 시 429 반환
- **입력 검증**: MAC/IP 형식 검증, 0~100 범위 체크, WOL 브로드캐스트 주소 정규화
- **오류 정보 누출 방지**: 500 응답 시 내부 에러 메시지 노출 차단

## 📈 향후 계획 (Roadmap)

### P1 (선택 목표)
- [x] Windows 등 추가 OS 용 에이전트 공식 지원
- [x] 상태 이력 그래프 (7 일 보존 + 자동 삭제)
- [x] Discord/Slack 웹훅 및 Telegram 알림 연동

### P2 (향후)
- [ ] SSH 를 통한 원격 명령 실행 (보류)
- [ ] 다중 사용자/역할 기반 권한 관리
- [ ] 모바일 앱 (React Native)
- [ ] Docker Hub 공식 이미지 배포

## 🤝 기여

이 프로젝트는 개인용으로 개발되었습니다. 이슈나 제안은 환영합니다.

## 📄 라이선스

MIT

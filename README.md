# DMW (Device Manager Web)

DMW는 홈 네트워크 내 장치들을 웹 UI에서 관리하고, Wake-on-LAN, 에이전트 기반 상태 수집, 실시간 리소스 모니터링을 통합 제공하는 개인용 디바이스 관리 서비스입니다.

## 프로젝트 개요

- 목적: 홈 네트워크 장치 관리 간소화
- 핵심 기능: 장치 등록, 원격 전원 켜기, 상태 모니터링, 경고 알림, 실시간 대시보드
- 기술 스택: Node.js, TypeScript, Fastify, React, Vite, SQLite, WebSocket
- 실행 환경: 로컬 개발, Docker Compose 기반 실행, 홈서버 배포 고려

## 주요 기능

- 관리자 로그인 및 JWT 인증
- 디바이스 등록 / 수정 / 삭제
- 일회용 페어링 코드 발급
- 에이전트 페어링 및 API Key 기반 인증
- WOL 매직 패킷 전송
- heartbeat 기반 온라인 / 오프라인 판정
- CPU / Memory / Disk 사용량 모니터링
- 최근 리소스 추세 그래프 표시
- 임계치 초과 경고 및 Discord / Slack 웹훅 연동
- 실시간 WebSocket 상태 반영
- SQLite 기반 데이터 저장

## 시스템 구조

- server: Fastify + TypeScript 백엔드 API
- web: React + Vite 프론트엔드 대시보드
- agent-demo: Linux/macOS / Windows용 에이전트 데모
- docker-compose.yml: 컨테이너 기반 실행 구성

## 빠른 시작

### 1) 의존성 설치

```bash
npm install
```

### 2) 환경 변수 설정

```bash
copy server\.env.example server\.env
```

필수 값:
- JWT_SECRET
- ADMIN_PASSWORD
- 필요 시 webhook URL

### 3) 로컬 실행

```bash
npm run dev:server
npm run dev:web
```

또는 Windows에서:

### 4) 프로덕션 실행

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

> 프로덕션 실행은 `.env` 준비가 필요합니다.


```powershell
./start-dev.ps1
```

또는 CMD에서:

```cmd
start-dev.cmd
```

### 4) 브라우저 접속

- Frontend: http://localhost:5173
- Backend: http://localhost:3001

## 기본 관리자 계정

- 이메일: admin@dmw.local
- 비밀번호: admin123

> 운영 환경에서는 반드시 비밀번호와 JWT_SECRET을 변경하세요.

## 운영 환경 설정

### 경고 임계치 설정

```env
ALERT_CPU_THRESHOLD=85
ALERT_MEMORY_THRESHOLD=80
ALERT_DISK_THRESHOLD=90
```

### 웹훅 알림 설정

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
# 또는
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

설정 후, 장치의 CPU / 메모리 / 디스크 사용량이 임계치를 넘으면 자동으로 알림 전송이 실행됩니다.

## 운영용 환경 변수 예시

프로덕션 환경에서는 아래 파일을 복사해서 사용하세요.

```bash
copy server\.env.production.example server\.env
```

예시 파일 내용은 다음과 같은 항목을 포함합니다.
- PORT
- JWT_SECRET
- ADMIN_EMAIL
- ADMIN_PASSWORD
- DB_PATH
- 경고 임계치 값
- 웹훅 URL

> `.env` 파일은 Git에 포함시키지 않는 것을 권장합니다.

## 데모 시나리오

아래 시나리오는 관리자가 실제로 장치를 등록하고 에이전트가 상태를 보고하는 전체 흐름을 검증하는 데 사용합니다.

### 1) 서버와 웹 실행

```bash
npm run dev:server
npm run dev:web
```

### 2) 데모 환경 파일 생성

```bash
copy agent-demo\.env.example agent-demo\.env
```

### 3) 전체 시나리오 실행

```bash
npm run demo
```

이 스크립트는 다음 절차를 자동으로 수행합니다.
- 관리자 로그인
- 디바이스 등록
- 페어링 코드 발급
- 에이전트 페어링
- heartbeat 전송
- 디바이스 목록 확인

## Agent 실행

### Linux / macOS Agent

1. 서버와 웹을 시작합니다.
2. 관리자 로그인 후 디바이스를 등록합니다.
3. 화면에 표시되는 페어링 코드를 복사합니다.
4. 에이전트 환경 파일을 준비합니다.

```bash
copy agent-demo\.env.example agent-demo\.env
```

예시 값:

```env
SERVER_URL=http://localhost:3001
PAIRING_CODE=ABCD1234
DEVICE_ID=1
HEARTBEAT_INTERVAL_MS=10000
```

실행:

```bash
cd agent-demo
node agent.js
```

### Windows Agent

1. 관리 페이지에서 장치를 등록하고 페어링 코드를 발급받습니다.
2. Windows용 환경 파일을 준비합니다.

```powershell
Copy-Item .\agent-demo\.env.win.example .\agent-demo\.env
```

3. `.env` 파일을 실제 값으로 수정합니다.
4. 실행:

```powershell
cd .\agent-demo
node .\agent-win.js
```

## Docker 실행

프로덕션/로컬 컨테이너 실행 환경을 준비하려면 다음을 수행합니다.

```bash
cd D:\workspace\DMW
copy server\.env.example server\.env
docker compose up --build -d
```

접속 주소:
- Frontend: http://localhost:5173
- Backend: http://localhost:3001

## Docker 보안 가이드

적용된 보안 원칙:
- 비권한 사용자로 서버 컨테이너 실행
- 정적 파일 경로 접근 권한 제한
- healthcheck 추가로 서비스 상태 확인
- SQLite 데이터는 볼륨으로 유지

## 체크리스트

- [x] 서버 실행
- [x] 웹 실행
- [x] 관리자 로그인
- [x] 디바이스 등록
- [x] 페어링 코드 생성
- [x] 에이전트 heartbeat 전송
- [x] 웹 대시보드 실시간 반영
- [x] 경고 임계치 확인
- [x] Docker 구성 준비

## 전체 시나리오

- 관리자 로그인
- 디바이스 등록
- 일회용 페어링 코드 발급
- Agent가 서버에 POST /agent/pair 호출
- API Key 발급
- Agent가 POST /agent/heartbeat로 CPU / 메모리 / 디스크 전송
- 서버가 상태를 갱신하고 WebSocket으로 UI에 반영
- 임계치 초과 시 경고 알림 전송

## 참고 사항

- 현재 구현은 홈 네트워크 기반 개인 운영용 MVP입니다.
- 실제 운영 환경에서는 비밀번호, JWT_SECRET, 웹훅 URL을 별도 관리하세요.
- WOL은 네트워크 장비 및 대상 장치의 BIOS/NIC 설정에 따라 동작 환경이 달라질 수 있습니다.

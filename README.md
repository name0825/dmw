# DMW (Device Manager Web)

홈/사내 LAN에 있는 여러 장치를 하나의 웹 대시보드에서 관리하는 개인용(단일 관리자) 서비스입니다. Wake-on-LAN으로 원격 전원을 켜고, 각 장치에 설치한 에이전트가 CPU/메모리/디스크 사용률을 주기적으로 보고하여 온라인/오프라인 상태와 리소스 추이를 실시간으로 확인할 수 있습니다.

## 주요 기능

- **관리자 로그인**: bcrypt 해시 비밀번호, JWT 액세스 토큰 + httpOnly 리프레시 쿠키, 리프레시 토큰 로테이션, 로그아웃 시 토큰 폐기, 로그인/리프레시 요청 속도 제한
- **장치 관리**: 장치 등록/수정/삭제, 대시보드 목록 조회(이름·상태·IP·CPU 사용량·최근 접속 기준 정렬, 선택값은 브라우저에 저장)
- **페어링**: 10분 유효한 1회용 페어링 코드를 웹에서 발급 → 에이전트가 코드를 입력하면 서버가 MAC/IP로 장치를 등록·갱신하고 API 키를 발급
- **상태 모니터링**: 에이전트가 10초 주기로 heartbeat 전송, 서버는 CPU/MEM/Disk 지표를 저장(7일 보관)하고 UI에 차트로 표시(오프라인 장치의 사용률은 0으로 표시)
- **상태 판정**: `ONLINE` / `OFFLINE`(30초간 heartbeat 없음) / `NOT_PAIRED` / `WAKE_TIMEOUT`(WOL 후 3분 내 미기동)
- **Wake-on-LAN**: 매직 패킷 전송, 대상 IP 기준 /24 가정으로 브로드캐스트 주소 자동 계산(`WOL_BROADCAST_ADDRESS`로 재정의 가능)
- **실시간 갱신**: WebSocket으로 장치 상태를 즉시 반영
- **알림**: 오프라인 전환·리소스 임계값 초과 시 Discord/Slack/Telegram으로 알림(5분 디바운스, 메시지에 장치 이름 포함). 웹의 알림 목록은 5건만 먼저 보여주고 `더 보기`로 펼칩니다
- **에이전트 자동 실행·자동 업데이트**: 로그인 시 자동 실행 등록(Windows/macOS/Linux), GitHub 릴리스 기반 자체 업데이트

- **에이전트 버전 표시**: heartbeat로 받은 `agentVersion`을 저장하여 장치 카드에 `에이전트 v{버전}`으로 표시
- **SSH 원격 명령**: 장치 카드의 SSH 버튼에서 관리자 비밀번호 재입력 후 원격 명령 실행([SSH 원격 명령](#ssh-원격-명령) 참고)

남은 작업·한계는 [IMPLEMENTATION_GAPS.md](./IMPLEMENTATION_GAPS.md)를, 전체 기획은 [project.md](./project.md)를 참고하세요.

## 아키텍처

```
┌──────────────┐   HTTP(S)/WS   ┌──────────────┐   heartbeat/HTTP   ┌──────────────┐
│  web (React)  │ ─────────────▶│ server        │◀────────────────── │ agent (Node)  │
│  Vite 빌드     │◀───────────── │ (Fastify)     │ ─────wake(UDP)────▶│ 대상 PC        │
└──────────────┘   /api, /ws    │ SQLite (dmw.db)│                    └──────────────┘
                                 └──────────────┘
```

`server`가 REST API(`/api` 프리픽스, `routes.ts` 참고)와 WebSocket 서버를 같은 프로세스에서 서빙합니다. `web`은 정적 프런트엔드, `agent`는 의존성 없는 순수 Node 스크립트로 각 대상 PC에서 실행합니다.

## 빠른 시작

### 로컬 개발

```bash
npm install
npm run dev:server   # server/ 를 tsx 등으로 watch 실행 (기본 포트 3001, WS 3002)
npm run dev:web      # web/ 을 Vite dev 서버로 실행 (기본 포트 5173)
```

또는 OS별 런처 스크립트로 서버+웹을 한 번에 띄울 수 있습니다.

```bash
./start.sh     # macOS/Linux
./start.ps1    # Windows PowerShell
./start.cmd    # Windows cmd
```

포트는 저장소 루트의 `dmw.conf`(`SERVER_PORT`, `WS_PORT`, `WEB_DEV_PORT`)에서 관리하며, 실제 환경 변수가 설정돼 있으면 항상 우선합니다. `DMW_CONFIG` 환경 변수로 다른 설정 파일 경로를 지정할 수도 있습니다.

프로덕션 빌드/실행:

```bash
npm run build   # server, web 순서로 빌드
npm start       # server/dist 실행
```

### Docker

```bash
cp .env.example .env
# .env 에서 JWT_SECRET, ADMIN_PASSWORD 등을 채운 뒤
docker compose up -d --build
```

`docker-compose.yml`은 `server`, `web` 두 컨테이너를 `network_mode: host`로 실행합니다(리눅스 호스트 전용). `server`는 `BIND_HOST=127.0.0.1`로 바인딩되어 호스트 루프백을 통해서만 접근 가능하며, `web`(nginx)이 `/api/` → `127.0.0.1:3001`, `/ws` → `127.0.0.1:3002`로 프록시합니다(`web/nginx.conf`, `web/nginx/dmw-locations.conf`). 데이터는 `dmw_data` 볼륨(`/app/data`)에 저장됩니다. `JWT_SECRET`과 `ADMIN_PASSWORD`는 루트 `.env`에 반드시 설정해야 컨테이너가 기동합니다.

개발용으로는 `docker-compose.dev.yml` 오버레이를 함께 지정하면 두 서비스가 Dockerfile의 `source` 스테이지로 빌드되고, `./server`·`./web`을 바인드 마운트해 `tsx watch`/Vite dev 서버로 핫 리로드됩니다. `docker-compose.prod.yml`은 현재 덮어쓰는 항목이 없는 운영용 자리표시자로, 기본 `docker-compose.yml`만 쓴 것과 같습니다.

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build     # 개발 (핫 리로드)
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build  # 운영
```

런처 스크립트에 `docker` 인자(또는 `DMW_DOCKER=1`)를 주면 위 명령을 대신 실행합니다: `dev`/`agent`는 dev 오버레이, `prod`는 prod 오버레이(백그라운드). 루트 `.env`가 없고 `JWT_SECRET`/`ADMIN_PASSWORD`도 설정돼 있지 않으면 시작 전에 중단합니다. 인자 없이 실행하면 기존처럼 Docker 없이 로컬에서 실행합니다.

```bash
./start.sh dev docker
./start.sh prod docker
```

> `docker-compose.yml`의 `server.environment`는 `DISCORD_WEBHOOK_URL`, `SLACK_WEBHOOK_URL`, `TELEGRAM_BOT_TOKEN`/`TELEGRAM_CHAT_ID`, `WOL_BROADCAST_ADDRESS`, `SSH_KEY_PATH`를 `.env`에서 컨테이너로 전달합니다. SSH 키 기본 위치는 `dmw_data` 볼륨의 `/app/data/ssh/dmw_ed25519`입니다.

### HTTPS로 서비스하기

인증서를 `./certs`에 준비한 뒤 `docker-compose.https.yml`을 함께 지정하면 nginx가 HTTPS(기본 `WEB_HTTPS_PORT=8443`)로도 서비스하고, 서버 쿠키에 `COOKIE_SECURE=true`가 적용됩니다.

```bash
docker compose -f docker-compose.yml -f docker-compose.https.yml up -d --build
```

> 기본 평문 HTTP 스택은 LAN 전용이며 이 구성에서는 리프레시 쿠키에 Secure 플래그가 없으므로, HTTPS 오버레이 사용을 권장합니다.

## 설정 (환경 변수)

서버(`server/src/config.ts`)가 읽는 환경 변수입니다. `.env`(dotenv) 또는 `dmw.conf`/`DMW_CONFIG`로 지정한 파일에서 로드하며, 실제 셸 환경 변수가 항상 우선합니다. 예시 파일: `.env.example`(Docker Compose용), `server/.env.example`, `server/.env.production.example`, `agent/.env.example`.

| 변수 | 설명 | 기본값 |
|---|---|---|
| `NODE_ENV` | 실행 환경. `development`/`test`가 아닌 모든 값(미설정 포함)은 프로덕션으로 취급되어 아래 필수값 검증과 `COOKIE_SECURE=true` 기본값이 적용됨. 개발 기본값이 필요하면 `development`로 명시(`npm run dev`는 자동 지정) | (미설정 = `production`) |
| `PORT` / `SERVER_PORT` | HTTP API 포트 | `3001` |
| `WS_PORT` | WebSocket 포트 | `PORT + 1` |
| `BIND_HOST` | HTTP/WS 바인딩 주소 (Docker host 네트워크에서는 `127.0.0.1`) | `0.0.0.0` |
| `DB_PATH` | SQLite DB 파일 경로 | `./data/dmw.db` |
| `DMW_CONFIG` | `dmw.conf` 대신 읽을 설정 파일 경로 | (없음) |
| `JWT_SECRET` | JWT 서명 비밀키. 프로덕션에서는 32자 이상 & 플레이스홀더 금지, 미설정 시 기동 실패 | `dev-secret`(개발 전용) |
| `ADMIN_EMAIL` | 관리자 이메일 | `admin@dmw.local` |
| `ADMIN_PASSWORD` | 관리자 비밀번호. 프로덕션에서는 플레이스홀더 금지, 미설정 시 기동 실패 | `admin123`(개발 전용) |
| `CORS_ORIGIN` / `FRONTEND_ORIGIN` | 허용할 CORS origin(쉼표 구분). 프로덕션에서는 필수 | (비움) |
| `COOKIE_SECURE` | 리프레시 쿠키 Secure 플래그 (`true`/`false`, 빈 값은 미설정과 같음). 기본 `docker-compose.yml`은 평문 HTTP용으로 `false`, `docker-compose.https.yml`은 `true` | 프로덕션 취급이면 `true` |
| `WOL_BROADCAST_ADDRESS` | WOL 브로드캐스트 주소 고정값. 비우면 대상 IP 기준 /24로 추정 | (비움) |
| `SSH_KEY_PATH` | SSH 원격 명령용 서버 개인키(ed25519) 경로. 없으면 첫 사용 시 0600 으로 생성. 공개키는 UI(기기 카드의 SSH)에 표시되며 대상 기기의 `authorized_keys`에 추가해야 함. sudo 명령은 대상 기기에서 NOPASSWD 필요. 키 파일을 교체·삭제하면 서버를 재시작해야 반영됨 | `DB_PATH` 옆 `ssh/dmw_ed25519` |
| `DISCORD_WEBHOOK_URL` | Discord 알림 웹훅 URL | (비움) |
| `SLACK_WEBHOOK_URL` | Slack 알림 웹훅 URL(`DISCORD_WEBHOOK_URL` 미설정 시 사용) | (비움) |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 텔레그램 알림 봇 토큰/채팅 ID | (비움) |

이 외에 `server/.env.example`에는 알림 임계값(`ALERT_CPU_THRESHOLD` 등, 기본 85/80/90)도 정의돼 있습니다.

## 에이전트 설치·페어링

1. 웹 대시보드에서 페어링 코드를 발급받습니다(10분 유효, 1회용).
2. 대상 PC에서 에이전트를 실행합니다.

   ```bash
   node agent/src/index.js --server 192.168.0.10:3001 --code ABC123 --name "내 PC"
   ```

   인자를 생략하면 TTY 환경에서 서버 주소/코드를 입력하라는 프롬프트가 뜹니다.
3. 페어링에 성공하면 서버가 MAC/IP로 장치를 등록·갱신하고, 에이전트는 자격 증명을 `agent/data/credentials.json`(또는 `DMW_STATE_DIR`)에 캐시한 뒤 10초 주기로 heartbeat를 전송합니다. 이후 실행부터는 페어링 코드가 필요 없습니다.
4. 첫 페어링 성공 후 사용자 로그인 시 자동 실행이 등록됩니다(부팅 서비스 아님). `--enable-autostart`/`--disable-autostart`로 수동 제어할 수 있습니다.

서버를 옮기거나 페어링을 해제하려면 `--unpair`, `--repair --server <url> --code <code>`를 사용합니다. 전체 CLI 인자·환경 변수·자동 업데이트 동작은 [agent/README.md](./agent/README.md)를 참고하세요.

## SSH 원격 명령

서버가 `ssh2`로 대상 기기에 직접 접속합니다. 서버 전용 ed25519 키 하나를 자동 생성해 사용합니다(`SSH_KEY_PATH`).

1. 웹의 장치 카드 `SSH` 버튼을 열어 서버 공개키(`GET /ssh/public-key`)를 복사해 대상 기기의 `~/.ssh/authorized_keys`에 추가합니다.
2. 호스트 키를 스캔(`POST /devices/:id/ssh/scan`)하고 표시된 지문을 확인한 뒤 사용자 이름/포트와 함께 저장합니다(`PUT /devices/:id/ssh`, 최초 신뢰 TOFU). 설정 해제는 `DELETE /devices/:id/ssh`입니다. 저장·해제 시 관리자 비밀번호가 필요합니다.
3. 명령을 실행합니다(`POST /devices/:id/commands` `{command, password}`). 실행할 때마다 관리자 비밀번호를 다시 입력해야 하며 틀리면 403입니다. 이력은 `GET /devices/:id/commands?limit=`로 조회합니다(출력 본문 제외).

제한:
- PTY 없는 비대화형 자유 명령이며 30초 제한 시간이 지나면 중단합니다(원격 프로세스에 KILL 시도). stdout/stderr는 각각 64KB까지만 저장합니다.
- 장치당 동시 1건, 전체 동시 4건, 요청 속도 제한 10회/윈도입니다.
- root 권한이 필요한 명령은 대상 기기에 NOPASSWD sudo 설정이 필요합니다.
- 실행 기록(`command_runs`)은 90일 보관하며 장치를 삭제해도 남습니다. 설정 변경과 재인증 실패도 감사 기록됩니다.
- 신뢰한 호스트 키는 저장 당시 장치 IP에 묶입니다. 장치 IP가 바뀌면 명령 실행이 409로 거부되므로 호스트 키를 다시 스캔·저장해야 합니다. IP 바인딩 도입 전에 저장한 기존 SSH 설정도 IP 정보가 없어 같은 이유로 거부되니, 업그레이드 후 한 번씩 다시 스캔·저장하세요.

## API 개요

모든 엔드포인트는 `/api` 프리픽스로 서빙됩니다(`server/src/routes.ts`, `server/src/routes/*.ts`).

| 메서드 | 경로 | 설명 |
|---|---|---|
| GET | `/health` | 헬스체크 |
| POST | `/auth/login` | 관리자 로그인 |
| POST | `/auth/refresh` | 액세스 토큰 갱신 |
| POST | `/auth/logout` | 로그아웃(리프레시 토큰 폐기) |
| GET | `/dashboard` | 대시보드용 장치+상태 요약 |
| GET | `/devices` | 장치 목록 |
| POST | `/devices` | 장치 등록 |
| PATCH | `/devices/:id` | 장치 수정 |
| DELETE | `/devices/:id` | 장치 삭제 |
| GET | `/devices/:id/history` | 장치의 리소스 지표 이력 |
| POST | `/devices/:id/wake` | 해당 장치로 WOL 매직 패킷 전송 |
| GET | `/alerts` | 발생한 알림 목록 |
| GET | `/ssh/public-key` | SSH용 서버 공개키 조회 |
| POST | `/devices/:id/ssh/scan` | 대상 기기 SSH 호스트 키 스캔 |
| PUT / DELETE | `/devices/:id/ssh` | SSH 설정 저장/해제(비밀번호 재입력) |
| POST / GET | `/devices/:id/commands` | 원격 명령 실행(비밀번호 재입력) / 실행 이력 조회 |
| POST | `/pairing-codes` | 페어링 코드 발급 |
| POST | `/agent/pair` | 에이전트 페어링(코드 → API 키) |
| POST | `/agent/heartbeat` | 에이전트 상태 보고 |
| POST | `/agent/unpair` | 에이전트 페어링 해제 |

인증이 필요한 엔드포인트는 JWT 액세스 토큰(로그인/리프레시로 발급)을 사용하고, 에이전트 전용 엔드포인트는 페어링으로 발급된 API 키를 사용합니다. 장치 상태 변경은 WebSocket(`/ws`, `WS_PORT`)으로도 실시간 전파됩니다.

## 디렉터리 구조

```
DMW/
├── server/                     # Fastify + TypeScript API/WS 서버
│   └── src/
│       ├── index.ts            # 서버 부트스트랩
│       ├── routes.ts           # 라우트 등록, /health
│       ├── routes/             # auth, devices, pairing, agent, ssh 라우트
│       ├── services/           # devices, agent, wake(WOL), monitoring, pairing, notifications, ws, ssh, sshKey
│       ├── database/           # SQLite 연결, 스키마, 인증 관련 쿼리
│       ├── middleware/auth.ts  # JWT 인증 미들웨어
│       ├── utils/              # crypto, validation 유틸
│       ├── config.ts           # 환경 변수 로딩·검증
│       ├── config/constants.ts # 상태값·임계값·레이트리밋 등 상수
│       └── *.test.ts           # 단위/통합 테스트
├── web/                         # React + Vite 프런트엔드
│   ├── src/
│   │   ├── App.tsx             # 대시보드 UI 진입점
│   │   ├── api.ts              # 서버 API 클라이언트
│   │   ├── hooks/               # useAuth, useDevices, useDeviceSocket
│   │   └── types.ts, constants.ts
│   └── nginx.conf, nginx/       # Docker용 nginx 설정(HTTP/HTTPS 프록시)
├── agent/                       # 의존성 없는 순수 Node ESM 에이전트
│   └── src/
│       ├── index.js            # CLI 진입점
│       ├── client.js, http.js  # 서버 통신
│       ├── config.js, credentials.js
│       ├── metrics/             # windows.js, unix.js, index.js
│       ├── network.js, retry.js, autostart.js, update.js
│   └── test/*.test.js           # 수명주기 테스트
├── dmw.conf                     # 포트 기본값 (SERVER_PORT/WS_PORT/WEB_DEV_PORT 등)
├── docker-compose.yml           # server + web 컨테이너 정의
├── docker-compose.dev.yml       # 개발용 오버레이(핫 리로드)
├── docker-compose.prod.yml      # 운영용 오버레이(자리표시자)
├── docker-compose.https.yml     # HTTPS 서빙용 오버레이
├── start.sh / start.ps1 / start.cmd  # 로컬 개발용 런처 스크립트
├── project.md                   # 프로젝트 기획서
└── IMPLEMENTATION_GAPS.md       # 미구현·한계 목록
```

## 테스트

```bash
npm test
```

`server`를 빌드한 뒤 `node --test`로 `server/dist/**/*.test.js`(단위/통합 테스트)와 `agent/test/*.test.js`(에이전트 수명주기 테스트)를 실행합니다. CI(`.github/workflows/ci.yml`)에는 위 테스트를 실행하는 `ci` 잡과, compose 빌드·기동 후 서버 컨테이너를 재시작해 데이터 유지를 확인하는 `docker` 잡이 있습니다.

## 미구현·한계

SSH 원격 명령은 실기기 수동 검증이 남아 있고, Docker CI 잡은 첫 실행 전이며, 브라우저 E2E는 없습니다. 전체 목록은 [IMPLEMENTATION_GAPS.md](./IMPLEMENTATION_GAPS.md)를 확인하세요.

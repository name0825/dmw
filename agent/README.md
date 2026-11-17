# dmw-agent

DMW 서버에 CPU/메모리/디스크 사용률을 주기적으로 보고하는 CLI 에이전트입니다. 런타임 의존성이 없고 Node 20+ 만 있으면 실행됩니다.

## 사용법

1. 웹에서 페어링 코드를 발급받습니다. 코드를 발급하는 것만으로 장치가 등록되지는 않습니다.
2. 대상 PC에서 에이전트를 실행합니다.
   ```bash
   node agent/src/index.js
   ```
3. 서버 주소와 페어링 코드를 입력하라는 프롬프트가 나오면 입력합니다 (TTY 환경일 때만 프롬프트가 뜹니다).
   ```
   서버 주소 (예: 192.168.0.10:3001): 192.168.0.10:3001
   페어링 코드: ABC123
   ```
4. 페어링이 성공하면 서버가 MAC/IP를 확인해 장치를 등록·갱신하고 자격 증명을 로컬에 캐시합니다. 이후 heartbeat를 전송하며, 다음 실행부터는 페어링 코드를 다시 입력할 필요가 없습니다. 첫 성공 페어링 뒤 사용자 로그인 시 자동 실행도 등록됩니다(부팅 서비스가 아닙니다).

인자나 환경 변수로 값을 미리 지정하면 프롬프트 없이 바로 실행됩니다.

```bash
node agent/src/index.js --server 192.168.0.10:3001 --code ABC123 --name "내 PC"
```

## CLI 인자

| 인자 | 설명 |
|---|---|
| `--server <url>` | 서버 주소 (스킴 생략 가능, 예: `192.168.0.10:3001`) |
| `--code <code>` | 페어링 코드 |
| `--name <name>` | 이 장치의 표시 이름 (미지정 시 서버가 MAC 뒷자리로 이름을 생성) |
| `--interval <ms>` | heartbeat 전송 주기, 기본 10000ms |
| `--unpair` | 현재 서버에 페어링 해제를 요청하고 로컬 자격 증명을 삭제한 뒤 종료 |
| `--repair`, `--reset` | 현재 서버에서 해제한 뒤 `--server`와 `--code`로 새 서버에 다시 페어링 |
| `--force` | `--unpair`/`--repair`에서 서버에 연결할 수 없어도 로컬 연결만 해제하고 진행(원격 API 키는 남을 수 있음) |
| `--enable-autostart` / `--disable-autostart` | 사용자 로그인 시 자동 실행 등록 / 해제(Windows Startup VBS, macOS LaunchAgent, Linux 데스크톱 자동 시작) |
| `--update` / `--no-update` | GitHub 최신 안정 릴리스 즉시 확인·설치 / 이번 실행의 자동 업데이트 확인 생략 |
| `-h`, `--help` | 도움말 출력 |

## 환경 변수

| 변수 | 설명 |
|---|---|
| `DMW_SERVER_URL` | 서버 주소 |
| `DMW_PAIRING_CODE` | 페어링 코드 |
| `DMW_AGENT_NAME` | 장치 표시 이름 |
| `DMW_HEARTBEAT_INTERVAL_MS` | heartbeat 전송 주기(ms) |
| `DMW_STATE_DIR` | 자격 증명 캐시 파일을 저장할 디렉터리 (기본: `agent/data`) |

자동 업데이트는 시작 시와 6시간마다 GitHub `name0825/dmw`의 최신 안정 릴리스를 확인합니다. 다운로드한 JSON의 SHA256을 검증하며, `--help` 스모크 검사가 실패하면 설치하지 않습니다. 런타임 롤백은 제공하지 않습니다. 업데이트 과정에서 Node.js 설치 경로와 원본 `agent/data` 및 heartbeat 주기 설정은 유지됩니다.

`.env` 파일로 관리하고 싶다면 `agent/.env.example` 을 참고해 `.env` 를 만들고 Node의 내장 기능으로 실행하세요.

```bash
node --env-file .env agent/src/index.js
```

## 자격 증명 캐시

페어링에 성공하면 `agent/data/credentials.json` (또는 `DMW_STATE_DIR` 로 지정한 경로)에 `serverUrl`, `deviceId`, `apiKey` 가 저장됩니다. 페어링 코드는 1회용이므로, 캐시가 있으면 재실행 시 페어링을 건너뛰고 바로 heartbeat 를 시작합니다.

현재 서버와의 연결을 끊고 다른 서버로 옮기려면 다음처럼 실행합니다.

```bash
node agent/src/index.js --unpair
node agent/src/index.js --repair --server 192.168.0.20:3001 --code NEWCODE
```

서버에서 장치가 삭제되거나 키가 무효화되어 heartbeat가 401/403을 받으면, 에이전트는 해당 자격 증명을 비우고 전송을 중단한 채 새 페어링을 기다립니다. 이 경우 웹에서 새 페어링 코드를 발급받아 별도 터미널에서 `--repair` 옵션으로 실행하세요.

```bash
node agent/src/index.js --repair --server 192.168.0.20:3001 --code NEWCODE
```

## Windows에서 실행

PowerShell `Get-CimInstance` 로 CPU/메모리/디스크 사용률을 수집합니다 (Windows 11 24H2+ 에서 제거된 `wmic` 대신 사용).

```powershell
node agent\src\index.js
```

## Linux/macOS에서 실행

메모리는 `os.totalmem()`/`os.freemem()`(macOS 는 `vm_stat` 의 앱 메모리(anonymous - purgeable) + wired + compressed 페이지, 활성 상태 보기의 "사용된 메모리" 기준), CPU 는 두 시점의 `os.cpus()` tick 차분으로 계산합니다. 디스크 사용률은 `df -P` 결과에서 `(전체 - 가용) / 전체`로 계산하며, 수집에 실패하면 heartbeat 요청에서 해당 필드를 생략합니다.

Linux에서는 물리 디스크를 용량 및 확인 가능한 온도와 함께 표시하고, 파일시스템 사용률은 루트 경로 `/`만 수집합니다. `/boot/efi`와 다른 마운트 경로는 수집하지 않습니다. 마운트되지 않은 디스크도 목록에 포함되지만 사용률은 계산하지 않으며, `/etc/pve` 같은 가상 파일시스템은 제외합니다. 물리 디스크는 `lsblk`로 수집하고 사용할 수 없으면 sysfs를 이용합니다. 물리 디스크는 최대 32개이며, 대표 디스크 사용률은 `/`의 사용률입니다. macOS에서는 APFS 데이터 볼륨 `/System/Volumes/Data` 등 `df`로 확인되는 볼륨을 표시합니다.

```bash
node agent/src/index.js
```

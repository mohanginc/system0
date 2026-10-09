# system0

주문 엑셀의 상품명을 정리하는 로컬 원페이지 앱입니다. HTML·CSS·JavaScript, Node.js, SQLite로 구성하며, 현재는 일반 업무 화면과 API를 제공합니다.

## 운영 컴퓨터 설치

Windows 10·11의 64비트 환경에서 `outputs/installer/system0-setup-0.1.4.exe` 하나를 옮겨 실행합니다. Node.js와 라이브러리가 포함되어 있으며 관리자 권한은 필요하지 않습니다. 최초 설치 화면에서 API 키를 입력하고, 바탕화면 **system0 주문 상품명 정리**를 실행합니다. 브라우저가 자동으로 열리며 서버 종료는 실행 창에서 `Ctrl+C`입니다.

프로그램은 `%LOCALAPPDATA%/Programs/system0`, 설정은 `%LOCALAPPDATA%/system0/.env`, DB는 기존 기본 경로에 저장합니다. 운영판 기본 접속 주소는 <http://127.0.0.1:3100>입니다. 새 컴퓨터에는 빈 DB로 시작하며, 기존 작업 이전은 아래 백업·복구 방법을 따릅니다. 재설치와 프로그램 제거는 DB와 설정을 보존합니다. 업데이트 전에 실행 중인 앱을 종료합니다.

설치 파일을 다시 만들 때 `npm.cmd run installer:build`를 실행합니다. 공식 Node.js 24.21.0과 Inno Setup 7.1.0을 내려받아 SHA-256을 확인한 뒤, 실행에 필요한 파일만 패키징합니다. 개발 컴퓨터의 `.env`와 DB는 포함하지 않습니다. `npm.cmd run installer:test`는 완성된 EXE를 임시 폴더에 설치해 번들 실행·엑셀 다운로드·업데이트·데이터 보존을 확인하고 정리합니다. 실제 운영 DB와 키는 사용하지 않으며 API 호출 비용도 발생하지 않습니다.

0.1.4 설치판의 **검수 완료 즉시 저장**은 가벼운 CMD 패치로 적용할 수 있습니다. 프로젝트 폴더에서 PowerShell로 직접 빌드하고 검사합니다.

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File installer/build-patch.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/patch.test.ps1
```

기본 결과는 `outputs/installer/system0-patch-review-save.cmd`입니다. 다른 출력 경로가 필요하면 빌드 명령에 `-OutputFile`을 지정합니다. 패치 파일 하나를 운영 컴퓨터로 옮긴 뒤 앱 실행 창에서 `Ctrl+C`로 종료하고, CMD를 더블클릭합니다. 적용 후 기존 아이콘으로 앱을 실행하고 브라우저를 새로고침합니다.

이 패치는 기본 경로 `%LOCALAPPDATA%/Programs/system0`에 설치된 0.1.4 전용이며 `public/app.js`만 교체합니다. DB와 `.env`는 유지합니다. 처음 설치하는 컴퓨터에는 전체 설치 파일이 필요합니다.

## 개발 컴퓨터 실행

Node.js 24 이상이 필요합니다. 프로젝트 폴더에서 실행합니다.

```powershell
npm.cmd ci
npm.cmd start
```

브라우저에서 <http://127.0.0.1:3000>에 접속합니다. 서버 종료는 실행한 터미널에서 `Ctrl+C`입니다.

`.env`에 `OPENAI_API_KEY`를 설정합니다. 기본 모델은 `gpt-6.1-sol`이며, 변경할 때만 `OPENAI_MODEL`을 지정합니다. 설정 예시는 `.env.example`에 있습니다. 키는 백엔드에서만 읽습니다. `.env`는 Git에서 제외되지만 OneDrive 동기화는 별개입니다.

## 기능과 사용

파일 불러오기 → 상품명 정리 → 직원 검수·저장 → 엑셀 다운로드 순서로 사용합니다. 화면별 사용법, 데이터 처리 범위와 API는 [기능 안내](docs/features.md)에 정리합니다.

## 저장과 백업

Windows 기본 DB는 `%LOCALAPPDATA%/system0/system0.sqlite`입니다. 이 컴퓨터에서는 `C:/Users/s705d/AppData/Local/system0/system0.sqlite`에 저장됩니다. OneDrive 밖에 두며, 경로를 변경할 때는 `.env`의 `DATABASE_PATH`를 설정합니다. 업로드한 원본 파일, 원본 행과 작업 이력도 이 DB에 저장됩니다.

화면 아래 **데이터 백업**은 실행 중인 DB의 일관된 백업본을 다운로드합니다. 백업본은 OneDrive 등에 보관할 수 있습니다. 복구할 때는 서버를 종료하고 기존 DB를 다른 폴더에 보관합니다. 같은 이름의 `-wal`·`-shm` 파일이 남아 있으면 함께 옮겨 보관한 뒤, 백업본을 기본 DB 경로에 복사하여 실행합니다. 복구 후 작업 목록과 상품명·검수 내용을 확인하세요. 실행 중인 DB 파일을 직접 동기화하지 않습니다.

현재 서버는 이 컴퓨터의 `127.0.0.1`에서만 접근할 수 있습니다. 여러 직원에게 공개하거나 외부에 배포할 때는 접속·인증 방식을 별도로 정합니다. PostgreSQL·Google Cloud와 채팅 연결은 이후 필요할 때 검토합니다.

## 검증

```powershell
npm.cmd test
```

테스트는 가져오기 누락·원본 보존, 직원 수정 보존, 잘못된 AI 응답, 중간 실패·재시도, 삭제한 작업·행의 제외와 DB 보존, 엑셀 내보내기와 백업 복구를 확인합니다. 테스트의 AI 응답은 모의 응답이며 API 비용이 발생하지 않습니다. 로컬 `reference-data/orders/`가 있으면 실제 주문 54개 파일·1,063행도 검사합니다.

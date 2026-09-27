# 개인 도메인 연결

이 서버의 권장 주소는 `https://books.catfish.cc`입니다. 앱과 책은 라즈베리 파이에 보관하고, Cloudflare Tunnel이 도메인의 요청을 `http://127.0.0.1:3000`으로 전달합니다. 공유기의 포트 전달 설정은 필요하지 않습니다. 루트 도메인 `catfish.cc`의 기존 웹사이트는 변경하지 않습니다.

## 현재 서버의 실행 환경

프로젝트의 `.runtime/node/`에는 Node.js 24, `.runtime/bin/cloudflared`에는 Cloudflare 연결 프로그램을 설치합니다. 두 폴더는 Git과 Docker 빌드에서 제외됩니다. 현재 서버에 설치한 바이너리는 공식 배포 파일의 SHA-256을 검증했습니다. 다른 서버에 옮길 때는 그 서버에 맞는 공식 바이너리를 같은 경로에 설치하세요.

프로젝트 루트에서 다음 명령으로 설정합니다. `.env.local`에 이미 비밀번호가 있으면 유지됩니다.

```bash
.runtime/node/bin/node scripts/setup.mjs --origin=https://books.catfish.cc
```

최초 관리자 아이디는 `.env.local`의 `ADMIN_USERNAME`(기본 `admin`), 초기 비밀번호는 `BOOKS_PASSWORD` 값입니다. 이 파일은 본인만 읽을 수 있도록 권한을 제한하며 Git에 포함되지 않습니다. 최초 계정 생성 후에는 **Account settings**에서 비밀번호를 변경합니다. 환경 변수 변경은 기존 계정의 비밀번호를 변경하지 않습니다.

지인에게는 **Account settings → Manage members → Create invitation**에서 만든 초대 링크를 전달하세요. 회원은 자기 아이디와 비밀번호로 책을 읽고 개인 진도를 저장하며, 원본 PDF 다운로드·책 업로드·삭제·제목 수정은 관리자만 가능합니다. 뷰어는 서버가 만든 페이지 이미지만 받아 표시하며 원본 PDF는 관리자 다운로드 API에서만 제공합니다. 초대 링크는 7일 안에 한 번만 사용할 수 있습니다.

## 앱 자동 실행

빌드를 먼저 완료한 뒤 사용자 서비스를 설치합니다.

```bash
export PATH="$PWD/.runtime/node/bin:$PATH"
npm run build
node scripts/install-services.mjs
```

사용자 서비스 `comic-shelf.service`가 앱을 실행하고 비정상 종료 시 다시 시작합니다. SSH 연결 종료 후에도 실행을 유지하려면 사용자 lingering 설정이 필요합니다. 현재 서버에서는 `loginctl show-user "$USER" -p Linger`로 확인할 수 있습니다. `Linger=no`이면 `loginctl enable-linger "$USER"`를 실행합니다.

## Cloudflare 계정 승인과 연결

앱을 준비한 뒤 다음 명령을 실행합니다.

```bash
.runtime/node/bin/node scripts/connect-domain.mjs books.catfish.cc
```

1. 출력되는 최신 Cloudflare 로그인 링크를 PC 브라우저에서 바로 엽니다. 이전에 열어 둔 승인 탭은 재사용하지 않습니다.
2. `catfish.cc`를 선택하고 연결을 승인합니다. 비밀번호나 API 토큰을 채팅에 붙여넣지 않습니다.
3. 명령이 터널, `books.catfish.cc` DNS 기록, 자동 실행 서비스를 설정합니다.
4. `https://books.catfish.cc`를 열고 관리자 계정으로 로그인합니다.

인증 대기는 약 9분 뒤 종료될 수 있습니다. 시간이 지나 명령이 종료됐다면 같은 명령을 다시 실행하고 새로 출력된 링크를 사용합니다. 브라우저의 성공 화면 외에 터미널의 연결 완료 메시지도 확인합니다. 인증서가 이미 있으면 로그인 단계를 건너뜁니다. 기존 `books.catfish.cc` DNS 기록이 충돌하면 자동으로 덮어쓰지 않고 중단합니다. 이 경우 해당 기록이 다른 서비스를 가리키는지 먼저 확인합니다.

Cloudflare 계정 인증서는 기본 위치인 `~/.cloudflared/cert.pem`에 저장됩니다. 이 앱의 터널 자격 증명과 설정은 프로젝트의 `.cloudflared/`에 저장됩니다. 이 파일들은 공개 저장소에 올리지 않습니다.

## 상태 확인과 업데이트

```bash
systemctl --user status comic-shelf.service comic-shelf-tunnel.service
journalctl --user -u comic-shelf.service -n 50 --no-pager
journalctl --user -u comic-shelf-tunnel.service -n 50 --no-pager
```

코드를 변경하고 빌드할 때는 실행 중인 앱과 빌드 파일이 섞이지 않도록 먼저 앱을 중지합니다.

```bash
systemctl --user stop comic-shelf.service
export PATH="$PWD/.runtime/node/bin:$PATH"
npm run build
systemctl --user start comic-shelf.service
```

`PUBLIC_ORIGIN` 같은 서버 설정을 변경했다면 `systemctl --user restart comic-shelf.service`로 적용합니다. 계정 비밀번호는 **Account settings**에서 바꾸며 서비스 재시작 없이 즉시 적용되고 다른 로그인 세션은 무효화됩니다. 자동 실행 중지는 `systemctl --user disable --now comic-shelf-tunnel.service comic-shelf.service`이며 책 데이터는 삭제하지 않습니다.

관리자 비밀번호를 잊은 경우 `.env.local`의 `BOOKS_PASSWORD`에 새 비밀번호를 설정하고 `.runtime/node/bin/node scripts/reset-admin-password.mjs`를 실행합니다. 로컬 서버 접근 권한이 있어야 사용할 수 있으며 책과 회원은 유지합니다.

## 업로드와 읽던 위치

큰 PDF는 8MiB 이하의 요청으로 나누므로 Cloudflare Free의 요청당 100MB 제한에 걸리지 않습니다. 파일 전체 제한은 `.env.local`의 `MAX_UPLOAD_MB` 값으로 정하며 기본 256MiB입니다. 업로드가 중단되면 처음부터 재시도합니다.

책장으로 돌아갈 때 최신 읽던 위치를 저장한 뒤 이동합니다. 탭 종료 시에도 최신 위치를 전송하며 이전 요청이 늦게 도착해 덮어쓰는 것을 막습니다. 기기가 갑자기 꺼지거나 인터넷이 완전히 끊긴 경우 서버 저장을 보장할 수는 없습니다.

참고: [Cloudflare Tunnel](https://developers.cloudflare.com/tunnel/), [CLI 연결 절차](https://developers.cloudflare.com/tunnel/features/locally-managed-tunnels/create-local-tunnel/), [업로드 제한](https://developers.cloudflare.com/support/troubleshooting/http-status-codes/4xx-client-error/error-413/).

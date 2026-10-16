# sweepy

맥미니 개발 디스크를 주기적으로 확인하고, 부족하면 정리 후보 보고서를 남기는 작은 cron 프로그램. 정리 엔진은 [Void](https://github.com/eladbash/void), 스케줄은 macOS launchd가 맡는다. sweepy는 아무것도 지우지 않는다. 지우는 일은 보고서를 본 사람이나 에이전트가 `void apply`로 한다.

```
launchd (1시간마다) ─▶ sweepy check
                        ├─ void guard check            ok면 기록만 하고 끝
                        ├─ low/critical/확인 실패이고, 상태가 바뀌었거나 24시간 지났으면
                        │    └─ void plan (dry-run, 2분 제한) ─▶ reports/<시각>.json
                        └─ sweepy.log 에 한 줄 기록
```

보고서를 어디로 보낼지(Discord, 에이전트 등)는 어댑터의 몫이고, 지금은 어댑터가 없다. 보고서 파일과 로그가 출력의 전부다.

## 사용

```sh
bin/sweepy check       # 한 번 실행. 보고서를 만들면 그 경로를 출력
bin/sweepy install     # launchd 등록(dev.sweepy.check), 등록 즉시 1회 실행
bin/sweepy uninstall   # launchd 해제. 상태·보고서는 남긴다
sh scripts/doctor.sh   # 설치·디스크·스케줄·macOS 권한 대화상자 점검
```

`install`은 이 체크아웃의 `bin/sweepy` 절대 경로를 등록하므로, 리포를 옮기면 다시 `install`한다.

| 환경 변수 | 기본값 | 뜻 |
|---|---|---|
| `SWEEPY_VOID` | `~/.local/bin/void` | Void 실행 파일 |
| `SWEEPY_STATE_DIR` | `~/.local/state/sweepy` | 로그·보고서·마지막 상태 |
| `SWEEPY_INTERVAL` | `3600` | 확인 주기(초), `install` 때 적용 |
| `SWEEPY_REPEAT_AFTER` | `86400` | 같은 상태를 다시 보고하기까지(초) |
| `SWEEPY_SCAN_TIMEOUT` | `120` | `void plan` 제한 시간(초) |
| `SWEEPY_VOID_CONFIG` | `void/sweepy.json` | sweepy가 Void에 넘기는 전용 설정 |

`void/sweepy.json`은 스캔을 `~/projects`와 node·rust·python으로 좁힌다. launchd에서 실행된 void는 macOS 권한을 자기 이름으로 묻기 때문에, 홈 전체를 스캔하면 다운로드·데스크탑·사진 폴더 권한 대화상자가 떠서 멈춘다(실측 4건). 범위를 좁힌 뒤로는 0건, 8초에 끝난다. 전역 Void 설정(`~/Library/Application Support/com.void.app/config.json`, Claude Code·Codex가 쓰는 것)은 건드리지 않는다.

보고서 형식: `{"state": "low", "guard": <void guard check>, "plan": <void plan>}`. 계획을 못 만들면 `"plan": null`과 `"plan_error"`가 들어간다(제한 시간 초과 시 최근 macOS 권한 대화상자 수 포함).

## 설치

1. Void CLI: [릴리스](https://github.com/eladbash/void/releases)의 `void-<버전>-aarch64-apple-darwin`을 `~/.local/bin/void`로 받고 sha256을 확인한다.
2. 전역 보호 경로(에이전트가 직접 Void를 쓸 때): `cp void/config.json ~/Library/Application\ Support/com.void.app/config.json`
3. 스케줄: `bin/sweepy install`
4. 점검: `sh scripts/doctor.sh` (모두 OK면 종료 코드 0)

Claude Code·Codex에서 Void를 직접 쓰려면 `claude mcp add --scope user void -- ~/.local/bin/void mcp`, `codex mcp add void -- ~/.local/bin/void mcp`.

## 운영하면서 알게 된 것

- **macOS 권한 대화상자가 스캔을 멈춘다.** void가 다른 앱 데이터 폴더에 닿으면 macOS가 권한을 묻고, 응답 전까지 스캔이 멈춘다. sweepy는 2분 뒤 끊고 보고서에 대화상자 수를 적는다. 캐시 정리에는 "허용 안 함"이면 충분하다.
- **`blocked_paths`는 계획에 그대로 나온다.** Void는 막힌 경로를 plan에서 빼지 않고 apply에서만 거부한다(상위 폴더를 막으면 하위도 막힘).
- **Docker는 Colima 안에 있다.** `docker builder prune` 뒤에 `colima ssh -- sudo fstrim -av`를 해야 맥 여유 공간이 늘어난다(실측 +9.3 GiB).
- **보고된 회수량과 실제 증가량은 다르다.** pnpm·Bun은 APFS 복제로 블록을 공유해서, `pnpm store prune`이 3 GB를 지웠다고 해도 실제로는 0.3 GiB만 늘었다.
- **macOS에는 `timeout`이 없다.** `perl -e 'alarm shift; exec @ARGV or die' 120 <명령>`을 쓴다. `or die`가 없으면 실행 파일을 못 찾아도 perl이 0으로 끝난다.

## 제거

```sh
bin/sweepy uninstall
rm -rf ~/.local/state/sweepy
```

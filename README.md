# sweepy

맥미니 개발 디스크를 에이전트가 감시하고 정리 후보를 보고하는 구성. 정리 엔진은 [Void](https://github.com/eladbash/void), 감시와 보고는 OpenClaw cron, 절차는 gisul 스킬 `void-disk-cleanup`이 맡는다. 삭제는 항상 사람의 승인 뒤에만 한다.

```
1시간마다  void guard check  ──(low/critical, 상태 변화 또는 24시간 경과)──▶  OpenClaw 에이전트
                                                                              │ gisul void-disk-cleanup 스킬
                                                                              ▼
                                                     정리 후보 보고(Discord DM) ──"디스크 정리 승인"──▶ void apply
```

## 구성

| 경로 | 내용 |
|---|---|
| `openclaw/disk-guard/trigger.js` | 조건 스크립트. 모델 호출 없이 `void guard check`만 실행하고, 확인이 실패해도 알린다 |
| `openclaw/disk-guard/message.md` | 깨어난 에이전트에게 주는 지시(보고만, 2분 제한, 제외 규칙) |
| `openclaw/disk-guard/install.sh` | cron 작업 등록. `declaration-key`로 다시 실행해도 하나만 유지된다 |
| `void/config.json` | Void `blocked_paths`. 이 경로 아래 항목은 적용 단계에서 거부된다 |
| `scripts/doctor.sh` | 설치·디스크 상태·MCP 등록·cron·macOS 권한 대화상자 점검 |

## 설치

1. Void CLI 설치: [릴리스](https://github.com/eladbash/void/releases)의 `void-<버전>-aarch64-apple-darwin`을 `~/.local/bin/void`로 받고 sha256을 확인한다.
2. 에이전트 연결
   ```sh
   claude mcp add --scope user void -- ~/.local/bin/void mcp
   codex mcp add void -- ~/.local/bin/void mcp
   ```
3. 보호 경로: `cp void/config.json ~/Library/Application\ Support/com.void.app/config.json`
4. 감시 등록: `DISCORD_TO=<받을 Discord id> DISCORD_ACCOUNT=<OpenClaw 계정 id> sh openclaw/disk-guard/install.sh`
5. 점검: `sh scripts/doctor.sh` (모두 OK면 종료 코드 0)

## 운영하면서 알게 된 것

- **macOS 권한 대화상자가 스캔을 멈춘다.** OpenClaw(node)가 실행한 void가 다른 앱 데이터 폴더에 닿으면 macOS가 권한을 묻고, 응답 전까지 스캔이 멈춘다. `doctor.sh`가 최근 대화상자를 찾아준다. 캐시 정리에는 "허용 안 함"이면 충분하고, node에 전체 디스크 접근 권한은 주지 않는다.
- **`blocked_paths`는 계획에 그대로 나온다.** Void는 막힌 경로를 plan에서 빼지 않고 apply에서만 거부한다(상위 폴더를 막으면 하위도 막힘). 보고할 때 따로 빼야 한다.
- **Docker는 Colima 안에 있다.** `docker builder prune`만으로는 맥 여유 공간이 늘지 않는다. 이어서 `colima ssh -- sudo fstrim -av`를 해야 VM 디스크가 줄어든다(실측 +9.3 GiB).
- **보고된 회수량과 실제 증가량은 다르다.** pnpm·Bun은 APFS 복제로 블록을 공유해서, `pnpm store prune`이 3 GB를 지웠다고 해도 실제로는 0.3 GiB만 늘었다. 정리 전후로 `void guard check`를 다시 잰다.
- **macOS에는 `timeout`이 없다.** `perl -e 'alarm shift; exec @ARGV' 120 <명령>`을 쓴다.

## 제거

```sh
openclaw cron rm "$(openclaw cron list --json | python3 -c 'import json,sys; print(next(j["id"] for j in json.load(sys.stdin)["jobs"] if j.get("declarationKey")=="disk-guard-v1"))')"
claude mcp remove void -s user; codex mcp remove void
rm ~/.local/bin/void
```

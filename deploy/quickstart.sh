#!/bin/sh
# =============================================================================
#  魔幻赛马 / Horse Racing —— 裸机一键部署
#
#  在有 Docker 的服务器上执行：
#
#    sh -c "$(curl -fsSL https://raw.githubusercontent.com/lbbit/HR_web/main/deploy/quickstart.sh)"
#
#  或先下载再跑（便于审计脚本内容）：
#
#    curl -fsSLO https://raw.githubusercontent.com/lbbit/HR_web/main/deploy/quickstart.sh
#    sh quickstart.sh
#
#  可用环境变量覆盖：
#    HR_WEB_DIR    安装目录，默认 $HOME/hr-web（不用 /opt，免得要 sudo）
#    HR_WEB_REPO   仓库地址
#    HR_WEB_PORT   对外端口，默认 8080
#    HR_WEB_REF    分支或 tag，默认 main
#
#  幂等：重复执行会拉取最新代码并重建容器。
# =============================================================================

set -eu

REPO="${HR_WEB_REPO:-https://github.com/lbbit/HR_web.git}"
DIR="${HR_WEB_DIR:-$HOME/hr-web}"
PORT="${HR_WEB_PORT:-8080}"
REF="${HR_WEB_REF:-main}"

say()  { printf '\033[36m==>\033[0m %s\n' "$1"; }
die()  { printf '\033[31m错误:\033[0m %s\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- 前置检查
command -v docker >/dev/null 2>&1 \
  || die "未安装 docker。请先安装：https://docs.docker.com/engine/install/"

docker info >/dev/null 2>&1 \
  || die "docker 命令存在但守护进程不可达。确认服务已启动，且当前用户有权限（把用户加入 docker 组）。"

# compose 有 v2 插件（docker compose）和 v1 独立程序（docker-compose）两种
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  die "未找到 docker compose。请安装 compose 插件（docker-compose-plugin）。"
fi

command -v git >/dev/null 2>&1 || die "未安装 git。"
say "环境检查通过（$COMPOSE）"

# ---------------------------------------------------------------- 取代码
if [ -d "$DIR/.git" ]; then
  say "更新代码 $DIR"
  git -C "$DIR" fetch --depth 1 origin "$REF"
  git -C "$DIR" checkout -q FETCH_HEAD
else
  say "克隆代码到 $DIR"
  mkdir -p "$(dirname "$DIR")"
  git clone --depth 1 --branch "$REF" "$REPO" "$DIR"
fi

# ---------------------------------------------------------------- 起服务
say "构建并启动（首次构建会跑镜像内的回归测试，稍慢）"
cd "$DIR"
HR_WEB_PORT="$PORT" $COMPOSE up -d --build

# ---------------------------------------------------------------- 报结果
say "等待健康检查"
i=0
while [ "$i" -lt 30 ]; do
  if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
    break
  fi
  i=$((i + 1))
  sleep 2
done

status="$($COMPOSE ps 2>/dev/null || true)"
printf '%s\n' "$status"

if curl -fsS --max-time 2 "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then
  HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "${HOST_IP:-}" ] || HOST_IP="<服务器IP>"
  echo
  say "部署完成"
  printf '    本机   http://localhost:%s\n' "$PORT"
  printf '    局域网 http://%s:%s\n' "$HOST_IP" "$PORT"
  echo
  printf '    看日志   cd %s && make logs\n' "$DIR"
  printf '    停服务   cd %s && make down\n' "$DIR"
else
  die "容器在 60 秒内未通过健康检查，请查看日志：cd $DIR && $COMPOSE logs"
fi

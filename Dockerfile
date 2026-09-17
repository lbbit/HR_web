# =============================================================================
#  魔幻赛马 / Horse Racing（像素 Web 复刻版）—— 静态站点镜像
#
#    阶段 1  bundle   只收集浏览器真正会下载的文件
#    阶段 2  gate     把无头回归测试当作**构建闸门**
#    阶段 3  runtime  rootless nginx + 调优过的站点配置
#
#  为什么分三段：测试和打包产物绑定在同一条链上，测试不过就产不出可运行镜像。
#  runtime 阶段从 gate 阶段 COPY —— Docker 必须先把 gate 跑完。
#
#  基础镜像可换成内网镜像源：
#    docker build \
#      --build-arg NODE_IMAGE=registry.local/node:22-alpine \
#      --build-arg NGINX_IMAGE=registry.local/nginx-unprivileged:1.27-alpine .
#
#  应急时跳过回归测试（正常不要用）：
#    docker build --build-arg SKIP_TESTS=1 .
# =============================================================================

ARG NODE_IMAGE=node:22-alpine
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.27-alpine


# ============================== 阶段 1 / bundle ==============================
FROM ${NODE_IMAGE} AS bundle
WORKDIR /build

# 只带浏览器需要的东西。test/、tools/、.git 都不进镜像。
COPY index.html styles.css ./
COPY src    ./src
COPY assets ./assets
COPY deploy/nginx/404.html ./

# 打包不全就立刻失败，不要等到运行期才发现少文件
RUN set -eu; \
    for f in index.html styles.css 404.html \
             src/main.js src/game.js src/audio.js src/storage.js src/assets.js \
             assets/fonts/zpix-subset.woff2 assets/ui/favicon.ico \
             assets/bg/BG0.webp assets/bg/BG9_0.webp; do \
      test -s "$f" || { echo "FATAL: 缺失或为空: $f"; exit 1; }; \
    done; \
    echo "--- bundle ---"; \
    echo "文件数: $(find . -type f | wc -l)"; \
    echo "体积  : $(du -sh . | cut -f1)"

# 容器必须能在无外网出口的内网跑，所以拒绝打包任何会发起外部请求的引用。
# 只检查真正会触发加载的写法，因此注释里出现网址不受影响。
RUN set -eu; \
    if grep -RInE \
         "(src|href)[[:space:]]*=[[:space:]]*[\"']?https?://|url\([[:space:]]*[\"']?https?://|@import[[:space:]]+[\"']?https?://" \
         index.html styles.css 404.html src; then \
      echo "FATAL: 打包内容引用了外部地址，内网离线部署会挂。"; \
      echo "       像素字体应当是自托管的 assets/fonts/zpix-subset.woff2。"; \
      exit 1; \
    fi; \
    echo "离线自包含检查: 通过（无任何外部引用）"


# ============================== 阶段 2 / gate ===============================
FROM bundle AS gate
ARG SKIP_TESTS=0

# 两套测试都按**仓库目录结构**解析路径，所以闸门阶段必须摆出与仓库一致的布局：
#   README.md            素材测试会扫它内嵌的 13 张界面截图引用
#   docs/                上面那些截图本体；少一个引用就报 BROKEN REF 并判失败
#   deploy/nginx/404.html 同样是被逐个核对的 markup 引用
# 这几样只存在于 gate 这个中间层。runtime 阶段是按文件名逐个 COPY 的，
# 所以 docs/ 与 deploy/ 不会进最终镜像。
COPY README.md ./
COPY test      ./test
COPY docs      ./docs
COPY deploy    ./deploy

RUN set -eu; \
    if [ "$SKIP_TESTS" = "1" ]; then \
      echo "*** SKIP_TESTS=1：回归测试已被跳过，此镜像未经验证 ***"; \
    else \
      node test/assets.mjs; \
      node test/harness.mjs; \
    fi


# ============================= 阶段 3 / runtime =============================
FROM ${NGINX_IMAGE} AS runtime

LABEL org.opencontainers.image.title="魔幻赛马 Horse Racing (pixel web remake)" \
      org.opencontainers.image.description="原作 Qt 像素赛马游戏的现代 Web 复刻版 —— 原样复用原作手绘像素素材，静态站点，无外部依赖。" \
      org.opencontainers.image.source="https://github.com/lbbit/HR_web" \
      org.opencontainers.image.licenses="NOASSERTION" \
      org.opencontainers.image.version="2.0.0"

# ---- 断言：绝不发布 root 容器 -----------------------------------------------
# 非特权基础镜像的 USER 是 101，构建期的 RUN 也会以该身份执行。
# 一旦有人把 NGINX_IMAGE 换成 root 版镜像，这里会直接把构建拦下来。
RUN set -eu; \
    uid="$(id -u)"; \
    if [ "$uid" = "0" ]; then \
      echo "FATAL: 基础镜像以 root 运行。请使用非特权镜像，例如默认的"; \
      echo "       nginxinc/nginx-unprivileged:1.27-alpine，让服务以普通 uid 运行。"; \
      exit 1; \
    fi; \
    echo "运行身份: $(id -un) (uid $uid) —— 非 root，符合预期"

# ---- 站点配置：直接覆盖镜像自带的 default.conf -------------------------------
# 自带的那份没有缓存、没有压缩、没有安全响应头，不适用于生产。
COPY deploy/nginx/default.conf /etc/nginx/conf.d/default.conf

# ---- 构建期校验 nginx 配置 --------------------------------------------------
# 否则配置写错只会在运维启动容器时才报错。
#
# 就用基础镜像自带的 nginx.conf 来校验：它本来就 include conf.d/*.conf，
# 我们那份 default.conf 会被完整解析，而且校验的正是**运行期真正生效的那套配置**。
#
# 不要写成 `nginx -t -c <自造配置文件>`（哪怕只是外面包一层 events{}/http{}）：
# 加了 -c 之后 nginx 不再读镜像的 nginx.conf，而 nginx-unprivileged 恰恰把
# pid 与全部 *_temp_path 改到 /tmp——这些改动就写在它的 nginx.conf 里，
# 也正是该镜像 README「Troubleshooting」的头两条。少了它们，nginx 会去写
# 编译期默认路径，而构建身份是 uid 101：
#   nginx: the configuration file /tmp/check.conf syntax is ok
#   [emerg] 8#8: open() "/run/nginx.pid" failed (13: Permission denied)
#   nginx: configuration file /tmp/check.conf test failed
# 注意第一行：**配置语法本来就是 ok 的**，纯粹是路径不可写把校验判死了
# （CI 上就是这么挂的，退出码 1）。docker-compose.yml 里给 /var/cache/nginx
# 挂的那个 tmpfs「保险栓」，防的是同一件事的另一面。
RUN nginx -t

# ---- 断言：运行期不需要写根文件系统 -----------------------------------------
# 官方 entrypoint 只有在 /etc/nginx/templates 有内容时才需要写 /etc/nginx/conf.d。
# 我们的配置是构建期直接拷进去的，所以 read_only: true 才成立。
RUN set -eu; \
    if [ -d /etc/nginx/templates ] && [ -n "$(ls -A /etc/nginx/templates 2>/dev/null || true)" ]; then \
      echo "FATAL: /etc/nginx/templates 非空，entrypoint 会在运行期写 conf.d，"; \
      echo "       这会让 read_only: true 下启动失败。请改为构建期直接 COPY 配置。"; \
      exit 1; \
    fi; \
    test -L /var/log/nginx/access.log || echo "提示: access.log 不是符号链接，已另行重定向到 /dev/stdout"; \
    echo "运行期写入点: 仅 /tmp（read_only 根文件系统安全）"

# ---- 静态产物：全部来自已过闸门的 bundle -------------------------------------
COPY --from=gate /build/index.html /usr/share/nginx/html/
COPY --from=gate /build/styles.css /usr/share/nginx/html/
COPY --from=gate /build/404.html   /usr/share/nginx/html/
COPY --from=gate /build/src        /usr/share/nginx/html/src
COPY --from=gate /build/assets     /usr/share/nginx/html/assets

# ---- 断言：nginx 实际要服务的内容是完整的 -----------------------------------
RUN set -eu; \
    cd /usr/share/nginx/html; \
    for f in index.html styles.css 404.html \
             src/main.js assets/fonts/zpix-subset.woff2 assets/ui/favicon.ico \
             assets/bg/BG0.webp assets/bg/BG9_0.webp; do \
      test -s "$f" || { echo "FATAL: 站点根目录缺少: $f"; exit 1; }; \
    done; \
    echo "站点根目录: $(find . -type f | wc -l) 个文件 / $(du -sh . | cut -f1)"

ENV TZ=Asia/Shanghai

# 对外端口用发布映射改（HR_WEB_PORT），容器内固定 8080
EXPOSE 8080

# busybox wget 已随基础镜像提供；探活只依赖自身，不依赖外部工具
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

# 优雅退出（等正在处理的请求结束再关）
STOPSIGNAL SIGQUIT

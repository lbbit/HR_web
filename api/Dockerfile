# =============================================================================
#  HR_web API — 零依赖 Node 服务（共享账号 / 排行榜）
#
#    podman/docker build -t hr-web-api ./api
#
#  运行约定：
#    HR_PORT=8081         容器内固定 8081
#    HR_DATA_PATH=/data/state.json   数据文件（挂卷持久化）
#    以内置非 root 用户 node (uid 1000) 运行
#    HEALTHCHECK 打本机 /healthz
# =============================================================================

FROM node:22-alpine

WORKDIR /app
COPY server.mjs ./server.mjs

# 预建数据目录并交给 node 用户 —— 命名卷首次挂载时 Docker 会按镜像内该目录的
# 属主初始化卷权限，非 root 进程才能写入
RUN mkdir -p /data && chown node:node /data

ENV HR_PORT=8081 \
    HR_DATA_PATH=/data/state.json \
    NODE_ENV=production

USER node

EXPOSE 8081

HEALTHCHECK --interval=30s --timeout=3s --start-period=3s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:8081/healthz" >/dev/null || exit 1

# server.mjs 的入口分支（pathToFileURL 比对）会在容器 CMD 下生效
CMD ["node", "server.mjs"]

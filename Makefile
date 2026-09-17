# =============================================================================
#  魔幻赛马 / Horse Racing —— 常用操作入口
#
#    make            显示所有可用目标（等同 make help）
#    make up         构建并启动 → http://localhost:8080
#    make logs       跟随日志
#    make down       停止并移除
#
#  可覆盖变量：IMAGE / PORT / PY
#    make up PORT=80
# =============================================================================

IMAGE ?= hr-web:latest
PORT  ?= 8080
PY    ?= python
COMPOSE ?= docker compose

.DEFAULT_GOAL := help
.PHONY: help up down restart logs ps sh health test assets font run build https prod clean nuke

help: ## 显示所有可用目标
	@echo "魔幻赛马 / Horse Racing —— 可用目标"
	@echo
	@grep -hE '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | sort \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-10s\033[0m %s\n", $$1, $$2}'
	@echo
	@echo "变量：IMAGE=$(IMAGE)  PORT=$(PORT)  PY=$(PY)"

# ---------------------------------------------------------------- 容器生命周期
up: ## 构建并启动（对外端口 PORT，默认 8080）
	HR_WEB_PORT=$(PORT) $(COMPOSE) up -d --build
	@echo "→ http://localhost:$(PORT)"

build: ## 只构建镜像，不启动
	$(COMPOSE) build

down: ## 停止并移除容器与网络
	$(COMPOSE) down

restart: ## 重启容器
	$(COMPOSE) restart

logs: ## 跟随日志（最近 100 行）
	$(COMPOSE) logs -f --tail=100

ps: ## 查看容器与健康状态
	$(COMPOSE) ps

sh: ## 进容器看文件（alpine 自带 sh）
	$(COMPOSE) exec web sh

health: ## 打一次健康检查接口
	@curl -fsS "http://localhost:$(PORT)/healthz" && echo "healthz: OK"
	@curl -fsS -o /dev/null -w "index.html: %{http_code}\n" "http://localhost:$(PORT)/"

# ------------------------------------------------------------------ 本地质量关卡
test: ## 跑无头回归测试（需要 node ≥ 20）
	node test/assets.mjs
	node test/harness.mjs

assets: ## 只校验素材完整性（磁盘存在性 / 大小写 / 孤儿文件）
	node test/assets.mjs

font: ## 重新生成自托管像素字体子集（需要 python + fonttools brotli）
	$(PY) tools/subset-font.py

# ------------------------------------------------------------------ 运行与发布
run: ## 不构建，直接跑已有镜像（前台）
	docker run --rm -p $(PORT):8080 $(IMAGE)

https: ## 域名 + 自动 HTTPS 部署（需先设置 HR_DOMAIN）
	$(COMPOSE) -f docker-compose.https.yml up -d --build

prod: ## 拉取已发布镜像并启动，不在本机构建
	$(COMPOSE) pull
	$(COMPOSE) up -d --no-build

# ---------------------------------------------------------------------- 清理
clean: ## 停止并移除容器/网络（保留镜像）
	$(COMPOSE) down --remove-orphans

nuke: ## 连镜像一起删掉
	$(COMPOSE) down --remove-orphans --rmi local

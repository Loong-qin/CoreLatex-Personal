# CoreLatex 整体运行镜像：Node 24 + TeX Live(xelatex/pdflatex/lualatex、CJK、tikz/pgfplots、
# bibtex/biber 等)+ Poppler(pdftotext/pdftoppm)+ Python3(matplotlib/numpy，供智能体绘图与脚本)。
# TeX 组件覆盖学术写作常用面：publishers(IEEEtran/acmart/elsarticle/llncs/revtex 等会议
# 期刊文档类)、fonts-extra(newtx/libertine/stix2/fontawesome5 等字体)、humanities(语言学)、
# pstricks(旧版期刊模板)、metapost、plain-generic、tex-gyre、cm-super(pdflatex 矢量 T1 字体)；
# IEEE 官方 ieeeconf.cls 与 aastex63 别名单独内置(见下文 docker/texlive-local)。
# 数据目录 /data 以卷挂载，镜像内不包含任何用户数据；容器删除重建后数据仍在宿主机 ./data。
#
# node 必须固定 24.19.0：24.21.0 在本机存在进程提前退出回归（事件循环被排空、exit 0，
# 退出清理时 better-sqlite3 Statement 析构断言崩溃），智能体运行中 SSE 随之中断（前端报 network error）。
# 24.19.0 与宿主 nvm 版本一致，已长时间稳定验证。

# ---------- 1) 前端构建 ----------
FROM node:24.19.0-bookworm AS web-build
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# ---------- 2) 后端依赖(原生模块编译) ----------
FROM node:24.19.0-bookworm AS server-deps
WORKDIR /app/server
RUN apt-get update && apt-get install -y --no-install-recommends build-essential python3 \
    && rm -rf /var/lib/apt/lists/*
COPY server/package*.json ./
RUN npm ci
# 镜像内源码编译的 better-sqlite3 存在崩溃缺陷:Statement GC 析构时命中
# node 断言 "Assertion failed: (env) != nullptr" → SIGSEGV,智能体运行数分钟后
# 进程被打死(SSE 断开,前端报 network error)。宿主机上同一版本的编译产物已长期
# 稳定验证,复制进构建上下文(docker/bins/)后直接覆盖镜像内产物。
COPY docker/bins/better_sqlite3.node ./node_modules/better-sqlite3/build/Release/better_sqlite3.node
RUN node -e "const db = require('better-sqlite3')(':memory:'); db.exec('CREATE TABLE t(x)'); db.prepare('INSERT INTO t VALUES (?)').run(1); if (db.prepare('SELECT x FROM t').get().x !== 1) throw new Error('smoke fail'); console.log('better-sqlite3 binary smoke ok')"

# ---------- 3) 运行镜像 ----------
FROM node:24.19.0-bookworm
RUN (sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null || true) \
    && (sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null || true) \
    && printf 'Acquire::Retries "8";\nAcquire::http::Timeout "60";\nAcquire::https::Timeout "60";\n' > /etc/apt/apt.conf.d/80deploy-retries \
    && apt-get update && apt-get install -y --no-install-recommends \
    texlive-latex-base \
    texlive-latex-recommended \
    texlive-latex-extra \
    texlive-fonts-recommended \
    texlive-fonts-extra \
    texlive-publishers \
    texlive-pstricks \
    texlive-humanities \
    texlive-plain-generic \
    texlive-metapost \
    texlive-xetex \
    texlive-luatex \
    texlive-lang-chinese \
    texlive-pictures \
    texlive-science \
    texlive-bibtex-extra \
    tex-gyre \
    cm-super \
    biber \
    latexmk \
    poppler-utils \
    python3 \
    python3-pip \
    python3-matplotlib \
    python3-numpy \
    fonts-noto-cjk \
    fontconfig \
    perl \
    tar \
    xz-utils \
    wget \
    ca-certificates \
    && (tlmgr option autobackup 0 2>/dev/null || true) \
    && rm -rf /var/lib/apt/lists/*

# IEEE 官方 ieeeconf.cls(PaperCept 发行,Debian 仅有大写 IEEEconf/其他版本)内置到
# TEXMFLOCAL,覆盖 \documentclass[conference]{ieeeconf} 场景;aastex63.cls 为
# aastex631 的别名(旧 AAS 模板按 v6.3 文件名引用)。注意:部分 Debian 源的
# texlive-publishers 修订版不含 aastex631.cls——别名是锦上添花,缺文件时跳过
# 而不是让整个构建失败(ieeeconf.cls 来自本地 texmf,不受影响)
COPY docker/texlive-local/texmf /usr/local/share/texmf
RUN cp /usr/share/texlive/texmf-dist/tex/latex/aastex/aastex631.cls /usr/local/share/texmf/tex/latex/aastex/aastex63.cls 2>/dev/null \
    || echo '[texlive-local] 本版 texlive-publishers 无 aastex631.cls,跳过 aastex63 别名'; \
    mktexlsr /usr/local/share/texmf

WORKDIR /app
COPY package.json LICENSE THIRD_PARTY_NOTICES ./
COPY scripts/ ./scripts/
COPY --from=server-deps /app/server/node_modules ./server/node_modules
COPY server/ ./server/
COPY --from=web-build /app/web/dist ./web/dist

ENV CORELATEX_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=3333 \
    NODE_ENV=production
VOLUME ["/data"]
EXPOSE 3333

CMD ["node", "server/src/index.js"]

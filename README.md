# CoreLatex

简体中文 · [English](README.en.md)

CoreLatex 是一款自托管 LaTeX 编辑器，支持 PDF 编译和 CoreAgent 辅助改稿。个人可免费自托管，用于本人的非商业学习、研究和写作。团队共用、机构部署或商业使用请联系下方邮箱取得书面授权。[个人非商业使用许可证](LICENSE)

- **演示视频**　[中文讲解](media/CoreLatex-AI-workflow-zh.mp4?raw=true) · [英文讲解](media/CoreLatex-AI-workflow-en.mp4?raw=true)（各 1 分 36 秒）
- **用户文档**　[在线用户手册](docs/README.md) · [下载离线手册](docs/CoreLatex-用户手册.html?raw=true)
- **联系方式**　[qinloong23@gmail.com](mailto:qinloong23@gmail.com)

如果 CoreLatex 帮你省下了写论文的时间，欢迎[联系我赞助项目](mailto:qinloong23@gmail.com?subject=CoreLatex%20%E8%B5%9E%E5%8A%A9)，支持后续开发与维护。

## 使用 Docker Compose 部署

在可信内网的 Linux x86-64（amd64）主机上准备好 Git、Docker Engine 和 Compose v2，首次部署时运行以下命令。

```bash
git clone https://github.com/Loong-qin/CoreLatex-Personal.git
cd CoreLatex-Personal
sudo install -d -m 700 -o 1000 -g 1000 data
docker compose up -d --build corelatex
docker compose ps
```

容器状态显示 `healthy` 后，在部署主机打开 <http://127.0.0.1:3333> 并注册。首个注册账号成为管理员，项目和账号数据保存在宿主机的 `./data/` 目录。

ARM64 裸机安装、备份和升级步骤见[安装与管理员指南](docs/installation-and-admin.md)。

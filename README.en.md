# CoreLatex

[简体中文](README.md) · English

CoreLatex is an open-source, self-hosted LaTeX editor with PDF compilation and CoreAgent-assisted editing. Individuals, teams, and companies can use, modify, and distribute CoreLatex, including commercially, under the [MIT License](LICENSE).

- **Demo videos** · [English walkthrough](media/CoreLatex-AI-workflow-en.mp4?raw=true) · [Chinese walkthrough](media/CoreLatex-AI-workflow-zh.mp4?raw=true) (1 min 36 sec each)
- **User documentation** · [Online handbook](docs/README.md) · [Download the offline handbook](docs/CoreLatex-用户手册.html?raw=true) (both in Chinese)
- **Contact** · [qinloong23@gmail.com](mailto:qinloong23@gmail.com)

If CoreLatex saves you time writing papers, [get in touch about sponsoring the project](mailto:qinloong23@gmail.com?subject=CoreLatex%20sponsorship) to support its ongoing development and maintenance.

## Deploy with Docker Compose

For a fresh installation, run these commands on a Linux x86-64 (amd64) host on a trusted network with Git, Docker Engine, and Compose v2 installed.

```bash
git clone https://github.com/Loong-qin/CoreLatex-Personal.git
cd CoreLatex-Personal
sudo install -d -m 700 -o 1000 -g 1000 data
docker compose up -d --build corelatex
docker compose ps
```

Once the container is `healthy`, open <http://127.0.0.1:3333> on the host and register. The first account becomes the administrator. Project and account data are stored in `./data/` on the host.

For native ARM64 installation, backups, and upgrades, see the [installation and administration guide (Chinese)](docs/installation-and-admin.md).

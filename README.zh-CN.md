# dsh-watchkeeper（值守）

[![test](https://github.com/Maravetech/dsh-watchkeeper/actions/workflows/test.yml/badge.svg)](https://github.com/Maravetech/dsh-watchkeeper/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![release](https://img.shields.io/github/v/release/Maravetech/dsh-watchkeeper?include_prereleases&sort=semver)](https://github.com/Maravetech/dsh-watchkeeper/releases)

**Alpha。** 版本 0.1，插件 API 与配置在 1.0 前可能变化。

dsh-watchkeeper 是一个替你值守会话的 DSH 插件。它做三件事：

| 功能 | 作用 |
| --- | --- |
| 会话编号 | 每个会话一个稳定编号，显示在会话列表行首。台账保留时编号不复用。 |
| 待答 | 人工决策卡统一收集到一处。你答一次，答案送回发问的会话。 |
| 值守 | 可插拔判断器替你回答会话中途的常规提问。拿不准、输出坏掉、碰红线，一律转人工。 |

> 截图位：会话列表带编号、一张决策卡、待答视图。等 `docs/assets/screenshot.png` 放进来后替换本行。

## 默认行为

- **不配判断器，就不自动回答决策卡。** 配置了 `fallbackEnabled` 的回复 Provider 也只处理已运行判断器给出的有限不确定结果；红线与判断器缺失都交人。可选的自动续跑是另一条路径。
- 回复 Provider 默认全关。
- HTTP 控制写接口要求 `WATCHKEEPER_CONTROL_TOKEN`；不配置时返回 403。Web Host 须使用本机回环地址字面量。
- 编号从 1 开始递增。重启后编号不变。

## 环境要求

- Node.js 22.5 或更新
- 带 profile 的 DSH 桌面端或网页端

## 安装

用 DSH 自带的插件命令安装：它在 profile 目录里转给 pnpm 执行，并把插件登记为该 profile 的 bundle，不用手改 `cordis.patch.yml`。尚未发布到 npm，从 GitHub 安装。

分两部分：插件（宿主行为）和技能（Agent 指令）。

### 插件

```bash
dsh plugin --profile <你的-profile> add github:Maravetech/dsh-watchkeeper#v0.2.0
```

要改本地克隆的代码时：

```bash
git clone https://github.com/Maravetech/dsh-watchkeeper.git
dsh plugin --profile <你的-profile> add "file:$PWD/dsh-watchkeeper"
```

也可以从 [Release 页](https://github.com/Maravetech/dsh-watchkeeper/releases)下载 `dsh-watchkeeper-<版本>.tgz` 后安装：

```bash
dsh plugin --profile <你的-profile> add ./dsh-watchkeeper-0.2.0.tgz
```

要固定版本，用提交号代替标签：`github:Maravetech/dsh-watchkeeper#<commit-sha>`。本包是纯 JavaScript、没有构建步骤，不需要在 `allowBuilds` 里授权。

支持的 DSH 版本写在 `engines.dsh`（当前 `>=0.2.0-rc.1 <0.3.0`），`dsh plugin add` 会拒绝不在范围内的版本。

卸载：`dsh plugin --profile <你的-profile> remove dsh-watchkeeper`。

完全退出并重启 DSH，然后查健康端点：

```bash
curl -s "$DSH_WEB_URL/watchkeeper/health" | python3 -m json.tool
```

如果 `DSH_WEB_URL` 没设置，就用应用地址里的端口，例如 `http://127.0.0.1:62630/watchkeeper/health`。

### 技能

```bash
ln -s "$DSH_PROFILE_DIR/node_modules/dsh-watchkeeper/skills/dsh-watchkeeper" "$DSH_HOME/skills/dsh-watchkeeper"
```

只想把技能装进其他 Agent（Claude Code、Codex 等），可以走 [skills.sh](https://skills.sh)（Vercel 的 `skills` 命令行，要求 Node 22.20 及以上）：

```bash
npx skills add Maravetech/dsh-watchkeeper --skill dsh-watchkeeper -g
```

技能只负责讲解插件怎么用；DSH 里没装上面的插件，它什么也做不了。

升级与卸载的完整步骤见 [docs/install.md](docs/install.md)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/install.md](docs/install.md) | 插件与技能安装、升级、卸载 |
| [docs/configuration.md](docs/configuration.md) | 环境变量、判断器契约、Provider |
| [docs/decision-cards.md](docs/decision-cards.md) | 决策卡 JSON、选项、常见错误 |

## 配置

配置走环境变量。最常用的三个：

| 变量 | 默认值 | 用途 |
| --- | --- | --- |
| `WATCHKEEPER_HOME` | `~/.dsh-watchkeeper` | 状态、会话编号台账、SQLite 数据库的存放目录。 |
| `WATCHKEEPER_JUDGE_CMD` | 未设置 | 判断器命令。不设置就是全部转人工。 |
| `WATCHKEEPER_CONTROL_TOKEN` | 未设置 | 值守控制 POST 路由的独立令牌；未设置则关闭这些写入口。 |
| `WATCHKEEPER_CODEX_BIN` / `WATCHKEEPER_AGY_BIN` / `WATCHKEEPER_CUSTOM_CMD` | 未设置 | 回复 Provider 的可执行文件。 |

完整变量表、判断器契约、Provider 命令见 [docs/configuration.md](docs/configuration.md)。

## 决策卡

决策卡是一段 JSON，用 `[DECISION_POINT]` 和 `[/DECISION_POINT]` 包起来，不能放进代码块。插件读到后把问题显示在待答视图里，你提交的答案会送回原会话。

最小形状：

```json
{
  "audience": "human",
  "requires_user_response": true,
  "human_review": [
    {
      "question_id": "q-1",
      "question": "用现在这张封面图发布，还是等新图？",
      "type": "卡点",
      "reason": "新图还没过审。",
      "manual_reason": "必要信息",
      "blocking_scope": "不回答就无法发布。",
      "attempts": ["已查素材目录，新图仍未到。"],
      "background": "现在这张能用，但版本较旧。",
      "recommendation": "先用现在这张发布。",
      "options": ["用现在这张发布", "等新图"],
      "state": "needs_user",
      "audience": "human",
      "requires_user_response": true,
      "agent_can_resolve": false,
      "already_resolved": false
    }
  ]
}
```

字段规则、选项、示例和常见错误见 [docs/decision-cards.md](docs/decision-cards.md)。

## 排查

先查健康端点：

```bash
curl -s "$DSH_WEB_URL/watchkeeper/health" | python3 -m json.tool
```

再看状态目录：

```bash
ls "$WATCHKEEPER_HOME"          # 默认：~/.dsh-watchkeeper
ls "$WATCHKEEPER_HOME/state"
```

再看插件日志：

```bash
tail -n 50 "$WATCHKEEPER_HOME/probe.log"
```

如果卡片不显示，通常是卡被包进了代码块、缺 `[DECISION_POINT]` 包壳，或缺必填字段。见 [docs/decision-cards.md](docs/decision-cards.md#common-mistakes)。

## 开发

```bash
node --version   # 必须 >= 22.5
npm test
```

测试用 Node 自带的测试运行器，不需要装依赖。见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可

MIT，见 [LICENSE](LICENSE)。

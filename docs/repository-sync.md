# 同一主线同步两个远端

内部仓库与 GitHub 应使用同一个已脱敏的 `main`，而不是持续维护内容不同的两套提交。人员、审批数据源、凭据及运行数据只保存在本机，不提交到任意远端。本流程不改变代码许可或替代公开发布授权。

维护者确认 GitHub URL 后，在每个本地 clone 首次配置双推送远端；先检查 `git remote -v`，不要覆盖或重复添加已有 `sync`：

```bash
git remote add sync "$(git remote get-url origin)"
git remote set-url --add --push sync "$(git remote get-url origin)"
git remote set-url --add --push sync "<GITHUB_REPOSITORY_URL>"
git config remote.sync.push refs/heads/main:refs/heads/main
```

发布前在本机 Git common directory 配置 `publication-policy.json`（路径可通过 `git rev-parse --path-format=absolute --git-common-dir` 查询）：

```json
{"denyTerms": ["your-private-domain.invalid", "your-private-project-name"]}
```

该文件不进入 Git；根据自己的组织维护私有域名、人名、项目名和数据源等禁用词，不把这些词写进公开规则。`PUBLICATION_POLICY_PATH` 可覆盖本机路径。通用检查还会拒绝非公开提交邮箱、真实格式消息标识、个人目录、已识别凭据及历史中跟踪的私有数据文件。它会检查 main 全部可达提交及历史文件，不只是当前目录；未知业务含义仍需要人工审查，检查不是任意秘密的绝对检测器。

维护者在每个 clone 安装仓库 hook：

```bash
git config core.hooksPath .githooks
git config branch.main.pushRemote sync
```

日常在共同主线完成代码提交与测试后，运行：

```bash
npm run publication:check
npm run sync:main
```

同步命令先检查历史，再确认两站 main 都可快进，随后只推 main，最后独立回读两站 SHA。Hook 拦截绕过 sync 的单端 main 推送，以及向 GitHub 发布内部归档或其他 ref。两站顺序推送，并非跨站点原子事务；某站失败会返回失败，可能需要补齐另一站，不会自动强推。同一提交可安全重试。两个远端的 `refs/heads/main` 都等于本机 `main` 才算同步完成。远端地址仅保存在本机 Git 配置中。

本机 hook 不是服务端权限控制，`--no-verify`、未安装 hook 的其他 clone、远端网页直接合并仍可绕过。维护者应统一安装、使用同步命令并审查外部提交；发现分叉先人工处理，禁止静默覆盖。

禁止对公开远端使用 `--mirror`、`--all` 或 `--tags`，避免将仅限内部的原历史、旧标签和未脱敏分支公开。旧 clone/工作树不能把旧历史合回共同主线。协作者应保留个人改动后重新克隆或人工迁移补丁；外部贡献在共同历史上正常评审和合入后再同步两站。
